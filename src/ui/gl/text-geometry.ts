/**
 * Extruded 3D text for `text` scene nodes.
 *
 * Browsers expose no glyph outlines, so the text is rasterized with a 2D
 * canvas at a high resolution, its coverage is traced back into outlines
 * (marching squares with sub-pixel edge interpolation on the antialiased
 * alpha), the outlines are simplified (Douglas-Peucker), sorted into outer
 * rings and holes by nesting, triangulated, and extruded to `depth` with an
 * optional rounded `bevel`. Any font the page can render works, including
 * web fonts once loaded (see ensureTextFont / clearTextGeometryCache).
 *
 * Output is a Geometry in px at scale 1: `size` is the font size, the text is
 * centred vertically on y = 0, placed horizontally by `align` (left edge,
 * centre, or right edge at x = 0), and spans z = -depth/2 .. +depth/2 with the
 * front face toward the viewer (+z). Results are cached by their inputs.
 * Browser only (OffscreenCanvas or a DOM canvas); returns null elsewhere.
 */

import { Geometry, extrudeShapes } from './primitives.js';
import { Vec2, classifyRings, ringArea } from './triangulate.js';
import { cssFont } from './label-texture.js';

export interface TextGeometryOptions {
  text: string;
  /** CSS font family, optionally led by style/weight words ('bold Georgia'). */
  font?: string;
  /** Font size in px [48]. */
  size?: number;
  /** Extrusion depth in px [8]. */
  depth?: number;
  /** Rounded edge size in px [0]; kept small enough for thin strokes. */
  bevel?: number;
  bevelSegments?: number;
  align?: 'left' | 'center' | 'right';
  /** Line spacing for multi-line text, as a multiple of size [1.2]. */
  lineHeight?: number;
}

export interface TextGeometryResult {
  geometry: Geometry;
  /** Extent of the laid-out text in px (advance width, line box height). */
  width: number;
  height: number;
  lines: number;
}

const MAX_TEXT_CHARS = 512;
const MAX_RASTER = 4096;
const CACHE_LIMIT = 48;
const DEFAULT_FONT = 'sans-serif';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeContext(w: number, h: number): Ctx2D | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c.getContext('2d', { willReadFrequently: true });
  }
  return null;
}

/**
 * Trace iso-contours of a scalar field (e.g. a glyph's alpha) with marching
 * squares. Samples sit at pixel centres; crossings are interpolated linearly
 * along cell edges. Every ring is closed as long as the field's border is
 * below `iso`. Returns rings in pixel coordinates, inside kept on one side.
 */
