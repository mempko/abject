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

// Layout/motion tokens are shared across themes — colour is the variable, not
// the spacing scale. Defined once and reused via spread on every preset.
const SHARED_TOKENS: DesignTokens = {
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
};

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
  tokens: SHARED_TOKENS,
};

// ── Paper (light) ──────────────────────────────────────────────────────────
export const PAPER_LIGHT: ThemeData = {
  canvasBg: '#ece8df',
  windowBg: '#faf7f1',
  titleBarBg: '#ede9df',
  accent: '#4a4ad9',
  accentSecondary: '#a05bd9',
  accentTertiary: '#d94a4a',
  textPrimary: '#1f1f24',
  textSecondary: '#5a5a64',
  textTertiary: '#8a8a94',
  textPlaceholder: '#b0b0b8',
  buttonBg: '#e6e2d8',
  buttonBorder: '#c8c4ba',
  buttonText: '#1f1f24',
  inputBg: '#ffffff',
  inputBorder: '#d0ccc2',
  inputBorderFocus: '#4a4ad9',
  windowBorder: '#cfcabe',
  divider: '#d8d4ca',
  resizeGrip: '#a0a09a',
  progressTrack: '#e0dcd0',
  progressFill: '#a05bd9',
  cursor: '#4a4ad9',
  checkboxCheckedBg: '#4a4ad9',
  checkboxBorder: '#b8b4aa',
  checkmarkColor: '#ffffff',
  selectBg: '#f4f0e6',
  selectHover: '#e8e4da',
  selectArrow: '#7a7a84',
  selectionBg: 'rgba(74, 74, 217, 0.18)',
  sliderTrack: '#e0dcd0',
  sliderFill: '#a05bd9',
  sliderThumb: '#a05bd9',
  sliderThumbBorder: '#ffffff',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#dcd8ce',
  titleCloseHoverBg: '#d94a4a',
  actionBg: '#4a4ad9',
  actionText: '#ffffff',
  actionBorder: '#4a4ad9',
  destructiveBg: '#fbe7e7',
  destructiveText: '#b91d1d',
  destructiveBorder: '#d94a4a',
  activeItemBg: '#e8e4da',
  activeItemBorder: '#4a4ad9',
  statusSuccess: '#3d8b3d',
  statusError: '#b91d1d',
  statusErrorBright: '#d94a4a',
  statusWarning: '#a05bd9',
  statusNeutral: '#7a7a84',
  statusInfo: '#1f6fc4',
  textHeading: '#0f0f14',
  textDescription: '#3a3a44',
  textMeta: '#6a6a74',
  sectionLabel: '#5a5a64',
  scrollbarTrack: 'rgba(0,0,0,0.04)',
  scrollbarThumb: 'rgba(0,0,0,0.18)',
  scrollbarThumbHover: 'rgba(0,0,0,0.3)',
  shadowColor: 'rgba(50,40,30,0.18)',
  dropdownShadow: 'rgba(50,40,30,0.15)',
  linkColor: '#1f4fc4',
  tokens: SHARED_TOKENS,
};

