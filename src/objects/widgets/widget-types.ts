/**
 * Shared types and constants for widget Abjects.
 */

import { AbjectId, InterfaceId } from '../../core/types.js';

// Re-export ThemeData and default theme constants from core (canonical source)
export type { ThemeData } from '../../core/theme-data.js';
export { MIDNIGHT_BLOOM, ARCANE_GRIMOIRE } from '../../core/theme-data.js';

// ── Interface IDs ──────────────────────────────────────────────────────────

export const WIDGET_INTERFACE: InterfaceId = 'abjects:widget' as InterfaceId;
export const WINDOW_INTERFACE: InterfaceId = 'abjects:window' as InterfaceId;
export const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout' as InterfaceId;
export const CANVAS_INTERFACE: InterfaceId = 'abjects:canvas' as InterfaceId;

// ── Types ──────────────────────────────────────────────────────────────────

export interface WidgetStyle {
  color?: string;
  background?: string;
  borderColor?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  fontFamily?: 'body' | 'display' | 'mono';  // font stack to use; defaults to body
  radius?: number;
  wordWrap?: boolean;
  disabled?: boolean;
  visible?: boolean;  // default true; when false, widget renders nothing and ignores input
  selectable?: boolean;  // labels only: enable text selection (read-only)
  markdown?: boolean;    // labels only: parse text as markdown and render with rich formatting
  syntaxHighlight?: boolean;  // textArea only: colorize JavaScript tokens
  flat?: boolean;  // buttons only: quiet row (sidebar/toolbar item) — no depth gradient, bevel, or border; hover/press feedback only
  tooltip?: string;  // hover tooltip text, shown after a dwell via WidgetManager's tooltip service (used by icon-only buttons)
}

export type WidgetType = 'label' | 'button' | 'textInput' | 'textArea' | 'checkbox' | 'progress' | 'divider' | 'select' | 'canvas' | 'tabBar' | 'slider' | 'image' | 'themeSwatch';

// ── Draw commands ──────────────────────────────────────────────────────────

/**
 * The complete draw-command vocabulary executed by the Compositor. Single
 * source of truth: the Compositor derives its DrawCommand type from it, and
 * CanvasWidget validates incoming `draw` calls against it (the Compositor
 * skips unknown types silently, which used to produce blank canvases).
 *
 * Two dialects coexist:
 * - High-level self-contained shapes (rect, text, circle, ...) where one
 *   command carries geometry plus fill/stroke styling.
 * - The standard HTML5 Canvas 2D API: every context method is a command
 *   (params named after the MDN argument names — see CANVAS_CTX_METHODS)
 *   and every settable context property is a command taking { value }
 *   (see CANVAS_CTX_PROPERTIES). Commands execute in order against a
 *   stateful context, so beginPath/moveTo/lineTo/fill works as in a
 *   browser.
 */
export const DRAW_COMMAND_TYPES = [
  // High-level self-contained shapes
  'rect', 'text', 'line', 'image', 'imageUrl', 'clear', 'path',
  'save', 'restore', 'clip', 'translate',
  'circle', 'arc', 'ellipse', 'polygon', 'rotate', 'scale',
  'globalAlpha', 'shadow', 'setLineDash', 'linearGradient', 'radialGradient',
  'conicGradient', 'bezierCurve', 'quadraticCurve',
  // Canvas 2D API methods
  'clearRect', 'fillRect', 'strokeRect',
  'fillText', 'strokeText',
  'beginPath', 'closePath', 'moveTo', 'lineTo',
  'bezierCurveTo', 'quadraticCurveTo', 'arcTo', 'roundRect',
  'fill', 'stroke',
  'transform', 'setTransform', 'resetTransform', 'reset',
  'drawImage', 'putImageData',
  // Canvas 2D API settable properties, as { value } commands
  'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin',
  'miterLimit', 'lineDashOffset',
  'font', 'textAlign', 'textBaseline', 'direction',
  'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch', 'textRendering',
  'globalCompositeOperation', 'filter',
  'imageSmoothingEnabled', 'imageSmoothingQuality',
  'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
] as const;

export type DrawCommandType = typeof DRAW_COMMAND_TYPES[number];

