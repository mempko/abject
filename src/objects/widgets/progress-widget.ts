/**
 * ProgressWidget — a progress bar with optional percentage text.
 *
 * Renders a track rectangle with a filled portion proportional to
 * the progress value (0-1). Non-interactive.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { hatch } from './widget-types.js';
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

  /**
   * A flat track with a solid fill (theme.progressFill) and no gloss.
   * Indeterminate mode runs diagonal hatching across the whole track, slid
   * by the shimmer phase so the stripes march left to right.
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style, this.theme);
    const radius = style.radius ?? 0;
    const trackColor = style.background ?? this.theme.progressTrack;
    const fillColor = style.color ?? this.theme.progressFill;
    const track = { x: ox, y: oy, width: w, height: h };

    commands.push({ type: 'rect', surfaceId, params: { ...track, fill: trackColor, radius } });

    if (this.indeterminate) {
      const spacing = Math.max(8, Math.min(14, h));
      const lineWidth = Math.max(2, spacing * 0.4);
      // Four whole periods per cycle, so the loop wraps without a jump.
      const phase = this.indeterminatePos * spacing * 4;
      commands.push(...hatch(surfaceId, track, fillColor, spacing, lineWidth, phase));
    } else if (this.progressValue > 0) {
      commands.push({
        type: 'rect', surfaceId,
        params: { x: ox, y: oy, width: Math.max(1, w * this.progressValue), height: h, fill: fillColor, radius },
      });
    }

    if (this.text) {
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: ox + w / 2, y: oy + h / 2, text: this.text, font,
          fill: this.theme.textPrimary, align: 'center', baseline: 'middle',
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
