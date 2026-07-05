/**
 * ChartWidget: declarative data visualization for the themed desktop.
 *
 * One spec renders a line, bar, area, pie (donut), or sparkline chart from
 * plain series data; no canvas draw commands required from the owner. All
 * colors derive from the active theme so charts stay on-palette across theme
 * changes. Scales, ticks, and layout recompute on every update, so owners
 * bind live data (a SQL query result, a stream of samples) with plain
 * this.call(id, 'update', { series }).
 *
 * Events:
 *   pointClicked: JSON { seriesIndex, pointIndex, x, y } when a click lands
 *   on (within 8px of) a point, bar, or pie slice.
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { BODY_FONT_STACK, withAlpha } from './widget-types.js';

export type ChartKind = 'line' | 'bar' | 'area' | 'pie' | 'sparkline';

export interface ChartPoint {
  x: number | string;
  y: number;
}

export interface ChartSeriesSpec {
  name?: string;
  points: ChartPoint[];
  color?: string;
}

export interface ChartWidgetConfig extends WidgetConfig {
  kind?: ChartKind;
  series?: ChartSeriesSpec[];
  xLabel?: string;
  yLabel?: string;
  showLegend?: boolean;
  showGrid?: boolean;
  yMin?: number;
  yMax?: number;
}

const TICK_FONT_SIZE = 11;
const AXIS_GAP = 6;
const LEGEND_H = 18;
const LABEL_H = 15;

/** Approximate glyph width for layout estimation (avoids async measureText). */
function estWidth(text: string, fontSize = TICK_FONT_SIZE): number {
  return text.length * fontSize * 0.58;
}

/** Round a raw span to a 1/2/5 * 10^n "nice" number. */
function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice: number;
  if (round) {
    nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  } else {
    nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  }
  return nice * Math.pow(10, exp);
}

