import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accumulateFrameStats,
  decideViewerFrameAction,
  emptyFrameCounters,
  mapPatchToCanvas,
  type ViewerFitRect,
} from './web-browser-viewer.js';
import type { ViewerFramePatch, ViewerFrameReply } from './frame-diff.js';

/** A stand-in patch: only the rect and the URI's size matter to the viewer. */
function patch(x: number, y: number, width: number, height: number): ViewerFramePatch {
  return { x, y, width, height, dataUri: 'data:image/png;base64,AAAA' };
}

const KEY: ViewerFrameReply = {
  kind: 'key',
  seq: 4,
  dataUri: 'data:image/png;base64,AAAAAAAA',
  width: 800,
  height: 600,
};

const UNCHANGED: ViewerFrameReply = { kind: 'unchanged', seq: 4 };

const FIT: ViewerFitRect = { drawX: 0, drawY: 0, drawW: 400, drawH: 300 };

// ── What each reply kind asks the viewer to do ──

test('viewer: an unchanged frame draws nothing at all', () => {
  const decision = decideViewerFrameAction(UNCHANGED, { lastDrawnSeq: 4, lastFit: FIT });
  assert.equal(decision.action, 'ignore');
  assert.deepEqual(decision.patches, []);
});

test('viewer: a key frame is drawn as a whole frame', () => {
  const decision = decideViewerFrameAction(KEY, { lastDrawnSeq: 3, lastFit: FIT });
  assert.equal(decision.action, 'key');
});

test('viewer: a patch based on the frame on screen is painted', () => {
  const reply: ViewerFrameReply = {
    kind: 'delta', seq: 5, baseSeq: 4, width: 800, height: 600,
    patches: [patch(10, 20, 30, 40)],
  };
  const decision = decideViewerFrameAction(reply, { lastDrawnSeq: 4, lastFit: FIT });
  assert.equal(decision.action, 'delta');
  assert.equal(decision.patches.length, 1);
});

// ── Resync: a patch for a frame the viewer no longer holds ──

test('viewer: a patch for an older frame asks for a fresh key frame', () => {
  const reply: ViewerFrameReply = {
    kind: 'delta', seq: 9, baseSeq: 8, width: 800, height: 600,
    patches: [patch(0, 0, 10, 10)],
  };
  // The screen holds seq 4: it missed updates 5-8, so the patch would lie.
  const decision = decideViewerFrameAction(reply, { lastDrawnSeq: 4, lastFit: FIT });
  assert.equal(decision.action, 'resync');
  assert.deepEqual(decision.patches, []);
});

test('viewer: a patch with nothing on screen asks for a key frame', () => {
  const reply: ViewerFrameReply = {
    kind: 'delta', seq: 2, baseSeq: 1, width: 800, height: 600,
    patches: [patch(0, 0, 10, 10)],
  };
  const decision = decideViewerFrameAction(reply, { lastFit: undefined });
  assert.equal(decision.action, 'resync');
});

test('viewer: a patch batch that carries nothing is dropped', () => {
  const reply: ViewerFrameReply = {
    kind: 'delta', seq: 5, baseSeq: 4, width: 800, height: 600, patches: [],
  };
  const decision = decideViewerFrameAction(reply, { lastDrawnSeq: 4, lastFit: FIT });
  assert.equal(decision.action, 'ignore');
});

// ── Mapping page pixels onto the canvas ──

test('viewer: a patch maps through the scale-to-fit transform', () => {
  // 800x600 fitted into 400x300 is a clean 0.5 scale.
  const rect = mapPatchToCanvas(patch(100, 60, 40, 20), FIT, 800, 600);
  assert.deepEqual(rect, { x: 50, y: 30, width: 20, height: 10 });
});

test('viewer: a patch honours the letterbox offset', () => {
  // A 600x100 strip centred in a 400x300 box: drawY pushes it down.
  const letterboxed: ViewerFitRect = { drawX: 0, drawY: 100, drawW: 400, drawH: 200 };
  const rect = mapPatchToCanvas(patch(0, 0, 600, 100), letterboxed, 600, 100);
  assert.deepEqual(rect, { x: 0, y: 100, width: 400, height: 200 });
});