// ── High Contrast ──────────────────────────────────────────────────────────
export const HIGH_CONTRAST: ThemeData = {
  canvasBg: '#000000',
  windowBg: '#000000',
  titleBarBg: '#0a0a0a',
  accent: '#ffd700',
  accentSecondary: '#00e5ff',
  accentTertiary: '#ff3b3b',
  textPrimary: '#ffffff',
  textSecondary: '#e0e0e0',
  textTertiary: '#bababa',
  textPlaceholder: '#888888',
  buttonBg: '#000000',
  buttonBorder: '#ffffff',
  buttonText: '#ffffff',
  inputBg: '#000000',
  inputBorder: '#ffffff',
  inputBorderFocus: '#ffd700',
  windowBorder: '#ffffff',
  divider: '#ffffff',
  resizeGrip: '#ffffff',
  progressTrack: '#1a1a1a',
  progressFill: '#ffd700',
  cursor: '#ffd700',
  checkboxCheckedBg: '#ffd700',
  checkboxBorder: '#ffffff',
  checkmarkColor: '#000000',
  selectBg: '#0a0a0a',
  selectHover: '#1a1a1a',
  selectArrow: '#ffffff',
  selectionBg: 'rgba(255, 215, 0, 0.35)',
  sliderTrack: '#1a1a1a',
  sliderFill: '#ffd700',
  sliderThumb: '#ffd700',
  sliderThumbBorder: '#ffffff',
  windowRadius: 4,
  widgetRadius: 4,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#1a1a1a',
  titleCloseHoverBg: '#ff3b3b',
  actionBg: '#ffd700',
  actionText: '#000000',
  actionBorder: '#ffd700',
  destructiveBg: '#000000',
  destructiveText: '#ff3b3b',
  destructiveBorder: '#ff3b3b',
  activeItemBg: '#1a1a1a',
  activeItemBorder: '#ffd700',
  statusSuccess: '#00ff66',
  statusError: '#ff3b3b',
  statusErrorBright: '#ff3b3b',
  statusWarning: '#ffd700',
  statusNeutral: '#bababa',
  statusInfo: '#00e5ff',
  textHeading: '#ffffff',
  textDescription: '#e0e0e0',
  textMeta: '#bababa',
  sectionLabel: '#e0e0e0',
  scrollbarTrack: 'rgba(255,255,255,0.1)',
  scrollbarThumb: 'rgba(255,255,255,0.5)',
  scrollbarThumbHover: 'rgba(255,255,255,0.8)',
  shadowColor: 'rgba(0,0,0,0.95)',
  dropdownShadow: 'rgba(0,0,0,0.9)',
  linkColor: '#00e5ff',
  tokens: SHARED_TOKENS,
};

// ── Sunset ─────────────────────────────────────────────────────────────────
export const SUNSET: ThemeData = {
  canvasBg: '#1a0f10',
  windowBg: '#2a1820',
  titleBarBg: '#3a1f28',
  accent: '#ffb454',
  accentSecondary: '#ff6b9d',
  accentTertiary: '#ff4d4d',
  textPrimary: '#fce8d8',
  textSecondary: '#c9a896',
  textTertiary: '#8a6e62',
  textPlaceholder: '#5a4a44',
  buttonBg: '#3d2530',
  buttonBorder: '#5a3848',
  buttonText: '#fce8d8',
  inputBg: '#1a0f10',
  inputBorder: '#3a2530',
  inputBorderFocus: '#ffb454',
  windowBorder: '#5a3848',
  divider: '#3a2530',
  resizeGrip: '#8a6e62',
  progressTrack: '#1a0f10',
  progressFill: '#ff6b9d',
  cursor: '#ffb454',
  checkboxCheckedBg: '#ffb454',
  checkboxBorder: '#3a2530',
  checkmarkColor: '#1a0f10',
  selectBg: '#22141c',
  selectHover: '#2e1a26',
  selectArrow: '#8a6e62',
  selectionBg: 'rgba(255, 180, 84, 0.22)',
  sliderTrack: '#1a0f10',
  sliderFill: '#ff6b9d',
  sliderThumb: '#ff6b9d',
  sliderThumbBorder: '#3a2530',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#4a2c38',
  titleCloseHoverBg: '#ff4d4d',
  actionBg: '#ffb454',
  actionText: '#1a0f10',
  actionBorder: '#ffb454',
  destructiveBg: '#3d1818',
  destructiveText: '#ff7a7a',
  destructiveBorder: '#ff4d4d',
  activeItemBg: '#2e1a26',
  activeItemBorder: '#ffb454',
  statusSuccess: '#cce880',
  statusError: '#ff5a5a',
  statusErrorBright: '#ff7a7a',
  statusWarning: '#ff6b9d',
  statusNeutral: '#8a6e62',
  statusInfo: '#7ab8d9',
  textHeading: '#ffeed8',
  textDescription: '#d8c0b0',
  textMeta: '#a89080',
  sectionLabel: '#8a6e62',
  scrollbarTrack: 'rgba(255,180,84,0.06)',
  scrollbarThumb: 'rgba(255,180,84,0.22)',
  scrollbarThumbHover: 'rgba(255,180,84,0.4)',
  shadowColor: 'rgba(0,0,0,0.7)',
  dropdownShadow: 'rgba(0,0,0,0.5)',
  linkColor: '#ffd29a',
  tokens: SHARED_TOKENS,
};

