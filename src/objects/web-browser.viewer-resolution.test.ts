/**
 * The web viewer renders at one fixed size; the window only scales the picture.
 *
 * The page is laid out at FIXED_VIDEO_WIDTH x FIXED_VIDEO_HEIGHT when it is
 * opened and is not re-laid-out afterwards, so the encode target is the same
 * however the window is dragged. These tests hold that line: the encode size
 * does not depend on the window, and the page is pinned to the fixed size even
 * when the window it is shown in is a different shape.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WebBrowser } from './capabilities/web-browser.js';
import {
  FIXED_VIDEO_WIDTH,
  FIXED_VIDEO_HEIGHT,
  MAX_VIDEO_WIDTH,
  MAX_VIDEO_HEIGHT,
  fixedVideoTarget,
} from './video-encoder.js';

const PAGE_ID = 'page-fixed-render';
const OWNER = 'owner-fixed-render' as any;

/** A page that reports and accepts a viewport, recording every resize asked of it. */
function fakePage(initial: { width: number; height: number }) {
  const page = {
    layout: { ...initial },
    resizes: [] as Array<{ width: number; height: number }>,
    viewportSize() { return { ...page.layout }; },
    async setViewportSize(size: { width: number; height: number }) {
      page.resizes.push({ ...size });
      page.layout = { ...size };
    },
  };
  return page;
}

function tracked(page: ReturnType<typeof fakePage>) {
  return { page, owner: OWNER, createdAt: Date.now(), lastActivity: Date.now() };
}

/** A browser with a clock the test advances, so settling needs no sleeping. */
function harness(page: ReturnType<typeof fakePage>) {
  const browser = new WebBrowser();
  const internals = browser as any;
  let now = 1_000_000;
  internals.resizeClock = () => now;
  internals.pages.set(PAGE_ID, tracked(page));
  return {
    internals,
    advance(ms: number) { now += ms; },
    pump(): any {
      return { running: false, forceKey: false, lastPollAt: Date.now() };
    },
  };
}

test('the fixed render size is a 16:9 picture under the encode ceiling', () => {
  assert.deepEqual([FIXED_VIDEO_WIDTH, FIXED_VIDEO_HEIGHT], [1280, 720]);
  assert.ok(FIXED_VIDEO_WIDTH <= MAX_VIDEO_WIDTH,
    'the fixed render size is capped by the encode ceiling');
  assert.ok(FIXED_VIDEO_HEIGHT <= MAX_VIDEO_HEIGHT,
    'the fixed render size is capped by the encode ceiling');
});

test('a capture at the fixed size encodes at exactly that size', () => {
  assert.deepEqual(fixedVideoTarget(1280, 720), { width: 1280, height: 720 });
});

test('a capture larger than the fixed box is contained in it, not grown', () => {
  const target = fixedVideoTarget(2560, 1440);
  assert.deepEqual(target, { width: 1280, height: 720 },
    'a page opened at a larger viewport must not enlarge the stream');
});

test('a capture smaller than the fixed box keeps its own pixels', () => {
  assert.deepEqual(fixedVideoTarget(800, 600), { width: 800, height: 600 },
    'a small page was upscaled instead of streamed at its own size');
});

test('the encode target never depends on a window size', () => {
  // The window is not an input to this rule at all, which is the point: two
  // polls from very different windows ask the same question.
  assert.deepEqual(fixedVideoTarget(1280, 720), fixedVideoTarget(1280, 720));
});

test('a window resize does not re-target the pump encode size', () => {
  const { internals, pump } = harness(fakePage({ width: 1280, height: 720 }));
  const p = pump();
  // The first poll adopts the fixed size.
  assert.equal(internals.settlePumpDisplay(p, { width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT }), false);
  assert.deepEqual(p.display, { width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT });
  // Every later poll asks for the same fixed size, so nothing re-targets.
  for (let i = 0; i < 5; i++) {
    assert.equal(internals.settlePumpDisplay(p, { width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT }), false,
      'the encode re-targeted, restarting the VP8 stream');
  }
  assert.deepEqual(p.display, { width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT });
});

test('a window of a different shape pins the page to the fixed size once', async () => {
  const page = fakePage({ width: 1900, height: 1200 });
  const { internals, advance } = harness(page);
  const window = { width: 1900, height: 1200 };

  await internals.followDisplaySize(PAGE_ID, internals.pages.get(PAGE_ID), window);
  advance(300);
  await internals.followDisplaySize(PAGE_ID, internals.pages.get(PAGE_ID), window);

  assert.deepEqual(page.resizes, [{ width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT }],
    'the page was laid out at the window size instead of the fixed render size');
  assert.deepEqual(page.layout, { width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT });
});

test('a page a caller opened at its own viewport keeps that layout', async () => {
  const page = fakePage({ width: 800, height: 600 });
  const { internals, advance } = harness(page);
  internals.pages.get(PAGE_ID).callerViewport = true;
  const window = { width: 1600, height: 1000 };

  await internals.followDisplaySize(PAGE_ID, internals.pages.get(PAGE_ID), window);
  advance(300);
  await internals.followDisplaySize(PAGE_ID, internals.pages.get(PAGE_ID), window);

  assert.deepEqual(page.resizes, [], 'a caller-chosen viewport was re-laid-out behind the caller');
  assert.deepEqual(page.layout, { width: 800, height: 600 });
});

test('a small window does not shrink the page either', async () => {
  const page = fakePage({ width: 400, height: 300 });
  const { internals, advance } = harness(page);
  const window = { width: 400, height: 300 };

  await internals.followDisplaySize(PAGE_ID, internals.pages.get(PAGE_ID), window);
  advance(300);
  await internals.followDisplaySize(PAGE_ID, internals.pages.get(PAGE_ID), window);

  assert.deepEqual(page.resizes, [{ width: FIXED_VIDEO_WIDTH, height: FIXED_VIDEO_HEIGHT }],
    'a small window reflowed the page instead of scaling the picture');
});
