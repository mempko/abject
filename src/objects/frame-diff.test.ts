import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePng,
  diffRects,
  encodePngFrame,
  encodePngRect,
  framesEqual,
  changedPixelCount,
  DEFAULT_KEY_FRAME_INTERVAL_MS,
  requireSameFrameSize,
  sameFrameSize,
  needsResync,
  ViewerFrameSession,
  FrameSizeMismatchError,
  type FrameRect,
  type RgbaFrame,
} from './frame-diff.js';

/** A solid-colour RGBA frame. */
function makeFrame(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [0, 0, 0, 255],
): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

/** Paint every pixel of `rect` in a frame. */
function paint(frame: RgbaFrame, rect: FrameRect, rgba: [number, number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * frame.width + x) * 4;
      frame.data[i] = rgba[0];
      frame.data[i + 1] = rgba[1];
      frame.data[i + 2] = rgba[2];
      frame.data[i + 3] = rgba[3];
    }
  }
}

function rectContains(outer: FrameRect, inner: FrameRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function coversEveryChangedPixel(previous: RgbaFrame, next: RgbaFrame, rects: FrameRect[]): boolean {
  for (let y = 0; y < next.height; y++) {
    for (let x = 0; x < next.width; x++) {
      const i = (y * next.width + x) * 4;
      const differs =
        previous.data[i] !== next.data[i] ||
        previous.data[i + 1] !== next.data[i + 1] ||
        previous.data[i + 2] !== next.data[i + 2] ||
        previous.data[i + 3] !== next.data[i + 3];
      if (!differs) continue;
      const covered = rects.some(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
      );
      if (!covered) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Identical frames
// ---------------------------------------------------------------------------

test('identical frames report no changed rectangles', () => {
  const a = makeFrame(64, 48, [10, 20, 30, 255]);
  const b = makeFrame(64, 48, [10, 20, 30, 255]);

  assert.equal(framesEqual(a, b), true);
  assert.equal(changedPixelCount(a, b), 0);
  assert.deepEqual(diffRects(a, b), []);
  assert.deepEqual(diffRects(a, b, { tileSize: 1 }), []);
});

test('a frame compared against itself has no rectangles', () => {
  const a = makeFrame(37, 21, [200, 100, 50, 255]);
  assert.deepEqual(diffRects(a, a), []);
});

// ---------------------------------------------------------------------------
// One small changed box
// ---------------------------------------------------------------------------

test('one small changed box yields that box (or a tight superset of it)', () => {
  const previous = makeFrame(128, 96, [0, 0, 0, 255]);
  const next = makeFrame(128, 96, [0, 0, 0, 255]);
  // Deliberately off the 16px tile grid so the rectangle must be a superset.
  const changed: FrameRect = { x: 20, y: 34, width: 7, height: 5 };
  paint(next, changed, [255, 0, 0, 255]);

  const rects = diffRects(previous, next);
  assert.equal(rects.length, 1, `expected one rectangle, got ${JSON.stringify(rects)}`);
  const [rect] = rects as [FrameRect];

  assert.ok(rectContains(rect, changed), `rect ${JSON.stringify(rect)} does not contain the change`);
  assert.ok(rect.width <= changed.width + 32 && rect.height <= changed.height + 32);
  assert.ok(rect.width < next.width && rect.height < next.height, 'rectangle should not cover the whole frame');
  assert.ok(coversEveryChangedPixel(previous, next, rects));
});

test('a changed box aligned to the tile grid is reported exactly', () => {
  const previous = makeFrame(96, 96);
  const next = makeFrame(96, 96);
  paint(next, { x: 32, y: 16, width: 16, height: 32 }, [0, 255, 0, 255]);

  assert.deepEqual(diffRects(previous, next), [{ x: 32, y: 16, width: 16, height: 32 }]);
});

test('two separated changed boxes yield two separate rectangles', () => {
  const previous = makeFrame(128, 64);
  const next = makeFrame(128, 64);
  paint(next, { x: 0, y: 0, width: 16, height: 16 }, [255, 255, 255, 255]);
  paint(next, { x: 96, y: 32, width: 16, height: 16 }, [255, 255, 255, 255]);

  const rects = diffRects(previous, next);
  assert.equal(rects.length, 2);
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.equal(area, 16 * 16 * 2, 'rectangles should not bleed into the unchanged middle');
  assert.ok(coversEveryChangedPixel(previous, next, rects));
});

test('a single changed pixel is still reported', () => {
  const previous = makeFrame(40, 40);
  const next = makeFrame(40, 40);
  paint(next, { x: 17, y: 3, width: 1, height: 1 }, [1, 2, 3, 255]);

  assert.equal(changedPixelCount(previous, next), 1);
  const rects = diffRects(previous, next, { tileSize: 1 });
  assert.deepEqual(rects, [{ x: 17, y: 3, width: 1, height: 1 }]);
});

// ---------------------------------------------------------------------------
// Size changes are caller-detectable
// ---------------------------------------------------------------------------

test('a size change throws a FrameSizeMismatchError instead of producing garbage', () => {
  const previous = makeFrame(32, 32);
  const next = makeFrame(32, 64);

  assert.equal(sameFrameSize(previous, next), false);
  assert.equal(framesEqual(previous, next), false);
  assert.throws(() => diffRects(previous, next), (err: unknown) => {
    assert.ok(err instanceof FrameSizeMismatchError);
    assert.equal(err.widthA, 32);
    assert.equal(err.heightA, 32);
    assert.equal(err.widthB, 32);
    assert.equal(err.heightB, 64);
    return true;
  });
  assert.throws(() => requireSameFrameSize(previous, next), FrameSizeMismatchError);
  assert.throws(() => changedPixelCount(previous, next), FrameSizeMismatchError);
});

test('callers can branch on the size check to decide on a key frame', () => {
  const previous = makeFrame(10, 10);
  const next = makeFrame(12, 10);
  const decision = sameFrameSize(previous, next) ? 'patch' : 'keyframe';
  assert.equal(decision, 'keyframe');
});

// ---------------------------------------------------------------------------
// PNG encode / decode round trips
// ---------------------------------------------------------------------------

test('decode-then-encode round trip preserves every pixel of a full frame', () => {
  const frame = makeFrame(23, 17);
  // A pattern that exercises filters and non-uniform alpha.
  for (let i = 0; i < frame.data.length; i += 4) {
    const p = i / 4;
    frame.data[i] = (p * 7) & 0xff;
    frame.data[i + 1] = (p * 13) & 0xff;
    frame.data[i + 2] = (p * 29) & 0xff;
    frame.data[i + 3] = p % 11 === 0 ? 0 : 255;
  }

  const png = encodePngFrame(frame);
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');

  const decoded = decodePng(png);
  assert.equal(decoded.width, frame.width);
  assert.equal(decoded.height, frame.height);
  assert.deepEqual(Array.from(decoded.data), Array.from(frame.data));

  // Re-encoding the decoded pixels reproduces an equivalent image.
  const again = decodePng(encodePngFrame(decoded));
  assert.deepEqual(Array.from(again.data), Array.from(frame.data));
});

// -- the viewer transport: what one poll of a capture becomes -----------------

/** A session that will not re-send a key frame on its own during a test. */
function quietSession(): ViewerFrameSession {
  return new ViewerFrameSession({ keyFrameIntervalMs: 60_000 });
}

test('viewer transport: the first poll sends a whole key frame', () => {
  const session = quietSession();
  const reply = session.next(makeFrame(32, 24, [10, 20, 30, 255]), 1000);

  assert.equal(reply.kind, 'key');
  if (reply.kind !== 'key') return;
  assert.equal(reply.seq, 1);
  assert.equal(reply.width, 32);
  assert.equal(reply.height, 24);
  assert.match(reply.dataUri, /^data:image\/png;base64,/);

  const decoded = decodePng(Buffer.from(reply.dataUri.split(',')[1]!, 'base64'));
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 24);
  assert.equal(session.stats.keyFrames, 1);
  assert.equal(session.stats.deltas, 0);
  assert.ok(session.stats.bytesSent > 0, 'a key frame counts its bytes');
});

test('viewer transport: identical pixels send nothing at all', () => {
  const session = quietSession();
  const frame = makeFrame(48, 32, [90, 100, 110, 255]);
  assert.equal(session.next(frame, 1000).kind, 'key');
  const before = session.stats.bytesSent;

  const reply = session.next(makeFrame(48, 32, [90, 100, 110, 255]), 1033);

  assert.equal(reply.kind, 'unchanged');
  assert.equal(reply.seq, 1, 'the client keeps the frame number it had');
  assert.equal('dataUri' in reply, false, 'no image bytes on an unchanged tick');
  assert.equal('patches' in reply, false, 'not even an empty patch list');
  assert.equal(session.stats.unchangedTicks, 1);
  assert.equal(session.stats.bytesSent, before, 'nothing crossed the bus');
});

test('viewer transport: a small change sends one tight patch, not a whole frame', () => {
  const session = quietSession();
  const base = makeFrame(128, 96, [0, 0, 0, 255]);
  assert.equal(session.next(base, 1000).kind, 'key');
  const keyBytes = session.stats.bytesSent;

  const next = makeFrame(128, 96, [0, 0, 0, 255]);
  const changed: FrameRect = { x: 40, y: 24, width: 8, height: 8 };
  paint(next, changed, [255, 0, 0, 255]);

  const reply = session.next(next, 1033);
  assert.equal(reply.kind, 'delta');
  if (reply.kind !== 'delta') return;

  assert.equal(reply.seq, 2);
  assert.equal(reply.baseSeq, 1, 'the patches apply to the frame the client holds');
  assert.equal(reply.width, 128);
  assert.equal(reply.height, 96);
  assert.ok(reply.patches.length >= 1);
  assert.ok(
    reply.patches.some((p) => rectContains(p, changed)),
    'a patch covers the pixels that changed',
  );
  for (const patch of reply.patches) {
    assert.match(patch.dataUri, /^data:image\/png;base64,/);
    assert.ok(patch.width * patch.height < 128 * 96 / 4, 'a patch is a rectangle, not the frame');
  }

  // Each patch decodes to exactly the pixels of that rectangle.
  const first = reply.patches[0]!;
  const decoded = decodePng(Buffer.from(first.dataUri.split(',')[1]!, 'base64'));
  assert.equal(decoded.width, first.width);
  assert.equal(decoded.height, first.height);
  assert.equal(decoded.data[0], next.data[(first.y * 128 + first.x) * 4]);

  assert.equal(session.stats.deltas, 1);
  assert.equal(session.stats.keyFrames, 1);
  assert.equal(session.stats.patches, reply.patches.length);
  assert.ok(
    session.stats.bytesSent - keyBytes < keyBytes,
    'the delta cost less than another whole frame',
  );
});

test('viewer transport: a size change is a key frame', () => {
  const session = quietSession();
  assert.equal(session.next(makeFrame(32, 24, [1, 2, 3, 255]), 1000).kind, 'key');

  const reply = session.next(makeFrame(40, 30, [1, 2, 3, 255]), 1033);

  assert.equal(reply.kind, 'key', 'a differently sized client needs a whole frame');
  if (reply.kind !== 'key') return;
  assert.equal(reply.width, 40);
  assert.equal(reply.height, 30);
  assert.equal(reply.seq, 2);
});

test('viewer transport: forceKey resyncs a client that fell behind', () => {
  const session = quietSession();
  const frame = makeFrame(24, 16, [7, 7, 7, 255]);
  assert.equal(session.next(frame, 1000).kind, 'key');

  // Same pixels, but the client asks for a whole frame.
  const forced = session.next(makeFrame(24, 16, [7, 7, 7, 255]), 1033, { forceKey: true });
  assert.equal(forced.kind, 'key');
  assert.equal(forced.seq, 2);
  assert.equal(session.stats.keyFrames, 2);

  // Having drawn it, the client is in sync again and the next quiet poll is free.
  const after = session.next(makeFrame(24, 16, [7, 7, 7, 255]), 1066);
  assert.equal(after.kind, 'unchanged');
  assert.equal(after.seq, 2);
});

test('viewer transport: a delta only applies to the frame the client holds', () => {
  assert.equal(needsResync(1, undefined), true, 'nothing drawn yet needs a key frame');
  assert.equal(needsResync(1, 2), true, 'a delta against another frame must be refused');
  assert.equal(needsResync(2, 2), false, 'the client holds exactly the base frame');
});

test('viewer transport: a per-poll interval override is honoured without sticking', () => {
  const session = quietSession();
  const frame = makeFrame(16, 16, [50, 60, 70, 255]);
  assert.equal(session.next(frame, 1000).kind, 'key');

  // An override of zero means the interval has always elapsed. The pixels have
  // changed too, so the client cannot patch: it gets a whole frame.
  const changed = makeFrame(16, 16, [50, 60, 70, 255]);
  paint(changed, { x: 0, y: 0, width: 4, height: 4 }, [200, 10, 10, 255]);
  const forced = session.next(changed, 1033, { keyFrameIntervalMs: 0 });
  assert.equal(forced.kind, 'key');
  assert.equal(session.keyFrameInterval, 60_000, 'the session cadence is unchanged');
});

test('viewer transport: a static page sends one key frame and then nothing', () => {
  // The default cadence, deliberately: this is the case a real idle page hits.
  const session = new ViewerFrameSession();
  const pixels = (): RgbaFrame => makeFrame(40, 30, [9, 9, 9, 255]);

  const first = session.next(pixels(), 0);
  assert.equal(first.kind, 'key', 'the first frame establishes the reference');
  if (first.kind !== 'key') return;
  const sentBytes = session.stats.bytesSent;

  // Poll many times, spanning far more than the key-frame interval. Identical
  // pixels: an elapsed interval alone must not put anything on the bus.
  const step = Math.max(1, Math.floor(DEFAULT_KEY_FRAME_INTERVAL_MS / 4));
  const polls = 60;
  for (let i = 1; i <= polls; i++) {
    const now = i * step;
    const reply = session.next(pixels(), now);
    assert.equal(reply.kind, 'unchanged', `poll at ${now}ms must send nothing`);
    assert.equal(reply.seq, first.seq, 'the client frame number stands');
  }
  assert.ok(
    polls * step > DEFAULT_KEY_FRAME_INTERVAL_MS * 10,
    'the polls span well past the key-frame interval',
  );

  assert.equal(session.stats.keyFrames, 1, 'no periodic key frame was sent');
  assert.equal(session.stats.bytesSent, sentBytes, 'not one further byte went out');
  assert.equal(session.stats.deltas, 0);
  assert.equal(session.stats.unchangedTicks, polls);
});

test('viewer transport: forceKey still resynchronises a static page', () => {
  const session = new ViewerFrameSession();
  const pixels = (): RgbaFrame => makeFrame(40, 30, [9, 9, 9, 255]);

  const first = session.next(pixels(), 0);
  assert.equal(first.kind, 'key');
  if (first.kind !== 'key') return;

  // The client lost its frame while the page sat still. It asks, and gets a
  // whole frame immediately, whatever the interval says.
  const forced = session.next(pixels(), 60_000, { forceKey: true });
  assert.equal(forced.kind, 'key', 'an explicit request is never suppressed');
  assert.equal(forced.seq, first.seq + 1);
  assert.match(forced.dataUri, /^data:image\/png;base64,/);
  assert.equal(session.stats.keyFrames, 2);

  // Having drawn it, the still page goes quiet again.
  const after = session.next(pixels(), 61_000);
  assert.equal(after.kind, 'unchanged');
  assert.equal(after.seq, forced.seq);
});

test('a rectangle encoded as PNG decodes back to exactly those pixels', () => {
  const frame = makeFrame(64, 48, [5, 6, 7, 255]);
  const rect: FrameRect = { x: 10, y: 12, width: 20, height: 15 };
  paint(frame, rect, [250, 128, 0, 200]);

  const png = encodePngRect(frame, rect);
  const decoded = decodePng(png);
  assert.equal(decoded.width, rect.width);
  assert.equal(decoded.height, rect.height);

  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const fromPatch = (y * rect.width + x) * 4;
      const fromFrame = ((rect.y + y) * frame.width + (rect.x + x)) * 4;
      for (let c = 0; c < 4; c++) {
        assert.equal(decoded.data[fromPatch + c], frame.data[fromFrame + c]);
      }
    }
  }
});

test('a decoded difference patch differs from the reference exactly where diffRects said', () => {
  const previous = makeFrame(64, 64);
  const next = makeFrame(64, 64);
  paint(next, { x: 16, y: 16, width: 32, height: 16 }, [9, 200, 40, 255]);

  const rects = diffRects(previous, next);
  assert.ok(rects.length > 0);

  // Apply the patches to a copy of `previous`; the result must be `next`.
  const rebuilt: RgbaFrame = { width: previous.width, height: previous.height, data: new Uint8ClampedArray(previous.data) };
  for (const rect of rects) {
    const patch = decodePng(encodePngRect(next, rect));
    assert.equal(patch.width, rect.width);
    assert.equal(patch.height, rect.height);
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const src = (y * rect.width + x) * 4;
        const dst = ((rect.y + y) * rebuilt.width + (rect.x + x)) * 4;
        for (let c = 0; c < 4; c++) rebuilt.data[dst + c] = patch.data[src + c]!;
      }
    }
  }

  assert.deepEqual(Array.from(rebuilt.data), Array.from(next.data));
  assert.deepEqual(diffRects(rebuilt, next), []);
});

test('encoding an out-of-bounds or empty rectangle is rejected', () => {
  const frame = makeFrame(16, 16);
  assert.throws(() => encodePngRect(frame, { x: 10, y: 10, width: 10, height: 10 }));
  assert.throws(() => encodePngRect(frame, { x: -1, y: 0, width: 4, height: 4 }));
  assert.throws(() => encodePngRect(frame, { x: 0, y: 0, width: 0, height: 4 }));
});
