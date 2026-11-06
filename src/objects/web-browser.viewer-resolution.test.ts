/**
 * The page follows the viewer window it is shown in.
 *
 * A window larger than the page's layout is served by a picture encoded from a
 * capture that size, so text and fine detail keep their pixels instead of being
 * upscaled. The layout is only ever grown (a smaller window is a downscale,
 * which stays sharp), the requested size must hold for two polls so a window
 * being dragged does not reflow the page on every frame, and a page that
 * refuses is left alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebBrowser } from './capabilities/web-browser.js';
import { encodePngFrame, type RgbaFrame } from './frame-diff.js';
import type { AbjectId } from '../core/types.js';

const OWNER = 'owner-id' as AbjectId;
const PAGE_ID = 'page-resolution-1';

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

  return { browser, page, internals, encoded, poll };
}

test('the display size reaches the encode unchanged', async () => {
  const { encoded, poll } = harness(fakePage({ width: 1280, height: 720 }));
  await poll({ width: 1000, height: 640 });
  assert.deepEqual(encoded[0]!.options.display, { width: 1000, height: 640 });
});

test('a larger window lays the page out once the size holds, and the capture follows', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { encoded, poll } = harness(page);

  // First sight of the size: nothing is reflowed yet.
  await poll({ width: 1600, height: 1000 });
  assert.deepEqual(page.resizes, [], 'the page was reflowed on the first poll it saw');
  assert.deepEqual([encoded[0]!.frame.width, encoded[0]!.frame.height], [1280, 720]);

  // The same size again: it held, so the page is laid out to match.
  await poll({ width: 1600, height: 1000 });
  assert.deepEqual(page.resizes, [{ width: 1600, height: 1000 }]);
  assert.deepEqual([encoded[1]!.frame.width, encoded[1]!.frame.height], [1600, 1000],
    'the capture did not follow the enlarged layout');
});

test('a size that changes every poll reflows nothing', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { poll } = harness(page);
  for (const width of [1500, 1520, 1560, 1620]) {
    await poll({ width, height: 1000 });
  }
  assert.deepEqual(page.resizes, [], 'a window being dragged reflowed the page mid-drag');
});

test('a window smaller than the layout never shrinks the page', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { poll } = harness(page);
  await poll({ width: 800, height: 600 });
  await poll({ width: 800, height: 600 });
  assert.deepEqual(page.resizes, [], 'the page was reflowed for a window that only downscales');
});

test('the layout a window may ask for is capped', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  const { poll } = harness(page);
  await poll({ width: 4000, height: 3000 });
  await poll({ width: 4000, height: 3000 });
  assert.deepEqual(page.resizes, [{ width: 1920, height: 1080 }]);
});

test('a page that refuses the layout is left alone after one refusal', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  page.refuseResize = true;
  const { internals, poll } = harness(page);

  await poll({ width: 1600, height: 1000 });
  await poll({ width: 1600, height: 1000 });
  assert.equal(page.attempts, 1, 'the refusal was not remembered');
  assert.ok(internals.layoutFixed.has(PAGE_ID));

  await poll({ width: 1800, height: 1000 });
  await poll({ width: 1800, height: 1000 });
  assert.equal(page.attempts, 1, 'a page that cannot be laid out was asked again');
});

test('releasing a page forgets what it was asked for', async () => {
  const page = fakePage({ width: 1280, height: 720 });
  page.refuseResize = true;
  const { internals, poll } = harness(page);
  await poll({ width: 1600, height: 1000 });
  await poll({ width: 1600, height: 1000 });
  assert.ok(internals.layoutFixed.has(PAGE_ID));

  internals.releasePage(PAGE_ID);
  assert.equal(internals.layoutFixed.has(PAGE_ID), false);
  assert.equal(internals.pendingDisplaySizes.has(PAGE_ID), false);
});