/**
 * Canvas 2D context methods executed by generic pass-through: each entry maps
 * the method name to its ordered argument names (MDN names). The command's
 * params object supplies arguments by name; trailing undefined optionals are
 * dropped before the call. Methods with bespoke handling in the Compositor
 * (arc, ellipse, clip, fill, stroke, drawImage, ...) are not listed here.
 */
export const CANVAS_CTX_METHODS: Partial<Record<DrawCommandType, readonly string[]>> = {
  clearRect: ['x', 'y', 'width', 'height'],
  fillRect: ['x', 'y', 'width', 'height'],
  strokeRect: ['x', 'y', 'width', 'height'],
  fillText: ['text', 'x', 'y', 'maxWidth'],
  strokeText: ['text', 'x', 'y', 'maxWidth'],
  beginPath: [],
  closePath: [],
  moveTo: ['x', 'y'],
  lineTo: ['x', 'y'],
  bezierCurveTo: ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'],
  quadraticCurveTo: ['cpx', 'cpy', 'x', 'y'],
  arcTo: ['x1', 'y1', 'x2', 'y2', 'radius'],
  roundRect: ['x', 'y', 'width', 'height', 'radii'],
  transform: ['a', 'b', 'c', 'd', 'e', 'f'],
  setTransform: ['a', 'b', 'c', 'd', 'e', 'f'],
  resetTransform: [],
};

/**
 * Canvas 2D context settable properties accepted as commands with a single
 * { value } param, e.g. { type: 'fillStyle', params: { value: '#f00' } }.
 * fillStyle/strokeStyle also accept a gradient descriptor object as value
 * ({ x0, y0, x1, y1, stops } linear; { cx0, cy0, r0, cx1, cy1, r1, stops }
 * radial; { startAngle, cx, cy, stops } conic).
 */
export const CANVAS_CTX_PROPERTIES: readonly DrawCommandType[] = [
  'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin',
  'miterLimit', 'lineDashOffset',
  'font', 'textAlign', 'textBaseline', 'direction',
  'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch', 'textRendering',
  'globalCompositeOperation', 'filter',
  'imageSmoothingEnabled', 'imageSmoothingQuality',
  'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
];

/**
 * Canvas API names that cannot be commands (they return values, which a
 * fire-and-forget draw batch has no way to deliver), mapped to the closest
 * supported equivalent. Used to build actionable rejection messages.
 */
