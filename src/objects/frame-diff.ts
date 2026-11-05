/**
 * Frame diffing for screenshot transports (PNG <-> RGBA, changed rectangles).
 *
 * The web viewer captures the page as a PNG screenshot and, historically, put
 * the whole image on the bus every tick. To send only what changed the
 * comparison has to happen next to the capture (inside the WebBrowser
 * capability), so this module is deliberately agnostic about the object
 * system: it takes and returns plain data (Buffers, Uint8ClampedArrays and
 * `{ x, y, width, height }` rectangles) and can be used by the capability, by
 * the viewer, or by a test.
 *
 *   decodePng(buffer)                 PNG bytes  -> RGBA pixels
 *   diffRects(a, b)                   two frames -> changed rectangles
 *   encodePngRect(frame, rect)        RGBA rect  -> PNG bytes
 *
 * A size change is a `FrameSizeMismatchError`, never garbage: the caller has to
 * decide whether that means "send a new key frame".
 */

import { deflateSync, inflateSync } from 'node:zlib';

/** An RGBA frame: 4 bytes per pixel, row-major, `width * height * 4` long. */
export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A rectangle in pixels; the unit both the diff and the canvas commands use. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Thrown when two frames (or a frame and a rectangle) disagree on dimensions. */
export class FrameSizeMismatchError extends Error {
  readonly widthA: number;
  readonly heightA: number;
  readonly widthB: number;
  readonly heightB: number;

  constructor(widthA: number, heightA: number, widthB: number, heightB: number) {
    super(
      `frame size mismatch: ${widthA}x${heightA} vs ${widthB}x${heightB}`,
    );
    this.name = 'FrameSizeMismatchError';
    this.widthA = widthA;
    this.heightA = heightA;
    this.widthB = widthB;
    this.heightB = heightB;
  }
}

/** Default edge length, in pixels, of the tiles compared by {@link diffRects}. */
export const DEFAULT_DIFF_TILE = 16;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---------------------------------------------------------------------------
// PNG decoding
// ---------------------------------------------------------------------------

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

function readUint32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // grayscale
    case 2: return 3; // truecolour
    case 3: return 1; // palette index
    case 4: return 2; // grayscale + alpha
    case 6: return 4; // truecolour + alpha
    default:
      throw new Error(`unsupported PNG colour type ${colorType}`);
  }
}

function parsePng(buffer: Uint8Array): {
  header: PngHeader;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  idat: Uint8Array;
} {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) {
      throw new Error('not a PNG: bad signature');
    }
  }

  let offset = 8;
  let header: PngHeader | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];

  while (offset + 8 <= buffer.length) {
    const length = readUint32(buffer, offset);
    const type = String.fromCharCode(
      buffer[offset + 4]!,
      buffer[offset + 5]!,
      buffer[offset + 6]!,
      buffer[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) {
      throw new Error(`truncated PNG chunk ${type}`);
    }
    const chunk = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      header = {
        width: readUint32(chunk, 0),
        height: readUint32(chunk, 4),
        bitDepth: chunk[8]!,
        colorType: chunk[9]!,
        interlace: chunk[12]!,
      };
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      transparency = chunk;
    } else if (type === 'IDAT') {
      idatParts.push(chunk);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }

  if (!header) throw new Error('PNG has no IHDR chunk');
  if (idatParts.length === 0) throw new Error('PNG has no IDAT chunk');

  let total = 0;
  for (const part of idatParts) total += part.length;
  const idat = new Uint8Array(total);
  let write = 0;
  for (const part of idatParts) {
    idat.set(part, write);
    write += part.length;
  }

  return { header, palette, transparency, idat };
}

