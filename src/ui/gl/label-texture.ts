/**
 * Label textures for `label` scene nodes: crisp, camera-facing 2D text.
 *
 * `renderLabel` draws the text (wrapped at `maxWidth`, on an optional rounded
 * background) into a canvas at the device pixel ratio, so one texel lands on
 * one device pixel when the label is shown at its natural size. It returns
 * the canvas and the label's CSS size; the caller uploads the canvas as a
 * texture (renderer.uploadTexture) and draws a quad of that size, built by
 * `labelModelMatrix` to face the camera and (for `screenSpace` labels) to keep
 * a constant on-screen size at any depth. Browser only (canvas).
 */

import type { Mat4 } from './math.js';

export interface LabelOptions {
  text: string;
  /** CSS font family, optionally led by style/weight words ('bold Inter'). */
  font?: string;
  /** Font size in CSS px [14]. */
  size?: number;
  /** CSS colour of the text [#ffffff]. */
  color?: string;
  /** CSS colour of the background; omitted = transparent. */
  background?: string;
  /** Padding around the text, CSS px [6]. */
  padding?: number;
  /** Background corner radius, CSS px [0]. */
  radius?: number;
  /** Wrap width for the text, CSS px (omitted = no wrapping). */
  maxWidth?: number;
  align?: 'left' | 'center' | 'right';
  /** Line height as a multiple of size [1.25]. */
  lineHeight?: number;
  /** Device pixel ratio to render at [window.devicePixelRatio or 1]. */
  dpr?: number;
}

export interface LabelTexture {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  /** Size in CSS px (the quad size at scale 1). */
  width: number;
  height: number;
  /** Backing size in device px. */
  pixelWidth: number;
  pixelHeight: number;
  dpr: number;
  lines: string[];
  /** Identity of the inputs, to skip re-rendering unchanged labels. */
  key: string;
}

const STYLE_WORDS = /^(italic|oblique|normal|bold|bolder|lighter|small-caps|[1-9]00)$/i;

/**
 * A CSS font shorthand for a family (optionally led by style and weight
 * words) at a pixel size: ('bold Georgia, serif', 20) -> 'bold 20px Georgia, serif'.
 * A value that already has a px size keeps its words and gets the new size.
 */
export function cssFont(font: string | undefined, sizePx: number, fallback = 'system-ui, sans-serif'): string {
  const f = (font ?? '').trim() || fallback;
  if (/\d+(\.\d+)?px/.test(f)) return f.replace(/\d+(\.\d+)?px/, `${sizePx}px`);
  const words = f.split(/\s+/);
  const lead: string[] = [];
  while (words.length > 1 && STYLE_WORDS.test(words[0])) lead.push(words.shift()!);
  return `${lead.length ? lead.join(' ') + ' ' : ''}${sizePx}px ${words.join(' ')}`;
}

/** Stable key for label inputs (the caller re-renders only when it changes). */
export function labelKey(o: LabelOptions): string {
  return JSON.stringify([o.text, o.font ?? '', o.size ?? 14, o.color ?? '', o.background ?? '', o.padding ?? 6,
    o.radius ?? 0, o.maxWidth ?? 0, o.align ?? 'center', o.lineHeight ?? 1.25, labelDpr(o)]);
}

