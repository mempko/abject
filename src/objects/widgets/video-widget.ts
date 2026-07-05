/**
 * VideoWidget — video playback inside a window surface.
 *
 * Sources:
 *   - http(s) URL or data: URI (file playback with controls)
 *   - abject://<typeId>/<path> file reference (resolved to a data: URI via the
 *     referenced FileSystem, like AudioOutput does for sound files)
 *   - a live streamId from MediaStream capture (camera, screen share, or a
 *     peer's remote track): the client already holds those streams, so a
 *     window showing a peer's camera is a video call surface
 *
 * Rendering: frames never cross the relay. The widget emits a `videoFrame`
 * draw command that registers its rect as a live region; the client-side
 * compositor composites the named video element's current frame into that
 * rect every animation frame (see Compositor.blitVideoFrames). The widget
 * itself only draws chrome: letterbox background, controls, badges.
 *
 * Events (via changed()): 'playing', 'paused', 'ended', 'error' (message).
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request } from '../../core/message.js';
import { parseAbjectUrl } from './markdown-image-resolver.js';
import { withAlpha } from './widget-types.js';

export interface VideoWidgetConfig extends WidgetConfig {
  /** URL, data: URI, abject:// reference, or a captured MediaStream id. */
  source: string;
  /** Show the play/pause + seek overlay. Defaults: URLs yes, streams no. */
  controls?: boolean;
  muted?: boolean;
  loop?: boolean;
  autoplay?: boolean;
}

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', ogg: 'video/ogg', mov: 'video/quicktime',
};

function videoMimeForPath(pathOrName: string): string {
  const dot = pathOrName.lastIndexOf('.');
  const ext = dot >= 0 ? pathOrName.slice(dot + 1).toLowerCase() : '';
  return VIDEO_MIME_BY_EXT[ext] ?? 'video/mp4';
}

/** URL-shaped sources play as files; anything else is a captured streamId. */
function isUrlSource(source: string): boolean {
  return /^(https?|data|abject|blob):/i.test(source);
}

const CONTROLS_HEIGHT = 28;
/** abject:// video files resolve inline as base64; keep them bounded. */
const MAX_INLINE_VIDEO_BYTES = 48 * 1024 * 1024;

export class VideoWidget extends WidgetAbject {
  private source: string;
  private controls: boolean;
  private muted: boolean;
  private loop: boolean;
  private autoplay: boolean;

  private playing = false;
  private ended = false;
  private duration = 0;
  private currentTime = 0;
  private errorText = '';
  /** Set once videoSetup has been relayed for the current source. */
  private setupDone = false;

  constructor(config: VideoWidgetConfig) {
    super(config);
    this.source = config.source ?? '';
    const stream = !isUrlSource(this.source);
    this.controls = config.controls ?? !stream;
    this.muted = config.muted ?? false;
    this.loop = config.loop ?? false;
    this.autoplay = config.autoplay ?? true;
    this.setupVideoHandlers();
  }

  /** Client-side element id: stable per widget, unique across the desktop. */
  private get videoId(): string {
    return `vid-${this.id}`;
  }

  private get isStream(): boolean {
    return !isUrlSource(this.source);
  }

  private setupVideoHandlers(): void {
    // Video element state relayed back from the client via BackendUI.
    this.on('videoEvent', async (msg: AbjectMessage) => {
      const p = msg.payload as {
        event: string; error?: string;
        duration?: number; currentTime?: number;
      };
      switch (p.event) {
        case 'playing':
          this.playing = true;
          this.ended = false;
          this.errorText = '';
          this.changed('playing', '');
          break;
        case 'paused':
          this.playing = false;
          this.changed('paused', '');
          break;
        case 'ended':
          this.playing = false;
          this.ended = true;
          this.changed('ended', '');
          break;
        case 'error':
          this.playing = false;
          this.errorText = p.error ?? 'video error';
          this.changed('error', this.errorText);
          break;
        case 'meta':
          if (typeof p.duration === 'number') this.duration = p.duration;
          break;
        case 'time':
          if (typeof p.currentTime === 'number') this.currentTime = p.currentTime;
          if (typeof p.duration === 'number') this.duration = p.duration;
          break;
      }
      // Chrome (play glyph, seek bar, badges) follows element state.
      await this.requestRedraw();
    });
  }

  protected override async onInit(): Promise<void> {
    await super.onInit();
    await this.relaySetup();
  }

