/**
 * Shared types and constants for widget Abjects.
 */

import { InterfaceId } from '../../core/types.js';

// ── Interface IDs ──────────────────────────────────────────────────────────

export const WIDGET_INTERFACE: InterfaceId = 'abjects:widget' as InterfaceId;
export const WINDOW_INTERFACE: InterfaceId = 'abjects:window' as InterfaceId;

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

// ── Constants ──────────────────────────────────────────────────────────────

export const WIDGET_FONT = '14px system-ui';
export const TITLE_FONT = 'bold 13px system-ui';
export const CODE_FONT = '13px monospace';
export const DEFAULT_LINE_HEIGHT = 18;
export const TITLE_BAR_HEIGHT = 30;
export const EDGE_SIZE = 6;
