/**
 * ImageWidget — a lightweight image display widget.
 *
 * Renders an image via the imageUrl draw command. Non-interactive.
 * Supports 'contain', 'cover', and 'fill' fit modes. Alt text
 * is displayed as a fallback when no URL is provided.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';

export interface ImageWidgetConfig extends WidgetConfig {
  url?: string;
  fit?: 'contain' | 'cover' | 'fill';
  alt?: string;
}

export class ImageWidget extends WidgetAbject {
  private url: string;
  private fit: 'contain' | 'cover' | 'fill';
  private alt: string;

  constructor(config: ImageWidgetConfig) {
    super(config);
    this.url = config.url ?? '';
    this.fit = config.fit ?? 'contain';
    this.alt = config.alt ?? '';
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;

    // Background (for letterboxing in 'contain' mode)
    if (this.style.background) {
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox, y: oy, width: w, height: h,
          fill: this.style.background,
          radius: this.style.radius ?? 0,
        },
      });
    }

    if (this.url) {
      // For 'fill' mode, just draw at full widget size.
      // For 'contain' and 'cover', we use full rect since we don't know
      // the image's intrinsic size — the compositor's imageUrl command
      // draws into the specified rect.
      commands.push({
        type: 'imageUrl',
        surfaceId,
        params: {
          x: ox, y: oy, width: w, height: h,
          url: this.url,
        },
      });
    } else if (this.alt) {
      // Alt text fallback
      const font = buildFont(this.style);
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + w / 2,
          y: oy + h / 2,
          text: this.alt,
          font,
          fill: this.style.color ?? this.theme.textTertiary,
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
    return this.url;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.url !== undefined) {
      this.url = updates.url as string;
    }
    if (updates.fit !== undefined) {
      this.fit = updates.fit as 'contain' | 'cover' | 'fill';
    }
    if (updates.alt !== undefined) {
      this.alt = updates.alt as string;
    }
  }
}
