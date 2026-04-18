/**
 * ClawHubClient -- client for clawhub.ai, the public vendor-neutral registry
 * of SKILL.md-format skills (MIT open source; see github.com/openclaw/clawhub).
 *
 * ClawHub hosts thousands of skills that work with both OpenClaw and Claude
 * Code because they share the SKILL.md format. This client mirrors
 * MCPRegistryClient's shape: streams pages in the background, caches in
 * Storage for 24h, and emits `clawhubUpdated` events so the UI can stream
 * rows into the Catalog window as they arrive.
 *
 * Skills download as ZIP bundles (usually SKILL.md plus scripts + refs);
 * downloads are unpacked in-process using Node's zlib and handed to
 * SkillRegistry.installSkillBundle, which writes the tree under
 * `<skillsDir>/<slug>/`.
 */

import * as zlib from 'zlib';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ClawHub');

const CLAWHUB_INTERFACE: InterfaceId = 'abjects:clawhub-client';
const CLAWHUB_BASE_URL = 'https://clawhub.ai/api/v1';
const CACHE_STORAGE_KEY = 'clawhub:cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_AUTO_PAGES = 200; // up to 20k entries total across pages

export const CLAWHUB_CLIENT_ID = 'abjects:clawhub-client' as AbjectId;

/** What the /api/v1/packages endpoint actually returns per entry. */
export interface ClawHubSkillSummary {
  slug: string;
  displayName: string;
  ownerHandle?: string;
  summary?: string;
  latestVersion?: string;
  family?: string; // 'skill' | 'soul' | other
  channel?: string; // 'community' | 'official' | ...
  isOfficial?: boolean;
  verificationTier?: string | null;
  capabilityTags?: string[];
  updatedAt?: number;
}

interface CacheEntry {
  skills: ClawHubSkillSummary[];
  fetchedAt: number;
  nextCursor?: string;
}

/** Flat map of file path → contents. Binary entries come back as base64. */
export interface SkillBundle {
  slug: string;
  version?: string;
  entries: Record<string, { text?: string; base64?: string }>;
}

export class ClawHubClient extends Abject {
  private httpClientId?: AbjectId;
  private storageId?: AbjectId;
  private cache?: CacheEntry;
  private refreshInFlight?: Promise<void>;
  private loadMoreInFlight?: Promise<{ added: number; total: number; hasMore: boolean }>;

