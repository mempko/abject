/**
 * Animation tracks for scene nodes: keyframes, springs, and constraints.
 *
 * Pure math, no GL and no DOM, so the compositor's animation loop, the
 * backend's validation, and one-shot Node checks all share the same curves.
 * Everything runs client-side off the render loop; the wire only ever carries
 * the declarative spec (one 'animate' op), never per-frame values.
 *
 * Vectors are plain number arrays: 3 components for position / rotation /
 * scale, rgb (0..1) for colour channels, 1 for opacity. Converting a CSS
 * colour or `$token` into a vector is the caller's job (it owns the theme),
 * which is why the builders take a `toVector` function.
 *
 * Coordinates follow the scene: px, y-down, +z toward the viewer. Euler
 * rotations use the same convention as `mat4TRS` in math.ts
 * (R = Rx * Ry * Rz, radians).
 */

import type { EasingCurve } from '../../core/theme-data.js';
import { ensure } from '../../core/contracts.js';
import { cubicBezier, STANDARD, ACCELERATE, DECELERATE, EMPHASIZE, LINEAR } from '../motion.js';

export type Vec3Tuple = [number, number, number];

// ── Easing ──────────────────────────────────────────────────────────────

/** Maps progress 0..1 to eased progress (may overshoot for back / elastic curves). */
export type EasingFn = (x: number) => number;

/** A named easing or a cubic-bezier control tuple [x1, y1, x2, y2]. */
export type EasingSpec = string | readonly [number, number, number, number];

function bezierFn(curve: EasingCurve): EasingFn {
  return (x) => cubicBezier(curve, x);
}

function bounceOut(x: number): number {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) { const t = x - 1.5 / d; return n * t * t + 0.75; }
  if (x < 2.5 / d) { const t = x - 2.25 / d; return n * t * t + 0.9375; }
  const t = x - 2.625 / d;
  return n * t * t + 0.984375;
}

function elasticOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

/**
 * Named easings. The first five match the scene's existing 'animate' easing
 * names (and motion.ts); the CSS names and the expressive curves are extra.
 * 'step' holds the start value and jumps at the end of the segment.
 */
export const NAMED_EASINGS: Readonly<Record<string, EasingFn>> = {
  linear: bezierFn(LINEAR),
  standard: bezierFn(STANDARD),
  decelerate: bezierFn(DECELERATE),
  accelerate: bezierFn(ACCELERATE),
  emphasize: bezierFn(EMPHASIZE),
  ease: bezierFn([0.25, 0.1, 0.25, 1]),
  easeIn: bezierFn([0.42, 0, 1, 1]),
  easeOut: bezierFn([0, 0, 0.58, 1]),
  easeInOut: bezierFn([0.42, 0, 0.58, 1]),
  backIn: bezierFn([0.36, 0, 0.66, -0.56]),
  backOut: bezierFn([0.34, 1.56, 0.64, 1]),
  bounce: bounceOut,
  elastic: elasticOut,
  step: (x) => (x >= 1 ? 1 : 0),
};

/** Every accepted easing name (for validation messages and docs). */
export const EASING_NAMES: readonly string[] = Object.keys(NAMED_EASINGS);

