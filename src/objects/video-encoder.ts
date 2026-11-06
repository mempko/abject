/**
 * VP8 encoding for the web viewer's live picture.
 *
 * The viewer used to move pictures as PNG rectangles: the capture side diffed
 * screenshots and sent changed patches against a key frame, and the client
 * reassembled them. Reassembly is where the flicker came from — patches arrive
 * asynchronously, land on a canvas between animation frames, and leave seams
 * and torn regions when the page moves faster than the patch chain.
 *
 * A real video codec replaces all of that. This module turns a captured RGBA
 * frame into VP8 packets with libvpx (via libav.js, a WebAssembly build of
 * FFmpeg's libraries, installed as an ordinary dependency), and the client
 * decodes them with WebCodecs' VideoDecoder. Inter frames are a few kilobytes
 * and the browser does the motion compensation, so a moving page costs a
 * fraction of a full frame and the picture is coherent at every step.
 *
 * Nothing here knows about the object system: it takes pixels and returns
 * packets, so it can be used by the WebBrowser capability or by a test.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { require, requirePositive } from '../core/contracts.js';

const requireNode = createRequire(import.meta.url);

/** One encoded VP8 packet, ready to hand to a VideoDecoder. */
export interface Vp8Chunk {
  /** `key` starts (or restarts) decoding; `delta` needs the prior frames. */
  type: 'key' | 'delta';
  /** Presentation timestamp in microseconds, strictly increasing per stream. */
  timestamp: number;
  data: Uint8Array;
}

/** A planar frame as libav.js wants it: one buffer plus per-plane strides. */
export interface PlanarFrame {
  data: Uint8Array;
  layout: Array<{ offset: number; stride: number }>;
}

export interface Vp8EncoderOptions {
  width: number;
  height: number;
  /** Target bitrate in bits per second (default 2 Mbps for a 720p page). */
  bitrate?: number;
  /** Frames per second the timestamps advance by (default 30). */
  fps?: number;
  /** Frames between key frames (default 60: a fresh start every ~2s). */
  gopSize?: number;
}

/** The slice of the libav.js API this module drives. */
export interface LibAvLike {
  AV_PIX_FMT_YUV420P: number;
  ff_init_encoder(
    name: string,
    opts: {
      ctx?: Record<string, number | [number, number]>;
      time_base?: [number, number];
      options?: Record<string, string>;
    },
  ): Promise<[number, number, number, number, number]>;
  ff_encode_multi(
    ctx: number,
    frame: number,
    pkt: number,
    frames: unknown[],
    fin?: boolean,
  ): Promise<Array<{ data: Uint8Array; flags?: number; pts?: number }>>;
  ff_free_encoder(ctx: number, frame: number, pkt: number): Promise<void>;
  ff_init_decoder(name: string): Promise<[number, number, number, number]>;
  ff_decode_multi(
    ctx: number,
    pkt: number,
    frame: number,
    packets: unknown[],
    fin?: boolean,
  ): Promise<Array<{ data: Uint8Array; width?: number; height?: number }>>;
  terminate?: () => void;
}

interface LibAvStatic {
  LibAV(opts?: { noworker?: boolean }): Promise<LibAvLike>;
  base?: string;
}

let libavPromise: Promise<LibAvLike> | undefined;

/**
 * Load the WebM/VP8 build of libav.js (once per process).
 *
 * The module is loaded from its installed path rather than by bare specifier
 * so a bundled server still finds the wasm beside it, and `base` is set so
 * libav.js looks for `libav-<version>-webm.wasm.wasm` there. `noworker` keeps
 * it on the calling thread: it already runs inside a pool worker, and a
 * sub-worker just to hold the codec would double the cost.
 */
