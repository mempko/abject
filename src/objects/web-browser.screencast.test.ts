/**
 * The viewer's pixels come from a screencast, not from a screenshot per poll.
 *
 * These tests pin the drain semantics of that capture on WebBrowser itself,
 * with a fake page and a fake CDP session: a pushed frame is what gets encoded,
 * a poll that finds nothing new reports the stream unchanged *without* taking a
 * screenshot, a host with no CDP session (or one that refuses the command, or
 * accepts it and pushes nothing) falls back to the old per-poll capture, and a
 * released page leaves no screencast running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebBrowser } from './capabilities/web-browser.js';
import { ScreencastSource, type ScreencastCdp, type ScreencastFrameEvent } from './screencast-source.js';
import { encodePngFrame, type RgbaFrame } from './frame-diff.js';
import type { AbjectId } from '../core/types.js';

const OWNER = 'owner-id' as AbjectId;

function solidFrame(width: number, height: number, shade: number): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = shade;
    data[i + 1] = shade;
    data[i + 2] = shade;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

class FakeCdp implements ScreencastCdp {
  readonly sent: string[] = [];
  detached = 0;
  startError?: Error;
  private handlers: Array<(event: ScreencastFrameEvent) => void> = [];

  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    if (method === 'Page.startScreencast' && this.startError) throw this.startError;
    return {};
  }
  on(_e: 'Page.screencastFrame', h: (event: ScreencastFrameEvent) => void): void { this.handlers.push(h); }
  off(_e: 'Page.screencastFrame', h: (event: ScreencastFrameEvent) => void): void {
    this.handlers = this.handlers.filter((x) => x !== h);
  }
  async detach(): Promise<void> { this.detached += 1; }
  push(frame: RgbaFrame, sessionId = 1): void {
    const data = Buffer.from(encodePngFrame(frame)).toString('base64');
    for (const h of [...this.handlers]) h({ data, sessionId });
  }
  count(method: string): number {
    return this.sent.filter((m) => m === method).length;
  }
}

/** A page that counts the screenshots asked of it, over a CDP session or none. */
function fakePage(cdp: ScreencastCdp | null) {
  const page = {
    screenshots: 0,
    url: () => 'https://example.test/',
    title: async () => 'Example',
    async screenshot(): Promise<Buffer> {
      page.screenshots += 1;
      return Buffer.from(encodePngFrame(solidFrame(8, 8, 40)));
    },
    context: () => (cdp === null ? {} : { newCDPSession: async () => cdp }),
  };
  return page;
}

interface Harness {
  browser: WebBrowser;
  page: ReturnType<typeof fakePage>;
  pageId: string;
  poll: () => Promise<any>;
  release: () => void;
  encoded: RgbaFrame[];
  internals: any;
}

/** A browser with one tracked page, polling through the real drain path. */
function harness(cdp: ScreencastCdp | null): Harness {
  const browser = new WebBrowser();
  const page = fakePage(cdp);
  const pageId = 'page-test-1';
  const internals = browser as any;
  internals.pages.set(pageId, { page, owner: OWNER, createdAt: Date.now(), lastActivity: Date.now() });

  // Record what reaches the encoder instead of running libav in a unit test.
  const encoded: RgbaFrame[] = [];
  internals.nextViewerVideoFrame = async (_pageId: string, frame: RgbaFrame) => {
    encoded.push(frame);
    return {
      kind: 'video', seq: encoded.length, key: encoded.length === 1,
      width: 960, height: 540, sourceWidth: frame.width, sourceHeight: frame.height,
      codec: 'vp8', chunks: [{ type: 'key', timestamp: 0, data: '' }],
    };
  };

  return {
    browser,
    page,
    pageId,
    internals,
    encoded,
    poll: () => internals.nextViewerVideoReply(pageId, internals.pages.get(pageId), undefined),
    release: () => internals.releasePage(pageId),
  };
}

