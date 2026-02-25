/**
 * Shared types and constants for widget Abjects.
 */

import { AbjectId, InterfaceId } from '../../core/types.js';

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
}

export type WidgetType = 'label' | 'button' | 'textInput' | 'textArea' | 'checkbox' | 'progress' | 'divider' | 'select' | 'canvas' | 'tabBar';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Theme ──────────────────────────────────────────────────────────────────

export interface ThemeData {
  canvasBg: string;
  windowBg: string;
  titleBarBg: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textPlaceholder: string;
  buttonBg: string;
  buttonBorder: string;
  buttonText: string;
  inputBg: string;
  inputBorder: string;
  inputBorderFocus: string;
  windowBorder: string;
  divider: string;
  resizeGrip: string;
  progressTrack: string;
  progressFill: string;
  cursor: string;
  checkboxCheckedBg: string;
  checkboxBorder: string;
  checkmarkColor: string;
  selectBg: string;
  selectHover: string;
  selectArrow: string;
  selectionBg: string;
  windowRadius: number;
  widgetRadius: number;
  titleBarHeight: number;
  titleButtonSize: number;
  titleButtonMargin: number;
  titleButtonIconSize: number;
  titleButtonHoverBg: string;
  titleCloseHoverBg: string;
}

export const MIDNIGHT_BLOOM: ThemeData = {
  canvasBg: '#0f1019',
  windowBg: '#171923',
  titleBarBg: '#1e2030',
  accent: '#e8a84c',
  textPrimary: '#e2e4e9',
  textSecondary: '#b4b8c8',
  textTertiary: '#6b7084',
  textPlaceholder: '#3d4158',
  buttonBg: '#252840',
  buttonBorder: '#353958',
  buttonText: '#e2e4e9',
  inputBg: '#10121c',
  inputBorder: '#2a2d42',
  inputBorderFocus: '#e8a84c',
  windowBorder: '#252840',
  divider: '#252840',
  resizeGrip: '#4a4d5e',
  progressTrack: '#1a1d2e',
  progressFill: '#e8a84c',
  cursor: '#e8a84c',
  checkboxCheckedBg: '#e8a84c',
  checkboxBorder: '#353958',
  checkmarkColor: '#0f1019',
  selectBg: '#1e2030',
  selectHover: '#252840',
  selectArrow: '#6b7084',
  selectionBg: 'rgba(232, 168, 76, 0.3)',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 34,
  titleButtonSize: 20,
  titleButtonMargin: 7,
  titleButtonIconSize: 10,
  titleButtonHoverBg: '#353958',
  titleCloseHoverBg: '#c53030',
};

// ── Constants ──────────────────────────────────────────────────────────────

export const WIDGET_FONT = '14px "Inter", system-ui, sans-serif';
export const TITLE_FONT = '600 13px "Inter", system-ui, sans-serif';
export const CODE_FONT = '13px "JetBrains Mono", "Fira Code", monospace';
export const DEFAULT_LINE_HEIGHT = 18;
export const TITLE_BAR_HEIGHT = 34;
export const EDGE_SIZE = 6;

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
