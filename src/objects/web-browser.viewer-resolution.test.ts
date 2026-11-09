/**
 * The page follows the viewer window it is shown in.
 *
 * The layout follows the window in both directions: a larger window is served
 * by a picture encoded from a capture that size, so text and fine detail keep
 * their pixels instead of being upscaled, and a smaller window is laid out
 * again so the picture keeps matching the window rather than staying a
 * downscale of a layout the person no longer has. A requested size must hold
 * still for a moment, so a window being dragged neither reflows the page nor
 * restarts the encoder, and a page that refuses is left alone. A window that
 * comes to rest at a new size is answered even when the page is not painting:
 * the picture must not keep the old size until something happens to repaint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebBrowser } from './capabilities/web-browser.js';
import { encodePngFrame, type RgbaFrame } from './frame-diff.js';
import type { AbjectId } from '../core/types.js';

const OWNER = 'owner-id' as AbjectId;
const PAGE_ID = 'page-resolution-1';

/** Comfortably longer than the settle window, as a person's pause would be. */
const SETTLE_MS = 400;

/** Let the pump's screenshot and encode run to completion. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

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

/** A page that reports its layout, honours a resize, and captures at that size. */
function fakePage(initial: { width: number; height: number }) {
  const page = {
    layout: { ...initial },
    resizes: [] as Array<{ width: number; height: number }>,
    attempts: 0,
    refuseResize: false,
    viewportSize() { return { ...page.layout }; },
    async setViewportSize(size: { width: number; height: number }) {
      page.attempts += 1;
      if (page.refuseResize) throw new Error('this page will not be laid out');
      page.resizes.push({ ...size });
      page.layout = { ...size };
    },
    url: () => 'https://example.test/',
    title: async () => 'Example',
    // A real capture is the page's own pixel size, so the frame proves which
    // layout the screenshot came from.
    async screenshot(): Promise<Buffer> {
      return Buffer.from(encodePngFrame(solidFrame(page.layout.width, page.layout.height, 40)));
    },
    context: () => ({}),
  };
  return page;
}

/**
 * The settle rules are timed, so a drag can be held still without sleeping. The
 * test owns the clock and moves it by hand.
 */
function withClock(internals: any): { advance: (ms: number) => Promise<void> } {
  let now = 1_000_000;
  internals.resizeClock = () => now;
  return {
    advance: async (ms: number) => {
      now += ms;
      await flush();
    },
  };
}

function harness(page: ReturnType<typeof fakePage>) {
  const browser = new WebBrowser();
  const internals = browser as any;
  internals.pages.set(PAGE_ID, {
    page, owner: OWNER, createdAt: Date.now(), lastActivity: Date.now(),
  });
  // The per-poll capture path, so the test needs no CDP session: what matters
  // here is which layout the pixels come from.
  internals.screencastRefused.add(PAGE_ID);

  const encoded: Array<{ frame: RgbaFrame; options: any }> = [];
  internals.nextViewerVideoFrame = async (_pageId: string, frame: RgbaFrame, options?: unknown) => {
    encoded.push({ frame, options });
    return {
      kind: 'video', seq: encoded.length, key: true,
      width: frame.width, height: frame.height,
      sourceWidth: frame.width, sourceHeight: frame.height,
      codec: 'vp8', chunks: [{ type: 'key', timestamp: 0, data: '' }],
    };
  };

  const poll = (display?: { width: number; height: number }) =>
    internals.nextViewerVideoReply(
      PAGE_ID, internals.pages.get(PAGE_ID), display ? { display } : undefined,
    );

  const { advance } = withClock(internals);
  return { browser, page, internals, encoded, poll, advance };
}

