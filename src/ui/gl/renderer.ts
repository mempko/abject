/**
 * GlRenderer — minimal hand-rolled WebGL2 renderer for the desktop scene.
 *
 * Deliberately dumb: it owns the GL context, shader programs, buffers, and
 * textures, and exposes typed draw calls. All scene/layout decisions live in
 * the Compositor. Blending is premultiplied source-over everywhere
 * (ONE, ONE_MINUS_SRC_ALPHA) so output matches canvas2d compositing, and the
 * backbuffer is transparent so the abyss background shows through.
 */

import { require } from '../../core/contracts.js';
import { Mat4, mat3NormalMatrix } from './math.js';
import { Geometry } from './primitives.js';
import {
  QUAD_VS, SURFACE_FS, GLOW_FS, FLAT_FS,
  OVERLAY_VS, OVERLAY_FS, MESH_VS, MESH_FS, MESH_INSTANCED_VS, MAX_MESH_LIGHTS,
  BRIGHT_FS, BLUR_FS, DEPTH_VS, DEPTH_FS, SHADOW_SIZE,
} from './shaders.js';

/** One instance for an instanced mesh draw: a transform plus an albedo tint. */
export interface MeshInstance {
  position: [number, number, number];
  scale?: number | [number, number, number];
  rotation?: [number, number, number];
  color?: [number, number, number];
}

/** GPU state for an instanced mesh: shared geometry + a per-instance buffer. */
export interface InstancedMesh {
  vao: WebGLVertexArrayObject;
  posBuf: WebGLBuffer;
  normBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  instBuf: WebGLBuffer;
  count: number;          // index count
  indexType: number;
  instanceCount: number;
}

export interface RGBA { r: number; g: number; b: number; a: number }

/** Parse #rgb/#rrggbb/rgb()/rgba() into 0..1 channels. Falls back to opaque white. */
export function parseCssColor(input: string): RGBA {
  const s = (input ?? '').trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const v = parseInt(hex.slice(0, 6), 16);
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 };
  }
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (m) {
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] !== undefined ? +m[4] : 1 };
  }
  return { r: 1, g: 1, b: 1, a: 1 };
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export interface SurfaceDrawOpts {
  model: Mat4;
  viewProj: Mat4;
  texture: WebGLTexture;
  width: number;
  height: number;
  radius: number;
  dim: number;
  opacity: number;
  borderColor?: RGBA;
  rimColor?: RGBA;
  rimWidth?: number;
  scissor?: { x: number; y: number; width: number; height: number };
}

export interface GlowDrawOpts {
  model: Mat4;            // positions/scales the OVERSIZED quad
  viewProj: Mat4;
  quadWidth: number;      // oversized quad px
  quadHeight: number;
  halfWidth: number;      // glow rect half-size px
  halfHeight: number;
  radius: number;
  offsetX?: number;       // rect center offset within the quad
  offsetY?: number;
  color: RGBA;
  a1: number; sigma1: number;
  a2?: number; sigma2?: number;
}

export interface MeshLight {
  /** xyz = position (point/spot) or direction slot (directional); w: 0=directional, 1=point, 2=spot */
  pos: [number, number, number, number];
  /** rgb already multiplied by intensity */
  color: [number, number, number];
  /** Aim direction for directional and spot lights. */
  dir?: [number, number, number];
  /** Falloff range in px (0 = infinite). Point/spot only. */
  range?: number;
  /** Spot cone, as cosines of the inner (full) and outer (zero) angles. */
  spotInner?: number;
  spotOuter?: number;
}

export interface FogOpts { color: [number, number, number]; near: number; far: number }

/** Shadow sampling state passed to a mesh draw when a shadow pass has run. */
export interface ShadowOpts { map: WebGLTexture; lightVP: Mat4; lightIndex: number }

export type DrawMode = 'triangles' | 'lines' | 'points';

/** Material + lighting for a mesh draw, independent of where the geometry lives. */
export interface MeshMaterialOpts {
  model: Mat4;
  viewProj: Mat4;
  color: RGBA;
  emissive?: RGBA;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  ambient?: [number, number, number];
  lights?: MeshLight[];
  cameraPos: [number, number, number];
  /** Albedo texture sampled by the geometry's UVs. */
  texture?: WebGLTexture;
  fog?: FogOpts;
  shadow?: ShadowOpts;
  /** triangles (default), lines (LINE_STRIP over vertices), or points. */
  drawMode?: DrawMode;
  pointSize?: number;
}

