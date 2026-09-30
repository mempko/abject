/**
 * Post effects for one scene subtree: SSAO, depth of field, edge outlines,
 * light shafts, FXAA, chromatic aberration, vignette and grain. Each turns
 * on just by being set on the subtree's environment node.
 *
 * A pass that asks for any of them renders into a pooled offscreen target
 * (multisampled, then resolved to a colour texture and a depth texture)
 * that covers the pass's clip rect at device pixel ratio. The renderer's
 * viewport offset keeps every projection identical, so nothing drawing into
 * the target has to know. The chain then runs (AO, DOF and shafts at half or
 * quarter resolution) and the result composites back with premultiplied
 * alpha, clipped like the plain path. Subtrees without effects never touch
 * any of this.
 *
 * A frame-time governor steps the chain down when the device cannot keep up
 * (sample counts, then resolution, then the heaviest effects) and back up
 * when it can. Every program follows the mobile portability rules (highp on
 * both stages, int flags, constant loop bounds) and a program this GPU
 * rejects skips its effect instead of throwing out of the frame.
 */

import { GlRenderer, RenderTarget } from './renderer.js';
import { buildProgram, GlProgram } from './program-cache.js';
import { Mat4 } from './math.js';

/** Resolved post settings for one subtree (see resolveEnvironment). */
export interface PostSettings {
  ao?: { radius: number; intensity: number };
  dof?: { focus: number; range: number; aperture: number };
  outline?: { color: [number, number, number]; width: number };
  lightShafts?: { intensity: number; decay: number };
  chromaticAberration?: number;
  fxaa?: boolean;
  vignette?: number;
  grain?: number;
}

/** True when any post effect is on. */
export function hasPostEffects(p: PostSettings | undefined): p is PostSettings {
  return !!p && !!(p.ao || p.dof || p.outline || p.lightShafts || (p.chromaticAberration ?? 0) > 0
    || p.fxaa || (p.vignette ?? 0) > 0 || (p.grain ?? 0) > 0);
}

/** Camera facts the depth-based effects need. */
export interface PostFrame {
  viewProj: Mat4;
  invViewProj: Mat4;
  cameraPos: [number, number, number];
  /** Camera distance to the content plane (DOF focus is measured behind it). */
  baseline: number;
  /** Direction toward the sun or brightest light (world), for light shafts. */
  lightDir?: [number, number, number];
  /** A light position (world), used when there is no directional light. */
  lightPos?: [number, number, number];
}

/** Quality levels the governor steps through. */
const LEVELS = [
  { name: 'full', ao: 12, dof: 16, shafts: 32, scale: 2, heavy: true },
  { name: 'reduced samples', ao: 8, dof: 12, shafts: 24, scale: 2, heavy: true },
  { name: 'quarter resolution', ao: 6, dof: 8, shafts: 16, scale: 4, heavy: true },
  { name: 'no AO or depth of field', ao: 6, dof: 8, shafts: 12, scale: 4, heavy: false },
] as const;

interface LowRes { width: number; height: number; tex: WebGLTexture[]; fbo: WebGLFramebuffer[] }

/** GPU resources for one target size, reused across subtrees and frames. */
interface TargetSet {
  width: number;
  height: number;
  msFbo?: WebGLFramebuffer;
  msColor?: WebGLRenderbuffer;
  msDepth?: WebGLRenderbuffer;
  resolveFbo: WebGLFramebuffer;
  color: WebGLTexture;
  depth: WebGLTexture;
  /** Full-resolution ping-pong: [combine, fxaa]. */
  full: { tex: WebGLTexture[]; fbo: WebGLFramebuffer[] };
  /** Low-resolution [ao, dof, shafts] per scale divisor. */
  low: Map<number, LowRes>;
  lastUsed: number;
}

/** An open post pass: the target draws land in until end(). */
export interface PostPass {
  set: TargetSet;
  target: RenderTarget;
  /** The covered region in canvas px (bottom-left origin). */
  x0: number; y0: number; width: number; height: number;
}

const VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aPos;
out highp vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/** Shared GLSL: world position and view distance from the depth texture. */
const DEPTH_GLSL = `
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec4 uNdcRect;     // target uv -> canvas NDC: xy + uv * zw
vec3 worldAt(vec2 uv, float d) {
  vec4 p = uInvViewProj * vec4(uNdcRect.xy + uv * uNdcRect.zw, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float depthAt(vec2 uv) { return texture(uDepth, uv).r; }
`;