/** Nice tick positions spanning [min, max] with at most maxTicks entries. */
function niceTicks(min: number, max: number, maxTicks = 5): { lo: number; hi: number; ticks: number[] } {
  if (min === max) {
    if (min === 0) { min = 0; max = 1; }
    else { const pad = Math.abs(min) * 0.1; min -= pad; max += pad; }
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (maxTicks - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step * 0.5; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return { lo, hi, ticks };
}

function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trimNum(v / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimNum(v / 1_000)}k`;
  return trimNum(v);
}

function trimNum(v: number): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return s.replace(/\.?0+$/, '');
}

interface PointHit { sx: number; sy: number; seriesIndex: number; pointIndex: number; x: number | string; y: number }
interface BarHit { bx: number; by: number; bw: number; bh: number; seriesIndex: number; pointIndex: number; x: number | string; y: number }
interface SliceHit { a0: number; a1: number; rIn: number; rOut: number; cx: number; cy: number; seriesIndex: number; pointIndex: number; x: number | string; y: number }

export class ChartWidget extends WidgetAbject {
  private kind: ChartKind;
  private series: ChartSeriesSpec[];
  private xLabel?: string;
  private yLabel?: string;
  private showLegend: boolean;
  private showGrid?: boolean;
  private yMin?: number;
  private yMax?: number;

  // Hit regions captured during the last draw, in widget-local coordinates.
  private pointHits: PointHit[] = [];
  private barHits: BarHit[] = [];
  private sliceHits: SliceHit[] = [];

  constructor(config: ChartWidgetConfig) {
    super(config);
    this.kind = config.kind ?? 'line';
    this.series = config.series ?? [];
    this.xLabel = config.xLabel;
    this.yLabel = config.yLabel;
    this.showLegend = config.showLegend ?? false;
    this.showGrid = config.showGrid;
    this.yMin = config.yMin;
    this.yMax = config.yMax;
  }

  /** Theme-derived color ramp; per-series color overrides win. */
  private seriesColor(i: number, override?: string): string {
    if (override) return override;
    const ramp = [
      this.theme.accent,
      this.theme.statusSuccess,
      this.theme.statusWarning,
      this.theme.statusError,
      this.theme.linkColor,
      this.theme.statusNeutral,
    ];
    return ramp[i % ramp.length];
  }

  private gridOn(): boolean {
    return this.showGrid ?? (this.kind !== 'sparkline' && this.kind !== 'pie');
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this._renderRect.width;
    const h = this._renderRect.height;
    this.pointHits = [];
    this.barHits = [];
    this.sliceHits = [];
    if (w <= 4 || h <= 4) return commands;

    const style = this._renderStyle;
    if (style.background && style.background !== 'transparent') {
      commands.push({
        type: 'rect', surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill: style.background, radius: style.radius ?? this.theme.widgetRadius },
      });
    }

    const hasData = this.series.some(s => s.points && s.points.length > 0);
    if (!hasData) {
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: ox + w / 2, y: oy + h / 2, text: 'no data',
          font: `${TICK_FONT_SIZE}px ${BODY_FONT_STACK}`,
          fill: this.theme.textTertiary, align: 'center', baseline: 'middle',
        },
      });
      return commands;
    }

    if (this.kind === 'pie') {
      this.buildPie(commands, surfaceId, ox, oy, w, h);
      return commands;
    }
    if (this.kind === 'sparkline') {
      this.buildSparkline(commands, surfaceId, ox, oy, w, h);
      return commands;
    }
    this.buildCartesian(commands, surfaceId, ox, oy, w, h);
    return commands;
  }

  // ── Cartesian (line / area / bar) ─────────────────────────────────────

  private buildCartesian(commands: unknown[], surfaceId: string, ox: number, oy: number, w: number, h: number): void {
    const tickFont = `${TICK_FONT_SIZE}px ${BODY_FONT_STACK}`;
    const textSub = this.theme.textSecondary;

    // Categorical when any x is a string; band positions in first-seen order.
    const categorical = this.series.some(s => s.points.some(p => typeof p.x === 'string'));
    const categories: string[] = [];
    if (categorical) {
      for (const s of this.series) {
        for (const p of s.points) {
          const key = String(p.x);
          if (!categories.includes(key)) categories.push(key);
        }
      }
    }

    // Y domain: data extent, zero included for bar/area, caller overrides win.
    let dMin = Infinity, dMax = -Infinity;
    for (const s of this.series) {
      for (const p of s.points) {
        if (Number.isFinite(p.y)) { dMin = Math.min(dMin, p.y); dMax = Math.max(dMax, p.y); }
      }
    }
    if (!Number.isFinite(dMin)) { dMin = 0; dMax = 1; }
    if (this.kind === 'bar' || this.kind === 'area') { dMin = Math.min(dMin, 0); dMax = Math.max(dMax, 0); }
    const { lo, hi, ticks } = niceTicks(this.yMin ?? dMin, this.yMax ?? dMax, 5);

    // X domain (numeric mode).
    let xLo = 0, xHi = 1;
    if (!categorical) {
      xLo = Infinity; xHi = -Infinity;
      for (const s of this.series) {
        for (const p of s.points) {
          const xv = p.x as number;
          if (Number.isFinite(xv)) { xLo = Math.min(xLo, xv); xHi = Math.max(xHi, xv); }
        }
      }
      if (!Number.isFinite(xLo)) { xLo = 0; xHi = 1; }
      if (xLo === xHi) { xLo -= 1; xHi += 1; }
    }

    // Layout. Left gutter fits the widest tick label; bottom stacks x ticks,
    // an optional axis label, and an optional legend row.
    const tickLabels = ticks.map(formatTick);
    const yGutter = Math.max(...tickLabels.map(t => estWidth(t))) + AXIS_GAP + 4 + (this.yLabel ? LABEL_H : 0);
    const namedSeries = this.series.filter(s => s.name);
    const legendOn = this.showLegend && namedSeries.length > 1;

    let rotateTicks = false;
    let xTickH = LABEL_H + 3;
    const plotWGuess = Math.max(10, w - yGutter - 10);
    if (categorical) {
      const band = plotWGuess / Math.max(1, categories.length);
      const maxLabelW = Math.max(...categories.map(c => estWidth(c)));
      rotateTicks = maxLabelW > band - 6;
      if (rotateTicks) xTickH = 34;
    }
    const bottomH = xTickH + (this.xLabel ? LABEL_H : 0) + (legendOn ? LEGEND_H : 0);
    const px = yGutter;            // plot origin, widget-local
    const py = 8;
    const pw = Math.max(10, w - px - 10);
    const ph = Math.max(10, h - py - bottomH);

    const yPos = (v: number) => py + ph - ((v - lo) / (hi - lo)) * ph;
    const xPosNum = (v: number) => px + ((v - xLo) / (xHi - xLo)) * pw;
    const band = pw / Math.max(1, categories.length);
    const xPosCat = (i: number) => px + band * i + band / 2;

    // Grid + y ticks.
    for (let i = 0; i < ticks.length; i++) {
      const ty = yPos(ticks[i]);
      if (this.gridOn()) {
        commands.push({
          type: 'line', surfaceId,
          params: { x1: ox + px, y1: oy + ty, x2: ox + px + pw, y2: oy + ty, stroke: withAlpha(this.theme.textTertiary, 0.15), lineWidth: 1 },
        });
      }
      commands.push({
        type: 'text', surfaceId,
        params: { x: ox + px - AXIS_GAP, y: oy + ty, text: tickLabels[i], font: tickFont, fill: textSub, align: 'right', baseline: 'middle' },
      });
    }
    // Baseline.
    const baseY = yPos(Math.max(lo, Math.min(hi, 0)));
    commands.push({
      type: 'line', surfaceId,
      params: { x1: ox + px, y1: oy + baseY, x2: ox + px + pw, y2: oy + baseY, stroke: withAlpha(this.theme.textTertiary, 0.4), lineWidth: 1 },
    });

    // X ticks.
    if (categorical) {
      for (let i = 0; i < categories.length; i++) {
        const cx = xPosCat(i);
        let label = categories[i];
        if (rotateTicks) {
          if (estWidth(label) > 60) label = label.slice(0, Math.max(1, Math.floor(60 / (TICK_FONT_SIZE * 0.58)))) + '…';
          commands.push({ type: 'save', surfaceId, params: {} });
          commands.push({ type: 'translate', surfaceId, params: { x: ox + cx, y: oy + py + ph + 4 } });
          commands.push({ type: 'rotate', surfaceId, params: { angle: -Math.PI * 35 / 180 } });
          commands.push({
            type: 'text', surfaceId,
            params: { x: 0, y: 0, text: label, font: tickFont, fill: textSub, align: 'right', baseline: 'top' },
          });
          commands.push({ type: 'restore', surfaceId, params: {} });
        } else {
          if (estWidth(label) > band - 4) label = label.slice(0, Math.max(1, Math.floor((band - 8) / (TICK_FONT_SIZE * 0.58)))) + '…';
          commands.push({
            type: 'text', surfaceId,
            params: { x: ox + cx, y: oy + py + ph + 4, text: label, font: tickFont, fill: textSub, align: 'center', baseline: 'top' },
          });
        }
      }
    } else {
      const xTicks = niceTicks(xLo, xHi, 5).ticks.filter(t => t >= xLo && t <= xHi);
      for (const t of xTicks) {
        commands.push({
          type: 'text', surfaceId,
          params: { x: ox + xPosNum(t), y: oy + py + ph + 4, text: formatTick(t), font: tickFont, fill: textSub, align: 'center', baseline: 'top' },
        });
      }
    }

    // Axis labels.
    if (this.xLabel) {
      commands.push({
        type: 'text', surfaceId,
        params: { x: ox + px + pw / 2, y: oy + py + ph + xTickH + 2, text: this.xLabel, font: tickFont, fill: textSub, align: 'center', baseline: 'top' },
      });
    }
    if (this.yLabel) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'translate', surfaceId, params: { x: ox + 11, y: oy + py + ph / 2 } });
      commands.push({ type: 'rotate', surfaceId, params: { angle: -Math.PI / 2 } });
      commands.push({
        type: 'text', surfaceId,
        params: { x: 0, y: 0, text: this.yLabel, font: tickFont, fill: textSub, align: 'center', baseline: 'middle' },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Series.
    if (this.kind === 'bar') {
      const nSeries = Math.max(1, this.series.length);
      for (let si = 0; si < this.series.length; si++) {
        const s = this.series[si];
        const color = this.seriesColor(si, s.color);
        for (let pi = 0; pi < s.points.length; pi++) {
          const p = s.points[pi];
          if (!Number.isFinite(p.y)) continue;
          const ci = categorical ? categories.indexOf(String(p.x)) : pi;
          const groupW = (categorical ? band : pw / Math.max(1, s.points.length)) * 0.7;
          const barW = Math.max(2, groupW / nSeries - 2);
          const center = categorical ? xPosCat(ci) : xPosNum(p.x as number);
          const bx = center - groupW / 2 + si * (groupW / nSeries) + 1;
          const vy = yPos(Math.max(lo, Math.min(hi, p.y)));
          const by = Math.min(vy, baseY);
          const bh = Math.max(1, Math.abs(baseY - vy));
          commands.push({
            type: 'rect', surfaceId,
            params: { x: ox + bx, y: oy + by, width: barW, height: bh, fill: color, radius: 2 },
          });
          this.barHits.push({ bx, by, bw: barW, bh, seriesIndex: si, pointIndex: pi, x: p.x, y: p.y });
        }
      }
    } else {
      // line / area
      for (let si = 0; si < this.series.length; si++) {
        const s = this.series[si];
        const color = this.seriesColor(si, s.color);
        const pts: Array<{ x: number; y: number }> = [];
        for (let pi = 0; pi < s.points.length; pi++) {
          const p = s.points[pi];
          if (!Number.isFinite(p.y)) continue;
          const sx = categorical ? xPosCat(categories.indexOf(String(p.x))) : xPosNum(p.x as number);
          const sy = yPos(Math.max(lo, Math.min(hi, p.y)));
          pts.push({ x: sx, y: sy });
          this.pointHits.push({ sx, sy, seriesIndex: si, pointIndex: pi, x: p.x, y: p.y });
        }
        if (pts.length === 0) continue;
        if (this.kind === 'area' && pts.length >= 2) {
          const areaPts = [
            { x: ox + pts[0].x, y: oy + baseY },
            ...pts.map(p => ({ x: ox + p.x, y: oy + p.y })),
            { x: ox + pts[pts.length - 1].x, y: oy + baseY },
          ];
          commands.push({
            type: 'polygon', surfaceId,
            params: { points: areaPts, fill: withAlpha(color, 0.18) },
          });
        }
        if (pts.length === 1) {
          commands.push({ type: 'circle', surfaceId, params: { cx: ox + pts[0].x, cy: oy + pts[0].y, radius: 3, fill: color } });
        } else {
          commands.push({
            type: 'polygon', surfaceId,
            params: {
              points: pts.map(p => ({ x: ox + p.x, y: oy + p.y })),
              closePath: false, stroke: color, lineWidth: 2, lineJoin: 'round', lineCap: 'round',
            },
          });
          if (pts.length <= 40) {
            for (const p of pts) {
              commands.push({ type: 'circle', surfaceId, params: { cx: ox + p.x, cy: oy + p.y, radius: 2.5, fill: color } });
            }
          }
        }
      }
    }

    // Legend row.
    if (legendOn) {
      let lx = px;
      const ly = py + ph + xTickH + (this.xLabel ? LABEL_H : 0) + 4;
      for (let si = 0; si < this.series.length; si++) {
        const s = this.series[si];
        if (!s.name) continue;
        const color = this.seriesColor(si, s.color);
        const itemW = 14 + estWidth(s.name) + 12;
        if (lx + itemW > px + pw) break;
        commands.push({ type: 'rect', surfaceId, params: { x: ox + lx, y: oy + ly, width: 10, height: 10, fill: color, radius: 2 } });
        commands.push({
          type: 'text', surfaceId,
          params: { x: ox + lx + 14, y: oy + ly + 5, text: s.name, font: tickFont, fill: textSub, align: 'left', baseline: 'middle' },
        });
        lx += itemW;
      }
    }
  }

  // ── Pie (donut) ───────────────────────────────────────────────────────

  private buildPie(commands: unknown[], surfaceId: string, ox: number, oy: number, w: number, h: number): void {
    const tickFont = `${TICK_FONT_SIZE}px ${BODY_FONT_STACK}`;
    const s = this.series[0];
    const slices = s.points.filter(p => Number.isFinite(p.y) && p.y > 0);
    const total = slices.reduce((acc, p) => acc + p.y, 0);
    if (total <= 0 || slices.length === 0) return;

    const namedLegend = this.showLegend && slices.length > 1;
    const legendH = namedLegend ? LEGEND_H : 0;
    const cx = w / 2;
    const cy = (h - legendH) / 2;
    const rOut = Math.max(8, Math.min(w, h - legendH) / 2 - 18);
    const rIn = rOut * 0.55;

    let angle = -Math.PI / 2;
    for (let pi = 0; pi < slices.length; pi++) {
      const p = slices[pi];
      const frac = p.y / total;
      const a0 = angle;
      const a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const color = this.seriesColor(pi, undefined);

      // Donut slice as an arc-approximated ring polygon (outer sweep forward,
      // inner sweep back), which needs no path punch-out support.
      const step = Math.PI / 45; // 4 degree segments
      const points: Array<{ x: number; y: number }> = [];
      for (let a = a0; a < a1; a += step) points.push({ x: ox + cx + Math.cos(a) * rOut, y: oy + cy + Math.sin(a) * rOut });
      points.push({ x: ox + cx + Math.cos(a1) * rOut, y: oy + cy + Math.sin(a1) * rOut });
      for (let a = a1; a > a0; a -= step) points.push({ x: ox + cx + Math.cos(a) * rIn, y: oy + cy + Math.sin(a) * rIn });
      points.push({ x: ox + cx + Math.cos(a0) * rIn, y: oy + cy + Math.sin(a0) * rIn });
      commands.push({ type: 'polygon', surfaceId, params: { points, fill: color } });

      if (frac > 0.08) {
        const mid = (a0 + a1) / 2;
        const lx = cx + Math.cos(mid) * (rOut + 8);
        const ly = cy + Math.sin(mid) * (rOut + 8);
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + lx, y: oy + ly, text: `${Math.round(frac * 100)}%`,
            font: tickFont, fill: this.theme.textSecondary,
            align: Math.cos(mid) >= 0 ? 'left' : 'right', baseline: 'middle',
          },
        });
      }
      this.sliceHits.push({ a0, a1, rIn, rOut, cx, cy, seriesIndex: 0, pointIndex: s.points.indexOf(p), x: p.x, y: p.y });
    }

    if (namedLegend) {
      let lx = 8;
      const ly = h - LEGEND_H + 4;
      for (let pi = 0; pi < slices.length; pi++) {
        const name = String(slices[pi].x);
        const itemW = 14 + estWidth(name) + 12;
        if (lx + itemW > w - 8) break;
        commands.push({ type: 'rect', surfaceId, params: { x: ox + lx, y: oy + ly, width: 10, height: 10, fill: this.seriesColor(pi), radius: 2 } });
        commands.push({
          type: 'text', surfaceId,
          params: { x: ox + lx + 14, y: oy + ly + 5, text: name, font: tickFont, fill: this.theme.textSecondary, align: 'left', baseline: 'middle' },
        });
        lx += itemW;
      }
    }
  }

  // ── Sparkline ─────────────────────────────────────────────────────────

  private buildSparkline(commands: unknown[], surfaceId: string, ox: number, oy: number, w: number, h: number): void {
    const s = this.series[0];
    const pts = s.points.filter(p => Number.isFinite(p.y));
    if (pts.length === 0) return;
    const color = this.seriesColor(0, s.color);

    let lo = Math.min(...pts.map(p => p.y));
    let hi = Math.max(...pts.map(p => p.y));
    if (lo === hi) { lo -= 1; hi += 1; }
    if (this.yMin !== undefined) lo = this.yMin;
    if (this.yMax !== undefined) hi = this.yMax;

    const padY = 3;
    const stepX = pts.length > 1 ? (w - 8) / (pts.length - 1) : 0;
    const screen = pts.map((p, i) => ({
      x: 4 + i * stepX,
      y: padY + (h - padY * 2) * (1 - (p.y - lo) / (hi - lo)),
    }));
    for (let i = 0; i < pts.length; i++) {
      this.pointHits.push({ sx: screen[i].x, sy: screen[i].y, seriesIndex: 0, pointIndex: i, x: pts[i].x, y: pts[i].y });
    }
    if (screen.length > 1) {
      commands.push({
        type: 'polygon', surfaceId,
        params: {
          points: screen.map(p => ({ x: ox + p.x, y: oy + p.y })),
          closePath: false, stroke: color, lineWidth: 1.5, lineJoin: 'round', lineCap: 'round',
        },
      });
    }
    const last = screen[screen.length - 1];
    commands.push({ type: 'circle', surfaceId, params: { cx: ox + last.x, cy: oy + last.y, radius: 2.5, fill: color } });
  }

  // ── Input ─────────────────────────────────────────────────────────────

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type !== 'mousedown') return { consumed: false };
    const mx = input.x as number;
    const my = input.y as number;

    for (const hit of this.pointHits) {
      const dx = mx - hit.sx, dy = my - hit.sy;
      if (dx * dx + dy * dy <= 64) {
        this.changed('pointClicked', JSON.stringify({ seriesIndex: hit.seriesIndex, pointIndex: hit.pointIndex, x: hit.x, y: hit.y }));
        return { consumed: true };
      }
    }
    for (const hit of this.barHits) {
      if (mx >= hit.bx - 2 && mx <= hit.bx + hit.bw + 2 && my >= hit.by - 2 && my <= hit.by + hit.bh + 2) {
        this.changed('pointClicked', JSON.stringify({ seriesIndex: hit.seriesIndex, pointIndex: hit.pointIndex, x: hit.x, y: hit.y }));
        return { consumed: true };
      }
    }
    for (const hit of this.sliceHits) {
      const dx = mx - hit.cx, dy = my - hit.cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < hit.rIn - 4 || r > hit.rOut + 4) continue;
      let a = Math.atan2(dy, dx);
      // Slice angles run from -PI/2 without normalization; bring the click
      // angle into the same continuous range.
      while (a < -Math.PI / 2) a += Math.PI * 2;
      if (a >= hit.a0 && a <= hit.a1) {
        this.changed('pointClicked', JSON.stringify({ seriesIndex: hit.seriesIndex, pointIndex: hit.pointIndex, x: hit.x, y: hit.y }));
        return { consumed: true };
      }
    }
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return '';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.kind !== undefined) this.kind = updates.kind as ChartKind;
    if (updates.series !== undefined && Array.isArray(updates.series)) this.series = updates.series as ChartSeriesSpec[];
    if (updates.xLabel !== undefined) this.xLabel = updates.xLabel as string;
    if (updates.yLabel !== undefined) this.yLabel = updates.yLabel as string;
    if (updates.showLegend !== undefined) this.showLegend = !!updates.showLegend;
    if (updates.showGrid !== undefined) this.showGrid = !!updates.showGrid;
    if (updates.yMin !== undefined) this.yMin = updates.yMin as number;
    if (updates.yMax !== undefined) this.yMax = updates.yMax as number;
    this.pointHits = [];
    this.barHits = [];
    this.sliceHits = [];
  }
}
