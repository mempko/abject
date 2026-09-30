/**
 * Shared design helpers for system Abjects' windows.
 *
 * Small pure functions that return widget styles, texts and scene ops in the
 * design language, so every system window builds its headers, empty states
 * and sigils the same way. Colours come from the theme (a palette).
 */

import type { ThemeData } from '../core/theme-data.js';
import { chromeCase } from '../core/theme-data.js';
import type { WidgetStyle } from './widgets/widget-types.js';
import { require as contractRequire, requireNonEmpty } from '../core/contracts.js';

/** Label style for a section header inside a window (not user text). */
export function sectionHeaderStyle(theme: ThemeData, size = 13): WidgetStyle {
  return { color: theme.textHeading, fontWeight: 'bold', fontSize: size, fontFamily: 'display' };
}

/** Section header text in chrome case, led by the sigil ring mark (◉). */
export function sectionHeaderText(theme: ThemeData, text: string): string {
  return `\u25C9  ${chromeCase(theme, text)}`;
}

/** Muted helper-text style (descriptions under headers, hints). */
export function hintStyle(theme: ThemeData, size = 12): WidgetStyle {
  return { color: theme.textSecondary, fontSize: size, wordWrap: true };
}

/**
 * Markdown for an empty state: a short title and one line saying what to do
 * next. Render it in a markdown label with `emptyStateStyle`.
 */
export function emptyStateMarkdown(title: string, hint: string): string {
  return `**${title}**\n\n${hint}`;
}

/** Style for an empty-state markdown label (centered, muted). */
export function emptyStateStyle(theme: ThemeData): WidgetStyle {
  return { color: theme.textSecondary, fontSize: 13, markdown: true, wordWrap: true, align: 'center' };
}

/** Style for a live/"alive" status label: the living light (accentSecondary). */
export function livingStyle(theme: ThemeData, size = 12): WidgetStyle {
  return { color: theme.accentSecondary, fontSize: size };
}

/** One scene op as accepted by a window's `scene` method. */
export type SceneOp = Record<string, unknown>;

/**
 * A small 3D eye sigil for a window's `scene` method: a bone ring facing the
 * viewer, a red inner ring, a phosphor slit pupil that breathes, and a red
 * square satellite orbiting it. All motion is client-side `animate` ops (one
 * batch, no per-frame traffic). `at` is px from the window centre (+y down,
 * +z toward the viewer); `size` is the ring diameter in px. Colours are theme
 * tokens, so the sigil re-skins on a theme change. Prefix node ids so several
 * sigils can coexist; remove it with `removeSigilOps(prefix)`.
 */
export function eyeSigilOps(prefix: string, at: [number, number, number], size = 34): SceneOp[] {
  const faceViewer: [number, number, number] = [Math.PI / 2, 0, 0];
  const g = `${prefix}-sigil`;
  return [
    { op: 'add', id: g, kind: 'group', transform: { position: at } },
    {
      op: 'add', id: `${g}-ring`, parentId: g, kind: 'mesh',
      transform: { rotation: faceViewer, scale: [size, size, size] },
      params: { primitive: 'torus', color: '$textPrimary', emissive: '$textPrimary', roughness: 1 },
    },
    {
      op: 'add', id: `${g}-inner`, parentId: g, kind: 'mesh',
      transform: { rotation: faceViewer, scale: [size * 0.62, size * 0.62, size * 0.62] },
      params: { primitive: 'torus', color: '$accent', emissive: '$accent', roughness: 1 },
    },
    {
      op: 'add', id: `${g}-pupil`, parentId: g, kind: 'mesh',
      transform: { position: [0, 0, 2], scale: [size * 0.12, size * 0.42, size * 0.12] },
      params: { primitive: 'sphere', color: '$accentSecondary', emissive: '$accentSecondary' },
    },
    {
      op: 'add', id: `${g}-sat`, parentId: g, kind: 'mesh',
      transform: { position: [size * 0.62, 0, 0], scale: [size * 0.14, size * 0.14, size * 0.14] },
      params: { primitive: 'box', color: '$accent', emissive: '$accent' },
    },
    { op: 'animate', id: `${g}-pupil`, params: { preset: 'pulse', scale: 1.25, duration: 1800 } },
    {
      op: 'animate', id: `${g}-sat`,
      params: { preset: 'orbit', center: [0, 0, 0], radius: size * 0.62, plane: 'xy', duration: 9000 },
    },
  ];
}

