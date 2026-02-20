/**
 * ProgressWidget — a progress bar with optional percentage text.
 *
 * Renders a track rectangle with a filled portion proportional to
 * the progress value (0-1). Non-interactive.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { lightenColor } from './widget-types.js';

export interface ProgressWidgetConfig extends WidgetConfig {
  value?: number;
}

export class ProgressWidget extends WidgetAbject {
  private progressValue: number;

  constructor(config: ProgressWidgetConfig) {
    super(config);
    this.progressValue = Math.max(0, Math.min(1, config.value ?? 0));
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;

    const trackColor = style.background ?? this.theme.progressTrack;
    const fillColor = style.color ?? this.theme.progressFill;

    // Track
    commands.push({
      type: 'rect',
      surfaceId,
      params: { x: ox, y: oy, width: w, height: h, fill: trackColor, radius },
    });

    // Fill with left-to-right gradient
    if (this.progressValue > 0) {
      const fillWidth = Math.max(radius * 2, w * this.progressValue);
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'linearGradient',
        surfaceId,
        params: { x0: ox, y0: 0, x1: ox + fillWidth, y1: 0, stops: [
          { offset: 0, color: fillColor },
          { offset: 1, color: lightenColor(fillColor, 30) },
        ] },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: oy, width: fillWidth, height: h, fill: fillColor, radius },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Optional percentage text
    if (this.text) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + w / 2,
          y: oy + h / 2,
          text: this.text,
          font,
          fill: this.theme.textPrimary,
          align: 'center',
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
    return String(this.progressValue);
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.value !== undefined) {
      this.progressValue = updates.value as number;
    }
  }
}