export async function loadLibAv(): Promise<LibAvLike> {
  if (!libavPromise) {
    libavPromise = (async () => {
      // The package does not export its package.json, so resolve the main
      // entry (dist/libav-default.js) and take its directory.
      const dist = dirname(requireNode.resolve('libav.js'));
      const entry = pathToFileURL(join(dist, 'libav-webm.mjs')).href;
      const mod = (await import(entry)) as { default?: LibAvStatic } & LibAvStatic;
      const LibAV = mod.default ?? mod;
      require(typeof LibAV?.LibAV === 'function', 'libav.js did not expose LibAV()');
      LibAV.base = `${pathToFileURL(dist).href}/`;
      return await LibAV.LibAV({ noworker: true });
    })();
    libavPromise.catch(() => { libavPromise = undefined; });
  }
  return libavPromise;
}

/**
 * Convert straight RGBA pixels to planar YUV 4:2:0, the only layout libvpx
 * encodes. BT.601 coefficients in integer maths: a 1280x720 frame converts in
 * a couple of milliseconds, which keeps it off the critical path of a capture.
 *
 * VP8 requires even dimensions, and the chroma planes hold one sample per
 * 2x2 block of pixels.
 */
export function rgbaToPlanarYuv420p(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): PlanarFrame {
  requirePositive(width, 'a frame needs a positive width');
  requirePositive(height, 'a frame needs a positive height');
  require(width % 2 === 0 && height % 2 === 0,
    `yuv420p needs even dimensions (got ${width}x${height})`);
  require(rgba.length >= width * height * 4,
    `rgba buffer holds ${rgba.length} bytes, needs ${width * height * 4}`);

  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  const out = new Uint8Array(ySize + cSize * 2);

  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    const nextRow = row + width;
    const chromaRow = (y / 2) * (width / 2);
    for (let x = 0; x < width; x += 2) {
      const i0 = (row + x) * 4;
      const i1 = i0 + 4;
      const i2 = (nextRow + x) * 4;
      const i3 = i2 + 4;

      const r0 = rgba[i0], g0 = rgba[i0 + 1], b0 = rgba[i0 + 2];
      const r1 = rgba[i1], g1 = rgba[i1 + 1], b1 = rgba[i1 + 2];
      const r2 = rgba[i2], g2 = rgba[i2 + 1], b2 = rgba[i2 + 2];
      const r3 = rgba[i3], g3 = rgba[i3 + 1], b3 = rgba[i3 + 2];

      const yIndex = row + x;
      out[yIndex] = luma(r0, g0, b0);
      out[yIndex + 1] = luma(r1, g1, b1);
      out[nextRow + x] = luma(r2, g2, b2);
      out[nextRow + x + 1] = luma(r3, g3, b3);

      const rAvg = (r0 + r1 + r2 + r3) / 4;
      const gAvg = (g0 + g1 + g2 + g3) / 4;
      const bAvg = (b0 + b1 + b2 + b3) / 4;
      const cIndex = ySize + chromaRow + x / 2;
      // Chroma is already BT.601 limited range (224/255 of the full-range
      // coefficients) with its 128 offset, so it agrees with the luma above.
      out[cIndex] = clampByte(128 + ((-38 * rAvg - 74 * gAvg + 112 * bAvg) / 256));
      out[ySize + cSize + chromaRow + x / 2] =
        clampByte(128 + ((112 * rAvg - 94 * gAvg - 18 * bAvg) / 256));
    }
  }

  return {
    data: out,
    layout: [
      { offset: 0, stride: width },
      { offset: ySize, stride: width / 2 },
      { offset: ySize + cSize, stride: width / 2 },
    ],
  };
}

function luma(r: number, g: number, b: number): number {
  // Limited (studio) range — 16..235, not 0..255. A YUV420P frame is read as
  // limited range by default by both ffmpeg and a browser's VideoDecoder, so
  // full-range luma here made every decoded frame visibly darker and flatter
  // than the page it came from (measured: source 18, decoded 10).
  return clampByte(16 + (66 * r + 129 * g + 25 * b) / 256);
}

function clampByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/**
 * A live VP8 encoder for one page's stream.
 *
 * Frames are pushed one at a time and come back as packets; the encoder keeps
 * the reference frames, so a delta costs a fraction of a key frame. Callers
 * decide *when* to encode (nothing changes, nothing is sent) and restart the
 * encoder when the page size changes.
 */