  /** Relay element creation to the client for the current source. */
  private async relaySetup(): Promise<void> {
    if (!this.source) return;
    let payload: Record<string, unknown>;
    if (this.isStream) {
      payload = { streamId: this.source };
    } else if (/^abject:/i.test(this.source)) {
      const dataUri = await this.resolveAbjectVideo(this.source);
      if (!dataUri) {
        this.errorText = `could not read ${this.source}`;
        await this.requestRedraw();
        return;
      }
      payload = { source: dataUri };
    } else {
      payload = { source: this.source };
    }
    try {
      await this.request(request(this.id, this.uiServerId, 'videoSetup', {
        videoId: this.videoId,
        ...payload,
        muted: this.muted,
        loop: this.loop,
        autoplay: this.autoplay,
        notifyId: this.id,
      }));
      this.setupDone = true;
      if (this.autoplay) this.playing = true; // optimistic; corrected by events
    } catch (err) {
      this.errorText = err instanceof Error ? err.message : String(err);
      await this.requestRedraw();
    }
  }

  /** Read abject://<typeId>/<path> bytes from the referenced FileSystem. */
  private async resolveAbjectVideo(url: string): Promise<string | null> {
    const regId = await this.resolveRegistryId();
    if (!regId) return null;
    for (const { typeId, path } of parseAbjectUrl(url)) {
      let fsId: AbjectId | null = null;
      try {
        fsId = await this.request<AbjectId | null>(
          request(this.id, regId, 'resolveType', { typeId }),
        );
      } catch { fsId = null; }
      if (!fsId) continue;
      try {
        const base64 = await this.request<string>(
          request(this.id, fsId, 'readFileBytes', { path }),
        );
        if (base64 && base64.length <= MAX_INLINE_VIDEO_BYTES * (4 / 3)) {
          return `data:${videoMimeForPath(path)};base64,${base64}`;
        }
        if (base64) {
          this.errorText = 'video file too large to play inline';
          return null;
        }
      } catch { /* read failed for a resolved typeId */ }
      return null;
    }
    return null;
  }

  private sendControl(action: 'play' | 'pause' | 'seek' | 'setMuted' | 'dispose', value?: number): void {
    this.send(request(this.id, this.uiServerId, 'videoControl', {
      videoId: this.videoId, action, value,
    }));
  }

  // ── Drawing ──────────────────────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this._renderRect.width;
    const h = this._renderRect.height;
    if (w <= 0 || h <= 0) return commands;

