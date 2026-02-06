/**
 * DividerWidget — a horizontal or vertical divider line.
 *
 * Draws a horizontal line if width > height, otherwise a vertical line.
 * Dividers are non-interactive and return no value.
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';

export class DividerWidget extends WidgetAbject {
  constructor(config: WidgetConfig) {
    super(config);
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const divColor = this.style.color ?? '#444';

    if (w > h) {
      // Horizontal divider
      const midY = oy + h / 2;
      commands.push({
        type: 'line',
        surfaceId,
        params: { x1: ox, y1: midY, x2: ox + w, y2: midY, stroke: divColor },
      });
    } else {
      // Vertical divider
      const midX = ox + w / 2;
      commands.push({
        type: 'line',
        surfaceId,
        params: { x1: midX, y1: oy, x2: midX, y2: oy + h, stroke: divColor },
      });
    }

    return commands;
  }

  protected async processInput(_input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return '';
  }

  protected applyUpdate(_updates: Record<string, unknown>): void {
    // No type-specific updates for dividers.
  }
}
