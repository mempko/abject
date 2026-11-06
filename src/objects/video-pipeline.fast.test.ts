/**
 * The screencast's fast PNG decode and the encoder's colour conversion.
 *
 * A 1692x1080 screencast frame arrives as an 8-bit truecolour PNG, and decoding
 * it was 39 ms of the 89 ms a poll used to spend on one frame. `decodePngFast`
 * is the same arithmetic on the shape a screencast actually pushes; these tests
 * pin that it agrees with the general decoder byte for byte and that it refuses
 * any other shape instead of guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePng, decodePngFast, encodePngFrame, type RgbaFrame } from './frame-diff.js';
import { rgbaToPlanarYuv420p } from './video-encoder.js';

function frame(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

const noise = (seed: number) => (x: number, y: number): [number, number, number, number] => [
  (x * 7 + y * 13 + seed) & 255,
  (x * 3 + y * 29 + seed) & 255,
  (x * 17 + y * 5 + seed) & 255,
  ((x ^ y) + seed) & 255,
];

test('the fast PNG decode matches the general decoder byte for byte', () => {
  for (const [w, h] of [[1, 1], [3, 2], [16, 9], [61, 37]]) {
    const source = frame(w, h, noise(w * 31 + h));
    const bytes = encodePngFrame(source);
    const general = decodePng(bytes);
    const fast = decodePngFast(bytes);
    assert.ok(fast, `the fast path refused a ${w}x${h} screencast frame`);
    assert.equal(fast!.width, w);
    assert.equal(fast!.height, h);
    assert.deepEqual(Buffer.from(fast!.data.buffer, fast!.data.byteOffset, fast!.data.byteLength),
      Buffer.from(general.data.buffer, general.data.byteOffset, general.data.byteLength),
      `${w}x${h} decoded differently`);
  }
});

test('the fast PNG decode returns nothing for bytes that are not that shape', () => {
  assert.equal(decodePngFast(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined, 'a non-PNG was decoded');
  const bytes = encodePngFrame(frame(4, 4, noise(9)));
  assert.equal(decodePngFast(bytes.subarray(0, 20)), undefined, 'a truncated PNG was decoded');
});

test('the fast PNG decode refuses an interlaced frame', () => {
  // IHDR is the first chunk: patch the interlace method and re-CRC nothing —
  // the decoder bails on the header long before it would meet a CRC.
  const bytes = Buffer.from(encodePngFrame(frame(4, 4, noise(3))));
  const ihdrData = 8 + 8;
  bytes[ihdrData + 12] = 1;
  assert.equal(decodePngFast(bytes), undefined, 'an interlaced PNG was decoded');
});

test('RGBA converts to limited-range YUV420p with the chroma of each 2x2 block', () => {
  // One 2x2 block of pure red: luma is BT.601 limited range — 16 + 66/256 of
  // the red coefficient, rounded, so 82 — and both chroma planes take the
  // block average with their 128 offset.
  const source = frame(2, 2, () => [255, 0, 0, 255]);
  const planar = rgbaToPlanarYuv420p(source.data, 2, 2);
  assert.equal(planar.data.length, 4 + 1 + 1, 'a 2x2 frame is 4 luma and 2 chroma samples');
  const redLuma = 16 + Math.round((66 * 255) / 256);
  assert.equal(redLuma, 82, 'the BT.601 limited-range red luma is 82');
  for (let i = 0; i < 4; i++) assert.equal(planar.data[i], redLuma, `luma ${i} is not BT.601 red`);
  assert.equal(planar.data[4], 128 + Math.round((-38 * 255) / 256), 'Cr does not carry the block average');
  assert.equal(planar.data[5], 128 + Math.round((112 * 255) / 256), 'Cb does not carry the block average');
  assert.deepEqual(planar.layout, [{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }]);
});

test('an unaligned RGBA view still converts to the same pixels', () => {
  const source = frame(8, 4, noise(21));
  const direct = rgbaToPlanarYuv420p(source.data, 8, 4);
  // A view one byte into a larger buffer exercises the byte-wise fallback the
  // word-at-a-time path skips.
  const shifted = new Uint8ClampedArray(source.data.length + 1);
  shifted.set(source.data, 1);
  const offsetView = shifted.subarray(1);
  const viaFallback = rgbaToPlanarYuv420p(offsetView, 8, 4);
  assert.deepEqual(Array.from(viaFallback.data), Array.from(direct.data),
    'the byte-wise fallback disagreed with the word-wise path');
});
