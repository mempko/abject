/**
 * Vector icon system for Abjects UI.
 *
 * Each icon emits an array of draw commands within an `(x, y, size, size)`
 * bounding box. Callers append the result to their own draw batch, so icons
 * compose with whatever surface a widget is rendering to.
 *
 * Icons are rendered with stroke or fill in the supplied color; line widths
 * scale with size. For pixel-perfect rendering, prefer multiples of 4 px.
 */

export type IconName =
  | 'close'
  | 'minimize'
  | 'restore'
  | 'maximize'
  | 'resize'
  | 'send'
  | 'search'
  | 'plus'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight'
  | 'check'
  | 'warning'
  | 'info'
  | 'help'
  | 'dot'
  | 'clock'
  // Geometric launcher set (dock rows): built from squares, circles,
  // triangles and bars so they read at 14-16 px.
  | 'chat'
  | 'users'
  | 'target'
  | 'list'
  | 'brain'
  | 'agent'
  | 'calendar'
  | 'globe'
  | 'network'
  | 'folder'
  | 'folderOpen'
  | 'gear'
  | 'eye'
  | 'bell'
  | 'lock'
  | 'grid'
  | 'diamond'
  | 'activity';

export interface IconDrawOpts {
  surfaceId: string;
  /** Top-left x of the icon's bounding box. */
  x: number;
  /** Top-left y of the icon's bounding box. */
  y: number;
  /** Side length of the (square) icon. */
  size: number;
  color: string;
  /** Override stroke width. Default scales with size: max(1.25, size/12). */
  lineWidth?: number;
  /**
   * Stroke ends and joins. 'round' (default) is the soft classic look;
   * 'square' renders square caps and miter joins for hard-edged themes.
   */
  caps?: 'round' | 'square';
}

type Cmd = { type: string; surfaceId: string; params: Record<string, unknown> };

/**
 * Emit draw commands for the named icon within the given bounding box.
 * Returns an empty array for unknown icon names so callers don't need to guard.
 */
export function iconCommands(name: IconName, opts: IconDrawOpts): Cmd[] {
  const renderer = ICONS[name];
  if (!renderer) return [];
  const cmds = renderer(opts);
  return opts.caps === 'square' ? cmds.map(squareOff) : cmds;
}

/** Rewrite a command's stroke ends and joins to square caps + miter joins. */
function squareOff(cmd: Cmd): Cmd {
  const p = cmd.params;
  if (p.stroke === undefined) return cmd;
  const next: Record<string, unknown> = { ...p };
  if (p.lineCap === 'round' || (cmd.type === 'line' && p.lineCap === undefined)) next.lineCap = 'square';
  if (cmd.type === 'polygon' || cmd.type === 'rect' || p.lineJoin !== undefined) next.lineJoin = 'miter';
  return { ...cmd, params: next };
}

const defaultLineWidth = (size: number) => Math.max(1.25, size / 12);

const line = (
  surfaceId: string,
  x1: number, y1: number, x2: number, y2: number,
  stroke: string, lineWidth: number,
  cap: 'round' | 'butt' | 'square' = 'round',
): Cmd => ({
  type: 'line',
  surfaceId,
  params: { x1, y1, x2, y2, stroke, lineWidth, lineCap: cap },
});

const circle = (
  surfaceId: string,
  cx: number, cy: number, radius: number,
  fill?: string, stroke?: string, lineWidth = 1,
): Cmd => ({
  type: 'circle',
  surfaceId,
  params: { cx, cy, radius, fill, stroke, lineWidth },
});

const rect = (
  surfaceId: string,
  x: number, y: number, width: number, height: number,
  stroke: string, lineWidth: number, radius = 0,
): Cmd => ({
  type: 'rect',
  surfaceId,
  params: { x, y, width, height, stroke, lineWidth, radius },
});

const polygon = (
  surfaceId: string,
  points: Array<{ x: number; y: number }>,
  fill: string,
): Cmd => ({
  type: 'polygon',
  surfaceId,
  params: { points, fill, closePath: true },
});

const filledRect = (
  surfaceId: string,
  x: number, y: number, width: number, height: number,
  fill: string,
): Cmd => ({
  type: 'rect',
  surfaceId,
  params: { x, y, width, height, fill },
});

const polyline = (
  surfaceId: string,
  points: Array<{ x: number; y: number }>,
  stroke: string, lineWidth: number, closePath: boolean,
): Cmd => ({
  type: 'polygon',
  surfaceId,
  params: { points, stroke, lineWidth, lineCap: 'round', lineJoin: 'round', closePath },
});

