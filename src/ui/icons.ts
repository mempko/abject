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
  | 'dot';

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
}

type Cmd = { type: string; surfaceId: string; params: Record<string, unknown> };

/**
 * Emit draw commands for the named icon within the given bounding box.
 * Returns an empty array for unknown icon names so callers don't need to guard.
 */
export function iconCommands(name: IconName, opts: IconDrawOpts): Cmd[] {
  const renderer = ICONS[name];
  if (!renderer) return [];
  return renderer(opts);
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

const dotIcon: Renderer = ({ surfaceId, x, y, size, color }) => {
  return [circle(surfaceId, x + size / 2, y + size / 2, size * 0.18, color)];
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
  dot: dotIcon,
};
