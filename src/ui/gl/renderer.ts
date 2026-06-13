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
import { Mat4 } from './math.js';
import { Geometry } from './primitives.js';
import {
  QUAD_VS, SURFACE_FS, GLOW_FS, FLAT_FS,
  OVERLAY_VS, OVERLAY_FS, MESH_VS, MESH_FS,
} from './shaders.js';

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
  /** xyz = position (point) or direction (directional); w: 1=point, 0=directional */
  pos: [number, number, number, number];
  color: [number, number, number];
}

export interface MeshDrawOpts {
  model: Mat4;
  viewProj: Mat4;
  geometry: Geometry;
  color: RGBA;
  emissive?: RGBA;
  opacity?: number;
  ambient?: [number, number, number];
  lights?: MeshLight[];
  cameraPos: [number, number, number];
}

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, ProgramInfo>();
  private quadVao!: WebGLVertexArrayObject;
  private overlayVao!: WebGLVertexArrayObject;
  private meshVaos = new WeakMap<Geometry, { vao: WebGLVertexArrayObject; count: number }>();
  private contextLost = false;
  /** Called after the context is restored so the owner can re-upload state. */
  onContextRestored?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    require(gl !== null, 'Failed to get WebGL2 context');
    this.gl = gl!;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.programs.clear();
      this.meshVaos = new WeakMap();
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

  private getProgram(name: string, vsSrc: string, fsSrc: string, uniformNames: string[]): ProgramInfo {
    let info = this.programs.get(name);
    if (info) return info;
    const gl = this.gl;
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
  }

  // ── Frame lifecycle ──────────────────────────────────────────────────

  setSize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  }

  beginFrame(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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
  uploadTexture(tex: WebGLTexture, source: OffscreenCanvas | HTMLCanvasElement): boolean {
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

  drawMesh(o: MeshDrawOpts): void {
    const gl = this.gl;
    const p = this.getProgram('mesh', MESH_VS, MESH_FS, [
      'uModel', 'uViewProj', 'uColor', 'uEmissive', 'uOpacity', 'uAmbient',
      'uCameraPos', 'uLightCount', 'uLightPos', 'uLightColor',
    ]);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.getMeshVao(o.geometry).vao);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, o.model);
    gl.uniformMatrix4fv(p.uniforms.uViewProj, false, o.viewProj);
    gl.uniform3f(p.uniforms.uColor, o.color.r, o.color.g, o.color.b);
    const em = o.emissive ?? { r: 0, g: 0, b: 0, a: 0 };
    gl.uniform3f(p.uniforms.uEmissive, em.r * em.a, em.g * em.a, em.b * em.a);
    gl.uniform1f(p.uniforms.uOpacity, o.opacity ?? 1);
    const amb = o.ambient ?? [0.35, 0.35, 0.4];
    gl.uniform3f(p.uniforms.uAmbient, amb[0], amb[1], amb[2]);
    gl.uniform3f(p.uniforms.uCameraPos, o.cameraPos[0], o.cameraPos[1], o.cameraPos[2]);
    const lights = (o.lights ?? []).slice(0, 4);
    gl.uniform1i(p.uniforms.uLightCount, lights.length);
    if (lights.length > 0) {
      const pos = new Float32Array(16);
      const col = new Float32Array(12);
      lights.forEach((l, i) => {
        pos.set(l.pos, i * 4);
        col.set(l.color, i * 3);
      });
      gl.uniform4fv(p.uniforms.uLightPos, pos);
      gl.uniform3fv(p.uniforms.uLightColor, col);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.drawElements(gl.TRIANGLES, this.getMeshVao(o.geometry).count, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.DEPTH_TEST);
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

  private getMeshVao(geometry: Geometry): { vao: WebGLVertexArrayObject; count: number } {
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
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    entry = { vao, count: geometry.indices.length };
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
