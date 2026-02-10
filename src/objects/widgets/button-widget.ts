/**
 * ButtonWidget — a clickable button with centered text.
 *
 * Renders a rounded rectangle with centered label text.
 * Consumes mousedown events and fires a 'click' change notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';

export class ButtonWidget extends WidgetAbject {
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

    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox,
        y: oy,
        width: w,
        height: h,
        fill: style.background ?? this.theme.buttonBg,
        stroke: style.borderColor ?? this.theme.buttonBorder,
        radius,
      },
    });

    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: ox + w / 2,
        y: oy + h / 2,
        text: this.text,
        font,
        fill: style.color ?? this.theme.buttonText,
        align: 'center',
        baseline: 'middle',
      },
    });

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
      this.changed('click', this.text);
      return { consumed: true };
    }
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(_updates: Record<string, unknown>): void {
    // No type-specific updates for buttons.
  }
}
