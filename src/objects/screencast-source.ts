/**
 * Push-based page capture: `Page.startScreencast`, newest frame wins.
 *
 * `page.screenshot()` costs a full capture round trip on every poll — measured
 * at 57 ms on an animated page, which is why the web viewer's frame feed never
 * got past a handful of frames per second however low the poll interval went.
 * A screencast inverts the direction: the renderer pushes a frame whenever it
 * paints, and this object keeps only the newest one. The viewer's poll then
 * drains whatever arrived instead of asking the browser for a picture, so an
 * unconsumed frame costs a dropped frame rather than a stalled pipeline.
 *
 * Everything downstream is unchanged: the caller decodes the pushed PNG and
 * hands it to the same scale / YUV / VP8 path as a screenshot used to take.
 */

import { require } from '../core/contracts.js';

/** One frame pushed by the renderer. */
export interface ScreencastFrameEvent {
  /** Base64 of the encoded image (PNG unless the source was told otherwise). */
  data: string;
  /** Handle the ack must quote back. */
  sessionId: number;
  /** Page-reported capture metadata (timestamp is seconds since epoch). */
  metadata?: { timestamp?: number; [key: string]: unknown };
}

/**
 * The slice of a CDP session the screencast needs. Playwright's `CDPSession`
 * satisfies it as it stands; a test can stand in a fake.
 */
export interface ScreencastCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'Page.screencastFrame', handler: (event: ScreencastFrameEvent) => void): void;
  off(event: 'Page.screencastFrame', handler: (event: ScreencastFrameEvent) => void): void;
  detach(): Promise<void>;
}

/** What to ask the renderer for. Defaults suit the viewer's VP8 stage. */
export interface ScreencastOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

/** A frame waiting to be encoded, or the last one that was. */
export interface PushedFrame {
  /** Encoded image bytes, exactly as the renderer sent them. */
  data: Buffer;
  format: 'png' | 'jpeg';
  /** Page-reported capture time in seconds, when the browser sends it. */
  capturedAt?: number;
}

export class ScreencastSource {
  private newest?: PushedFrame;
  private last?: PushedFrame;
  private started = false;
  private stopped = false;
  private pushed = 0;
  private taken = 0;
  private superseded = 0;
  private waiters: Set<() => void> = new Set();

  constructor(
    private readonly cdp: ScreencastCdp,
    private readonly options: ScreencastOptions = {},
  ) {}

  /** Ask the renderer to start pushing. Throws if this host refuses. */
  async start(): Promise<void> {
    require(!this.started, 'ScreencastSource.start called twice');
    this.cdp.on('Page.screencastFrame', this.onFrame);
    this.started = true;
    try {
      await this.cdp.send('Page.startScreencast', {
        format: this.options.format ?? 'png',
        ...(this.options.quality !== undefined ? { quality: this.options.quality } : {}),
        ...(this.options.maxWidth !== undefined ? { maxWidth: this.options.maxWidth } : {}),
        ...(this.options.maxHeight !== undefined ? { maxHeight: this.options.maxHeight } : {}),
        everyNthFrame: this.options.everyNthFrame ?? 1,
      });
    } catch (err) {
      this.cdp.off('Page.screencastFrame', this.onFrame);
      this.started = false;
      throw err;
    }
  }

  /**
   * Take the newest frame, if one has arrived since the last take. A frame
   * still waiting when a fresh one arrives is dropped: the viewer wants the
   * present picture, not a backlog of past ones.
   */
  takeNewest(): PushedFrame | undefined {
    const frame = this.newest;
    if (!frame) return undefined;
    this.newest = undefined;
    this.last = frame;
    this.taken += 1;
    return frame;
  }

  /** The last frame handed out — re-encoded when a client asks for a key frame. */
  lastFrame(): PushedFrame | undefined {
    return this.last;
  }

  /**
   * Resolve as soon as a frame is waiting — the first poll needs pixels before
   * it can encode anything — or after `timeoutMs` with nothing, which tells the
   * caller this host is not going to push.
   */
  async waitForFrame(timeoutMs: number): Promise<PushedFrame | undefined> {
    require(timeoutMs > 0, 'waitForFrame needs a positive timeout');
    const waiting = this.takeNewest();
    if (waiting) return waiting;
    return new Promise<PushedFrame | undefined>((resolve) => {
      let settled = false;
      // A woken waiter takes the frame the same way a poll does, so a frame
      // that wakes several waiters is served once and not handed out twice.
      const wake = (): void => {
        if (settled) return;
        const taken = this.stopped ? undefined : this.takeNewest();
        if (!taken && !this.stopped) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(taken);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.delete(wake);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.add(wake);
    });
  }

  /** Wake whoever waits on the next frame; called for each arriving frame. */
  private wakeWaiters(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Stop the push and let the CDP session go. Safe to call more than once. */
  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.cdp.off('Page.screencastFrame', this.onFrame);
    this.newest = undefined;
    // A poll waiting for a frame that will never come is told so, rather than
    // sitting out its own timeout.
    for (const waiter of [...this.waiters]) waiter();
    this.waiters.clear();
    try {
      await this.cdp.send('Page.stopScreencast', {});
    } catch { /* the page is already gone */ }
    try {
      await this.cdp.detach();
    } catch { /* already detached */ }
  }

  /** True once the push has been stopped, so a draining reader can stop too. */
  get isStopped(): boolean {
    return this.stopped;
  }

  get stats(): { pushed: number; taken: number; superseded: number; pending: boolean } {
    return {
      pushed: this.pushed,
      taken: this.taken,
      superseded: this.superseded,
      pending: this.newest !== undefined,
    };
  }

  private readonly onFrame = (event: ScreencastFrameEvent): void => {
    // Ack every frame, including the ones thrown away: the ack is what lets the
    // renderer send the next one.
    void this.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    const data = Buffer.from(event.data, 'base64');
    require(data.length > 0, 'screencast frame carried no data');
    if (this.newest) this.superseded += 1;
    this.pushed += 1;
    const frame: PushedFrame = {
      data,
      format: this.options.format ?? 'png',
      capturedAt: event.metadata?.timestamp,
    };
    this.newest = frame;
    this.wakeWaiters();
  };
}