export class Vp8Encoder {
  private pts = 0;

  private constructor(
    private readonly libav: LibAvLike,
    private readonly codecCtx: number,
    private readonly framePtr: number,
    private readonly packetPtr: number,
    readonly width: number,
    readonly height: number,
    private readonly fps: number,
  ) {}

  static async create(options: Vp8EncoderOptions): Promise<Vp8Encoder> {
    const { width, height, bitrate = 2_000_000, fps = 30, gopSize = 60 } = options;
    requirePositive(width, 'Vp8Encoder needs a positive width');
    requirePositive(height, 'Vp8Encoder needs a positive height');
    requirePositive(fps, 'Vp8Encoder needs a positive fps');

    const libav = await loadLibAv();
    const [, codecCtx, framePtr, packetPtr] = await libav.ff_init_encoder('libvpx', {
      ctx: {
        width,
        height,
        pix_fmt: libav.AV_PIX_FMT_YUV420P,
        bit_rate: bitrate,
        framerate_num: fps,
        framerate_den: 1,
        gop_size: gopSize,
        time_base: [1, fps],
      },
      // Realtime/speed-first: the viewer wants the newest picture, not the
      // smallest file. lag-in-frames 0 means a pushed frame is a packet now.
      options: {
        deadline: 'realtime',
        'cpu-used': '8',
        'lag-in-frames': '0',
        'error-resilient': '1',
      },
    });
    return new Vp8Encoder(libav, codecCtx, framePtr, packetPtr, width, height, fps);
  }

  /** Encode one RGBA frame into VP8 packets (at least one). */
  async encode(rgba: Uint8ClampedArray | Uint8Array): Promise<Vp8Chunk[]> {
    const planar = rgbaToPlanarYuv420p(rgba, this.width, this.height);
    const pts = this.pts;
    this.pts += 1;
    const packets = await this.libav.ff_encode_multi(this.codecCtx, this.framePtr, this.packetPtr, [
      {
        data: planar.data,
        width: this.width,
        height: this.height,
        format: this.libav.AV_PIX_FMT_YUV420P,
        layout: planar.layout,
        pts,
        time_base_num: 1,
        time_base_den: this.fps,
      },
    ]);
    const timestamp = Math.round((pts * 1_000_000) / this.fps);
    return packets.map((packet) => ({
      type: ((packet.flags ?? 0) & 1) === 1 ? 'key' : 'delta',
      timestamp,
      data: packet.data,
    }));
  }

  async close(): Promise<void> {
    await this.libav.ff_free_encoder(this.codecCtx, this.framePtr, this.packetPtr);
  }
}

/** One encoded packet, base64-encoded so it can ride the message bus. */
export interface ViewerVideoChunk {
  type: 'key' | 'delta';
  timestamp: number;
  data: string;
}

/**
 * One poll's answer from the codec transport: either the pixels are identical
 * to the frame already on screen (send nothing), or a set of VP8 packets that
 * continue the stream.
 */
export interface ViewerVideoReply {
  kind: 'unchanged' | 'video';
  /** Stream sequence: increments only when packets are actually sent. */
  seq: number;
  /** True when this reply carries a key frame (the client must reset first). */
  key: boolean;
  width: number;
  height: number;
  /** The page's own pixel size, before the codec's downscale. */
  sourceWidth: number;
  sourceHeight: number;
  /** Codec string the client passes to VideoDecoder. */
  codec: string;
  chunks: ViewerVideoChunk[];
  /** The page's current URL and title, when the capability reports them. */
  url?: string;
  title?: string;
}

/** Per-page encoder state kept by the capture side. */
export interface ViewerVideoStreamState {
  encoder: Vp8Encoder;
  width: number;
  height: number;
  seq: number;
  lastKeyAt: number;
  /** Pixels last encoded, to tell an idle page from a moving one. */
  lastFrame: Uint8Array;
  keyFrames: number;
  deltas: number;
  unchangedTicks: number;
  bytesSent: number;
}

