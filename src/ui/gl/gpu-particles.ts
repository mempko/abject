/**
 * GPU particles: one instanced draw call per emitter, simulated in the
 * vertex shader.
 *
 * The CPU only SPAWNS. Each new particle's record (start position and
 * velocity in the node's local px space, spawn time, start and end size,
 * spin, a random seed) goes into a per-emitter ring buffer with
 * `bufferSubData` for just the new slots. The vertex shader evaluates every
 * particle at `age = now - spawn` in closed form: ballistic flight under
 * `gravity` (+y down, px/s^2), `drag` as exponential velocity decay,
 * `turbulence` as an analytic flow (the integral of a few seeded sine
 * fields), spin, and size / colour / opacity over life. Particles live in
 * the emitter's local space, so moving the node carries them, exactly like
 * the CPU emitter this replaces.
 *
 * Spawning keeps the CPU emitter's semantics (the compositor's former
 * drawParticleNode): `rate` per second with a fractional accumulator and a
 * 100 ms frame cap, `burst` on first sight and again whenever `burstKey`
 * changes, `speed` / `size` ranges, `direction` with a `spread` cone,
 * `emitterSize` box, `lifetime` ms, `color` to `colorEnd`, `opacity`,
 * `shape` 'glow' | 'square', and `maxParticles` (now up to 20000). Glow
 * discs and squares are drawn with the same coverage maths as the glow
 * program, so existing emitters look the same.
 *
 * Additions: `sizeEnd`, `opacityEnd`, `spin`, `drag`, `turbulence`, `blend`,
 * and `texture` sprites (the caller resolves the texture). Quads face the
 * camera (right / up vectors from the view the caller draws with).
 *
 * Blending never changes GL blend state: the renderer's premultiplied
 * (ONE, ONE_MINUS_SRC_ALPHA) blend adds light when a fragment writes zero
 * alpha, so 'additive' writes alpha 0 and 'normal' writes coverage. The
 * default for glow discs and sprites is keyed on the colour's luminance:
 * light colours (white, neon, pale gold) add light and bloom where they
 * overlap, while mid and dark colours cover exactly as before, so red, ink,
 * and violet particles keep their look on paper-coloured themes too.
 * Squares default to 'normal' (chips of colour, not light). The module restores the renderer's state contract
 * after every draw (depth test off, depth writes on, no VAO bound).
 *
 * Portability (mobile GPUs): highp on both stages and every varying, int
 * flags instead of bool uniforms, no loops, one sampler on an explicit unit.
 * The program goes through the shared compile cache (program-cache.ts): if
 * it fails to build, the failure is logged once and every draw is skipped
 * (bookkeeping continues, so nothing else changes). A restored context is
 * noticed through the cache's generation counter and everything is rebuilt
 * from the CPU mirror.
 */

import type { RGBA } from './renderer.js';
import { Mat4, mat4TransformPoint, vec3 } from './math.js';
import { invariant } from '../../core/contracts.js';
import { buildProgram, contextGeneration, programError, restoreRendererState, GlProgram } from './program-cache.js';

export type Vec3Tuple = [number, number, number];

/** Hard cap on live particles per emitter. */
export const MAX_GPU_PARTICLES = 20000;

/** Per-particle record: 3 x vec4. */
const FLOATS = 12;
const STRIDE = FLOATS * 4;
/** Emitter-relative time is rebased past this many seconds so float32 keeps sub-ms precision. */
const REBASE_AFTER_S = 600;
/** Spawn time written into slots that must never draw again. */
const DEAD_TIME = -1e9;

const SHAPE_GLOW = 0, SHAPE_SQUARE = 1, SHAPE_SPRITE = 2;
const BLEND_NORMAL = 0, BLEND_ADDITIVE = 1, BLEND_LIGHT = 2;