    // Letterbox base; also what shows before the first frame arrives.
    commands.push({
      type: 'rect', surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: '#000000',
        radius: this.style.radius ?? 0,
      },
    });

    if (this.errorText) {
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: ox + w / 2, y: oy + h / 2,
          text: this.errorText,
          font: `12px sans-serif`,
          fill: this.theme.statusError,
          align: 'center', baseline: 'middle', maxWidth: w - 16,
        },
      });
      return commands;
    }

    // Live region registration: the client composites frames into this rect
    // each animation frame. Re-emitted on every redraw so scrolling, layout
    // moves, and visibility changes all reposition or pause the blit.
    const clip = this._renderViewportClip;
    commands.push({
      type: 'videoFrame', surfaceId,
      params: {
        videoId: this.videoId,
        x: ox, y: oy, width: w, height: h,
        clipTop: clip?.top, clipBottom: clip?.bottom,
        hidden: this.visible === false,
      },
    });

    if (this.isStream) {
      // LIVE badge instead of transport controls.
      const bx = ox + 8;
      const by = oy + 8;
      commands.push({
        type: 'rect', surfaceId,
        params: { x: bx, y: by, width: 44, height: 18, fill: 'rgba(0,0,0,0.55)', radius: 9 },
      });
      commands.push({
        type: 'circle', surfaceId,
        params: { cx: bx + 11, cy: by + 9, radius: 3.5, fill: this.theme.statusError },
      });
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: bx + 19, y: by + 9, text: 'LIVE',
          font: 'bold 10px sans-serif', fill: '#ffffff', baseline: 'middle',
        },
      });
    }

    if (this.controls && !this.isStream) {
      commands.push(...this.buildControlCommands(surfaceId, ox, oy, w, h));
    }

    return commands;
  }

  private buildControlCommands(surfaceId: string, ox: number, oy: number, w: number, h: number): unknown[] {
    const commands: unknown[] = [];
    const barY = oy + h - CONTROLS_HEIGHT;

    commands.push({
      type: 'rect', surfaceId,
      params: { x: ox, y: barY, width: w, height: CONTROLS_HEIGHT, fill: 'rgba(0,0,0,0.55)' },
    });

    // Play/pause glyph in the leftmost 28px cell.
    const cx = ox + 14;
    const cy = barY + CONTROLS_HEIGHT / 2;
    if (this.playing) {
      commands.push(
        { type: 'rect', surfaceId, params: { x: cx - 5, y: cy - 6, width: 3.5, height: 12, fill: '#ffffff' } },
        { type: 'rect', surfaceId, params: { x: cx + 1.5, y: cy - 6, width: 3.5, height: 12, fill: '#ffffff' } },
      );
    } else {
      commands.push({
        type: 'polygon', surfaceId,
        params: {
          points: [
            { x: cx - 4, y: cy - 6 },
            { x: cx - 4, y: cy + 6 },
            { x: cx + 6, y: cy },
          ],
          fill: '#ffffff',
        },
      });
    }

    // Seek bar: track, progress fill, thumb.
    const trackX = ox + 30;
    const trackW = Math.max(10, w - 38);
    const trackY = cy - 2;
    const ratio = this.duration > 0 ? Math.min(1, this.currentTime / this.duration) : 0;
    commands.push({
      type: 'rect', surfaceId,
      params: { x: trackX, y: trackY, width: trackW, height: 4, fill: withAlpha('#ffffff', 0.25), radius: 2 },
    });
    if (ratio > 0) {
      commands.push({
        type: 'rect', surfaceId,
        params: { x: trackX, y: trackY, width: trackW * ratio, height: 4, fill: this.theme.accent, radius: 2 },
      });
    }
    commands.push({
      type: 'circle', surfaceId,
      params: { cx: trackX + trackW * ratio, cy: trackY + 2, radius: 5, fill: '#ffffff' },
    });

    return commands;
  }

  // ── Input ────────────────────────────────────────────────────────────

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type !== 'mousedown') return { consumed: false };
    if (this.errorText || !this.setupDone) return { consumed: false };
    const x = (input.x as number) ?? 0;
    const y = (input.y as number) ?? 0;
    const w = this.rect.width;
    const h = this.rect.height;

    if (this.controls && !this.isStream && y >= h - CONTROLS_HEIGHT) {
      const trackX = 30;
      const trackW = Math.max(10, w - 38);
      if (x >= trackX - 4 && x <= trackX + trackW + 4 && this.duration > 0) {
        // Seek: clamp click to the track and jump.
        const ratio = Math.max(0, Math.min(1, (x - trackX) / trackW));
        this.currentTime = ratio * this.duration;
        this.sendControl('seek', this.currentTime);
        await this.requestRedraw();
        return { consumed: true };
      }
      // Anything else on the bar (the glyph cell) toggles playback.
      this.togglePlayback();
      return { consumed: true };
    }

    if (this.controls && !this.isStream) {
      // Click on the picture toggles playback too, the familiar idiom.
      this.togglePlayback();
      return { consumed: true };
    }

    return { consumed: false };
  }

  private togglePlayback(): void {
    if (this.playing) {
      this.sendControl('pause');
      this.playing = false;
    } else {
      this.sendControl('play');
      this.playing = true;
      this.ended = false;
    }
    void this.requestRedraw();
  }

  // ── Lifecycle / updates ──────────────────────────────────────────────

  protected getWidgetValue(): string {
    return JSON.stringify({
      playing: this.playing,
      ended: this.ended,
      currentTime: this.currentTime,
      duration: this.duration,
    });
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.muted !== undefined) {
      this.muted = updates.muted as boolean;
      this.sendControl('setMuted', this.muted ? 1 : 0);
    }
    if (updates.loop !== undefined) {
      this.loop = updates.loop as boolean;
      // Loop changes take effect on the next setup (source swap).
    }
    if (updates.source !== undefined && updates.source !== this.source) {
      // Swap: dispose the old element, reset state, set up the new source.
      this.sendControl('dispose');
      this.source = updates.source as string;
      this.controls = (updates.controls as boolean | undefined) ?? !this.isStream;
      this.playing = false;
      this.ended = false;
      this.duration = 0;
      this.currentTime = 0;
      this.errorText = '';
      this.setupDone = false;
      void this.relaySetup();
    } else if (updates.controls !== undefined) {
      this.controls = updates.controls as boolean;
    }
  }

  protected override async onStop(): Promise<void> {
    // Tear down the client element; also drops its compositor region.
    try { this.sendControl('dispose'); } catch { /* client may be gone */ }
    await super.onStop();
  }
}
