/**
 * Theme data types and default theme constant.
 *
 * Extracted to core/ to avoid circular imports between core/abject.ts and
 * objects/widgets/widget-types.ts. Re-exported from widget-types.ts for
 * backward compatibility.
 */

// ── Design Tokens ──────────────────────────────────────────────────────────

export interface SpaceTokens {
  none: number;
  xxs: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
  xxxl: number;
}

export interface TypeToken {
  font: string;
  size: number;
  weight: string;
  lineHeight: number;
}

export interface TypeTokens {
  caption: TypeToken;
  body: TypeToken;
  bodyStrong: TypeToken;
  title: TypeToken;
  display: TypeToken;
  code: TypeToken;
}

export interface RadiusTokens {
  sm: number;
  md: number;
  lg: number;
  pill: number;
}

export interface MotionTokens {
  fast: number;
  base: number;
  slow: number;
  shimmer: number;
}

export type EasingCurve = readonly [number, number, number, number];

export interface EasingTokens {
  standard: EasingCurve;
  accelerate: EasingCurve;
  decelerate: EasingCurve;
  emphasize: EasingCurve;
}

export interface ElevationToken {
  blur: number;
  offsetY: number;
  color: string;
}

export interface ElevationTokens {
  level0: ElevationToken;
  level1: ElevationToken;
  level2: ElevationToken;
  level3: ElevationToken;
}

export interface GlowToken {
  blur: number;
  color: string;
}

export interface GlowTokens {
  focus: GlowToken;
  accent: GlowToken;
  danger: GlowToken;
}

export interface DesignTokens {
  space: SpaceTokens;
  type: TypeTokens;
  radius: RadiusTokens;
  motion: MotionTokens;
  easing: EasingTokens;
  elevation: ElevationTokens;
  glow: GlowTokens;
}

// ── Theme ──────────────────────────────────────────────────────────────────

export interface ThemeData {
  canvasBg: string;
  windowBg: string;
  titleBarBg: string;
  accent: string;
  accentSecondary: string;
  accentTertiary: string;
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
  sliderTrack: string;
  sliderFill: string;
  sliderThumb: string;
  sliderThumbBorder: string;
  windowRadius: number;
  widgetRadius: number;
  titleBarHeight: number;
  titleButtonSize: number;
  titleButtonMargin: number;
  titleButtonIconSize: number;
  titleButtonHoverBg: string;
  titleCloseHoverBg: string;

  // ── Semantic action buttons ──
  actionBg: string;
  actionText: string;
  actionBorder: string;

  // ── Destructive buttons ──
  destructiveBg: string;
  destructiveText: string;
  destructiveBorder: string;

  // ── Active sidebar/list item highlight ──
  activeItemBg: string;
  activeItemBorder: string;

  // ── Status indicators ──
  statusSuccess: string;
  statusError: string;
  statusErrorBright: string;
  statusWarning: string;
  statusNeutral: string;
  statusInfo: string;

  // ── Semantic text ──
  textHeading: string;
  textDescription: string;
  textMeta: string;
  sectionLabel: string;

  // ── Scrollbar ──
  scrollbarTrack: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;

  // ── Shadow ──
  shadowColor: string;
  dropdownShadow: string;

  // ── Links ──
  linkColor: string;

  // ── Design Tokens ──
  // Centralized scales for spacing, typography, radius, motion, elevation, glow.
  // New widgets should read from tokens; legacy fields above remain for compatibility.
  tokens: DesignTokens;
}