function labelDpr(o: LabelOptions): number {
  const d = o.dpr ?? (typeof globalThis !== 'undefined' ? (globalThis as { devicePixelRatio?: number }).devicePixelRatio : undefined) ?? 1;
  return Math.max(0.5, Math.min(4, d));
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

let measureCtx: Ctx2D | null = null;
function measurer(): Ctx2D | null {
  if (!measureCtx) {
    const c = makeCanvas(4, 4);
    measureCtx = (c?.getContext('2d') as Ctx2D | null) ?? null;
  }
  return measureCtx;
}

/** Greedy word wrap; words longer than the width break by characters. */
export function wrapText(ctx: Ctx2D, text: string, maxWidth: number | undefined): string[] {
  const out: string[] = [];
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth!;
  for (const para of text.split('\n')) {
    if (!maxWidth || maxWidth <= 0) { out.push(para); continue; }
    let line = '';
    for (const tok of para.split(/(\s+)/).filter((w) => w.length > 0)) {
      if (fits(line + tok)) { line += tok; continue; }
      if (!tok.trim()) { out.push(line.trimEnd()); line = ''; continue; }
      if (line.trim()) { out.push(line.trimEnd()); line = ''; }
      if (fits(tok)) { line = tok; continue; }
      for (const ch of tok) {
        if (line && !fits(line + ch)) { out.push(line); line = ch; } else line += ch;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Draw a label into a fresh canvas. Returns null where no canvas exists (Node). */
export function renderLabel(o: LabelOptions): LabelTexture | null {
  const m = measurer();
  if (!m) return null;
  const size = Math.max(1, Math.min(512, o.size ?? 14));
  const pad = Math.max(0, o.padding ?? 6);
  const dpr = labelDpr(o);
  const lh = Math.max(0.5, o.lineHeight ?? 1.25) * size;
  const font = cssFont(o.font, size);
  m.font = font;
  const lines = wrapText(m, String(o.text ?? ''), o.maxWidth);
  let textW = 0;
  for (const l of lines) textW = Math.max(textW, m.measureText(l).width);
  const metrics = m.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? size * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? size * 0.2;
  const contentW = o.maxWidth && o.maxWidth > 0 ? Math.min(textW, o.maxWidth) : textW;
  const width = Math.ceil(contentW + pad * 2);
  const height = Math.ceil(lh * (lines.length - 1) + ascent + descent + pad * 2);
  const pw = Math.max(1, Math.min(4096, Math.ceil(width * dpr)));
  const ph = Math.max(1, Math.min(4096, Math.ceil(height * dpr)));
  const canvas = makeCanvas(pw, ph);
  const ctx = canvas?.getContext('2d') as Ctx2D | null;
  if (!canvas || !ctx) return null;
  ctx.scale(pw / Math.max(1, width), ph / Math.max(1, height));
  if (o.background) {
    const r = Math.max(0, Math.min(o.radius ?? 0, width / 2, height / 2));
    ctx.fillStyle = o.background;
    ctx.beginPath();
    if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(0, 0, width, height, r);
    else ctx.rect(0, 0, width, height);
    ctx.fill();
  }
  ctx.font = font;
  ctx.fillStyle = o.color ?? '#ffffff';
  ctx.textBaseline = 'alphabetic';
  const align = o.align ?? 'center';
  ctx.textAlign = align;
  const x = align === 'left' ? pad : align === 'right' ? width - pad : width / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, pad + ascent + i * lh));
  return { canvas, width, height, pixelWidth: pw, pixelHeight: ph, dpr, lines, key: labelKey(o) };
}

export interface LabelPlacement {
  /** Anchor point in world px. */
  position: [number, number, number];
  /** Label size in CSS px. */
  width: number;
  height: number;
  /** Which point of the label sits on `position`: [0,0] top-left, [0.5,0.5] centre. */
  anchor?: [number, number];
  /** Keep a constant on-screen size [true]. */
  screenSpace?: boolean;
  /** Extra uniform scale (the node's own scale) [1]. */
  scale?: number;
  /** World-space eye. */
  cameraPos: [number, number, number];
  /**
   * The camera's view matrix, when it rotates (a camera node). Omitted means
   * the desktop and window cameras, which look straight down -z.
   */
  view?: Mat4;
  /** Eye distance at which 1 world px shows as 1 CSS px (cameraDistance(viewport height)). */
  refDistance: number;
}

/**
 * Model matrix for a label quad (the renderer's unit quad, -0.5..0.5, with
 * texture rows running down +y): faces the camera, sized to the label, and
 * for screen-space labels scaled by depth so it keeps its on-screen size.
 */
export function labelModelMatrix(p: LabelPlacement, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  // Camera axes: right = view row 0, down = view row 1 (this renderer's
  // projection flips y, so view +y is screen down), forward = view row 2.
  const v = p.view;
  const rx = v ? v[0] : 1, ry = v ? v[4] : 0, rz = v ? v[8] : 0;
  const dx = v ? v[1] : 0, dy = v ? v[5] : 1, dz = v ? v[9] : 0;
  const fx = v ? v[2] : 0, fy = v ? v[6] : 0, fz = v ? v[10] : 1;
  const [px, py, pz] = p.position;
  const depth = v
    ? -(v[2] * px + v[6] * py + v[10] * pz + v[14])
    : p.cameraPos[2] - pz;
  const s = (p.screenSpace === false ? 1 : Math.max(1e-3, depth) / Math.max(1e-3, p.refDistance)) * (p.scale ?? 1);
  const W = p.width * s, H = p.height * s;
  const ax = p.anchor?.[0] ?? 0.5, ay = p.anchor?.[1] ?? 0.5;
  const ox = (0.5 - ax) * W, oy = (0.5 - ay) * H;
  m[0] = rx * W; m[1] = ry * W; m[2] = rz * W; m[3] = 0;
  m[4] = dx * H; m[5] = dy * H; m[6] = dz * H; m[7] = 0;
  m[8] = fx; m[9] = fy; m[10] = fz; m[11] = 0;
  m[12] = px + rx * ox + dx * oy;
  m[13] = py + ry * ox + dy * oy;
  m[14] = pz + rz * ox + dz * oy;
  m[15] = 1;
  return m;
}