function aoFs(samples: number): string {
  return `#version 300 es
precision highp float;
precision highp int;
// Full-precision texture reads: the depth-based effects need every bit of the
// depth texture, and some drivers honour the default lowp sampler precision.
precision highp sampler2D;
in highp vec2 vUv;
out vec4 outColor;
${DEPTH_GLSL}
uniform mat4 uViewProj;
uniform vec2 uTexel;       // full-res texel (uv)
uniform float uRadius;     // world px
uniform float uIntensity;
const int SAMPLES = ${samples};
vec3 kernel(int i) {
  float fi = float(i);
  float a = fi * 2.39996323;                     // golden angle spiral over the hemisphere
  float z = 1.0 - (fi + 0.5) / float(SAMPLES);
  float r = sqrt(max(0.0, 1.0 - z * z));
  float s = mix(0.2, 1.0, (fi + 1.0) / float(SAMPLES));
  return vec3(cos(a) * r, sin(a) * r, z) * s;
}
void main() {
  // This pass runs at reduced resolution over a point-sampled full-res
  // depth texture: snap to a full-res texel centre so the neighbours below
  // sit exactly one texel away on each side.
  vec2 uv = (floor(vUv / uTexel) + 0.5) * uTexel;
  float d = depthAt(uv);
  if (d >= 0.99999) { outColor = vec4(1.0); return; }
  vec3 P = worldAt(uv, d);
  // Normal from the nearer neighbour on each axis, so it never spans an edge.
  vec2 tx = vec2(uTexel.x, 0.0), ty = vec2(0.0, uTexel.y);
  vec3 pr = worldAt(uv + tx, depthAt(uv + tx)) - P;
  vec3 pl = P - worldAt(uv - tx, depthAt(uv - tx));
  vec3 pu = worldAt(uv + ty, depthAt(uv + ty)) - P;
  vec3 pd = P - worldAt(uv - ty, depthAt(uv - ty));
  vec3 ddx = dot(pr, pr) < dot(pl, pl) ? pr : pl;
  vec3 ddy = dot(pu, pu) < dot(pd, pd) ? pu : pd;
  vec3 N = normalize(cross(ddx, ddy));
  if (dot(N, uCameraPos - P) < 0.0) N = -N;
  float rnd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  vec3 up = abs(N.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float c = cos(rnd), s = sin(rnd);
  vec3 T2 = T * c + B * s;
  vec3 B2 = cross(N, T2);
  float occ = 0.0;
  float dist = length(uCameraPos - P);
  for (int i = 0; i < SAMPLES; i++) {
    vec3 k = kernel(i);
    vec3 S = P + (T2 * k.x + B2 * k.y + N * k.z) * uRadius;
    vec4 clip = uViewProj * vec4(S, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 uvS = ((clip.xy / clip.w) - uNdcRect.xy) / uNdcRect.zw;
    if (uvS.x < 0.0 || uvS.y < 0.0 || uvS.x > 1.0 || uvS.y > 1.0) continue;
    float ds = depthAt(uvS);
    if (ds >= 0.99999) continue;
    vec3 Q = worldAt(uvS, ds);
    float sampleDist = length(uCameraPos - S);
    float sceneDist = length(uCameraPos - Q);
    float range = smoothstep(0.0, 1.0, uRadius / max(abs(dist - sceneDist), 1e-3));
    float bias = uRadius * 0.08 + sampleDist * 0.002;
    occ += (sceneDist < sampleDist - bias ? 1.0 : 0.0) * range;
  }
  float ao = clamp(1.0 - occ / float(SAMPLES) * uIntensity, 0.0, 1.0);
  outColor = vec4(ao, ao, ao, 1.0);
}
`;
}