/** A page with a screencast that pushes nothing unless the test says so. */
function stillPageHarness(page: ReturnType<typeof fakePage>) {
  const browser = new WebBrowser();
  const internals = browser as any;
  internals.pages.set(PAGE_ID, {
    page, owner: OWNER, createdAt: Date.now(), lastActivity: Date.now(),
  });

  const pushed: Array<{ data: Buffer; format: string; capturedAt: number }> = [];
  let wake: ((frame?: unknown) => void) | undefined;
  let nudgeCount = 0;
  const source = {
    isStopped: false,
    stats: { pushed: 0, taken: 0, superseded: 0, pending: false },
    takeNewest: () => pushed.shift(),
    lastFrame: () => undefined,
    waitForFrame: () => {
      const ready = pushed.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<unknown>((resolve) => { wake = resolve; });
    },
    nudge: () => {
      nudgeCount += 1;
      const waiting = wake;
      wake = undefined;
      waiting?.(undefined);
    },
  };
  internals.ensureScreencast = async () => source;

  const encoded: Array<{ frame: RgbaFrame; options: any }> = [];
  internals.nextViewerVideoFrame = async (_pageId: string, frame: RgbaFrame, options?: unknown) => {
    encoded.push({ frame, options });
    return {
      kind: 'video', seq: encoded.length, key: true,
      width: frame.width, height: frame.height,
      sourceWidth: frame.width, sourceHeight: frame.height,
      codec: 'vp8', chunks: [{ type: 'key', timestamp: 0, data: '' }],
    };
  };

  const poll = (display: { width: number; height: number }) =>
    internals.nextViewerVideoReply(PAGE_ID, internals.pages.get(PAGE_ID), { display });

  const { advance } = withClock(internals);
  return { internals, encoded, poll, advance, pushed, nudges: () => nudgeCount };
}

test('the display size reaches the encode unchanged', async () => {
  const { encoded, poll } = harness(fakePage({ width: 1280, height: 720 }));
  await poll({ width: 1000, height: 640 });
  assert.deepEqual(encoded[0]!.options.display, { width: 1000, height: 640 });
});

test('a larger window lays the page out once the size holds, and the capture follows', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { encoded, poll, advance } = harness(page);

  // First sight of the size: nothing is reflowed yet.
  await poll({ width: 1600, height: 1000 });
  assert.deepEqual(page.resizes, [], 'the page was reflowed on the first poll it saw');
  assert.deepEqual([encoded[0]!.frame.width, encoded[0]!.frame.height], [1280, 720]);

  // The same size, still, a moment later: it held, so the page is laid out to match.
  await advance(SETTLE_MS);
  await poll({ width: 1600, height: 1000 });
  assert.deepEqual(page.resizes, [{ width: 1600, height: 1000 }]);
  assert.deepEqual([encoded[1]!.frame.width, encoded[1]!.frame.height], [1600, 1000],
    'the capture did not follow the enlarged layout');
});

test('a size that changes every poll reflows nothing', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { poll, advance } = harness(page);
  for (const width of [1500, 1520, 1560, 1620]) {
    await poll({ width, height: 1000 });
    await advance(20);
  }
  assert.deepEqual(page.resizes, [], 'a window being dragged reflowed the page mid-drag');
});

test('a drag holds the encode size until the window stops moving', async () => {
  const { internals, advance } = harness(fakePage({ width: 1280, height: 720 }));
  const pump = internals.viewerVideoPumpFor(PAGE_ID);

  assert.equal(internals.settlePumpDisplay(pump, { width: 1280, height: 720 }), false);
  assert.deepEqual(pump.display, { width: 1280, height: 720 },
    'the first size a page is shown at was not adopted at once');

  // A drag reports a new size every couple of polls. A new encode size restarts
  // the VP8 stream, so following it here would freeze the picture for the drag.
  for (const width of [1500, 1520, 1560, 1620, 1580, 1640]) {
    const height = Math.round(width * 0.625);
    assert.equal(internals.settlePumpDisplay(pump, { width, height }), false);
    await advance(20);
    assert.equal(internals.settlePumpDisplay(pump, { width, height }), false,
      `the encode re-targeted mid-drag at ${width}px, restarting the stream`);
    assert.deepEqual(pump.display, { width: 1280, height: 720 });
  }

  // The window came to rest, and stayed there: the next poll of that size is followed.
  await advance(SETTLE_MS);
  assert.equal(internals.settlePumpDisplay(pump, { width: 1640, height: 1025 }), true);
  assert.deepEqual(pump.display, { width: 1640, height: 1025 },
    'the encode did not follow the size the window stopped at');
});

