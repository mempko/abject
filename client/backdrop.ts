/**
 * Desktop backdrop: the sigil void.
 *
 * The design's ground, painted behind the windows (the WebGL desktop clears to
 * transparent so this canvas shows through). A Constructivist composition
 * printed faintly into the void: an eclipse disc in the accent with a living
 * corona and a slit pupil, a diagonal bar, a wedge, thin rules on a faint
 * grid, tendrils rising from below, and drifting motes of living light. Every
 * layer is a watermark (low alpha) so the windows stay the subject.
 *
 * Colours come from the scene theme pushed by the backend, so each palette
 * gets its own void. Cheap by construction: the ground, grid, rules and grain
 * are rendered once into an offscreen layer (rebuilt on resize or theme
 * change); the moving parts redraw at ~8 fps, ~30 fps while connecting.
 * Pauses while the tab is hidden and holds still under reduced motion.
 */

import type { SceneTheme } from '../src/ui/gl/scene-types.js';

export interface BackdropControl {
  stop: () => void;
  /** Connecting: motes rise faster and the corona turns while the link comes up. */
  setDescending: (descending: boolean) => void;
  /** Apply the scene theme pushed by the backend. */
  setTheme: (theme?: SceneTheme) => void;
}

/** Red Sigil colours, used until the backend pushes a scene theme. */
const DEFAULTS = {
  ground: '#06070a',
  ink: '#e7e1ce',
  hand: '#d32f22',
  living: '#5be5a0',
  brass: '#c9a45c',
};
type Palette = typeof DEFAULTS;

const IDLE_FRAME_MS = 125;
const ACTIVE_FRAME_MS = 33;
const MOTE_COUNT = 28;
const DEG = Math.PI / 180;

/** Watermark strength of each layer (its share of ink in the void). */
const MUTE = {
  grid: 0.025, rules: 0.07, disc: 0.08, corona: 0.16, pupil: 0.07,
  bar: 0.035, wedge: 0.07, tendril: 0.05, brass: 0.12,
} as const;

function paletteFrom(colors?: Record<string, string>): Palette {
  return {
    ground: colors?.canvasBg ?? DEFAULTS.ground,
    ink: colors?.textPrimary ?? DEFAULTS.ink,
    hand: colors?.accent ?? DEFAULTS.hand,
    living: colors?.accentSecondary ?? DEFAULTS.living,
    brass: colors?.accentTertiary ?? DEFAULTS.brass,
  };
}

interface Mote { x: number; y: number; r: number; vy: number; drift: number; phase: number; a: number }