export interface MeshDrawOpts extends MeshMaterialOpts {
  geometry: Geometry;
}

/**
 * A GPU mesh whose vertex buffers can be re-uploaded in place — the backing
 * store for scene nodes carrying custom `params.geometry`. The compositor
 * owns one handle per custom-mesh node and re-uploads it only when the
 * node's geometry revision changes, so deforming a surface every frame
 * reuses the same buffers instead of leaking a VAO per update.
 */
export interface DynamicMesh {
  vao: WebGLVertexArrayObject;
  posBuf: WebGLBuffer;
  normBuf: WebGLBuffer;
  colorBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  count: number;
  vertexCount: number;
  indexType: number; // gl.UNSIGNED_SHORT | gl.UNSIGNED_INT
  hasColor: boolean;
}

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, ProgramInfo>();
  private quadVao!: WebGLVertexArrayObject;
  private overlayVao!: WebGLVertexArrayObject;
  private meshVaos = new WeakMap<Geometry, { vao: WebGLVertexArrayObject; count: number; vertexCount: number; indexType: number; hasColor: boolean }>();
  private contextLost = false;
  /** Called after the context is restored so the owner can re-upload state. */
  onContextRestored?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Surface the driver's real reason if creation fails (blocklist, out of
    // memory, unsupported flag combo) instead of a bare null — invaluable when
    // debugging device-specific blank screens.
    canvas.addEventListener('webglcontextcreationerror', (e) => {
      console.error('[GlRenderer] WebGL2 context creation error:', (e as WebGLContextEvent).statusMessage);
    }, { once: true });
    const attrs: WebGLContextAttributes = {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      // Stencil clips a tilted window's content to its PROJECTED quad — the
      // scissor rect can only express axis-aligned clipping.
      stencil: true,
    };
    // Some Android GL drivers refuse a multisampled stencil default framebuffer
    // (antialias + stencil together). Stencil is functionally required; MSAA is
    // cosmetic, so retry without it rather than fail boot with a blank screen.
    const gl = canvas.getContext('webgl2', attrs)
      ?? canvas.getContext('webgl2', { ...attrs, antialias: false });
    require(gl !== null, 'Failed to get WebGL2 context');
    this.gl = gl!;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.programs.clear();
      this.programErrors.clear();   // recompile fresh against the restored context
      this.meshVaos = new WeakMap();
      this.disposeBloomTargets();   // GPU FBOs/textures are gone; reallocate lazily
      this.disposeShadow();
      this.initStaticResources();
      this.onContextRestored?.();
    });

    this.initStaticResources();
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  private initStaticResources(): void {
    const gl = this.gl;
    // Unit centered quad
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Fullscreen triangle
    this.overlayVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.overlayVao);
    const triBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Global state: premultiplied source-over, no culling (y-flip inverts
    // winding), depth handled per-pass.
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Program names whose compile/link failed once, mapped to the driver info log.
   *  A shader that fails on this GPU fails identically every frame, so we record
   *  it and stop re-running the compiler (and re-throwing) 60x/second. */
  private programErrors = new Map<string, string>();

  private getProgram(name: string, vsSrc: string, fsSrc: string, uniformNames: string[]): ProgramInfo {
    let info = this.programs.get(name);
    if (info) return info;
    const prior = this.programErrors.get(name);
    if (prior !== undefined) throw new Error(prior);
    const gl = this.gl;
    try {
      const compile = (type: number, src: string): WebGLShader => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error(`Shader '${name}' compile error: ${gl.getShaderInfoLog(sh)}`);
        }
        return sh;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program '${name}' link error: ${gl.getProgramInfoLog(program)}`);
      }
      const uniforms: Record<string, WebGLUniformLocation | null> = {};
      for (const u of uniformNames) uniforms[u] = gl.getUniformLocation(program, u);
      info = { program, uniforms };
      this.programs.set(name, info);
      return info;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.programErrors.set(name, msg);
      // Log the real driver reason exactly once per program. On a device where a
      // shader won't build (a driver miscompile the desktop never hits), this is
      // the single line that names the cause; remote consoles pick it up.
      console.error('[GlRenderer]', msg);
      throw err;
    }
  }

  // ── Frame lifecycle ──────────────────────────────────────────────────

  setSize(cssWidth: number, cssHeight: number, dpr: number): void {
    // Clamp the backing buffer to what the GPU can actually allocate. High-DPR
    // phones (Android Chrome commonly reports dpr 2.6-4) can otherwise push the
    // drawing buffer AND the full-resolution bloom texture (copyTexImage2D of
    // canvas.width x canvas.height) past MAX_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE,
    // yielding an incomplete framebuffer or a lost context — a blank canvas that
    // only reproduces on mobile. Shrink dpr uniformly so the larger dimension
    // fits; correctness (something visible) beats pixel density.
    const limit = this.maxBufferSize();
    const maxDim = Math.max(cssWidth, cssHeight) * dpr;
    if (maxDim > limit) dpr = dpr * (limit / maxDim);
    this.canvas.width = Math.max(1, Math.min(limit, Math.round(cssWidth * dpr)));
    this.canvas.height = Math.max(1, Math.min(limit, Math.round(cssHeight * dpr)));
  }

  /** Largest square buffer this GPU accepts as both a texture and a renderbuffer. */
  private maxBufferSize(): number {
    if (this.cachedMaxBufferSize === 0) {
      const gl = this.gl;
      this.cachedMaxBufferSize = Math.max(1, Math.min(
        gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      ));
    }
    return this.cachedMaxBufferSize;
  }
  private cachedMaxBufferSize = 0;

  beginFrame(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }

  /**
   * Clip subsequent draws to a screen rect (CSS px from the top-left). Used to
   * keep a window's occluded 3D children inside the window's bounds. Pass a
   * rect to enable, then clearScissor() when done.
   */
  setScissor(r: { x: number; y: number; width: number; height: number }): void {
    const gl = this.gl;
    const dpr = this.canvas.width / Math.max(1, this.cssWidth);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.round(r.x * dpr),
      Math.round(this.canvas.height - (r.y + r.height) * dpr),
      Math.round(r.width * dpr),
      Math.round(r.height * dpr),
    );
  }

  clearScissor(): void {
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  /**
   * Begin a stencil clip: rasterize the projected unit quad (model ×
   * viewProj) into the stencil buffer and restrict subsequent draws to it.
   * The scissor (if set) bounds the stencil clear, so set the conservative
   * screen bbox FIRST. Used for tilted windows, whose content region is a
   * rotated quad on screen that the axis-aligned scissor cannot express.
   * Pair with endStencilClip().
   */
  beginStencilClip(model: Mat4, viewProj: Mat4): void {
    const gl = this.gl;
    const p = this.getProgram('stencilQuad',
      `#version 300 es
layout(location = 0) in vec2 aPos;
uniform mat4 uModel;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * uModel * vec4(aPos, 0.0, 1.0); }`,
      `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() { fragColor = vec4(1.0); }`,
      ['uModel', 'uViewProj']);
    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, model);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, viewProj);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  endStencilClip(): void {
    this.gl.disable(this.gl.STENCIL_TEST);
  }

  /** Clear just the depth buffer (scissor must be off). Gives a fresh depth
   * range so a later pass (e.g. non-occluded overlay meshes) sits on top. */
  clearDepth(): void {
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.clear(this.gl.DEPTH_BUFFER_BIT);
  }

  // ── Textures ─────────────────────────────────────────────────────────

  createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Upload a canvas into a texture, premultiplied, no color-space mangling. */
  /**
   * Upload a surface canvas as a texture. Returns false if the canvas is
   * tainted by a cross-origin image (drawn without CORS) — texImage2D throws
   * a SecurityError on such canvases. We swallow that throw and upload a 1x1
   * transparent pixel instead so a single bad surface can never abort the
   * whole desktop render. The caller marks the surface so it stops retrying.
   */
  uploadTexture(tex: WebGLTexture, source: OffscreenCanvas | HTMLCanvasElement | HTMLImageElement | ImageBitmap): boolean {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
      return true;
    } catch {
      // Tainted canvas — upload a safe placeholder so the texture stays valid.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]),
      );
      return false;
    }
  }

  deleteTexture(tex: WebGLTexture): void {
    this.gl.deleteTexture(tex);
  }

  // ── Draw calls ───────────────────────────────────────────────────────

  drawSurface(o: SurfaceDrawOpts): void {
    const gl = this.gl;
    // A surface quad is a 2D COMPOSITING PLANE (a window slab or a canvas
    // layer): it paints in painter's order and must never write depth, or it
    // would cull the 3D nodes behind it. Assert that here rather than trusting
    // ambient GL state — a leaked DEPTH_TEST from another pass is invisible
    // until an entire scene mysteriously renders only its front half.
    gl.disable(gl.DEPTH_TEST);
    const p = this.getProgram('surface', QUAD_VS, SURFACE_FS, [
      'uModel', 'uViewProj', 'uTex', 'uSize', 'uRadius', 'uDim', 'uOpacity',
      'uBorderColor', 'uRimColor', 'uRimWidth',
    ]);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVao);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, o.model);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, o.viewProj);
    gl.uniform2f(p.uniforms.uSize, o.width, o.height);
    gl.uniform1f(p.uniforms.uRadius, o.radius);
    gl.uniform1f(p.uniforms.uDim, o.dim);
    gl.uniform1f(p.uniforms.uOpacity, o.opacity);
    const bc = o.borderColor ?? { r: 0, g: 0, b: 0, a: 0 };
    gl.uniform4f(p.uniforms.uBorderColor, bc.r, bc.g, bc.b, bc.a);
    const rc = o.rimColor ?? { r: 0, g: 0, b: 0, a: 0 };
    gl.uniform4f(p.uniforms.uRimColor, rc.r * rc.a, rc.g * rc.a, rc.b * rc.a, rc.a);
    gl.uniform1f(p.uniforms.uRimWidth, o.rimWidth ?? 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, o.texture);
    gl.uniform1i(p.uniforms.uTex, 0);

    if (o.scissor) {
      const dpr = this.canvas.width / Math.max(1, this.cssWidth);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        Math.round(o.scissor.x * dpr),
        Math.round(this.canvas.height - (o.scissor.y + o.scissor.height) * dpr),
        Math.round(o.scissor.width * dpr),
        Math.round(o.scissor.height * dpr),
      );
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (o.scissor) gl.disable(gl.SCISSOR_TEST);
  }

  drawGlow(o: GlowDrawOpts): void {
    const gl = this.gl;
    const p = this.getProgram('glow', QUAD_VS, GLOW_FS, [
      'uModel', 'uViewProj', 'uQuadSize', 'uHalfSize', 'uRadius', 'uOffset',
      'uColor', 'uColorAlpha', 'uA1', 'uSigma1', 'uA2', 'uSigma2',
    ]);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVao);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, o.model);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, o.viewProj);
    gl.uniform2f(p.uniforms.uQuadSize, o.quadWidth, o.quadHeight);
    gl.uniform2f(p.uniforms.uHalfSize, o.halfWidth, o.halfHeight);
    gl.uniform1f(p.uniforms.uRadius, o.radius);
    gl.uniform2f(p.uniforms.uOffset, o.offsetX ?? 0, o.offsetY ?? 0);
    gl.uniform3f(p.uniforms.uColor, o.color.r, o.color.g, o.color.b);
    gl.uniform1f(p.uniforms.uColorAlpha, o.color.a);
    gl.uniform1f(p.uniforms.uA1, o.a1);
    gl.uniform1f(p.uniforms.uSigma1, o.sigma1);
    gl.uniform1f(p.uniforms.uA2, o.a2 ?? 0);
    gl.uniform1f(p.uniforms.uSigma2, o.sigma2 ?? 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawFlat(model: Mat4, viewProj: Mat4, color: RGBA): void {
    const gl = this.gl;
    const p = this.getProgram('flat', QUAD_VS, FLAT_FS, ['uModel', 'uViewProj', 'uColor']);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVao);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, model);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, viewProj);
    gl.uniform4f(p.uniforms.uColor, color.r * color.a, color.g * color.a, color.b * color.a, color.a);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private static readonly MESH_UNIFORMS = [
    'uModel', 'uViewProj', 'uNormalMat', 'uPointSize', 'uColor', 'uEmissive', 'uOpacity',
    'uMetalness', 'uRoughness', 'uAmbient', 'uCameraPos',
    'uUseVertexColor', 'uUseTexture', 'uTex',
    'uLightCount', 'uLightPos', 'uLightColor', 'uLightDir', 'uLightSpot',
    'uFogEnabled', 'uFogColor', 'uFogRange',
    'uShadowEnabled', 'uShadowLight', 'uShadowMap', 'uLightVP',
  ];

  /**
   * Bind the mesh (or instanced-mesh) program and set every material uniform.
   * Returns null if the mesh program cannot be built on this GPU — callers then
   * skip the draw so a driver that rejects the mesh shader degrades to "no 3D"
   * rather than throwing out of the frame and blanking the 2D desktop with it.
   */
  private useMeshMaterial(o: MeshMaterialOpts, instanced = false): ProgramInfo | null {
    const gl = this.gl;
    let p: ProgramInfo;
    try {
      p = instanced
        ? this.getProgram('meshInstanced', MESH_INSTANCED_VS, MESH_FS, GlRenderer.MESH_UNIFORMS)
        : this.getProgram('mesh', MESH_VS, MESH_FS, GlRenderer.MESH_UNIFORMS);
    } catch {
      return null;   // reason already logged once by getProgram
    }
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, o.model);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, o.viewProj);
    gl.uniformMatrix3fv(p.uniforms.uNormalMat, false, mat3NormalMatrix(o.model));
    gl.uniform1f(p.uniforms.uPointSize, o.pointSize ?? 4);
    gl.uniform3f(p.uniforms.uColor, o.color.r, o.color.g, o.color.b);
    const em = o.emissive ?? { r: 0, g: 0, b: 0, a: 0 };
    gl.uniform3f(p.uniforms.uEmissive, em.r * em.a, em.g * em.a, em.b * em.a);
    gl.uniform1f(p.uniforms.uOpacity, o.opacity ?? 1);
    gl.uniform1f(p.uniforms.uMetalness, Math.min(1, Math.max(0, o.metalness ?? 0)));
    gl.uniform1f(p.uniforms.uRoughness, Math.min(1, Math.max(0, o.roughness ?? 0.55)));
    const amb = o.ambient ?? [0.35, 0.35, 0.4];
    gl.uniform3f(p.uniforms.uAmbient, amb[0], amb[1], amb[2]);
    gl.uniform3f(p.uniforms.uCameraPos, o.cameraPos[0], o.cameraPos[1], o.cameraPos[2]);

    if (o.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, o.texture);
      gl.uniform1i(p.uniforms.uTex, 0);
      gl.uniform1i(p.uniforms.uUseTexture, 1);
    } else {
      gl.uniform1i(p.uniforms.uUseTexture, 0);
    }

    const lights = (o.lights ?? []).slice(0, MAX_MESH_LIGHTS);
    gl.uniform1i(p.uniforms.uLightCount, lights.length);
    if (lights.length > 0) {
      const pos = new Float32Array(MAX_MESH_LIGHTS * 4);
      const col = new Float32Array(MAX_MESH_LIGHTS * 3);
      const dir = new Float32Array(MAX_MESH_LIGHTS * 4);
      const spot = new Float32Array(MAX_MESH_LIGHTS * 4);
      lights.forEach((l, i) => {
        pos.set(l.pos, i * 4);
        col.set(l.color, i * 3);
        const d = l.dir ?? [0, 1, 0];
        dir.set([d[0], d[1], d[2], l.range ?? 0], i * 4);
        const isSpot = l.pos[3] >= 1.5 ? 1 : 0;
        spot.set([l.spotInner ?? 1, l.spotOuter ?? 0, isSpot, 0], i * 4);
      });
      gl.uniform4fv(p.uniforms.uLightPos, pos);
      gl.uniform3fv(p.uniforms.uLightColor, col);
      gl.uniform4fv(p.uniforms.uLightDir, dir);
      gl.uniform4fv(p.uniforms.uLightSpot, spot);
    }

    if (o.fog) {
      gl.uniform1i(p.uniforms.uFogEnabled, 1);
      gl.uniform3f(p.uniforms.uFogColor, o.fog.color[0], o.fog.color[1], o.fog.color[2]);
      gl.uniform2f(p.uniforms.uFogRange, o.fog.near, o.fog.far);
    } else {
      gl.uniform1i(p.uniforms.uFogEnabled, 0);
    }

    if (o.shadow) {
      gl.uniform1i(p.uniforms.uShadowEnabled, 1);
      gl.uniform1i(p.uniforms.uShadowLight, o.shadow.lightIndex);
      gl.uniformMatrix4fv(p.uniforms.uLightVP, false, o.shadow.lightVP);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, o.shadow.map);
      gl.uniform1i(p.uniforms.uShadowMap, 1);
    } else {
      gl.uniform1i(p.uniforms.uShadowEnabled, 0);
    }
    return p;
  }

  drawMesh(o: MeshDrawOpts): void {
    const gl = this.gl;
    const p = this.useMeshMaterial(o);
    if (!p) return;
    const entry = this.getMeshVao(o.geometry);
    gl.uniform1i(p.uniforms.uUseVertexColor, entry.hasColor ? 1 : 0);
    gl.bindVertexArray(entry.vao);
    gl.enable(gl.DEPTH_TEST);
    const mode = o.drawMode ?? 'triangles';
    if (mode === 'triangles') {
      gl.drawElements(gl.TRIANGLES, entry.count, entry.indexType, 0);
    } else {
      gl.drawArrays(mode === 'lines' ? gl.LINE_STRIP : gl.POINTS, 0, entry.vertexCount);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  // ── Dynamic (custom-geometry) meshes ─────────────────────────────────

  /** Allocate an empty dynamic mesh; fill it with updateDynamicMesh. */
  createDynamicMesh(): DynamicMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const normBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const colorBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bindVertexArray(null);
    return { vao, posBuf, normBuf, colorBuf, uvBuf, idxBuf, count: 0, vertexCount: 0, indexType: gl.UNSIGNED_INT, hasColor: false };
  }

  /** (Re-)upload a dynamic mesh's vertex data. Cheap to call every frame. */
  updateDynamicMesh(mesh: DynamicMesh, geometry: Geometry): void {
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.DYNAMIC_DRAW);
    if (geometry.colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.colors, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      mesh.hasColor = true;
    } else if (mesh.hasColor) {
      gl.disableVertexAttribArray(2);
      mesh.hasColor = false;
    }
    if (geometry.uvs) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(3);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    mesh.count = geometry.indices.length;
    mesh.vertexCount = Math.floor(geometry.positions.length / 3);
    mesh.indexType = geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  drawDynamicMesh(mesh: DynamicMesh, o: MeshMaterialOpts): void {
    if (mesh.count === 0) return;
    const gl = this.gl;
    const p = this.useMeshMaterial(o);
    if (!p) return;
    gl.uniform1i(p.uniforms.uUseVertexColor, mesh.hasColor ? 1 : 0);
    gl.bindVertexArray(mesh.vao);
    gl.enable(gl.DEPTH_TEST);
    const mode = o.drawMode ?? 'triangles';
    if (mode === 'triangles') {
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    } else {
      gl.drawArrays(mode === 'lines' ? gl.LINE_STRIP : gl.POINTS, 0, mesh.vertexCount);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  deleteDynamicMesh(mesh: DynamicMesh): void {
    const gl = this.gl;
    gl.deleteBuffer(mesh.posBuf);
    gl.deleteBuffer(mesh.normBuf);
    gl.deleteBuffer(mesh.colorBuf);
    gl.deleteBuffer(mesh.uvBuf);
    gl.deleteBuffer(mesh.idxBuf);
    gl.deleteVertexArray(mesh.vao);
  }

  // ── Instanced meshes (one geometry drawn many times) ─────────────────

  /** Build an instanced mesh from a base geometry; fill instances with updateInstances. */
  createInstancedMesh(geometry: Geometry): InstancedMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const normBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    // Per-instance attributes: mat4 (locations 4-7) + color (8), stride 19 floats.
    const instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const stride = 19 * 4;
    for (let c = 0; c < 4; c++) {
      gl.enableVertexAttribArray(4 + c);
      gl.vertexAttribPointer(4 + c, 4, gl.FLOAT, false, stride, c * 16);
      gl.vertexAttribDivisor(4 + c, 1);
    }
    gl.enableVertexAttribArray(8);
    gl.vertexAttribPointer(8, 3, gl.FLOAT, false, stride, 16 * 4);
    gl.vertexAttribDivisor(8, 1);
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      vao, posBuf, normBuf, idxBuf, instBuf,
      count: geometry.indices.length,
      indexType: geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      instanceCount: 0,
    };
  }

  /** Upload a packed instance buffer (19 floats per instance: mat4 + rgb). */
  updateInstances(mesh: InstancedMesh, data: Float32Array, instanceCount: number): void {
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    mesh.instanceCount = instanceCount;
  }

  drawInstanced(mesh: InstancedMesh, o: MeshMaterialOpts): void {
    if (mesh.instanceCount === 0) return;
    const gl = this.gl;
    const p = this.useMeshMaterial(o, true);
    if (!p) return;
    gl.uniform1i(p.uniforms.uUseVertexColor, 1); // instance color drives albedo
    // ...and because it does, uColor must be WHITE. The shader multiplies them
    // (albedo = uColor * vColor), and the compositor already defaults an
    // instance with no colour of its own to the NODE's colour — so leaving
    // uColor set to that same node colour rendered every instance at colour
    // SQUARED (a #808080 starfield came out at 0.25 grey, not 0.5).
    gl.uniform3f(p.uniforms.uColor, 1, 1, 1);
    gl.bindVertexArray(mesh.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.indexType, 0, mesh.instanceCount);
    gl.disable(gl.DEPTH_TEST);
  }

  deleteInstancedMesh(mesh: InstancedMesh): void {
    const gl = this.gl;
    gl.deleteBuffer(mesh.posBuf);
    gl.deleteBuffer(mesh.normBuf);
    gl.deleteBuffer(mesh.idxBuf);
    gl.deleteBuffer(mesh.instBuf);
    gl.deleteVertexArray(mesh.vao);
  }

  // ── Shadow map (opt-in directional shadows) ──────────────────────────

  private shadowFbo?: WebGLFramebuffer;
  private shadowTex?: WebGLTexture;

  /** The depth texture written by the last shadow pass (for mesh sampling). */
  get shadowMap(): WebGLTexture | undefined { return this.shadowTex; }

  private ensureShadowTarget(): void {
    if (this.shadowTex) return;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowTex = tex; this.shadowFbo = fbo;
  }

  private disposeShadow(): void {
    const gl = this.gl;
    if (this.shadowTex) gl.deleteTexture(this.shadowTex);
    if (this.shadowFbo) gl.deleteFramebuffer(this.shadowFbo);
    this.shadowTex = undefined; this.shadowFbo = undefined;
  }

  /** Begin the depth-only shadow pass from the light's POV. */
  beginShadowPass(lightVP: Mat4): void {
    this.ensureShadowTarget();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo!);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const p = this.getProgram('depth', DEPTH_VS, DEPTH_FS, ['uLightVP', 'uModel']);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.uLightVP, false, lightVP);
  }

  /** Draw a caster's depth (static geometry) during a shadow pass. */
  drawDepthGeometry(geometry: Geometry, model: Mat4): void {
    const gl = this.gl;
    const p = this.getProgram('depth', DEPTH_VS, DEPTH_FS, ['uLightVP', 'uModel']);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, model);
    const entry = this.getMeshVao(geometry);
    gl.bindVertexArray(entry.vao);
    gl.drawElements(gl.TRIANGLES, entry.count, entry.indexType, 0);
  }

  /** Draw a caster's depth (dynamic/custom mesh) during a shadow pass. */
  drawDepthDynamic(mesh: DynamicMesh, model: Mat4): void {
    if (mesh.count === 0) return;
    const gl = this.gl;
    const p = this.getProgram('depth', DEPTH_VS, DEPTH_FS, ['uLightVP', 'uModel']);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, model);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
  }

  /** End the shadow pass: restore the backbuffer, blend, AND the depth state.
   *
   *  DEPTH_TEST is OFF by default in this renderer and is enabled only for the
   *  duration of a mesh draw — that invariant is what lets 2D compositing planes
   *  (window slabs, canvas layers) paint in painter's order without writing depth.
   *  beginShadowPass enables it, so failing to disable it here leaked a depth-
   *  writing state into the very next drawSurface: the window's backdrop canvas
   *  layer then stamped depth across the whole window at z=0, and EVERY mesh
   *  behind the window plane was silently culled (a 3D scene would render only
   *  the half of itself in front of the camera-facing window plane). */
  endShadowPass(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  drawOverlay(tex: WebGLTexture): void {
    const gl = this.gl;
    const p = this.getProgram('overlay', OVERLAY_VS, OVERLAY_FS, ['uTex']);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.overlayVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.uniforms.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ── Bloom (opt-in post pass) ─────────────────────────────────────────

  private bloomSceneTex?: WebGLTexture;
  private bloomFbo: WebGLFramebuffer[] = [];
  private bloomTex: WebGLTexture[] = [];
  private bloomW = 0;
  private bloomH = 0;
  /** Set once if the GPU can't complete the bloom FBOs; makes applyBloom a no-op. */
  private bloomUnavailable = false;

  private ensureBloomTargets(): void {
    const gl = this.gl;
    const w = Math.max(1, this.canvas.width >> 1);
    const h = Math.max(1, this.canvas.height >> 1);
    if (this.bloomSceneTex && this.bloomW === w && this.bloomH === h) return;
    // (Re)allocate the scene copy and two half-res ping-pong targets.
    this.disposeBloomTargets();
    this.bloomW = w; this.bloomH = h;
    this.bloomSceneTex = this.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bloomSceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (let i = 0; i < 2; i++) {
      const tex = this.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      // An incomplete FBO (e.g. an oversized allocation on a limited mobile GPU)
      // must not throw mid-frame and kill the render loop — drop bloom instead.
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.bloomUnavailable = true;
      }
      this.bloomTex[i] = tex; this.bloomFbo[i] = fbo;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private disposeBloomTargets(): void {
    const gl = this.gl;
    if (this.bloomSceneTex) gl.deleteTexture(this.bloomSceneTex);
    this.bloomFbo.forEach((f) => gl.deleteFramebuffer(f));
    this.bloomTex.forEach((t) => gl.deleteTexture(t));
    this.bloomSceneTex = undefined; this.bloomFbo = []; this.bloomTex = []; this.bloomW = 0; this.bloomH = 0;
  }

  private blitFullscreen(): void {
    this.gl.bindVertexArray(this.overlayVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /**
   * Apply bloom as an additive post pass: copy the current backbuffer, extract
   * bright pixels, gaussian-blur them, and add the result back. Operates on a
   * copy, so a failure here can only affect the glow, never the base render.
   * Call after the scene draws and before the 2D chrome overlay.
   */
  applyBloom(threshold: number, intensity: number, iterations = 3): void {
    const gl = this.gl;
    if (this.contextLost) return;
    this.ensureBloomTargets();
    if (this.bloomUnavailable) return;
    // 1. Snapshot the lit backbuffer.
    gl.bindTexture(gl.TEXTURE_2D, this.bloomSceneTex!);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, this.canvas.width, this.canvas.height, 0);

    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.bloomW, this.bloomH);

    // 2. Bright-pass scene → bloomTex[0].
    const bright = this.getProgram('bloomBright', OVERLAY_VS, BRIGHT_FS, ['uTex', 'uThreshold']);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[0]);
    gl.useProgram(bright.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomSceneTex!);
    gl.uniform1i(bright.uniforms.uTex, 0);
    gl.uniform1f(bright.uniforms.uThreshold, threshold);
    this.blitFullscreen();

    // 3. Separable gaussian, ping-ponging between the two half-res targets.
    const blur = this.getProgram('bloomBlur', OVERLAY_VS, BLUR_FS, ['uTex', 'uDir']);
    gl.useProgram(blur.program);
    let src = 0;
    for (let i = 0; i < iterations * 2; i++) {
      const horizontal = i % 2 === 0;
      const dst = src ^ 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[dst]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[src]);
      gl.uniform1i(blur.uniforms.uTex, 0);
      gl.uniform2f(blur.uniforms.uDir, horizontal ? 1 / this.bloomW : 0, horizontal ? 0 : 1 / this.bloomH);
      this.blitFullscreen();
      src = dst;
    }

    // 4. Additively composite the blurred glow onto the backbuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const comp = this.getProgram('overlay', OVERLAY_VS, OVERLAY_FS, ['uTex']);
    gl.useProgram(comp.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[src]);
    gl.uniform1i(comp.uniforms.uTex, 0);
    // Scale glow by intensity via repeated additive blits (cheap, 1-3x).
    const passes = Math.max(1, Math.round(intensity));
    for (let i = 0; i < passes; i++) this.blitFullscreen();
    // Restore the standard premultiplied source-over blend.
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private getMeshVao(geometry: Geometry): { vao: WebGLVertexArrayObject; count: number; vertexCount: number; indexType: number; hasColor: boolean } {
    let entry = this.meshVaos.get(geometry);
    if (entry) return entry;
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const normBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    if (geometry.colors) {
      const colorBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    }
    if (geometry.uvs) {
      const uvBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    }
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    entry = {
      vao,
      count: geometry.indices.length,
      vertexCount: Math.floor(geometry.positions.length / 3),
      indexType: geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      hasColor: !!geometry.colors,
    };
    this.meshVaos.set(geometry, entry);
    return entry;
  }

  /** CSS width tracked for scissor math (set via resize). */
  cssWidth = 1;
  cssHeight = 1;

  dispose(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
