/**
 * ProgressWidget — a progress bar with optional percentage text.
 *
 * Renders a track rectangle with a filled portion proportional to
 * the progress value (0-1). Non-interactive.
 */

import { WidgetAbject, WidgetConfig, WidgetSceneDecoration, buildFont } from './widget-abject.js';
import { hatch, withAlpha } from './widget-types.js';
import { progressSweepOps } from '../ui-kit.js';

export interface ProgressWidgetConfig extends WidgetConfig {
  /**
   * Fraction in [0, 1], or a percentage above 1 (up to 100, as the guide
   * documents). Pass a negative number for indeterminate mode.
   */
  value?: number;
}

export class ProgressWidget extends WidgetAbject {
  private progressValue = 0;
  private indeterminate = false;

  constructor(config: ProgressWidgetConfig) {
    super(config);
    this.setProgress(config.value ?? 0);
  }

  private setProgress(value: number): void {
    const wasIndeterminate = this.indeterminate;
    if (value < 0) {
      this.indeterminate = true;
      this.progressValue = 0;
    } else {
      this.indeterminate = false;
      const fraction = value > 1 ? value / 100 : value;
      this.progressValue = Math.max(0, Math.min(1, fraction));
    }
    // The sweep starts or stops with the mode (the repaint that follows
    // every update places it exactly).
    if (this.indeterminate !== wasIndeterminate) this.syncSceneDecorations();
  }

  /**
   * Indeterminate mode is a sweep of light along the track, animated by the
   * browser as retained scene nodes: no timer here, no per-frame repaint.
   */
  protected override sceneDecorations(): WidgetSceneDecoration[] {
    const base = super.sceneDecorations();
    if (!this.indeterminate) return base;
    const id = `sweep-${this.id}`;
    const color = this.style.color ?? '$accentSecondary';
    const trackColor = this.style.background ?? this.theme.progressTrack;
    return [...base, { id, build: (rect) => progressSweepOps(id, rect, { color, trackColor }) }];
  }

  /**
   * A flat track with a solid fill (theme.progressFill) and no gloss.
   * Indeterminate mode paints faint, still diagonal hatching (what a screen
   * without 3D shows); the moving sweep rides above it in the scene.
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
      commands.push(...hatch(surfaceId, track, withAlpha(fillColor, 0.22), spacing, lineWidth, 0));
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