export function startBackdrop(canvas: HTMLCanvasElement): BackdropControl {
  const ctx = canvas.getContext('2d')!;
  const staticLayer = document.createElement('canvas');
  let palette = paletteFrom();
  let w = 0;
  let h = 0;
  let dpr = 1;
  let animId = 0;
  let stopped = false;
  let paused = false;
  let lastTs = 0;
  let descending = true;
  let energy = 1;       // 1 while connecting, eases to 0
  let spinTime = 0;     // corona rotation clock, faster with energy
  const startTs = performance.now();
  const reduceMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let motes: Mote[] = [];

  function applyGround(): void {
    document.documentElement.style.background = palette.ground;
    document.body.style.background = palette.ground;
  }

  function seedMotes(): void {
    motes = Array.from({ length: MOTE_COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.8 + Math.random() * 1.8,
      vy: 4 + Math.random() * 10,
      drift: 6 + Math.random() * 14,
      phase: Math.random() * Math.PI * 2,
      a: 0.05 + Math.random() * 0.16,
    }));
  }

  function buildStatic(): void {
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
    const s = staticLayer.getContext('2d')!;
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.fillStyle = palette.ground;
    s.fillRect(0, 0, w, h);

    // Faint construction grid.
    s.strokeStyle = palette.ink;
    s.globalAlpha = MUTE.grid;
    s.lineWidth = 1;
    s.beginPath();
    for (let x = 0.5; x < w; x += 64) { s.moveTo(x, 0); s.lineTo(x, h); }
    for (let y = 0.5; y < h; y += 64) { s.moveTo(0, y); s.lineTo(w, y); }
    s.stroke();

    // A few thin rules, the poster's scaffolding.
    s.globalAlpha = MUTE.rules;
    s.lineWidth = 2;
    s.beginPath();
    s.moveTo(w * 0.06, h * 0.12); s.lineTo(w * 0.46, h * 0.12);
    s.moveTo(w * 0.9, h * 0.6); s.lineTo(w * 0.9, h * 0.95);
    s.stroke();

    // Print grain.
    s.globalAlpha = 1;
    const grain = document.createElement('canvas');
    grain.width = grain.height = 96;
    const g = grain.getContext('2d')!;
    g.fillStyle = palette.ink;
    for (let i = 0; i < 260; i++) {
      g.globalAlpha = 0.01 + Math.random() * 0.03;
      g.fillRect(Math.random() * 96, Math.random() * 96, 1, 1);
    }
    const pattern = s.createPattern(grain, 'repeat');
    if (pattern) { s.fillStyle = pattern; s.fillRect(0, 0, w, h); }
  }

  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    buildStatic();
    seedMotes();
    draw(performance.now(), 0);
  }

  function bar(px: number, py: number, angle: number, thickness: number, length: number): void {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.fillRect(-length / 2, -thickness / 2, length, thickness);
    ctx.restore();
  }

  function draw(ts: number, dt: number): void {
    const t = reduceMotion ? 0 : (ts - startTs) / 1000;
    const s = Math.min(w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Eclipse: a disc in the hand's colour, a living corona with a turning
    // gap and a notch, and a slit pupil in its centre.
    const cx = w * 0.78;
    const cy = h * 0.32;
    const r = s * 0.42;
    ctx.globalAlpha = MUTE.disc;
    ctx.fillStyle = palette.hand;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    const spin = spinTime * 2 * Math.PI / 240;
    ctx.globalAlpha = MUTE.corona * (1 + energy * 0.8);
    ctx.strokeStyle = palette.living;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.06, spin + 0.3, spin + Math.PI * 2 - 0.3); ctx.stroke();
    ctx.fillStyle = palette.living;
    const n = s * 0.018;
    ctx.fillRect(cx + Math.cos(spin) * r * 1.06 - n / 2, cy + Math.sin(spin) * r * 1.06 - n / 2, n, n);
    ctx.globalAlpha = MUTE.pupil;
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.07, r * 0.36, 0, 0, Math.PI * 2); ctx.fill();

    // Diagonal bar and a wedge driving in from the left.
    const drift = Math.sin(t * 2 * Math.PI / 60);
    ctx.globalAlpha = MUTE.bar;
    ctx.fillStyle = palette.ink;
    bar(w * 0.4, h * 0.64, (-24 + drift * 1.2) * DEG, s * 0.07, Math.hypot(w, h) * 1.4);
    ctx.globalAlpha = MUTE.wedge;
    ctx.fillStyle = palette.hand;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.8); ctx.lineTo(w * 0.32, h * 0.855); ctx.lineTo(0, h * 0.94);
    ctx.closePath(); ctx.fill();

    // A small brass square, the one warm note.
    ctx.globalAlpha = MUTE.brass;
    ctx.fillStyle = palette.brass;
    ctx.save();
    ctx.translate(w * 0.14, h * 0.24);
    ctx.rotate(-24 * DEG);
    ctx.fillRect(-s * 0.03, -s * 0.03, s * 0.06, s * 0.06);
    ctx.restore();

    // Tendrils rising from below, swaying slowly.
    ctx.globalAlpha = MUTE.tendril;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const bx = w * (0.22 + i * 0.27);
      const sway = Math.sin(t * 0.12 + i * 1.7) * s * 0.06;
      ctx.beginPath();
      ctx.moveTo(bx, h + 10);
      ctx.bezierCurveTo(bx + sway, h * 0.78, bx - sway * 1.4, h * 0.62, bx + sway * 0.6, h * (0.46 + i * 0.05));
      ctx.stroke();
    }

    // Motes of living light drifting upward.
    const speed = 1 + energy * 5;
    ctx.fillStyle = palette.living;
    for (const m of motes) {
      if (!reduceMotion) {
        m.y -= m.vy * speed * dt;
        if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
      }
      const x = m.x + Math.sin(t * 0.3 + m.phase) * m.drift;
      ctx.globalAlpha = m.a * (0.7 + 0.3 * Math.sin(t * 0.8 + m.phase));
      ctx.beginPath(); ctx.arc(x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(ts: number): void {
    if (stopped || paused) return;
    const frameMs = energy > 0.01 ? ACTIVE_FRAME_MS : IDLE_FRAME_MS;
    if (ts - lastTs >= frameMs) {
      const dt = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      if (!descending && energy > 0) energy = Math.max(0, energy - dt / 1.6);
      spinTime += dt * (1 + energy * 40);
      draw(ts, dt);
    }
    if (reduceMotion && energy <= 0.01) return;
    animId = requestAnimationFrame(frame);
  }

  function kick(): void {
    if (stopped || paused) return;
    cancelAnimationFrame(animId);
    lastTs = 0;
    animId = requestAnimationFrame(frame);
  }

  function onVisibility(): void {
    paused = document.hidden;
    if (paused) cancelAnimationFrame(animId);
    else kick();
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  applyGround();
  resize();
  kick();

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    },
    setDescending: (d: boolean) => {
      descending = d;
      if (d) energy = 1;
      kick();
    },
    setTheme: (theme?: SceneTheme) => {
      palette = paletteFrom(theme?.colors);
      applyGround();
      buildStatic();
      draw(performance.now(), 0);
      kick();
    },
  };
}
