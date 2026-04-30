/**
 * ProgressWidget — a progress bar with optional percentage text.
 *
 * Renders a track rectangle with a filled portion proportional to
 * the progress value (0-1). Non-interactive.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { lightenColor } from './widget-types.js';
import { Tween, shimmer as motionShimmer } from '../../ui/motion.js';

export interface ProgressWidgetConfig extends WidgetConfig {
  /** Value in [0, 1]. Pass a negative number to enable indeterminate mode. */
  value?: number;
}

export class ProgressWidget extends WidgetAbject {
  private progressValue = 0;
  private indeterminate = false;
  private indeterminatePos = 0;
  private indeterminateTween?: Tween;

  constructor(config: ProgressWidgetConfig) {
    super(config);
    this.setProgress(config.value ?? 0);
  }

  protected override async onStop(): Promise<void> {
    this.indeterminateTween?.cancel();
    this.indeterminateTween = undefined;
  }

  private setProgress(value: number): void {
    if (value < 0) {
      this.indeterminate = true;
      this.progressValue = 0;
      this.startIndeterminate();
    } else {
      this.indeterminate = false;
      this.stopIndeterminate();
      this.progressValue = Math.max(0, Math.min(1, value));
    }
  }

  private startIndeterminate(): void {
    if (this.indeterminateTween) return;
    this.indeterminateTween = motionShimmer(
      1400,
      (pos) => {
        this.indeterminatePos = pos;
        this.requestRedraw().catch(() => {});
      },
    ).start();
  }

  private stopIndeterminate(): void {
    this.indeterminateTween?.cancel();
    this.indeterminateTween = undefined;
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

    if (this.indeterminate) {
      // Indeterminate: a 35%-width segment slides across the track and wraps.
      // Communicates "working" without committing to a percentage (Doherty).
      const segW = Math.max(40, w * 0.35);
      const travel = w + segW;
      const segX = ox + this.indeterminatePos * travel - segW;

      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'clip', surfaceId, params: { x: ox, y: oy, width: w, height: h } });
      commands.push({
        type: 'linearGradient',
        surfaceId,
        params: { x0: segX, y0: 0, x1: segX + segW, y1: 0, stops: [
          { offset: 0,    color: 'rgba(0,0,0,0)' },
          { offset: 0.5,  color: lightenColor(fillColor, 30) },
          { offset: 1,    color: 'rgba(0,0,0,0)' },
        ] },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: segX, y: oy, width: segW, height: h, radius },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    } else if (this.progressValue > 0) {
      // Determinate fill with left-to-right gradient
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
      this.setProgress(updates.value as number);
    }
  }
}