export function marchingSquares(field: ArrayLike<number>, width: number, height: number, iso: number, stride = 1, channel = 0): Vec2[][] {
  const at = (x: number, y: number) => field[(y * width + x) * stride + channel];
  const next = new Map<number, number>();
  const pos = new Map<number, Vec2>();
  const H = (x: number, y: number) => (y * width + x) * 2;
  const V = (x: number, y: number) => (y * width + x) * 2 + 1;
  const ids = [0, 0, 0, 0];
  const inside = [false, false, false, false];
  const vals = [0, 0, 0, 0];
  const cross: number[] = [];

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      vals[0] = at(x, y); vals[1] = at(x + 1, y); vals[2] = at(x + 1, y + 1); vals[3] = at(x, y + 1);
      inside[0] = vals[0] > iso; inside[1] = vals[1] > iso; inside[2] = vals[2] > iso; inside[3] = vals[3] > iso;
      if (inside[0] === inside[1] && inside[1] === inside[2] && inside[2] === inside[3]) continue;
      ids[0] = H(x, y); ids[1] = V(x + 1, y); ids[2] = H(x, y + 1); ids[3] = V(x, y);
      cross.length = 0;
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) & 3;
        if (inside[k] === inside[k1]) continue;
        cross.push(k);
        const id = ids[k];
        if (!pos.has(id)) {
          const t = (iso - vals[k]) / (vals[k1] - vals[k]);
          // Corner positions (pixel centres) in the order a, b, c, d.
          const x0 = x + 0.5 + (k === 1 || k === 2 ? 1 : 0), y0 = y + 0.5 + (k >= 2 ? 1 : 0);
          const x1 = x + 0.5 + (k1 === 1 || k1 === 2 ? 1 : 0), y1 = y + 0.5 + (k1 >= 2 ? 1 : 0);
          pos.set(id, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        }
      }
      if (cross.length === 2) {
        const [p, q] = cross;
        if (inside[p]) next.set(ids[p], ids[q]); else next.set(ids[q], ids[p]);
      } else if (cross.length === 4) {
        // Saddle: the cell centre decides which corners connect.
        const centerIn = (vals[0] + vals[1] + vals[2] + vals[3]) / 4 > iso;
        for (const k of cross) {
          if (!inside[k]) continue; // start from each in->out crossing
          const partner = centerIn ? (k + 1) & 3 : (k + 3) & 3;
          next.set(ids[k], ids[partner]);
        }
      }
    }
  }

  const rings: Vec2[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const ring: Vec2[] = [];
    let id: number | undefined = start;
    let guard = next.size + 1;
    while (id !== undefined && !visited.has(id) && guard-- > 0) {
      visited.add(id);
      ring.push(pos.get(id)!);
      id = next.get(id);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker simplification of a closed ring (iterative, no recursion). */
export function simplifyRing(ring: Vec2[], tolerance: number): Vec2[] {
  const n = ring.length;
  if (n < 4 || tolerance <= 0) return ring.slice();
  // Split at the point farthest from the first so each half is an open chain.
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const pt = (i: number) => ring[i % n];
  const tol2 = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const A = pt(a), B = pt(b);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    let idx = -1, dmax = -1;
    for (let i = a + 1; i < b; i++) {
      const P = pt(i);
      let d2: number;
      if (len2 === 0) d2 = (P[0] - A[0]) ** 2 + (P[1] - A[1]) ** 2;
      else {
        const cr = dx * (P[1] - A[1]) - dy * (P[0] - A[0]);
        d2 = (cr * cr) / len2;
      }
      if (d2 > dmax) { dmax = d2; idx = i; }
    }
    if (dmax > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

/** Everything that shapes the geometry, as a cache key. */
function textKey(o: TextGeometryOptions): string {
  return JSON.stringify([o.text, o.font ?? '', o.size ?? 48, o.depth ?? 8, o.bevel ?? 0, o.bevelSegments ?? 2, o.align ?? 'center', o.lineHeight ?? 1.2]);
}

/**
 * Trace the outlines of laid-out text. Returns rings in px (size units) with
 * the same placement as the final geometry, or null without a canvas.
 */
export function traceText(o: TextGeometryOptions): { rings: Vec2[][]; width: number; height: number; lines: number } | null {
  const text = String(o.text ?? '').slice(0, MAX_TEXT_CHARS);
  const lines = text.split('\n');
  const size = Math.max(1, Math.min(2048, o.size ?? 48));
  const align = o.align ?? 'center';
  const lineHeight = Math.max(0.5, o.lineHeight ?? 1.2);
  const probe = makeContext(8, 8);
  if (!probe) return null;

  // Raster resolution: ~128 px glyphs, reduced for long runs to fit MAX_RASTER.
  let R = 128;
  const measure = (px: number) => {
    probe.font = cssFont(o.font, px, DEFAULT_FONT);
    let w = 0, ascent = 0, descent = 0;
    for (const line of lines) {
      const m = probe.measureText(line || ' ');
      w = Math.max(w, m.width, (m.actualBoundingBoxLeft ?? 0) + (m.actualBoundingBoxRight ?? m.width));
    }
    const mm = probe.measureText('Mgjy');
    ascent = mm.fontBoundingBoxAscent ?? mm.actualBoundingBoxAscent ?? px * 0.8;
    descent = mm.fontBoundingBoxDescent ?? mm.actualBoundingBoxDescent ?? px * 0.2;
    return { w, ascent, descent };
  };
  let met = measure(R);
  const pad0 = (px: number) => Math.ceil(px * 0.15) + 2;
  const blockH = (m: { ascent: number; descent: number }, px: number) => (lines.length - 1) * lineHeight * px + m.ascent + m.descent;
  const fitW = (MAX_RASTER - 2 * pad0(R)) / Math.max(1, met.w);
  const fitH = (MAX_RASTER - 2 * pad0(R)) / Math.max(1, blockH(met, R));
  if (fitW < 1 || fitH < 1) {
    R = Math.max(16, Math.floor(R * Math.min(fitW, fitH)));
    met = measure(R);
  }
  const pad = pad0(R);
  const advance = lines.reduce((mx, l) => Math.max(mx, probe.measureText(l).width), 0);
  const W = Math.min(MAX_RASTER, Math.ceil(met.w + pad * 2));
  const bh = blockH(met, R);
  const Hh = Math.min(MAX_RASTER, Math.ceil(bh + pad * 2));
  const ctx = makeContext(W, Hh);
  if (!ctx) return null;
  ctx.clearRect(0, 0, W, Hh);
  ctx.font = cssFont(o.font, R, DEFAULT_FONT);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align;
  // Anchor so ink overhang on either side stays inside the padding.
  const ax = align === 'left' ? pad : align === 'right' ? W - pad : W / 2;
  lines.forEach((line, i) => ctx.fillText(line, ax, pad + met.ascent + i * lineHeight * R));
  const img = ctx.getImageData(0, 0, W, Hh);

  const k = size / R;
  const originY = pad + bh / 2;
  const tol = 0.3;
  const rings: Vec2[][] = [];
  for (const raw of marchingSquares(img.data, W, Hh, 127.5, 4, 3)) {
    if (Math.abs(ringArea(raw)) < 1.5) continue; // speckle
    const simple = simplifyRing(raw, tol);
    if (simple.length < 3) continue;
    rings.push(simple.map(([x, y]) => [(x - ax) * k, (y - originY) * k] as Vec2));
  }
  return { rings, width: advance * k, height: bh * k, lines: lines.length };
}

/** Build (uncached) extruded text geometry. */
export function buildTextGeometry(o: TextGeometryOptions): TextGeometryResult | null {
  const traced = traceText(o);
  if (!traced) return null;
  const size = Math.max(1, Math.min(2048, o.size ?? 48));
  const depth = Math.max(0, o.depth ?? 8);
  // Keep the bevel inside thin strokes (hairlines are ~5% of the size).
  const bevel = Math.max(0, Math.min(o.bevel ?? 0, depth / 2, size * 0.04));
  const shapes = classifyRings(traced.rings);
  const geometry = extrudeShapes(shapes, { depth, bevel, bevelSegments: o.bevelSegments ?? 2, smoothAngle: (40 * Math.PI) / 180 });
  return { geometry, width: traced.width, height: traced.height, lines: traced.lines };
}

const cache = new Map<string, TextGeometryResult>();

/**
 * Extruded text geometry, cached by (text, font, size, depth, bevel, align,
 * lineHeight). The same inputs return the same Geometry instance, so the
 * renderer's VAO cache holds too. Null where no canvas is available.
 */
export function getTextGeometry(o: TextGeometryOptions): TextGeometryResult | null {
  const key = textKey(o);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const built = buildTextGeometry(o);
  if (!built) return null;
  cache.set(key, built);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return built;
}

/** Forget cached text (call when a web font finishes loading so text re-traces with it). */
export function clearTextGeometryCache(): void {
  cache.clear();
}

/**
 * Resolve once `font` is loaded and usable (or immediately where the Font
 * Loading API is absent). Text traced before its font loads uses a fallback
 * face; re-request it after this resolves (and clear the cache).
 */
export async function ensureTextFont(font: string | undefined, size = 48): Promise<boolean> {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts
    ?? (globalThis as { fonts?: FontFaceSet }).fonts;
  if (!fonts) return true;
  const css = cssFont(font, size, DEFAULT_FONT);
  try {
    await fonts.load(css);
    return fonts.check(css);
  } catch {
    return false;
  }
}