/** Remove an eye sigil added with `eyeSigilOps(prefix, ...)`. */
export function removeSigilOps(prefix: string): SceneOp[] {
  return [{ op: 'remove', id: `${prefix}-sigil` }];
}

/**
 * A slow living-light stream rising off an eye sigil added with
 * `eyeSigilOps(prefix, ...)`: a child of the sigil group, so removing the
 * sigil removes the stream too. Motes drift up and toward the viewer, fading
 * as they pass the title rule (they draw over the chrome, unclipped). Update
 * the `${prefix}-stream` node's `params.rate` to start or stop it without
 * rebuilding the eye (a stream with rate > 0 keeps the desktop redrawing, so
 * set it to 0 whenever the thing it shows is idle).
 */
export function sigilStreamOps(prefix: string, size: number, rate: number): SceneOp[] {
  return [{
    op: 'add', id: `${prefix}-stream`, parentId: `${prefix}-sigil`, kind: 'particles',
    transform: { position: [0, -size * 0.25, 4] },
    params: {
      rate, lifetime: 1600, speed: [8, 18], direction: [0, -1, 0.5], spread: 0.55,
      gravity: -4, size: [1.2, 2.4], color: '$accentSecondary', shape: 'glow',
      maxParticles: 24, occlude: false,
    },
  }];
}


// ── Living light around a rect (busy / indeterminate work) ─────────────
//
// Scene ops for a window's `scene` method sent with `origin: 'topLeft'`, so
// rects are window px from the window's top-left corner (the same numbers a
// widget draws at). Everything moves client-side: one batch turns the light
// on, one op moves it, one op turns it off. Colours are theme tokens (or any
// colour you pass), so every palette re-skins it; normal blending keeps it
// visible on light palettes too.

/** A rect in window px from the window's top-left corner. */
export interface WindowRect { x: number; y: number; width: number; height: number }

function requireRect(rect: WindowRect, what: string): void {
  contractRequire(!!rect && [rect.x, rect.y, rect.width, rect.height].every((v) => typeof v === 'number' && Number.isFinite(v)),
    `${what}: rect needs finite { x, y, width, height } in window px`);
}

export interface BusyFrameOptions {
  /** Light colour ($token or CSS colour). Default: the living light, $accentSecondary. */
  color?: string;
  /** Frame line width in screen px. Default 1.5. */
  lineWidth?: number;
  /** Also let a few motes rise off the frame. Default false. */
  motes?: boolean;
  /**
   * Add light instead of painting it (additive blending): a real glow on a
   * dark ground. Leave it off on light grounds, where added light vanishes
   * (see `isDarkGround`). Default false.
   */
  glow?: boolean;
  /**
   * The fuller treatment: a brighter breathing frame and two haloed lights
   * chasing each other. Default false: one small, slow light and a faint
   * frame, calm enough to sit on always-visible rows like the dock.
   */
  vivid?: boolean;
}

/** True when a CSS colour (#rgb, #rrggbb, rgb[a]()) is dark enough that added light reads as glow. */
export function isDarkGround(color: string | undefined): boolean {
  if (!color) return true;
  let r = 0, g = 0, b = 0;
  const hex = color.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex && hex[1].length !== 5 && hex[1].length !== 7) {
    const h = hex[1].length <= 4 ? hex[1].slice(0, 3).split('').map((c) => c + c).join('') : hex[1].slice(0, 6);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (!m) return true;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
}

/**
 * Evenly spaced points around a rect centred on the origin, corners exact,
 * closed (the last point is the first). Position animations sample paths
 * per segment, so equal spacing gives the runner an even speed.
 */
function perimeterPath(w: number, h: number, z: number): number[][] {
  const hw = w / 2, hh = h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
  const step = Math.max(4, (w + h) / 24);
  const pts: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n, z]);
  }
  pts.push([-hw, -hh, z]);
  return pts;
}

