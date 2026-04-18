/**
 * MCPRegistryClient -- read-only client for the official MCP registry at
 * registry.modelcontextprotocol.io (v0.1 API, OpenAPI 3.1, stable since Oct 2025).
 *
 * Fetches server summaries and detail records, caches responses in Storage
 * under `mcp-registry:cache` with a 24h TTL so the CatalogBrowser is instant
 * on repeat opens and degrades gracefully when offline.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MCPRegistry');

const MCP_REGISTRY_INTERFACE: InterfaceId = 'abjects:mcp-registry-client';
const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io/v0.1';
const CACHE_STORAGE_KEY = 'mcp-registry:cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_PAGE_LIMIT = 100; // registry caps at 100 per request
/** Upper bound on pages we auto-walk during a cache refresh. At 100/page that
 *  is 10_000 servers — well above the registry's current size and plenty for
 *  the foreseeable future. Stops a buggy cursor from looping forever. */
const MAX_AUTO_PAGES = 100;

export const MCP_REGISTRY_CLIENT_ID = 'abjects:mcp-registry-client' as AbjectId;

/** Environment-variable declaration on a registry package. */
export interface MCPServerEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: string;
}

/**
 * Package reference as the registry currently ships it (schema
 * `static.modelcontextprotocol.io/schemas/2025-12-11`). Earlier drafts used
 * `registry_name` + `name`; we still accept those as fallbacks so a stale
 * cache can't break us.
 */
export interface MCPServerPackage {
  /** npm | pypi | docker | oci | ... */
  registryType?: string;
  /** Package specifier (e.g. `@cablate/mcp-google-map`). */
  identifier?: string;
  version?: string;
  transport?: { type?: string; url?: string };
  environmentVariables?: MCPServerEnvVar[];
  /** Back-compat aliases for earlier registry drafts. */
  registry_name?: string;
  name?: string;
}

/** Summary record returned by list/search. Intentionally lax: registry schema
 *  may add fields without breaking us. */
export interface MCPServerSummary {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: MCPServerPackage[];
  remotes?: Array<{ transport_type?: string; type?: string; url?: string }>;
  /** Populated by detail queries. */
  runtime_hint?: string;
}

export interface MCPServerDetail extends MCPServerSummary {
  /** Full JSON as returned by the registry. */
  raw: Record<string, unknown>;
}

interface CacheEntry {
  servers: MCPServerSummary[];
  fetchedAt: number;
  /** Cursor for the LAST page we fetched, if we need to resume. Undefined
   *  means we successfully walked to the end. */
  nextCursor?: string;
}

export class MCPRegistryClient extends Abject {
  private httpClientId?: AbjectId;
  private storageId?: AbjectId;
  private cache?: CacheEntry;
  /** Single in-flight refresh promise so concurrent callers share one walk. */
  private refreshInFlight?: Promise<void>;
  /** Single in-flight loadMore promise for the same reason. */
  private loadMoreInFlight?: Promise<{ added: number; total: number; hasMore: boolean }>;

