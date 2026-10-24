/**
 * Context windows: how many tokens a model takes, and the conversation
 * budget that follows from it.
 *
 * A model's window decides how much an agent keeps verbatim before it starts
 * eliding, and how much source a tool may show in one piece. An unknown
 * window falls back to a small fixed budget, so a provider that does not
 * report windows makes every agent on it work as if its model were small.
 * Providers report the window from their own model list where the API gives
 * one (contextWindowOf); otherwise the public OpenRouter catalog, which
 * lists a context_length for nearly every hosted model, fills it in
 * (publicContextWindow).
 */

import { Log } from '../core/timed-log.js';
import { fetchJsonWithTimeout } from './cli-model-discovery.js';

const log = new Log('CONTEXT-WINDOW');

/**
 * The field names model lists use for the input window: OpenRouter and xAI
 * `context_length`, Anthropic `max_input_tokens`, Gemini `inputTokenLimit`,
 * vLLM `max_model_len`, and the spellings other OpenAI-compatible servers
 * use.
 */
const WINDOW_FIELDS = ['context_length', 'max_input_tokens', 'inputTokenLimit', 'context_window', 'max_context_length', 'max_model_len', 'contextWindow'] as const;

/** A model-list row's context window in tokens, when it reports one. */
export function contextWindowOf(row: unknown): number | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const fields = row as Record<string, unknown>;
  for (const name of WINDOW_FIELDS) {
    const value = fields[name];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

/** `{ contextWindow }` for a row that reports one, else `{}`: spread into a ModelInfo. */
export function windowField(row: unknown): { contextWindow?: number } {
  const window = contextWindowOf(row);
  return window !== undefined ? { contextWindow: window } : {};
}

/** Characters per token. Below the usual ~4, so estimates under-use a window rather than overflow it. */
export const CHARS_PER_TOKEN = 3.5;
/**
 * Tokens held back for the model's reply. The window covers input and output
 * together, so reserve enough for a long reasoning turn; floored at half the
 * window so a small local model still gets a usable input budget.
 */
const OUTPUT_RESERVE_TOKENS = 32000;
/** Fraction of the usable window at which cheap deterministic elision starts. */
export const SOFT_BUDGET_FRACTION = 0.60;
/** Fraction at which LLM summarization may run. */
export const HARD_BUDGET_FRACTION = 0.85;

/**
 * Whole-conversation budget in characters when the model's window is
 * unknown. 180k chars ≈ 45k tokens: small enough for almost any window,
 * which is exactly why it is only the fallback.
 */
export const FALLBACK_CONVERSATION_CHARS = 180000;

/** The conversation budget, in characters, for a model with this window (the fallback when unknown). */
export function conversationBudget(windowTokens: number | null | undefined): { soft: number; hard: number } {
  if (typeof windowTokens !== 'number' || !(windowTokens > 0)) {
    return { soft: Math.floor(FALLBACK_CONVERSATION_CHARS * (SOFT_BUDGET_FRACTION / HARD_BUDGET_FRACTION)), hard: FALLBACK_CONVERSATION_CHARS };
  }
  const usableTokens = Math.max(windowTokens - OUTPUT_RESERVE_TOKENS, windowTokens * 0.5);
  const usableChars = usableTokens * CHARS_PER_TOKEN;
  return {
    soft: Math.floor(usableChars * SOFT_BUDGET_FRACTION),
    hard: Math.floor(usableChars * HARD_BUDGET_FRACTION),
  };
}

// ── The public catalog ──────────────────────────────────────────────

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
/** A loaded catalog is reused for a day; windows change on release days. */
const CATALOG_OK_TTL_MS = 24 * 60 * 60 * 1000;
/** A failed load is retried after five minutes. */
const CATALOG_FAIL_TTL_MS = 5 * 60 * 1000;

let catalog: { windows: Map<string, number>; expiresAt: number } | undefined;
let catalogLoad: Promise<Map<string, number>> | undefined;

/**
 * One spelling for a model id across providers: lowercase, no vendor prefix
 * ('anthropic/'), no routing variant (':batch') or OpenRouter's '~' alias
 * mark, and dashes for dots, since providers write versions both ways
 * ('claude-fable-5.1' / 'claude-fable-5-1').
 */
function catalogKey(id: string): string {
  let key = id.trim().toLowerCase().replace(/^~/, '');
  const slash = key.lastIndexOf('/');
  if (slash >= 0) key = key.slice(slash + 1);
  const colon = key.indexOf(':');
  if (colon >= 0) key = key.slice(0, colon);
  return key.replace(/\./g, '-');
}

async function loadCatalog(): Promise<Map<string, number>> {
  if (catalog && catalog.expiresAt > Date.now()) return catalog.windows;
  catalogLoad ??= (async () => {
    const windows = new Map<string, number>();
    try {
      const body = await fetchJsonWithTimeout(CATALOG_URL) as { data?: unknown };
      const rows = Array.isArray(body?.data) ? body.data as unknown[] : [];
      for (const row of rows) {
        const id = (row as { id?: unknown })?.id;
        const window = contextWindowOf(row);
        if (typeof id !== 'string' || window === undefined) continue;
        // Two vendors' models under one bare name: keep the smaller window,
        // since overestimating overflows the model and underestimating only
        // trims sooner.
        const key = catalogKey(id);
        const known = windows.get(key);
        windows.set(key, known === undefined ? window : Math.min(known, window));
      }
      catalog = { windows, expiresAt: Date.now() + (windows.size > 0 ? CATALOG_OK_TTL_MS : CATALOG_FAIL_TTL_MS) };
    } catch (err) {
      log.warn(`could not load the public model catalog: ${err instanceof Error ? err.message : String(err)}`);
      catalog = { windows, expiresAt: Date.now() + CATALOG_FAIL_TTL_MS };
    } finally {
      catalogLoad = undefined;
    }
    return windows;
  })();
  return catalogLoad;
}

/**
 * A hosted model's context window from the public OpenRouter catalog, or
 * null when it is not listed. Tries the id as given, then without a dated
 * snapshot suffix ('-20251001', '-0813'). Not for local runtimes, whose
 * window is whatever they were configured with.
 */
export async function publicContextWindow(model: string): Promise<number | null> {
  const windows = await loadCatalog();
  const key = catalogKey(model);
  const undated = key.replace(/-(?:\d{8}|\d{4})$/, '');
  return windows.get(key) ?? windows.get(undated) ?? null;
}

/** Forget the loaded catalog (tests and a settings change that should re-ask). */
export function resetPublicCatalog(): void {
  catalog = undefined;
}