export const DRAW_COMMAND_ALIASES: Record<string, string> = {
  measureText: 'no equivalent — estimate from font size, or pass maxWidth to fillText/text',
  getImageData: 'no equivalent — draw commands cannot return pixel data',
  createImageData: 'putImageData with params {data: <RGBA number array>, width, height, dx, dy}',
  createPattern: 'no equivalent — use imageUrl, or a gradient value on fillStyle',
  createLinearGradient: 'linearGradient with params {x0, y0, x1, y1, stops}, or fillStyle with a gradient descriptor value',
  createRadialGradient: 'radialGradient with params {cx0, cy0, r0, cx1, cy1, r1, stops}, or fillStyle with a gradient descriptor value',
  createConicGradient: 'conicGradient with params {startAngle, cx, cy, stops}, or fillStyle with a gradient descriptor value',
  isPointInPath: 'no equivalent — draw commands cannot return values; hit-test in your own code',
  isPointInStroke: 'no equivalent — draw commands cannot return values; hit-test in your own code',
  getTransform: 'no equivalent — track your transform in your own code',
  getLineDash: 'no equivalent — track dash state in your own code',
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

// Font stacks for the Arcane Grimoire look: a screen-serif body, a characterful
// display serif for titles/headings, and a refined mono. Defined once here so
// every widget that builds an ad-hoc font string stays in the same family.
export const BODY_FONT_STACK = '"Spectral", Georgia, "Times New Roman", serif';
export const DISPLAY_FONT_STACK = '"Fraunces", "Spectral", Georgia, serif';
export const MONO_FONT_STACK = '"Spline Sans Mono", "JetBrains Mono", monospace';

export const WIDGET_FONT = `14px ${BODY_FONT_STACK}`;
export const TITLE_FONT = `600 14px ${DISPLAY_FONT_STACK}`;
export const CODE_FONT = `13px ${MONO_FONT_STACK}`;
export const DEFAULT_LINE_HEIGHT = 18;
export const TITLE_BAR_HEIGHT = 36;
export const EDGE_SIZE = 10;

// ── Layout Types ──────────────────────────────────────────────────────────

export type SizePolicy = 'fixed' | 'preferred' | 'expanding';

export interface LayoutChildConfig {
  widgetId: AbjectId;
  sizePolicy?: { horizontal?: SizePolicy; vertical?: SizePolicy };
  preferredSize?: { width?: number; height?: number };
  alignment?: 'left' | 'center' | 'right';
  stretch?: number;
}

export interface SpacerConfig {
  type: 'spacer';
  stretch?: number;
}

// ── Color Utilities ───────────────────────────────────────────────────

/**
 * Lighten a hex color by bumping each RGB channel. The amount is rounded so
 * fractional values (e.g. scaled by tokens.surface.gradient) stay valid hex.
 */
export function lightenColor(hex: string, amount = 20): string {
  const amt = Math.round(amount);
  const c = hex.replace('#', '');
  const r = Math.min(255, parseInt(c.substring(0, 2), 16) + amt);
  const g = Math.min(255, parseInt(c.substring(2, 4), 16) + amt);
  const b = Math.min(255, parseInt(c.substring(4, 6), 16) + amt);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Darken a hex color by reducing each RGB channel. The amount is rounded so
 * fractional values (e.g. scaled by tokens.surface.gradient) stay valid hex.
 */
export function darkenColor(hex: string, amount = 20): string {
  const amt = Math.round(amount);
  const c = hex.replace('#', '');
  const r = Math.max(0, parseInt(c.substring(0, 2), 16) - amt);
  const g = Math.max(0, parseInt(c.substring(2, 4), 16) - amt);
  const b = Math.max(0, parseInt(c.substring(4, 6), 16) - amt);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Convert a hex color (#rgb or #rrggbb) into an `rgba(...)` string at the given
 * alpha. Lets theme-driven chrome (window accent line, focus rings) derive
 * translucent strokes from a solid `theme.accent` instead of hardcoding colors.
 * If the input is already an rgb()/rgba() string it is returned unchanged.
 */
export interface GradientStopSpec {
  offset: number;
  color: string;
}

/**
 * Gradient descriptor accepted as a fillStyle/strokeStyle value by the
 * Compositor: { x0, y0, x1, y1, stops } linear, { cx0, cy0, r0, cx1, cy1,
 * r1, stops } radial, { startAngle, cx, cy, stops } conic.
 */
export type GradientSpec = Record<string, unknown> & { stops: GradientStopSpec[] };

/**
 * Command sequence that fills (and optionally strokes) a rounded rectangle
 * with a gradient. Uses the canvas-API dialect because a gradient descriptor
 * set via fillStyle survives for the fill() call, whereas a shape command's
 * own fill param would overwrite it with a solid color. radii may be a single
 * number or per-corner [topLeft, topRight, bottomRight, bottomLeft].
 */
export function gradientRect(surfaceId: string, opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  radii?: number | number[];
  gradient: GradientSpec;
  stroke?: string;
  lineWidth?: number;
}): unknown[] {
  const commands: unknown[] = [
    { type: 'save', surfaceId, params: {} },
    { type: 'fillStyle', surfaceId, params: { value: opts.gradient } },
    { type: 'beginPath', surfaceId, params: {} },
    { type: 'roundRect', surfaceId, params: { x: opts.x, y: opts.y, width: opts.width, height: opts.height, radii: opts.radii ?? 0 } },
    { type: 'fill', surfaceId, params: {} },
  ];
  if (opts.stroke) {
    commands.push({ type: 'stroke', surfaceId, params: { strokeStyle: opts.stroke, lineWidth: opts.lineWidth ?? 1 } });
  }
  commands.push({ type: 'restore', surfaceId, params: {} });
  return commands;
}

export function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#')) return color;
  let c = color.slice(1);
  if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