/** True when `e` is a known easing name or a 4-number cubic-bezier tuple. */
export function isEasingSpec(e: unknown): e is EasingSpec {
  if (typeof e === 'string') return e in NAMED_EASINGS;
  return Array.isArray(e) && e.length === 4 && e.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Resolve an easing spec to a function. Unknown or missing specs fall back
 * to `fallback` (a name, default 'linear').
 */
export function resolveEasing(e: unknown, fallback = 'linear'): EasingFn {
  if (typeof e === 'string' && NAMED_EASINGS[e]) return NAMED_EASINGS[e];
  if (isEasingSpec(e) && Array.isArray(e)) {
    const curve = [e[0], e[1], e[2], e[3]] as const;
    return bezierFn(curve);
  }
  return NAMED_EASINGS[fallback] ?? NAMED_EASINGS.linear;
}

// ── Keyframes ───────────────────────────────────────────────────────────

/** One keyframe as authored: `t` in ms from the start, any channel value. */
export interface KeyframeInput {
  t: number;
  value: unknown;
  easing?: unknown;
}

/** A resolved keyframe. `ease` shapes the segment from this key to the next. */
export interface Keyframe {
  t: number;
  value: number[];
  ease: EasingFn;
}

export interface KeyframeTrack {
  keys: Keyframe[];
  /** ms, the last key's time. */
  duration: number;
  loop: boolean;
  /** With loop, every other cycle plays backwards. */
  yoyo: boolean;
}

export interface KeyframeTrackOptions {
  loop?: boolean;
  yoyo?: boolean;
  /** Easing for keys that name none (default 'linear'). */
  easing?: unknown;
}

/**
 * Build a track from authored keyframes. Keys whose value `toVector` cannot
 * convert, or whose `t` is not a finite number >= 0, are skipped; keys are
 * sorted by time (stable, so equal times keep their order and make a jump).
 * Shorter vectors are padded from the first key so every key has the same
 * length. Returns undefined when no key survives.
 *
 * Easing follows the Web Animations convention: a key's easing shapes the
 * segment that STARTS at that key.
 */
export function buildKeyframeTrack(
  input: readonly KeyframeInput[],
  toVector: (value: unknown) => number[] | undefined,
  opts: KeyframeTrackOptions = {},
): KeyframeTrack | undefined {
  const fallback = resolveEasing(opts.easing, 'linear');
  const keys: Keyframe[] = [];
  for (const k of input) {
    if (!k || typeof k.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) continue;
    const v = toVector(k.value);
    if (!v || v.length === 0 || !v.every((n) => Number.isFinite(n))) continue;
    keys.push({ t: k.t, value: v.slice(), ease: k.easing !== undefined ? resolveEasing(k.easing, 'linear') : fallback });
  }
  if (keys.length === 0) return undefined;
  keys.sort((a, b) => a.t - b.t);
  const width = Math.max(...keys.map((k) => k.value.length));
  const pad = keys[0].value;
  for (const k of keys) {
    while (k.value.length < width) k.value.push(pad[k.value.length] ?? 0);
  }
  const track: KeyframeTrack = {
    keys,
    duration: keys[keys.length - 1].t,
    loop: opts.loop === true,
    yoyo: opts.yoyo === true,
  };
  ensure(track.keys.every((k, i) => i === 0 || k.t >= track.keys[i - 1].t), 'keyframes sorted by time');
  return track;
}

/** Sample a track `elapsed` ms after its start (negative = before the start). */
export function sampleKeyframes(track: KeyframeTrack, elapsed: number): { value: number[]; done: boolean } {
  const keys = track.keys;
  const first = keys[0], last = keys[keys.length - 1];
  if (!(elapsed > 0)) return { value: first.value.slice(), done: false };
  const dur = track.duration;
  if (dur <= 0) return { value: last.value.slice(), done: true };

  let local = elapsed;
  let done = false;
  if (elapsed >= dur) {
    if (track.loop) {
      const cycle = Math.floor(elapsed / dur);
      local = elapsed - cycle * dur;
      if (track.yoyo && cycle % 2 === 1) local = dur - local;
    } else {
      return { value: last.value.slice(), done: true };
    }
  }

  if (local <= first.t) return { value: first.value.slice(), done };
  // Last key at or before `local` (keys are few; a linear scan is fine).
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= local) i++;
  if (i >= keys.length - 1) return { value: last.value.slice(), done };
  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  const f = span > 0 ? (local - a.t) / span : 1;
  const e = a.ease(Math.min(1, Math.max(0, f)));
  return { value: lerpVec(a.value, b.value, e), done };
}

export function lerpVec(a: readonly number[], b: readonly number[], t: number): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + ((b[i] ?? a[i]) - a[i]) * t;
  return out;
}

// ── Springs ─────────────────────────────────────────────────────────────

export interface SpringConfig {
  /** N/m-style stiffness [170]. */
  stiffness?: number;
  /** Damping coefficient [26]. */
  damping?: number;
  /** Mass [1]. */
  mass?: number;
  /** Settled when every component is within this of the target (default 0.1% of the travel, min 1e-4). */
  restDelta?: number;
  /** ...and moving slower than this per second (default 10 x restDelta). */
  restSpeed?: number;
}

export const SPRING_DEFAULTS = { stiffness: 170, damping: 26, mass: 1 } as const;