/**
 * The busy treatment for a rect: a faint frame in the living light that
 * breathes slowly, and one small light travelling its edge with a short
 * fading tail (`vivid` brightens the frame and adds a second, haloed light
 * chasing the first). `id` names the root group (remove it with
 * `removeSceneGroupOps(id)`, move it with `moveBusyFrameOps(id, rect)`).
 * Loops only while the nodes exist, so remove them the moment the work ends.
 */
export function busyFrameOps(id: string, rect: WindowRect, opts: BusyFrameOptions = {}): SceneOp[] {
  requireNonEmpty(id, 'busyFrameOps id');
  requireRect(rect, 'busyFrameOps');
  const color = opts.color ?? '$accentSecondary';
  const blend = opts.glow ? 'additive' : 'normal';
  const w = Math.max(2, rect.width), h = Math.max(2, rect.height);
  const lineWidth = opts.lineWidth ?? 1.5;
  const inset = lineWidth / 2;
  const fw = Math.max(1, w - inset * 2), fh = Math.max(1, h - inset * 2);
  const hw = fw / 2, hh = fh / 2;
  const perimeter = 2 * (fw + fh);
  const vivid = opts.vivid === true;
  // A calm light: slower laps, a smaller head, a dimmer frame. Vivid keeps
  // the original, livelier numbers.
  const lap = vivid
    ? Math.round(Math.min(4800, Math.max(1800, perimeter / 0.14)))
    : Math.round(Math.min(8000, Math.max(3200, perimeter / 0.08)));
  const size = vivid
    ? Math.max(3, Math.min(6.5, Math.min(w, h) * 0.16))
    : Math.max(2, Math.min(3.2, Math.min(w, h) * 0.1));
  const frameBreath = vivid
    ? [{ t: 0, value: 0.18, easing: 'standard' }, { t: 1300, value: 0.6, easing: 'standard' }, { t: 2600, value: 0.18 }]
    : [{ t: 0, value: 0.06, easing: 'standard' }, { t: 2000, value: 0.24, easing: 'standard' }, { t: 4000, value: 0.06 }];
  const path = perimeterPath(fw, fh, 1);
  // The second light starts half a lap on, so the two chase each other.
  const half = Math.floor((path.length - 1) / 2);
  const opposite = [...path.slice(half, path.length - 1), ...path.slice(0, half), path[half]];
  const ops: SceneOp[] = [
    {
      op: 'add', id, kind: 'group',
      transform: { position: [rect.x + w / 2, rect.y + h / 2, 0] },
      params: { clip: 'window' },
    },
    {
      op: 'add', id: `${id}-frame`, parentId: id, kind: 'line',
      transform: { position: [0, 0, 0.5] },
      params: {
        points: [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]],
        closed: true, width: lineWidth, color, opacity: vivid ? 0.2 : 0.06, blend,
      },
    },
    {
      op: 'animate', id: `${id}-frame`,
      params: { channel: 'opacity', loop: true, keyframes: frameBreath },
    },
  ];
  (vivid ? [path, opposite] : [path]).forEach((p, i) => {
    const runner = `${id}-runner${i}`;
    ops.push(
      {
        op: 'add', id: runner, parentId: id, kind: 'mesh',
        transform: { position: p[0] as [number, number, number], scale: size },
        params: {
          primitive: 'sphere', color, emissive: color, shading: 'unlit',
          opacity: vivid ? 1 : 0.75,
          trail: vivid
            ? { width: size, lifetime: Math.round(lap * 0.3), color, blend, opacity: 1 }
            : { width: size * 0.7, lifetime: Math.round(lap * 0.14), color, blend, opacity: 0.45 },
        },
      },
      {
        op: 'add', id: `${runner}-halo`, parentId: runner, kind: 'mesh',
        transform: { position: [0, 0, -0.2], scale: vivid ? 2.4 : 2 },
        params: {
          primitive: 'sphere', color, emissive: color, shading: 'unlit', blend,
          opacity: vivid ? (opts.glow ? 0.35 : 0.14) : (opts.glow ? 0.12 : 0.06),
        },
      },
      {
        op: 'animate', id: runner,
        params: { channel: 'position', path: p, duration: lap, loop: true, easing: 'linear' },
      },
    );
  });
  if (opts.motes) {
    ops.push({
      op: 'add', id: `${id}-motes`, parentId: id, kind: 'particles',
      transform: { position: [0, -hh, 2] },
      params: {
        rate: 5, lifetime: 1400, speed: [6, 14], direction: [0, -1, 0.4], spread: 0.6,
        size: [1.2, 2.2], sizeEnd: 0.4, color, opacity: 0.8, opacityEnd: 0,
        emitterSize: [fw, 1, 0], maxParticles: 16,
      },
    });
  }
  return ops;
}

