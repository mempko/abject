/**
 * MarkdownImageResolver — turns a markdown image `src` into a Compositor-ready
 * `data:` URI, fetching the bytes asynchronously when needed and caching the
 * result.
 *
 * Three source kinds are supported:
 *   1. `data:` / base64 data URIs        — drawable as-is, no fetch.
 *   2. `abject://<typeId>/<path>`         — bytes live in a FileSystem Abject;
 *      the host fetches them via message passing (resolveType → readFileBytes).
 *   3. `http(s)://…`                      — fetched server-side into a data URI
 *      (so a cross-origin draw never taints the surface canvas).
 *
 * The resolver itself is messaging-agnostic: it owns the cache and the
 * synchronous dimension lookups, and delegates the actual byte fetch to its
 * host (a WidgetAbject) via {@link ImageFetcher.fetchImageSource}. On a
 * successful async resolve it calls {@link ImageFetcher.onImageResolved} so the
 * widget can drop its layout cache and redraw.
 */

/** Prefix marking a FileSystem-Abject-backed image reference. */
export const ABJECT_URL_SCHEME = 'abject://';

export interface ImageFetcher {
  /**
   * Fetch a non-`data:` image URL into a drawable `data:` URI, or null on
   * failure. Implemented by the host widget (it owns the message bus).
   */
  fetchImageSource(url: string): Promise<string | null>;
  /** Called after a successful async resolve so the widget can redraw. */
  onImageResolved(): void;
}

/** True for sources the Compositor can paint directly without a fetch. */
export function isDrawableUrl(url: string): boolean {
  return url.startsWith('data:');
}

/** True for FileSystem-Abject-backed references (`abject://typeId/path`). */
export function isAbjectUrl(url: string): boolean {
  return url.startsWith(ABJECT_URL_SCHEME);
}

