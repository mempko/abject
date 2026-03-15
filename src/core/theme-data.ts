/**
 * Theme data types and default theme constant.
 *
 * Extracted to core/ to avoid circular imports between core/abject.ts and
 * objects/widgets/widget-types.ts. Re-exported from widget-types.ts for
 * backward compatibility.
 */

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
}

export const MIDNIGHT_BLOOM: ThemeData = {
  canvasBg: '#030308',
  windowBg: '#141422',
  titleBarBg: '#1a1a2a',
  accent: '#39ff8e',
  accentSecondary: '#9b59ff',
  accentTertiary: '#ff4d6a',
  textPrimary: '#e0e0ea',
  textSecondary: '#8a8a9e',
  textTertiary: '#5a5a70',
  textPlaceholder: '#3a3a4a',
  buttonBg: '#1a1a2a',
  buttonBorder: '#2a2a3a',
  buttonText: '#e0e0ea',
  inputBg: '#08080f',
  inputBorder: '#1a1a2a',
  inputBorderFocus: '#39ff8e',
  windowBorder: '#2a2a3e',
  divider: '#1a1a2a',
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
  titleBarHeight: 34,
  titleButtonSize: 20,
  titleButtonMargin: 7,
  titleButtonIconSize: 10,
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
  shadowColor: 'rgba(0,0,0,0.5)',
  dropdownShadow: 'rgba(0,0,0,0.4)',
};
