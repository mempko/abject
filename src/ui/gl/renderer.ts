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
  OVERLAY_VS, OVERLAY_FS, BLOOM_COMPOSITE_FS, BLOOM_DOWN_FS, BLOOM_UP_FS, MAX_MESH_LIGHTS,
  BRIGHT_FS, BLUR_FS, DEPTH_VS, DEPTH_FS, SHADOW_SIZE,
  MeshShading, MeshVariant, DEFAULT_MESH_VARIANT, meshVariantKey, meshVertexSource, meshFragmentSource,
  OUTLINE_FS,
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
  /** Per-vertex UVs of the base geometry, when it has them. */
  uvBuf?: WebGLBuffer;
  count: number;          // index count
  indexType: number;
  instanceCount: number;
  hasUv?: boolean;
}

export interface RGBA { r: number; g: number; b: number; a: number }

/** An offscreen colour + depth/stencil target covering a canvas-px region (see GlRenderer.pushTarget). */
export interface RenderTarget {
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  /** DEPTH24_STENCIL8, sampleable as depth. */
  depth: WebGLTexture;
  width: number;
  height: number;
  /** Bottom-left of the covered region in canvas GL window px. */
  x0: number;
  y0: number;
}

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

/** An sRGB-encoded channel (0..1, as parsed from CSS) to linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light to an sRGB-encoded channel. */
export function linearToSrgb(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export interface MeshLight {
  /** xyz = position (point/spot); w: 0=directional, 1=point, 2=spot, 3=hemisphere */
  pos: [number, number, number, number];
  /** Display-referred rgb (as parsed from CSS) multiplied by intensity (hemisphere: the sky colour). */
  color: [number, number, number];
  /** Travel direction for directional, spot and hemisphere (sky toward ground) lights. */
  dir?: [number, number, number];
  /** Falloff range in px (0 = infinite). Point/spot only. */
  range?: number;
  /** Spot cone, as cosines of the inner (full) and outer (zero) angles. */
  spotInner?: number;
  spotOuter?: number;
  /** Hemisphere ground colour, display-referred rgb multiplied by intensity. */
  groundColor?: [number, number, number];
}

export type FogMode = 'linear' | 'exp' | 'exp2';

/** Distance fog. `color` is sRGB; near/far are camera distances (linear mode). */
export interface FogOpts {
  color: [number, number, number];
  near: number;
  far: number;
  mode?: FogMode;
  /** Optical density per px of scene depth (exp, exp2). */
  density?: number;
  /** Camera distance where the scene, and the exp fog, begins. */
  start?: number;
  /** Height fog: world y of the fog's top surface; it thins above (smaller y). */
  height?: number;
  /** How quickly height fog thins, per px above `height`. */
  heightFalloff?: number;
}

export type ToneMapping = 'aces' | 'agx' | 'neutral' | 'none';

/** An analytic sky for image-based light. Colours are sRGB. */
export interface SkyOpts {
  top: [number, number, number];
  horizon: [number, number, number];
  bottom: [number, number, number];
  /** direction points TOWARD the sun (y-down world); intensity multiplies its colour; size = disk radius, radians. */
  sun?: { direction: [number, number, number]; color: [number, number, number]; intensity: number; size: number };
}

export interface GradingOpts { contrast?: number; saturation?: number; temperature?: number; tint?: number }

/**
 * Scene mood for a mesh draw: image-based light, tone mapping, grading and
 * fog. Without a sky or env map, a soft gradient derived from `ambient` lights
 * and reflects, so a flat-ambient scene keeps its energy while metals and
 * glossy surfaces reflect something.
 */
export interface EnvironmentOpts {
  /** sRGB flat ambient; the default sky is derived from it. */
  ambient?: [number, number, number];
  sky?: SkyOpts;
  /** Equirectangular environment texture (mipmapped via uploadImageTexture). */
  envMap?: WebGLTexture;
  envIntensity?: number;
  toneMapping?: ToneMapping;
  exposure?: number;
  grading?: GradingOpts;
  fog?: FogOpts;
}

/** Shadow sampling state passed to a mesh draw when a shadow pass has run. */
export interface ShadowOpts {
  map: WebGLTexture;
  lightVP: Mat4;
  lightIndex: number;
  /** Map resolution, texels per side [SHADOW_SIZE]. */
  size?: number;
  /** Filter radius in texels [1.5]. */
  softness?: number;
  /** Depth bias, normalized depth. */
  bias?: number;
  /** Receiver offset along the normal: world px (directional) or px per px of light distance (spot). */
  normalOffset?: number;
}

export type DrawMode = 'triangles' | 'lines' | 'points';

/** Material maps, as GL textures resolved by the caller. */
export interface MeshMaps {
  normal?: WebGLTexture;
  roughness?: WebGLTexture;
  metalness?: WebGLTexture;
  ao?: WebGLTexture;
  emissive?: WebGLTexture;
  matcap?: WebGLTexture;
}

/** Material + lighting for a mesh draw, independent of where the geometry lives. */
export interface MeshMaterialOpts {
  model: Mat4;
  viewProj: Mat4;
  /** Albedo, sRGB (as parsed from CSS); decoded to linear by the renderer. */
  color: RGBA;
  emissive?: RGBA;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  /** sRGB flat ambient (shorthand for environment.ambient). */
  ambient?: [number, number, number];
  lights?: MeshLight[];
  cameraPos: [number, number, number];
  /** Albedo texture sampled by the geometry's UVs. */
  texture?: WebGLTexture;
  /** Fog (shorthand for environment.fog). */
  fog?: FogOpts;
  /** Directional-light shadow. */
  shadow?: ShadowOpts;
  /** Spot-light shadow. */
  spotShadow?: ShadowOpts;
  /** triangles (default), lines (LINE_STRIP over vertices), or points. */
  drawMode?: DrawMode;
  pointSize?: number;
  environment?: EnvironmentOpts;
  /** false = ignore shadow maps for this mesh [true]. */
  receiveShadow?: boolean;
  shading?: MeshShading;
  /** 'additive' adds light without covering what is behind (and writes no depth). */
  blend?: 'normal' | 'additive';
  maps?: MeshMaps;
  normalScale?: number;
  uvRepeat?: [number, number];
  uvOffset?: [number, number];
  toonSteps?: number;
  /** Inverted-hull outline in screen px; radial expands along the position (faceted convex primitives). */
  outline?: { color: RGBA; width: number; radial?: boolean };
  rimColor?: RGBA;
  rimPower?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenColor?: RGBA;
  transmission?: number;
  ior?: number;
  /** This material's environment reflection strength [1]. */
  envIntensity?: number;
  /** The geometry is a closed, outward-facing shape: light-adding materials draw its near shell only. */
  closed?: boolean;
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
  hasUv?: boolean;
}

/** Texture units the mesh programs use, fixed per sampler so no two sampler types ever share one. */
const MESH_UNITS = {
  uTex: 0, uShadowMap: 1, uSpotShadowMap: 2, uNormalMap: 3, uRoughnessMap: 4,
  uMetalnessMap: 5, uAoMap: 6, uEmissiveMap: 7, uMatcapMap: 8, uEnvMap: 9,
} as const;

/** Flat ambient used when a scene sets none (sRGB). */
const DEFAULT_AMBIENT: [number, number, number] = [0.35, 0.35, 0.4];

/**
 * The environment derived from a flat ambient, as multiples of it (linear):
 * brighter overhead, darker underfoot, normalized so a camera-facing surface
 * receives the old flat ambient. Tops read lit, undersides fall off, and a
 * mirror finally has a horizon to reflect.
 */
const DEFAULT_SKY_GAIN = { top: 1.35, horizon: 1.0, bottom: 0.65 };

const TONE_MAP_IDS: Record<ToneMapping, number> = { none: 0, neutral: 1, aces: 2, agx: 3 };

/** Uniform values for an environment, computed once per environment object. */
interface PackedEnv {
  top: [number, number, number];
  horizon: [number, number, number];
  bottom: [number, number, number];
  sunDir: [number, number, number];
  sunColor: [number, number, number];
  sunSize: number;
  envMap?: WebGLTexture;
  envMapLod: number;
  envMapIntensity: number;
  toneMap: number;
  exposure: number;
  grade: [number, number, number, number];
  fogMode: number;
  fogColor: [number, number, number];
  fogParams: [number, number, number, number];
  fogHeight: [number, number, number, number];
}

interface PackedLights {
  count: number;
  pos: Float32Array;
  col: Float32Array;
  dir: Float32Array;
  spot: Float32Array;
  ground: Float32Array;
}

function linear3(c: [number, number, number], scale = 1): [number, number, number] {
  return [srgbToLinear(c[0]) * scale, srgbToLinear(c[1]) * scale, srgbToLinear(c[2]) * scale];
}

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, ProgramInfo>();
  private quadVao!: WebGLVertexArrayObject;
  private overlayVao!: WebGLVertexArrayObject;
  private meshVaos = new WeakMap<Geometry, { vao: WebGLVertexArrayObject; count: number; vertexCount: number; indexType: number; hasColor: boolean; hasUv: boolean }>();
  private contextLost = false;
  /** Called after the context is restored so the owner can re-upload state. */
  onContextRestored?: () => void;
  /**
   * Cheap counters for scene info: draw calls and triangles submitted through
   * the renderer's draw entry points since beginFrame (read between frames,
   * they are the last rendered frame's totals), and an estimate of the bytes
   * of textures uploaded through uploadTexture / uploadImageTexture.
   */
  readonly frameStats = { drawCalls: 0, triangles: 0 };
  private textureByteSizes = new WeakMap<WebGLTexture, number>();
  textureBytes = 0;
  private countDraw(triangles: number): void {
    this.frameStats.drawCalls++;
    this.frameStats.triangles += triangles;
  }
  private trackTextureBytes(tex: WebGLTexture, bytes: number): void {
    this.textureBytes += bytes - (this.textureByteSizes.get(tex) ?? 0);
    this.textureByteSizes.set(tex, bytes);
  }

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
      this.disposeShadow();         // depth targets died with the context
      this.samplers.clear();        // so did the mesh samplers
      this.dummyDepth = undefined;
      this.initStaticResources();
      this.onContextRestored?.();
    });

    this.initStaticResources();
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  /**
   * The WebGL2 context, for self-contained render modules (GPU particles,
   * thick lines, post effects) that compile and own their programs. They
   * must restore the global state this renderer relies on (premultiplied
   * blending on, depth test off, no culling, default framebuffer) when done.
   */
  get context(): WebGL2RenderingContext {
    return this.gl;
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
  maxBufferSize(): number {
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
    this.frameStats.drawCalls = 0;
    this.frameStats.triangles = 0;
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
    gl.enable(gl.SCISSOR_TEST);
    this.scissorCss(r);
  }

  /** Set gl.scissor from a CSS-px rect, in the coordinates of the active target. */
  private scissorCss(r: { x: number; y: number; width: number; height: number }): void {
    const dpr = this.canvas.width / Math.max(1, this.cssWidth);
    const t = this.targets[this.targets.length - 1];
    this.gl.scissor(
      Math.round(r.x * dpr) - (t?.x0 ?? 0),
      Math.round(this.canvas.height - (r.y + r.height) * dpr) - (t?.y0 ?? 0),
      Math.round(r.width * dpr),
      Math.round(r.height * dpr),
    );
  }

  // ── Offscreen render targets (post effects) ─────────────────────────

  /**
   * Targets draws are redirected into, innermost last. A target covers a
   * canvas-px region (x0, y0 = its bottom-left in GL window coordinates);
   * the viewport keeps the whole canvas's mapping, offset so that region
   * lands in the target, so every projection, screen-space width and module
   * drawing through this context renders exactly as it would on screen.
   */
  private targets: RenderTarget[] = [];

  /** The target draws currently land in, if any. */
  get activeTarget(): RenderTarget | undefined { return this.targets[this.targets.length - 1]; }

  /** Redirect subsequent draws into a target (see targets). */
  pushTarget(t: RenderTarget): void {
    this.targets.push(t);
    this.bindActiveTarget();
  }

  /** Stop drawing into the innermost target. */
  popTarget(): void {
    this.targets.pop();
    this.bindActiveTarget();
  }

  /** Bind the active target (or the canvas) with its viewport. */
  bindActiveTarget(): void {
    const gl = this.gl;
    const t = this.activeTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(-(t?.x0 ?? 0), -(t?.y0 ?? 0), this.canvas.width, this.canvas.height);
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
      const sw = (source as HTMLImageElement).naturalWidth || source.width;
      const sh = (source as HTMLImageElement).naturalHeight || source.height;
      this.trackTextureBytes(tex, sw * sh * 4);
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

  /**
   * Upload a loaded image as a mesh map (albedo, normal, env...): premultiplied
   * like every texture, plus a full mip chain so it minifies cleanly (the mesh
   * samplers add trilinear and anisotropic filtering). Window-content textures
   * change every frame and stay on uploadTexture without mips.
   */
  uploadImageTexture(tex: WebGLTexture, source: OffscreenCanvas | HTMLCanvasElement | HTMLImageElement | ImageBitmap): boolean {
    if (!this.uploadTexture(tex, source)) return false;
    const gl = this.gl;
    const w = (source as HTMLImageElement).naturalWidth || source.width;
    const h = (source as HTMLImageElement).naturalHeight || source.height;
    gl.generateMipmap(gl.TEXTURE_2D);
    this.textureLevels.set(tex, Math.floor(Math.log2(Math.max(1, w, h))) + 1);
    this.trackTextureBytes(tex, Math.round(w * h * 4 * 4 / 3)); // the mip chain adds a third
    return true;
  }

  deleteTexture(tex: WebGLTexture): void {
    this.trackTextureBytes(tex, 0);
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
      gl.enable(gl.SCISSOR_TEST);
      this.scissorCss(o.scissor);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.countDraw(2);
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
    this.countDraw(2);
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
    this.countDraw(2);
  }

  private static readonly MESH_UNIFORMS = [
    'uModel', 'uViewProj', 'uNormalMat', 'uPointSize', 'uHasUv', 'uUvTransform',
    'uColor', 'uEmissive', 'uOpacity', 'uMetalness', 'uRoughness', 'uCameraPos',
    'uUseVertexColor', 'uUseTexture', 'uAdditive', 'uFrontOnly', 'uTex', 'uEnvIntensity',
    'uLightCount', 'uLightPos', 'uLightColor', 'uLightDir', 'uLightSpot', 'uLightGround',
    'uEnvTop', 'uEnvHorizon', 'uEnvBottom', 'uSunDir', 'uSunColor', 'uSunSize',
    'uEnvMap', 'uEnvMapLod', 'uEnvMapIntensity',
    'uReceiveShadow', 'uShadowEnabled', 'uShadowLight', 'uShadowMap', 'uLightVP', 'uShadowParams',
    'uSpotShadowEnabled', 'uSpotShadowLight', 'uSpotShadowMap', 'uSpotLightVP', 'uSpotShadowParams',
    'uNormalMap', 'uNormalScale', 'uRoughnessMap', 'uMetalnessMap', 'uAoMap', 'uEmissiveMap', 'uMatcapMap',
    'uClearcoat', 'uClearcoatRoughness', 'uSheen', 'uSheenColor', 'uTransmission', 'uIor',
    'uToonSteps', 'uRimColor', 'uRimPower',
    'uFogMode', 'uFogColor', 'uFogParams', 'uFogHeight', 'uToneMap', 'uExposure', 'uGrade',
    'uOutlineWidth', 'uViewportPx', 'uHullRadial', 'uOutlineColor',
  ];

  /** Environments packed into uniform values, reused across a subtree's meshes. */
  private envCache = new WeakMap<EnvironmentOpts, PackedEnv>();
  /** Light arrays packed into uniform arrays, reused across a subtree's meshes. */
  private lightCache = new WeakMap<MeshLight[], PackedLights>();
  /** Texture units bound for the current mesh draw, released right after it. */
  private boundMeshUnits: number[] = [];
  /**
   * A 1x1 compare-mode depth texture for shadow samplers whose shadow is off.
   * WebGL rejects a draw whose shadow sampler sees a texture without compare
   * mode (or whose colour sampler sees one with it), even on a branch that
   * never samples, so every sampler always gets a texture of its own kind.
   */
  private dummyDepth?: WebGLTexture;

  /**
   * The program for a mesh variant, compiled on first use. A variant this GPU
   * rejects falls back to plain standard shading, and if even that fails the
   * caller skips the draw ("no 3D") instead of throwing out of the frame.
   */
  private meshProgram(v: MeshVariant): ProgramInfo | null {
    const key = meshVariantKey(v);
    const hit = this.programs.get(key);
    if (hit) return hit;
    if (!this.programErrors.has(key)) {
      try {
        const info = this.getProgram(key, meshVertexSource(v.instanced), meshFragmentSource(v), GlRenderer.MESH_UNIFORMS);
        this.assignSamplerUnits(info);
        return info;
      } catch {
        // reason already logged once by getProgram
      }
    }
    const base: MeshVariant = { ...DEFAULT_MESH_VARIANT, instanced: v.instanced };
    return meshVariantKey(base) === key ? null : this.meshProgram(base);
  }

  /**
   * Point every sampler at its own fixed unit once, at link time. Left at the
   * default (unit 0), a shadow sampler and a colour sampler would share a unit,
   * which WebGL rejects at draw time.
   */
  private assignSamplerUnits(info: ProgramInfo): void {
    const gl = this.gl;
    gl.useProgram(info.program);
    for (const [name, unit] of Object.entries(MESH_UNITS)) {
      const loc = gl.getUniformLocation(info.program, name);
      if (loc) gl.uniform1i(loc, unit);
    }
  }

  private variantFor(o: MeshMaterialOpts, env: PackedEnv, instanced: boolean): MeshVariant {
    const shading = o.shading ?? 'standard';
    const lit = shading === 'standard' || shading === 'toon';
    const std = shading === 'standard';
    const maps = o.maps ?? {};
    return {
      shading,
      instanced,
      normalMap: shading !== 'unlit' && !!maps.normal,
      roughnessMap: lit && !!maps.roughness,
      metalnessMap: lit && !!maps.metalness,
      aoMap: lit && !!maps.ao,
      emissiveMap: !!maps.emissive,
      matcapMap: shading === 'matcap' && !!maps.matcap,
      envMap: (lit || shading === 'rim') && !!env.envMap,
      clearcoat: std && (o.clearcoat ?? 0) > 0,
      sheen: std && (o.sheen ?? 0) > 0,
      transmission: std && (o.transmission ?? 0) > 0,
    };
  }

  /** Pack an environment's uniform values (cached per environment object). */
  private packEnvironment(o: MeshMaterialOpts): PackedEnv {
    const env = o.environment;
    if (env) {
      const hit = this.envCache.get(env);
      if (hit) return hit;
    }
    const ambient = env?.ambient ?? o.ambient ?? DEFAULT_AMBIENT;
    const intensity = Math.max(0, env?.envIntensity ?? 1);
    let top: [number, number, number], horizon: [number, number, number], bottom: [number, number, number];
    if (env?.sky) {
      top = linear3(env.sky.top, intensity);
      horizon = linear3(env.sky.horizon, intensity);
      bottom = linear3(env.sky.bottom, intensity);
    } else {
      const a = linear3(ambient, intensity);
      top = [a[0] * DEFAULT_SKY_GAIN.top, a[1] * DEFAULT_SKY_GAIN.top, a[2] * DEFAULT_SKY_GAIN.top];
      horizon = [a[0] * DEFAULT_SKY_GAIN.horizon, a[1] * DEFAULT_SKY_GAIN.horizon, a[2] * DEFAULT_SKY_GAIN.horizon];
      bottom = [a[0] * DEFAULT_SKY_GAIN.bottom, a[1] * DEFAULT_SKY_GAIN.bottom, a[2] * DEFAULT_SKY_GAIN.bottom];
    }
    let sunDir: [number, number, number] = [0, -1, 0];
    let sunColor: [number, number, number] = [0, 0, 0];
    let sunSize = 0;
    const sun = env?.sky?.sun;
    if (sun && sun.intensity > 0) {
      const d = sun.direction;
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      sunDir = [d[0] / l, d[1] / l, d[2] / l];
      const k = sun.intensity * intensity;
      sunColor = [sun.color[0] * k, sun.color[1] * k, sun.color[2] * k];
      sunSize = Math.max(0, sun.size);
    }
    const levels = env?.envMap ? (this.textureLevels.get(env.envMap) ?? 1) : 1;
    const g = env?.grading ?? {};
    const fog = env?.fog ?? o.fog;
    const fogMode = !fog ? 0 : fog.mode === 'exp' ? 2 : fog.mode === 'exp2' ? 3 : 1;
    const packed: PackedEnv = {
      top, horizon, bottom, sunDir, sunColor, sunSize,
      envMap: env?.envMap,
      envMapLod: Math.max(0, levels - 1),
      envMapIntensity: intensity,
      toneMap: TONE_MAP_IDS[env?.toneMapping ?? 'neutral'] ?? 1,
      exposure: Math.max(0, env?.exposure ?? 1),
      grade: [g.contrast ?? 1, g.saturation ?? 1, g.temperature ?? 0, g.tint ?? 0],
      fogMode,
      fogColor: fog ? [fog.color[0], fog.color[1], fog.color[2]] : [0, 0, 0],
      fogParams: fog ? [fog.near, fog.far, Math.max(0, fog.density ?? 0), fog.start ?? fog.near] : [0, 0, 0, 0],
      fogHeight: fog && fog.height !== undefined
        ? [1, fog.height, Math.max(1e-6, fog.heightFalloff ?? 0.01), 0]
        : [0, 0, 0, 0],
    };
    if (env) this.envCache.set(env, packed);
    return packed;
  }

  private packLights(lights: MeshLight[]): PackedLights {
    const hit = this.lightCache.get(lights);
    if (hit) return hit;
    const n = Math.min(lights.length, MAX_MESH_LIGHTS);
    const p: PackedLights = {
      count: n,
      pos: new Float32Array(MAX_MESH_LIGHTS * 4),
      col: new Float32Array(MAX_MESH_LIGHTS * 3),
      dir: new Float32Array(MAX_MESH_LIGHTS * 4),
      spot: new Float32Array(MAX_MESH_LIGHTS * 4),
      ground: new Float32Array(MAX_MESH_LIGHTS * 3),
    };
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      p.pos.set(l.pos, i * 4);
      p.col.set(l.color, i * 3);
      const d = l.dir ?? [0, 1, 0];
      p.dir.set([d[0], d[1], d[2], l.range ?? 0], i * 4);
      const isSpot = l.pos[3] >= 1.5 && l.pos[3] < 2.5 ? 1 : 0;
      p.spot.set([l.spotInner ?? 1, l.spotOuter ?? 0, isSpot, 0], i * 4);
      if (l.groundColor) p.ground.set(l.groundColor, i * 3);
    }
    this.lightCache.set(lights, p);
    return p;
  }

  // ── Mesh texture sampling ────────────────────────────────────────────

  /** Mip level counts for textures uploaded with mipmaps (mesh maps, env maps). */
  private textureLevels = new WeakMap<WebGLTexture, number>();
  private samplers = new Map<string, WebGLSampler>();

  /**
   * A sampler for a mesh map. Mipmapped textures get trilinear + anisotropic
   * filtering; `repeat` tiles (uvRepeat / uvOffset); `env` wraps around the
   * horizon of an equirect map but clamps at the poles.
   */
  private sampler(mip: boolean, wrap: 'clamp' | 'repeat' | 'env'): WebGLSampler {
    const key = `${mip ? 'm' : 'l'}:${wrap}`;
    let s = this.samplers.get(key);
    if (s) return s;
    const gl = this.gl;
    s = gl.createSampler()!;
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap === 'clamp' ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    if (mip) {
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
        gl.samplerParameterf(s, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max || 1));
      }
    }
    this.samplers.set(key, s);
    return s;
  }

  private bindMeshTexture(unit: number, tex: WebGLTexture, wrap: 'clamp' | 'repeat' | 'env'): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindSampler(unit, this.sampler(this.textureLevels.has(tex), wrap));
    this.boundMeshUnits.push(unit);
  }

  /** Bind a depth map (or the dummy) to a shadow unit; its own compare mode must win over any sampler. */
  private bindDepthTexture(unit: number, tex: WebGLTexture | undefined): void {
    const gl = this.gl;
    if (!tex) {
      if (!this.dummyDepth) {
        this.dummyDepth = gl.createTexture()!;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.dummyDepth);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xffffffff]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      }
      tex = this.dummyDepth;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindSampler(unit, null);
    this.boundMeshUnits.push(unit);
  }

  /**
   * Unbind the draw's textures and samplers, so no depth map or sampler state
   * lingers on a unit another pass or module samples from.
   */
  private releaseMeshUnits(): void {
    const gl = this.gl;
    for (const unit of this.boundMeshUnits) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindSampler(unit, null);
    }
    this.boundMeshUnits.length = 0;
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Bind the mesh program for this material's variant and set every uniform.
   * Returns null if no mesh program can be built on this GPU; callers then
   * skip the draw so a driver that rejects the mesh shader degrades to "no 3D"
   * rather than throwing out of the frame and blanking the 2D desktop with it.
   */
  private useMeshMaterial(o: MeshMaterialOpts, instanced: boolean, hasUv: boolean, hasColor: boolean): ProgramInfo | null {
    const gl = this.gl;
    const env = this.packEnvironment(o);
    const p = this.meshProgram(this.variantFor(o, env, instanced));
    if (!p) return null;
    const u = p.uniforms;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(u.uModel, false, o.model);
    gl.uniformMatrix4fv(u.uViewProj, false, o.viewProj);
    gl.uniformMatrix3fv(u.uNormalMat, false, mat3NormalMatrix(o.model));
    gl.uniform1f(u.uPointSize, o.pointSize ?? 4);
    gl.uniform1i(u.uHasUv, hasUv ? 1 : 0);
    const rep = o.uvRepeat ?? [1, 1];
    const off = o.uvOffset ?? [0, 0];
    gl.uniform4f(u.uUvTransform, rep[0], rep[1], off[0], off[1]);
    const wrap = rep[0] !== 1 || rep[1] !== 1 || off[0] !== 0 || off[1] !== 0 ? 'repeat' : 'clamp';

    gl.uniform3f(u.uColor, srgbToLinear(o.color.r), srgbToLinear(o.color.g), srgbToLinear(o.color.b));
    const em = o.emissive ?? { r: 0, g: 0, b: 0, a: 0 };
    gl.uniform3f(u.uEmissive, srgbToLinear(em.r * em.a), srgbToLinear(em.g * em.a), srgbToLinear(em.b * em.a));
    gl.uniform1f(u.uOpacity, o.opacity ?? 1);
    gl.uniform1f(u.uMetalness, Math.min(1, Math.max(0, o.metalness ?? 0)));
    gl.uniform1f(u.uRoughness, Math.min(1, Math.max(0, o.roughness ?? 0.55)));
    gl.uniform3f(u.uCameraPos, o.cameraPos[0], o.cameraPos[1], o.cameraPos[2]);
    gl.uniform1i(u.uUseVertexColor, hasColor ? 1 : 0);
    gl.uniform1i(u.uAdditive, o.blend === 'additive' ? 1 : 0);
    gl.uniform1i(u.uFrontOnly, o.closed && GlRenderer.addsLight(o) ? 1 : 0);
    gl.uniform1f(u.uEnvIntensity, Math.max(0, o.envIntensity ?? 1));

    if (o.texture) {
      this.bindMeshTexture(MESH_UNITS.uTex, o.texture, wrap);
      gl.uniform1i(u.uUseTexture, 1);
    } else {
      // Whatever an earlier pass left on unit 0 must not be a depth map.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.uniform1i(u.uUseTexture, 0);
    }
    const maps = o.maps ?? {};
    if (maps.normal) { this.bindMeshTexture(MESH_UNITS.uNormalMap, maps.normal, wrap); gl.uniform1f(u.uNormalScale, o.normalScale ?? 1); }
    if (maps.roughness) this.bindMeshTexture(MESH_UNITS.uRoughnessMap, maps.roughness, wrap);
    if (maps.metalness) this.bindMeshTexture(MESH_UNITS.uMetalnessMap, maps.metalness, wrap);
    if (maps.ao) this.bindMeshTexture(MESH_UNITS.uAoMap, maps.ao, wrap);
    if (maps.emissive) this.bindMeshTexture(MESH_UNITS.uEmissiveMap, maps.emissive, wrap);
    if (maps.matcap) this.bindMeshTexture(MESH_UNITS.uMatcapMap, maps.matcap, 'clamp');

    const lights = this.packLights(o.lights ?? []);
    gl.uniform1i(u.uLightCount, lights.count);
    if (lights.count > 0) {
      gl.uniform4fv(u.uLightPos, lights.pos);
      gl.uniform3fv(u.uLightColor, lights.col);
      gl.uniform4fv(u.uLightDir, lights.dir);
      gl.uniform4fv(u.uLightSpot, lights.spot);
      gl.uniform3fv(u.uLightGround, lights.ground);
    }

    gl.uniform3fv(u.uEnvTop, env.top);
    gl.uniform3fv(u.uEnvHorizon, env.horizon);
    gl.uniform3fv(u.uEnvBottom, env.bottom);
    gl.uniform3fv(u.uSunDir, env.sunDir);
    gl.uniform3fv(u.uSunColor, env.sunColor);
    gl.uniform1f(u.uSunSize, env.sunSize);
    if (env.envMap) {
      this.bindMeshTexture(MESH_UNITS.uEnvMap, env.envMap, 'env');
      gl.uniform1f(u.uEnvMapLod, env.envMapLod);
      gl.uniform1f(u.uEnvMapIntensity, env.envMapIntensity);
    }

    gl.uniform1i(u.uReceiveShadow, o.receiveShadow === false ? 0 : 1);
    this.setShadowUniforms(u, o.shadow, MESH_UNITS.uShadowMap, 'uShadowEnabled', 'uShadowLight', 'uLightVP', 'uShadowParams', 0.0008);
    this.setShadowUniforms(u, o.spotShadow, MESH_UNITS.uSpotShadowMap, 'uSpotShadowEnabled', 'uSpotShadowLight', 'uSpotLightVP', 'uSpotShadowParams', 0.00008);

    const lin = (c: RGBA | undefined, fallback: [number, number, number]): [number, number, number] =>
      c ? [srgbToLinear(c.r * c.a), srgbToLinear(c.g * c.a), srgbToLinear(c.b * c.a)] : fallback;
    gl.uniform1f(u.uClearcoat, Math.min(1, Math.max(0, o.clearcoat ?? 0)));
    gl.uniform1f(u.uClearcoatRoughness, Math.min(1, Math.max(0, o.clearcoatRoughness ?? 0.1)));
    gl.uniform1f(u.uSheen, Math.min(1, Math.max(0, o.sheen ?? 0)));
    gl.uniform3fv(u.uSheenColor, lin(o.sheenColor, [1, 1, 1]));
    gl.uniform1f(u.uTransmission, Math.min(1, Math.max(0, o.transmission ?? 0)));
    gl.uniform1f(u.uIor, Math.max(1, o.ior ?? 1.5));
    gl.uniform1f(u.uToonSteps, Math.max(2, Math.round(o.toonSteps ?? 3)));
    gl.uniform3fv(u.uRimColor, lin(o.rimColor, [0.35, 0.9, 0.63]));
    gl.uniform1f(u.uRimPower, Math.max(0.1, o.rimPower ?? 2.5));

    this.setOutputUniforms(u, env);
    return p;
  }

  private setShadowUniforms(
    u: Record<string, WebGLUniformLocation | null>, s: ShadowOpts | undefined, unit: number,
    enabled: string, index: string, vp: string, params: string, defaultBias: number,
  ): void {
    const gl = this.gl;
    this.bindDepthTexture(unit, s?.map);
    if (!s) { gl.uniform1i(u[enabled], 0); return; }
    gl.uniform1i(u[enabled], 1);
    gl.uniform1i(u[index], s.lightIndex);
    gl.uniformMatrix4fv(u[vp], false, s.lightVP);
    const size = s.size ?? SHADOW_SIZE;
    gl.uniform4f(u[params], 1 / size, s.softness ?? 1.5, s.bias ?? defaultBias, s.normalOffset ?? 0);
  }

  private setOutputUniforms(u: Record<string, WebGLUniformLocation | null>, env: PackedEnv): void {
    const gl = this.gl;
    gl.uniform1i(u.uFogMode, env.fogMode);
    gl.uniform3fv(u.uFogColor, env.fogColor);
    gl.uniform4fv(u.uFogParams, env.fogParams);
    gl.uniform4fv(u.uFogHeight, env.fogHeight);
    gl.uniform1i(u.uToneMap, env.toneMap);
    gl.uniform1f(u.uExposure, env.exposure);
    gl.uniform4fv(u.uGrade, env.grade);
  }

  /** Materials that add light over what is behind them rather than covering it. */
  private static addsLight(o: MeshMaterialOpts): boolean {
    return o.blend === 'additive' || o.shading === 'rim' || (o.transmission ?? 0) > 0;
  }

  /**
   * Issue a mesh draw with the material's depth behaviour, then its outline.
   * Light-adding materials (additive blend, rim holograms, glass) test depth
   * but write none, so they never punch holes in what draws after them.
   */
  private submitMesh(o: MeshMaterialOpts, instanced: boolean, hasUv: boolean, draw: () => void): void {
    const gl = this.gl;
    const addsLight = GlRenderer.addsLight(o);
    gl.enable(gl.DEPTH_TEST);
    if (addsLight) gl.depthMask(false);
    draw();
    if (addsLight) gl.depthMask(true);
    this.releaseMeshUnits();
    if (o.outline && o.outline.width > 0 && (o.drawMode ?? 'triangles') === 'triangles') {
      this.drawOutlineHull(o, instanced, hasUv, draw);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  /** Inverted-hull outline pass over the VAO the mesh draw just used. */
  private drawOutlineHull(o: MeshMaterialOpts, instanced: boolean, hasUv: boolean, draw: () => void): void {
    const gl = this.gl;
    const name = instanced ? 'meshOutlineI' : 'meshOutline';
    let p: ProgramInfo;
    try {
      p = this.programs.get(name)
        ?? this.getProgram(name, meshVertexSource(instanced, true), OUTLINE_FS, GlRenderer.MESH_UNIFORMS);
    } catch {
      return;
    }
    const u = p.uniforms;
    const ol = o.outline!;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(u.uModel, false, o.model);
    gl.uniformMatrix4fv(u.uViewProj, false, o.viewProj);
    gl.uniformMatrix3fv(u.uNormalMat, false, mat3NormalMatrix(o.model));
    gl.uniform1f(u.uPointSize, o.pointSize ?? 4);
    gl.uniform1i(u.uHasUv, hasUv ? 1 : 0);
    gl.uniform4f(u.uUvTransform, 1, 1, 0, 0);
    gl.uniform1f(u.uOutlineWidth, ol.width);
    gl.uniform2f(u.uViewportPx, Math.max(1, this.cssWidth), Math.max(1, this.cssHeight));
    gl.uniform1f(u.uHullRadial, ol.radial ? 1 : 0);
    gl.uniform3f(u.uCameraPos, o.cameraPos[0], o.cameraPos[1], o.cameraPos[2]);
    const a = ol.color.a * (o.opacity ?? 1);
    gl.uniform4f(u.uOutlineColor, ol.color.r, ol.color.g, ol.color.b, a);
    this.setOutputUniforms(u, this.packEnvironment(o));
    draw();
  }

  drawMesh(o: MeshDrawOpts): void {
    const gl = this.gl;
    const entry = this.getMeshVao(o.geometry);
    const p = this.useMeshMaterial(o, false, entry.hasUv, entry.hasColor);
    if (!p) return;
    gl.bindVertexArray(entry.vao);
    const mode = o.drawMode ?? 'triangles';
    this.submitMesh(o, false, entry.hasUv, () => {
      this.countDraw(mode === 'triangles' ? entry.count / 3 : 0);
      if (mode === 'triangles') {
        gl.drawElements(gl.TRIANGLES, entry.count, entry.indexType, 0);
      } else {
        gl.drawArrays(mode === 'lines' ? gl.LINE_STRIP : gl.POINTS, 0, entry.vertexCount);
      }
    });
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
    return { vao, posBuf, normBuf, colorBuf, uvBuf, idxBuf, count: 0, vertexCount: 0, indexType: gl.UNSIGNED_INT, hasColor: false, hasUv: false };
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
      mesh.hasUv = true;
    } else if (mesh.hasUv) {
      gl.disableVertexAttribArray(3);
      mesh.hasUv = false;
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
    const hasUv = mesh.hasUv ?? false;
    const p = this.useMeshMaterial(o, false, hasUv, mesh.hasColor);
    if (!p) return;
    gl.bindVertexArray(mesh.vao);
    const mode = o.drawMode ?? 'triangles';
    this.submitMesh(o, false, hasUv, () => {
      this.countDraw(mode === 'triangles' ? mesh.count / 3 : 0);
      if (mode === 'triangles') {
        gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
      } else {
        gl.drawArrays(mode === 'lines' ? gl.LINE_STRIP : gl.POINTS, 0, mesh.vertexCount);
      }
    });
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
    let uvBuf: WebGLBuffer | undefined;
    if (geometry.uvs) {
      uvBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    }
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
      vao, posBuf, normBuf, idxBuf, instBuf, uvBuf,
      count: geometry.indices.length,
      indexType: geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      instanceCount: 0,
      hasUv: !!geometry.uvs,
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
    const hasUv = mesh.hasUv ?? false;
    const p = this.useMeshMaterial(o, true, hasUv, true); // instance color drives albedo
    if (!p) return;
    // ...and because it does, uColor must be WHITE. The shader multiplies them
    // (albedo = uColor * vColor), and the compositor already defaults an
    // instance with no colour of its own to the NODE's colour — so leaving
    // uColor set to that same node colour rendered every instance at colour
    // SQUARED (a #808080 starfield came out at 0.25 grey, not 0.5).
    gl.uniform3f(p.uniforms.uColor, 1, 1, 1);
    gl.bindVertexArray(mesh.vao);
    this.submitMesh(o, true, hasUv, () => {
      this.countDraw((mesh.count / 3) * mesh.instanceCount);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.indexType, 0, mesh.instanceCount);
    });
  }

  deleteInstancedMesh(mesh: InstancedMesh): void {
    const gl = this.gl;
    gl.deleteBuffer(mesh.posBuf);
    gl.deleteBuffer(mesh.normBuf);
    gl.deleteBuffer(mesh.idxBuf);
    gl.deleteBuffer(mesh.instBuf);
    if (mesh.uvBuf) gl.deleteBuffer(mesh.uvBuf);
    gl.deleteVertexArray(mesh.vao);
  }

  // ── Shadow maps (a directional and a spot light) ─────────────────────

  /** Depth targets: slot 0 for the directional light, slot 1 for the spot light. */
  private shadowTargets: Array<{ fbo: WebGLFramebuffer; tex: WebGLTexture; size: number } | undefined> = [];
  private shadowPassSize = SHADOW_SIZE;

  /** The directional depth texture written by the last shadow pass (for mesh sampling). */
  get shadowMap(): WebGLTexture | undefined { return this.shadowTargets[0]?.tex; }
  /** The spot-light depth texture written by the last spot shadow pass. */
  get spotShadowMap(): WebGLTexture | undefined { return this.shadowTargets[1]?.tex; }

  /**
   * (Re)allocate a depth target. Compare mode + LINEAR filtering makes every
   * lookup a hardware 2x2 PCF, which the shader's Poisson taps build on.
   */
  private ensureShadowTarget(slot: number, size: number): void {
    const cur = this.shadowTargets[slot];
    if (cur && cur.size === size) return;
    const gl = this.gl;
    if (cur) { gl.deleteTexture(cur.tex); gl.deleteFramebuffer(cur.fbo); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Leave no compare-mode depth texture on the active unit: a colour sampler
    // reading that unit would make the next draw fail.
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.shadowTargets[slot] = { fbo, tex, size };
  }

  private disposeShadow(): void {
    const gl = this.gl;
    for (const t of this.shadowTargets) {
      if (!t) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.shadowTargets = [];
  }

  /**
   * Begin a depth-only shadow pass from a light's POV: `kind` picks the
   * directional or the spot map, `size` its resolution (clamped to what the
   * GPU allows). A slope-scaled polygon offset keeps receivers free of acne.
   */
  beginShadowPass(lightVP: Mat4, kind: 'directional' | 'spot' = 'directional', size = SHADOW_SIZE): void {
    const slot = kind === 'spot' ? 1 : 0;
    const res = Math.max(64, Math.min(Math.round(size), this.maxBufferSize()));
    this.ensureShadowTarget(slot, res);
    this.shadowPassSize = res;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowTargets[slot]!.fbo);
    gl.viewport(0, 0, res, res);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 2.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const p = this.getProgram('depth', DEPTH_VS, DEPTH_FS, ['uLightVP', 'uModel']);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.uLightVP, false, lightVP);
  }

  /** Resolution of the map the current (or last) shadow pass renders into. */
  get shadowSize(): number { return this.shadowPassSize; }

  /** Draw a caster's depth (static geometry) during a shadow pass. */
  drawDepthGeometry(geometry: Geometry, model: Mat4): void {
    const gl = this.gl;
    const p = this.getProgram('depth', DEPTH_VS, DEPTH_FS, ['uLightVP', 'uModel']);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, model);
    const entry = this.getMeshVao(geometry);
    gl.bindVertexArray(entry.vao);
    gl.drawElements(gl.TRIANGLES, entry.count, entry.indexType, 0);
    this.countDraw(entry.count / 3);
  }

  /** Draw a caster's depth (dynamic/custom mesh) during a shadow pass. */
  drawDepthDynamic(mesh: DynamicMesh, model: Mat4): void {
    if (mesh.count === 0) return;
    const gl = this.gl;
    const p = this.getProgram('depth', DEPTH_VS, DEPTH_FS, ['uLightVP', 'uModel']);
    gl.uniformMatrix4fv(p.uniforms.uModel, false, model);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    this.countDraw(mesh.count / 3);
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
    this.bindActiveTarget();   // back to the canvas, or the pass's offscreen target
    gl.disable(gl.POLYGON_OFFSET_FILL);
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

  // ── Bloom (post pass over the whole frame or one window) ─────────────

  private bloomSceneTex?: WebGLTexture;
  /** Mip chain: level i is (half res) >> i; each has its own framebuffer. */
  private bloomFbo: WebGLFramebuffer[] = [];
  private bloomTex: WebGLTexture[] = [];
  private bloomSize: Array<[number, number]> = [];
  private bloomW = 0;
  private bloomH = 0;
  /** Set once if the GPU can't complete the bloom FBOs; makes applyBloom a no-op. */
  private bloomUnavailable = false;

  private ensureBloomTargets(levels: number): void {
    const gl = this.gl;
    const w = Math.max(1, this.canvas.width >> 1);
    const h = Math.max(1, this.canvas.height >> 1);
    if (this.bloomSceneTex && this.bloomW === w && this.bloomH === h && this.bloomTex.length >= levels) return;
    // (Re)allocate the scene copy and the half-res mip chain.
    this.disposeBloomTargets();
    this.bloomW = w; this.bloomH = h;
    this.bloomSceneTex = this.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bloomSceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (let i = 0; i < levels; i++) {
      const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i);
      const tex = this.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      // An incomplete FBO (e.g. an oversized allocation on a limited mobile GPU)
      // must not throw mid-frame and kill the render loop — drop bloom instead.
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.bloomUnavailable = true;
      }
      this.bloomTex[i] = tex; this.bloomFbo[i] = fbo; this.bloomSize[i] = [lw, lh];
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.bindActiveTarget();
  }

  private disposeBloomTargets(): void {
    const gl = this.gl;
    if (this.bloomSceneTex) gl.deleteTexture(this.bloomSceneTex);
    this.bloomFbo.forEach((f) => gl.deleteFramebuffer(f));
    this.bloomTex.forEach((t) => gl.deleteTexture(t));
    this.bloomSceneTex = undefined; this.bloomFbo = []; this.bloomTex = []; this.bloomSize = []; this.bloomW = 0; this.bloomH = 0;
  }

  private blitFullscreen(): void {
    this.gl.bindVertexArray(this.overlayVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /**
   * Apply bloom as an additive post pass: copy the current backbuffer, keep
   * the bright pixels, spread them through a dual-filter mip chain
   * (downsample, then tent-upsample back up adding each level), and add the
   * glow back. Operates on a copy, so a failure here can only affect the
   * glow, never the base render. Call after the scene draws and before the
   * 2D chrome overlay.
   *
   * `levels` is the chain depth (the glow's reach: 3 is tight, 6 wide);
   * `opts.radius` spreads each upsample (1 = the filter's natural width).
   */
  applyBloom(
    threshold: number,
    intensity: number,
    levels = 3,
    rect?: { x: number; y: number; width: number; height: number },
    opts?: { radius?: number },
  ): void {
    const gl = this.gl;
    if (this.contextLost) return;
    const maxLevels = Math.max(1, Math.floor(Math.log2(Math.max(2, Math.min(this.canvas.width, this.canvas.height) >> 1))) - 1);
    const L = Math.max(1, Math.min(8, Math.round(levels), maxLevels));
    this.ensureBloomTargets(L);
    if (this.bloomUnavailable) return;
    // `rect` (CSS px, y-down) scopes the pass to one window: the bright
    // extraction is masked to it and the final composite is scissored to it,
    // so glow neither enters from outside nor spills out. Omitted, the pass
    // covers the whole frame, which is what a world-scene environment means.
    const dpr = this.canvas.width / Math.max(1, this.cssWidth);
    const cssH = this.canvas.height / dpr;
    const uvRect = rect
      ? [rect.x / this.cssWidth, rect.y / cssH, (rect.x + rect.width) / this.cssWidth, (rect.y + rect.height) / cssH]
      : [0, 0, 1, 1];
    // 1. Snapshot the lit backbuffer.
    gl.bindTexture(gl.TEXTURE_2D, this.bloomSceneTex!);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, this.canvas.width, this.canvas.height, 0);

    gl.disable(gl.BLEND);

    // 2. Bright-pass scene into the top of the chain (half res).
    const bright = this.getProgram('bloomBright', OVERLAY_VS, BRIGHT_FS, ['uTex', 'uThreshold', 'uRect']);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[0]);
    gl.viewport(0, 0, this.bloomSize[0][0], this.bloomSize[0][1]);
    gl.useProgram(bright.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomSceneTex!);
    gl.uniform1i(bright.uniforms.uTex, 0);
    gl.uniform1f(bright.uniforms.uThreshold, threshold);
    gl.uniform4f(bright.uniforms.uRect, uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
    this.blitFullscreen();

    // 3. Downsample through the chain (each level a softened half of the last).
    const down = this.getProgram('bloomDown', OVERLAY_VS, BLOOM_DOWN_FS, ['uTex', 'uHalfPixel']);
    gl.useProgram(down.program);
    gl.uniform1i(down.uniforms.uTex, 0);
    for (let i = 1; i < L; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[i]);
      gl.viewport(0, 0, this.bloomSize[i][0], this.bloomSize[i][1]);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[i - 1]);
      gl.uniform2f(down.uniforms.uHalfPixel, 0.5 / this.bloomSize[i - 1][0], 0.5 / this.bloomSize[i - 1][1]);
      this.blitFullscreen();
    }

    // 4. Upsample back up, adding each coarser level into the finer one.
    const up = this.getProgram('bloomUp', OVERLAY_VS, BLOOM_UP_FS, ['uTex', 'uHalfPixel']);
    gl.useProgram(up.program);
    gl.uniform1i(up.uniforms.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const spread = Math.max(0.25, opts?.radius ?? 1);
    for (let i = L - 1; i > 0; i--) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[i - 1]);
      gl.viewport(0, 0, this.bloomSize[i - 1][0], this.bloomSize[i - 1][1]);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[i]);
      gl.uniform2f(up.uniforms.uHalfPixel, spread * 0.5 / this.bloomSize[i][0], spread * 0.5 / this.bloomSize[i][1]);
      this.blitFullscreen();
    }

    // 5. Additively composite the glow onto the backbuffer.
    this.bindActiveTarget();
    gl.blendFunc(gl.ONE, gl.ONE);
    const comp = this.getProgram('bloomComposite', OVERLAY_VS, BLOOM_COMPOSITE_FS, ['uTex', 'uScale']);
    gl.useProgram(comp.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[0]);
    gl.uniform1i(comp.uniforms.uTex, 0);
    // Each level adds a similar energy, so normalise by the chain depth; a
    // shallow chain keeps the tight glow scenes were tuned with.
    gl.uniform1f(comp.uniforms.uScale, Math.max(0, intensity) * 1.1 / L);
    if (rect) this.setScissor(rect);
    this.blitFullscreen();
    if (rect) this.clearScissor();
    // Restore the standard premultiplied source-over blend.
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private getMeshVao(geometry: Geometry): { vao: WebGLVertexArrayObject; count: number; vertexCount: number; indexType: number; hasColor: boolean; hasUv: boolean } {
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
      hasUv: !!geometry.uvs,
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