const PARTICLE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aCorner;   // unit quad corner, -0.5..0.5
layout(location = 1) in vec4 aP0;       // spawn position xyz (local px), spawn time (s)
layout(location = 2) in vec4 aP1;       // velocity xyz (px/s), start size (px)
layout(location = 3) in vec4 aP2;       // end size (px), spin (rad/s), spin phase (rad), seed 0..1
uniform mat4 uViewProj;
uniform mat4 uWorld;
uniform vec3 uRight;                     // world-space screen right
uniform vec3 uDown;                      // world-space screen down
uniform float uTime;                     // s, emitter-relative
uniform float uMinSpawn;                 // spawn time of the oldest live particle
uniform float uLifetime;                 // s
uniform float uGravity;                  // px/s^2 along local +y
uniform float uDragK;                    // 1/s exponential velocity decay
uniform float uTurbulence;               // px/s
uniform vec4 uColor0;                    // straight rgba
uniform vec4 uColor1;
uniform vec2 uOpacity;                   // start, end
uniform int uFadeMode;                   // 0: opacity * (1 - k); 1: mix(start, end, k)
uniform int uShape;                      // 0 glow, 1 square, 2 sprite
out highp vec2 vUnit;
out highp vec4 vColor;                   // straight rgb, alpha with the life envelope
out highp vec3 vShape;                   // quad px, rect half-size px, sigma px

void main() {
  float age = uTime - aP0.w;
  // Dead, not yet born, or older than the ring's live tail. Evaluated in
  // straight-line code (no early return) and moved outside the clip volume
  // at the end, which strict mobile compilers handle best.
  int dead = (age < 0.0 || age >= uLifetime || aP0.w < uMinSpawn) ? 1 : 0;
  age = clamp(age, 0.0, uLifetime);
  float k = age / uLifetime;

  vec3 g = vec3(0.0, uGravity, 0.0);
  vec3 pos;
  if (uDragK > 0.0001) {
    vec3 term = g / uDragK;                // terminal velocity
    pos = aP0.xyz + term * age + (aP1.xyz - term) * (1.0 - exp(-uDragK * age)) / uDragK;
  } else {
    pos = aP0.xyz + aP1.xyz * age + 0.5 * g * age * age;
  }
  if (uTurbulence > 0.0) {
    // Displacement = integral of a velocity field sum(a_i cos(w_i t + p_i)),
    // phases seeded per particle and drifting with the spawn point.
    vec3 ph = aP2.w * vec3(12.9898, 78.233, 37.719) + aP0.xyz * 0.013;
    vec3 ph2 = ph.yzx * 1.37 + 1.7;
    vec3 d = 0.6 * (sin(1.7 * age + ph) - sin(ph)) / 1.7
           + 0.4 * (sin(4.3 * age + ph2) - sin(ph2)) / 4.3;
    pos += uTurbulence * d;
  }

  float size = max(0.0, mix(aP1.w, aP2.x, k));
  vec4 col = mix(uColor0, uColor1, k);
  float env = uFadeMode == 0 ? uOpacity.x * (1.0 - k) : mix(uOpacity.x, uOpacity.y, k);
  vColor = vec4(col.rgb, col.a * env);

  float quad;
  if (uShape == 1) {
    quad = size * 2.0 + 2.0;
    vShape = vec3(quad, size, 0.4);
  } else if (uShape == 2) {
    quad = size * 2.0;
    vShape = vec3(quad, size, 1.0);
  } else {
    quad = size * 6.0;
    vShape = vec3(quad, 0.5, size * 0.9);
  }

  float ang = aP2.z + aP2.y * age;
  float c = cos(ang), s = sin(ang);
  vec2 corner = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c) * quad;
  vec4 center = uWorld * vec4(pos, 1.0);
  vec3 wp = center.xyz / center.w + uRight * corner.x + uDown * corner.y;
  vUnit = aCorner;
  gl_Position = dead != 0 ? vec4(2.0, 2.0, 2.0, 1.0) : uViewProj * vec4(wp, 1.0);
}
`;

const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp int;
in highp vec2 vUnit;
in highp vec4 vColor;
in highp vec3 vShape;
uniform int uShape;                      // 0 glow, 1 square, 2 sprite
uniform int uBlend;                      // 0 normal, 1 additive, 2 light (luminance-keyed)
uniform sampler2D uTex;                  // sprite, premultiplied
out vec4 outColor;

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float gaussCoverage(float d, float sigma) {
  float x = d / (sigma * 1.41421356);
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float erfAbs = 1.0 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * exp(-x * x);
  return 0.5 * (1.0 - sign(x) * erfAbs);
}

void main() {
  vec3 rgb;
  float a;
  if (uShape == 2) {
    vec4 t = texture(uTex, vUnit + 0.5);
    vec3 straight = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
    rgb = straight * vColor.rgb;
    a = clamp(t.a * vColor.a, 0.0, 1.0);
  } else {
    vec2 p = vUnit * vShape.x;
    float hs = vShape.y;
    float r = uShape == 0 ? min(0.5, hs) : 0.0;
    float d = sdRoundRect(p, vec2(hs), r);
    a = clamp(gaussCoverage(d, max(vShape.z, 0.001)) * vColor.a, 0.0, 1.0);
    rgb = vColor.rgb;
  }
  if (a <= 0.002) discard;
  float cover = uBlend == 0 ? 1.0
    : (uBlend == 1 ? 0.0 : 1.0 - smoothstep(0.5, 0.95, dot(rgb, vec3(0.2126, 0.7152, 0.0722))));
  outColor = vec4(rgb * a, a * cover);
}
`;

