/**
 * Slab motion: a declarative vocabulary for animating whole windows (slabs)
 * in the 3D desktop, evaluated client-side by the Compositor.
 *
 * Everything here is data. The built-in effects and window transitions below
 * are only the default library; any Abject can play an inline spec, register
 * new named effects, or replace the transitions (open, close, minimize,
 * restore, workspace-in) and the modal depth style through WidgetManager.
 * Shared by the backend (validation, docs) and the client (evaluation).
 *
 * Motion is visual only: a slab's rect, input routing and hit-testing never
 * change (picking follows the animated matrix; a closing slab is a ghost that
 * input no longer sees).
 */

/** A value over an effect's normalized time t (0..1). */
export type MotionTrack =
  /** Constant. */
  | number
  /** Interpolate from -> to along the eased time. */
  | [number, number]
  /** Piecewise-linear keyframes [t, value] over the eased time (t ascending, 0..1). */
  | { stops: Array<[number, number]> }
  /**
   * Oscillation around the channel's neutral value (0 for offsets and
   * rotations, 1 for scale / opacity / dim): neutral + amplitude * sin(2π·cycles·t),
   * fading out over the effect when `decay` is set. Uses raw (uneased) time.
   */
  | { wave: { amplitude: number; cycles: number; decay?: boolean } };

export type MotionEasing =
  | 'linear' | 'standard' | 'decelerate' | 'accelerate' | 'emphasize'
  | [number, number, number, number];

/** A light effect: a colour (CSS or $token; defaults per effect) and its alpha track. */
export interface MotionLight {
  color?: string;
  alpha: MotionTrack;
}

/** A declarative slab effect. Channels combine across concurrent effects. */
export interface SlabEffectSpec {
  /** Milliseconds. */
  duration: number;
  /** Easing for tracks and the scan line (default 'standard'). */
  easing?: MotionEasing;
  /** Offsets in px (x right, y down, z toward the viewer). Additive. */
  x?: MotionTrack;
  y?: MotionTrack;
  z?: MotionTrack;
  /** Radians. Additive. */
  rotateX?: MotionTrack;
  rotateY?: MotionTrack;
  rotateZ?: MotionTrack;
  /** Multiplicative (neutral 1). */
  scale?: MotionTrack;
  scaleX?: MotionTrack;
  scaleY?: MotionTrack;
  opacity?: MotionTrack;
  dim?: MotionTrack;
  /** Pull the slab's centre toward a desktop point by `amount` (0..1). */
  toward?: { x?: number; y?: number; amount: MotionTrack };
  /** Colour the slab's rim (default: the living light). */
  rim?: MotionLight;
  /** A soft glow around the slab (default: the living light). */
  aura?: MotionLight & { spread?: number };
  /**
   * A bright line across the slab. 'top'/'bottom' sweep with the eased time;
   * 'middle' stays at the centre (a fold line). Default colour: the living light.
   */
  scan?: MotionLight & { from?: 'top' | 'bottom' | 'middle' };
  /** A particle burst seeded when the effect starts. */
  particles?: {
    count?: number;
    color?: string;
    /** Where particles start: the slab's edges (flying outward) or its centre. */
    from?: 'edges' | 'center';
    /** px/s range. */
    speed?: [number, number];
    /** px range. */
    size?: [number, number];
    /** px/s² downward. */
    gravity?: number;
    /** 'glow' soft motes, 'square' hard chips, 'mixed' (default). */
    shape?: 'glow' | 'square' | 'mixed';
  };
}

/** Which effect (by name, inline spec, or none) plays on each window lifecycle moment. */
export interface SlabTransitions {
  open: string | SlabEffectSpec | null;
  close: string | SlabEffectSpec | null;
  minimize: string | SlabEffectSpec | null;
  restore: string | SlabEffectSpec | null;
  /** Plays on each window of the workspace being switched to, staggered. */
  workspaceIn: string | SlabEffectSpec | null;
}

/** How every other window reacts while a modal window is up. */
export interface SlabModalStyle {
  /** px pushed away from the viewer. */
  z: number;
  /** Brightness multiplier (1 = unchanged). */
  dim: number;
}

/** The full motion configuration the client evaluates. */
export interface SlabMotionConfig {
  /** Named effects (user-registered ones layered over the built-ins). */
  effects: Record<string, SlabEffectSpec>;
  transitions: SlabTransitions;
  modal: SlabModalStyle;
  /** Delay (ms) between successive windows of a workspace-in. */
  stagger: number;
  /** Lifecycle motion skips windows shorter than this (tooltips, chips). */
  minHeight: number;
}