/** Let a poll reach the point where it waits for the renderer. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('the first poll starts a screencast and encodes the pushed frame', async () => {
  const cdp = new FakeCdp();
  const { page, pageId, poll, encoded, internals } = harness(cdp);

  const pending = poll();
  await tick();
  cdp.push(solidFrame(12, 6, 77));
  const reply = await pending;

  assert.equal(reply.kind, 'video');
  assert.equal(page.screenshots, 0, 'the screenshot path was not used');
  assert.equal(encoded.length, 1);
  assert.equal(encoded[0]!.width, 12);
  assert.equal(encoded[0]!.height, 6);
  assert.equal(cdp.count('Page.startScreencast'), 1);
  assert.ok(internals.screencastSources.has(pageId));
});

test('a poll with no new frame reports unchanged without capturing anything', async () => {
  const cdp = new FakeCdp();
  const { page, pageId, poll, internals } = harness(cdp);

  const first = poll();
  await tick();
  cdp.push(solidFrame(8, 8, 10));
  await first;
  internals.viewerVideoStreams.set(pageId, {
    width: 960, height: 540, seq: 4, lastKeyAt: 0, lastFrame: new Uint8Array(0),
    keyFrames: 1, deltas: 3, unchangedTicks: 0, bytesSent: 0,
  });

  const idle = await poll();
  assert.equal(idle.kind, 'unchanged');
  assert.deepEqual(idle.chunks, []);
  assert.equal(page.screenshots, 0, 'an idle poll costs no capture');
  assert.equal(internals.viewerVideoStreams.get(pageId).unchangedTicks, 1);
});

test('a forced key frame re-encodes the last frame when a still page pushes nothing', async () => {
  const cdp = new FakeCdp();
  const { page, pageId, poll, encoded, internals } = harness(cdp);

  const first = poll();
  await tick();
  cdp.push(solidFrame(8, 8, 10));
  await first;
  internals.viewerVideoStreams.set(pageId, {
    width: 960, height: 540, seq: 4, lastKeyAt: 0, lastFrame: new Uint8Array(0),
    keyFrames: 1, deltas: 3, unchangedTicks: 0, bytesSent: 0,
  });

  const forced = await internals.nextViewerVideoReply(
    pageId, internals.pages.get(pageId), { forceKey: true },
  );
  assert.equal(forced.kind, 'video');
  assert.equal(encoded.length, 2, 'a key frame was encoded from the pixels already held');
  assert.equal(page.screenshots, 0);
});

test('a page with no CDP session keeps the per-poll screenshot', async () => {
  const { page, poll } = harness(null);
  const reply = await poll();
  assert.equal(reply.kind, 'video');
  assert.equal(page.screenshots, 1, 'a host that cannot screencast still delivers pixels');
});

test('a host that refuses startScreencast falls back and is not asked again', async () => {
  const cdp = new FakeCdp();
  cdp.startError = new Error('screencast not allowed');
  const { page, pageId, poll, internals } = harness(cdp);

  await poll();
  await poll();
  assert.equal(page.screenshots, 2);
  assert.equal(cdp.count('Page.startScreencast'), 1, 'the refusal is remembered');
  assert.ok(internals.screencastRefused.has(pageId));
});

test('a host that accepts the command but never pushes falls back after the wait', async () => {
  const cdp = new FakeCdp();
  const { page, pageId, poll, internals } = harness(cdp);
  const original = WebBrowser.SCREENCAST_FIRST_FRAME_WAIT_MS;
  Object.defineProperty(WebBrowser, 'SCREENCAST_FIRST_FRAME_WAIT_MS', { value: 5, configurable: true });
  try {
    const reply = await poll();
    assert.equal(reply.kind, 'video');
    assert.equal(page.screenshots, 1, 'the silent host was captured the old way');
    assert.equal(cdp.count('Page.stopScreencast'), 1, 'the silent push was stopped');
    assert.ok(internals.screencastRefused.has(pageId));
  } finally {
    Object.defineProperty(WebBrowser, 'SCREENCAST_FIRST_FRAME_WAIT_MS', { value: original, configurable: true });
  }
});

test('releasing a page stops its screencast and drops its CDP session', async () => {
  const cdp = new FakeCdp();
  const { pageId, poll, release, internals } = harness(cdp);

  const first = poll();
  await tick();
  cdp.push(solidFrame(8, 8, 99));
  await first;
  assert.ok(internals.screencastSources.has(pageId));

  release();
  await tick();
  assert.equal(internals.screencastSources.has(pageId), false);
  assert.equal(internals.captureSessions.has(pageId), false);
  assert.equal(cdp.count('Page.stopScreencast'), 1, 'the renderer was told to stop pushing');
  assert.equal(cdp.detached, 1);
});

test('stopping the capability stops every push', async () => {
  const cdp = new FakeCdp();
  const { poll, internals } = harness(cdp);
  const first = poll();
  await tick();
  cdp.push(solidFrame(8, 8, 5));
  await first;

  await internals.stopAllScreencasts();
  assert.equal(internals.screencastSources.size, 0);
  assert.equal(cdp.detached, 1);
});

test('ScreencastSource waits for the first pushed frame and gives up on time', async () => {
  const cdp = new FakeCdp();
  const source = new ScreencastSource(cdp, { format: 'png' });
  await source.start();

  const waiting = source.waitForFrame(200);
  cdp.push(solidFrame(8, 8, 3));
  const frame = await waiting;
  assert.ok(frame, 'the waiting poll got the pushed frame');
  assert.equal(frame!.format, 'png');

  const empty = await source.waitForFrame(5);
  assert.equal(empty, undefined, 'a silent page times out instead of hanging the poll');
  await source.stop();
});