function dofFs(taps: number): string {
  return `#version 300 es
precision highp float;
precision highp int;
// Full-precision texture reads: the depth-based effects need every bit of the
// depth texture, and some drivers honour the default lowp sampler precision.
precision highp sampler2D;
in highp vec2 vUv;
out vec4 outColor;
${DEPTH_GLSL}
uniform sampler2D uColor;
uniform vec2 uPx;          // one CSS px in target uv
uniform vec3 uDof;         // focus distance (camera), half range, aperture (css px)
const int TAPS = ${taps};
float coc(vec2 uv) {
  float d = depthAt(uv);
  if (d >= 0.99999) return 0.0;
  float dist = length(uCameraPos - worldAt(uv, d));
  return clamp((abs(dist - uDof.x) - uDof.y) / max(uDof.y, 1.0), 0.0, 1.0);
}
void main() {
  float c = coc(vUv);
  vec4 sum = texture(uColor, vUv);
  float wsum = 1.0;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i);
    float a = fi * 2.39996323;
    float r = sqrt((fi + 0.5) / float(TAPS));
    vec2 off = vec2(cos(a), sin(a)) * r * uDof.z * c * uPx;
    vec2 uv = vUv + off;
    // A sharp neighbour does not bleed into a blurred pixel as much.
    float w = mix(0.3, 1.0, coc(uv));
    sum += texture(uColor, uv) * w;
    wsum += w;
  }
  outColor = vec4((sum / wsum).rgb, (sum / wsum).a);
}
`;
}

function shaftsFs(samples: number): string {
  return `#version 300 es
precision highp float;
precision highp int;
// Full-precision texture reads: the depth-based effects need every bit of the
// depth texture, and some drivers honour the default lowp sampler precision.
precision highp sampler2D;
in highp vec2 vUv;
out vec4 outColor;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uLight;       // light position in target uv
uniform float uDecay;
const int SAMPLES = ${samples};
vec3 source(vec2 uv) {
  vec4 c = texture(uColor, uv);
  float sky = texture(uDepth, uv).r >= 0.99999 ? 1.0 : 0.0;
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  // Open sky feeds the shafts; bright lit surfaces add a little.
  return c.rgb * max(sky * c.a, smoothstep(0.75, 1.0, l) * 0.35);
}
void main() {
  vec2 delta = (vUv - uLight) / float(SAMPLES) * 0.9;
  vec2 uv = vUv;
  vec3 sum = vec3(0.0);
  float w = 1.0;
  for (int i = 0; i < SAMPLES; i++) {
    uv -= delta;
    sum += source(uv) * w;
    w *= uDecay;
  }
  outColor = vec4(sum / float(SAMPLES), 1.0);
}
`;
}

const COMBINE_FS = `#version 300 es
precision highp float;
precision highp int;
// Full-precision texture reads: the depth-based effects need every bit of the
// depth texture, and some drivers honour the default lowp sampler precision.
precision highp sampler2D;
in highp vec2 vUv;
out vec4 outColor;
${DEPTH_GLSL}
uniform sampler2D uColor;
uniform sampler2D uAo;
uniform sampler2D uDofTex;
uniform sampler2D uShafts;
uniform int uUseAo;
uniform int uUseDof;
uniform int uUseShafts;
uniform int uUseOutline;
uniform vec2 uTexel;
uniform vec3 uDof;
uniform vec4 uOutline;     // rgb (display), width in texels
uniform float uShaftIntensity;
float viewDist(vec2 uv) {
  float d = depthAt(uv);
  return d >= 0.99999 ? 1e9 : length(uCameraPos - worldAt(uv, d));
}
void main() {
  vec4 col = texture(uColor, vUv);
  if (uUseAo != 0) {
    // 3x3 tent over the low-resolution AO.
    float ao = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ao += texture(uAo, vUv + vec2(float(x), float(y)) * uTexel * 2.0).r * (x == 0 && y == 0 ? 0.25 : (x == 0 || y == 0 ? 0.125 : 0.0625));
      }
    }
    col.rgb *= ao;
  }
  if (uUseDof != 0) {
    float d = depthAt(vUv);
    float c = 0.0;
    if (d < 0.99999) {
      float dist = length(uCameraPos - worldAt(vUv, d));
      c = clamp((abs(dist - uDof.x) - uDof.y) / max(uDof.y, 1.0), 0.0, 1.0);
    }
    col = mix(col, texture(uDofTex, vUv), smoothstep(0.0, 0.6, c));
  }
  if (uUseOutline != 0) {
    // Edges and creases: across a plane, reciprocal distance changes
    // linearly over the screen, so the centre sits halfway between its
    // neighbours. A depth jump (silhouette) or a fold (crease) breaks that,
    // and steep planes, however foreshortened, do not.
    // (1 - depth) is proportional to reciprocal view depth, which is exactly
    // linear across a plane on screen.
    // Whole-texel offsets: the depth texture is point-sampled, and a
    // fractional offset rounds unevenly, which would make planes look bent.
    vec2 o = uTexel * max(1.0, floor(uOutline.w + 0.5));
    float ic = 1.0 - depthAt(vUv);
    float il = 1.0 - depthAt(vUv - vec2(o.x, 0.0));
    float ir = 1.0 - depthAt(vUv + vec2(o.x, 0.0));
    float ib = 1.0 - depthAt(vUv - vec2(0.0, o.y));
    float it = 1.0 - depthAt(vUv + vec2(0.0, o.y));
    float dev = (abs(il + ir - 2.0 * ic) + abs(ib + it - 2.0 * ic)) / max(max(ic, max(max(il, ir), max(ib, it))), 1e-9);
    float edge = smoothstep(0.004, 0.012, dev);
    col.rgb = mix(col.rgb, uOutline.rgb * max(col.a, edge), edge);
    col.a = max(col.a, edge);
  }
  if (uUseShafts != 0) {
    vec3 s = texture(uShafts, vUv).rgb * uShaftIntensity;
    col.rgb += s;
    col.a = max(col.a, clamp(max(s.r, max(s.g, s.b)), 0.0, 1.0));
  }
  outColor = col;
}
`;