const PROGRAM_NAME = 'gpuParticles';
const UNIFORMS = [
  'uViewProj', 'uWorld', 'uRight', 'uDown', 'uTime', 'uMinSpawn', 'uLifetime', 'uGravity',
  'uDragK', 'uTurbulence', 'uColor0', 'uColor1', 'uOpacity', 'uFadeMode', 'uShape', 'uBlend', 'uTex',
] as const;
type UniformName = typeof UNIFORMS[number];

/** How to draw an emitter this frame. Colours arrive resolved (no `$tokens`). */
export interface ParticleDrawOpts {
  viewProj: Mat4;
  /** World-space unit vectors for screen right and screen up (see billboardBasis). */
  cameraRight: Vec3Tuple;
  cameraUp: Vec3Tuple;
  /** Resolved `color` (straight alpha, 0..1). */
  color: RGBA;
  /** Resolved `colorEnd` [color]. */
  colorEnd?: RGBA;
  /** Resolved `texture` sprite (premultiplied, as GlRenderer uploads). Absent = glow disc. */
  texture?: WebGLTexture | null;
  /** Test (never write) depth against the pass's meshes [false: particles draw over solids, as before]. */
  depthTest?: boolean;
}

/** Counters for the harness and diagnostics; reset with resetStats(). */
export interface ParticleStats {
  drawCalls: number;
  instances: number;
  uploads: number;
  uploadedBytes: number;
}

interface SimParams {
  lifetime: number;
  gravity: number;
  dragK: number;
  turbulence: number;
  shape: number;
  blend: number;
  opacity: number;
  opacityEnd: number;
  fadeMode: number;
  wantsSprite: boolean;
}

interface Emitter {
  capacity: number;
  mirror: Float32Array;
  head: number;
  count: number;
  /** Slots [0, written) have held a particle; the draw covers exactly these. */
  written: number;
  epoch: number;
  last: number;
  acc: number;
  burstKey: unknown;
  burstDone: boolean;
  serial: number;
  nowSec: number;
  dirty: Array<[number, number]>;
  fullUpload: boolean;
  vao?: WebGLVertexArrayObject;
  buf?: WebGLBuffer;
  world: Float32Array;
  sim: SimParams;
  touched: boolean;
}

function num(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

function range(v: unknown, def: [number, number]): [number, number] {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v];
  if (Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) return [v[0] as number, v[1] as number];
  return def;
}

function vec3Param(v: unknown, def: Vec3Tuple): Vec3Tuple {
  if (Array.isArray(v) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])) {
    return [v[0] as number, v[1] as number, v[2] as number];
  }
  return def;
}