/** A running spring. Mutated in place by stepSpring / retargetSpring. */
export interface Spring {
  value: number[];
  velocity: number[];
  target: number[];
  stiffness: number;
  damping: number;
  mass: number;
  restDelta: number;
  restSpeed: number;
  /** True once at rest on the target (value snapped, velocity zero). */
  settled: boolean;
}

function positive(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : def;
}

function restThresholds(from: readonly number[], to: readonly number[], cfg: SpringConfig): { restDelta: number; restSpeed: number } {
  let span = 0;
  for (let i = 0; i < to.length; i++) span = Math.max(span, Math.abs((to[i] ?? 0) - (from[i] ?? 0)));
  const restDelta = positive(cfg.restDelta, Math.max(1e-4, span * 1e-3));
  const restSpeed = positive(cfg.restSpeed, restDelta * 10);
  return { restDelta, restSpeed };
}

/** Start a spring at `from` (optionally already moving) heading for `to`. */
export function createSpring(from: readonly number[], to: readonly number[], config: SpringConfig = {}, velocity?: readonly number[]): Spring {
  const n = to.length;
  const value = Array.from({ length: n }, (_, i) => from[i] ?? to[i]);
  const s: Spring = {
    value,
    velocity: Array.from({ length: n }, (_, i) => velocity?.[i] ?? 0),
    target: to.slice(),
    stiffness: positive(config.stiffness, SPRING_DEFAULTS.stiffness),
    damping: typeof config.damping === 'number' && Number.isFinite(config.damping) && config.damping >= 0
      ? config.damping : SPRING_DEFAULTS.damping,
    mass: positive(config.mass, SPRING_DEFAULTS.mass),
    ...restThresholds(value, to, config),
    settled: false,
  };
  return s;
}

/**
 * Point a running spring at a new target, keeping its current value and
 * velocity (so a re-issued animate op bends the motion instead of restarting
 * it). Config fields given here replace the spring's.
 */
export function retargetSpring(s: Spring, to: readonly number[], config: SpringConfig = {}): void {
  while (s.value.length < to.length) { s.value.push(to[s.value.length]); s.velocity.push(0); }
  s.value.length = to.length;
  s.velocity.length = to.length;
  s.target = to.slice();
  if (config.stiffness !== undefined) s.stiffness = positive(config.stiffness, s.stiffness);
  if (config.damping !== undefined && Number.isFinite(config.damping) && config.damping >= 0) s.damping = config.damping;
  if (config.mass !== undefined) s.mass = positive(config.mass, s.mass);
  Object.assign(s, restThresholds(s.value, to, config));
  s.settled = false;
}

/**
 * Advance a spring by `dt` seconds with the exact solution of the damped
 * oscillator (under-, critically, and over-damped cases), so the result is
 * the same whether the frame took 4 ms or 400 ms: no explicit integrator to
 * blow up at low frame rates. Returns true while the spring is still moving.
 */
export function stepSpring(s: Spring, dt: number): boolean {
  if (s.settled) return false;
  const t = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const w0 = Math.sqrt(s.stiffness / s.mass);
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  let resting = true;
  for (let i = 0; i < s.target.length; i++) {
    const x0 = s.value[i] - s.target[i];
    const v0 = s.velocity[i];
    let x: number, v: number;
    if (zeta < 1 - 1e-6) {
      const a = zeta * w0;
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-a * t), c = Math.cos(wd * t), sn = Math.sin(wd * t);
      x = e * (x0 * c + ((v0 + a * x0) / wd) * sn);
      v = e * (v0 * c - ((a * v0 + w0 * w0 * x0) / wd) * sn);
    } else if (zeta > 1 + 1e-6) {
      const r = Math.sqrt(zeta * zeta - 1);
      const r1 = -w0 * (zeta - r), r2 = -w0 * (zeta + r);
      const c2 = (v0 - r1 * x0) / (r2 - r1);
      const c1 = x0 - c2;
      const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
      x = c1 * e1 + c2 * e2;
      v = r1 * c1 * e1 + r2 * c2 * e2;
    } else {
      const e = Math.exp(-w0 * t);
      const b = v0 + w0 * x0;
      x = e * (x0 + b * t);
      v = e * (v0 - w0 * b * t);
    }
    s.value[i] = s.target[i] + x;
    s.velocity[i] = v;
    if (Math.abs(x) > s.restDelta || Math.abs(v) > s.restSpeed) resting = false;
  }
  if (resting) {
    for (let i = 0; i < s.target.length; i++) { s.value[i] = s.target[i]; s.velocity[i] = 0; }
    s.settled = true;
  }
  return !s.settled;
}