const FXAA_FS = `#version 300 es
precision highp float;
precision highp int;
// Full-precision texture reads: the depth-based effects need every bit of the
// depth texture, and some drivers honour the default lowp sampler precision.
precision highp sampler2D;
in highp vec2 vUv;
out vec4 outColor;
uniform sampler2D uColor;
uniform vec2 uTexel;
void main() {
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  vec4 cM = texture(uColor, vUv);
  float lNW = dot(texture(uColor, vUv + vec2(-1.0, -1.0) * uTexel).rgb, LUMA);
  float lNE = dot(texture(uColor, vUv + vec2(1.0, -1.0) * uTexel).rgb, LUMA);
  float lSW = dot(texture(uColor, vUv + vec2(-1.0, 1.0) * uTexel).rgb, LUMA);
  float lSE = dot(texture(uColor, vUv + vec2(1.0, 1.0) * uTexel).rgb, LUMA);
  float lM = dot(cM.rgb, LUMA);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;
  vec4 a = 0.5 * (texture(uColor, vUv + dir * (1.0 / 3.0 - 0.5)) + texture(uColor, vUv + dir * (2.0 / 3.0 - 0.5)));
  vec4 b = a * 0.5 + 0.25 * (texture(uColor, vUv - dir * 0.5) + texture(uColor, vUv + dir * 0.5));
  float lB = dot(b.rgb, LUMA);
  outColor = (lB < lMin || lB > lMax) ? a : b;
}
`;

/** Final pass onto the canvas: chromatic aberration, vignette, grain; depth-tested when asked. */
const COMPOSITE_FS = `#version 300 es
precision highp float;
precision highp int;
// Full-precision texture reads: the depth-based effects need every bit of the
// depth texture, and some drivers honour the default lowp sampler precision.
precision highp sampler2D;
in highp vec2 vUv;
out vec4 outColor;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform int uWriteDepth;
uniform vec2 uPx;          // one CSS px in target uv
uniform float uAberration; // css px at the corners
uniform float uVignette;
uniform float uGrain;
uniform vec2 uAspect;      // target width/height normalisation
uniform float uSeed;
void main() {
  vec4 c = texture(uColor, vUv);
  if (uAberration > 0.0) {
    vec2 fromCentre = vUv - 0.5;
    vec2 shift = fromCentre * 2.0 * uAberration * uPx;
    vec4 r = texture(uColor, vUv + shift);
    vec4 b = texture(uColor, vUv - shift);
    c = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
  }
  if (uVignette > 0.0) {
    vec2 q = (vUv - 0.5) * uAspect;
    c.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(q) * 1.414);
  }
  if (uGrain > 0.0) {
    float n = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    c.rgb = max(c.rgb + n * uGrain * 0.12 * c.a, 0.0);
  }
  if (uWriteDepth != 0) gl_FragDepth = texture(uDepth, vUv).r;
  else gl_FragDepth = gl_FragCoord.z;
  outColor = c;
}
`;

export class PostEffects {
  private sets = new Map<string, TargetSet>();
  private vao?: WebGLVertexArrayObject;
  private frame = 0;
  private floatColor?: boolean;
  private samples?: number;
  /** Current governor level (0 = full quality). */
  level = 0;
  private ema = 0;
  private lastFrameAt = 0;
  private slow = 0;
  private fast = 0;
  private usedThisFrame = false;
  /** The previous frame asked for another right away (something is animating). */
  private continuing = false;