  constructor() {
    super({
      manifest: {
        name: 'MCPRegistryClient',
        description:
          'Read-only client for the official MCP server registry at ' +
          'registry.modelcontextprotocol.io. Search, list, and fetch server ' +
          'metadata for the CatalogBrowser and for chat-driven install intents.',
        version: '1.0.0',
        interface: {
          id: MCP_REGISTRY_INTERFACE,
          name: 'MCPRegistryClient',
          description: 'MCP registry operations',
          methods: [
            {
              name: 'search',
              description: 'Case-insensitive substring search against the registry. Returns up to `limit` results.',
              parameters: [
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Search text' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'MCPServerSummary' } },
            },
            {
              name: 'list',
              description: 'List servers, paginated. Uses local cache when fresh; otherwise fetches a page from the registry.',
              parameters: [
                { name: 'cursor', type: { kind: 'primitive', primitive: 'string' }, description: 'Pagination cursor', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results per page', optional: true },
              ],
              returns: {
                kind: 'object',
                properties: {
                  servers: { kind: 'array', elementType: { kind: 'reference', reference: 'MCPServerSummary' } },
                  nextCursor: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
            {
              name: 'getServer',
              description: 'Fetch full detail for a single server.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Server name' },
                { name: 'version', type: { kind: 'primitive', primitive: 'string' }, description: 'Version (optional)', optional: true },
              ],
              returns: { kind: 'reference', reference: 'MCPServerDetail' },
            },
            {
              name: 'refresh',
              description: 'Drop the local cache and walk all pages again, emitting `changed` after each page so listeners can update incrementally.',
              parameters: [],
              returns: { kind: 'object', properties: { total: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'loadMore',
              description: 'Fetch the next page using the cached cursor. Returns { added, total, hasMore }.',
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
              description: 'Return the current cache size, cursor state, and whether a background walk is in progress.',
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
        tags: ['system', 'mcp', 'registry'],
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
    return super.askPrompt(_question) + `\n\n## MCPRegistryClient Usage Guide

Read-only window onto the official MCP server registry. Useful for building
install UIs and for chat-driven "install an MCP for X" intents.

### Search

  const hits = await call(await dep('MCPRegistryClient'), 'search', { query: 'gmail', limit: 10 });

### List (first page)

  const { servers, nextCursor } = await call(await dep('MCPRegistryClient'), 'list', {});

### Fetch full detail

  const detail = await call(await dep('MCPRegistryClient'), 'getServer', { name: '@example/server-foo' });
  // detail.packages[0] → { registry_name: 'npm', name: '...', version: '...' }

### IMPORTANT
- The interface ID is '${MCP_REGISTRY_INTERFACE}'.
- Results are cached for 24h in Storage; call 'refresh' to force a reload.
- The registry itself is case-insensitive on substring search.`;
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('search', async (msg: AbjectMessage) => {
      const { query, limit } = msg.payload as { query: string; limit?: number };
      contractRequire(typeof query === 'string', 'query must be a string');
      const max = typeof limit === 'number' && limit > 0 ? limit : DEFAULT_PAGE_LIMIT;
      return this.search(query, max);
    });

    this.on('list', async (msg: AbjectMessage) => {
      const { cursor, limit } = (msg.payload ?? {}) as { cursor?: string; limit?: number };
      // limit is optional: omit to receive every cached entry.
      return this.list(cursor, limit);
    });

    this.on('getServer', async (msg: AbjectMessage) => {
      const { name, version } = msg.payload as { name: string; version?: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      return this.getServer(name, version);
    });

    this.on('refresh', async () => {
      this.cache = undefined;
      this.refreshInFlight = undefined;
      await this.persistCache();
      // Kick off the walk in the background; caller gets an immediate reply
      // and the UI updates via `registryUpdated` events as pages arrive.
      void this.ensureFreshCache();
      return { started: true };
    });

    this.on('loadMore', async () => {
      return this.loadMore();
    });

    this.on('status', async () => {
      return {
        total: this.cache?.servers.length ?? 0,
        hasMore: !!this.cache?.nextCursor,
        loading: this.refreshInFlight !== undefined || this.loadMoreInFlight !== undefined,
        fetchedAt: this.cache?.fetchedAt ?? 0,
      };
    });
  }

  // ─── Operations ─────────────────────────────────────────────────

  private async search(query: string, limit: number): Promise<MCPServerSummary[]> {
    await this.ensureFreshCache();
    const q = query.trim().toLowerCase();
    const servers = this.cache?.servers ?? [];
    if (!q) return servers.slice(0, limit);

    const hits: MCPServerSummary[] = [];
    for (const s of servers) {
      const hay = `${s.name} ${s.description ?? ''}`.toLowerCase();
      if (hay.includes(q)) {
        hits.push(s);
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  private async list(cursor: string | undefined, limit: number | undefined): Promise<{ servers: MCPServerSummary[]; nextCursor?: string }> {
    if (cursor) {
      // Cursor is opaque to us; go straight to the registry for subsequent pages.
      return this.fetchPage(cursor, limit ?? DEFAULT_PAGE_LIMIT);
    }
    await this.ensureFreshCache();
    const all = this.cache?.servers ?? [];
    const servers = typeof limit === 'number' && limit > 0 ? all.slice(0, limit) : all;
    return { servers, nextCursor: this.cache?.nextCursor };
  }

  private async getServer(name: string, version?: string): Promise<MCPServerDetail> {
    const encName = encodeURIComponent(name);
    const suffix = version ? `/versions/${encodeURIComponent(version)}` : '';
    const url = `${REGISTRY_BASE_URL}/servers/${encName}${suffix}`;
    const body = await this.fetchJson(url);
    const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const inner = (raw.server && typeof raw.server === 'object')
      ? raw.server as Record<string, unknown>
      : raw;
    const summary = this.summariseRaw(inner);
    return { ...summary, raw };
  }

  // ─── Cache ──────────────────────────────────────────────────────

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

  /**
   * Fetch the first page, then keep following the cursor until the registry
   * stops returning one. Emits `changed` after each page so the UI streams
   * entries in rather than waiting for the whole walk. Safety-capped at
   * MAX_AUTO_PAGES to survive a cursor loop.
   */
  private async walkAllPages(startedAt: number): Promise<void> {
    const collected: MCPServerSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    const startMs = Date.now();

    try {
      while (pageCount < MAX_AUTO_PAGES) {
        const page = await this.fetchPage(cursor, DEFAULT_PAGE_LIMIT);
        pageCount++;

        // Dedupe by name — some entries ship multiple versions as separate
        // records and we only want the most recent we see per name.
        for (const s of page.servers) {
          if (!seen.has(s.name)) {
            seen.add(s.name);
            collected.push(s);
          }
        }

        // Update the cache after every page so listeners see progress.
        this.cache = {
          servers: collected.slice(),
          fetchedAt: startedAt,
          nextCursor: page.nextCursor,
        };
        await this.persistCache();
        this.changed('registryUpdated', {
          total: collected.length,
          hasMore: !!page.nextCursor,
        });

        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      const elapsed = Date.now() - startMs;
      log.info(`Cache refreshed: ${collected.length} servers across ${pageCount} pages in ${elapsed}ms${this.cache?.nextCursor ? ' (cap reached, more available)' : ''}`);
    } catch (err) {
      log.warn(`Pagination stopped early: ${err instanceof Error ? err.message : String(err)}`);
      // Keep whatever we collected in cache so the UI still has data.
    }
  }

  /**
   * Manual next-page append. Uses the cached cursor, appends entries, emits
   * `changed`. Safe to call repeatedly.
   */
  private async loadMore(): Promise<{ added: number; total: number; hasMore: boolean }> {
    if (!this.cache?.nextCursor) {
      return { added: 0, total: this.cache?.servers.length ?? 0, hasMore: false };
    }
    if (this.loadMoreInFlight) return this.loadMoreInFlight;

    const cursor = this.cache.nextCursor;
    const existing = this.cache;
    const promise = (async () => {
      const page = await this.fetchPage(cursor, DEFAULT_PAGE_LIMIT);
      const seen = new Set(existing.servers.map(s => s.name));
      const added: MCPServerSummary[] = [];
      for (const s of page.servers) {
        if (!seen.has(s.name)) {
          seen.add(s.name);
          added.push(s);
        }
      }
      const merged = existing.servers.concat(added);
      this.cache = {
        servers: merged,
        fetchedAt: existing.fetchedAt,
        nextCursor: page.nextCursor,
      };
      await this.persistCache();
      this.changed('registryUpdated', {
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

  private async fetchPage(cursor: string | undefined, limit: number): Promise<{ servers: MCPServerSummary[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const url = `${REGISTRY_BASE_URL}/servers?${params.toString()}`;
    const body = await this.fetchJson(url);
    if (!body || typeof body !== 'object') return { servers: [] };
    const obj = body as Record<string, unknown>;
    const rawList = Array.isArray(obj.servers) ? obj.servers : Array.isArray(obj.data) ? obj.data : [];
    const servers = rawList
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map(entry => {
        // Registry wraps each record as { server: {...}, _meta: {...} }.
        // Unwrap if present; fall back to the flat shape so we work with
        // native-shape responses too.
        const inner = (entry.server && typeof entry.server === 'object')
          ? entry.server as Record<string, unknown>
          : entry;
        return this.summariseRaw(inner);
      })
      .filter(s => s.name.length > 0);
    const metadata = (obj.metadata && typeof obj.metadata === 'object')
      ? obj.metadata as Record<string, unknown>
      : {};
    // Registry returns `nextCursor`; accept `next_cursor` too for safety.
    const next = typeof metadata.nextCursor === 'string'
      ? metadata.nextCursor
      : typeof metadata.next_cursor === 'string'
        ? metadata.next_cursor
        : typeof obj.nextCursor === 'string'
          ? obj.nextCursor
          : typeof obj.next_cursor === 'string'
            ? obj.next_cursor
            : undefined;
    return { servers, nextCursor: next };
  }

  private summariseRaw(raw: Record<string, unknown>): MCPServerSummary {
    const name = typeof raw.name === 'string' ? raw.name : '';
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    const title = typeof raw.title === 'string' ? raw.title : undefined;
    const version = typeof raw.version === 'string' ? raw.version : undefined;
    const summary: MCPServerSummary = { name };
    if (description) summary.description = description;
    if (title) summary.title = title;
    if (version) summary.version = version;
    if (raw.repository && typeof raw.repository === 'object') {
      summary.repository = raw.repository as MCPServerSummary['repository'];
    }
    if (Array.isArray(raw.packages)) {
      summary.packages = raw.packages as MCPServerSummary['packages'];
    }
    if (Array.isArray(raw.remotes)) {
      summary.remotes = raw.remotes as MCPServerSummary['remotes'];
    }
    if (typeof raw.runtime_hint === 'string') {
      summary.runtime_hint = raw.runtime_hint;
    }
    return summary;
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
    if (!res.ok) throw new Error(`Registry ${res.status} at ${url}`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`Registry returned non-JSON at ${url}`);
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
        if (Array.isArray(candidate.servers) && typeof candidate.fetchedAt === 'number') {
          // Drop cached entries that lack a usable name (can happen if an
          // older parser mis-extracted the registry wrapper shape).
          const filtered = candidate.servers.filter(s => typeof s?.name === 'string' && s.name.length > 0);
          if (filtered.length === 0 && candidate.servers.length > 0) {
            // Stale/broken cache; don't seed it.
            log.info('Ignoring stale cache with no named servers');
            return;
          }
          this.cache = { ...candidate, servers: filtered };
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
