/**
 * CheckboxWidget — a toggleable checkbox with a label.
 *
 * Renders a 16x16 box (with checkmark when checked) and label text
 * to its right. Toggles on mousedown and fires a 'change' notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { inkFrame } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';

export interface CheckboxWidgetConfig extends WidgetConfig {
  checked?: boolean;
}

export class CheckboxWidget extends WidgetAbject {
  private checked: boolean;

  constructor(config: CheckboxWidgetConfig) {
    super(config);
    this.checked = config.checked ?? false;
  }

  /**
   * A square ink frame; checked fills solid red
   * with a paper tick drawn with square caps. Focus reddens the frame.
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const h = this.rect.height;
    const style = this.style;
    const theme = this.theme;
    const shape = shapeOf(theme);
    const font = buildFont(style, theme);
    const boxSize = 16;
    const boxY = Math.round(oy + (h - boxSize) / 2);
    const box = { x: ox, y: boxY, width: boxSize, height: boxSize };

    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    if (this.checked) {
      commands.push({ type: 'rect', surfaceId, params: { ...box, fill: style.background ?? theme.checkboxCheckedBg } });
    } else {
      commands.push({ type: 'rect', surfaceId, params: { ...box, fill: theme.inputBg } });
    }
    const frameColor = this.focused && !this.disabled
      ? shape.blockFocusColor
      : (style.borderColor ?? theme.checkboxBorder);
    commands.push(...inkFrame(surfaceId, box, frameColor, shape.ruleWidth));

    if (this.checked) {
      commands.push({
        type: 'polygon', surfaceId,
        params: {
          points: [
            { x: ox + 4, y: boxY + 8 },
            { x: ox + 7, y: boxY + 11 },
            { x: ox + 12, y: boxY + 5 },
          ],
          stroke: theme.checkmarkColor,
          lineWidth: 2.5,
          lineCap: 'square',
          lineJoin: 'miter',
          closePath: false,
        },
      });
    }

    commands.push({
      type: 'text', surfaceId,
      params: {
        x: ox + boxSize + 8, y: oy + h / 2, text: this.text, font,
        fill: style.color ?? theme.textPrimary, baseline: 'middle',
      },
    });

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
      this.checked = !this.checked;
      this.changed('change', this.checked ? 'true' : 'false');
      return { consumed: true };
    }
    if (input.type === 'keydown' && this.focused) {
      const key = input.key as string;
      if (key === ' ') {
        this.checked = !this.checked;
        this.changed('change', this.checked ? 'true' : 'false');
        await this.requestRedraw();
        return { consumed: true };
      }
    }
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.checked ? 'true' : 'false';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.checked !== undefined) {
      this.checked = updates.checked as boolean;
    }
  }
}