/** Deterministic 0..1 values from an integer (per-particle extras, so `random` draws match the CPU emitter). */
function hash01(n: number, salt: number): number {
  let x = (n * 0x9e3779b1 + salt * 0x85ebca6b) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Screen right / up as world-space unit vectors for a camera, from its
 * inverse view-projection (works for off-axis projections too: points at one
 * NDC depth lie on a plane parallel to the image plane).
 */
export function billboardBasis(invViewProj: Mat4): { right: Vec3Tuple; up: Vec3Tuple } {
  const o = mat4TransformPoint(invViewProj, vec3(0, 0, 0));
  const x = mat4TransformPoint(invViewProj, vec3(0.5, 0, 0));
  const y = mat4TransformPoint(invViewProj, vec3(0, 0.5, 0));
  const r: Vec3Tuple = [x.x - o.x, x.y - o.y, x.z - o.z];
  const u: Vec3Tuple = [y.x - o.x, y.y - o.y, y.z - o.z];
  const rl = Math.hypot(r[0], r[1], r[2]) || 1;
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  return { right: [r[0] / rl, r[1] / rl, r[2] / rl], up: [u[0] / ul, u[1] / ul, u[2] / ul] };
}

export class GpuParticles {
  private readonly gl: WebGL2RenderingContext;
  private readonly random: () => number;
  private emitters = new Map<string, Emitter>();
  private generation: number;
  private cornerBuf?: WebGLBuffer;
  private whiteTex?: WebGLTexture;

  readonly stats: ParticleStats = { drawCalls: 0, instances: 0, uploads: 0, uploadedBytes: 0 };

  /** `random` is injectable for reproducible comparisons (default Math.random). */
  constructor(gl: WebGL2RenderingContext, opts: { random?: () => number } = {}) {
    this.gl = gl;
    this.random = opts.random ?? Math.random;
    this.generation = contextGeneration(gl);
  }

  /** False once the particle program failed to build on this GPU (draws are skipped). */
  get available(): boolean {
    return programError(this.gl, PROGRAM_NAME) === undefined;
  }

  /** Live particles in an emitter (0 when unknown). */
  aliveCount(key: string): number {
    return this.emitters.get(key)?.count ?? 0;
  }

  resetStats(): void {
    this.stats.drawCalls = 0; this.stats.instances = 0; this.stats.uploads = 0; this.stats.uploadedBytes = 0;
  }

  /**
   * Advance an emitter to `now` (ms, performance.now() clock): retire expired
   * particles, emit bursts and the rate stream, upload only the new slots.
   * `params` are the node's resolved params; `world` its world matrix (the
   * emitter's local px space to world). Returns true while the emitter has
   * something to draw or keeps emitting (the render loop should continue).
   */
  update(key: string, params: Record<string, unknown>, world: Mat4, now: number): boolean {
    this.checkGeneration();
    const capacity = Math.max(0, Math.min(MAX_GPU_PARTICLES, Math.floor(num(params.maxParticles, 300))));
    let em = this.emitters.get(key);
    if (!em || em.capacity !== capacity) {
      const prev = em;
      if (prev) this.freeGl(prev);
      em = this.createEmitter(capacity, now);
      if (prev) { em.burstKey = prev.burstKey; em.burstDone = prev.burstDone; em.acc = prev.acc; em.last = prev.last; }
      this.emitters.set(key, em);
    }
    em.touched = true;
    const dt = Math.min(0.1, Math.max(0, (now - em.last) / 1000));
    em.last = now;

    const sim = this.simParams(params);
    em.sim = sim;
    em.world.set(world);

    // Retire from the tail: one lifetime for the whole emitter keeps the ring FIFO.
    let nowSec = (now - em.epoch) / 1000;
    const cap = em.capacity;
    if (cap > 0) {
      let tail = (em.head - em.count + cap) % cap;
      while (em.count > 0 && nowSec - em.mirror[tail * FLOATS + 3] >= sim.lifetime) {
        em.count--;
        tail = (tail + 1) % cap;
      }
    }
    if (em.count === 0) {
      // Empty ring: restart it at slot 0 on a fresh clock.
      em.head = 0; em.written = 0; em.epoch = now; nowSec = 0;
      em.dirty.length = 0; em.fullUpload = false;
    } else if (nowSec > REBASE_AFTER_S) {
      this.rebase(em, Math.floor(nowSec));
      nowSec = (now - em.epoch) / 1000;
    }
    em.nowSec = nowSec;

    // Spawn: burst has priority for free slots (as before), but the rate
    // stream is written first so spawn times stay in slot order.
    const burst = Math.max(0, Math.floor(num(params.burst, 0)));
    let nBurst = 0;
    if (burst > 0 && (!em.burstDone || em.burstKey !== params.burstKey)) {
      nBurst = burst;
      em.burstDone = true;
      em.burstKey = params.burstKey;
    }
    const rate = Math.max(0, num(params.rate, 0));
    let nRate = 0;
    if (rate > 0) {
      em.acc += rate * dt;
      nRate = Math.floor(em.acc);
      em.acc -= nRate;
    }
    const free = cap - em.count;
    nBurst = Math.min(nBurst, free);
    nRate = Math.min(nRate, free - nBurst);
    // The stream's particles are spread across the frame interval so a high
    // rate reads as a continuous jet instead of one clump per frame.
    if (nRate > 0) this.spawn(em, params, nRate, nowSec - dt, dt);
    if (nBurst > 0) this.spawn(em, params, nBurst, nowSec, 0);

    if (!this.gl.isContextLost()) this.upload(em);
    invariant(em.count >= 0 && em.count <= em.capacity && em.written <= em.capacity, 'particle ring bookkeeping stays within capacity');
    return em.count > 0 || rate > 0;
  }

  /** Draw an emitter (after update) through a camera. One instanced draw call. */
  draw(key: string, o: ParticleDrawOpts): void {
    const em = this.emitters.get(key);
    if (!em || em.count === 0 || em.written === 0) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this.checkGeneration();
    const prog = this.program();
    if (!prog) return;
    this.upload(em);
    if (!em.vao) return;
    const u = prog.uniforms as Record<UniformName, WebGLUniformLocation | null>;

    const sim = em.sim;
    const sprite = sim.wantsSprite && !!o.texture;
    const shape = sprite ? SHAPE_SPRITE : sim.shape;
    const c0 = o.color;
    const c1 = o.colorEnd ?? o.color;
    const cap = em.capacity;
    const tail = (em.head - em.count + cap) % cap;

    gl.useProgram(prog.program);
    gl.uniformMatrix4fv(u.uViewProj, false, o.viewProj);
    gl.uniformMatrix4fv(u.uWorld, false, em.world);
    gl.uniform3f(u.uRight, o.cameraRight[0], o.cameraRight[1], o.cameraRight[2]);
    gl.uniform3f(u.uDown, -o.cameraUp[0], -o.cameraUp[1], -o.cameraUp[2]);
    gl.uniform1f(u.uTime, em.nowSec);
    gl.uniform1f(u.uMinSpawn, em.mirror[tail * FLOATS + 3]);
    gl.uniform1f(u.uLifetime, sim.lifetime);
    gl.uniform1f(u.uGravity, sim.gravity);
    gl.uniform1f(u.uDragK, sim.dragK);
    gl.uniform1f(u.uTurbulence, sim.turbulence);
    gl.uniform4f(u.uColor0, c0.r, c0.g, c0.b, c0.a);
    gl.uniform4f(u.uColor1, c1.r, c1.g, c1.b, c1.a);
    gl.uniform2f(u.uOpacity, sim.opacity, sim.opacityEnd);
    gl.uniform1i(u.uFadeMode, sim.fadeMode);
    gl.uniform1i(u.uShape, shape);
    gl.uniform1i(u.uBlend, sim.blend);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sprite ? o.texture! : this.ensureWhiteTexture());
    gl.uniform1i(u.uTex, 0);

    if (o.depthTest) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    gl.bindVertexArray(em.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, em.written);
    restoreRendererState(gl);
    this.stats.drawCalls++;
    this.stats.instances += em.written;
  }

  /** Drop every emitter whose key is not in `keep` (and its GPU buffers). */
  prune(keep: ReadonlySet<string>): void {
    for (const [key, em] of this.emitters) {
      if (!keep.has(key)) { this.freeGl(em); this.emitters.delete(key); }
    }
  }

  /** Drop every emitter not updated since the previous call (end-of-frame sweep). */
  pruneUntouched(): void {
    for (const [key, em] of this.emitters) {
      if (!em.touched) { this.freeGl(em); this.emitters.delete(key); }
      else em.touched = false;
    }
  }

  /**
   * The GL context was restored: every handle died with the old context.
   * Forget them (without deleting) and rebuild lazily; live particles are
   * re-uploaded from the CPU mirror on the next update. Called automatically
   * when the compile cache reports a new context generation; calling it
   * directly is harmless.
   */
  contextRestored(): void {
    this.generation = contextGeneration(this.gl);
    this.cornerBuf = undefined;
    this.whiteTex = undefined;
    for (const em of this.emitters.values()) {
      em.vao = undefined; em.buf = undefined; em.fullUpload = true;
    }
  }

  dispose(): void {
    for (const em of this.emitters.values()) this.freeGl(em);
    this.emitters.clear();
    const gl = this.gl;
    if (!gl.isContextLost()) {
      // The program belongs to the shared compile cache; only our buffers go.
      if (this.cornerBuf) gl.deleteBuffer(this.cornerBuf);
      if (this.whiteTex) gl.deleteTexture(this.whiteTex);
    }
    this.cornerBuf = undefined;
    this.whiteTex = undefined;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private createEmitter(capacity: number, now: number): Emitter {
    return {
      capacity,
      mirror: new Float32Array(Math.max(1, capacity) * FLOATS),
      head: 0, count: 0, written: 0,
      epoch: now, last: now, acc: 0,
      burstKey: undefined, burstDone: false,
      serial: 0, nowSec: 0,
      dirty: [], fullUpload: false,
      world: new Float32Array(16),
      sim: this.simParams({}),
      touched: true,
    };
  }

  private simParams(p: Record<string, unknown>): SimParams {
    const square = p.shape === 'square';
    const blendParam = p.blend;
    const blend = blendParam === 'additive' ? BLEND_ADDITIVE
      : blendParam === 'normal' ? BLEND_NORMAL
      : square ? BLEND_NORMAL : BLEND_LIGHT;
    const drag = Math.min(0.999, Math.max(0, num(p.drag, 0)));
    const hasEnd = typeof p.opacityEnd === 'number' && Number.isFinite(p.opacityEnd);
    return {
      lifetime: Math.max(0.001, num(p.lifetime, 1500) / 1000),
      gravity: num(p.gravity, 0),
      dragK: drag > 0 ? -Math.log(1 - drag) : 0,
      turbulence: Math.max(0, num(p.turbulence, 0)),
      shape: square ? SHAPE_SQUARE : SHAPE_GLOW,
      blend,
      opacity: num(p.opacity, 1),
      opacityEnd: hasEnd ? (p.opacityEnd as number) : 0,
      fadeMode: hasEnd ? 1 : 0,
      wantsSprite: typeof p.texture === 'string' && p.texture.length > 0,
    };
  }

  /**
   * Write `n` new particles at the head of the ring. Spawn times run evenly
   * from t0 (exclusive) to t0 + span; `random` is drawn in the CPU emitter's
   * order (cone angle, azimuth, speed, box x, y, z, size) so seeded runs
   * match it particle for particle.
   */
  private spawn(em: Emitter, p: Record<string, unknown>, n: number, t0: number, span: number): void {
    const rnd = this.random;
    const [smin, smax] = range(p.speed, [20, 60]);
    const [zmin, zmax] = range(p.size, [2, 4]);
    const sizeEnd = p.sizeEnd === undefined ? undefined : range(p.sizeEnd, [zmin, zmax]);
    const spread = num(p.spread, Math.PI / 6);
    const dir = vec3Param(p.direction, [0, -1, 0]);
    const box = vec3Param(p.emitterSize, [0, 0, 0]);
    const square = p.shape === 'square';
    const spin = p.spin === undefined ? (square ? [3, 3] as [number, number] : [0, 0] as [number, number]) : range(p.spin, [0, 0]);

    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / len, dir[1] / len, dir[2] / len];
    // Two axes perpendicular to d for the spread cone.
    const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
    const al = Math.hypot(a[0], a[1], a[2]) || 1;
    const uu = [a[0] / al, a[1] / al, a[2] / al];
    const vv = [d[1] * uu[2] - d[2] * uu[1], d[2] * uu[0] - d[0] * uu[2], d[0] * uu[1] - d[1] * uu[0]];

    const cap = em.capacity;
    const first = em.head;
    for (let i = 0; i < n; i++) {
      const theta = rnd() * spread;
      const phi = rnd() * Math.PI * 2;
      const st = Math.sin(theta), ct = Math.cos(theta);
      const vx = d[0] * ct + (uu[0] * Math.cos(phi) + vv[0] * Math.sin(phi)) * st;
      const vy = d[1] * ct + (uu[1] * Math.cos(phi) + vv[1] * Math.sin(phi)) * st;
      const vz = d[2] * ct + (uu[2] * Math.cos(phi) + vv[2] * Math.sin(phi)) * st;
      const speed = smin + rnd() * (smax - smin);
      const x = (rnd() - 0.5) * box[0], y = (rnd() - 0.5) * box[1], z = (rnd() - 0.5) * box[2];
      const sr = rnd();
      const size0 = zmin + sr * (zmax - zmin);
      const size1 = sizeEnd ? sizeEnd[0] + sr * (sizeEnd[1] - sizeEnd[0]) : size0;
      const serial = em.serial++;
      const h1 = hash01(serial, 1), h2 = hash01(serial, 2), h3 = hash01(serial, 3);

      const slot = em.head;
      const o = slot * FLOATS;
      const m = em.mirror;
      m[o] = x; m[o + 1] = y; m[o + 2] = z;
      m[o + 3] = span > 0 ? t0 + (span * (i + 1)) / n : t0;
      m[o + 4] = vx * speed; m[o + 5] = vy * speed; m[o + 6] = vz * speed;
      m[o + 7] = size0;
      m[o + 8] = size1;
      m[o + 9] = spin[0] + h1 * (spin[1] - spin[0]);
      m[o + 10] = h2 * Math.PI * 2;
      m[o + 11] = h3;
      em.head = (slot + 1) % cap;
      em.count++;
      if (slot + 1 > em.written) em.written = slot + 1;
    }
    // Dirty slots: one run, or two when the batch wraps past the end.
    const endRun = Math.min(cap, first + n);
    em.dirty.push([first, endRun]);
    if (first + n > cap) em.dirty.push([0, first + n - cap]);
  }

  /** Shift the emitter clock by `shift` s; kill the slots that no longer hold live particles. */
  private rebase(em: Emitter, shift: number): void {
    const cap = em.capacity;
    const live = new Uint8Array(cap);
    for (let i = 0, s = (em.head - em.count + cap) % cap; i < em.count; i++, s = (s + 1) % cap) live[s] = 1;
    for (let s = 0; s < em.written; s++) {
      const o = s * FLOATS + 3;
      em.mirror[o] = live[s] ? em.mirror[o] - shift : DEAD_TIME;
    }
    em.epoch += shift * 1000;
    em.fullUpload = true;
  }

  private upload(em: Emitter): void {
    if (em.capacity === 0) return;
    const gl = this.gl;
    if (!em.buf || !em.vao) {
      if (!this.program()) return;
      this.createGl(em);
      em.fullUpload = true;
    }
    if (!em.buf) return;
    if (!em.fullUpload && em.dirty.length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, em.buf);
    if (em.fullUpload) {
      if (em.written > 0) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, em.mirror, 0, em.written * FLOATS);
        this.stats.uploads++;
        this.stats.uploadedBytes += em.written * STRIDE;
      }
    } else {
      for (const [from, to] of em.dirty) {
        if (to <= from) continue;
        gl.bufferSubData(gl.ARRAY_BUFFER, from * STRIDE, em.mirror, from * FLOATS, (to - from) * FLOATS);
        this.stats.uploads++;
        this.stats.uploadedBytes += (to - from) * STRIDE;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    em.dirty.length = 0;
    em.fullUpload = false;
  }

  private createGl(em: Emitter): void {
    const gl = this.gl;
    const corners = this.ensureCornerBuffer();
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf || !corners) return;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, em.capacity * STRIDE, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STRIDE, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    em.vao = vao;
    em.buf = buf;
  }

  private freeGl(em: Emitter): void {
    const gl = this.gl;
    if (!gl.isContextLost()) {
      if (em.vao) gl.deleteVertexArray(em.vao);
      if (em.buf) gl.deleteBuffer(em.buf);
    }
    em.vao = undefined;
    em.buf = undefined;
  }

  private ensureCornerBuffer(): WebGLBuffer | undefined {
    if (this.cornerBuf) return this.cornerBuf;
    const gl = this.gl;
    const b = gl.createBuffer();
    if (!b) return undefined;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.cornerBuf = b;
    return b;
  }

  private ensureWhiteTexture(): WebGLTexture | null {
    if (this.whiteTex) return this.whiteTex;
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) return null;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.whiteTex = t;
    return t;
  }

  /** The particle program from the shared compile cache (null when this GPU rejects it). */
  private program(): GlProgram | null {
    return buildProgram(this.gl, PROGRAM_NAME, PARTICLE_VS, PARTICLE_FS, [...UNIFORMS]);
  }

  /** Forget every GL handle when the context was restored since we last looked. */
  private checkGeneration(): void {
    if (contextGeneration(this.gl) !== this.generation) this.contextRestored();
  }
}
