/**
 * SliderWidget — a numeric range slider.
 *
 * Renders a horizontal track with a circular thumb. The active portion
 * is filled with accent color. Fires a 'change' notification with the
 * numeric value as a string.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';

export interface SliderWidgetConfig extends WidgetConfig {
  min?: number;
  max?: number;
  step?: number;
  value?: number;
}

const THUMB_RADIUS = 8;
const TRACK_HEIGHT = 6;

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

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const font = buildFont(this.style);

    const trackY = oy + h / 2 - TRACK_HEIGHT / 2;
    const trackRadius = TRACK_HEIGHT / 2;
    const fraction = this.max > this.min ? (this.sliderValue - this.min) / (this.max - this.min) : 0;
    const thumbX = ox + THUMB_RADIUS + fraction * (w - THUMB_RADIUS * 2);

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
        type: 'circle',
        surfaceId,
        params: { cx: thumbX, cy: oy + h / 2, radius: THUMB_RADIUS + 2, fill: 'transparent', stroke: this.theme.inputBorderFocus },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Track background (full width)
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: trackY, width: w, height: TRACK_HEIGHT,
        fill: this.style.background ?? this.theme.sliderTrack,
        radius: trackRadius,
      },
    });

    // Active fill (from left to thumb)
    if (fraction > 0) {
      const fillWidth = Math.max(trackRadius * 2, (w - THUMB_RADIUS * 2) * fraction + THUMB_RADIUS);
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox, y: trackY, width: fillWidth, height: TRACK_HEIGHT,
          fill: this.style.color ?? this.theme.sliderFill,
          radius: trackRadius,
        },
      });
    }

    // Thumb circle
    commands.push({
      type: 'circle',
      surfaceId,
      params: {
        cx: thumbX,
        cy: oy + h / 2,
        radius: THUMB_RADIUS,
        fill: this.theme.sliderThumb,
        stroke: this.theme.sliderThumbBorder,
        lineWidth: 2,
      },
    });

    // Value text to the right (if there's room and label text is present)
    if (this.text) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + w / 2,
          y: oy + h / 2 + THUMB_RADIUS + 8,
          text: `${this.text}: ${this.sliderValue}`,
          font,
          fill: this.theme.textSecondary,
          align: 'center',
          baseline: 'top',
        },
      });
    }

    // Close disabled alpha save
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