/** Reverse the per-scanline PNG filters, producing packed (filter-free) rows. */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(stride * height);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    if (pos >= raw.length) throw new Error('truncated PNG image data');
    const filter = raw[pos++]!;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;

    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x]!;
      const a = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel]! : 0;
      const b = y > 0 ? out[prevStart + x]! : 0;
      const c = x >= bytesPerPixel && y > 0 ? out[prevStart + x - bytesPerPixel]! : 0;
      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + a;
          break;
        case 2:
          reconstructed = value + b;
          break;
        case 3:
          reconstructed = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          reconstructed = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter type ${filter}`);
      }
      out[rowStart + x] = reconstructed & 0xff;
    }
    pos += stride;
  }

  return out;
}

/**
 * Decode a PNG buffer into straight RGBA pixels.
 *
 * Supports 8-bit non-interlaced images in every standard colour type (grey,
 * truecolour, palette, grey+alpha, truecolour+alpha) — which is what
 * `page.screenshot` and canvas encoders produce. Anything else throws rather
 * than guessing.
 */
export function decodePng(buffer: Uint8Array | Buffer): RgbaFrame {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { header, palette, transparency, idat } = parsePng(bytes);

  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8 is supported)`);
  }
  if (interlace !== 0) {
    throw new Error('interlaced PNG is not supported');
  }
  if (colorType === 3 && !palette) {
    throw new Error('palette PNG has no PLTE chunk');
  }

  const channels = channelsForColorType(colorType);
  const inflated = inflateSync(idat);
  const packed = unfilter(inflated, width, height, channels);

  const rgba = new Uint8ClampedArray(width * height * 4);
  const pixels = width * height;

  for (let i = 0; i < pixels; i++) {
    const src = i * channels;
    const dst = i * 4;
    switch (colorType) {
      case 0: {
        const grey = packed[src]!;
        const alpha = transparency && transparency.length >= 2 && grey === transparency[1] ? 0 : 255;
        rgba[dst] = grey;
        rgba[dst + 1] = grey;
        rgba[dst + 2] = grey;
        rgba[dst + 3] = alpha;
        break;
      }
      case 2: {
        rgba[dst] = packed[src]!;
        rgba[dst + 1] = packed[src + 1]!;
        rgba[dst + 2] = packed[src + 2]!;
        rgba[dst + 3] = 255;
        break;
      }
      case 3: {
        const index = packed[src]!;
        rgba[dst] = palette![index * 3] ?? 0;
        rgba[dst + 1] = palette![index * 3 + 1] ?? 0;
        rgba[dst + 2] = palette![index * 3 + 2] ?? 0;
        rgba[dst + 3] = transparency && transparency.length > index ? transparency[index]! : 255;
        break;
      }
      case 4: {
        const grey = packed[src]!;
        rgba[dst] = grey;
        rgba[dst + 1] = grey;
        rgba[dst + 2] = grey;
        rgba[dst + 3] = packed[src + 1]!;
        break;
      }
      case 6: {
        rgba[dst] = packed[src]!;
        rgba[dst + 1] = packed[src + 1]!;
        rgba[dst + 2] = packed[src + 2]!;
        rgba[dst + 3] = packed[src + 3]!;
        break;
      }
    }
  }

  return { width, height, data: rgba };
}

// ---------------------------------------------------------------------------
// Frame comparison
// ---------------------------------------------------------------------------

/** True when both frames have the same pixel dimensions. */
export function sameFrameSize(a: RgbaFrame, b: RgbaFrame): boolean {
  return a.width === b.width && a.height === b.height;
}

function assertWellFormed(frame: RgbaFrame, label: string): void {
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new Error(`${label}: invalid frame dimensions ${frame.width}x${frame.height}`);
  }
  const expected = frame.width * frame.height * 4;
  if (frame.data.length !== expected) {
    throw new Error(
      `${label}: expected ${expected} RGBA bytes for ${frame.width}x${frame.height}, got ${frame.data.length}`,
    );
  }
}

/**
 * Throw {@link FrameSizeMismatchError} unless the two frames match in size.
 * Callers use this to decide between "patch it" and "send a key frame".
 */
export function requireSameFrameSize(a: RgbaFrame, b: RgbaFrame): void {
  if (!sameFrameSize(a, b)) {
    throw new FrameSizeMismatchError(a.width, a.height, b.width, b.height);
  }
}

