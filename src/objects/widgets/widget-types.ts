/**
 * Shared types and constants for widget Abjects.
 */

import { AbjectId, InterfaceId } from '../../core/types.js';

// Re-export ThemeData and MIDNIGHT_BLOOM from core (canonical source)
export type { ThemeData } from '../../core/theme-data.js';
export { MIDNIGHT_BLOOM } from '../../core/theme-data.js';

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
  radius?: number;
  wordWrap?: boolean;
  disabled?: boolean;
  visible?: boolean;  // default true; when false, widget renders nothing and ignores input
  selectable?: boolean;  // labels only: enable text selection (read-only)
  markdown?: boolean;    // labels only: parse text as markdown and render with rich formatting
  syntaxHighlight?: boolean;  // textArea only: colorize JavaScript tokens
}

export type WidgetType = 'label' | 'button' | 'textInput' | 'textArea' | 'checkbox' | 'progress' | 'divider' | 'select' | 'canvas' | 'tabBar' | 'slider' | 'image';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const WIDGET_FONT = '14px "Inter", system-ui, sans-serif';
export const TITLE_FONT = '600 13px "Inter", system-ui, sans-serif';
export const CODE_FONT = '13px "JetBrains Mono", "Fira Code", monospace';
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