// ── Ocean ──────────────────────────────────────────────────────────────────
export const OCEAN: ThemeData = {
  canvasBg: '#040814',
  windowBg: '#0c1a2e',
  titleBarBg: '#13243d',
  accent: '#3ae0d8',
  accentSecondary: '#5b9bd5',
  accentTertiary: '#ff7a90',
  textPrimary: '#d8e8f4',
  textSecondary: '#8a9eb4',
  textTertiary: '#5a708a',
  textPlaceholder: '#3a4e62',
  buttonBg: '#162e48',
  buttonBorder: '#27466a',
  buttonText: '#d8e8f4',
  inputBg: '#06101e',
  inputBorder: '#1a2c44',
  inputBorderFocus: '#3ae0d8',
  windowBorder: '#27466a',
  divider: '#1a2c44',
  resizeGrip: '#5a708a',
  progressTrack: '#06101e',
  progressFill: '#5b9bd5',
  cursor: '#3ae0d8',
  checkboxCheckedBg: '#3ae0d8',
  checkboxBorder: '#1a2c44',
  checkmarkColor: '#040814',
  selectBg: '#0a1828',
  selectHover: '#142640',
  selectArrow: '#5a708a',
  selectionBg: 'rgba(58, 224, 216, 0.22)',
  sliderTrack: '#06101e',
  sliderFill: '#5b9bd5',
  sliderThumb: '#5b9bd5',
  sliderThumbBorder: '#1a2c44',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#1c3450',
  titleCloseHoverBg: '#ff7a90',
  actionBg: '#3ae0d8',
  actionText: '#040814',
  actionBorder: '#3ae0d8',
  destructiveBg: '#2a1a22',
  destructiveText: '#ff8aa0',
  destructiveBorder: '#ff7a90',
  activeItemBg: '#142640',
  activeItemBorder: '#3ae0d8',
  statusSuccess: '#7ad9b0',
  statusError: '#ff7a90',
  statusErrorBright: '#ff8aa0',
  statusWarning: '#ffc474',
  statusNeutral: '#5a708a',
  statusInfo: '#5b9bd5',
  textHeading: '#e0eef8',
  textDescription: '#b4c4d4',
  textMeta: '#8a9eb4',
  sectionLabel: '#5a708a',
  scrollbarTrack: 'rgba(58,224,216,0.06)',
  scrollbarThumb: 'rgba(58,224,216,0.22)',
  scrollbarThumbHover: 'rgba(58,224,216,0.4)',
  shadowColor: 'rgba(0,0,0,0.7)',
  dropdownShadow: 'rgba(0,0,0,0.5)',
  linkColor: '#7ab8d9',
  tokens: SHARED_TOKENS,
};

// ── Monochrome ─────────────────────────────────────────────────────────────
export const MONOCHROME: ThemeData = {
  canvasBg: '#0d0d0d',
  windowBg: '#1a1a1a',
  titleBarBg: '#222222',
  accent: '#c0c0c0',
  accentSecondary: '#909090',
  accentTertiary: '#e8b04a',
  textPrimary: '#e8e8e8',
  textSecondary: '#a0a0a0',
  textTertiary: '#707070',
  textPlaceholder: '#505050',
  buttonBg: '#262626',
  buttonBorder: '#3a3a3a',
  buttonText: '#e8e8e8',
  inputBg: '#0a0a0a',
  inputBorder: '#2a2a2a',
  inputBorderFocus: '#c0c0c0',
  windowBorder: '#3a3a3a',
  divider: '#2a2a2a',
  resizeGrip: '#707070',
  progressTrack: '#0a0a0a',
  progressFill: '#909090',
  cursor: '#c0c0c0',
  checkboxCheckedBg: '#c0c0c0',
  checkboxBorder: '#2a2a2a',
  checkmarkColor: '#0d0d0d',
  selectBg: '#161616',
  selectHover: '#202020',
  selectArrow: '#707070',
  selectionBg: 'rgba(192, 192, 192, 0.18)',
  sliderTrack: '#0a0a0a',
  sliderFill: '#909090',
  sliderThumb: '#909090',
  sliderThumbBorder: '#2a2a2a',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#2e2e2e',
  titleCloseHoverBg: '#a04848',
  actionBg: '#c0c0c0',
  actionText: '#0d0d0d',
  actionBorder: '#c0c0c0',
  destructiveBg: '#2a1818',
  destructiveText: '#d09090',
  destructiveBorder: '#a04848',
  activeItemBg: '#202020',
  activeItemBorder: '#c0c0c0',
  statusSuccess: '#a8c8a8',
  statusError: '#c87878',
  statusErrorBright: '#d09090',
  statusWarning: '#e8b04a',
  statusNeutral: '#707070',
  statusInfo: '#a0a0c0',
  textHeading: '#f0f0f0',
  textDescription: '#c0c0c0',
  textMeta: '#909090',
  sectionLabel: '#707070',
  scrollbarTrack: 'rgba(255,255,255,0.05)',
  scrollbarThumb: 'rgba(255,255,255,0.18)',
  scrollbarThumbHover: 'rgba(255,255,255,0.32)',
  shadowColor: 'rgba(0,0,0,0.7)',
  dropdownShadow: 'rgba(0,0,0,0.5)',
  linkColor: '#a0a0c0',
  tokens: SHARED_TOKENS,
};