type Renderer = (opts: IconDrawOpts) => Cmd[];

const closeIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const inset = size * 0.28;
  const x1 = x + inset, y1 = y + inset;
  const x2 = x + size - inset, y2 = y + size - inset;
  return [
    line(surfaceId, x1, y1, x2, y2, color, lw),
    line(surfaceId, x2, y1, x1, y2, color, lw),
  ];
};

const minimizeIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const inset = size * 0.28;
  const cy = y + size * 0.6; // sits slightly below center to read as "underline"
  return [
    line(surfaceId, x + inset, cy, x + size - inset, cy, color, lw),
  ];
};

const restoreIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const s = size * 0.5;
  const off = size * 0.18;
  return [
    rect(surfaceId, x + off + s * 0.18, y + off - s * 0.18, s, s, color, lw),
    rect(surfaceId, x + off, y + off, s, s, color, lw),
  ];
};

const maximizeIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const inset = size * 0.25;
  return [
    rect(surfaceId, x + inset, y + inset, size - inset * 2, size - inset * 2, color, lw),
  ];
};

const resizeIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  // Three diagonal dashes in the bottom-right corner of the box
  const x1 = x + size * 0.95, y1 = y + size * 0.6;
  const x2 = x + size * 0.6,  y2 = y + size * 0.95;
  return [
    line(surfaceId, x1, y1, x2, y2, color, lw),
    line(surfaceId, x + size * 0.95, y + size * 0.78, x + size * 0.78, y + size * 0.95, color, lw),
    line(surfaceId, x + size * 0.95, y + size * 0.92, x + size * 0.92, y + size * 0.95, color, lw),
  ];
};

const sendIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  // Paper plane: a triangle pointing right, with a notch on the left edge
  const pad = size * 0.12;
  return [
    polygon(surfaceId, [
      { x: x + pad,            y: y + pad },
      { x: x + size - pad,     y: y + size * 0.5 },
      { x: x + pad,            y: y + size - pad },
      { x: x + size * 0.32,    y: y + size * 0.5 },
    ], color),
  ];
};

const searchIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const r = size * 0.28;
  const cx = x + size * 0.42;
  const cy = y + size * 0.42;
  const handleStartX = cx + r * 0.7;
  const handleStartY = cy + r * 0.7;
  const handleEndX = x + size - size * 0.18;
  const handleEndY = y + size - size * 0.18;
  return [
    circle(surfaceId, cx, cy, r, undefined, color, lw),
    line(surfaceId, handleStartX, handleStartY, handleEndX, handleEndY, color, lw),
  ];
};

const plusIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const inset = size * 0.25;
  const cx = x + size / 2;
  const cy = y + size / 2;
  return [
    line(surfaceId, x + inset, cy, x + size - inset, cy, color, lw),
    line(surfaceId, cx, y + inset, cx, y + size - inset, color, lw),
  ];
};

function chevron(direction: 'down' | 'up' | 'left' | 'right'): Renderer {
  return ({ surfaceId, x, y, size, color, lineWidth }) => {
    const lw = lineWidth ?? defaultLineWidth(size);
    const cx = x + size / 2;
    const cy = y + size / 2;
    const r = size * 0.28;
    const points = (() => {
      switch (direction) {
        case 'down':  return [{ x: cx - r, y: cy - r * 0.5 }, { x: cx, y: cy + r * 0.5 }, { x: cx + r, y: cy - r * 0.5 }];
        case 'up':    return [{ x: cx - r, y: cy + r * 0.5 }, { x: cx, y: cy - r * 0.5 }, { x: cx + r, y: cy + r * 0.5 }];
        case 'left':  return [{ x: cx + r * 0.5, y: cy - r }, { x: cx - r * 0.5, y: cy }, { x: cx + r * 0.5, y: cy + r }];
        case 'right': return [{ x: cx - r * 0.5, y: cy - r }, { x: cx + r * 0.5, y: cy }, { x: cx - r * 0.5, y: cy + r }];
      }
    })();
    return [
      {
        type: 'polygon',
        surfaceId,
        params: { points, stroke: color, lineWidth: lw, lineCap: 'round', lineJoin: 'round', closePath: false },
      },
    ];
  };
}

const checkIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size) * 1.1;
  return [
    {
      type: 'polygon',
      surfaceId,
      params: {
        points: [
          { x: x + size * 0.22, y: y + size * 0.55 },
          { x: x + size * 0.42, y: y + size * 0.75 },
          { x: x + size * 0.78, y: y + size * 0.32 },
        ],
        stroke: color,
        lineWidth: lw,
        lineCap: 'round',
        lineJoin: 'round',
        closePath: false,
      },
    },
  ];
};

const warningIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const apex = { x: x + size / 2, y: y + size * 0.16 };
  const left = { x: x + size * 0.1, y: y + size * 0.86 };
  const right = { x: x + size * 0.9, y: y + size * 0.86 };
  const cx = x + size / 2;
  return [
    {
      type: 'polygon',
      surfaceId,
      params: { points: [apex, right, left], stroke: color, lineWidth: lw, lineJoin: 'round', closePath: true },
    },
    line(surfaceId, cx, y + size * 0.42, cx, y + size * 0.65, color, lw),
    circle(surfaceId, cx, y + size * 0.76, lw * 0.8, color),
  ];
};

const infoIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.42;
  return [
    circle(surfaceId, cx, cy, r, undefined, color, lw),
    circle(surfaceId, cx, cy - r * 0.45, lw * 0.85, color),
    line(surfaceId, cx, cy - r * 0.1, cx, cy + r * 0.55, color, lw),
  ];
};

const helpIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  // Slightly thinner stroke and a compact glyph so the "?" reads at the same
  // visual weight as the close (×) and minimize (−) icons, which only span the
  // middle of the box. A question mark stacks a bowl + stem + dot, so it must
  // be drawn tighter to avoid looking oversized next to them.
  const lw = (lineWidth ?? defaultLineWidth(size)) * 0.9;
  const cx = x + size / 2;
  const r = size * 0.16;
  const top = y + size * 0.4;
  // The hook of the question mark: an open polyline tracing the upper bowl
  // down into the vertical stem, then a separate dot for the point below.
  return [
    {
      type: 'polygon',
      surfaceId,
      params: {
        points: [
          { x: cx - r,        y: top - r * 0.35 },
          { x: cx - r * 0.45, y: top - r },
          { x: cx + r * 0.55, y: top - r * 0.9 },
          { x: cx + r,        y: top - r * 0.05 },
          { x: cx + r * 0.1,  y: top + r * 0.6 },
          { x: cx,            y: top + r },
        ],
        stroke: color,
        lineWidth: lw,
        lineCap: 'round',
        lineJoin: 'round',
        closePath: false,
      },
    },
    circle(surfaceId, cx, y + size * 0.7, lw * 0.8, color),
  ];
};

const dotIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  return [circle(surfaceId, x + size / 2, y + size / 2, size * 0.18, color)];
};

/**
 * A clock face: the "waiting on something else" state, which needs to read
 * differently at a glance from "queued" (a dot) and "running" (a chevron).
 */
const clockIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.36;
  const lw = Math.max(1, size * 0.08);
  return [
    circle(surfaceId, cx, cy, r, undefined, color, lw),
    // Hands at roughly 10:10, which reads as a clock at small sizes better
    // than any vertical/horizontal pair does.
    line(surfaceId, cx, cy, cx, cy - r * 0.55, color, lw),
    line(surfaceId, cx, cy, cx + r * 0.45, cy + r * 0.2, color, lw),
  ];
};

// ── Geometric launcher set ──────────────────────────────────────────────
// Each glyph is a small composition of solid primitives (squares, circles,
// triangles, bars) in the spirit of a Constructivist poster: few shapes,
// heavy weights, readable at 14-16 px. Coordinates are fractions of `size`.

/** Map fractional box coordinates to absolute ones for a renderer. */
const at = (x: number, y: number, size: number) => (fx: number, fy: number) => ({ x: x + size * fx, y: y + size * fy });

const chatIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  const p = at(x, y, size);
  return [
    filledRect(surfaceId, x + size * 0.14, y + size * 0.18, size * 0.72, size * 0.48, color),
    polygon(surfaceId, [p(0.24, 0.64), p(0.48, 0.64), p(0.24, 0.88)], color),
  ];
};

const usersIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  return [
    // Rear figure (right), then the front figure overlapping it.
    circle(surfaceId, x + size * 0.68, y + size * 0.3, size * 0.11, color),
    filledRect(surfaceId, x + size * 0.54, y + size * 0.47, size * 0.32, size * 0.33, color),
    circle(surfaceId, x + size * 0.36, y + size * 0.34, size * 0.13, color),
    filledRect(surfaceId, x + size * 0.16, y + size * 0.54, size * 0.4, size * 0.32, color),
  ];
};

const targetIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const cx = x + size / 2, cy = y + size / 2;
  return [
    circle(surfaceId, cx, cy, size * 0.4, undefined, color, lw),
    circle(surfaceId, cx, cy, size * 0.24, undefined, color, lw),
    circle(surfaceId, cx, cy, size * 0.09, color),
  ];
};

const listIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = Math.max(lineWidth ?? defaultLineWidth(size), size * 0.1);
  const out: Cmd[] = [];
  for (const fy of [0.24, 0.5, 0.76]) {
    const cy = y + size * fy;
    out.push(filledRect(surfaceId, x + size * 0.12, cy - size * 0.07, size * 0.14, size * 0.14, color));
    out.push(filledRect(surfaceId, x + size * 0.34, cy - lw / 2, size * 0.54, lw, color));
  }
  return out;
};

const brainIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const cy = y + size * 0.5;
  // Two lobes split by a central bar: knowledge as a bicameral circle.
  return [
    circle(surfaceId, x + size * 0.36, cy, size * 0.25, undefined, color, lw),
    circle(surfaceId, x + size * 0.64, cy, size * 0.25, undefined, color, lw),
    line(surfaceId, x + size * 0.5, y + size * 0.2, x + size * 0.5, y + size * 0.8, color, lw),
    circle(surfaceId, x + size * 0.36, cy, size * 0.08, color),
  ];
};

const agentIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const cx = x + size / 2;
  return [
    line(surfaceId, cx, y + size * 0.14, cx, y + size * 0.3, color, lw),
    circle(surfaceId, cx, y + size * 0.12, size * 0.07, color),
    rect(surfaceId, x + size * 0.2, y + size * 0.3, size * 0.6, size * 0.52, color, lw),
    filledRect(surfaceId, x + size * 0.32, y + size * 0.46, size * 0.12, size * 0.12, color),
    filledRect(surfaceId, x + size * 0.56, y + size * 0.46, size * 0.12, size * 0.12, color),
    filledRect(surfaceId, x + size * 0.32, y + size * 0.66, size * 0.36, size * 0.06, color),
  ];
};

const calendarIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  return [
    rect(surfaceId, x + size * 0.14, y + size * 0.22, size * 0.72, size * 0.64, color, lw),
    filledRect(surfaceId, x + size * 0.14, y + size * 0.22, size * 0.72, size * 0.18, color),
    line(surfaceId, x + size * 0.34, y + size * 0.1, x + size * 0.34, y + size * 0.26, color, lw),
    line(surfaceId, x + size * 0.66, y + size * 0.1, x + size * 0.66, y + size * 0.26, color, lw),
    filledRect(surfaceId, x + size * 0.54, y + size * 0.56, size * 0.18, size * 0.18, color),
  ];
};

const globeIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const cx = x + size / 2, cy = y + size / 2;
  const r = size * 0.38;
  return [
    circle(surfaceId, cx, cy, r, undefined, color, lw),
    { type: 'ellipse', surfaceId, params: { cx, cy, radiusX: r * 0.42, radiusY: r, stroke: color, lineWidth: lw } },
    line(surfaceId, cx - r, cy, cx + r, cy, color, lw),
  ];
};

const networkIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const p = at(x, y, size);
  const a = p(0.5, 0.2), b = p(0.2, 0.78), c = p(0.8, 0.78);
  const r = size * 0.11;
  return [
    line(surfaceId, a.x, a.y, b.x, b.y, color, lw),
    line(surfaceId, b.x, b.y, c.x, c.y, color, lw),
    line(surfaceId, c.x, c.y, a.x, a.y, color, lw),
    circle(surfaceId, a.x, a.y, r, color),
    circle(surfaceId, b.x, b.y, r, color),
    circle(surfaceId, c.x, c.y, r, color),
  ];
};

const folderIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  const p = at(x, y, size);
  return [
    polygon(surfaceId, [p(0.12, 0.22), p(0.42, 0.22), p(0.5, 0.32), p(0.88, 0.32), p(0.88, 0.8), p(0.12, 0.8)], color),
  ];
};

const folderOpenIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const p = at(x, y, size);
  return [
    polyline(surfaceId, [p(0.12, 0.8), p(0.12, 0.22), p(0.42, 0.22), p(0.5, 0.32), p(0.8, 0.32), p(0.8, 0.46)], color, lw, false),
    polygon(surfaceId, [p(0.12, 0.8), p(0.26, 0.46), p(0.94, 0.46), p(0.8, 0.8)], color),
  ];
};

const gearIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const cx = x + size / 2, cy = y + size / 2;
  const out: Cmd[] = [circle(surfaceId, cx, cy, size * 0.22, undefined, color, lw * 1.4)];
  const tooth = Math.max(lw * 1.6, size * 0.13);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const cos = Math.cos(a), sin = Math.sin(a);
    out.push(line(
      surfaceId,
      cx + cos * size * 0.28, cy + sin * size * 0.28,
      cx + cos * size * 0.42, cy + sin * size * 0.42,
      color, tooth, 'butt',
    ));
  }
  return out;
};

const eyeIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = lineWidth ?? defaultLineWidth(size);
  const p = at(x, y, size);
  // An angular lens: the eye as a hexagon around a solid pupil.
  return [
    polyline(surfaceId, [p(0.06, 0.5), p(0.3, 0.26), p(0.7, 0.26), p(0.94, 0.5), p(0.7, 0.74), p(0.3, 0.74)], color, lw, true),
    circle(surfaceId, x + size / 2, y + size / 2, size * 0.14, color),
  ];
};

const bellIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  const p = at(x, y, size);
  return [
    polygon(surfaceId, [p(0.36, 0.18), p(0.64, 0.18), p(0.76, 0.66), p(0.24, 0.66)], color),
    filledRect(surfaceId, x + size * 0.12, y + size * 0.66, size * 0.76, size * 0.1, color),
    circle(surfaceId, x + size / 2, y + size * 0.86, size * 0.08, color),
  ];
};

const lockIcon: Renderer = ({ surfaceId, x, y, size, color, lineWidth }) => {
  const lw = Math.max(lineWidth ?? defaultLineWidth(size), size * 0.1);
  const p = at(x, y, size);
  return [
    polyline(surfaceId, [p(0.33, 0.48), p(0.33, 0.2), p(0.67, 0.2), p(0.67, 0.48)], color, lw, false),
    filledRect(surfaceId, x + size * 0.2, y + size * 0.46, size * 0.6, size * 0.42, color),
  ];
};

const gridIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  const s = size * 0.3;
  const a = size * 0.16, b = size * 0.54;
  return [
    filledRect(surfaceId, x + a, y + a, s, s, color),
    filledRect(surfaceId, x + b, y + a, s, s, color),
    filledRect(surfaceId, x + a, y + b, s, s, color),
    filledRect(surfaceId, x + b, y + b, s, s, color),
  ];
};

const diamondIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  const p = at(x, y, size);
  return [polygon(surfaceId, [p(0.5, 0.1), p(0.9, 0.5), p(0.5, 0.9), p(0.1, 0.5)], color)];
};

const activityIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  // A bar chart of uneven heights: running work at a glance.
  const w = size * 0.16;
  const base = y + size * 0.86;
  const bars = [[0.12, 0.4], [0.42, 0.7], [0.72, 0.52]] as const;
  return bars.map(([fx, fh]) => filledRect(surfaceId, x + size * fx, base - size * fh, w, size * fh, color));
};

const ICONS: Record<IconName, Renderer> = {
  close: closeIcon,
  minimize: minimizeIcon,
  restore: restoreIcon,
  maximize: maximizeIcon,
  resize: resizeIcon,
  send: sendIcon,
  search: searchIcon,
  plus: plusIcon,
  chevronDown: chevron('down'),
  chevronUp: chevron('up'),
  chevronLeft: chevron('left'),
  chevronRight: chevron('right'),
  check: checkIcon,
  warning: warningIcon,
  info: infoIcon,
  help: helpIcon,
  dot: dotIcon,
  clock: clockIcon,
  chat: chatIcon,
  users: usersIcon,
  target: targetIcon,
  list: listIcon,
  brain: brainIcon,
  agent: agentIcon,
  calendar: calendarIcon,
  globe: globeIcon,
  network: networkIcon,
  folder: folderIcon,
  folderOpen: folderOpenIcon,
  gear: gearIcon,
  eye: eyeIcon,
  bell: bellIcon,
  lock: lockIcon,
  grid: gridIcon,
  diamond: diamondIcon,
  activity: activityIcon,
};

/** True when `name` is a built-in icon (for validating caller-supplied names). */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}
