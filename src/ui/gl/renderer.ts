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
  ];

  /** Bind the mesh (or instanced-mesh) program and set every material uniform. */
  private useMeshMaterial(o: MeshMaterialOpts, instanced = false): ProgramInfo {
    const gl = this.gl;
    const p = instanced
      ? this.getProgram('meshInstanced', MESH_INSTANCED_VS, MESH_FS, GlRenderer.MESH_UNIFORMS)
      : this.getProgram('mesh', MESH_VS, MESH_FS, GlRenderer.MESH_UNIFORMS);
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
    return p;
  }

  drawMesh(o: MeshDrawOpts): void {
    const gl = this.gl;
    const p = this.useMeshMaterial(o);
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
    gl.uniform1i(p.uniforms.uUseVertexColor, 1); // instance color drives albedo
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
