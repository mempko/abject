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
}

export type WidgetType = 'label' | 'button' | 'textInput' | 'textArea' | 'checkbox' | 'progress' | 'divider' | 'select' | 'canvas' | 'tabBar' | 'slider' | 'image' | 'themeSwatch';

// ── Draw commands ──────────────────────────────────────────────────────────

/**
 * The complete draw-command vocabulary executed by the Compositor. Single
 * source of truth: the Compositor derives its DrawCommand type from it, and
 * CanvasWidget validates incoming `draw` calls against it (the Compositor
 * skips unknown types silently, which used to produce blank canvases).
 */
export const DRAW_COMMAND_TYPES = [
  'rect', 'text', 'line', 'image', 'imageUrl', 'clear', 'path',
  'save', 'restore', 'clip', 'translate',
  'circle', 'arc', 'ellipse', 'polygon', 'rotate', 'scale',
  'globalAlpha', 'shadow', 'setLineDash', 'linearGradient', 'radialGradient',
  'bezierCurve', 'quadraticCurve',
] as const;

export type DrawCommandType = typeof DRAW_COMMAND_TYPES[number];

/**
 * HTML5 Canvas API names that code generators commonly reach for but that are
 * NOT part of the vocabulary, mapped to the correct equivalent. Used to build
 * actionable rejection messages.
 */
export const DRAW_COMMAND_ALIASES: Record<string, string> = {
  fillRect: 'rect with params {x, y, width, height, fill}',
  strokeRect: 'rect with params {x, y, width, height, stroke, lineWidth}',
  clearRect: 'rect with params {x, y, width, height, fill: <background color>}',
  fillText: 'text with params {x, y, text, fill, font}',
  strokeText: 'text with params {x, y, text, stroke, font}',
  drawImage: 'image with params {x, y, width, height, data} or imageUrl with params {x, y, width, height, url}',
  beginPath: 'path with params {path: <SVG path string>, fill?, stroke?} (each command is self-contained; there is no path-building state)',
  moveTo: 'line or path commands (each command is self-contained; there is no path-building state)',
  lineTo: 'line with params {x1, y1, x2, y2, stroke, lineWidth}',
  fill: 'a fill param on the shape command itself (rect/circle/path all take fill)',
  stroke: 'a stroke param on the shape command itself (rect/circle/path all take stroke)',
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
 * Lighten a hex color by bumping each RGB channel.
 */
export function lightenColor(hex: string, amount = 20): string {
  const c = hex.replace('#', '');
  const r = Math.min(255, parseInt(c.substring(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(c.substring(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(c.substring(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Darken a hex color by reducing each RGB channel.
 */
export function darkenColor(hex: string, amount = 20): string {
  const c = hex.replace('#', '');
  const r = Math.max(0, parseInt(c.substring(0, 2), 16) - amount);
  const g = Math.max(0, parseInt(c.substring(2, 4), 16) - amount);
  const b = Math.max(0, parseInt(c.substring(4, 6), 16) - amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Convert a hex color (#rgb or #rrggbb) into an `rgba(...)` string at the given
 * alpha. Lets theme-driven chrome (window accent line, focus rings) derive
 * translucent strokes from a solid `theme.accent` instead of hardcoding colors.
 * If the input is already an rgb()/rgba() string it is returned unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#')) return color;
  let c = color.slice(1);
  if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
