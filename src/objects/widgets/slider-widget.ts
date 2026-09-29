/**
 * SliderWidget — a numeric range slider.
 *
 * Renders a horizontal track with a square thumb. The active portion
 * is filled with accent color. Fires a 'change' notification with the
 * numeric value as a string.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { inkFrame } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';

export interface SliderWidgetConfig extends WidgetConfig {
  min?: number;
  max?: number;
  step?: number;
  value?: number;
}

const THUMB_RADIUS = 8;

export class SliderWidget extends WidgetAbject {
  private min: number;
  private max: number;
  private step: number;
  private sliderValue: number;
  private dragging = false;

  constructor(config: SliderWidgetConfig) {
    super(config);
    this.min = config.min ?? 0;
    this.max = config.max ?? 100;
    this.step = config.step ?? 1;
    this.sliderValue = Math.max(this.min, Math.min(this.max, config.value ?? this.min));
  }

  /**
   * A thick flat track, a solid ink fill, and a red
   * square thumb with an ink frame. Grab or focus inverts the thumb (ink
   * face, red frame).
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const theme = this.theme;
    const shape = shapeOf(theme);
    const font = buildFont(this.style, theme);
    const trackH = 8;
    const cy = oy + h / 2;
    const trackY = Math.round(cy - trackH / 2);
    const fraction = this.max > this.min ? (this.sliderValue - this.min) / (this.max - this.min) : 0;
    const thumbX = ox + THUMB_RADIUS + fraction * (w - THUMB_RADIUS * 2);

    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    commands.push({
      type: 'rect', surfaceId,
      params: { x: ox, y: trackY, width: w, height: trackH, fill: this.style.background ?? theme.sliderTrack },
    });
    if (fraction > 0) {
      commands.push({
        type: 'rect', surfaceId,
        params: { x: ox, y: trackY, width: Math.max(0, thumbX - ox), height: trackH, fill: this.style.color ?? theme.sliderFill },
      });
    }

    const size = THUMB_RADIUS * 2;
    const thumb = { x: Math.round(thumbX - THUMB_RADIUS), y: Math.round(cy - THUMB_RADIUS), width: size, height: size };
    const engaged = (this.dragging || this.focused) && !this.disabled;
    commands.push({
      type: 'rect', surfaceId,
      params: { ...thumb, fill: engaged ? theme.textPrimary : theme.sliderThumb },
    });
    commands.push(...inkFrame(
      surfaceId, thumb,
      engaged ? shape.blockFocusColor : theme.sliderThumbBorder,
      shape.ruleWidth,
    ));

    if (this.text) {
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: ox + w / 2, y: cy + THUMB_RADIUS + 8,
          text: `${this.text}: ${this.sliderValue}`,
          font, fill: theme.textSecondary, align: 'center', baseline: 'top',
        },
      });
    }

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
      this.dragging = true;
      this.updateValueFromX(input);
      return { consumed: true };
    }

    if (input.type === 'mousemove' && this.dragging) {
      this.updateValueFromX(input);
      return { consumed: true };
    }

    if (input.type === 'mouseup') {
      if (this.dragging) {
        this.dragging = false;
        return { consumed: true };
      }
    }

    if (input.type === 'keydown' && this.focused) {
      const key = input.key as string;
      let newValue = this.sliderValue;

      if (key === 'ArrowRight' || key === 'ArrowUp') {
        newValue = Math.min(this.max, this.sliderValue + this.step);
      } else if (key === 'ArrowLeft' || key === 'ArrowDown') {
        newValue = Math.max(this.min, this.sliderValue - this.step);
      } else if (key === 'Home') {
        newValue = this.min;
      } else if (key === 'End') {
        newValue = this.max;
      } else {
        return { consumed: false };
      }

      if (newValue !== this.sliderValue) {
        this.sliderValue = newValue;
        await this.requestRedraw();
        this.changed('change', String(this.sliderValue));
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  private updateValueFromX(input: Record<string, unknown>): void {
    const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const w = this.rect.width;
    const usableWidth = w - THUMB_RADIUS * 2;
    const fraction = Math.max(0, Math.min(1, (localX - THUMB_RADIUS) / usableWidth));
    const raw = this.min + fraction * (this.max - this.min);
    const stepped = Math.round(raw / this.step) * this.step;
    const newValue = Math.max(this.min, Math.min(this.max, stepped));

    if (newValue !== this.sliderValue) {
      this.sliderValue = newValue;
      this.requestRedraw();
      this.changed('change', String(this.sliderValue));
    }
  }

  protected getWidgetValue(): string {
    return String(this.sliderValue);
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.value !== undefined) {
      this.sliderValue = Math.max(this.min, Math.min(this.max, updates.value as number));
    }
    if (updates.min !== undefined) {
      this.min = updates.min as number;
    }
    if (updates.max !== undefined) {
      this.max = updates.max as number;
    }
    if (updates.step !== undefined) {
      this.step = updates.step as number;
    }
  }
}
