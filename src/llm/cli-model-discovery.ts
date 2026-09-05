/**
 * Live model discovery for the CLI-backed providers.
 *
 * The coding-agent binaries are not catalogs. `claude` has no list command
 * at all, `codex` refreshes its own list from an endpoint it does not
 * expose, and `agy`'s list changes with every release. So each provider
 * answered listModels() with a handful of names typed in by hand, and the
 * picker went on offering four Claude aliases long after Fable 5.1, Opus 5
 * and Sonnet 5 had shipped: the list could only ever be as fresh as the
 * last time somebody edited this repo.
 *
 * This is the shared half of the fix. A source is anything that can produce
 * a model list; sources are tried best-first and the first one to return
 * anything wins, so an unreachable network degrades to the next source
 * rather than to an error. What stays with each provider is its own sources
 * - which endpoint, which filter, and which hand-written names are still
 * correct enough to offer when nothing answers at all.
 *
 * Everything is cached, because a settings panel asks several times per
 * paint: six dropdowns rebuilding is one request, not six.
 */

import { Log } from '../core/timed-log.js';
import type { ModelInfo } from './provider.js';

const log = new Log('CLI-MODELS');

/**
 * A live answer is reused for an hour. Catalogs change on release days, not
 * between two paints of a dropdown.
 */
const OK_TTL_MS = 60 * 60 * 1000;

/**
 * A fallback answer is held for 30s only. "Offline for a moment at startup"
 * is the common case, and a cache that pinned the hand-written names for a
 * full hour would reproduce the very bug this module exists to fix.
 */
const FALLBACK_TTL_MS = 30 * 1000;

/**
 * No discovery request may stall the UI. A fresh model list is a nicety; a
 * dropdown that will not open is not.
 */
const REQUEST_TIMEOUT_MS = 8_000;

/** Produces a model list, or [] meaning "I have nothing, try the next one". */
export type ModelSource = () => Promise<ModelInfo[]>;

interface CacheEntry {
  models: ModelInfo[];
  expiresAt: number;
  /** False for the hand-written fallback, so describe() can tell them apart. */
  live: boolean;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ModelInfo[]>>();

/**
 * The cached live list, if discovery has already succeeded for this key.
 *
 * describe() is synchronous and is what the settings panel paints first.
 * Without this it would always paint the hand-written names and rely on the
 * async refresh to correct them. Returns undefined rather than the fallback
 * so the caller stays in charge of what to show before anything is known.
 */
export function peekCachedModels(key: string): ModelInfo[] | undefined {
  const hit = cache.get(key);
  if (!hit || !hit.live || hit.expiresAt <= Date.now()) return undefined;
  return hit.models;
}

/** Drop every cached list. For tests, and for an explicit forced refresh. */
export function resetModelDiscoveryCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Try each source in order and return the first non-empty list.
 *
 * Concurrent callers share one lookup: the picker asks once per row, and
 * they all land on the same in-flight promise instead of the same endpoint.
 * A source that throws is not fatal on its own - that is what the next one
 * is for - so only the exhaustion of every source reaches the fallback.
 */
export async function discoverModels(
  key: string,
  sources: ModelSource[],
  fallback: ModelInfo[],
): Promise<ModelInfo[]> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.models;

  const pending = inflight.get(key);
  if (pending) return pending;

  const lookup = (async (): Promise<ModelInfo[]> => {
    for (const source of sources) {
      try {
        const models = await source();
        if (models.length > 0) {
          cache.set(key, { models, expiresAt: Date.now() + OK_TTL_MS, live: true });
          return models;
        }
      } catch (err) {
        log.warn(`${key}: model source failed, trying the next one`, err);
      }
    }
    log.warn(`${key}: no live model source answered; showing built-in names`);
    cache.set(key, { models: fallback, expiresAt: Date.now() + FALLBACK_TTL_MS, live: false });
    return fallback;
  })();

  inflight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    inflight.delete(key);
  }
}

/** GET a JSON document, giving up rather than hanging the caller. */
export async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface CatalogEntry {
  /** The id with its vendor prefix removed, e.g. 'claude-fable-5.1'. */
  id: string;
  /** A display name with the redundant vendor prefix removed. */
  name: string;
}

/**
 * The public OpenRouter catalog, filtered to one vendor.
 *
 * It needs no key, which is exactly what makes it the tier that actually
 * fires: every provider here authenticates through its own binary, so the
 * user typically has no vendor API key for us to borrow.
 */
export async function openRouterCatalog(vendorPrefix: string): Promise<CatalogEntry[]> {
  const body = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/models') as { data?: unknown };
  const rows = Array.isArray(body?.data) ? body.data as Array<Record<string, unknown>> : [];
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id.startsWith(vendorPrefix)) continue;
    // ':batch' and its siblings are billing and routing variants of a model
    // already in this list, not something a CLI can be pointed at.
    if (id.includes(':')) continue;
    const bare = id.slice(vendorPrefix.length);
    if (bare.length === 0 || seen.has(bare)) continue;
    seen.add(bare);
    const raw = typeof row.name === 'string' && row.name.length > 0 ? row.name : bare;
    out.push({ id: bare, name: stripVendorPrefix(raw) });
  }
  return out;
}

/** 'Anthropic: Claude Fable 5.1' -> 'Claude Fable 5.1'. */
function stripVendorPrefix(name: string): string {
  const cut = name.indexOf(': ');
  return cut > 0 ? name.slice(cut + 2) : name;
}