// ── Built-in library ───────────────────────────────────────────────────────

/** The default effects. Registered names shadow these. */
export const BUILTIN_SLAB_EFFECTS: Readonly<Record<string, SlabEffectSpec>> = {
  /** Out of depth behind a living-light scan line. */
  materialize: {
    duration: 340,
    easing: 'decelerate',
    scale: [0.94, 1],
    z: [-160, 0],
    opacity: [0, 1],
    scan: { from: 'top', alpha: [0.9, 0] },
  },
  /** Fold to a bright line, then pinch it out. */
  dematerialize: {
    duration: 260,
    easing: 'linear',
    scaleY: { stops: [[0, 1], [0.55, 0.012], [1, 0.012]] },
    scaleX: { stops: [[0, 1], [0.55, 1], [1, 0.02]] },
    opacity: { stops: [[0, 1], [0.55, 1], [1, 0]] },
    scan: { from: 'middle', alpha: [0.95, 0] },
  },
  /** Sink toward the dock. */
  sink: {
    duration: 240,
    easing: 'accelerate',
    toward: { x: 84, amount: [0, 1] },
    scale: [1, 0.15],
    opacity: [1, 0],
  },
  /** An error shudder with a red rim. */
  shake: {
    duration: 460,
    easing: 'linear',
    x: { wave: { amplitude: 11, cycles: 4.5, decay: true } },
    rim: { color: '$accent', alpha: [0.9, 0] },
  },
  /** A rim and aura flash (success, arrival). */
  flash: {
    duration: 650,
    easing: 'decelerate',
    rim: { alpha: [0.95, 0] },
    aura: { alpha: [0.6, 0] },
  },
  /** A brief swell for attention. */
  pulse: {
    duration: 380,
    easing: 'linear',
    scale: { wave: { amplitude: 0.03, cycles: 0.5 } },
    aura: { alpha: { stops: [[0, 0], [0.5, 0.35], [1, 0]] } },
  },
  /** Particles fly off the slab's edges (completion, celebration). */
  burst: {
    duration: 1100,
    easing: 'decelerate',
    particles: { count: 56, from: 'edges', speed: [70, 270], size: [2, 5.5], gravity: 90, shape: 'mixed' },
    aura: { alpha: [0.4, 0] },
  },
  /** A signal-loss jitter. */
  glitch: {
    duration: 320,
    easing: 'linear',
    x: { wave: { amplitude: 6, cycles: 7, decay: true } },
    rotateZ: { wave: { amplitude: 0.006, cycles: 5, decay: true } },
    opacity: { stops: [[0, 1], [0.2, 0.55], [0.35, 1], [0.6, 0.7], [0.75, 1], [1, 1]] },
    scan: { from: 'bottom', color: '$accent', alpha: [0.7, 0] },
  },
};

/** The default motion configuration (the design's own). */
export const DEFAULT_SLAB_MOTION: SlabMotionConfig = {
  effects: {},
  transitions: {
    open: 'materialize',
    close: 'dematerialize',
    minimize: 'sink',
    restore: 'materialize',
    workspaceIn: 'materialize',
  },
  modal: { z: 110, dim: 0.65 },
  stagger: 45,
  minHeight: 80,
};

/** Effect names reserved for built-in behaviour (not registrable). */
export const RESERVED_EFFECT_NAMES: ReadonlySet<string> = new Set(['none']);

// ── Evaluation helpers (pure; used by the client) ──────────────────────────

/** Neutral value per channel: offsets/rotations 0, factors 1. */
export function channelNeutral(channel: string): number {
  return channel === 'scale' || channel === 'scaleX' || channel === 'scaleY'
    || channel === 'opacity' || channel === 'dim' ? 1 : 0;
}

/** Sample a track. `t` is raw normalized time, `e` the eased time. */
export function sampleTrack(track: MotionTrack, t: number, e: number, neutral: number): number {
  if (typeof track === 'number') return track;
  if (Array.isArray(track)) return track[0] + (track[1] - track[0]) * e;
  if ('stops' in track) {
    const stops = track.stops;
    if (stops.length === 0) return neutral;
    if (e <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      const [t1, v1] = stops[i];
      if (e <= t1) {
        const [t0, v0] = stops[i - 1];
        const k = t1 === t0 ? 1 : (e - t0) / (t1 - t0);
        return v0 + (v1 - v0) * k;
      }
    }
    return stops[stops.length - 1][1];
  }
  const { amplitude, cycles, decay } = track.wave;
  return neutral + amplitude * Math.sin(2 * Math.PI * cycles * t) * (decay ? 1 - t : 1);
}

// ── Validation (used by the backend before anything reaches a client) ─────

