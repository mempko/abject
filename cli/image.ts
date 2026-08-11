/**
 * Terminal image rendering for chat transcripts: data-URI images embedded in
 * messages (pasted screenshots, agent attachments) are decoded and drawn as
 * half-block ANSI art -- each terminal cell shows two vertically stacked
 * pixels via '▀' with independent foreground/background colors. Truecolor
 * when the terminal supports it, xterm-256 otherwise.
 *
 * PNG is decoded here directly (inflate via fflate, which the project already
 * ships); JPEG goes through jpeg-js. GIF/WebP fall back to a text marker.
 */

import { unzlibSync } from 'fflate';
import * as jpeg from 'jpeg-js';

export interface ImageRef {
  /** Display label (markdown alt with any `|WxH` size hint removed). */
  alt: string;
  /** Full data: URI. */
  uri: string;
}

interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

// ── Extraction ─────────────────────────────────────────────────────────

const MD_IMAGE = /!\[([^\]]*)\]\(\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+?)\s*\)/g;
const BARE_IMAGE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/g;

/**
 * Pull data-URI images out of a message, replacing each with a short inline
 * marker so the raw base64 never reaches the transcript.
 */
export function extractImages(text: string): { text: string; images: ImageRef[] } {
  if (!text.includes('data:image/')) return { text, images: [] };
  const images: ImageRef[] = [];
  let stripped = text.replace(MD_IMAGE, (_m, alt: string, uri: string) => {
    const label = alt.split('|')[0].trim() || 'image';
    images.push({ alt: label, uri });
    return `⧉ ${label}`;
  });
  stripped = stripped.replace(BARE_IMAGE, (uri) => {
    images.push({ alt: 'image', uri });
    return '⧉ image';
  });
  return { text: stripped, images };
}

// ── Decoding ───────────────────────────────────────────────────────────

function decodeDataUri(uri: string): RawImage | null {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(uri);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
  try {
    if (mime === 'png') return decodePng(bytes);
    if (mime === 'jpeg' || mime === 'jpg') return decodeJpeg(bytes);
  } catch {
    return null;
  }
  return null;
}

function decodeJpeg(bytes: Uint8Array): RawImage | null {
  const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
  if (!img || !img.width || !img.height) return null;
  return { width: img.width, height: img.height, rgba: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 8-bit non-interlaced PNG (every colorType); anything rarer returns null. */
function decodePng(bytes: Uint8Array): RawImage | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') paletteAlpha = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const channels = PNG_CHANNELS[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels) return null;
  if (width * height > 64_000_000) return null;

  const raw = unzlibSync(concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo per-scanline filters (each row: filter byte + raw bytes).
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= channels ? px[dst + x - channels] : 0;
      const up = y > 0 ? px[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: return null;
      }
      px[dst + x] = out & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    switch (colorType) {
      case 0:
        rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
        rgba[d + 3] = 255;
        break;
      case 2:
        rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2];
        rgba[d + 3] = 255;
        break;
      case 3: {
        const idx = px[s] * 3;
        if (!palette || idx + 2 >= palette.length) return null;
        rgba[d] = palette[idx]; rgba[d + 1] = palette[idx + 1]; rgba[d + 2] = palette[idx + 2];
        rgba[d + 3] = paletteAlpha && px[s] < paletteAlpha.length ? paletteAlpha[px[s]] : 255;
        break;
      }
      case 4:
        rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
        rgba[d + 3] = px[s + 1];
        break;
      default:
        rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2];
        rgba[d + 3] = px[s + 3];
        break;
    }
  }
  return { width, height, rgba };
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ── Half-block ANSI rendering ──────────────────────────────────────────

const RESET = '\x1b[0m';
// Transparent pixels blend toward a dark neutral so alpha edges stay soft.
const BLEND_BG = [30, 30, 34];
const ALPHA_CUTOFF = 24;

function supportsTruecolor(): boolean {
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return true;
  return (process.env.TERM ?? '').includes('direct');
}