/** True when the two frames are pixel-identical (and the same size). */
export function framesEqual(a: RgbaFrame, b: RgbaFrame): boolean {
  if (!sameFrameSize(a, b)) return false;
  const left = a.data;
  const right = b.data;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Number of pixels whose RGBA value differs. Same-size frames only. */
export function changedPixelCount(a: RgbaFrame, b: RgbaFrame): number {
  requireSameFrameSize(a, b);
  assertWellFormed(a, 'frame A');
  assertWellFormed(b, 'frame B');
  const left = a.data;
  const right = b.data;
  let changed = 0;
  for (let p = 0; p < left.length; p += 4) {
    if (
      left[p] !== right[p] ||
      left[p + 1] !== right[p + 1] ||
      left[p + 2] !== right[p + 2] ||
      left[p + 3] !== right[p + 3]
    ) {
      changed++;
    }
  }
  return changed;
}

export interface DiffOptions {
  /** Edge length in pixels of the tiles compared; default {@link DEFAULT_DIFF_TILE}. */
  tileSize?: number;
}

/**
 * Report the rectangles of `next` that differ from `previous`.
 *
 * Identical frames return an empty array (nothing to send). Changed pixels are
 * found on a tile grid and neighbouring runs of changed tiles are merged, so
 * the result is a small set of rectangles that is a tight superset of the real
 * changed area — never missing a changed pixel, never the whole frame unless
 * the whole frame really changed.
 *
 * Frames whose dimensions differ throw {@link FrameSizeMismatchError}: a size
 * change invalidates the reference frame, and only the caller knows whether to
 * send a key frame or drop the patch.
 */
export function diffRects(
  previous: RgbaFrame,
  next: RgbaFrame,
  options: DiffOptions = {},
): FrameRect[] {
  requireSameFrameSize(previous, next);
  assertWellFormed(previous, 'previous frame');
  assertWellFormed(next, 'next frame');

  if (framesEqual(previous, next)) return [];

  const tile = Math.max(1, Math.floor(options.tileSize ?? DEFAULT_DIFF_TILE));
  const { width, height } = next;
  const cols = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const changedTiles = new Uint8Array(cols * rows);

  const left = previous.data;
  const right = next.data;

  for (let y = 0; y < height; y++) {
    const rowTileBase = Math.floor(y / tile) * cols;
    let rowOffset = y * width * 4;
    for (let x = 0; x < width; x++, rowOffset += 4) {
      if (
        left[rowOffset] !== right[rowOffset] ||
        left[rowOffset + 1] !== right[rowOffset + 1] ||
        left[rowOffset + 2] !== right[rowOffset + 2] ||
        left[rowOffset + 3] !== right[rowOffset + 3]
      ) {
        changedTiles[rowTileBase + Math.floor(x / tile)] = 1;
      }
    }
  }

  // Merge horizontal runs of changed tiles per tile-row, then merge identical
  // runs vertically so a tall changed band becomes one rectangle.
  interface TileRun { startCol: number; endCol: number; startRow: number; endRow: number }
  const runs: TileRun[] = [];
  const open = new Map<string, TileRun>();

  for (let row = 0; row < rows; row++) {
    const rowBase = row * cols;
    let col = 0;
    const rowRuns: Array<{ startCol: number; endCol: number }> = [];
    while (col < cols) {
      if (!changedTiles[rowBase + col]) { col++; continue; }
      const startCol = col;
      while (col < cols && changedTiles[rowBase + col]) col++;
      rowRuns.push({ startCol, endCol: col - 1 });
    }

    const stillOpen = new Set<string>();
    for (const run of rowRuns) {
      const key = `${run.startCol}:${run.endCol}`;
      const existing = open.get(key);
      if (existing && existing.endRow === row - 1) {
        existing.endRow = row;
        stillOpen.add(key);
      } else {
        const created: TileRun = { ...run, startRow: row, endRow: row };
        open.set(key, created);
        runs.push(created);
        stillOpen.add(key);
      }
    }
    for (const key of [...open.keys()]) {
      if (!stillOpen.has(key)) open.delete(key);
    }
  }

  return runs.map((run) => {
    const x = run.startCol * tile;
    const y = run.startRow * tile;
    const right = Math.min(width, (run.endCol + 1) * tile);
    const bottom = Math.min(height, (run.endRow + 1) * tile);
    return { x, y, width: right - x, height: bottom - y };
  });
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/**
 * Encode a rectangle of an RGBA frame as a standalone PNG (RGBA, 8-bit).
 *
 * The result is a complete image of `rect.width x rect.height` pixels, ready
 * for a `data:image/png;base64,` URI and to be drawn at `(rect.x, rect.y)` over
 * the client's copy of the reference frame.
 */
export function encodePngRect(frame: RgbaFrame, rect: FrameRect): Buffer {
  assertWellFormed(frame, 'frame');
  if (
    !Number.isInteger(rect.x) ||
    !Number.isInteger(rect.y) ||
    !Number.isInteger(rect.width) ||
    !Number.isInteger(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error(`invalid rectangle ${rect.x},${rect.y} ${rect.width}x${rect.height}`);
  }
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > frame.width ||
    rect.y + rect.height > frame.height
  ) {
    throw new Error(
      `rectangle ${rect.x},${rect.y} ${rect.width}x${rect.height} is outside the ${frame.width}x${frame.height} frame`,
    );
  }

  const stride = rect.width * 4;
  const raw = new Uint8Array((stride + 1) * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const destStart = row * (stride + 1);
    raw[destStart] = 0; // filter type: none
    const srcStart = ((rect.y + row) * frame.width + rect.x) * 4;
    raw.set(frame.data.subarray(srcStart, srcStart + stride), destStart + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr[0] = (rect.width >>> 24) & 0xff;
  ihdr[1] = (rect.width >>> 16) & 0xff;
  ihdr[2] = (rect.width >>> 8) & 0xff;
  ihdr[3] = rect.width & 0xff;
  ihdr[4] = (rect.height >>> 24) & 0xff;
  ihdr[5] = (rect.height >>> 16) & 0xff;
  ihdr[6] = (rect.height >>> 8) & 0xff;
  ihdr[7] = rect.height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode a whole RGBA frame as a PNG (the key-frame case). */
export function encodePngFrame(frame: RgbaFrame): Buffer {
  assertWellFormed(frame, 'frame');
  return encodePngRect(frame, { x: 0, y: 0, width: frame.width, height: frame.height });
}

// ── Viewer frame transport ────────────────────────────────────────────────
//
// The viewer used to receive a whole PNG on every tick, whether or not the
// page had moved. The transport below compares each capture against the frame
// the client already holds: identical pixels send nothing at all, a change
// sends only the rectangles that differ, and occasionally (or on demand) a
// whole key frame goes out so a client can resync.

/** Default cap on how often a key frame is re-sent, in ms. */
export const DEFAULT_KEY_FRAME_INTERVAL_MS = 2000;
/** Default poll cadence for a visible viewer, in ms (≈30 fps). */
export const DEFAULT_FRAME_POLL_MS = 33;

/** One changed rectangle, already encoded, to draw at (x, y) in page pixels. */
export interface ViewerFramePatch {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `data:image/png;base64,...` for exactly this rectangle. */
  dataUri: string;
}

/**
 * What one poll of the viewer transport produces. `unchanged` carries no image
 * bytes at all; `delta` carries patches against the frame numbered `baseSeq`;
 * `key` carries a whole frame that replaces whatever the client had.
 */
export type ViewerFrameReply =
  | { kind: 'unchanged'; seq: number; url?: string; title?: string }
  | { kind: 'key'; seq: number; dataUri: string; width: number; height: number; url?: string; title?: string }
  | {
      kind: 'delta';
      seq: number;
      baseSeq: number;
      width: number;
      height: number;
      patches: ViewerFramePatch[];
      url?: string;
      title?: string;
    };

/** `data:image/png;base64,...` for a PNG buffer. */
export function pngDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Bytes a data URI actually carries once decoded (base64 is 6 bits/char). */
export function dataUriBytes(dataUri: string): number {
  const comma = dataUri.indexOf(',');
  const payload = comma >= 0 ? dataUri.length - comma - 1 : dataUri.length;
  const padding = dataUri.endsWith('==') ? 2 : dataUri.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

/**
 * A patch applies only to the frame it was computed from. When the client's
 * last drawn frame is not that frame (nothing drawn yet, a dropped update, a
 * page switch), it must ask for a key frame instead of painting the patch.
 */
export function needsResync(baseSeq: number, lastDrawnSeq: number | undefined): boolean {
  return lastDrawnSeq === undefined || baseSeq !== lastDrawnSeq;
}

/** Options a caller may pass per poll. */
export interface ViewerFrameOptions {
  /** A client that is out of sync asks for a whole frame. */
  forceKey?: boolean;
  /** Override the key-frame interval for this poll. */
  keyFrameIntervalMs?: number;
}

/**
 * The reference-frame state machine behind the viewer transport: one instance
 * per page. It holds the frame the client already has, numbers every frame it
 * sends, and decides per capture whether to send nothing, a set of patches, or
 * a new key frame.
 */
export class ViewerFrameSession {
  /** The frame the client holds — what a delta is computed against. */
  private reference?: RgbaFrame;
  /** Sequence number of the last frame actually sent; 0 = nothing sent yet. */
  private seq = 0;
  /** When the last key frame was sent (ms, caller's clock). */
  private lastKeyAt = 0;
  private keyFrameIntervalMs: number;
  private readonly tileSize: number;

  /** Counters, readable by whoever owns the session. */
  readonly stats = {
    keyFrames: 0,
    deltas: 0,
    patches: 0,
    unchangedTicks: 0,
    bytesSent: 0,
  };

  constructor(options?: { keyFrameIntervalMs?: number; tileSize?: number }) {
    const interval = options?.keyFrameIntervalMs ?? DEFAULT_KEY_FRAME_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval < 0) {
      throw new Error('ViewerFrameSession keyFrameIntervalMs must be a non-negative number');
    }
    this.keyFrameIntervalMs = interval;
    this.tileSize = options?.tileSize ?? DEFAULT_DIFF_TILE;
  }

  /** The seq the client should hold after the last call (0 = nothing yet). */
  get currentSeq(): number {
    return this.seq;
  }

  get keyFrameInterval(): number {
    return this.keyFrameIntervalMs;
  }

  setKeyFrameInterval(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error('keyFrameIntervalMs must be a non-negative number');
    }
    this.keyFrameIntervalMs = intervalMs;
  }

  /** Forget the reference frame: the next poll sends a key frame. */
  reset(): void {
    this.reference = undefined;
    this.seq = 0;
    this.lastKeyAt = 0;
  }

  /**
   * Decide what this capture becomes. `nowMs` is the caller's clock (Date.now).
   * Throws FrameSizeMismatchError never: a size change simply becomes a key
   * frame, which is the resync a differently-sized client needs.
   */
  next(frame: RgbaFrame, nowMs: number, options?: ViewerFrameOptions): ViewerFrameReply {
    assertWellFormed(frame, 'next frame');
    const interval = options?.keyFrameIntervalMs ?? this.keyFrameIntervalMs;
    const reference = this.reference;

    const firstFrame = reference === undefined;
    const sizeChanged = reference !== undefined && !sameFrameSize(reference, frame);
    const forced = options?.forceKey === true;

    // Identical pixels: nothing goes out, and the client's frame number stands.
    // This holds even once the key-frame interval has elapsed: a periodic key
    // frame is only worth sending when there is something to resynchronise to,
    // so a page that does not change must not cross the bus at all. A client
    // that is genuinely out of sync asks with forceKey, which skips this test.
    if (!forced && reference !== undefined && !sizeChanged && framesEqual(reference, frame)) {
      this.stats.unchangedTicks++;
      return { kind: 'unchanged', seq: this.seq };
    }

    // A whole frame when the client cannot apply a patch: it holds nothing, the
    // size changed, it asked, or an elapsed interval retires a patch chain.
    const intervalElapsed = nowMs - this.lastKeyAt >= interval;
    const keyWanted = forced || firstFrame || sizeChanged || intervalElapsed;

    const seq = this.seq + 1;
    this.seq = seq;
    this.reference = frame;

    if (!keyWanted) {
      const rects = diffRects(reference as RgbaFrame, frame, { tileSize: this.tileSize });
      const patches: ViewerFramePatch[] = rects.map((rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        dataUri: pngDataUri(encodePngRect(frame, rect)),
      }));
      // A 'delta' with no patches would mean the client hears about a change it
      // cannot apply; fall through to a key frame in that case.
      if (patches.length > 0) {
        this.stats.deltas++;
        this.stats.patches += patches.length;
        for (const patch of patches) this.stats.bytesSent += dataUriBytes(patch.dataUri);
        return {
          kind: 'delta',
          seq,
          baseSeq: seq - 1,
          width: frame.width,
          height: frame.height,
          patches,
        };
      }
    }

    const dataUri = pngDataUri(encodePngFrame(frame));
    this.lastKeyAt = nowMs;
    this.stats.keyFrames++;
    this.stats.bytesSent += dataUriBytes(dataUri);
    return { kind: 'key', seq, dataUri, width: frame.width, height: frame.height };
  }
}