test('viewer: patch rects round outward so neighbouring patches cannot leave a seam', () => {
  // A third-scale fit puts edges on fractional pixels.
  const fit: ViewerFitRect = { drawX: 0, drawY: 0, drawW: 100, drawH: 100 };
  const rect = mapPatchToCanvas(patch(1, 1, 1, 1), fit, 300, 300);
  assert.equal(rect.width, 1);
  assert.equal(rect.height, 1);
  // The left edge floors and the right edge ceils: never narrower than the
  // scaled span, so adjacent patches overlap by a pixel rather than gap.
  assert.ok(rect.x <= 1 / 3);
});

// ── Counters ──

test('viewer: counters start empty and count only what was actually sent', () => {
  const empty = emptyFrameCounters();
  assert.deepEqual(empty, {
    updatesSent: 0, bytesSent: 0, keyFrames: 0, deltas: 0,
    patches: 0, unchangedTicks: 0, resyncs: 0,
  });

  const afterKey = accumulateFrameStats(
    empty, KEY, decideViewerFrameAction(KEY, { lastFit: undefined }),
  );
  assert.equal(afterKey.keyFrames, 1);
  assert.equal(afterKey.updatesSent, 1);
  assert.ok(afterKey.bytesSent > 0);

  // An unchanged tick sends nothing: no update, no bytes.
  const afterUnchanged = accumulateFrameStats(
    afterKey, UNCHANGED, decideViewerFrameAction(UNCHANGED, { lastDrawnSeq: 4, lastFit: FIT }),
  );
  assert.equal(afterUnchanged.updatesSent, 1);
  assert.equal(afterUnchanged.bytesSent, afterKey.bytesSent);
  assert.equal(afterUnchanged.unchangedTicks, 1);
});

test('viewer: a delta counts as one update carrying several patches', () => {
  const reply: ViewerFrameReply = {
    kind: 'delta', seq: 5, baseSeq: 4, width: 800, height: 600,
    patches: [patch(0, 0, 10, 10), patch(50, 50, 10, 10)],
  };
  const decision = decideViewerFrameAction(reply, { lastDrawnSeq: 4, lastFit: FIT });
  const stats = accumulateFrameStats(emptyFrameCounters(), reply, decision);
  assert.equal(stats.deltas, 1);
  assert.equal(stats.patches, 2);
  assert.equal(stats.updatesSent, 1);
  assert.equal(stats.bytesSent, 6); // two 3-byte payloads
});

test('viewer: a resync tick is counted as a resync, not as an update', () => {
  const reply: ViewerFrameReply = {
    kind: 'delta', seq: 9, baseSeq: 8, width: 800, height: 600,
    patches: [patch(0, 0, 10, 10)],
  };
  const decision = decideViewerFrameAction(reply, { lastDrawnSeq: 4, lastFit: FIT });
  const stats = accumulateFrameStats(emptyFrameCounters(), reply, decision);
  assert.equal(stats.resyncs, 1);
  assert.equal(stats.updatesSent, 0);
  assert.equal(stats.bytesSent, 0);
});

// ── A run: a busy page then a static one ──

test('viewer: a static page costs one key frame and then nothing', () => {
  let stats = emptyFrameCounters();
  let lastDrawnSeq: number | undefined;

  const keyReply: ViewerFrameReply = { ...KEY, seq: 1 };
  let decision = decideViewerFrameAction(keyReply, { lastDrawnSeq, lastFit: undefined });
  stats = accumulateFrameStats(stats, keyReply, decision);
  assert.equal(decision.action, 'key');
  lastDrawnSeq = 1;

  // Thirty identical polls: not one byte crosses the bus.
  for (let i = 0; i < 30; i += 1) {
    const unchanged: ViewerFrameReply = { kind: 'unchanged', seq: 1 };
    decision = decideViewerFrameAction(unchanged, { lastDrawnSeq, lastFit: FIT });
    stats = accumulateFrameStats(stats, unchanged, decision);
    assert.equal(decision.action, 'ignore');
  }

  assert.equal(stats.updatesSent, 1);
  assert.equal(stats.unchangedTicks, 30);
});
