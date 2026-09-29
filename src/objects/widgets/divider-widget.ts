/**
 * DividerWidget — a horizontal or vertical divider line.
 *
 * Draws a horizontal line if width > height, otherwise a vertical line.
 * Dividers are non-interactive and return no value.
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { squareMark } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';

export class DividerWidget extends WidgetAbject {
  constructor(config: WidgetConfig) {
    super(config);
  }

  /**
   * A heavy ink rule at rule width, capped by a
   * small red square at its far end when there is room.
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const color = this.style.color ?? this.theme.textPrimary;
    const horizontal = w > h;
    const thick = Math.max(1, Math.min(shapeOf(this.theme).ruleWidth, horizontal ? h : w));
    const length = horizontal ? w : h;
    const mark = Math.min(6, horizontal ? h : w);
    const withMark = length > 40 && mark >= 4;

    if (horizontal) {
      const y = Math.round(oy + h / 2 - thick / 2);
      commands.push({ type: 'rect', surfaceId, params: { x: ox, y, width: withMark ? w - mark - 2 : w, height: thick, fill: color } });
      if (withMark) commands.push(...squareMark(surfaceId, ox + w - mark / 2, oy + h / 2, mark, this.theme.accent));
    } else {
      const x = Math.round(ox + w / 2 - thick / 2);
      commands.push({ type: 'rect', surfaceId, params: { x, y: oy, width: thick, height: withMark ? h - mark - 2 : h, fill: color } });
      if (withMark) commands.push(...squareMark(surfaceId, ox + w / 2, oy + h - mark / 2, mark, this.theme.accent));
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