test('a smaller window lays the page out again, and the capture follows', async () => {
  const page = fakePage({ width: 1600, height: 1000 });
  const { encoded, poll, advance } = harness(page);

  await poll({ width: 1000, height: 740 });
  assert.deepEqual(page.resizes, [], 'the page was reflowed on the first poll it saw');

  await advance(SETTLE_MS);
  await poll({ width: 1000, height: 740 });
  assert.deepEqual(page.resizes, [{ width: 1000, height: 740 }],
    'the page kept a layout larger than the window it is shown in');
  assert.deepEqual([encoded[1]!.frame.width, encoded[1]!.frame.height], [1000, 740],
    'the capture did not follow the shrunken layout');
  assert.deepEqual([encoded[1]!.options.display.width, encoded[1]!.options.display.height], [1000, 740],
    'the encode was not aimed at the window it is painted into');
});

test('a window grown and then shrunk again ends with the page at the window size', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { encoded, poll, advance } = harness(page);

  await poll({ width: 1600, height: 1000 });
  await advance(SETTLE_MS);
  await poll({ width: 1600, height: 1000 });
  assert.deepEqual([page.layout.width, page.layout.height], [1600, 1000]);

  await poll({ width: 1456, height: 894 });
  await advance(SETTLE_MS);
  await poll({ width: 1456, height: 894 });
  assert.deepEqual([page.layout.width, page.layout.height], [1456, 894],
    'the page stayed at the size of a window the person already resized away from');

  const last = encoded[encoded.length - 1]!;
  assert.deepEqual([last.frame.width, last.frame.height], [1456, 894]);
  assert.deepEqual([last.options.display.width, last.options.display.height], [1456, 894],
    'the delivered picture did not match the page layout within a pixel');
});

test('the layout a window may ask for is capped', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { poll, advance } = harness(page);
  await poll({ width: 4000, height: 3000 });
  await advance(SETTLE_MS);
  await poll({ width: 4000, height: 3000 });
  assert.deepEqual(page.resizes, [{ width: 1920, height: 1080 }]);
});

test('a page that refuses the layout is left alone after one refusal', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  page.refuseResize = true;
  const { internals, poll, advance } = harness(page);

  await poll({ width: 1600, height: 1000 });
  await advance(SETTLE_MS);
  await poll({ width: 1600, height: 1000 });
  assert.equal(page.attempts, 1, 'the refusal was not remembered');
  assert.ok(internals.layoutFixed.has(PAGE_ID));

  await poll({ width: 1800, height: 1000 });
  await advance(SETTLE_MS);
  await poll({ width: 1800, height: 1000 });
  assert.equal(page.attempts, 1, 'a page that cannot be laid out was asked again');
});

test('releasing a page forgets what it was asked for', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  page.refuseResize = true;
  const { internals, poll, advance } = harness(page);
  await poll({ width: 1600, height: 1000 });
  await advance(SETTLE_MS);
  await poll({ width: 1600, height: 1000 });
  assert.ok(internals.layoutFixed.has(PAGE_ID));

  internals.releasePage(PAGE_ID);
  assert.equal(internals.layoutFixed.has(PAGE_ID), false);
  assert.equal(internals.pendingDisplaySizes.has(PAGE_ID), false);
});

test('a window that comes to rest is drawn at its new size without a repaint', async () => {
  const page = fakePage({ width: 1000, height: 700 });
  const { encoded, poll, advance, pushed, nudges } = stillPageHarness(page);

  // The page pushes one frame and then goes quiet, as a loaded page does.
  pushed.push({
    data: Buffer.from(encodePngFrame(solidFrame(1000, 700, 40))),
    format: 'png',
    capturedAt: 0,
  });
  await poll({ width: 1000, height: 700 });
  await flush();
  assert.equal(encoded.length, 1, 'the pushed frame was not encoded');

  // The window is resized. The page has nothing to paint, so nothing is pushed.
  await poll({ width: 1400, height: 1000 });
  await advance(SETTLE_MS);
  await poll({ width: 1400, height: 1000 });
  await flush();

  assert.ok(nudges() >= 1, 'the pump was left waiting for a repaint that never came');
  assert.ok(encoded.length >= 2, 'nothing was encoded for the settled size');
  const last = encoded[encoded.length - 1]!;
  assert.deepEqual([last.options.display.width, last.options.display.height], [1400, 1000],
    'the encode was not aimed at the size the person resized to');
  assert.deepEqual([last.frame.width, last.frame.height], [1400, 1000],
    'the picture kept the old page layout, so the resize was never drawn');
});