// ── Constraints ─────────────────────────────────────────────────────────

/**
 * Euler rotation [rx, ry, rz] (the `mat4TRS` convention, R = Rx * Ry * Rz)
 * that turns a node at `from` so its local +z axis points at `to`, keeping
 * it upright: its local -y stays as close as possible to `up` (default
 * [0, -1, 0], screen-up in the y-down scene). Both points are in the node's
 * parent space. Returns the identity rotation when the points coincide.
 */
export function lookAtEuler(from: readonly number[], to: readonly number[], up: readonly number[] = [0, -1, 0]): Vec3Tuple {
  let zx = to[0] - from[0], zy = to[1] - from[1], zz = to[2] - from[2];
  const zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-9) return [0, 0, 0];
  zx /= zl; zy /= zl; zz /= zl;

  // Local +y maps to "down" (the opposite of up). x = down × z, y = z × x.
  let dx = -up[0], dy = -up[1], dz = -up[2];
  let xx = dy * zz - dz * zy, xy = dz * zx - dx * zz, xz = dx * zy - dy * zx;
  let xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-6) {
    // Looking straight along the up axis: any roll is valid; pick a stable one.
    dx = 0; dy = 0; dz = zy > 0 ? -1 : 1;
    xx = dy * zz - dz * zy; xy = dz * zx - dx * zz; xz = dx * zy - dy * zx;
    xl = Math.hypot(xx, xy, xz) || 1;
  }
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;

  // Columns of R are (x, y, z). For R = Rx*Ry*Rz:
  //   r02 = sin ry, r12 = -sin rx cos ry, r22 = cos rx cos ry,
  //   r01 = -cos ry sin rz, r00 = cos ry cos rz.
  const r02 = zx, r12 = zy, r22 = zz, r01 = yx, r00 = xx;
  const ry = Math.asin(Math.max(-1, Math.min(1, r02)));
  let rx: number, rz: number;
  if (Math.abs(r02) < 0.999999) {
    rx = Math.atan2(-r12, r22);
    rz = Math.atan2(-r01, r00);
  } else {
    // Gimbal lock (target straight along x): with rz = 0, r11 = cos rx and
    // r21 = sin rx, so the whole roll folds into rx.
    rz = 0;
    rx = Math.atan2(yz, yy);
  }
  return [rx, ry, rz];
}

/**
 * Per-frame follow blend. `stiffness` is the fraction of the remaining gap
 * closed per frame at 60 fps (0..1, [0.15]); this converts it to the
 * equivalent fraction for a `dt`-second frame so the motion is the same at
 * any frame rate.
 */
export function followAlpha(stiffness: number, dt: number): number {
  const k = Math.min(1, Math.max(0, Number.isFinite(stiffness) ? stiffness : 0.15));
  if (k >= 1) return 1;
  return 1 - Math.pow(1 - k, Math.max(0, dt) * 60);
}

/** Ease `current` toward `target` for one frame of `dt` seconds (see followAlpha). */
export function followStep(current: readonly number[], target: readonly number[], stiffness: number, dt: number): number[] {
  return lerpVec(current, target, followAlpha(stiffness, dt));
}

// ── Data-driven motion presets ──────────────────────────────────────────

/** One channel of a motion preset, relative to the node's current value. */
export interface MotionPresetTrack {
  channel: 'position' | 'rotation' | 'scale';
  /** 'add' offsets the current value; 'mul' multiplies it (scale). */
  mode: 'add' | 'mul';
  /** `t` is a 0..1 fraction of the preset's duration; values are 3-vectors. */
  keyframes: Array<{ t: number; value: Vec3Tuple; easing?: EasingSpec }>;
}

/**
 * A reusable, data-only motion. `amplitude` names the preset's own unit
 * (px for hover, radians for wobble, a scale fraction for breathe); an
 * animate op's `amplitude` param scales every track by amplitude / this.
 */