const TRACK_CHANNELS = ['x', 'y', 'z', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'opacity', 'dim'] as const;
const SPEC_KEYS = new Set<string>([...TRACK_CHANNELS, 'duration', 'easing', 'toward', 'rim', 'aura', 'scan', 'particles']);
const EASING_NAMES = new Set(['linear', 'standard', 'decelerate', 'accelerate', 'emphasize']);

function trackProblem(track: unknown, where: string): string | undefined {
  if (typeof track === 'number') return Number.isFinite(track) ? undefined : `${where}: must be finite`;
  if (Array.isArray(track)) {
    return track.length === 2 && track.every((v) => typeof v === 'number' && Number.isFinite(v))
      ? undefined : `${where}: [from, to] needs two finite numbers`;
  }
  if (track && typeof track === 'object') {
    const o = track as Record<string, unknown>;
    if (Array.isArray(o.stops)) {
      const ok = (o.stops as unknown[]).every((s) => Array.isArray(s) && s.length === 2
        && s.every((v) => typeof v === 'number' && Number.isFinite(v)));
      return ok && (o.stops as unknown[]).length > 0 ? undefined : `${where}: stops must be a non-empty list of [t, value] pairs`;
    }
    if (o.wave && typeof o.wave === 'object') {
      const w = o.wave as Record<string, unknown>;
      return typeof w.amplitude === 'number' && typeof w.cycles === 'number'
        ? undefined : `${where}: wave needs numeric amplitude and cycles`;
    }
  }
  return `${where}: a track is a number, [from, to], { stops: [[t, v], ...] }, or { wave: { amplitude, cycles, decay? } }`;
}

/** Problems with an effect spec (empty when valid). */
export function validateSlabEffectSpec(spec: unknown): string[] {
  const problems: string[] = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['effect spec must be an object'];
  const s = spec as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!SPEC_KEYS.has(k)) problems.push(`unknown field "${k}" (known: ${[...SPEC_KEYS].join(', ')})`);
  if (typeof s.duration !== 'number' || !(s.duration > 0) || s.duration > 10_000) {
    problems.push('duration must be a number of milliseconds in (0, 10000]');
  }
  if (s.easing !== undefined && !(typeof s.easing === 'string' && EASING_NAMES.has(s.easing))
      && !(Array.isArray(s.easing) && s.easing.length === 4 && s.easing.every((v) => typeof v === 'number'))) {
    problems.push(`easing must be one of ${[...EASING_NAMES].join(', ')} or a cubic-bezier [x1, y1, x2, y2]`);
  }
  for (const c of TRACK_CHANNELS) {
    if (s[c] !== undefined) {
      const p = trackProblem(s[c], c);
      if (p) problems.push(p);
    }
  }
  for (const light of ['rim', 'aura', 'scan'] as const) {
    const l = s[light];
    if (l === undefined) continue;
    if (!l || typeof l !== 'object') { problems.push(`${light} must be an object with an alpha track`); continue; }
    const lo = l as Record<string, unknown>;
    const p = trackProblem(lo.alpha, `${light}.alpha`);
    if (p) problems.push(p);
    if (lo.color !== undefined && typeof lo.color !== 'string') problems.push(`${light}.color must be a CSS color or $token`);
  }
  if (s.toward !== undefined) {
    const t = s.toward as Record<string, unknown>;
    const p = trackProblem(t?.amount, 'toward.amount');
    if (p) problems.push(p);
  }
  if (s.particles !== undefined) {
    const pa = s.particles as Record<string, unknown>;
    if (!pa || typeof pa !== 'object') problems.push('particles must be an object');
    else if (pa.count !== undefined && (typeof pa.count !== 'number' || pa.count < 0 || pa.count > 400)) {
      problems.push('particles.count must be 0..400');
    }
  }
  return problems;
}

/** Problems with a transitions patch (names must resolve; specs must validate). */
export function validateTransitions(
  patch: Record<string, unknown>,
  knownEffects: (name: string) => boolean,
): string[] {
  const problems: string[] = [];
  const keys = new Set(['open', 'close', 'minimize', 'restore', 'workspaceIn']);
  for (const [k, v] of Object.entries(patch)) {
    if (!keys.has(k)) { problems.push(`unknown transition "${k}" (known: ${[...keys].join(', ')})`); continue; }
    if (v === null) continue;
    if (typeof v === 'string') {
      if (!knownEffects(v)) problems.push(`${k}: no effect named "${v}"`);
      continue;
    }
    for (const p of validateSlabEffectSpec(v)) problems.push(`${k}: ${p}`);
  }
  return problems;
}