// ── Dracula ────────────────────────────────────────────────────────────────
export const DRACULA: ThemeData = {
  canvasBg: '#181924',
  windowBg: '#282a36',
  titleBarBg: '#343746',
  accent: '#ff79c6',
  accentSecondary: '#bd93f9',
  accentTertiary: '#ff5555',
  textPrimary: '#f8f8f2',
  textSecondary: '#bfc0c8',
  textTertiary: '#6272a4',
  textPlaceholder: '#44475a',
  buttonBg: '#3a3c4e',
  buttonBorder: '#525569',
  buttonText: '#f8f8f2',
  inputBg: '#21222c',
  inputBorder: '#3a3c4e',
  inputBorderFocus: '#ff79c6',
  windowBorder: '#44475a',
  divider: '#3a3c4e',
  resizeGrip: '#6272a4',
  progressTrack: '#21222c',
  progressFill: '#bd93f9',
  cursor: '#ff79c6',
  checkboxCheckedBg: '#50fa7b',
  checkboxBorder: '#44475a',
  checkmarkColor: '#282a36',
  selectBg: '#2c2e3a',
  selectHover: '#3a3c4e',
  selectArrow: '#6272a4',
  selectionBg: 'rgba(255, 121, 198, 0.22)',
  sliderTrack: '#21222c',
  sliderFill: '#bd93f9',
  sliderThumb: '#bd93f9',
  sliderThumbBorder: '#44475a',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#44475a',
  titleCloseHoverBg: '#ff5555',
  actionBg: '#bd93f9',
  actionText: '#282a36',
  actionBorder: '#bd93f9',
  destructiveBg: '#3a1f24',
  destructiveText: '#ff7a8c',
  destructiveBorder: '#ff5555',
  activeItemBg: '#3a3c4e',
  activeItemBorder: '#ff79c6',
  statusSuccess: '#50fa7b',
  statusError: '#ff5555',
  statusErrorBright: '#ff7a8c',
  statusWarning: '#ffb86c',
  statusNeutral: '#6272a4',
  statusInfo: '#8be9fd',
  textHeading: '#ffffff',
  textDescription: '#d8d8e0',
  textMeta: '#9aa0b8',
  sectionLabel: '#6272a4',
  scrollbarTrack: 'rgba(189,147,249,0.05)',
  scrollbarThumb: 'rgba(189,147,249,0.25)',
  scrollbarThumbHover: 'rgba(189,147,249,0.45)',
  shadowColor: 'rgba(0,0,0,0.7)',
  dropdownShadow: 'rgba(0,0,0,0.5)',
  linkColor: '#8be9fd',
  tokens: SHARED_TOKENS,
};

