/**
 * Model price list and cost estimation.
 *
 * Two sources of truth, in priority order:
 *
 * 1. What the provider says the call cost. OpenRouter reports `usage.cost`
 *    per response, and a charge the biller computed beats any arithmetic we
 *    could do from token counts: cached reads are discounted, cache writes
 *    carry a premium, and how each is folded into `inputTokens` varies by
 *    route.
 * 2. Failing that, published list prices from the table below, applied to
 *    the token counts the provider returned. This is an ESTIMATE and is
 *    labelled as one everywhere it surfaces.
 *
 * A model with no reported cost and no price entry is left UNPRICED rather
 * than counted as free. Spend that reads $0.00 because nobody knew the price
 * is worse than spend that says "unknown" out loud. Fill gaps with
 * `setModelPricing` on the LLM object (persisted, overrides this table).
 *
 * Prices are USD per million tokens. Local models (Ollama) and
 * subscription-billed CLI providers are priced at zero deliberately: no
 * per-token charge lands on the user's API bill for them.
 */

/** USD per million tokens for one model. */
export interface ModelPricing {
  /** Uncached input tokens. */
  inputPerMTok: number;
  /** Output tokens (including reasoning tokens the provider bills as output). */
  outputPerMTok: number;
  /**
   * Cache reads. Defaults to 0.1x input, the ratio Anthropic, OpenAI, and
   * most OpenAI-compatible routes charge.
   */
  cacheReadPerMTok?: number;
  /**
   * Cache writes. Defaults to 1.25x input (Anthropic's 5-minute TTL
   * premium); providers that re-cache for free are given 1.0x explicitly.
   */
  cacheWritePerMTok?: number;
}

/** A price entry plus where it came from, for display. */
export interface PricingEntry extends ModelPricing {
  /** Which price list this row came from: the built-in table or a user override. */
  source: 'builtin' | 'override';
}

/**
 * Built-in list prices, keyed `provider/model-prefix`. Lookup matches the
 * LONGEST prefix, so `anthropic/claude-opus-4` covers every dated snapshot
 * of that family without an entry per date.
 *
 * Anthropic prices verified against the published rate card. Prices for
 * providers whose rate cards are not verified here are deliberately absent:
 * a guessed price silently becomes a number the user reads as fact.
 */
const BUILTIN_PRICES: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────────────
  'anthropic/claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'anthropic/claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'anthropic/claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'anthropic/claude-opus-4': { inputPerMTok: 5, outputPerMTok: 25 },
  'anthropic/claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'anthropic/claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'anthropic/claude-haiku-4': { inputPerMTok: 1, outputPerMTok: 5 },

  // ── Local / subscription-billed: no per-token API charge ─────────
  'ollama/': { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
  'claude-cli/': { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
  'codex-cli/': { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
};

/** User-supplied prices, keyed the same way. These win over the built-ins. */
const overrides = new Map<string, ModelPricing>();

/** Normalize a provider/model pair into a lookup key. */
function priceKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}/${model.toLowerCase()}`;
}

/**
 * Find the price for a model by longest-prefix match, overrides first.
 * Returns undefined when the model is unpriced.
 */
export function lookupPricing(provider: string, model: string): PricingEntry | undefined {
  const key = priceKey(provider, model);
  let best: { entry: ModelPricing; len: number; source: 'builtin' | 'override' } | undefined;

  for (const [prefix, entry] of overrides) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { entry, len: prefix.length, source: 'override' };
    }
  }
  if (best) return { ...best.entry, source: 'override' };

  for (const prefix of Object.keys(BUILTIN_PRICES)) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { entry: BUILTIN_PRICES[prefix], len: prefix.length, source: 'builtin' };
    }
  }
  return best ? { ...best.entry, source: 'builtin' } : undefined;
}

/** Install (or clear, with `undefined`) a user price for a provider/model prefix. */
export function setPricingOverride(provider: string, model: string, pricing?: ModelPricing): void {
  const key = priceKey(provider, model);
  if (pricing) overrides.set(key, pricing);
  else overrides.delete(key);
}

/** All active overrides, for persistence and display. */
export function listPricingOverrides(): Array<{ key: string; pricing: ModelPricing }> {
  return Array.from(overrides.entries()).map(([key, pricing]) => ({ key, pricing }));
}

/** Replace the whole override set (used when restoring from storage). */
export function loadPricingOverrides(entries: Array<{ key: string; pricing: ModelPricing }>): void {
  overrides.clear();
  for (const { key, pricing } of entries) overrides.set(key.toLowerCase(), pricing);
}

/** Token counts a cost estimate is computed from. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Estimate what a call cost from its token counts and the list price.
 * Returns undefined when the model is unpriced, so callers can report the
 * call as unpriced instead of free.
 */
export function estimateCostUsd(
  provider: string,
  model: string,
  usage: UsageTokens,
): number | undefined {
  const price = lookupPricing(provider, model);
  if (!price) return undefined;

  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * 1.25;

  const cost =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWriteTokens ?? 0) * cacheWrite) /
    1_000_000;

  return cost;
}