  constructor() {
    super({
      manifest: {
        name: 'ClawHubClient',
        description:
          'Browse and download skills from clawhub.ai, the vendor-neutral ' +
          'open skills registry (used by OpenClaw, content compatible with ' +
          'Claude Code). ~13k+ community-built skills in SKILL.md format.',
        version: '1.0.0',
        interface: {
          id: CLAWHUB_INTERFACE,
          name: 'ClawHubClient',
          description: 'ClawHub registry operations',
          methods: [
            {
              name: 'list',
              description: 'List cached skills. Auto-paginates in the background on first open; subsequent pages arrive via the `clawhubUpdated` event.',
              parameters: [
                { name: 'cursor', type: { kind: 'primitive', primitive: 'string' }, description: 'Opaque next-page cursor', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Cap on rows returned', optional: true },
              ],
              returns: {
                kind: 'object',
                properties: {
                  skills: { kind: 'array', elementType: { kind: 'reference', reference: 'ClawHubSkillSummary' } },
                  nextCursor: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
            {
              name: 'search',
              description: 'Server-side search across the full ClawHub catalog (vector + keyword).',
              parameters: [
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Search text' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ClawHubSkillSummary' } },
            },
            {
              name: 'downloadSkill',
              description: 'Fetch a skill bundle as a flat map of path → contents. Hand directly to SkillRegistry.installSkillBundle.',
              parameters: [
                { name: 'slug', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill slug (unique id)' },
                { name: 'version', type: { kind: 'primitive', primitive: 'string' }, description: 'Specific version (default: latest)', optional: true },
              ],
              returns: { kind: 'reference', reference: 'SkillBundle' },
            },
            {
              name: 'refresh',
              description: 'Drop the cache and walk every page again. Non-blocking; progress arrives via `clawhubUpdated` events.',
              parameters: [],
              returns: { kind: 'object', properties: { started: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'loadMore',
              description: 'Fetch the next page using the cached cursor.',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  added: { kind: 'primitive', primitive: 'number' },
                  total: { kind: 'primitive', primitive: 'number' },
                  hasMore: { kind: 'primitive', primitive: 'boolean' },
                },
              },
            },
            {
              name: 'status',
              description: 'Cache size, whether more pages exist, and whether a background walk is in progress.',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  total: { kind: 'primitive', primitive: 'number' },
                  hasMore: { kind: 'primitive', primitive: 'boolean' },
                  loading: { kind: 'primitive', primitive: 'boolean' },
                  fetchedAt: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'skill', 'registry'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadCache();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ClawHubClient Usage Guide

Browses clawhub.ai, the public vendor-neutral skills registry. Skills are
downloaded as ZIP bundles and installed via SkillRegistry.installSkillBundle.

### Browse + search

  const { skills } = await call(await dep('ClawHubClient'), 'list', {});
  const hits = await call(await dep('ClawHubClient'), 'search', { query: 'pdf', limit: 10 });

### Install a skill

  const bundle = await call(await dep('ClawHubClient'), 'downloadSkill', { slug: 'macos-calendar' });
  await call(await dep('SkillRegistry'), 'installSkillBundle', {
    name: bundle.slug,
    entries: bundle.entries,
  });

### IMPORTANT
- The interface ID is '${CLAWHUB_INTERFACE}'.
- Entries are cached for 24h; emit \`clawhubUpdated\` as pages arrive.
- Skills on ClawHub are untrusted community content; review before enabling.`;
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('list', async (msg: AbjectMessage) => {
      const { cursor, limit } = (msg.payload ?? {}) as { cursor?: string; limit?: number };
      return this.list(cursor, limit);
    });

    this.on('search', async (msg: AbjectMessage) => {
      const { query, limit } = msg.payload as { query: string; limit?: number };
      contractRequire(typeof query === 'string', 'query must be a string');
      return this.search(query, typeof limit === 'number' && limit > 0 ? limit : 25);
    });

    this.on('downloadSkill', async (msg: AbjectMessage) => {
      const { slug, version } = msg.payload as { slug: string; version?: string };
      contractRequire(typeof slug === 'string' && slug.length > 0, 'slug must be non-empty');
      return this.downloadSkill(slug, version);
    });

    this.on('refresh', async () => {
      this.cache = undefined;
      this.refreshInFlight = undefined;
      await this.persistCache();
      void this.ensureFreshCache();
      return { started: true };
    });

    this.on('loadMore', async () => {
      return this.loadMore();
    });

    this.on('status', async () => {
      return {
        total: this.cache?.skills.length ?? 0,
        hasMore: !!this.cache?.nextCursor,
        loading: this.refreshInFlight !== undefined || this.loadMoreInFlight !== undefined,
        fetchedAt: this.cache?.fetchedAt ?? 0,
      };
    });
  }

  // ─── Operations ─────────────────────────────────────────────────

  private async list(cursor: string | undefined, limit: number | undefined): Promise<{ skills: ClawHubSkillSummary[]; nextCursor?: string }> {
    if (cursor) {
      return this.fetchPage(cursor, limit ?? DEFAULT_PAGE_LIMIT);
    }
    await this.ensureFreshCache();
    const all = this.cache?.skills ?? [];
    const skills = typeof limit === 'number' && limit > 0 ? all.slice(0, limit) : all;
    return { skills, nextCursor: this.cache?.nextCursor };
  }

  private async search(query: string, limit: number): Promise<ClawHubSkillSummary[]> {
    const url = `${CLAWHUB_BASE_URL}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const body = await this.fetchJson(url);
    if (!body || typeof body !== 'object') return [];
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) return [];
    return results
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map(r => this.searchHitToSummary(r));
  }

  private async downloadSkill(slug: string, version?: string): Promise<SkillBundle> {
    contractRequire(this.httpClientId !== undefined, 'HttpClient not available');
    const params = new URLSearchParams();
    params.set('slug', slug);
    if (version) params.set('version', version);
    const url = `${CLAWHUB_BASE_URL}/download?${params.toString()}`;

    // Use getBase64 so binary zip survives the bus round-trip.
    const res = await this.request<{ ok: boolean; status: number; dataUri: string; size: number }>(
      request(this.id, this.httpClientId!, 'getBase64', { url }),
      60000,
    );
    if (!res.ok) throw new Error(`ClawHub download ${res.status} for ${slug}`);

    const comma = res.dataUri.indexOf(',');
    if (comma < 0) throw new Error(`Malformed data URI from ClawHub download`);
    const b64 = res.dataUri.slice(comma + 1);
    const zipBytes = Buffer.from(b64, 'base64');

    const entries = unzipToEntries(zipBytes);
    return { slug, version, entries };
  }

  // ─── Cache + pagination ────────────────────────────────────────

  private async ensureFreshCache(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) return;
    if (this.refreshInFlight) return this.refreshInFlight;

    const promise = this.walkAllPages(now);
    this.refreshInFlight = promise.finally(() => {
      if (this.refreshInFlight === promise) this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async walkAllPages(startedAt: number): Promise<void> {
    const collected: ClawHubSkillSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    const startMs = Date.now();

    try {
      while (pageCount < MAX_AUTO_PAGES) {
        const page = await this.fetchPage(cursor, DEFAULT_PAGE_LIMIT);
        pageCount++;

        for (const s of page.skills) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            collected.push(s);
          }
        }

        this.cache = {
          skills: collected.slice(),
          fetchedAt: startedAt,
          nextCursor: page.nextCursor,
        };
        await this.persistCache();
        this.changed('clawhubUpdated', {
          total: collected.length,
          hasMore: !!page.nextCursor,
        });

        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      const elapsed = Date.now() - startMs;
      log.info(`Cache refreshed: ${collected.length} skills across ${pageCount} pages in ${elapsed}ms${this.cache?.nextCursor ? ' (cap reached, more available)' : ''}`);
    } catch (err) {
      log.warn(`Pagination stopped early: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadMore(): Promise<{ added: number; total: number; hasMore: boolean }> {
    if (!this.cache?.nextCursor) {
      return { added: 0, total: this.cache?.skills.length ?? 0, hasMore: false };
    }
    if (this.loadMoreInFlight) return this.loadMoreInFlight;

    const cursor = this.cache.nextCursor;
    const existing = this.cache;
    const promise = (async () => {
      const page = await this.fetchPage(cursor, DEFAULT_PAGE_LIMIT);
      const seen = new Set(existing.skills.map(s => s.slug));
      const added: ClawHubSkillSummary[] = [];
      for (const s of page.skills) {
        if (!seen.has(s.slug)) {
          seen.add(s.slug);
          added.push(s);
        }
      }
      const merged = existing.skills.concat(added);
      this.cache = {
        skills: merged,
        fetchedAt: existing.fetchedAt,
        nextCursor: page.nextCursor,
      };
      await this.persistCache();
      this.changed('clawhubUpdated', {
        total: merged.length,
        hasMore: !!page.nextCursor,
      });
      return { added: added.length, total: merged.length, hasMore: !!page.nextCursor };
    })();

    this.loadMoreInFlight = promise.finally(() => {
      if (this.loadMoreInFlight === promise) this.loadMoreInFlight = undefined;
    });
    return this.loadMoreInFlight;
  }

  private async fetchPage(cursor: string | undefined, limit: number): Promise<{ skills: ClawHubSkillSummary[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const url = `${CLAWHUB_BASE_URL}/packages?${params.toString()}`;
    const body = await this.fetchJson(url);
    if (!body || typeof body !== 'object') return { skills: [] };
    const obj = body as Record<string, unknown>;
    const rawList = Array.isArray(obj.items) ? obj.items : [];
    const skills = rawList
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      // Only keep entries we can install as a SKILL.md bundle (skip souls).
      .filter(s => s.family === undefined || s.family === 'skill')
      .map(s => this.packageToSummary(s))
      .filter(s => s.slug.length > 0);
    const next = typeof obj.nextCursor === 'string' && obj.nextCursor.length > 0
      ? obj.nextCursor
      : undefined;
    return { skills, nextCursor: next };
  }

  private packageToSummary(raw: Record<string, unknown>): ClawHubSkillSummary {
    return {
      slug: typeof raw.name === 'string' ? raw.name
        : typeof raw.slug === 'string' ? raw.slug
        : '',
      displayName: typeof raw.displayName === 'string' ? raw.displayName
        : typeof raw.name === 'string' ? raw.name
        : '',
      ownerHandle: typeof raw.ownerHandle === 'string' ? raw.ownerHandle : undefined,
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      latestVersion: typeof raw.latestVersion === 'string' ? raw.latestVersion : undefined,
      family: typeof raw.family === 'string' ? raw.family : undefined,
      channel: typeof raw.channel === 'string' ? raw.channel : undefined,
      isOfficial: typeof raw.isOfficial === 'boolean' ? raw.isOfficial : undefined,
      verificationTier: typeof raw.verificationTier === 'string' ? raw.verificationTier : null,
      capabilityTags: Array.isArray(raw.capabilityTags)
        ? raw.capabilityTags.filter((t): t is string => typeof t === 'string')
        : undefined,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
    };
  }

  private searchHitToSummary(raw: Record<string, unknown>): ClawHubSkillSummary {
    return {
      slug: typeof raw.slug === 'string' ? raw.slug : '',
      displayName: typeof raw.displayName === 'string' ? raw.displayName
        : typeof raw.slug === 'string' ? raw.slug
        : '',
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      latestVersion: typeof raw.version === 'string' ? raw.version : undefined,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
    };
  }

  private async fetchJson(url: string): Promise<unknown> {
    contractRequire(this.httpClientId !== undefined, 'HttpClient not available');
    const res = await this.request<{ ok: boolean; status: number; body: string }>(
      request(this.id, this.httpClientId!, 'get', {
        url,
        headers: { 'Accept': 'application/json' },
      }),
      20000,
    );
    if (!res.ok) throw new Error(`ClawHub ${res.status} at ${url}`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`ClawHub returned non-JSON at ${url}`);
    }
  }

  private async loadCache(): Promise<void> {
    if (!this.storageId) return;
    try {
      const raw = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: CACHE_STORAGE_KEY }),
      );
      if (raw && typeof raw === 'object') {
        const candidate = raw as CacheEntry;
        if (Array.isArray(candidate.skills) && typeof candidate.fetchedAt === 'number') {
          const filtered = candidate.skills.filter(s => typeof s?.slug === 'string' && s.slug.length > 0);
          if (filtered.length === 0 && candidate.skills.length > 0) {
            log.info('Ignoring stale cache with no named skills');
            return;
          }
          this.cache = { ...candidate, skills: filtered };
        }
      }
    } catch { /* storage may not be ready yet */ }
  }

  private async persistCache(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: CACHE_STORAGE_KEY,
          value: this.cache ?? null,
        }),
      );
    } catch { /* best effort */ }
  }
}

// ─── Minimal ZIP extraction ──────────────────────────────────────
//
// We parse local file headers directly and use Node's zlib for deflate
// decompression. This avoids a third-party zip library; format reference:
// PKWARE APPNOTE.TXT section 4.3. Supports stored (method 0) and deflate
// (method 8) entries, which is what ClawHub ships.

const LOCAL_FILE_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;

function unzipToEntries(bytes: Buffer): Record<string, { text?: string; base64?: string }> {
  const entries: Record<string, { text?: string; base64?: string }> = {};
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const sig = bytes.readUInt32LE(offset);
    if (sig === CENTRAL_DIR_SIG) break; // reached central directory; done with entries
    if (sig !== LOCAL_FILE_SIG) break;   // not a recognised header; stop

    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    let compSize = bytes.readUInt32LE(offset + 18);
    const uncompSize = bytes.readUInt32LE(offset + 22);
    const nameLen = bytes.readUInt16LE(offset + 26);
    const extraLen = bytes.readUInt16LE(offset + 28);
    const name = bytes.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;

    // Streaming entries (bit 3) don't include size in the header; rely on
    // zlib's end-of-stream marker for deflate.
    let compData: Buffer;
    if (flags & 0x08) {
      // We can't know the exact compressed size; let zlib consume what it needs.
      compData = bytes.slice(dataStart);
    } else {
      compData = bytes.slice(dataStart, dataStart + compSize);
    }

    let content: Buffer;
    if (method === 0) {
      content = compData.slice(0, uncompSize);
      if (!(flags & 0x08)) compSize = uncompSize;
    } else if (method === 8) {
      try {
        content = zlib.inflateRawSync(compData);
      } catch (err) {
        log.warn(`Failed to inflate ${name}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (flags & 0x08) compSize = compData.length - (compData.length - countDeflateBytesConsumed(compData, content.length));
    } else {
      log.warn(`Unsupported compression method ${method} for ${name}`);
      break;
    }

    // Skip directories (zero-length, trailing slash).
    if (!name.endsWith('/')) {
      entries[name] = isProbablyText(content)
        ? { text: content.toString('utf8') }
        : { base64: content.toString('base64') };
    }

    if (flags & 0x08) {
      // Streaming entry: after compressed data there's a data descriptor
      // (4-byte signature + crc32 + compressed size + uncompressed size).
      // zlib told us how many bytes it consumed via `bytesWritten` on the
      // stream... but inflateRawSync doesn't surface that. Fall back to a
      // search: the signature 0x08074b50 precedes the descriptor.
      const desc = 0x08074b50;
      let i = dataStart;
      const max = Math.min(bytes.length - 16, dataStart + compData.length);
      while (i <= max && bytes.readUInt32LE(i) !== desc) i++;
      if (i <= max) {
        offset = i + 16;
        continue;
      }
      // Couldn't find it — give up.
      break;
    }

    offset = dataStart + compSize;
  }

  return entries;
}

/**
 * Rough "did zlib consume this much?" counter. We never actually call this
 * (see the streaming branch above) but keeping the helper makes it clear
 * that bit-3 streaming is an approximation: we rely on the data-descriptor
 * signature scan to find entry boundaries.
 */
function countDeflateBytesConsumed(_comp: Buffer, _uncompLen: number): number {
  return _comp.length;
}

function isProbablyText(buf: Buffer): boolean {
  // Heuristic: no NUL bytes + high-bit bytes don't dominate. Good enough
  // for SKILL.md, scripts, and README-style files we expect.
  if (buf.length === 0) return true;
  const sample = buf.slice(0, Math.min(4096, buf.length));
  let printable = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13) { printable++; continue; }
    if (b >= 0x20 && b < 0x7f) { printable++; continue; }
    if (b >= 0xc0) { printable++; continue; } // common UTF-8 lead bytes
  }
  return printable / sample.length > 0.8;
}
