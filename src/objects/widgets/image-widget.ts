/**
 * ImageWidget — a lightweight image display widget.
 *
 * Renders an image via the imageUrl draw command. Emits 'click' to
 * dependents on mousedown (useful for clickable thumbnails, avatars,
 * and image grids). Supports 'contain', 'cover', and 'fill' fit modes.
 * Alt text is displayed as a fallback when no URL is provided.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { request } from '../../core/message.js';

export interface ImageWidgetConfig extends WidgetConfig {
  url?: string;
  fit?: 'contain' | 'cover' | 'fill';
  alt?: string;
}

export class ImageWidget extends WidgetAbject {
  private url: string;
  private fit: 'contain' | 'cover' | 'fill';
  private alt: string;
  /**
   * The URL actually handed to the draw command. For remote http(s) URLs we
   * fetch the bytes server-side (HttpClient.getBase64) into a data: URI:
   * cross-origin images drawn directly taint the surface canvas, which makes
   * the WebGL texture upload fail and can break the whole desktop. A data:
   * URI is same-origin and never taints.
   */
  private resolvedUrl: string = '';

  constructor(config: ImageWidgetConfig) {
    super(config);
    this.url = config.url ?? '';
    this.fit = config.fit ?? 'contain';
    this.alt = config.alt ?? '';
    // data: and same-origin URLs are safe to draw as-is.
    if (this.url && !this.isRemoteUrl(this.url)) this.resolvedUrl = this.url;
  }

  protected override async onInit(): Promise<void> {
    await super.onInit();
    if (this.url && this.isRemoteUrl(this.url)) void this.resolveImage(this.url);
  }

  /** http(s) URL on another origin — must be fetched server-side, not drawn directly. */
  private isRemoteUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }

  /**
   * Fetch a remote image as a data: URI via HttpClient, then redraw. On any
   * failure the widget falls back to its alt text rather than tainting the
   * canvas with a direct cross-origin draw.
   */
  private async resolveImage(url: string): Promise<void> {
    try {
      const httpId = await this.discoverDep('HttpClient');
      if (!httpId) return;
      const res = await this.request<{ dataUri?: string }>(
        request(this.id, httpId, 'getBase64', { url }),
        20000,
      );
      // Ignore stale responses if the url changed while we were fetching.
      if (this.url !== url) return;
      if (res?.dataUri) {
        this.resolvedUrl = res.dataUri;
        await this.requestRedraw();
      }
    } catch {
      // Leave resolvedUrl empty; buildDrawCommands shows alt text instead.
    }
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

    if (this.resolvedUrl) {
      // For 'fill' mode, just draw at full widget size.
      // For 'contain' and 'cover', we use full rect since we don't know
      // the image's intrinsic size — the compositor's imageUrl command
      // draws into the specified rect.
      commands.push({
        type: 'imageUrl',
        surfaceId,
        params: {
          x: ox, y: oy, width: w, height: h,
          url: this.resolvedUrl,
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

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
      this.changed('click', this.url);
    }
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.url;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.url !== undefined) {
      this.url = updates.url as string;
      if (!this.url || !this.isRemoteUrl(this.url)) {
        // data: / same-origin — safe to draw directly.
        this.resolvedUrl = this.url;
      } else {
        // Remote — clear the old image and fetch the new one server-side.
        this.resolvedUrl = '';
        void this.resolveImage(this.url);
      }
    }
    if (updates.fit !== undefined) {
      this.fit = updates.fit as 'contain' | 'cover' | 'fill';
    }
    if (updates.alt !== undefined) {
      this.alt = updates.alt as string;
    }
  }
}