export interface MotionPreset {
  duration: number;
  loop: boolean;
  yoyo?: boolean;
  amplitude: number;
  tracks: MotionPresetTrack[];
}

/** Built-in data presets. Anyone can add entries (or pass their own) to expandMotionPreset. */
export const MOTION_PRESETS: Record<string, MotionPreset> = {
  /** A jelly wobble after a hit: decaying twist with a squash and stretch. */
  wobble: {
    duration: 900, loop: false, amplitude: 0.14,
    tracks: [
      { channel: 'rotation', mode: 'add', keyframes: [
        { t: 0, value: [0, 0, 0], easing: 'easeOut' },
        { t: 0.15, value: [0, 0, 0.14], easing: 'easeInOut' },
        { t: 0.35, value: [0, 0, -0.1], easing: 'easeInOut' },
        { t: 0.55, value: [0, 0, 0.06], easing: 'easeInOut' },
        { t: 0.75, value: [0, 0, -0.025], easing: 'easeInOut' },
        { t: 1, value: [0, 0, 0] },
      ] },
      { channel: 'scale', mode: 'mul', keyframes: [
        { t: 0, value: [1, 1, 1], easing: 'easeOut' },
        { t: 0.15, value: [1.08, 0.93, 1], easing: 'easeInOut' },
        { t: 0.4, value: [0.96, 1.04, 1], easing: 'easeInOut' },
        { t: 0.7, value: [1.015, 0.99, 1], easing: 'easeInOut' },
        { t: 1, value: [1, 1, 1] },
      ] },
    ],
  },
  /** A slow living swell, like something asleep. */
  breathe: {
    duration: 1800, loop: true, yoyo: true, amplitude: 0.04,
    tracks: [
      { channel: 'scale', mode: 'mul', keyframes: [
        { t: 0, value: [1, 1, 1], easing: 'easeInOut' },
        { t: 1, value: [1.04, 1.04, 1.04] },
      ] },
    ],
  },
  /** Lift toward the viewer and tip slightly, as when a pointer rests on it. */
  hover: {
    duration: 1400, loop: true, yoyo: true, amplitude: 6,
    tracks: [
      { channel: 'position', mode: 'add', keyframes: [
        { t: 0, value: [0, 0, 0], easing: 'easeInOut' },
        { t: 1, value: [0, -6, 6] },
      ] },
      { channel: 'rotation', mode: 'add', keyframes: [
        { t: 0, value: [0, 0, 0], easing: 'easeInOut' },
        { t: 1, value: [0.05, 0, 0] },
      ] },
    ],
  },
};

export interface MotionBase {
  position: readonly number[];
  rotation: readonly number[];
  scale: readonly number[];
}

/**
 * Turn a motion preset into concrete keyframe tracks around a node's current
 * transform. `duration` (ms) and `amplitude` (in the preset's unit) override
 * the preset's own; `loop` / `yoyo` too.
 */
export function expandMotionPreset(
  preset: MotionPreset,
  base: MotionBase,
  overrides: { duration?: number; amplitude?: number; loop?: boolean; yoyo?: boolean } = {},
): Array<{ channel: MotionPresetTrack['channel']; track: KeyframeTrack }> {
  const duration = positive(overrides.duration, preset.duration);
  const factor = typeof overrides.amplitude === 'number' && Number.isFinite(overrides.amplitude) && preset.amplitude !== 0
    ? overrides.amplitude / preset.amplitude : 1;
  const loop = overrides.loop ?? preset.loop;
  const yoyo = overrides.yoyo ?? preset.yoyo ?? false;
  const out: Array<{ channel: MotionPresetTrack['channel']; track: KeyframeTrack }> = [];
  for (const tr of preset.tracks) {
    const cur = base[tr.channel];
    const keys: KeyframeInput[] = tr.keyframes.map((k) => ({
      t: Math.min(1, Math.max(0, k.t)) * duration,
      easing: k.easing,
      value: [0, 1, 2].map((i) => tr.mode === 'mul'
        ? (cur[i] ?? 1) * (1 + (k.value[i] - 1) * factor)
        : (cur[i] ?? 0) + k.value[i] * factor),
    }));
    const track = buildKeyframeTrack(keys, (v) => v as number[], { loop, yoyo });
    if (track) out.push({ channel: tr.channel, track });
  }
  return out;
}