function xterm256(r: number, g: number, b: number): number {
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    const v = Math.round((r + g + b) / 3);
    if (v < 8) return 16;
    if (v > 248) return 231;
    return 232 + Math.round(((v - 8) / 247) * 23);
  }
  return 16
    + 36 * Math.round((r / 255) * 5)
    + 6 * Math.round((g / 255) * 5)
    + Math.round((b / 255) * 5);
}

interface Sample { r: number; g: number; b: number; a: number }

/** Box-average the source rectangle covering target pixel (tx, ty). */
function samplePixel(img: RawImage, tx: number, ty: number, pxW: number, pxH: number): Sample {
  const x0 = Math.floor((tx * img.width) / pxW);
  const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.width) / pxW));
  const y0 = Math.floor((ty * img.height) / pxH);
  const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.height) / pxH));
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = y0; y < y1 && y < img.height; y++) {
    for (let x = x0; x < x1 && x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; a += img.rgba[i + 3];
      n++;
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: r / n, g: g / n, b: b / n, a: a / n };
}

function blend(s: Sample): [number, number, number] {
  const t = s.a / 255;
  return [
    Math.round(s.r * t + BLEND_BG[0] * (1 - t)),
    Math.round(s.g * t + BLEND_BG[1] * (1 - t)),
    Math.round(s.b * t + BLEND_BG[2] * (1 - t)),
  ];
}

/**
 * Render decoded pixels into terminal rows of '▀' half-blocks, scaled to fit
 * maxCols x maxRows cells (2 pixels per cell vertically; a cell being about
 * twice as tall as wide makes the result roughly square-pixel).
 */
function renderHalfBlocks(img: RawImage, maxCols: number, maxRows: number): string[] {
  const scale = Math.min(maxCols / img.width, (maxRows * 2) / img.height, 1);
  const pxW = Math.max(1, Math.round(img.width * scale));
  const pxH = Math.max(1, Math.round(img.height * scale));
  const rows = Math.ceil(pxH / 2);
  const truecolor = supportsTruecolor();

  const fgCode = (c: [number, number, number]) =>
    truecolor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${xterm256(c[0], c[1], c[2])}m`;
  const bgCode = (c: [number, number, number] | null) =>
    c === null ? '\x1b[49m'
      : truecolor ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${xterm256(c[0], c[1], c[2])}m`;

  const out: string[] = [];
  for (let cy = 0; cy < rows; cy++) {
    let row = '';
    let lastFg = '';
    let lastBg = '';
    for (let cx = 0; cx < pxW; cx++) {
      const top = samplePixel(img, cx, cy * 2, pxW, pxH);
      const bottom = cy * 2 + 1 < pxH ? samplePixel(img, cx, cy * 2 + 1, pxW, pxH) : { r: 0, g: 0, b: 0, a: 0 };
      const topVisible = top.a >= ALPHA_CUTOFF;
      const bottomVisible = bottom.a >= ALPHA_CUTOFF;
      let fg = '', bg = '', ch: string;
      if (!topVisible && !bottomVisible) {
        bg = bgCode(null);
        ch = ' ';
      } else if (!bottomVisible) {
        fg = fgCode(blend(top));
        bg = bgCode(null);
        ch = '▀';
      } else if (!topVisible) {
        fg = fgCode(blend(bottom));
        bg = bgCode(null);
        ch = '▄';
      } else {
        fg = fgCode(blend(top));
        bg = bgCode(blend(bottom));
        ch = '▀';
      }
      if (fg && fg !== lastFg) { row += fg; lastFg = fg; }
      if (bg !== lastBg) { row += bg; lastBg = bg; }
      row += ch;
    }
    out.push(row + RESET);
  }
  return out;
}

/**
 * Decode and render an extracted image as ANSI art rows, or null when the
 * format is unsupported or the data is broken (caller keeps the marker).
 */
export function renderImage(ref: ImageRef, maxCols: number, maxRows: number): string[] | null {
  const img = decodeDataUri(ref.uri);
  if (!img) return null;
  return renderHalfBlocks(img, Math.max(4, maxCols), Math.max(2, maxRows));
}