// ── Solarized Light ────────────────────────────────────────────────────────
export const SOLARIZED_LIGHT: ThemeData = {
  canvasBg: '#fdf6e3',
  windowBg: '#fbf2da',
  titleBarBg: '#eee8d5',
  accent: '#268bd2',
  accentSecondary: '#6c71c4',
  accentTertiary: '#dc322f',
  textPrimary: '#073642',
  textSecondary: '#586e75',
  textTertiary: '#93a1a1',
  textPlaceholder: '#b3b8b1',
  buttonBg: '#eee8d5',
  buttonBorder: '#cec6a8',
  buttonText: '#073642',
  inputBg: '#fdf6e3',
  inputBorder: '#cec6a8',
  inputBorderFocus: '#268bd2',
  windowBorder: '#cec6a8',
  divider: '#e1dabc',
  resizeGrip: '#93a1a1',
  progressTrack: '#eee8d5',
  progressFill: '#6c71c4',
  cursor: '#268bd2',
  checkboxCheckedBg: '#268bd2',
  checkboxBorder: '#cec6a8',
  checkmarkColor: '#fdf6e3',
  selectBg: '#fbf2da',
  selectHover: '#eee8d5',
  selectArrow: '#586e75',
  selectionBg: 'rgba(38, 139, 210, 0.2)',
  sliderTrack: '#eee8d5',
  sliderFill: '#6c71c4',
  sliderThumb: '#6c71c4',
  sliderThumbBorder: '#fdf6e3',
  windowRadius: 8,
  widgetRadius: 6,
  titleBarHeight: 36,
  titleButtonSize: 24,
  titleButtonMargin: 6,
  titleButtonIconSize: 14,
  titleButtonHoverBg: '#e1dabc',
  titleCloseHoverBg: '#dc322f',
  actionBg: '#268bd2',
  actionText: '#fdf6e3',
  actionBorder: '#268bd2',
  destructiveBg: '#fbe0db',
  destructiveText: '#a62420',
  destructiveBorder: '#dc322f',
  activeItemBg: '#eee8d5',
  activeItemBorder: '#268bd2',
  statusSuccess: '#859900',
  statusError: '#dc322f',
  statusErrorBright: '#dc322f',
  statusWarning: '#cb4b16',
  statusNeutral: '#93a1a1',
  statusInfo: '#268bd2',
  textHeading: '#002b36',
  textDescription: '#073642',
  textMeta: '#586e75',
  sectionLabel: '#586e75',
  scrollbarTrack: 'rgba(0,43,54,0.05)',
  scrollbarThumb: 'rgba(0,43,54,0.18)',
  scrollbarThumbHover: 'rgba(0,43,54,0.3)',
  shadowColor: 'rgba(50,40,30,0.18)',
  dropdownShadow: 'rgba(50,40,30,0.15)',
  linkColor: '#268bd2',
  tokens: SHARED_TOKENS,
};

// ── Theme catalogue ────────────────────────────────────────────────────────

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  theme: ThemeData;
}

export const DEFAULT_THEME_ID = 'midnight-bloom';

export const BUILTIN_THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'midnight-bloom', name: 'Midnight Bloom', description: 'Dark with green and purple accents', builtin: true, theme: MIDNIGHT_BLOOM },
  { id: 'paper-light',    name: 'Paper',          description: 'Warm light theme with indigo accent', builtin: true, theme: PAPER_LIGHT },
  { id: 'high-contrast',  name: 'High Contrast',  description: 'Black, white, and yellow for accessibility', builtin: true, theme: HIGH_CONTRAST },
  { id: 'sunset',         name: 'Sunset',         description: 'Warm maroon with amber accents',     builtin: true, theme: SUNSET },
  { id: 'ocean',          name: 'Ocean',          description: 'Deep navy with teal accents',        builtin: true, theme: OCEAN },
  { id: 'monochrome',     name: 'Monochrome',     description: 'Neutral grays with silver accent',   builtin: true, theme: MONOCHROME },
  { id: 'dracula',        name: 'Dracula',        description: 'Pink, purple, cyan on plum',         builtin: true, theme: DRACULA },
  { id: 'solarized-light',name: 'Solarized Light',description: 'Warm cream with classic blue accent',builtin: true, theme: SOLARIZED_LIGHT },
] as const;

export function getBuiltinThemeById(id: string): ThemeData | undefined {
  return BUILTIN_THEME_PRESETS.find((p) => p.id === id)?.theme;
}

export function isBuiltinThemeId(id: string): boolean {
  return BUILTIN_THEME_PRESETS.some((p) => p.id === id);
}

/**
 * Fill any missing colour slots on a partial theme with values from
 * MIDNIGHT_BLOOM. Used so user-registered themes that omit fields still render.
 */
export function fillThemeDefaults(partial: Partial<ThemeData>): ThemeData {
  return { ...MIDNIGHT_BLOOM, ...partial, tokens: partial.tokens ?? MIDNIGHT_BLOOM.tokens };
}