/** True for remote http(s) URLs (fetched server-side to avoid tainting). */
export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Minimal extension → image MIME map (mirrors FileSystem's inferMime). */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

/** Best-effort image MIME from a file name/path; defaults to image/png. */
export function imageMimeForPath(pathOrName: string): string {
  const dot = pathOrName.lastIndexOf('.');
  const ext = dot >= 0 ? pathOrName.slice(dot + 1).toLowerCase() : '';
  return IMAGE_MIME_BY_EXT[ext] ?? 'image/png';
}

/**
 * Parse an `abject://<typeId>/<path>` reference into candidate (typeId, path)
 * splits. A TypeId is `{peerId}/{workspaceId}/{objectName}` (3 segments) for
 * system objects and `{peerId}/{workspaceId}/user/{Name}` (4 segments) for user
 * objects, so we offer both splits and let the caller try each against the
 * Registry. Returns an empty array when the URL is malformed.
 */
export function parseAbjectUrl(url: string): Array<{ typeId: string; path: string }> {
  if (!isAbjectUrl(url)) return [];
  const segs = url.slice(ABJECT_URL_SCHEME.length).split('/').filter(Boolean);
  const out: Array<{ typeId: string; path: string }> = [];
  for (const n of [3, 4]) {
    if (segs.length > n) {
      out.push({ typeId: segs.slice(0, n).join('/'), path: '/' + segs.slice(n).join('/') });
    }
  }
  return out;
}

/** Build an `abject://<typeId>/<path>` reference for a stored file. */
export function buildAbjectUrl(typeId: string, path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${ABJECT_URL_SCHEME}${typeId}/${clean}`;
}

/**
 * Extract natural width/height from a data-URI-encoded image by parsing the
 * format header bytes directly. No DOM required, so this works in the Node
 * worker where widgets run.
 *
 * Supports PNG, JPEG, and GIF — covers every common case for screenshots and
 * attached images. Returns null on unsupported formats, malformed data URIs, or
 * decode errors; the layout falls back to an alt-text `|WxH` hint or a 16:9
 * placeholder, so a null return is safe.
 */
export function decodeDataUriImageDims(url: string): { width: number; height: number } | null {
  // Format: data:[<mediatype>][;base64],<data>
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma); // strip "data:"
  const isBase64 = /;base64/i.test(meta);
  const data = url.slice(comma + 1);
  if (!data) return null;

  let bytes: Uint8Array;
  try {
    if (isBase64) {
      // atob exists in modern Node (and browsers). Decode base64 → bytes.
      const bin = (typeof atob === 'function') ? atob(data) : Buffer.from(data, 'base64').toString('binary');
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      const decoded = decodeURIComponent(data);
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    }
  } catch {
    return null;
  }

  // PNG: 8-byte signature 89 50 4E 47 0D 0A 1A 0A, then IHDR chunk where
  // width is bytes 16-19 (big-endian uint32), height is 20-23.
  if (bytes.length >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }

  // GIF: "GIF87a" or "GIF89a", then width/height as little-endian uint16
  // at bytes 6-9.
  if (bytes.length >= 10 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
      bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }

  // JPEG: starts with FF D8. Scan markers until we hit a Start-Of-Frame
  // (SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15) which carries
  // height + width. Skip variable-length markers via their declared size.
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) return null;
      let marker = bytes[i + 1];
      // Skip fill bytes 0xFF 0xFF...
      while (marker === 0xFF && i + 2 < bytes.length) {
        i++;
        marker = bytes[i + 1];
      }
      i += 2;
      // Markers without payload
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) continue;
      if (i + 1 >= bytes.length) return null;
      const segLen = (bytes[i] << 8) | bytes[i + 1];
      // SOF markers
      const isSOF =
        (marker >= 0xC0 && marker <= 0xC3) ||
        (marker >= 0xC5 && marker <= 0xC7) ||
        (marker >= 0xC9 && marker <= 0xCB) ||
        (marker >= 0xCD && marker <= 0xCF);
      if (isSOF && i + 7 < bytes.length) {
        const h = (bytes[i + 3] << 8) | bytes[i + 4];
        const w = (bytes[i + 5] << 8) | bytes[i + 6];
        if (w > 0 && h > 0) return { width: w, height: h };
        return null;
      }
      i += segLen;
    }
    return null;
  }

  return null;
}

/**
 * Caches resolved image sources + natural dimensions for a single widget.
 *
 * Layout calls {@link resolveDims} (synchronous) to size image lines; the draw
 * pass calls {@link drawableUrl} (synchronous) to get a paintable URL. Both
 * kick an async fetch on a cache miss and return null/placeholder until the
 * fetch completes and triggers a redraw.
 */
export class MarkdownImageResolver {
  /** Original url → drawable data: URI. */
  private resolved = new Map<string, string>();
  /** Original url → natural dims, or 'error' when undecodable. */
  private dims = new Map<string, { width: number; height: number } | 'error'>();
  /** Urls with an in-flight fetch (deduplicates concurrent kicks). */
  private pending = new Set<string>();
  /** Urls whose fetch failed (don't retry every frame). */
  private failed = new Set<string>();

  constructor(private readonly fetcher: ImageFetcher) {}

  /**
   * Return a Compositor-paintable URL for `url`, or null if it isn't ready yet
   * (a fetch is kicked) or can't be resolved. `data:` URIs pass through.
   */
  drawableUrl(url: string): string | null {
    if (isDrawableUrl(url)) return url;
    const got = this.resolved.get(url);
    if (got) return got;
    if (!this.failed.has(url)) void this.kick(url);
    return null;
  }

  /**
   * Synchronous natural dimensions for layout. Bound as a field so it can be
   * passed directly as the layout's `ImageResolver` callback.
   */
  resolveDims = (url: string): { width: number; height: number } | null => {
    const known = this.dims.get(url);
    if (known === 'error') return null;
    if (known) return known;

    const drawable = isDrawableUrl(url) ? url : this.resolved.get(url);
    if (drawable) {
      const d = decodeDataUriImageDims(drawable);
      this.dims.set(url, d ?? 'error');
      return d;
    }

    // Not yet fetched — kick a resolve; layout uses its placeholder meanwhile.
    if (!this.failed.has(url)) void this.kick(url);
    return null;
  };

  /** Kick an async fetch for a non-data: url, caching the result. */
  private async kick(url: string): Promise<void> {
    if (this.pending.has(url) || this.resolved.has(url) || this.failed.has(url)) return;
    if (isDrawableUrl(url)) return;
    this.pending.add(url);
    try {
      const dataUri = await this.fetcher.fetchImageSource(url);
      if (dataUri) {
        this.resolved.set(url, dataUri);
        this.dims.delete(url); // recompute real dims on next layout pass
        this.fetcher.onImageResolved();
      } else {
        this.failed.add(url);
      }
    } catch {
      this.failed.add(url);
    } finally {
      this.pending.delete(url);
    }
  }
}
