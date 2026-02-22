/**
 * CheckboxWidget — a toggleable checkbox with a label.
 *
 * Renders a 16x16 box (with checkmark when checked) and label text
 * to its right. Toggles on mousedown and fires a 'change' notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';

export interface CheckboxWidgetConfig extends WidgetConfig {
  checked?: boolean;
}

export class CheckboxWidget extends WidgetAbject {
  private checked: boolean;

  constructor(config: CheckboxWidgetConfig) {
    super(config);
    this.checked = config.checked ?? false;
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);

    const boxSize = 16;
    const boxY = oy + (h - boxSize) / 2;

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    // Focus ring glow
    if (this.focused && !this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId,
        params: { color: this.theme.inputBorderFocus, blur: 6 },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: boxY, width: boxSize, height: boxSize, fill: 'transparent', stroke: this.theme.inputBorderFocus, radius: 2 },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Checkbox box
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox,
        y: boxY,
        width: boxSize,
        height: boxSize,
        fill: this.checked ? (style.background ?? this.theme.checkboxCheckedBg) : 'transparent',
        stroke: style.borderColor ?? this.theme.checkboxBorder,
        radius: 2,
      },
    });

    // Checkmark (polygon)
    if (this.checked) {
      const cx = ox;
      const cy = boxY;
      commands.push({
        type: 'polygon',
        surfaceId,
        params: {
          points: [
            { x: cx + 3, y: cy + 8 },
            { x: cx + 6, y: cy + 12 },
            { x: cx + 13, y: cy + 4 },
          ],
          stroke: this.theme.checkmarkColor,
          lineWidth: 2,
          closePath: false,
        },
      });
    }

    // Label text to the right of the checkbox
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: ox + boxSize + 8,
        y: oy + h / 2,
        text: this.text,
        font,
        fill: style.color ?? this.theme.textTertiary,
        baseline: 'middle',
      },
    });

    // Close disabled alpha save
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