  constructor(private readonly renderer: GlRenderer) {}

  /** Name of the active quality level, for reports and debugging. */
  get levelName(): string { return LEVELS[this.level].name; }

  /** The governor's smoothed frame interval (ms) over back-to-back effect frames. */
  get frameTime(): number { return this.ema; }

  /**
   * Called once per rendered frame. While effects run on consecutive frames,
   * the frame interval feeds the governor: sustained slow frames step the
   * chain down a level, a long run of fast frames steps it back up.
   */
  newFrame(now: number): void {
    // Only back-to-back frames measure the device: a frame the previous one
    // requested (an animation running) with effects on. Sparse redraws say
    // nothing about speed.
    if (this.usedThisFrame && this.continuing && this.lastFrameAt > 0) {
      const dt = now - this.lastFrameAt;
      if (dt < 1000) {
        this.ema = this.ema === 0 ? dt : this.ema * 0.9 + dt * 0.1;
        // Slow: below ~38 fps. Fast: keeping up with a 60 Hz (or faster) display.
        if (this.ema > 26) { this.slow++; this.fast = 0; } else if (this.ema < 19) { this.fast++; this.slow = 0; } else { this.slow = 0; this.fast = 0; }
        if (this.slow > 30 && this.level < LEVELS.length - 1) this.setLevel(this.level + 1);
        else if (this.fast > 180 && this.level > 0) this.setLevel(this.level - 1);
      }
    }
    this.lastFrameAt = now;
    this.usedThisFrame = false;
    this.frame++;
    if (this.frame % 120 === 0) this.prune();
  }

  /** Called when a frame finishes: whether it asked for another frame right away. */
  frameEnd(wantsMore: boolean): void {
    this.continuing = wantsMore;
  }

  private setLevel(level: number): void {
    this.level = level;
    this.slow = 0;
    this.fast = 0;
    console.info(`[post] quality level ${level} (${LEVELS[level].name}), frame time ~${this.ema.toFixed(1)} ms`);
  }

  /**
   * Start drawing a pass into an offscreen target covering `rectCss` (CSS px,
   * top-left origin). Returns undefined when the rect is empty or targets are
   * unavailable, in which case the caller draws the plain way.
   */
  begin(rectCss: { x: number; y: number; width: number; height: number }): PostPass | undefined {
    const r = this.renderer;
    const gl = r.context;
    if (r.isContextLost) return undefined;
    const W = r.canvas.width, H = r.canvas.height;
    const dpr = W / Math.max(1, r.cssWidth);
    const left = Math.max(0, Math.floor(rectCss.x * dpr));
    const right = Math.min(W, Math.ceil((rectCss.x + rectCss.width) * dpr));
    const top = Math.max(0, Math.floor(rectCss.y * dpr));
    const bottom = Math.min(H, Math.ceil((rectCss.y + rectCss.height) * dpr));
    const width = right - left, height = bottom - top;
    if (width <= 0 || height <= 0) return undefined;
    const set = this.targetSet(width, height);
    if (!set) return undefined;
    set.lastUsed = this.frame;
    this.usedThisFrame = true;
    const target: RenderTarget = {
      fbo: set.msFbo ?? set.resolveFbo, color: set.color, depth: set.depth,
      width, height, x0: left, y0: H - bottom,
    };
    r.pushTarget(target);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    return { set, target, x0: left, y0: H - bottom, width, height };
  }

