/**
 * Motion primitives for canvas-driven UI animation.
 *
 * Animations on Abjects run in their own Node.js worker (or main thread) and
 * stream fresh draw commands per step to the client compositor. This module
 * is therefore pure: it owns timers and tween math, but never touches a
 * canvas directly. Callers wire `onUpdate` to their own `_draw()` cycle.
 *
 * Easings are cubic-bezier curves, evaluated with Newton-Raphson on the x
 * axis to give visually correct timing (not just naive parametric t).
 */

import { EasingCurve } from '../core/theme-data.js';

export const STANDARD:   EasingCurve = [0.4, 0.0, 0.2, 1.0];
export const ACCELERATE: EasingCurve = [0.4, 0.0, 1.0, 1.0];
export const DECELERATE: EasingCurve = [0.0, 0.0, 0.2, 1.0];
export const EMPHASIZE:  EasingCurve = [0.2, 0.0, 0.0, 1.0];
export const LINEAR:     EasingCurve = [0.0, 0.0, 1.0, 1.0];

function sampleCurveX(t: number, x1: number, x2: number): number {
  const it = 1 - t;
  return 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t;
}

function sampleCurveDerivativeX(t: number, x1: number, x2: number): number {
  const it = 1 - t;
  return 3 * it * it * x1 + 6 * it * t * (x2 - x1) + 3 * t * t * (1 - x2);
}

function sampleCurveY(t: number, y1: number, y2: number): number {
  const it = 1 - t;
  return 3 * it * it * t * y1 + 3 * it * t * t * y2 + t * t * t;
}

/**
 * Evaluate a cubic-bezier easing curve at progress x in [0, 1].
 * Uses Newton-Raphson to invert x(t), then samples y(t).
 */
export function cubicBezier(curve: EasingCurve, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = curve;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xT = sampleCurveX(t, x1, x2);
    const slope = sampleCurveDerivativeX(t, x1, x2);
    if (Math.abs(slope) < 1e-6) break;
    t -= (xT - x) / slope;
  }
  return sampleCurveY(t, y1, y2);
}

export interface TweenOptions {
  from: number;
  to: number;
  /** Duration in milliseconds. */
  duration: number;
  easing?: EasingCurve;
  /** Called every step, including a final call at t=1. */
  onUpdate: (value: number, t: number) => void;
  /** Called once when the tween reaches t=1 (not called on cancel). */
  onDone?: () => void;
  /** Restart the tween when it completes. */
  loop?: boolean;
  /** With loop=true, alternate direction each iteration. */
  yoyo?: boolean;
}

const DEFAULT_FRAME_MS = 16;

/**
 * Animates a single number from `from` to `to` over `duration`, calling
 * `onUpdate` each step with the eased value.
 *
 * Multiple in-flight tweens on the same property must be coordinated by the
 * caller (cancel the old one before starting the new). This class owns
 * exactly one timer.
 */
export class Tween {
  private readonly opts: Required<Omit<TweenOptions, 'onDone'>> & Pick<TweenOptions, 'onDone'>;
  private startTime = 0;
  private timer?: ReturnType<typeof setInterval>;
  private cancelled = false;
  private direction = 1;

  constructor(opts: TweenOptions) {
    this.opts = {
      easing: STANDARD,
      loop: false,
      yoyo: false,
      ...opts,
    };
  }

  start(): this {
    if (this.timer !== undefined) return this;
    this.cancelled = false;
    this.startTime = nowMs();
    this.step();
    if (!this.cancelled) {
      this.timer = setInterval(() => this.step(), DEFAULT_FRAME_MS);
    }
    return this;
  }

  private step(): void {
    if (this.cancelled) return;
    const elapsed = nowMs() - this.startTime;
    let progress = elapsed / this.opts.duration;

    if (progress >= 1) {
      const eased = cubicBezier(this.opts.easing, 1);
      const finalValue = this.lerp(eased);
      this.opts.onUpdate(finalValue, 1);

      if (this.opts.loop) {
        this.startTime = nowMs();
        if (this.opts.yoyo) {
          this.direction *= -1;
        }
        return;
      }

      this.stopTimer();
      this.opts.onDone?.();
      return;
    }

    if (progress < 0) progress = 0;
    const eased = cubicBezier(this.opts.easing, progress);
    this.opts.onUpdate(this.lerp(eased), progress);
  }

  private lerp(eased: number): number {
    const { from, to } = this.opts;
    if (this.direction === 1) {
      return from + (to - from) * eased;
    }
    return to + (from - to) * eased;
  }

  cancel(): void {
    this.cancelled = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get running(): boolean {
    return this.timer !== undefined;
  }
}

/** Convenience: fade alpha 0 → 1 (decelerate). */
export function fadeIn(duration: number, onUpdate: (alpha: number) => void, onDone?: () => void): Tween {
  return new Tween({ from: 0, to: 1, duration, easing: DECELERATE, onUpdate, onDone });
}

/** Convenience: fade alpha 1 → 0 (accelerate). */
export function fadeOut(duration: number, onUpdate: (alpha: number) => void, onDone?: () => void): Tween {
  return new Tween({ from: 1, to: 0, duration, easing: ACCELERATE, onUpdate, onDone });
}

/** Convenience: scale 0.96 → 1.0 (decelerate). */
export function scaleIn(duration: number, onUpdate: (scale: number) => void, onDone?: () => void): Tween {
  return new Tween({ from: 0.96, to: 1.0, duration, easing: DECELERATE, onUpdate, onDone });
}

/** Convenience: 0 → 1 → 0 yoyo loop forever. Caller must cancel(). */
export function pulse(duration: number, onUpdate: (intensity: number) => void): Tween {
  return new Tween({
    from: 0,
    to: 1,
    duration: duration / 2,
    easing: EMPHASIZE,
    onUpdate,
    loop: true,
    yoyo: true,
  });
}

/** Convenience: linear 0 → 1 loop forever (for shimmer position). Cancel to stop. */
export function shimmer(duration: number, onUpdate: (position: number) => void): Tween {
  return new Tween({
    from: 0,
    to: 1,
    duration,
    easing: EMPHASIZE,
    onUpdate,
    loop: true,
  });
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
}
