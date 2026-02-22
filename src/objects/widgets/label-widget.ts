/**
 * LabelWidget — a non-interactive text label.
 *
 * Renders text with optional background and configurable alignment.
 * When style.wordWrap is true, text is wrapped to fit the widget width
 * and rendered as multiple lines. Labels do not consume any input events.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { wrapText } from './word-wrap.js';

export class LabelWidget extends WidgetAbject {
  // Word-wrap cache
  private cachedWrappedLines: string[] | null = null;
  private cachedWrapText: string = '';
  private cachedWrapWidth: number = 0;
  private cachedWrapFontSize: number | undefined = undefined;

  constructor(config: WidgetConfig) {
    super(config);
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;

    if (style.background) {
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill: style.background, radius },
      });
    }

    const align = style.align ?? 'left';
    const fill = style.color ?? this.theme.textTertiary;

    if (style.wordWrap && w > 0) {
      // Multi-line word-wrap rendering
      const fontSize = style.fontSize ?? 14;
      const lineHeight = fontSize + 4;
      const textPadding = 4;
      const maxWidth = w - textPadding * 2;

      // Use cached wrapped lines if text, width, and font haven't changed
      if (
        this.cachedWrappedLines === null ||
        this.cachedWrapText !== this.text ||
        this.cachedWrapWidth !== maxWidth ||
        this.cachedWrapFontSize !== fontSize
      ) {
        const measureFn = (t: string) => this.measureText(surfaceId, t, font);
        this.cachedWrappedLines = await wrapText(this.text, maxWidth, measureFn);
        this.cachedWrapText = this.text;
        this.cachedWrapWidth = maxWidth;
        this.cachedWrapFontSize = fontSize;
      }

      const lines = this.cachedWrappedLines;

      // Clip to prevent overflow
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'clip',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h },
      });

      for (let i = 0; i < lines.length; i++) {
        const lineY = oy + i * lineHeight + lineHeight * 0.7;
        if (lineY - lineHeight > oy + h) break; // past bottom edge

        let textX: number;
        if (align === 'center') {
          textX = ox + w / 2;
        } else if (align === 'right') {
          textX = ox + w - textPadding;
        } else {
          textX = ox + textPadding;
        }

        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: textX,
            y: lineY,
            text: lines[i],
            font,
            fill,
            align,
            baseline: 'alphabetic',
          },
        });
      }

      commands.push({ type: 'restore', surfaceId, params: {} });
    } else {
      // Single-line rendering (original behavior)
      let textX: number;
      if (align === 'center') {
        textX = ox + w / 2;
      } else if (align === 'right') {
        textX = ox + w;
      } else {
        textX = ox;
      }

      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: textX,
          y: oy + h / 2,
          text: this.text,
          font,
          fill,
          align,
          baseline: 'middle',
        },
      });
    }

    return commands;
  }

  protected async processInput(_input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(_updates: Record<string, unknown>): void {
    // Invalidate wrap cache when text or style changes (handled by base class applyCommonUpdates)
    this.cachedWrappedLines = null;
  }
}