/** Move a busy frame (or any rect-centred group) to a rect of the SAME size. */
export function moveBusyFrameOps(id: string, rect: WindowRect): SceneOp[] {
  requireRect(rect, 'moveBusyFrameOps');
  return [{ op: 'update', id, transform: { position: [rect.x + rect.width / 2, rect.y + rect.height / 2, 0] } }];
}

/** Remove a group added by `busyFrameOps` / `progressSweepOps` (its children go with it). */
export function removeSceneGroupOps(id: string): SceneOp[] {
  return [{ op: 'remove', id }];
}

/**
 * An indeterminate-progress sweep along a track rect: a bar of light that
 * grows out of the left end, crosses, and shrinks into the right end, on a
 * loop. With `trackColor` the bar fades into the track at both ends (a soft
 * comet of light); without it the bar is solid. Stays inside the track.
 * Remove it with `removeSceneGroupOps(id)` when the work ends or turns
 * determinate.
 */
export function progressSweepOps(
  id: string, rect: WindowRect, opts: { color?: string; trackColor?: string; duration?: number } = {},
): SceneOp[] {
  requireNonEmpty(id, 'progressSweepOps id');
  requireRect(rect, 'progressSweepOps');
  contractRequire(opts.duration === undefined || opts.duration > 0, 'progressSweepOps: duration must be > 0 ms');
  const color = opts.color ?? '$accentSecondary';
  const w = Math.max(8, rect.width), h = Math.max(2, rect.height);
  const dur = opts.duration ?? 1500;
  const edge = Math.min(4, w * 0.05);
  const wide = w * 0.45;
  const bar: SceneOp = opts.trackColor
    ? {
      op: 'add', id: `${id}-bar`, parentId: `${id}-run`, kind: 'line',
      params: {
        points: [[-0.5, 0, 0], [-0.3, 0, 0], [0.3, 0, 0], [0.5, 0, 0]],
        colors: [opts.trackColor, color, color, opts.trackColor],
        width: h, color,
      },
    }
    : {
      op: 'add', id: `${id}-bar`, parentId: `${id}-run`, kind: 'mesh',
      transform: { scale: [1, h, 1] },
      params: { primitive: 'box', color, emissive: color, shading: 'unlit' },
    };
  return [
    {
      op: 'add', id, kind: 'group',
      transform: { position: [rect.x + w / 2, rect.y + h / 2, 0] },
      params: { clip: 'window' },
    },
    {
      op: 'add', id: `${id}-run`, parentId: id, kind: 'group',
      transform: { position: [-w / 2 + edge / 2, 0, 0.5], scale: [edge, 1, 1] },
    },
    bar,
    {
      op: 'animate', id: `${id}-run`,
      params: {
        channel: 'position', loop: true,
        keyframes: [
          { t: 0, value: [-w / 2 + edge / 2, 0, 0.5] },
          { t: dur / 2, value: [0, 0, 0.5] },
          { t: dur, value: [w / 2 - edge / 2, 0, 0.5] },
        ],
      },
    },
    {
      op: 'animate', id: `${id}-run`,
      params: {
        channel: 'scale', loop: true,
        keyframes: [
          { t: 0, value: [edge, 1, 1] },
          { t: dur / 2, value: [wide, 1, 1] },
          { t: dur, value: [edge, 1, 1] },
        ],
      },
    },
  ];
}
