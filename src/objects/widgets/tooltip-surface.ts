/**
 * TooltipSurface — manages a floating tooltip overlay.
 *
 * Plain helper class (not an Abject) that creates/destroys a UIServer surface
 * to show tooltip text on hover. Uses inputPassthrough so the tooltip never
 * steals mouse events.
 */

import { AbjectId } from '../../core/types.js';
import { ThemeData } from '../../core/theme-data.js';

/** Callback type for sending requests to UIServer via the owning widget. */
export type TooltipRequester = <T>(targetId: AbjectId, method: string, payload: Record<string, unknown>) => Promise<T>;

const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_PADDING_X = 8;
const TOOLTIP_PADDING_Y = 5;
const TOOLTIP_OFFSET_Y = 12;
const TOOLTIP_FONT = '12px "Inter", system-ui, sans-serif';
const TOOLTIP_Z_INDEX = 10000;
const TOOLTIP_RADIUS = 4;
const TOOLTIP_MAX_WIDTH = 300;
const TOOLTIP_MAX_LINES = 5;
const TOOLTIP_LINE_HEIGHT = 16; // 12px font + 4px leading
const TOOLTIP_CHAR_WIDTH = 6.5; // approximate average for 12px Inter
const TOOLTIP_AUTO_HIDE_MS = 3000;

export class TooltipSurface {
  private timer?: ReturnType<typeof setTimeout>;
  private autoHideTimer?: ReturnType<typeof setTimeout>;
  private surfaceId?: string;
  private showGeneration = 0;  // Incremented on hide() to cancel in-flight showTooltip
  private uiServerId: AbjectId;
  private requester: TooltipRequester;
  private screenWidth: number;
  private screenHeight: number;

  constructor(uiServerId: AbjectId, requester: TooltipRequester, screenWidth = 1920, screenHeight = 1080) {
    this.uiServerId = uiServerId;
    this.requester = requester;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
  }

  scheduleShow(text: string, screenX: number, screenY: number, theme: ThemeData): void {
    // Cancel any pending show — restart the delay
    this.cancelTimer();

    // If already showing, hide first then re-show after delay
    if (this.surfaceId) {
      this.destroySurface();
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.showTooltip(text, screenX, screenY, theme).catch(() => {});
    }, TOOLTIP_DELAY_MS);
  }

  hide(): void {
    this.showGeneration++;
    this.cancelTimer();
    this.cancelAutoHide();
    this.destroySurface();
  }

  destroy(): void {
    this.hide();
  }

  /** Await-able destroy for use before widget shutdown. */
  async destroyAsync(): Promise<void> {
    this.showGeneration++;
    this.cancelTimer();
    this.cancelAutoHide();
    if (this.surfaceId) {
      const sid = this.surfaceId;
      this.surfaceId = undefined;
      await this.requester<boolean>(this.uiServerId, 'destroySurface', { surfaceId: sid }).catch(() => {});
    }
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private cancelAutoHide(): void {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = undefined;
    }
  }

  private startAutoHide(): void {
    this.cancelAutoHide();
    this.autoHideTimer = setTimeout(() => {
      this.autoHideTimer = undefined;
      this.destroySurface();
    }, TOOLTIP_AUTO_HIDE_MS);
  }

  private destroySurface(): void {
    if (this.surfaceId) {
      const sid = this.surfaceId;
      this.surfaceId = undefined;
      this.requester<boolean>(this.uiServerId, 'destroySurface', { surfaceId: sid }).catch(() => {});
    }
  }

  /**
   * Word-wrap text into lines that fit within TOOLTIP_MAX_WIDTH,
   * capped at TOOLTIP_MAX_LINES. Returns wrapped lines and surface dimensions.
   */
  private measureTooltip(text: string): { lines: string[]; width: number; height: number } {
    const maxTextChars = Math.floor((TOOLTIP_MAX_WIDTH - TOOLTIP_PADDING_X * 2) / TOOLTIP_CHAR_WIDTH);
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (candidate.length <= maxTextChars) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        // If a single word exceeds the line, hard-break it
        current = word.length > maxTextChars ? word.slice(0, maxTextChars - 1) + '…' : word;
      }
      if (lines.length >= TOOLTIP_MAX_LINES) break;
    }
    if (current && lines.length < TOOLTIP_MAX_LINES) lines.push(current);

    // Truncate last line with ellipsis if we hit the limit and there's remaining text
    if (lines.length >= TOOLTIP_MAX_LINES) {
      lines.length = TOOLTIP_MAX_LINES;
      const last = lines[TOOLTIP_MAX_LINES - 1];
      if (last.length > maxTextChars - 1) {
        lines[TOOLTIP_MAX_LINES - 1] = last.slice(0, maxTextChars - 1) + '…';
      } else {
        lines[TOOLTIP_MAX_LINES - 1] = last + '…';
      }
    }

    const longestLine = Math.max(...lines.map(l => l.length));
    const width = Math.min(longestLine * TOOLTIP_CHAR_WIDTH + TOOLTIP_PADDING_X * 2, TOOLTIP_MAX_WIDTH);
    const height = TOOLTIP_PADDING_Y * 2 + lines.length * TOOLTIP_LINE_HEIGHT;
    return { lines, width, height };
  }

  private async showTooltip(text: string, screenX: number, screenY: number, theme: ThemeData): Promise<void> {
    const gen = this.showGeneration;
    const { lines, width: surfaceW, height: surfaceH } = this.measureTooltip(text);

    // Position tooltip below cursor, clamped to screen
    let x = screenX;
    let y = screenY + TOOLTIP_OFFSET_Y;
    if (x + surfaceW > this.screenWidth) x = this.screenWidth - surfaceW;
    if (x < 0) x = 0;
    if (y + surfaceH > this.screenHeight) y = screenY - surfaceH - 4; // flip above cursor
    if (y < 0) y = 0;

    // Create surface with inputPassthrough so it doesn't steal events
    const surfaceId = await this.requester<string>(this.uiServerId, 'createSurface', {
      rect: { x, y, width: surfaceW, height: surfaceH },
      zIndex: TOOLTIP_Z_INDEX,
      inputPassthrough: true,
    });

    // If hide() was called while awaiting createSurface, destroy immediately
    if (gen !== this.showGeneration) {
      this.requester<boolean>(this.uiServerId, 'destroySurface', { surfaceId }).catch(() => {});
      return;
    }
    this.surfaceId = surfaceId;

    // Draw tooltip background and text lines
    const commands: unknown[] = [
      { type: 'clear', surfaceId: this.surfaceId, params: {} },
      {
        type: 'rect',
        surfaceId: this.surfaceId,
        params: {
          x: 0, y: 0, width: surfaceW, height: surfaceH,
          fill: theme.windowBg,
          stroke: theme.windowBorder,
          radius: TOOLTIP_RADIUS,
        },
      },
    ];

    for (let i = 0; i < lines.length; i++) {
      commands.push({
        type: 'text',
        surfaceId: this.surfaceId,
        params: {
          x: TOOLTIP_PADDING_X,
          y: TOOLTIP_PADDING_Y + i * TOOLTIP_LINE_HEIGHT + TOOLTIP_LINE_HEIGHT / 2,
          text: lines[i],
          font: TOOLTIP_FONT,
          fill: theme.textPrimary,
          baseline: 'middle',
        },
      });
    }

    await this.requester<boolean>(this.uiServerId, 'draw', { commands });

    // Auto-hide after timeout as a safety net — the mouse may leave
    // the window without triggering a mouseleave on the widget.
    this.startAutoHide();
  }

}