export const MIDNIGHT_BLOOM: ThemeData = {
  canvasBg: '#030308',
  windowBg: '#16162a',
  titleBarBg: '#1e1e34',
  accent: '#39ff8e',
  accentSecondary: '#9b59ff',
  accentTertiary: '#ff4d6a',
  textPrimary: '#e0e0ea',
  textSecondary: '#8a8a9e',
  textTertiary: '#5a5a70',
  textPlaceholder: '#3a3a4a',
  buttonBg: '#252545',
  buttonBorder: '#3a3a68',
  buttonText: '#e0e0ea',
  inputBg: '#08080f',
  inputBorder: '#22223a',
  inputBorderFocus: '#39ff8e',
  windowBorder: '#32325a',
  divider: '#22223a',
  resizeGrip: '#5a5a70',
  progressTrack: '#0e0e18',
  progressFill: '#9b59ff',
  cursor: '#39ff8e',
  checkboxCheckedBg: '#39ff8e',
  checkboxBorder: '#2a2a3a',
  checkmarkColor: '#030308',
  selectBg: '#12121e',
  selectHover: '#1a1a2a',
  selectArrow: '#5a5a70',
  selectionBg: 'rgba(57, 255, 142, 0.2)',
  sliderTrack: '#0e0e18',
  sliderFill: '#9b59ff',
  sliderThumb: '#9b59ff',
  sliderThumbBorder: '#2a2a3a',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#2a2a3a',
  titleCloseHoverBg: '#ff4d6a',

  // ── Semantic action buttons ──
  actionBg: '#39ff8e',
  actionText: '#030308',
  actionBorder: '#39ff8e',

  // ── Destructive buttons ──
  destructiveBg: '#3a1f1f',
  destructiveText: '#ff6b6b',
  destructiveBorder: '#ff6b6b',

  // ── Active sidebar/list item highlight ──
  activeItemBg: '#1a1a2e',
  activeItemBorder: '#39ff8e',

  // ── Status indicators ──
  statusSuccess: '#a8cc8c',
  statusError: '#e05561',
  statusErrorBright: '#ff6b6b',
  statusWarning: '#9b59ff',
  statusNeutral: '#6b7084',
  statusInfo: '#5b9bd5',

  // ── Semantic text ──
  textHeading: '#e2e4e9',
  textDescription: '#b4b8c8',
  textMeta: '#8b8fa3',
  sectionLabel: '#6b7084',

  // ── Scrollbar ──
  scrollbarTrack: 'rgba(255,255,255,0.05)',
  scrollbarThumb: 'rgba(255,255,255,0.15)',
  scrollbarThumbHover: 'rgba(255,255,255,0.3)',

  // ── Shadow ──
  shadowColor: 'rgba(0,0,0,0.7)',
  dropdownShadow: 'rgba(0,0,0,0.4)',

  // ── Links ──
  linkColor: '#6ea8fe',

  // ── Design Tokens ──
  tokens: {
    space: {
      none: 0,
      xxs: 2,
      xs: 4,
      sm: 6,
      md: 8,
      lg: 12,
      xl: 16,
      xxl: 24,
      xxxl: 32,
    },
    type: {
      caption:    { font: '"Inter", system-ui, sans-serif',          size: 11, weight: '400', lineHeight: 14 },
      body:       { font: '"Inter", system-ui, sans-serif',          size: 14, weight: '400', lineHeight: 20 },
      bodyStrong: { font: '"Inter", system-ui, sans-serif',          size: 14, weight: '600', lineHeight: 20 },
      title:      { font: '"Inter", system-ui, sans-serif',          size: 13, weight: '600', lineHeight: 18 },
      display:    { font: '"Inter", system-ui, sans-serif',          size: 18, weight: '700', lineHeight: 24 },
      code:       { font: '"JetBrains Mono", "Fira Code", monospace', size: 13, weight: '400', lineHeight: 18 },
    },
    radius: {
      sm: 4,
      md: 8,
      lg: 12,
      pill: 999,
    },
    motion: {
      fast: 120,
      base: 200,
      slow: 320,
      shimmer: 3000,
    },
    easing: {
      standard:   [0.4, 0.0, 0.2, 1.0],
      accelerate: [0.4, 0.0, 1.0, 1.0],
      decelerate: [0.0, 0.0, 0.2, 1.0],
      emphasize:  [0.2, 0.0, 0.0, 1.0],
    },
    elevation: {
      level0: { blur: 0,  offsetY: 0, color: 'rgba(0,0,0,0)' },
      level1: { blur: 8,  offsetY: 2, color: 'rgba(0,0,0,0.35)' },
      level2: { blur: 18, offsetY: 6, color: 'rgba(0,0,0,0.5)' },
      level3: { blur: 32, offsetY: 12, color: 'rgba(0,0,0,0.65)' },
    },
    glow: {
      focus:  { blur: 18, color: 'rgba(57, 255, 142, 0.55)' },
      accent: { blur: 10, color: 'rgba(57, 255, 142, 0.35)' },
      danger: { blur: 14, color: 'rgba(255, 77, 106, 0.5)' },
    },
  },
};
