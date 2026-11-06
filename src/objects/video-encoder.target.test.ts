/**
 * The picture the viewer receives is sized for the window it lands in.
 *
 * These pin the rule that replaced the fixed 960x540 stage: a frame is encoded
 * for the pixels the viewer will actually paint, never beyond what the capture
 * holds (upscaling in an encoder buys bits, not detail), and never so small that
 * a sliver of a window gets an undecodable picture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_VIDEO_WIDTH,
  MAX_VIDEO_HEIGHT,
  MAX_VIDEO_WIDTH,
  videoBitrateFor,
  videoTargetFor,
} from './video-encoder.js';

const CAPTURE = { width: 1280, height: 720 };

function target(displayWidth: number, displayHeight: number, capture = CAPTURE) {
  return videoTargetFor(capture.width, capture.height, displayWidth, displayHeight);
}

test('a window the size of the capture gets the capture\'s own pixels', () => {
  assert.deepEqual(target(1280, 720), { width: 1280, height: 720 });
});

test('a large window no longer gets the fixed 960x540 picture', () => {
  const large = target(1600, 1000);
  assert.deepEqual(large, { width: 1280, height: 720 });
  assert.ok(large.width > DEFAULT_VIDEO_WIDTH,
    `a 1600px draw area got ${large.width}px, no more than the old ${DEFAULT_VIDEO_WIDTH}px`);
  assert.ok(large.height > DEFAULT_VIDEO_HEIGHT);
});

test('a small window stays cheap', () => {
  assert.deepEqual(target(480, 270), { width: 480, height: 270 });
  assert.ok(target(480, 270).width < DEFAULT_VIDEO_WIDTH);
});

test('the encode grows with the window it is displayed in', () => {
  const small = target(640, 360);
  const medium = target(960, 540);
  const large = target(1280, 720);
  assert.ok(small.width < medium.width && medium.width < large.width,
    `sizes did not climb with the window: ${small.width}, ${medium.width}, ${large.width}`);
});

test('the encode never exceeds the capture, however large the window', () => {
  // Upscaling here would cost bits and add no detail: the pixels do not exist.
  assert.deepEqual(target(2000, 1200), { width: 1280, height: 720 });
});

test('a capture larger than the ceiling is encoded no bigger than the ceiling', () => {
  const huge = { width: 2560, height: 1440 };
  const fitted = target(4000, 3000, huge);
  assert.ok(fitted.width <= MAX_VIDEO_WIDTH, `${fitted.width} exceeded ${MAX_VIDEO_WIDTH}`);
  assert.ok(fitted.height <= MAX_VIDEO_HEIGHT, `${fitted.height} exceeded ${MAX_VIDEO_HEIGHT}`);
});

test('the page aspect ratio is kept, so the client can contain-fit it', () => {
  const fitted = target(1000, 1000);
  assert.equal(fitted.width % 2, 0, 'VP8 needs an even width');
  assert.equal(fitted.height % 2, 0, 'VP8 needs an even height');
  assert.ok(Math.abs(fitted.width / fitted.height - CAPTURE.width / CAPTURE.height) < 0.02,
    `aspect drifted: ${fitted.width}x${fitted.height}`);
});

test('a sliver of a window still gets a decodable picture', () => {
  const tiny = target(10, 10);
  assert.ok(tiny.width >= 2 && tiny.height >= 2);
  assert.ok(tiny.width <= CAPTURE.width && tiny.height <= CAPTURE.height,
    'the floor must not magnify the picture past its capture');
});

test('an odd-sized capture is trimmed to even dimensions', () => {
  const odd = { width: 1279, height: 719 };
  const fitted = target(1279, 719, odd);
  assert.equal(fitted.width % 2, 0);
  assert.equal(fitted.height % 2, 0);
});

test('the bitrate follows the pixel count and stays within sane bounds', () => {
  // The old stream was 960x540 at 2 Mbps: keeping that per-pixel budget is what
  // holds quality steady as the picture grows.
  const legacy = videoBitrateFor(960, 540);
  assert.ok(legacy >= 1_900_000 && legacy <= 2_300_000, `960x540 got ${legacy} bps`);
  assert.ok(videoBitrateFor(1280, 720) > legacy, 'a larger picture did not get more bits');
  assert.ok(videoBitrateFor(1920, 1080) > videoBitrateFor(1280, 720));
  assert.ok(videoBitrateFor(2, 2) >= 800_000, 'a tiny picture was starved');
  assert.ok(videoBitrateFor(7680, 4320) <= 12_000_000, 'a huge picture was given an unbounded bitrate');
});
