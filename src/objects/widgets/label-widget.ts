/**
 * LabelWidget — a non-interactive text label.
 *
 * Renders text with optional background and configurable alignment.
 * Labels do not consume any input events.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';

export class LabelWidget extends WidgetAbject {
  constructor(config: WidgetConfig) {
    super(config);
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? 4;

    if (style.background) {
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill: style.background, radius },
      });
    }

    const align = style.align ?? 'left';
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
        fill: style.color ?? '#aaa',
        align,
        baseline: 'middle',
      },
    });

    return commands;
  }

  protected async processInput(_input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(_updates: Record<string, unknown>): void {
    // No type-specific updates for labels.
  }
}