/** VP8 WebCodecs codec string. */
export const VP8_CODEC = 'vp8';

/**
 * Shrink a captured frame to at most `maxWidth`x`maxHeight` and force even
 * dimensions (VP8 requires them), so a 4K window does not pay 4K encoding cost
 * for a picture displayed a few hundred pixels wide.
 */
export function fitFrameToVideo(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { data: Uint8ClampedArray | Uint8Array; width: number; height: number } {
  requirePositive(width, 'a frame needs a positive width');
  requirePositive(height, 'a frame needs a positive height');
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  let w = Math.max(2, Math.round((width * scale) / 2) * 2);
  let h = Math.max(2, Math.round((height * scale) / 2) * 2);
  if (w === width && h === height) {
    // Same size, but an odd dimension still has to be trimmed for VP8.
    if (width % 2 === 0 && height % 2 === 0) return { data: rgba, width, height };
    w = width - (width % 2);
    h = height - (height % 2);
  }
  if (w === width && h === height) return { data: rgba, width, height };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / w));
      const from = (sy * width + sx) * 4;
      const to = (y * w + x) * 4;
      out[to] = rgba[from];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from + 2];
      out[to + 3] = rgba[from + 3];
    }
  }
  return { data: out, width: w, height: h };
}

/** Ceiling on the encoded picture, however large a window asks for it. */
export const MAX_VIDEO_WIDTH = 1920;
export const MAX_VIDEO_HEIGHT = 1080;

/** The encode size a poll that names no display size still gets. */
export const DEFAULT_VIDEO_WIDTH = 960;
export const DEFAULT_VIDEO_HEIGHT = 540;

/** No picture is encoded at less than this fraction of its capture. */
const MIN_VIDEO_SCALE = 0.25;

/** One poll's request from the viewer. */
export interface ViewerVideoPollOptions {
  /** Restart the stream with a key frame on this poll. */
  forceKey?: boolean;
  /** Override the configured key-frame cadence. */
  keyFrameIntervalMs?: number;
  /**
   * The pixels the viewer will paint the picture into — its canvas draw area.
   * The encode follows it, so a large window is sharp instead of an upscaled
   * small picture, and a small window stays cheap.
   */
  display?: { width: number; height: number };
}

/**
 * The size to encode a page frame at for a picture the viewer will paint into
 * `displayWidth` x `displayHeight` of its own pixels.
 *
 * The page's aspect ratio is kept, so the shape the client contain-fits into
 * its draw rect still matches the capture. The result never exceeds the
 * capture's own pixel count — upscaling in the encoder buys bits, not detail —
 * and never falls below a quarter of it, so a sliver of a window still gets a
 * decodable picture. Dimensions are even throughout: VP8 requires them.
 */
export function videoTargetFor(
  sourceWidth: number,
  sourceHeight: number,
  displayWidth: number,
  displayHeight: number,
): { width: number; height: number } {
  requirePositive(sourceWidth, 'a frame needs a positive width');
  requirePositive(sourceHeight, 'a frame needs a positive height');
  const fitW = Math.max(1, Math.min(displayWidth, MAX_VIDEO_WIDTH)) / sourceWidth;
  const fitH = Math.max(1, Math.min(displayHeight, MAX_VIDEO_HEIGHT)) / sourceHeight;
  const scale = Math.min(1, Math.max(MIN_VIDEO_SCALE, Math.min(fitW, fitH)));
  const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
  const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
  return { width, height };
}

/**
 * A bitrate that holds quality steady as the picture grows: about four bits per
 * pixel, which is the 2 Mbps the 960x540 stream was tuned at, kept between a
 * floor so a small window is not starved and a ceiling so a huge one cannot
 * swamp the connection.
 */
export function videoBitrateFor(width: number, height: number): number {
  requirePositive(width, 'a stream needs a positive width');
  requirePositive(height, 'a stream needs a positive height');
  return Math.max(800_000, Math.min(12_000_000, Math.round(width * height * 4)));
}