  /**
   * Finish a pass: resolve the target, run the effect chain, and composite
   * the result into whatever the pass would have drawn into, scissored to
   * `scissorCss` and (for deferred pop-outs) depth-tested with the pass's own
   * depth against what is already there.
   */
  end(pass: PostPass, s: PostSettings, f: PostFrame, opts: { scissorCss?: { x: number; y: number; width: number; height: number }; depthTest?: boolean }): void {
    const r = this.renderer;
    const gl = r.context;
    r.popTarget();
    const { set } = pass;
    const W = r.canvas.width, H = r.canvas.height;
    const dpr = W / Math.max(1, r.cssWidth);

    // Resolve multisampled colour and depth into the sampleable textures.
    if (set.msFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, set.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, set.resolveFbo);
      gl.blitFramebuffer(0, 0, pass.width, pass.height, 0, 0, pass.width, pass.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.blitFramebuffer(0, 0, pass.width, pass.height, 0, 0, pass.width, pass.height, gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    const lv = LEVELS[this.level];
    const ndc: [number, number, number, number] = [pass.x0 / W * 2 - 1, pass.y0 / H * 2 - 1, pass.width / W * 2, pass.height / H * 2];
    const texel: [number, number] = [1 / pass.width, 1 / pass.height];
    const px: [number, number] = [dpr / pass.width, dpr / pass.height];
    const useAo = !!s.ao && lv.heavy;
    const useDof = !!s.dof && lv.heavy;
    let lightUv: [number, number] | undefined;
    if (s.lightShafts) lightUv = this.lightUv(f, ndc);
    const useShafts = !!s.lightShafts && !!lightUv;
    const low = (useAo || useDof || useShafts) ? this.lowRes(set, lv.scale) : undefined;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.quad());
    const common = (p: GlProgram) => {
      gl.uniformMatrix4fv(p.uniforms.uInvViewProj, false, f.invViewProj);
      gl.uniformMatrix4fv(p.uniforms.uViewProj, false, f.viewProj);
      gl.uniform3f(p.uniforms.uCameraPos, f.cameraPos[0], f.cameraPos[1], f.cameraPos[2]);
      gl.uniform4f(p.uniforms.uNdcRect, ndc[0], ndc[1], ndc[2], ndc[3]);
      gl.uniform2f(p.uniforms.uTexel, texel[0], texel[1]);
      gl.uniform2f(p.uniforms.uPx, px[0], px[1]);
    };
    const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindSampler(unit, null);
      gl.uniform1i(loc, unit);
    };
    const dofU: [number, number, number] = s.dof
      ? [f.baseline + s.dof.focus, Math.max(1, s.dof.range / 2), Math.max(0, s.dof.aperture)]
      : [0, 1, 0];

    let aoOk = false, dofOk = false, shaftsOk = false;
    if (low && useAo) {
      const p = this.program(`postAo${lv.ao}`, aoFs(lv.ao), ['uDepth', 'uInvViewProj', 'uViewProj', 'uCameraPos', 'uNdcRect', 'uTexel', 'uPx', 'uRadius', 'uIntensity']);
      if (p) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, low.fbo[0]);
        gl.viewport(0, 0, low.width, low.height);
        gl.useProgram(p.program);
        common(p);
        bind(0, set.depth, p.uniforms.uDepth);
        gl.uniform1f(p.uniforms.uRadius, s.ao!.radius);
        gl.uniform1f(p.uniforms.uIntensity, s.ao!.intensity);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        aoOk = true;
      }
    }
    if (low && useDof) {
      const p = this.program(`postDof${lv.dof}`, dofFs(lv.dof), ['uDepth', 'uColor', 'uInvViewProj', 'uCameraPos', 'uNdcRect', 'uPx', 'uDof']);
      if (p) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, low.fbo[1]);
        gl.viewport(0, 0, low.width, low.height);
        gl.useProgram(p.program);
        common(p);
        bind(0, set.depth, p.uniforms.uDepth);
        bind(1, set.color, p.uniforms.uColor);
        gl.uniform3f(p.uniforms.uDof, dofU[0], dofU[1], dofU[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        dofOk = true;
      }
    }
    if (low && useShafts) {
      const p = this.program(`postShafts${lv.shafts}`, shaftsFs(lv.shafts), ['uColor', 'uDepth', 'uLight', 'uDecay']);
      if (p) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, low.fbo[2]);
        gl.viewport(0, 0, low.width, low.height);
        gl.useProgram(p.program);
        bind(0, set.color, p.uniforms.uColor);
        bind(1, set.depth, p.uniforms.uDepth);
        gl.uniform2f(p.uniforms.uLight, lightUv![0], lightUv![1]);
        gl.uniform1f(p.uniforms.uDecay, s.lightShafts!.decay);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        shaftsOk = true;
      }
    }

    let src = set.color;
    if (aoOk || dofOk || shaftsOk || s.outline) {
      const p = this.program('postCombine', COMBINE_FS, ['uDepth', 'uColor', 'uAo', 'uDofTex', 'uShafts', 'uInvViewProj', 'uCameraPos', 'uNdcRect',
        'uUseAo', 'uUseDof', 'uUseShafts', 'uUseOutline', 'uTexel', 'uDof', 'uOutline', 'uShaftIntensity']);
      if (p) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, set.full.fbo[0]);
        gl.viewport(0, 0, pass.width, pass.height);
        gl.useProgram(p.program);
        common(p);
        bind(0, set.depth, p.uniforms.uDepth);
        bind(1, set.color, p.uniforms.uColor);
        bind(2, low ? low.tex[0] : set.color, p.uniforms.uAo);
        bind(3, low ? low.tex[1] : set.color, p.uniforms.uDofTex);
        bind(4, low ? low.tex[2] : set.color, p.uniforms.uShafts);
        gl.uniform1i(p.uniforms.uUseAo, aoOk ? 1 : 0);
        gl.uniform1i(p.uniforms.uUseDof, dofOk ? 1 : 0);
        gl.uniform1i(p.uniforms.uUseShafts, shaftsOk ? 1 : 0);
        gl.uniform1i(p.uniforms.uUseOutline, s.outline ? 1 : 0);
        gl.uniform3f(p.uniforms.uDof, dofU[0], dofU[1], dofU[2]);
        const ol = s.outline;
        gl.uniform4f(p.uniforms.uOutline, ol?.color[0] ?? 0, ol?.color[1] ?? 0, ol?.color[2] ?? 0, Math.max(0.5, (ol?.width ?? 1) * dpr));
        gl.uniform1f(p.uniforms.uShaftIntensity, s.lightShafts?.intensity ?? 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = set.full.tex[0];
      }
    }
    if (s.fxaa) {
      const p = this.program('postFxaa', FXAA_FS, ['uColor', 'uTexel']);
      if (p) {
        const dst = src === set.full.tex[0] ? 1 : 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, set.full.fbo[dst]);
        gl.viewport(0, 0, pass.width, pass.height);
        gl.useProgram(p.program);
        bind(0, src, p.uniforms.uColor);
        gl.uniform2f(p.uniforms.uTexel, texel[0], texel[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = set.full.tex[dst];
      }
    }

    // Composite onto the canvas (or the enclosing target), clipped like the plain path.
    r.bindActiveTarget();
    const outer = r.activeTarget;
    gl.viewport(pass.x0 - (outer?.x0 ?? 0), pass.y0 - (outer?.y0 ?? 0), pass.width, pass.height);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (opts.scissorCss) r.setScissor(opts.scissorCss);
    if (opts.depthTest) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
    }
    const p = this.program('postComposite', COMPOSITE_FS, ['uColor', 'uDepth', 'uWriteDepth', 'uPx', 'uAberration', 'uVignette', 'uGrain', 'uAspect', 'uSeed']);
    if (p) {
      gl.useProgram(p.program);
      bind(0, src, p.uniforms.uColor);
      bind(1, set.depth, p.uniforms.uDepth);
      gl.uniform1i(p.uniforms.uWriteDepth, opts.depthTest ? 1 : 0);
      gl.uniform2f(p.uniforms.uPx, px[0], px[1]);
      gl.uniform1f(p.uniforms.uAberration, s.chromaticAberration ?? 0);
      gl.uniform1f(p.uniforms.uVignette, s.vignette ?? 0);
      gl.uniform1f(p.uniforms.uGrain, s.grain ?? 0);
      const ar = pass.width / Math.max(1, pass.height);
      gl.uniform2f(p.uniforms.uAspect, ar >= 1 ? 1 : ar, ar >= 1 ? 1 / ar : 1);
      gl.uniform1f(p.uniforms.uSeed, (this.frame % 64) * 17.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (opts.depthTest) {
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
      gl.disable(gl.DEPTH_TEST);
    }
    if (opts.scissorCss) r.clearScissor();
    for (let u = 0; u < 5; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    r.bindActiveTarget();
  }

  /** Where the light sits in target uv (off-screen positions are fine). */
  private lightUv(f: PostFrame, ndc: [number, number, number, number]): [number, number] | undefined {
    let p: [number, number, number];
    if (f.lightDir) {
      const far = f.baseline * 20;
      p = [f.cameraPos[0] + f.lightDir[0] * far, f.cameraPos[1] + f.lightDir[1] * far, f.cameraPos[2] + f.lightDir[2] * far];
    } else if (f.lightPos) {
      p = f.lightPos;
    } else {
      return undefined;
    }
    const m = f.viewProj;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 1e-6) return undefined;
    return [(x / w - ndc[0]) / ndc[2], (y / w - ndc[1]) / ndc[3]];
  }

  private program(name: string, fs: string, uniforms: string[]): GlProgram | null {
    return buildProgram(this.renderer.context, name, VS, fs, uniforms);
  }

  private quad(): WebGLVertexArrayObject {
    const gl = this.renderer.context;
    if (this.vao) return this.vao;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
    return vao;
  }

  /** Colour format: half float when the GPU can render to it, else RGBA8. */
  private colorFormat(): { internal: number; type: number } {
    const gl = this.renderer.context;
    if (this.floatColor === undefined) this.floatColor = !!gl.getExtension('EXT_color_buffer_float');
    return this.floatColor ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
  }

  private colorTexture(w: number, h: number): WebGLTexture {
    const gl = this.renderer.context;
    const fmt = this.colorFormat();
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, fmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  private fboFor(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.renderer.context;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  }

  /** The pooled resources for a target size, created on first use. */
  private targetSet(width: number, height: number): TargetSet | undefined {
    const key = `${width}x${height}`;
    const hit = this.sets.get(key);
    if (hit) return hit;
    const gl = this.renderer.context;
    const fmt = this.colorFormat();
    try {
      const color = this.colorTexture(width, height);
      const depth = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, depth);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH24_STENCIL8, width, height, 0, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      const resolveFbo = this.fboFor(color);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('post target incomplete');
      // Multisampled drawing surface, so edges stay as smooth as on the canvas.
      if (this.samples === undefined) this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
      let msFbo: WebGLFramebuffer | undefined, msColor: WebGLRenderbuffer | undefined, msDepth: WebGLRenderbuffer | undefined;
      if (this.samples > 1) {
        msColor = gl.createRenderbuffer()!;
        gl.bindRenderbuffer(gl.RENDERBUFFER, msColor);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, fmt.internal, width, height);
        msDepth = gl.createRenderbuffer()!;
        gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH24_STENCIL8, width, height);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        msFbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, msDepth);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          gl.deleteFramebuffer(msFbo); gl.deleteRenderbuffer(msColor); gl.deleteRenderbuffer(msDepth);
          msFbo = undefined; msColor = undefined; msDepth = undefined;
          this.samples = 0;
        }
      }
      const fullTex = [this.colorTexture(width, height), this.colorTexture(width, height)];
      const full = { tex: fullTex, fbo: fullTex.map((t) => this.fboFor(t)) };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const set: TargetSet = { width, height, msFbo, msColor, msDepth, resolveFbo, color, depth, full, low: new Map(), lastUsed: this.frame };
      this.sets.set(key, set);
      return set;
    } catch (err) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (this.floatColor) {
        // Half-float targets failed on this GPU: retry once with RGBA8.
        this.floatColor = false;
        return this.targetSet(width, height);
      }
      console.warn('[post] offscreen target unavailable; drawing without effects', err);
      return undefined;
    }
  }

  private lowRes(set: TargetSet, scale: number): LowRes {
    let lr = set.low.get(scale);
    if (lr) return lr;
    const width = Math.max(1, Math.ceil(set.width / scale)), height = Math.max(1, Math.ceil(set.height / scale));
    const tex = [0, 1, 2].map(() => this.colorTexture(width, height));
    lr = { width, height, tex, fbo: tex.map((t) => this.fboFor(t)) };
    this.renderer.context.bindFramebuffer(this.renderer.context.FRAMEBUFFER, null);
    set.low.set(scale, lr);
    return lr;
  }

  /** Free target sets no subtree has used for a while. */
  private prune(): void {
    const gl = this.renderer.context;
    for (const [key, set] of this.sets) {
      if (this.frame - set.lastUsed < 600) continue;
      gl.deleteTexture(set.color); gl.deleteTexture(set.depth); gl.deleteFramebuffer(set.resolveFbo);
      if (set.msFbo) gl.deleteFramebuffer(set.msFbo);
      if (set.msColor) gl.deleteRenderbuffer(set.msColor);
      if (set.msDepth) gl.deleteRenderbuffer(set.msDepth);
      set.full.tex.forEach((t) => gl.deleteTexture(t)); set.full.fbo.forEach((f) => gl.deleteFramebuffer(f));
      for (const lr of set.low.values()) { lr.tex.forEach((t) => gl.deleteTexture(t)); lr.fbo.forEach((f) => gl.deleteFramebuffer(f)); }
      this.sets.delete(key);
    }
  }

  /** Drop every GPU object (after a context loss the objects are already gone). */
  reset(): void {
    this.sets.clear();
    this.vao = undefined;
    this.samples = undefined;
    this.floatColor = undefined;
  }
}
