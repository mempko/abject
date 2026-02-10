/**
 * Shared types and constants for widget Abjects.
 */

import { AbjectId, InterfaceId } from '../../core/types.js';

// ── Interface IDs ──────────────────────────────────────────────────────────

export const WIDGET_INTERFACE: InterfaceId = 'abjects:widget' as InterfaceId;
export const WINDOW_INTERFACE: InterfaceId = 'abjects:window' as InterfaceId;
export const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout' as InterfaceId;

// ── Types ──────────────────────────────────────────────────────────────────

export interface WidgetStyle {
  color?: string;
  background?: string;
  borderColor?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  radius?: number;
}

export type WidgetType = 'label' | 'button' | 'textInput' | 'textArea' | 'checkbox' | 'progress' | 'divider' | 'select';

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
  windowRadius: number;
  widgetRadius: number;
  titleBarHeight: number;
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
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 34,
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
