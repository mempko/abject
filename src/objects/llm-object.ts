/**
 * LLM Service object - provides LLM capabilities to other objects.
 */

import { AbjectId, AbjectMessage } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { Capabilities } from '../core/capability.js';
import * as msg from '../core/message.js';
import { event } from '../core/message.js';
import {
  LLMProvider,
  LLMProviderDescription,
  FetchDelegate,
  FetchResult,
  LLMMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMStreamChunk,
  ModelTier,
  ModelInfo,
  EffortLevel,
  CacheProfile,
  getTextContent,
  truncateText,
  messageTextChars,
  conversationTextChars,
  enforceConversationCharBudget,
  systemMessage,
  userMessage,
} from '../llm/provider.js';
import {
  ModelPricing,
  estimateCostUsd,
  lookupPricing,
  listPricingOverrides,
  loadPricingOverrides,
  setPricingOverride,
} from '../llm/pricing.js';

export interface TierConfig {
  provider: string;
  model: string;
  /**
   * Reasoning-effort override for this tier. When set, requests routed
   * through the tier run at this effort unless the caller passed an explicit
   * `options.effort`. Omitted → the provider's per-tier default applies.
   */
  effort?: EffortLevel;
}

export interface CompressOptions {
  /** Total char budget for the compressed conversation. Default 180000. */
  targetChars?: number;
  /** Leading messages kept verbatim (system prompt, task statement). Default 2. */
  pinnedCount?: number;
  /** Trailing messages kept verbatim (current working context). Default 4. */
  keepRecent?: number;
  /** What the conversation is working on — focuses the distillation. */
  taskHint?: string;
}

export interface CompressResult {
  messages: LLMMessage[];
  originalChars: number;
  compressedChars: number;
  /** Which stages ran: 'distill-oversized', 'distill-middle', 'truncate', or 'none'. */
  methods: string[];
}

export type TierRouting = Partial<Record<ModelTier, TierConfig>>;

/**
 * The effective model behind one tier, with capabilities. `vision` is
 * tri-state: true = accepts image input, false = text-only, null = unknown
 * (treat as probably-capable rather than blocking).
 */
export interface TierCapability {
  provider: string;
  model: string | null;
  vision: boolean | null;
  /** The tier's configured reasoning-effort override, when one is set. */
  effort?: EffortLevel;
  /** Effort levels the model supports ([] = no selectable effort). */
  supportedEfforts?: EffortLevel[];
}

export interface TierCapabilities {
  smart: TierCapability | null;
  balanced: TierCapability | null;
  fast: TierCapability | null;
  code: TierCapability | null;
  /**
   * Optional vision substitute: the model to use for an image-bearing step
   * when the requested tier's model is text-only. Null when not configured.
   */
  visionFallback: TierCapability | null;
}
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAIProvider } from '../llm/openai.js';
import { ClaudeCliProvider } from '../llm/claude-cli.js';
import { CodexCliProvider } from '../llm/codex-cli.js';
import { AntigravityCliProvider } from '../llm/antigravity-cli.js';
import { OllamaProvider } from '../llm/ollama.js';
import { OpenRouterProvider } from '../llm/openrouter.js';
import { DeepSeekProvider } from '../llm/deepseek.js';
import { GrokProvider } from '../llm/grok.js';
import { GeminiProvider } from '../llm/google-gemini.js';
import { KimiProvider } from '../llm/kimi.js';
import { MetaProvider } from '../llm/meta.js';
import { MiniMaxProvider } from '../llm/minimax.js';
import type { HttpRequest, HttpResponse } from './capabilities/http-client.js';

const log = new Log('LLM');

const LLM_INTERFACE = 'abjects:llm';

export interface LLMQueryPayload {
  messages: LLMMessage[];
  options?: LLMCompletionOptions;
  provider?: string;
  /**
   * Who this call is really for, when the sender is calling on someone's
   * behalf. AgentAbject runs every agent's think step, so without this the
   * ledger attributes every agent's spend to AgentAbject and the one thing a
   * cost view has to answer — which agent is spending this — is unanswerable.
   * The sender's own identity is still recorded, as `via`.
   */
  onBehalfOf?: string;
}

export interface LLMGenerateCodePayload {
  language: string;
  description: string;
  context?: string;
}

export interface LLMAnalyzePayload {
  content: string;
  task: string;
}

/**
 * An in-flight call. Not a separate record: it is the same ledger entry the
 * call will finish as, still in `active` status.
 */
export type LLMActiveRequest = LLMLedgerEntry;

/**
 * Everything a provider told us about what one call consumed. Cache and
 * reasoning counts ride alongside the plain input/output pair because they
 * are separately priced, and `costUsd` is the provider's own charge when it
 * reports one (OpenRouter does) — always preferred over our arithmetic.
 */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

/**
 * One call, start to finish: who asked, what it ran on, what it consumed,
 * what it cost, and what was actually said. This is the ledger's unit of
 * record — the LLM object keeps every call as one of these, and everything
 * else (the monitor's active and history tabs, the stats line, the per-model
 * spend table) is a view or a rollup over them. Nothing is aggregated at
 * write time.
 *
 * `inputMessages` and `outputContent` are part of the entry, but they are
 * the one part that is not always resident: text is held in memory only for
 * the newest `residentTextEntries` calls and read back from storage on
 * demand for older ones. `hasText` says whether it is retrievable at all —
 * an entry whose text has been dropped, or that was recorded while text
 * storage was off, has `hasText: false` rather than an empty string that
 * would read as "the model said nothing".
 */
export interface LLMLedgerEntry {
  id: string;
  callerId: AbjectId;
  /**
   * Display name for whoever this call is attributed to: the `onBehalfOf`
   * subject when the sender named one, otherwise the sender itself.
   */
  callerName?: string;
  /**
   * The object that actually sent the request, when it differs from
   * `callerName`. Set only for on-behalf-of calls, so the machinery stays
   * visible without crowding the common case.
   */
  via?: string;
  method: string;
  provider: string;
  model: string;
  startTime: number;
  /** Undefined while the call is still running. */
  endTime?: number;
  elapsedMs: number;
  inputChars: number;
  outputChars: number;
  streaming: boolean;
  /** `active` entries are the in-flight calls the monitor's first tab shows. */
  status: 'active' | 'complete' | 'error';
  killed?: boolean;
  error?: string;
  /**
   * The tier the caller asked for (smart/balanced/fast/code), when it routed
   * by tier rather than naming a model. Without this, "what is the smart tier
   * costing me" is unanswerable from the ledger even though tier routing is
   * how most callers pick a model.
   */
  tier?: ModelTier;
  /** Reasoning effort the call ran at. Drives token spend on reasoning models. */
  effort?: EffortLevel;
  /** The caller's output cap, for reading alongside a truncated finishReason. */
  maxTokens?: number;
  /**
   * How generation ended. `length`/`max_tokens` means the answer was cut off
   * mid-thought — a real failure that otherwise looks identical to a clean
   * completion, since the call returns normally and is billed in full.
   */
  finishReason?: string;
  usage?: LLMUsage;
  /**
   * What this call cost, in USD. Set from the provider's reported charge
   * when there is one, otherwise estimated from list prices. Undefined
   * means the model is unpriced — which is not the same as free.
   */
  costUsd?: number;
  /** True when costUsd came from a list-price estimate rather than the provider. */
  costEstimated?: boolean;
  /**
   * The prompt as sent, roles included. Present when this entry's text is
   * resident; read it back for an older entry with `getRequestDetail` or
   * `getLedger({ includeText: true })`.
   */
  inputMessages?: string;
  /** The completion as returned. Same residency rule as inputMessages. */
  outputContent?: string;
  /** Whether this entry's text is retrievable at all, resident or in storage. */
  hasText?: boolean;
}

/** The name the monitor's detail view speaks: an entry with its text filled in. */
export type LLMHistoryEntry = LLMLedgerEntry;

/**
 * How much of the ledger to keep, and how much of it to hold in memory.
 *
 * One clock governs everything an entry carries, text included — a call is
 * either still on the books with what it said, or it is gone. The resident
 * bound is separate and is about memory, not history: text is the bulky
 * part, so only the newest few calls keep theirs in RAM while the rest stay
 * one storage read away.
 */
export interface LLMLedgerRetention {
  /** Drop entries, text and all, older than this many days. 0 disables the age bound. */
  maxAgeDays: number;
  /**
   * Hard ceiling on retained entries regardless of age, oldest dropped
   * first. 0 disables it — a safety valve, not the primary bound.
   */
  maxEntries: number;
  /** Whether to store prompt and completion text at all. */
  keepText: boolean;
  /**
   * How many of the newest entries hold their text in memory. Older entries
   * keep their text in storage and load it on demand.
   */
  residentTextEntries: number;
}

/** Filter for reading back the ledger. */
export interface LLMLedgerQuery {
  limit?: number;
  offset?: number;
  /** Only entries started at or after this timestamp. */
  since?: number;
  /** Only entries started at or before this timestamp. */
  until?: number;
  provider?: string;
  model?: string;
  status?: 'active' | 'complete' | 'error';
  callerName?: string;
  /**
   * Fill in prompt/completion text for entries whose text is not resident.
   * Off by default: the history list renders from metadata, and paging text
   * nobody is going to read is the expensive part.
   */
  includeText?: boolean;
}

/**
 * Headline totals. A rollup over the retained ledger, recomputed from the
 * entries rather than maintained as running counters — so it can never drift
 * from the calls it claims to summarize, and it always describes exactly the
 * window the ledger still holds (`windowStart`..`windowEnd`).
 */
export interface LLMStats {
  totalRequests: number;
  totalInputChars: number;
  totalOutputChars: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalErrors: number;
  totalLatencyMs: number;
  /** Total spend across every model, in USD (reported + estimated). */
  totalCostUsd: number;
  /** Ledger entries the totals were computed from. */
  entryCount: number;
  /** Start time of the oldest retained entry (0 when the ledger is empty). */
  windowStart: number;
  /** Start time of the newest retained entry (0 when the ledger is empty). */
  windowEnd: number;
}

/**
 * Spend for one provider/model pair. Derived on demand by rolling up the
 * ledger — there is no separate stored aggregate to fall out of step with
 * the calls.
 */
export interface LLMModelSpend {
  key: string;
  provider: string;
  model: string;
  requests: number;
  errors: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Total cost over the retained window: reportedCostUsd + estimatedCostUsd. */
  costUsd: number;
  /** Portion the provider billed us for directly. */
  reportedCostUsd: number;
  /** Portion derived from list prices. */
  estimatedCostUsd: number;
  /** Completed calls whose cost is unknown (no reported charge, no price entry). */
  unpricedRequests: number;
  totalLatencyMs: number;
  firstUsed: number;
  lastUsed: number;
  /** Cost per calendar day (local time), YYYY-MM-DD → USD. */
  byDay: Record<string, number>;
  /** Spend from calls made since this process started. */
  sessionCostUsd: number;
  /** Calls made since this process started. */
  sessionRequests: number;
}

/** The spend picture the LLM monitor renders, rolled up from the ledger. */
export interface LLMSpendReport {
  models: LLMModelSpend[];
  totals: {
    costUsd: number;
    reportedCostUsd: number;
    estimatedCostUsd: number;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    unpricedRequests: number;
  };
  todayCostUsd: number;
  sessionCostUsd: number;
  sessionStartedAt: number;
  /** Cost per day across all models, oldest first. */
  days: Array<{ day: string; costUsd: number }>;
  /**
   * Cost per routing tier. Tier is how most callers pick a model, so this is
   * usually the cut that answers "what is the expensive part of my setup".
   */
  byTier: Array<{ tier: string; costUsd: number; requests: number }>;
  /** Prices the user supplied, which override the built-in list. */
  pricingOverrides: Array<{ key: string; pricing: ModelPricing }>;
  /** How much history these totals cover. */
  retention: LLMLedgerRetention;
  entryCount: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Keepalive policy derived from a provider's CacheProfile: the economical
 * ping interval τ* (TTL minus a safety margin), the break-even idle horizon
 * I_max = τ*(w/r − 1) past which warmth costs more than the re-prefill it
 * prevents, and the per-arm ping budget that bounds total spend at roughly
 * one re-prefill even if every clock in the process lies.
 */
interface WarmPolicy {
  ttlMs: number;
  tauMs: number;
  iMaxMs: number;
  maxPings: number;
  minPrefixTokens: number;
}

/**
 * One tracked prompt-cache entry, mirroring (as well as the client can) a
 * prefix the provider currently holds warm. Identity is CONTENT — the
 * serialized (provider, model, message-prefix) — never the caller's
 * cacheKey, which is retained only for ping routing affinity and as the
 * release handle.
 *
 * Two clocks, deliberately distinct: `lastUsedAt` moves only on real
 * (paying) requests and decides whether warmth is still worth buying;
 * `lastWarmAt` moves on any successful refresh (real request or ping) and
 * tracks the provider's TTL. Pings never touch `lastUsedAt` — a keepalive
 * that could justify itself would never stop.
 */
interface WarmEntry {
  /** Short content hash for logs; identity is `serialized`. */
  id: string;
  providerName: string;
  model: string;
  messages: LLMMessage[];
  serialized: string;
  /** Last-seen routing key: replayed on pings, matched by releaseCache. */
  cacheKey?: string;
  prefixTokens: number;
  lastUsedAt: number;
  lastWarmAt: number;
  pingsRemaining: number;
  consecutiveFailures: number;
  pingInFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
  policy: WarmPolicy;
}

/**
 * The LLM object provides language model capabilities to the system.
 */
export class LLMObject extends Abject {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider?: string;
  private tierRouting: TierRouting = {};
  /** Optional vision substitute for image-bearing steps on text-only tiers. */
  private visionFallback?: TierConfig;
  private httpClientId?: AbjectId;

  // ── The ledger ────────────────────────────────────────────────────
  // Every call is one entry, from start to finish. Active requests are the
  // entries still in `active` status; history is the rest; the stats line
  // and the per-model spend table are rollups over the whole thing. There
  // is no second copy of any of it.
  //
  // Entries are resident for the whole retained window, because every
  // rollup scans them and metadata is cheap. Their TEXT is not: only the
  // newest `residentTextEntries` keep it in memory, and older entries load
  // it from storage on demand. Persistence is by calendar day — entries
  // chunk into one key per day (without text, so a rollup load stays cheap)
  // and each call's text gets its own key, written once and never rewritten.
  private _ledger: LLMLedgerEntry[] = [];
  private _byId: Map<string, LLMLedgerEntry> = new Map();
  /** Prompt text for in-flight calls, held until the entry completes. */
  private _pendingText: Map<string, string> = new Map();
  private readonly _sessionStartedAt = Date.now();
  private storageId?: AbjectId;

  private _retention: LLMLedgerRetention = {
    maxAgeDays: 7,
    maxEntries: 0,
    keepText: true,
    residentTextEntries: 50,
  };

  /** Day keys whose chunk changed and needs rewriting. */
  private dirtyDays: Set<string> = new Set();
  private ledgerSaveTimer?: ReturnType<typeof setTimeout>;
  private static readonly LEDGER_SAVE_DEBOUNCE_MS = 5000;
  private static readonly LEDGER_DAY_PREFIX = 'llm:ledger:day:';
  private static readonly LEDGER_TEXT_PREFIX = 'llm:ledger:text:';
  private static readonly LEDGER_INDEX_KEY = 'llm:ledger:days';
  private static readonly RETENTION_STORAGE_KEY = 'llm:ledgerRetention';
  private static readonly PRICING_STORAGE_KEY = 'llm:pricingOverrides';

  private _paused = false;
  private readonly _MAX_CONTENT_CHARS = 10_000;

  // ── Prompt-cache keepalive (the "cache warmer") ───────────────────────
  // Distinct from the progress-heartbeat keepaliveTimer in complete/stream:
  // this one re-reads large prompt prefixes on a timer during agent pauses
  // so the provider's prompt cache stays warm (cached reads at ~0.1× input
  // price instead of a full re-prefill after eviction). Default OFF — every
  // ping spends real money on the user's key.
  private cacheKeepaliveEnabled = false;
  /** Latched by the circuit breaker; only an explicit reconfigure resets it. */
  private cacheKeepaliveTripped = false;
  /** Content-addressed registry, small enough that identity is by string compare. */
  private warmEntries: WarmEntry[] = [];
  private _warmStats = { pings: 0, pingFailures: 0, pingInputTokens: 0, pingOutputTokens: 0, entriesDropped: 0 };
  /** Rolling window of ping send-times backing the runaway circuit breaker. */
  private _warmPingTimes: number[] = [];

  /** Max concurrently tracked prefixes; each retains a potentially large prompt. */
  private static readonly WARM_MAX_ENTRIES = 8;
  /** Safety margin under the provider TTL covering ping latency, jitter, and TTL-enforcement slack. */
  private static readonly WARM_TTL_MARGIN_S = 60;
  /** Consecutive ping failures before the entry is dropped (a failing ping means the cache is probably cold; retrying is paying to find out). */
  private static readonly WARM_MAX_PING_FAILURES = 2;
  /** Ping generation cap: a cache read, not an answer. */
  private static readonly WARM_PING_MAX_TOKENS = 8;
  /**
   * Circuit breaker: 3× the theoretical fleet maximum (8 entries pinging
   * every 240s ≈ 120/hour). Exceeding this means a bug category we didn't
   * foresee — disable the feature entirely rather than keep spending.
   */
  private static readonly WARM_MAX_PINGS_PER_HOUR = 360;

  constructor() {
    super({
      manifest: {
        name: 'LLM',
        description:
          'Language model service. Provides completion, code generation, and analysis capabilities. Use cases: generate text completions, analyze or summarize text, generate code from natural language.',
        version: '1.0.0',
        interface: {
            id: LLM_INTERFACE,
            name: 'LLM',
            description: 'Language model operations',
            methods: [
              {
                name: 'complete',
                description: 'Complete a conversation',
                parameters: [
                  {
                    name: 'messages',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'LLMMessage' },
                    },
                    description: 'Conversation messages',
                  },
                  {
                    name: 'options',
                    type: { kind: 'reference', reference: 'LLMCompletionOptions' },
                    description: 'Completion options',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'LLMCompletionResult' },
              },
              {
                name: 'generateCode',
                description: 'Generate code from description',
                parameters: [
                  {
                    name: 'language',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Programming language',
                  },
                  {
                    name: 'description',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What the code should do',
                  },
                  {
                    name: 'context',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Additional context (e.g., existing code)',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'analyze',
                description: 'Analyze content',
                parameters: [
                  {
                    name: 'content',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Content to analyze',
                  },
                  {
                    name: 'task',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Analysis task',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'stream',
                description: 'Stream a conversation completion. Sends llmChunk events for each token, returns full accumulated content.',
                parameters: [
                  {
                    name: 'messages',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'LLMMessage' },
                    },
                    description: 'Conversation messages',
                  },
                  {
                    name: 'options',
                    type: { kind: 'reference', reference: 'LLMCompletionOptions' },
                    description: 'Completion options',
                    optional: true,
                  },
                ],
                returns: { kind: 'object', properties: {
                  content: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'compress',
                description: 'Shrink an oversized conversation to fit a character budget. Oversized messages are split into chunks and distilled in parallel by a fast-tier model (preserving findings, errors, IDs, and partial results); the conversation middle is summarized next; deterministic head+tail truncation guarantees the budget as a last resort. Returns the compressed messages plus before/after sizes. Use this when a complete/stream call fails with PROMPT_TOO_LONG.',
                parameters: [
                  {
                    name: 'messages',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'LLMMessage' },
                    },
                    description: 'Conversation messages to compress',
                  },
                  {
                    name: 'options',
                    type: { kind: 'reference', reference: 'CompressOptions' },
                    description: 'Optional: targetChars (default 180000), pinnedCount (leading messages kept verbatim, default 2), keepRecent (trailing messages kept verbatim, default 4), taskHint (what the conversation is working on — improves distillation relevance)',
                    optional: true,
                  },
                ],
                returns: { kind: 'object', properties: {
                  messages: { kind: 'array', elementType: { kind: 'reference', reference: 'LLMMessage' } },
                  originalChars: { kind: 'primitive', primitive: 'number' },
                  compressedChars: { kind: 'primitive', primitive: 'number' },
                  methods: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                } },
              },
              {
                name: 'listProviders',
                description: 'List available LLM providers',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'primitive', primitive: 'string' },
                },
              },
              {
                name: 'listProviderDescriptions',
                description: 'List self-describing UI metadata for every known provider type (id, label, credential mode, default models, …). Returns descriptions for all known providers regardless of credential state, so settings UIs can render the full provider list before configure().',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'LLMProviderDescription' },
                },
              },
              {
                name: 'setProvider',
                description: 'Set the default provider',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Provider name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getStats',
                description: 'Get rolled-up stats, the calls currently in flight, recent history, and paused state. The stats are recomputed from the call ledger rather than kept as running counters, so they always describe exactly the window the ledger still retains (see stats.windowStart/windowEnd and the retention policy); activeRequests and history are cuts of that same ledger, not separate records.',
                parameters: [],
                returns: { kind: 'object', properties: {
                  stats: { kind: 'reference', reference: 'LLMStats' },
                  activeRequests: { kind: 'array', elementType: { kind: 'reference', reference: 'LLMActiveRequest' } },
                  history: { kind: 'array', elementType: { kind: 'reference', reference: 'LLMLedgerEntry' } },
                  retention: { kind: 'reference', reference: 'LLMLedgerRetention' },
                  paused: { kind: 'primitive', primitive: 'boolean' },
                }},
              },
              {
                name: 'getSpend',
                description: 'Get spend broken down by provider and model, rolled up from the call ledger. Returns { models, totals, todayCostUsd, sessionCostUsd, sessionStartedAt, days, pricingOverrides, retention, entryCount, windowStart, windowEnd }. Costs are the provider-reported charge where the provider reports one, otherwise an estimate from published list prices; calls with neither are counted in unpricedRequests rather than as free. The totals cover the retained ledger window, not necessarily all time — widen retention to widen the window. Session figures cover this process only.',
                parameters: [],
                returns: { kind: 'reference', reference: 'LLMSpendReport' },
              },
              {
                name: 'setModelPricing',
                description: 'Set (or clear) the price used to estimate cost for a model whose provider does not report one. The model is matched as a prefix, so a family name covers every dated snapshot in it. Pass pricing null to clear an override and fall back to the built-in price list. Persisted.',
                parameters: [
                  { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider name, e.g. anthropic' },
                  { name: 'model', type: { kind: 'primitive', primitive: 'string' }, description: 'Model id or id prefix, e.g. claude-opus-5' },
                  { name: 'pricing', type: { kind: 'reference', reference: 'ModelPricing' }, description: 'USD per million tokens: { inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok? }. Null clears the override.', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getModelPricing',
                description: 'Get the price that would be applied to a provider/model pair, including whether it came from the built-in list or a user override. Returns null when the model is unpriced.',
                parameters: [
                  { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider name' },
                  { name: 'model', type: { kind: 'primitive', primitive: 'string' }, description: 'Model id' },
                ],
                returns: { kind: 'reference', reference: 'ModelPricing' },
              },
              {
                name: 'getLedger',
                description: 'Read back recorded calls, newest first. Every LLM call is one ledger entry carrying caller, method, provider, model, routing (tier/effort/maxTokens), how generation ended, timings, character and token counts (including cache reads/writes and reasoning tokens), cost, and the prompt and completion text. Active requests and history are both cuts of this list — filter by status. Returns { entries, total, retention }.',
                parameters: [
                  { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max entries to return (default 200, cap 2000)', optional: true },
                  { name: 'offset', type: { kind: 'primitive', primitive: 'number' }, description: 'Entries to skip, for paging', optional: true },
                  { name: 'since', type: { kind: 'primitive', primitive: 'number' }, description: 'Only calls started at or after this epoch-ms timestamp', optional: true },
                  { name: 'until', type: { kind: 'primitive', primitive: 'number' }, description: 'Only calls started at or before this epoch-ms timestamp', optional: true },
                  { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Only calls on this provider', optional: true },
                  { name: 'model', type: { kind: 'primitive', primitive: 'string' }, description: 'Only calls on this model', optional: true },
                  { name: 'status', type: { kind: 'primitive', primitive: 'string' }, description: "'active' | 'complete' | 'error'", optional: true },
                  { name: 'callerName', type: { kind: 'primitive', primitive: 'string' }, description: 'Only calls made by this object', optional: true },
                  { name: 'includeText', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Fill in prompt/completion text for entries whose text is no longer resident. Off by default — the history list renders from metadata.', optional: true },
                ],
                returns: { kind: 'object', properties: {
                  entries: { kind: 'array', elementType: { kind: 'reference', reference: 'LLMLedgerEntry' } },
                  total: { kind: 'primitive', primitive: 'number' },
                  retention: { kind: 'reference', reference: 'LLMLedgerRetention' },
                }},
              },
              {
                name: 'getLedgerRetention',
                description: 'Get how much of the call ledger is kept and how much of it is held in memory: { maxAgeDays, maxEntries, keepText, residentTextEntries }.',
                parameters: [],
                returns: { kind: 'reference', reference: 'LLMLedgerRetention' },
              },
              {
                name: 'setLedgerRetention',
                description: 'Set how much of the call ledger to keep, and how much of it to hold in memory. One clock governs everything an entry carries, prompt and completion text included: a call is either still on the books with what it said, or it is gone. residentTextEntries is a memory bound rather than a history one — text beyond the newest N entries stays in storage and loads on demand. A tightened policy is applied immediately, not at the next call. Persisted. Returns the effective policy.',
                parameters: [
                  { name: 'maxAgeDays', type: { kind: 'primitive', primitive: 'number' }, description: 'Drop entries, text and all, older than this many days (0 = no age bound). Default 7.', optional: true },
                  { name: 'maxEntries', type: { kind: 'primitive', primitive: 'number' }, description: 'Hard ceiling on retained entries regardless of age, oldest dropped first (0 = no count bound). A safety valve; the age bound is the primary one. Default 0.', optional: true },
                  { name: 'keepText', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether to store prompt and completion text at all. Turning this off deletes what is already stored. Default true.', optional: true },
                  { name: 'residentTextEntries', type: { kind: 'primitive', primitive: 'number' }, description: 'How many of the newest entries hold their text in memory; older ones read it back from storage on demand. Default 50.', optional: true },
                ],
                returns: { kind: 'reference', reference: 'LLMLedgerRetention' },
              },
              {
                name: 'repriceLedger',
                description: 'Recompute recorded costs against the current price list, using the token counts each call already carries. Calls the provider billed directly are left untouched. Run this after setModelPricing to apply a new price to calls that were already recorded, including ones that were unpriced at the time. Returns { repriced, nowPriced }.',
                parameters: [],
                returns: { kind: 'object', properties: {
                  repriced: { kind: 'primitive', primitive: 'number' },
                  nowPriced: { kind: 'primitive', primitive: 'number' },
                }},
              },
              {
                name: 'clearLedger',
                description: 'Delete every recorded call, its stored prompt/completion text, and therefore every total rolled up from them. Calls still in flight are kept. Does not affect the price list or the retention policy.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'resetSpend',
                description: 'Alias for clearLedger, kept for callers written against the earlier name.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'killRequest',
                description: 'Kill an active LLM request',
                parameters: [
                  { name: 'requestId', type: { kind: 'primitive', primitive: 'string' }, description: 'The request ID to kill' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'releaseCache',
                description: 'Stop keeping the prompt cache warm for a cache key. Send this (fire-and-forget) when the task or conversation that was passing options.cacheKey reaches a terminal state, so the keepalive never keeps a dead session warm. Returns the number of tracked prefixes released.',
                parameters: [
                  { name: 'cacheKey', type: { kind: 'primitive', primitive: 'string' }, description: 'The cacheKey the requests were sent with' },
                ],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'pause',
                description: 'Pause the LLM object, rejecting new requests',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unpause',
                description: 'Unpause the LLM object, accepting requests again',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getRequestDetail',
                description: 'Get the full detail of a request including prompt and output',
                parameters: [
                  { name: 'requestId', type: { kind: 'primitive', primitive: 'string' }, description: 'The request ID' },
                ],
                returns: { kind: 'reference', reference: 'LLMHistoryEntry' },
              },
              {
                name: 'listProviderModels',
                description: 'List available models for a specific provider',
                parameters: [
                  { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider name' },
                  { name: 'ollamaUrl', type: { kind: 'primitive', primitive: 'string' }, description: 'Ollama base URL (optional, for listing before registration)', optional: true },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ModelInfo' } },
              },
              {
                name: 'setTierRouting',
                description: 'Set per-tier provider, model, and optional reasoning-effort routing',
                parameters: [
                  { name: 'tierRouting', type: { kind: 'reference', reference: 'TierRouting' }, description: 'Mapping from tier to { provider, model, effort? } — effort (none/minimal/low/medium/high/xhigh/max) overrides the provider default for requests routed through that tier' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getTierRouting',
                description: 'Get current per-tier provider and model routing',
                parameters: [],
                returns: { kind: 'reference', reference: 'TierRouting' },
              },
              {
                name: 'describeTiers',
                description: 'Describe the effective model behind each tier (smart/balanced/fast/code) including capabilities. Returns { smart, balanced, fast, code, visionFallback } where each entry is { provider, model, vision, effort?, supportedEfforts } — vision is true when the model accepts image input, false when it is text-only, and null when unknown; effort is the tier\'s configured reasoning-effort override when one is set; supportedEfforts lists the effort levels the model accepts ([] = no selectable effort). visionFallback is the optional substitute model for image-bearing steps when a tier is text-only (null when not configured); to use it, pass its provider in the request payload and its model in options.model. Consult this before sending image content: pick a tier whose vision is not false, use the fallback, or omit the image.',
                parameters: [],
                returns: { kind: 'reference', reference: 'TierCapabilities' },
              },
              {
                name: 'getVisionModel',
                description: 'The first configured model that accepts image input, searched in tier order (smart, balanced, fast) and then the vision fallback. Returns { tier, provider, model, vision } or null when every configured model is text-only. Consult this BEFORE building a workflow around screenshots or image analysis: null means images sent to the LLM are silently replaced with text notes, so visual verification is impossible until a vision-capable model is configured.',
                parameters: [],
                returns: {
                  kind: 'union',
                  variants: [
                    { kind: 'reference', reference: 'TierCapability' },
                    { kind: 'primitive', primitive: 'null' },
                  ],
                },
              },
              {
                name: 'transcribe',
                description: 'Transcribe audio to text (speech-to-text). Routes to the first registered provider with a transcription API unless a provider is named.',
                parameters: [
                  { name: 'audio', type: { kind: 'object', properties: { base64: { kind: 'primitive', primitive: 'string' }, mimeType: { kind: 'primitive', primitive: 'string' } } }, description: 'Encoded audio: { base64, mimeType }' },
                  { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider name (optional; auto-selected when omitted)', optional: true },
                  { name: 'model', type: { kind: 'primitive', primitive: 'string' }, description: 'Transcription model id (optional)', optional: true },
                  { name: 'language', type: { kind: 'primitive', primitive: 'string' }, description: 'Spoken language hint (optional)', optional: true },
                ],
                returns: { kind: 'object', properties: {
                  text: { kind: 'primitive', primitive: 'string' },
                  provider: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'synthesize',
                description: 'Synthesize speech audio from text (text-to-speech). Returns encoded audio as { base64, mimeType }. Routes to the first registered provider with a speech API unless a provider is named.',
                parameters: [
                  { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to speak' },
                  { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider name (optional; auto-selected when omitted)', optional: true },
                  { name: 'model', type: { kind: 'primitive', primitive: 'string' }, description: 'Speech model id (optional)', optional: true },
                  { name: 'voice', type: { kind: 'primitive', primitive: 'string' }, description: 'Voice id (optional; provider default when omitted)', optional: true },
                ],
                returns: { kind: 'object', properties: {
                  base64: { kind: 'primitive', primitive: 'string' },
                  mimeType: { kind: 'primitive', primitive: 'string' },
                  provider: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'supportsSpeech',
                description: 'Which speech directions a registered provider can serve right now',
                parameters: [],
                returns: { kind: 'object', properties: {
                  transcribe: { kind: 'primitive', primitive: 'boolean' },
                  synthesize: { kind: 'primitive', primitive: 'boolean' },
                  transcribeProvider: { kind: 'primitive', primitive: 'string' },
                  synthesizeProvider: { kind: 'primitive', primitive: 'string' },
                } },
              },
            ],
            events: [
              { name: 'requestStarted', description: 'Emitted when a new LLM request begins', payload: { kind: 'reference', reference: 'LLMActiveRequest' } },
              { name: 'requestCompleted', description: 'Emitted when an LLM request finishes', payload: { kind: 'object', properties: {} } },
              { name: 'requestError', description: 'Emitted when an LLM request fails', payload: { kind: 'object', properties: {} } },
              { name: 'requestProgress', description: 'Emitted periodically during streaming with output progress', payload: { kind: 'object', properties: {} } },
              { name: 'paused', description: 'Emitted when the LLM is paused', payload: { kind: 'primitive', primitive: 'boolean' } },
              { name: 'unpaused', description: 'Emitted when the LLM is unpaused', payload: { kind: 'primitive', primitive: 'boolean' } },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.LLM_QUERY],
        tags: ['system', 'llm', 'ai'],
      },
    });

    this.setupHandlers();
  }

  /**
   * Hard backstop on prompt size, checked before any provider call. ~600k
   * chars ≈ 150–200k tokens, at or above every configured model's context
   * window — anything bigger is a runaway prompt (e.g. an agent embedding a
   * multi-megabyte scratchpad dump) that would burn a round-trip just to get
   * an opaque 400 back. Failing locally is free and names the fat messages so
   * the caller can compact the right thing. Callers are expected to stay far
   * below this via their own budgets (AgentAbject trims to 180k chars).
   */
  private static readonly MAX_PROMPT_CHARS = 600_000;

  private checkPromptSize(messages: LLMMessage[]): void {
    const sizes = messages.map((msg) => getTextContent(msg).length);
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total <= LLMObject.MAX_PROMPT_CHARS) return;
    const offenders = sizes
      .map((chars, i) => ({ i, role: messages[i].role, chars }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 3)
      .map((o) => `#${o.i} (${o.role}, ${o.chars} chars)`)
      .join(', ');
    throw new Error(
      `PROMPT_TOO_LONG: ${total} chars across ${messages.length} messages exceeds the ` +
      `${LLMObject.MAX_PROMPT_CHARS}-char limit. Largest messages: ${offenders}. ` +
      `Call this object's 'compress' method with the same messages to shrink them, or drop oversized content.`
    );
  }

  private setupHandlers(): void {
    this.on('complete', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { messages, options, provider, onBehalfOf } = m.payload as LLMQueryPayload;
      this.checkPromptSize(messages);
      const result = await this.complete(messages, options, provider, m.routing.from, m.header.messageId, onBehalfOf);
      this.trackCacheWarmth(provider, options, messages, result.usage);
      return result;
    });

    this.on('generateCode', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { language, description, context } = m.payload as LLMGenerateCodePayload;
      return this.generateCode(language, description, context, m.routing.from, m.header.messageId);
    });

    this.on('analyze', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { content, task } = m.payload as LLMAnalyzePayload;
      return this.analyze(content, task, m.routing.from, m.header.messageId);
    });

    this.on('compress', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { messages, options, onBehalfOf } = m.payload as {
        messages: LLMMessage[];
        options?: CompressOptions;
        onBehalfOf?: string;
      };
      return this.compressMessages(messages, options ?? {}, m.routing.from, m.header.messageId, onBehalfOf);
    });

    this.on('stream', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { messages, options, provider: providerName, onBehalfOf } = m.payload as LLMQueryPayload;
      this.checkPromptSize(messages);
      const { provider, modelOverride, effortOverride } = this.resolveProviderAndModel(providerName, options?.tier);
      const effectiveOptions = this.applyRouting(options, modelOverride, effortOverride);

      const callerId = m.routing.from;
      const correlationId = m.header.messageId;

      // If provider doesn't support streaming, fall back to complete
      if (!provider.stream) {
        const result = await this.complete(messages, options, providerName, callerId, correlationId, onBehalfOf);
        // 'length' is the provider-agnostic signal for a truncated response.
        return { content: result.content, stopReason: result.finishReason === 'length' ? 'max_tokens' : result.finishReason };
      }

      const totalChars = messages.reduce((sum, m2) => sum + getTextContent(m2).length, 0);
      log.info(`→ ${provider.name} stream | ${messages.length} msgs | ${totalChars} chars | model=${effectiveOptions?.model ?? 'provider-default'}`);
      const start = Date.now();

      const activeReq = await this.trackRequestStart(
        correlationId, callerId, 'stream', provider.name,
        this.modelFor(provider, effectiveOptions), totalChars, true, messages,
        { tier: options?.tier, effort: effectiveOptions?.effort, maxTokens: options?.maxTokens },
        onBehalfOf,
      );

      // Keep-alive heartbeat sent every 30s for the entire stream lifetime.
      // Caller-side request timers are "no progress for N ms" — they reset on
      // any incoming event from this Abject. The chunk events already cover
      // the steady-state token-flow case, but two failure modes need an
      // explicit heartbeat: (1) pre-first-chunk model load / queue time, and
      // (2) mid-stream subprocess stalls that haven't yet hit the provider's
      // 180s idle-kill timer. Keeping the keepalive running through the whole
      // stream fills both gaps for ~one event/30s of overhead.
      // Must beat the 30s default no-progress request timeout with margin:
      // a heartbeat cadence EQUAL to the timeout loses the race every time
      // (the timer fires at 30.000s; the first beat lands at 30.00x plus bus
      // hops), which killed every ask whose LLM synthesis ran past ~29s.
      const KEEPALIVE_MS = 10000;
      let lastChunkAt = start;
      const keepaliveTimer: ReturnType<typeof setInterval> = setInterval(() => {
        const sinceChunk = Date.now() - lastChunkAt;
        // Skip keepalive if a chunk arrived within the last interval —
        // chunks already reset upstream timers, so the keepalive is redundant
        // during healthy token flow.
        if (sinceChunk < KEEPALIVE_MS) return;
        this.send(
          event(this.id, callerId, 'progress', {
            phase: 'llm-waiting',
            message: `Waiting for LLM (${Math.round((Date.now() - start) / 1000)}s)`,
          })
        );
      }, KEEPALIVE_MS);

      let fullContent = '';
      let stopReason: string | undefined;
      let usage: LLMStreamChunk['usage'];
      try {
        for await (const chunk of provider.stream(messages, effectiveOptions)) {
          if (activeReq.killed) {
            log.info(`Request ${correlationId} killed during streaming`);
            break;
          }
          lastChunkAt = Date.now();
          fullContent += chunk.content;
          if (chunk.stopReason) stopReason = chunk.stopReason;
          if (chunk.usage) usage = chunk.usage;
          activeReq.outputChars = fullContent.length;
          // Send each chunk as an event back to the requester
          this.send(event(this.id, callerId, 'llmChunk', {
            correlationId,
            content: chunk.content,
            done: chunk.done,
          }));
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`${provider.name} stream | ${elapsed}ms | ${errMsg}`);
        this.trackRequestError(correlationId, errMsg);
        throw err;
      } finally {
        clearInterval(keepaliveTimer);
      }

      const elapsed = Date.now() - start;
      // Reads and writes both, never one or the other: a call typically does
      // both (it reads the stable prefix back and writes a new entry for the
      // grown tail), and reporting only the read makes a write-heavy call
      // look free. Cost is what actually settles whether caching pays —
      // reads are discounted, writes carry a premium, and how each is folded
      // into inputTokens varies by route, so the token counts alone cannot
      // answer it.
      const cacheNote =
        (usage?.cacheReadTokens ? `/cached=${usage.cacheReadTokens}` : '') +
        (usage?.cacheWriteTokens ? `/cachewrite=${usage.cacheWriteTokens}` : '');
      const costNote = typeof usage?.costUsd === 'number' ? ` | cost=$${usage.costUsd.toFixed(5)}` : '';
      const tokenSummary = usage
        ? ` | tokens=${usage.inputTokens}in/${usage.outputTokens}out${cacheNote}${usage.reasoningTokens ? `/reasoning=${usage.reasoningTokens}` : ''}${costNote}`
        : '';
      // A stream that ends without a finish frame is suspect: the generation
      // may have been cut off upstream. Name it so truncation hunts don't
      // have to infer it from a bare 'unknown'.
      const reasonNote = stopReason === undefined && fullContent.length > 0
        ? 'unknown (no finish frame — possible truncation)'
        : (stopReason ?? 'unknown');
      log.info(`← ${provider.name} stream | ${fullContent.length} chars | ${elapsed}ms | reason=${reasonNote}${tokenSummary}`);
      this.trackRequestEnd(correlationId, fullContent, usage, stopReason);
      this.trackCacheWarmth(providerName, options, messages, usage);
      return { content: fullContent, stopReason, usage };
    });

    this.on('listProviders', async () => {
      return this.listProviders();
    });

    this.on('listProviderDescriptions', async () => {
      return this.listProviderDescriptions();
    });

    this.on('setProvider', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.setDefaultProvider(name);
    });

    this.on('configure', async (msg: AbjectMessage) => {
      const config = msg.payload as {
        credentials?: Record<string, string>;
        tierRouting?: TierRouting;
        visionFallback?: TierConfig | null;
        cacheKeepalive?: { enabled: boolean };
      };
      await this.configure(config);
      return true;
    });

    this.on('listProviderModels', async (m: AbjectMessage) => {
      const { provider: providerName, ollamaUrl } = m.payload as { provider: string; ollamaUrl?: string };
      // For Ollama, allow listing models from a URL even if provider not yet registered
      if (providerName === 'ollama' && !this.providers.get('ollama')) {
        const provider = new OllamaProvider({ baseUrl: ollamaUrl ?? 'http://localhost:11434' });
        return provider.listModels();
      }
      if (!this.providers.get(providerName)) return [];
      return this.getProviderModels(providerName, { refresh: true });
    });

    this.on('setTierRouting', async (msg: AbjectMessage) => {
      const { tierRouting, visionFallback } = msg.payload as {
        tierRouting: TierRouting;
        visionFallback?: TierConfig | null;
      };
      this.tierRouting = { ...tierRouting };
      if (visionFallback !== undefined) this.visionFallback = visionFallback ?? undefined;
      log.info(`Tier routing updated: ${JSON.stringify(this.tierRouting)} visionFallback=${JSON.stringify(this.visionFallback ?? null)}`);
      return true;
    });

    this.on('transcribe', async (m: AbjectMessage) => {
      const { audio, provider: providerName, model, language } = m.payload as {
        audio: { base64: string; mimeType: string };
        provider?: string; model?: string; language?: string;
      };
      require(audio !== undefined && typeof audio.base64 === 'string' && audio.base64.length > 0,
        'audio must carry non-empty base64');
      require(typeof audio.mimeType === 'string' && audio.mimeType.length > 0,
        'audio must carry a mimeType');
      return this.transcribeAudio(audio, providerName, model, language);
    });

    this.on('synthesize', async (m: AbjectMessage) => {
      const { text, provider: providerName, model, voice } = m.payload as {
        text: string; provider?: string; model?: string; voice?: string;
      };
      require(typeof text === 'string' && text.length > 0, 'text must be non-empty');
      return this.synthesizeSpeech(text, providerName, model, voice);
    });

    this.on('supportsSpeech', async () => {
      const transcriber = this.findSpeechProvider('transcribe');
      const synthesizer = this.findSpeechProvider('synthesize');
      return {
        transcribe: transcriber !== undefined,
        synthesize: synthesizer !== undefined,
        transcribeProvider: transcriber?.name,
        synthesizeProvider: synthesizer?.name,
      };
    });

    this.on('getTierRouting', async () => {
      return { ...this.tierRouting };
    });

    this.on('describeTiers', async () => {
      return this.describeTiers();
    });

    this.on('getVisionModel', async () => {
      return this.getVisionModel();
    });

    this.on('getStats', async () => {
      // Both lists are cuts of the same ledger, and the stats are a rollup
      // over it — nothing here is stored separately from the calls.
      const active = this._ledger.filter(e => e.status === 'active');
      // The recent-history working set matches the resident-text bound: it
      // is the same "recent calls you might actually open" window.
      const history = this.queryLedger({ limit: Math.max(1, this._retention.residentTextEntries) }).entries
        .filter(e => e.status !== 'active');
      return {
        stats: this.rollupStats(),
        activeRequests: active,
        history,
        retention: { ...this._retention },
        paused: this._paused,
        keepalive: {
          enabled: this.cacheKeepaliveEnabled,
          tripped: this.cacheKeepaliveTripped,
          ...this._warmStats,
          entries: this.warmEntries.map(e => ({
            id: e.id,
            provider: e.providerName,
            model: e.model,
            prefixTokens: e.prefixTokens,
            cacheKey: e.cacheKey,
            lastUsedAt: e.lastUsedAt,
            lastWarmAt: e.lastWarmAt,
            pingsRemaining: e.pingsRemaining,
          })),
        },
      };
    });

    this.on('getSpend', async () => {
      return this.buildSpendReport();
    });

    this.on('setModelPricing', async (m: AbjectMessage) => {
      const { provider, model, pricing } = m.payload as {
        provider?: string;
        model?: string;
        pricing?: ModelPricing | null;
      };
      require(typeof provider === 'string' && provider.length > 0, 'setModelPricing needs a provider');
      require(typeof model === 'string' && model.length > 0, 'setModelPricing needs a model (or model prefix)');
      if (pricing) {
        require(
          typeof pricing.inputPerMTok === 'number' && pricing.inputPerMTok >= 0 &&
          typeof pricing.outputPerMTok === 'number' && pricing.outputPerMTok >= 0,
          'setModelPricing needs non-negative inputPerMTok and outputPerMTok'
        );
      }
      setPricingOverride(provider!, model!, pricing ?? undefined);
      await this.savePricing();
      log.info(`Pricing ${pricing ? 'set' : 'cleared'} for ${provider}/${model}`);
      return true;
    });

    this.on('getModelPricing', async (m: AbjectMessage) => {
      const { provider, model } = m.payload as { provider?: string; model?: string };
      require(typeof provider === 'string' && typeof model === 'string', 'getModelPricing needs provider and model');
      return lookupPricing(provider!, model!) ?? null;
    });

    this.on('getLedger', async (m: AbjectMessage) => {
      const q = (m.payload ?? {}) as LLMLedgerQuery;
      const { entries, total } = this.queryLedger(q);
      const withText = q.includeText
        ? await Promise.all(entries.map(e => this.withText(e)))
        : entries;
      return { entries: withText, total, retention: { ...this._retention } };
    });

    this.on('getLedgerRetention', async () => ({ ...this._retention }));

    this.on('setLedgerRetention', async (m: AbjectMessage) => {
      const p = (m.payload ?? {}) as Partial<LLMLedgerRetention>;
      const next: LLMLedgerRetention = { ...this._retention };
      if (p.maxAgeDays !== undefined) {
        require(typeof p.maxAgeDays === 'number' && p.maxAgeDays >= 0, 'maxAgeDays must be a non-negative number');
        next.maxAgeDays = Math.floor(p.maxAgeDays);
      }
      if (p.maxEntries !== undefined) {
        require(typeof p.maxEntries === 'number' && p.maxEntries >= 0, 'maxEntries must be a non-negative number');
        next.maxEntries = Math.floor(p.maxEntries);
      }
      if (p.keepText !== undefined) {
        require(typeof p.keepText === 'boolean', 'keepText must be a boolean');
        next.keepText = p.keepText;
      }
      if (p.residentTextEntries !== undefined) {
        require(typeof p.residentTextEntries === 'number' && p.residentTextEntries >= 0,
          'residentTextEntries must be a non-negative number');
        next.residentTextEntries = Math.floor(p.residentTextEntries);
      }
      this._retention = next;
      await this.saveRetention();
      // A tightened policy takes effect now, not at the next call.
      this.enforceRetention();
      if (!next.keepText) await this.dropAllText();
      this.scheduleLedgerSave();
      log.info(`Ledger retention set: ${next.maxAgeDays}d${next.maxEntries > 0 ? ` / ${next.maxEntries} calls` : ''}, text ${next.keepText ? `on (${next.residentTextEntries} resident)` : 'off'}`);
      return { ...this._retention };
    });

    this.on('repriceLedger', async () => {
      const result = this.repriceLedger();
      log.info(`Repriced ${result.repriced} ledger entries (${result.nowPriced} previously unpriced)`);
      return result;
    });

    this.on('clearLedger', async () => {
      await this.clearLedger();
      return true;
    });

    // Retained under its old name: the monitor's reset button and any script
    // written against it still mean "throw away the recorded calls".
    this.on('resetSpend', async () => {
      await this.clearLedger();
      return true;
    });

    this.on('getRequestDetail', async (m: AbjectMessage) => {
      const { requestId } = m.payload as { requestId: string };
      const entry = this._byId.get(requestId);
      if (!entry) return null;

      if (entry.status === 'active') {
        return {
          ...entry,
          elapsedMs: Date.now() - entry.startTime,
          inputMessages: this._pendingText.get(requestId) ?? '',
          outputContent: '(still in progress)',
        } as LLMHistoryEntry;
      }
      return await this.withText(entry);
    });

    this.on('killRequest', async (m: AbjectMessage) => {
      const { requestId } = m.payload as { requestId: string };
      const req = this._byId.get(requestId);
      if (!req || req.status !== 'active') return false;
      req.killed = true;
      log.info(`Kill requested for ${requestId}`);
      return true;
    });

    this.on('releaseCache', async (m: AbjectMessage) => {
      const { cacheKey } = m.payload as { cacheKey?: string };
      require(typeof cacheKey === 'string' && cacheKey.length > 0, 'releaseCache needs the cacheKey the requests were sent with');
      const matches = this.warmEntries.filter(e => e.cacheKey === cacheKey);
      for (const entry of matches) this.dropWarmEntry(entry, 'released by caller');
      return matches.length;
    });

    this.on('pause', async () => {
      this._paused = true;
      // Pause stops spending too; entries are not resurrected on unpause —
      // only the next real request re-arms.
      this.dropAllWarmEntries('paused');
      log.info('LLM paused');
      this.changed('paused', true);
      return true;
    });

    this.on('unpause', async () => {
      this._paused = false;
      log.info('LLM unpaused');
      this.changed('unpaused', true);
      return true;
    });

  }

  /**
   * Register an LLM provider.
   */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    if (this.storageId) {
      // Order matters: the retention policy decides what the ledger load is
      // allowed to keep, and prices are needed before anything is re-priced.
      await this.loadRetention();
      await this.loadPricing();
      await this.loadLedger();
    } else {
      log.warn('Storage unavailable; the call ledger will reset when the process restarts');
    }
  }

  /**
   * Create a FetchDelegate that routes HTTP requests through the HttpClient abject.
   */
  private createFetchDelegate(): FetchDelegate {
    const self = this;
    return async (url: string, init: RequestInit, options?: { timeout?: number }): Promise<FetchResult> => {
      require(self.httpClientId !== undefined, 'httpClientId not set');

      const timeout = options?.timeout ?? 300000;

      // Resolve relative URLs (e.g. /api/anthropic/v1/messages) to absolute
      const resolvedUrl = url.startsWith('/') && typeof window !== 'undefined'
        ? new URL(url, window.location.origin).href
        : url;

      const httpRequest: HttpRequest = {
        method: (init.method as HttpRequest['method']) ?? 'GET',
        url: resolvedUrl,
        headers: init.headers as Record<string, string> | undefined,
        body: init.body as string | undefined,
        timeout,
      };

      const requestMsg = msg.request(
        self.id,
        self.httpClientId!,
        'request',
        httpRequest
      );

      const response = await self.request<HttpResponse>(requestMsg, timeout + 5000);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        ok: response.ok,
      };
    };
  }

  /**
   * Configure providers and tier routing.
   * All providers with valid credentials are registered simultaneously.
   */
  async configure(config: {
    credentials?: Record<string, string>;
    tierRouting?: TierRouting;
    visionFallback?: TierConfig | null;
    cacheKeepalive?: { enabled: boolean };
  }): Promise<void> {
    const fetchFn = this.httpClientId ? this.createFetchDelegate() : undefined;
    const credentials = config.credentials ?? {};

    // CLI providers — top-level entries in the registry alongside the API
    // ones. Always registered; their own `isAvailable()` reports whether
    // the binary is on PATH. Routing to an unreachable CLI surfaces a
    // clear error toast at call time.
    // Each CLI is offered under both transports so the user picks in tier
    // routing rather than through a separate setting. The stream-json entry
    // is the plain name because it is the one that reports token usage and
    // returns output verbatim; the pty entry trades both away for warm
    // startup.
    this.registerProvider(new ClaudeCliProvider());
    this.registerProvider(new ClaudeCliProvider({ transport: 'terminal' }));
    this.registerProvider(new CodexCliProvider());
    this.registerProvider(new CodexCliProvider({ transport: 'terminal' }));
    this.registerProvider(new AntigravityCliProvider());

    // API-key-credentialed providers, registered when a key is present.
    const apiKeyFactories: Array<[string, (apiKey: string) => LLMProvider]> = [
      ['anthropic',  (apiKey) => new AnthropicProvider({ apiKey, fetchFn })],
      ['openai',     (apiKey) => new OpenAIProvider({ apiKey, fetchFn })],
      ['openrouter', (apiKey) => new OpenRouterProvider({ apiKey, fetchFn })],
      ['deepseek',   (apiKey) => new DeepSeekProvider({ apiKey, fetchFn })],
      ['grok',       (apiKey) => new GrokProvider({ apiKey, fetchFn })],
      ['gemini',     (apiKey) => new GeminiProvider({ apiKey, fetchFn })],
      ['kimi',       (apiKey) => new KimiProvider({ apiKey, fetchFn })],
      ['minimax',    (apiKey) => new MiniMaxProvider({ apiKey, fetchFn })],
      ['meta',       (apiKey) => new MetaProvider({ apiKey, fetchFn })],
    ];
    for (const [id, make] of apiKeyFactories) {
      const cred = credentials[id];
      if (cred) this.registerProvider(make(cred));
    }

    // URL-credentialed providers (Ollama). Always register if configured;
    // also register if reachable at the default URL even without explicit
    // configuration.
    const ollamaUrl = credentials.ollama || 'http://localhost:11434';
    const ollamaProvider = new OllamaProvider({ baseUrl: ollamaUrl });
    if (await ollamaProvider.isAvailable()) {
      await ollamaProvider.autoDetectModel();
      this.registerProvider(ollamaProvider);
    } else if (credentials.ollama) {
      this.registerProvider(ollamaProvider);
    }

    // Apply tier routing
    if (config.tierRouting) {
      this.tierRouting = { ...config.tierRouting };
      log.info(`Tier routing configured: ${JSON.stringify(this.tierRouting)}`);
    }

    // Vision fallback: undefined leaves it untouched, null clears it
    if (config.visionFallback !== undefined) {
      this.visionFallback = config.visionFallback ?? undefined;
      log.info(`Vision fallback configured: ${JSON.stringify(this.visionFallback ?? null)}`);
    }

    // Cache keepalive: undefined leaves it untouched. An explicit reconfigure
    // is the one thing that resets a tripped circuit breaker.
    if (config.cacheKeepalive !== undefined) {
      this.cacheKeepaliveEnabled = !!config.cacheKeepalive.enabled;
      this.cacheKeepaliveTripped = false;
      if (!this.cacheKeepaliveEnabled) this.dropAllWarmEntries('keepalive disabled');
      log.info(`Cache keepalive ${this.cacheKeepaliveEnabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Complete a conversation.
   */
  async complete(
    messages: LLMMessage[],
    options?: LLMCompletionOptions,
    providerName?: string,
    callerId?: AbjectId,
    requestId?: string,
    onBehalfOf?: string,
  ): Promise<LLMCompletionResult> {
    const { provider, modelOverride, effortOverride } = this.resolveProviderAndModel(providerName, options?.tier);
    const effectiveOptions = this.applyRouting(options, modelOverride, effortOverride);

    const totalChars = messages.reduce((sum, m2) => sum + getTextContent(m2).length, 0);
    log.info(`→ ${provider.name} | ${messages.length} msgs | ${totalChars} chars | tier=${options?.tier ?? 'default'} model=${effectiveOptions?.model ?? 'provider-default'}${effectiveOptions?.effort ? ` effort=${effectiveOptions.effort}` : ''} maxTokens=${options?.maxTokens ?? 'default'}`);
    const start = Date.now();

    // Track active request
    const trackId = requestId ?? `internal-${Date.now()}`;
    if (callerId) {
      await this.trackRequestStart(trackId, callerId, 'complete', provider.name,
        this.modelFor(provider, effectiveOptions), totalChars, false, messages,
        { tier: options?.tier, effort: effectiveOptions?.effort, maxTokens: options?.maxTokens },
        onBehalfOf);
    }

    // Send keep-alive progress events every 30s so upstream timeouts don't fire
    // Must beat the 30s default no-progress request timeout with margin:
      // a heartbeat cadence EQUAL to the timeout loses the race every time
      // (the timer fires at 30.000s; the first beat lands at 30.00x plus bus
      // hops), which killed every ask whose LLM synthesis ran past ~29s.
      const KEEPALIVE_MS = 10000;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    if (callerId) {
      keepaliveTimer = setInterval(() => {
        this.send(
          event(this.id, callerId, 'progress', {
            phase: 'llm-waiting',
            message: `LLM request in progress (${Math.round((Date.now() - start) / 1000)}s)`,
          })
        );
      }, KEEPALIVE_MS);
    }

    try {
      const result = await provider.complete(messages, effectiveOptions);
      const elapsed = Date.now() - start;
      log.info(`← ${provider.name} | ${result.content.length} chars | ${elapsed}ms | reason=${result.finishReason} | tokens=${result.usage?.inputTokens ?? '?'}in/${result.usage?.outputTokens ?? '?'}out`);
      if (callerId) this.trackRequestEnd(trackId, result.content, result.usage, result.finishReason);
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`${provider.name} | ${elapsed}ms | ${errMsg}`);
      if (callerId) this.trackRequestError(trackId, errMsg);
      throw err;
    } finally {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    }
  }

  // ── Conversation compression ──────────────────────────────────────────

  /** Messages with more text than this get split-and-distilled individually. */
  private static readonly DISTILL_MESSAGE_THRESHOLD = 80_000;
  /** Chunk size fed to one fast-tier distillation call. */
  private static readonly DISTILL_CHUNK_CHARS = 50_000;
  /** Max concurrent distillation calls. */
  private static readonly DISTILL_CONCURRENCY = 4;

  /**
   * Shrink a conversation to fit a char budget, preserving meaning where
   * possible. Three stages, each only running if the previous left the
   * conversation over budget:
   *
   * 1. distill-oversized: each non-system message larger than the threshold
   *    is split into chunks and distilled in parallel by the fast tier, then
   *    replaced by its joined summaries. Handles the classic failure (one
   *    multi-megabyte observation) semantically instead of slicing it.
   * 2. distill-middle: the block between pinned and recent messages is
   *    chunked along message boundaries and distilled into synthetic context
   *    messages, like an agent conversation summary.
   * 3. truncate: deterministic head+tail truncation of the largest messages
   *    until the budget holds. No LLM, cannot fail — this is the guarantee.
   *
   * System messages are never LLM-distilled (rewriting instructions changes
   * behavior); if a system prompt is itself oversized, only stage 3 touches it.
   */
  async compressMessages(
    messages: LLMMessage[],
    options: CompressOptions,
    callerId?: AbjectId,
    requestId?: string,
    onBehalfOf?: string,
  ): Promise<CompressResult> {
    const targetChars = options.targetChars ?? 180_000;
    const pinnedCount = options.pinnedCount ?? 2;
    const keepRecent = options.keepRecent ?? 4;
    const taskHint = options.taskHint ?? '';

    // Work on a deep-enough copy: messages are replaced, never mutated.
    const out: LLMMessage[] = messages.map((m) => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : m.content.map((p) => ({ ...p })),
    }));
    const originalChars = conversationTextChars(out);
    const methods: string[] = [];

    if (originalChars <= targetChars) {
      return { messages: out, originalChars, compressedChars: originalChars, methods: ['none'] };
    }

    const baseId = requestId ?? `compress-${this.id.slice(0, 8)}`;
    let distillSeq = 0;

    // Stage 1: split-and-distill individual oversized messages.
    {
      const jobs: Array<() => Promise<void>> = [];
      out.forEach((m, i) => {
        if (m.role === 'system') return;
        const len = messageTextChars(m);
        if (len <= LLMObject.DISTILL_MESSAGE_THRESHOLD) return;
        jobs.push(async () => {
          const text = getTextContent(m);
          const summary = await this.distillText(text, taskHint, callerId, `${baseId}-m${i}`, () => distillSeq++, onBehalfOf);
          const replacement = `[Oversized message (${len} chars) distilled to preserve context budget]\n${summary}`;
          if (typeof m.content === 'string') {
            m.content = replacement;
          } else {
            // Keep non-text parts (images, documents); replace all text parts
            // with the single summary.
            m.content = [
              { type: 'text', text: replacement },
              ...m.content.filter((p) => p.type !== 'text'),
            ];
          }
        });
      });
      if (jobs.length > 0) {
        methods.push('distill-oversized');
        await this.runPool(jobs, LLMObject.DISTILL_CONCURRENCY);
      }
    }

    // Stage 2: distill the middle block (between pinned and recent).
    if (conversationTextChars(out) > targetChars) {
      const middleEnd = Math.max(pinnedCount, out.length - keepRecent);
      if (middleEnd > pinnedCount) {
        const middle = out.slice(pinnedCount, middleEnd);
        // Chunk along message boundaries.
        const chunks: LLMMessage[][] = [];
        let current: LLMMessage[] = [];
        let currentLen = 0;
        for (const m of middle) {
          const len = messageTextChars(m);
          if (current.length > 0 && currentLen + len > LLMObject.DISTILL_CHUNK_CHARS) {
            chunks.push(current);
            current = [];
            currentLen = 0;
          }
          current.push(m);
          currentLen += len;
        }
        if (current.length > 0) chunks.push(current);

        const summaries = new Array<string>(chunks.length);
        const jobs = chunks.map((chunk, ci) => async () => {
          const serialized = chunk
            .map((m, mi) => `---- message ${mi + 1} (${m.role}) ----\n${truncateText(getTextContent(m), LLMObject.DISTILL_CHUNK_CHARS)}`)
            .join('\n\n');
          summaries[ci] = await this.distillText(serialized, taskHint, callerId, `${baseId}-c${ci}`, () => distillSeq++, onBehalfOf);
        });
        methods.push('distill-middle');
        await this.runPool(jobs, LLMObject.DISTILL_CONCURRENCY);

        const synthetic: LLMMessage = {
          role: 'user',
          content: `[Earlier context — ${middle.length} messages distilled]\n${summaries.join('\n\n')}`,
        };
        out.splice(pinnedCount, middleEnd - pinnedCount, synthetic);
      }
    }

    // Stage 3: deterministic guarantee.
    if (conversationTextChars(out) > targetChars) {
      methods.push('truncate');
      enforceConversationCharBudget(out, targetChars);
    }

    const compressedChars = conversationTextChars(out);
    log.info(`compress | ${originalChars} → ${compressedChars} chars | ${messages.length} → ${out.length} msgs | stages=${methods.join('+')}`);
    return { messages: out, originalChars, compressedChars, methods };
  }

  /**
   * Distill one text blob via the fast tier. Long blobs are split into
   * chunks distilled in parallel and joined. Falls back to head+tail
   * truncation when the fast tier fails — compression must never throw.
   */
  private async distillText(
    text: string,
    taskHint: string,
    callerId: AbjectId | undefined,
    idPrefix: string,
    nextSeq: () => number,
    onBehalfOf?: string,
  ): Promise<string> {
    const systemPrompt = `You are compressing part of a working conversation so an agent can keep going without losing its progress. Distil the content below into a tight, factual summary (target: under 2000 chars). Include every one of:
- findings and discovered facts (IDs, names, states, values)
- actions attempted and their outcomes (what succeeded, what failed, error messages)
- partial results that later steps will need
- decisions made and rejected options
- blockers and what is still unknown
Omit: duplicated schema dumps, long method catalogs, decorative headers. Write in neutral prose with bullet points — this is context, not a narrative.`;
    const hint = taskHint ? `The conversation's task: "${taskHint.slice(0, 400)}"\n\n` : '';

    const chunkSize = LLMObject.DISTILL_CHUNK_CHARS;
    const chunks: string[] = [];
    for (let off = 0; off < text.length; off += chunkSize) {
      chunks.push(text.slice(off, off + chunkSize));
    }

    const summaries = new Array<string>(chunks.length);
    const jobs = chunks.map((chunk, i) => async () => {
      try {
        const result = await this.complete(
          [
            systemMessage(systemPrompt),
            userMessage(`${hint}Content to distil${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ''}:\n\n${chunk}`),
          ],
          { tier: 'fast', maxTokens: 1024 },
          undefined,
          callerId,
          `${idPrefix}-d${nextSeq()}`,
          onBehalfOf,
        );
        const summary = result.content?.trim();
        if (!summary) throw new Error('empty summary');
        summaries[i] = summary;
      } catch (err) {
        log.warn(`distill chunk failed (${err instanceof Error ? err.message : String(err)}) — truncating instead`);
        summaries[i] = truncateText(chunk, 2000);
      }
    });
    await this.runPool(jobs, LLMObject.DISTILL_CONCURRENCY);
    return summaries.join('\n\n');
  }

  /** Run async jobs with bounded concurrency. */
  private async runPool(jobs: Array<() => Promise<void>>, concurrency: number): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
      }
    });
    await Promise.all(workers);
  }

  /**
   * Generate code from a description.
   */
  async generateCode(
    language: string,
    description: string,
    context?: string,
    callerId?: AbjectId,
    requestId?: string,
  ): Promise<string> {
    const systemPrompt = `You are a code generator. Generate clean, well-documented ${language} code.
Only output the code, no explanations. Use proper formatting and comments.`;

    let userPrompt = `Generate ${language} code that: ${description}`;
    if (context) {
      userPrompt += `\n\nContext:\n${context}`;
    }

    const result = await this.complete([
      systemMessage(systemPrompt),
      userMessage(userPrompt),
    ], { tier: 'smart' }, undefined, callerId, requestId);

    // Extract code from markdown if present
    return this.extractCode(result.content, language);
  }

  /**
   * Analyze content.
   */
  async analyze(
    content: string,
    task: string,
    callerId?: AbjectId,
    requestId?: string,
  ): Promise<string> {
    const result = await this.complete([
      systemMessage(
        'You are an expert analyst. Provide clear, structured analysis.'
      ),
      userMessage(`${task}\n\nContent:\n${content}`),
    ], { tier: 'balanced' }, undefined, callerId, requestId);

    return result.content;
  }

  /**
   * List available providers.
   */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Self-describing UI metadata for every known provider type. Used by
   * GlobalSettings to render the AI tab — credential rows, default tier
   * models, static model-list seeds — without per-provider hardcoding.
   *
   * Returns descriptions for all known providers regardless of whether
   * they are registered with credentials yet, so the dropdown can show
   * the full set on first run. Already-registered providers' live
   * `describe()` is preferred over the stub instance.
   */
  listProviderDescriptions(): LLMProviderDescription[] {
    const descriptions: LLMProviderDescription[] = [];
    for (const factory of LLMObject.PROVIDER_DESCRIPTORS) {
      const registered = this.providers.get(factory.id);
      if (registered) {
        descriptions.push(registered.describe());
      } else {
        descriptions.push(factory.describe());
      }
    }
    return descriptions;
  }

  /**
   * Static list of provider factories. Each entry is a stub instance
   * (constructed with no credentials) used purely to harvest its
   * `describe()` for the AI tab. Keep this list aligned with the set of
   * providers `configure()` knows how to register — the order here is
   * the order the dropdown shows.
   */
  private static readonly PROVIDER_DESCRIPTORS: ReadonlyArray<{
    id: string;
    describe(): LLMProviderDescription;
  }> = [
    new AnthropicProvider({ apiKey: '' }),
    new OpenAIProvider({ apiKey: '' }),
    new ClaudeCliProvider(),
    new ClaudeCliProvider({ transport: 'terminal' }),
    new CodexCliProvider(),
    new CodexCliProvider({ transport: 'terminal' }),
    new AntigravityCliProvider(),
    new OllamaProvider(),
    new OpenRouterProvider({ apiKey: '' }),
    new DeepSeekProvider({ apiKey: '' }),
    new GrokProvider({ apiKey: '' }),
    new GeminiProvider({ apiKey: '' }),
    new KimiProvider({ apiKey: '' }),
    new MiniMaxProvider({ apiKey: '' }),
    new MetaProvider({ apiKey: '' }),
  ].map(p => ({ id: p.describe().id, describe: () => p.describe() }));

  /**
   * Set the default provider.
   */
  setDefaultProvider(name: string): boolean {
    if (!this.providers.has(name)) {
      return false;
    }
    this.defaultProvider = name;
    return true;
  }

  /**
   * Resolve an AbjectId to a human-readable name by asking the caller directly.
   * Every Abject has a built-in 'describe' handler that returns its manifest.
   */
  private async resolveCallerName(callerId: AbjectId): Promise<string | undefined> {
    try {
      const result = await this.request<{ manifest: { name: string } }>(
        msg.request(this.id, callerId, 'describe', {}),
        5000,
      );
      return result?.manifest?.name;
    } catch {
      return undefined;
    }
  }

  /**
   * Begin tracking an active request.
   */
  private truncate(s: string): string {
    if (s.length <= this._MAX_CONTENT_CHARS) return s;
    return s.slice(0, this._MAX_CONTENT_CHARS) + '\n...(truncated)';
  }

  private serializeMessages(messages: LLMMessage[]): string {
    return this.truncate(
      messages.map(m => `[${m.role}]: ${getTextContent(m)}`).join('\n\n')
    );
  }

  /**
   * The model a request will run on, for tracking. Never throws — an
   * unconfigured provider (which would fail the request itself anyway)
   * reports the explicit option or 'unknown'.
   */
  private modelFor(provider: LLMProvider, options?: LLMCompletionOptions): string {
    try {
      return provider.resolveModel(options);
    } catch {
      return options?.model ?? 'unknown';
    }
  }

  // ── The ledger: write path ────────────────────────────────────────

  /** Local calendar day key, the unit both retention and persistence use. */
  private static dayKey(ts: number): string {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  /**
   * Open a ledger entry for a call that is starting. The entry goes into the
   * ledger immediately, in `active` status — the monitor's Active Requests
   * tab is a filter over these, not a separate collection — and is mutated
   * in place as the call streams and finishes.
   */
  private async trackRequestStart(
    requestId: string,
    callerId: AbjectId,
    method: string,
    providerName: string,
    model: string,
    inputChars: number,
    streaming: boolean,
    messages?: LLMMessage[],
    routing?: { tier?: ModelTier; effort?: EffortLevel; maxTokens?: number },
    onBehalfOf?: string,
  ): Promise<LLMLedgerEntry> {
    const senderName = await this.resolveCallerName(callerId);
    // Attribute to the subject when the sender named one; keep the sender as
    // `via` so the route is still inspectable rather than erased.
    const callerName = onBehalfOf ?? senderName;
    const entry: LLMLedgerEntry = {
      id: requestId,
      callerId,
      callerName,
      ...(onBehalfOf && senderName && senderName !== onBehalfOf ? { via: senderName } : {}),
      method,
      provider: providerName,
      model,
      startTime: Date.now(),
      elapsedMs: 0,
      inputChars,
      outputChars: 0,
      streaming,
      killed: false,
      status: 'active',
      tier: routing?.tier,
      effort: routing?.effort,
      maxTokens: routing?.maxTokens,
    };
    this._ledger.push(entry);
    this._byId.set(requestId, entry);
    if (messages) this._pendingText.set(requestId, this.serializeMessages(messages));
    this.changed('requestStarted', { ...entry });
    return entry;
  }

  /**
   * Close a ledger entry that completed: fold in the token counts, price the
   * call, and hand its message bodies to storage.
   */
  private trackRequestEnd(
    requestId: string,
    outputContent: string,
    usage?: LLMUsage,
    finishReason?: string,
  ): void {
    const entry = this._byId.get(requestId);
    if (!entry || entry.status !== 'active') return;
    const now = Date.now();
    entry.endTime = now;
    entry.elapsedMs = now - entry.startTime;
    entry.outputChars = outputContent.length;
    entry.usage = usage;
    entry.finishReason = finishReason;
    entry.status = 'complete';

    const cost = this.priceCall(entry.provider, entry.model, usage);
    entry.costUsd = cost.costUsd;
    // Left undefined when the call is unpriced. `false` has to mean exactly
    // "the provider billed us this", or an unpriced call is indistinguishable
    // from a billed one and re-pricing would skip it forever.
    entry.costEstimated = cost.costUsd === undefined ? undefined : cost.estimated;

    this.finishEntry(entry, outputContent);
    this.changed('requestCompleted', {
      id: requestId,
      callerName: entry.callerName,
      method: entry.method,
      provider: entry.provider,
      model: entry.model,
      elapsedMs: entry.elapsedMs,
      inputChars: entry.inputChars,
      outputChars: entry.outputChars,
      usage,
      costUsd: entry.costUsd,
      costEstimated: entry.costEstimated,
    });
  }

  /** Close a ledger entry that failed. A failed call has no cost to price. */
  private trackRequestError(requestId: string, error: string): void {
    const entry = this._byId.get(requestId);
    if (!entry || entry.status !== 'active') return;
    const now = Date.now();
    entry.endTime = now;
    entry.elapsedMs = now - entry.startTime;
    entry.outputChars = 0;
    entry.status = 'error';
    entry.error = error;

    this.finishEntry(entry, '');
    this.changed('requestError', {
      id: requestId,
      callerName: entry.callerName,
      method: entry.method,
      provider: entry.provider,
      model: entry.model,
      elapsedMs: entry.elapsedMs,
      error,
    });
  }

  /** Shared tail of both close paths: attach the text, mark dirty, prune. */
  private finishEntry(entry: LLMLedgerEntry, outputContent: string): void {
    const prompt = this._pendingText.get(entry.id);
    this._pendingText.delete(entry.id);

    if (this._retention.keepText) {
      const inputMessages = prompt ?? '';
      const output = this.truncate(outputContent);
      if (inputMessages || output) {
        entry.inputMessages = inputMessages;
        entry.outputContent = output;
        entry.hasText = true;
        void this.writeText(entry.id, { inputMessages, outputContent: output });
      }
    }

    this.dirtyDays.add(LLMObject.dayKey(entry.startTime));
    this.enforceRetention();
    this.scheduleLedgerSave();
  }

  /**
   * What a call cost. The provider's own charge wins when it reports one;
   * otherwise the token counts are priced off the list. Neither available
   * means UNPRICED — deliberately left undefined rather than zero, so a
   * $0.00 total always means $0.00 spent and never "nobody knew the price".
   */
  private priceCall(
    provider: string,
    model: string,
    usage: LLMUsage | undefined,
  ): { costUsd?: number; estimated: boolean } {
    if (typeof usage?.costUsd === 'number') return { costUsd: usage.costUsd, estimated: false };
    if (!usage) return { costUsd: undefined, estimated: false };
    const estimate = estimateCostUsd(provider, model, usage);
    return estimate === undefined
      ? { costUsd: undefined, estimated: false }
      : { costUsd: estimate, estimated: true };
  }

  // ── The ledger: retention ─────────────────────────────────────────

  /**
   * Drop what the retention policy says to drop: entries past the age or
   * count bound, and bodies past their own (shorter) age bound. Active
   * entries are never pruned — a long-running call is not stale history.
   */
  private enforceRetention(): void {
    const { maxAgeDays, maxEntries, residentTextEntries } = this._retention;
    const now = Date.now();
    const dropped: LLMLedgerEntry[] = [];

    if (maxAgeDays > 0) {
      const cutoff = now - maxAgeDays * 86_400_000;
      for (const e of this._ledger) {
        if (e.status !== 'active' && e.startTime < cutoff) dropped.push(e);
      }
    }
    if (maxEntries > 0) {
      const closed = this._ledger.filter(e => e.status !== 'active');
      const surplus = closed.length - dropped.length - maxEntries;
      if (surplus > 0) {
        // Oldest first; `closed` is in insertion order, which is start order.
        const alreadyDropped = new Set(dropped.map(e => e.id));
        let taken = 0;
        for (const e of closed) {
          if (taken >= surplus) break;
          if (alreadyDropped.has(e.id)) continue;
          dropped.push(e);
          taken++;
        }
      }
    }

    if (dropped.length > 0) {
      const dropIds = new Set(dropped.map(e => e.id));
      for (const e of dropped) {
        this._byId.delete(e.id);
        this.dirtyDays.add(LLMObject.dayKey(e.startTime));
        if (e.hasText) void this.deleteText(e.id);
      }
      this._ledger = this._ledger.filter(e => !dropIds.has(e.id));
    }

    // Text follows the entry's clock, so nothing expires separately. What
    // IS bounded separately is how much of it sits in RAM: keep the newest
    // few entries' text resident and let the rest live in storage.
    this.enforceResidentText(residentTextEntries);
  }

  /**
   * Hold text in memory only for the newest N entries. Dropping it here is
   * an eviction, not a deletion: `hasText` stays true and the text is still
   * in storage, so opening an older call just costs one read.
   */
  private enforceResidentText(limit: number): void {
    if (limit <= 0) {
      for (const e of this._ledger) {
        e.inputMessages = undefined;
        e.outputContent = undefined;
      }
      return;
    }
    const withText: LLMLedgerEntry[] = [];
    for (const e of this._ledger) {
      if (e.inputMessages !== undefined || e.outputContent !== undefined) withText.push(e);
    }
    if (withText.length <= limit) return;
    withText.sort((a, b) => b.startTime - a.startTime);
    for (const e of withText.slice(limit)) {
      e.inputMessages = undefined;
      e.outputContent = undefined;
    }
  }

  // ── The ledger: rollups ───────────────────────────────────────────

  /** Headline totals, recomputed from the retained entries. */
  private rollupStats(): LLMStats {
    const stats: LLMStats = {
      totalRequests: 0,
      totalInputChars: 0,
      totalOutputChars: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalErrors: 0,
      totalLatencyMs: 0,
      totalCostUsd: 0,
      entryCount: this._ledger.length,
      windowStart: 0,
      windowEnd: 0,
    };
    for (const e of this._ledger) {
      stats.totalRequests++;
      stats.totalInputChars += e.inputChars;
      stats.totalOutputChars += e.outputChars;
      stats.totalInputTokens += e.usage?.inputTokens ?? 0;
      stats.totalOutputTokens += e.usage?.outputTokens ?? 0;
      stats.totalLatencyMs += e.elapsedMs;
      stats.totalCostUsd += e.costUsd ?? 0;
      if (e.status === 'error') stats.totalErrors++;
      if (stats.windowStart === 0 || e.startTime < stats.windowStart) stats.windowStart = e.startTime;
      if (e.startTime > stats.windowEnd) stats.windowEnd = e.startTime;
    }
    return stats;
  }

  /** Spend rolled up per provider/model, plus per-day and session cuts. */
  private buildSpendReport(): LLMSpendReport {
    const models = new Map<string, LLMModelSpend>();
    const dayTotals = new Map<string, number>();
    const tierTotals = new Map<string, { costUsd: number; requests: number }>();
    const totals = {
      costUsd: 0, reportedCostUsd: 0, estimatedCostUsd: 0,
      requests: 0, errors: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      unpricedRequests: 0,
    };
    let sessionCostUsd = 0;
    let windowStart = 0;
    let windowEnd = 0;

    for (const e of this._ledger) {
      if (e.status === 'active') continue; // nothing settled to charge yet
      const key = `${e.provider}/${e.model || '(default)'}`;
      let m = models.get(key);
      if (!m) {
        m = {
          key, provider: e.provider, model: e.model || '(default)',
          requests: 0, errors: 0, inputChars: 0, outputChars: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          reasoningTokens: 0,
          costUsd: 0, reportedCostUsd: 0, estimatedCostUsd: 0, unpricedRequests: 0,
          totalLatencyMs: 0, firstUsed: e.startTime, lastUsed: e.startTime,
          byDay: {}, sessionCostUsd: 0, sessionRequests: 0,
        };
        models.set(key, m);
      }

      m.totalLatencyMs += e.elapsedMs;
      m.firstUsed = Math.min(m.firstUsed, e.startTime);
      m.lastUsed = Math.max(m.lastUsed, e.startTime);
      if (windowStart === 0 || e.startTime < windowStart) windowStart = e.startTime;
      if (e.startTime > windowEnd) windowEnd = e.startTime;

      if (e.status === 'error') {
        m.errors++;
        totals.errors++;
        continue;
      }

      m.requests++;
      totals.requests++;
      const tierKey = e.tier ?? '(no tier)';
      let tierRec = tierTotals.get(tierKey);
      if (!tierRec) { tierRec = { costUsd: 0, requests: 0 }; tierTotals.set(tierKey, tierRec); }
      tierRec.requests++;
      m.inputChars += e.inputChars;
      m.outputChars += e.outputChars;
      if (e.startTime >= this._sessionStartedAt) m.sessionRequests++;

      const u = e.usage;
      if (u) {
        m.inputTokens += u.inputTokens;
        m.outputTokens += u.outputTokens;
        m.cacheReadTokens += u.cacheReadTokens ?? 0;
        m.cacheWriteTokens += u.cacheWriteTokens ?? 0;
        m.reasoningTokens += u.reasoningTokens ?? 0;
        totals.inputTokens += u.inputTokens;
        totals.outputTokens += u.outputTokens;
        totals.cacheReadTokens += u.cacheReadTokens ?? 0;
        totals.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      }

      if (e.costUsd === undefined) {
        m.unpricedRequests++;
        totals.unpricedRequests++;
        continue;
      }

      m.costUsd += e.costUsd;
      totals.costUsd += e.costUsd;
      if (e.costEstimated) {
        m.estimatedCostUsd += e.costUsd;
        totals.estimatedCostUsd += e.costUsd;
      } else {
        m.reportedCostUsd += e.costUsd;
        totals.reportedCostUsd += e.costUsd;
      }
      if (e.startTime >= this._sessionStartedAt) {
        m.sessionCostUsd += e.costUsd;
        sessionCostUsd += e.costUsd;
      }
      tierRec.costUsd += e.costUsd;
      const day = LLMObject.dayKey(e.startTime);
      m.byDay[day] = (m.byDay[day] ?? 0) + e.costUsd;
      dayTotals.set(day, (dayTotals.get(day) ?? 0) + e.costUsd);
    }

    const days = Array.from(dayTotals.entries())
      .map(([day, costUsd]) => ({ day, costUsd }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return {
      models: Array.from(models.values()),
      totals,
      todayCostUsd: dayTotals.get(LLMObject.dayKey(Date.now())) ?? 0,
      sessionCostUsd,
      sessionStartedAt: this._sessionStartedAt,
      days,
      byTier: Array.from(tierTotals.entries())
        .map(([tier, v]) => ({ tier, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd),
      pricingOverrides: listPricingOverrides(),
      retention: { ...this._retention },
      entryCount: this._ledger.length,
      windowStart,
      windowEnd,
    };
  }

  /**
   * Return an entry with its text filled in, reading storage when the text
   * is no longer resident. An entry that never had text, or whose text was
   * dropped, says so rather than coming back with empty strings that would
   * read as "the model was sent nothing and said nothing".
   */
  private async withText(entry: LLMLedgerEntry): Promise<LLMLedgerEntry> {
    if (entry.inputMessages !== undefined || entry.outputContent !== undefined) {
      return { ...entry };
    }
    if (!entry.hasText) {
      return {
        ...entry,
        inputMessages: '',
        outputContent: '(prompt and output not retained)',
      };
    }
    const stored = await this.readText(entry.id);
    return {
      ...entry,
      inputMessages: stored?.inputMessages ?? '',
      outputContent: stored?.outputContent ?? '(prompt and output no longer retained)',
    };
  }

  /** Read back ledger entries, newest first, with optional filters. */
  private queryLedger(q: LLMLedgerQuery): { entries: LLMLedgerEntry[]; total: number } {
    let rows = this._ledger;
    if (q.status) rows = rows.filter(e => e.status === q.status);
    if (q.provider) rows = rows.filter(e => e.provider === q.provider);
    if (q.model) rows = rows.filter(e => e.model === q.model);
    if (q.callerName) rows = rows.filter(e => e.callerName === q.callerName);
    if (q.since !== undefined) rows = rows.filter(e => e.startTime >= q.since!);
    if (q.until !== undefined) rows = rows.filter(e => e.startTime <= q.until!);

    const total = rows.length;
    // Newest first, breaking ties by insertion order — a burst of calls can
    // share a millisecond, and without the tiebreak those land oldest-first
    // in the middle of a newest-first list.
    const order = new Map(this._ledger.map((e, i) => [e.id, i]));
    const sorted = [...rows].sort((a, b) =>
      (b.startTime - a.startTime) || ((order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)));
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.max(1, Math.min(q.limit ?? 200, 2000));
    return { entries: sorted.slice(offset, offset + limit), total };
  }

  // ── The ledger: persistence ───────────────────────────────────────
  //
  // One Storage key per calendar day holds that day's entries. Appending a
  // call rewrites only today; a day aging out of the retention window is a
  // single delete. Message bodies are separate keys, written once and never
  // rewritten, so the hot path never re-serializes prompt text.

  private scheduleLedgerSave(): void {
    if (this.ledgerSaveTimer || !this.storageId) return;
    this.ledgerSaveTimer = setTimeout(() => {
      this.ledgerSaveTimer = undefined;
      this.saveLedger().catch(err => log.warn('Failed to persist LLM ledger:', err));
    }, LLMObject.LEDGER_SAVE_DEBOUNCE_MS);
  }

  private async writeText(id: string, text: { inputMessages: string; outputContent: string }): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(
        msg.request(this.id, this.storageId, 'set', { key: LLMObject.LEDGER_TEXT_PREFIX + id, value: text })
      );
    } catch (err) {
      log.warn(`Failed to persist ledger text ${id}:`, err);
    }
  }

  private async deleteText(id: string): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(
        msg.request(this.id, this.storageId, 'delete', { key: LLMObject.LEDGER_TEXT_PREFIX + id })
      );
    } catch { /* already gone */ }
  }

  private async readText(id: string): Promise<{ inputMessages: string; outputContent: string } | null> {
    if (!this.storageId) return null;
    try {
      const v = await this.request<unknown>(
        msg.request(this.id, this.storageId, 'get', { key: LLMObject.LEDGER_TEXT_PREFIX + id })
      );
      return v && typeof v === 'object' ? v as { inputMessages: string; outputContent: string } : null;
    } catch {
      return null;
    }
  }

  /** Rewrite every day chunk that changed, and the day index alongside. */
  private async saveLedger(): Promise<void> {
    if (!this.storageId || this.dirtyDays.size === 0) return;
    const days = Array.from(this.dirtyDays);
    this.dirtyDays.clear();

    // Group the closed entries by day. Active ones are deliberately excluded:
    // a call in flight when the process dies did not happen as far as any
    // later boot can tell, and persisting it would strand an entry that can
    // never leave `active`.
    const byDay = new Map<string, LLMLedgerEntry[]>();
    for (const e of this._ledger) {
      if (e.status === 'active') continue;
      const day = LLMObject.dayKey(e.startTime);
      let bucket = byDay.get(day);
      if (!bucket) { bucket = []; byDay.set(day, bucket); }
      // Strip the text: it lives under its own key, and keeping it out of
      // the day chunk is what lets a rollup load seven days cheaply.
      const { inputMessages: _i, outputContent: _o, ...meta } = e;
      bucket.push(meta as LLMLedgerEntry);
    }

    try {
      for (const day of days) {
        const entries = byDay.get(day);
        const key = LLMObject.LEDGER_DAY_PREFIX + day;
        if (!entries || entries.length === 0) {
          await this.request(msg.request(this.id, this.storageId, 'delete', { key }));
        } else {
          await this.request(msg.request(this.id, this.storageId, 'set', { key, value: entries }));
        }
      }
      await this.request(msg.request(this.id, this.storageId, 'set', {
        key: LLMObject.LEDGER_INDEX_KEY,
        value: Array.from(byDay.keys()).sort(),
      }));
    } catch (err) {
      // Stay dirty so the next call retries rather than losing the record.
      for (const day of days) this.dirtyDays.add(day);
      throw err;
    }
  }

  private async loadLedger(): Promise<void> {
    if (!this.storageId) return;
    try {
      const index = await this.request<unknown>(
        msg.request(this.id, this.storageId, 'get', { key: LLMObject.LEDGER_INDEX_KEY })
      );
      if (!Array.isArray(index)) return;
      const loaded: LLMLedgerEntry[] = [];
      for (const day of (index as string[]).slice().sort()) {
        const chunk = await this.request<unknown>(
          msg.request(this.id, this.storageId, 'get', { key: LLMObject.LEDGER_DAY_PREFIX + day })
        );
        if (Array.isArray(chunk)) loaded.push(...(chunk as LLMLedgerEntry[]));
      }
      loaded.sort((a, b) => a.startTime - b.startTime);
      for (const e of loaded) {
        if (!e || typeof e.id !== 'string') continue;
        // Belt and braces: nothing should have been stored active, but a
        // stranded active entry would never age out of the Active tab.
        if (e.status === 'active') e.status = 'error';
        this._ledger.push(e);
        this._byId.set(e.id, e);
      }
      // Policy may have tightened, or the process may have been down for
      // longer than the window, so prune against today's clock on the way in.
      const before = this._ledger.length;
      this.enforceRetention();
      const stats = this.rollupStats();
      log.info(
        `Restored ${this._ledger.length} ledger entries` +
        `${before !== this._ledger.length ? ` (${before - this._ledger.length} aged out)` : ''}` +
        `, $${stats.totalCostUsd.toFixed(4)} over the retained window`
      );
      if (this.dirtyDays.size > 0) this.scheduleLedgerSave();
    } catch (err) {
      log.warn('Failed to restore LLM ledger:', err);
    }
  }

  /** Drop every entry, every body, and every day chunk. */
  private async clearLedger(): Promise<void> {
    const ids = this._ledger.filter(e => e.status !== 'active').map(e => e.id);
    const days = new Set(this._ledger.map(e => LLMObject.dayKey(e.startTime)));
    const active = this._ledger.filter(e => e.status === 'active');

    this._ledger = active;
    this._byId = new Map(active.map(e => [e.id, e]));
    this.dirtyDays.clear();

    if (!this.storageId) return;
    for (const day of days) {
      try {
        await this.request(msg.request(this.id, this.storageId, 'delete', {
          key: LLMObject.LEDGER_DAY_PREFIX + day,
        }));
      } catch { /* already gone */ }
    }
    for (const id of ids) await this.deleteText(id);
    try {
      await this.request(msg.request(this.id, this.storageId, 'set', {
        key: LLMObject.LEDGER_INDEX_KEY, value: [],
      }));
    } catch { /* best effort */ }
    log.info('Ledger cleared');
  }

  /**
   * Re-price recorded calls against the current price list. Entries whose
   * cost came from the provider are left alone — a billed charge is not ours
   * to recompute. Everything else is re-derived from the token counts the
   * entry already carries, which is what makes setting a price for a model
   * that was unpriced at the time worth anything.
   */
  private repriceLedger(): { repriced: number; nowPriced: number } {
    let repriced = 0;
    let nowPriced = 0;
    for (const e of this._ledger) {
      if (e.status !== 'complete') continue;
      // Only a priced-and-not-estimated entry is a real provider charge;
      // an unpriced one carries costEstimated undefined and must be re-tried.
      if (e.costUsd !== undefined && e.costEstimated === false) continue;
      if (!e.usage) continue;
      const next = estimateCostUsd(e.provider, e.model, e.usage);
      if (next === e.costUsd) continue;
      if (e.costUsd === undefined && next !== undefined) nowPriced++;
      e.costUsd = next;
      e.costEstimated = next === undefined ? undefined : true;
      repriced++;
      this.dirtyDays.add(LLMObject.dayKey(e.startTime));
    }
    if (repriced > 0) this.scheduleLedgerSave();
    return { repriced, nowPriced };
  }

  /** Forget every retained prompt/completion, keeping the cost records. */
  private async dropAllText(): Promise<void> {
    for (const e of this._ledger) {
      if (!e.hasText) continue;
      e.hasText = false;
      e.inputMessages = undefined;
      e.outputContent = undefined;
      this.dirtyDays.add(LLMObject.dayKey(e.startTime));
      await this.deleteText(e.id);
    }
  }

  private async loadRetention(): Promise<void> {
    if (!this.storageId) return;
    try {
      const stored = await this.request<unknown>(
        msg.request(this.id, this.storageId, 'get', { key: LLMObject.RETENTION_STORAGE_KEY })
      );
      if (stored && typeof stored === 'object') {
        this._retention = { ...this._retention, ...(stored as Partial<LLMLedgerRetention>) };
      }
    } catch (err) {
      log.warn('Failed to restore ledger retention policy:', err);
    }
  }

  private async saveRetention(): Promise<void> {
    if (!this.storageId) return;
    await this.request(msg.request(this.id, this.storageId, 'set', {
      key: LLMObject.RETENTION_STORAGE_KEY, value: this._retention,
    }));
  }

  private async loadPricing(): Promise<void> {
    if (!this.storageId) return;
    try {
      const stored = await this.request<unknown>(
        msg.request(this.id, this.storageId, 'get', { key: LLMObject.PRICING_STORAGE_KEY })
      );
      if (Array.isArray(stored)) {
        loadPricingOverrides(stored as Array<{ key: string; pricing: ModelPricing }>);
      }
    } catch (err) {
      log.warn('Failed to restore LLM pricing overrides:', err);
    }
  }

  private async savePricing(): Promise<void> {
    if (!this.storageId) return;
    await this.request(
      msg.request(this.id, this.storageId, 'set', {
        key: LLMObject.PRICING_STORAGE_KEY,
        value: listPricingOverrides(),
      })
    );
  }

  /**
   * Get a provider by name or the default.
   */
  private getProvider(name?: string): LLMProvider | undefined {
    if (name) {
      return this.providers.get(name);
    }
    if (this.defaultProvider) {
      return this.providers.get(this.defaultProvider);
    }
    // Return first available
    return this.providers.values().next().value;
  }

  /** First registered provider that can serve the given speech direction. */
  private findSpeechProvider(direction: 'transcribe' | 'synthesize'): LLMProvider | undefined {
    for (const provider of this.providers.values()) {
      const support = provider.supportsSpeech?.();
      if (direction === 'transcribe' && provider.transcribe && support?.transcribe) return provider;
      if (direction === 'synthesize' && provider.synthesize && support?.synthesize) return provider;
    }
    return undefined;
  }

  /**
   * Transcribe audio via the named provider, or the first willing provider
   * when unnamed. Auto-selection falls through failed candidates so a flaky
   * provider degrades to the next one.
   */
  private async transcribeAudio(
    audio: { base64: string; mimeType: string },
    providerName?: string,
    model?: string,
    language?: string,
  ): Promise<{ text: string; provider: string }> {
    const opts = { ...(model ? { model } : {}), ...(language ? { language } : {}) };
    if (providerName) {
      const provider = this.providers.get(providerName);
      require(provider !== undefined, `Provider '${providerName}' not registered`);
      require(provider!.transcribe !== undefined, `Provider '${providerName}' has no transcription API`);
      const { text } = await provider!.transcribe!(audio, opts);
      return { text, provider: provider!.name };
    }

    const candidates = [...this.providers.values()]
      .filter(p => p.transcribe && p.supportsSpeech?.().transcribe);
    if (candidates.length === 0) {
      throw new Error('No registered provider supports transcription. Configure OpenAI or Gemini.');
    }
    const failures: string[] = [];
    for (const provider of candidates) {
      try {
        const start = Date.now();
        const { text } = await provider.transcribe!(audio, opts);
        log.info(`← ${provider.name} transcribe | ${Date.now() - start}ms`);
        return { text, provider: provider.name };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${provider.name}: ${msg.slice(0, 200)}`);
      }
    }
    throw new Error(`All transcription providers failed. ${failures.join(' | ')}`);
  }

  /** Synthesize speech via the named provider or the first willing one. */
  private async synthesizeSpeech(
    text: string,
    providerName?: string,
    model?: string,
    voice?: string,
  ): Promise<{ base64: string; mimeType: string; provider: string }> {
    const opts = { ...(model ? { model } : {}), ...(voice ? { voice } : {}) };
    if (providerName) {
      const provider = this.providers.get(providerName);
      require(provider !== undefined, `Provider '${providerName}' not registered`);
      require(provider!.synthesize !== undefined, `Provider '${providerName}' has no speech synthesis API`);
      const result = await provider!.synthesize!(text, opts);
      return { ...result, provider: provider!.name };
    }

    const candidates = [...this.providers.values()]
      .filter(p => p.synthesize && p.supportsSpeech?.().synthesize);
    if (candidates.length === 0) {
      throw new Error('No registered provider supports speech synthesis. Configure OpenAI.');
    }
    const failures: string[] = [];
    for (const provider of candidates) {
      try {
        const start = Date.now();
        const result = await provider.synthesize!(text, opts);
        log.info(`← ${provider.name} synthesize | ${text.length} chars | ${Date.now() - start}ms`);
        return { ...result, provider: provider.name };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${provider.name}: ${msg.slice(0, 200)}`);
      }
    }
    throw new Error(`All speech synthesis providers failed. ${failures.join(' | ')}`);
  }

  // ── Tier capabilities ─────────────────────────────────────────────

  /** Cached listModels results per provider, for capability lookups. */
  private modelListCache: Map<string, ModelInfo[]> = new Map();
  /** In-flight listModels fetches (dedupes concurrent callers). */
  private modelListFetches: Map<string, Promise<ModelInfo[]>> = new Map();

  /**
   * A provider's model list, cached for the session. `refresh` forces a
   * live re-fetch (used by the Settings-driven listProviderModels path so
   * newly-available models still show up).
   */
  private async getProviderModels(providerName: string, opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    if (!opts.refresh) {
      const cached = this.modelListCache.get(providerName);
      if (cached) return cached;
    }
    const provider = this.providers.get(providerName);
    if (!provider) return [];
    let inFlight = this.modelListFetches.get(providerName);
    if (!inFlight) {
      inFlight = provider.listModels()
        .then(models => {
          if (models.length > 0) this.modelListCache.set(providerName, models);
          return models;
        })
        .catch(() => [] as ModelInfo[])
        .finally(() => { this.modelListFetches.delete(providerName); });
      this.modelListFetches.set(providerName, inFlight);
    }
    return inFlight;
  }

  /**
   * The first model that can accept image input, searched in tier order
   * (smart → balanced → fast) and then the configured vision fallback.
   * `vision: null` (unknown) counts as capable, matching AgentAbject's
   * image-step routing. Returns null when every configured model is
   * text-only — callers should then skip screenshot-based verification
   * and say so instead of shipping images that get stripped to text notes.
   */
  async getVisionModel(): Promise<{ tier: string; provider: string; model: string | null; vision: boolean | null } | null> {
    const caps = await this.describeTiers();
    for (const tier of ['smart', 'balanced', 'fast'] as const) {
      const c = caps[tier];
      if (c && c.vision !== false) return { tier, provider: c.provider, model: c.model, vision: c.vision };
    }
    const fb = caps.visionFallback;
    if (fb && fb.vision !== false) {
      return { tier: 'visionFallback', provider: fb.provider, model: fb.model, vision: fb.vision };
    }
    return null;
  }

  /**
   * Describe the effective model behind each tier with its capabilities.
   * Mirrors resolveProviderAndModel's routing (tier config first, default
   * provider as fallback) so agents see exactly what a tiered call will hit.
   */
  async describeTiers(): Promise<TierCapabilities> {
    const out = {} as TierCapabilities;

    // The optional vision substitute, only when its provider is registered
    out.visionFallback = null;
    if (this.visionFallback && this.providers.get(this.visionFallback.provider)) {
      const { provider, model } = this.visionFallback;
      out.visionFallback = {
        provider,
        model,
        vision: await this.lookupVision(provider, model),
      };
    }

    for (const tier of ['smart', 'balanced', 'fast', 'code'] as ModelTier[]) {
      let providerName: string | undefined;
      let model: string | undefined;
      let effort: EffortLevel | undefined;

      // Mirror resolveProviderAndModel: an unrouted code tier rides smart.
      const config = this.tierRouting[tier] ?? (tier === 'code' ? this.tierRouting.smart : undefined);
      if (config && this.providers.get(config.provider)) {
        providerName = config.provider;
        model = config.model;
        effort = config.effort;
      } else {
        const provider = this.getProvider();
        if (provider) {
          providerName = provider.name;
          model = provider.describe().defaultTierModels[tier] || undefined;
        }
      }

      if (!providerName) {
        out[tier] = null;
        continue;
      }
      const tierProvider = this.providers.get(providerName);
      out[tier] = {
        provider: providerName,
        model: model ?? null,
        vision: model ? await this.lookupVision(providerName, model) : null,
        ...(effort ? { effort } : {}),
        supportedEfforts: model && tierProvider?.supportedEfforts ? tierProvider.supportedEfforts(model) : [],
      };
    }
    return out;
  }

  /** Vision capability of one provider model; null = unknown. */
  private async lookupVision(providerName: string, model: string): Promise<boolean | null> {
    const models = await this.getProviderModels(providerName);
    const live = models.find(mi => mi.id === model);
    if (live?.vision !== undefined) return live.vision;
    // Fall back to the provider's static catalog (covers models the live
    // list missed, and providers whose live fetch failed)
    const catalog = this.providers.get(providerName)?.describe().models ?? [];
    return catalog.find(mi => mi.id === model)?.vision ?? null;
  }

  private resolveProviderAndModel(
    providerName?: string,
    tier?: ModelTier,
  ): { provider: LLMProvider; modelOverride?: string; effortOverride?: EffortLevel } {
    // Explicit provider name takes priority (backward compat)
    if (providerName) {
      const provider = this.providers.get(providerName);
      require(provider !== undefined, `Provider '${providerName}' not registered`);
      return { provider: provider! };
    }

    // Tier routing: look up per-tier provider+model(+effort). The code tier
    // falls back to the smart tier's routing when unconfigured — code
    // generation wants the strongest model, and smart is where users put it.
    const effectiveTier = tier === 'code' && !this.tierRouting.code ? 'smart' : tier;
    if (effectiveTier && this.tierRouting[effectiveTier]) {
      const config = this.tierRouting[effectiveTier]!;
      const provider = this.providers.get(config.provider);
      if (provider) {
        return { provider, modelOverride: config.model, effortOverride: config.effort };
      }
      log.warn(`Tier '${effectiveTier}' routes to provider '${config.provider}' which is not registered, falling back to default`);
    }

    // Fall back to default provider
    const provider = this.getProvider();
    require(provider !== undefined, 'No LLM provider available');
    return { provider: provider! };
  }

  /**
   * Merge tier-routing overrides into a request's options: the configured
   * model always applies; the configured effort applies unless the caller
   * passed an explicit effort of its own.
   */
  private applyRouting(
    options: LLMCompletionOptions | undefined,
    modelOverride?: string,
    effortOverride?: EffortLevel,
  ): LLMCompletionOptions | undefined {
    if (!modelOverride && !effortOverride) return options;
    return {
      ...options,
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(effortOverride && !options?.effort ? { effort: effortOverride } : {}),
    };
  }

  // ── Prompt-cache keepalive ────────────────────────────────────────────
  // The client-side defense against agentic cache eviction: an agent's loop
  // is think → act → wait, and the wait routinely outlives the provider's
  // cache TTL, so the follow-up pays full prefill price again. During the
  // pause we re-read the exact prefix on a timer (τ* under the TTL), each
  // read refreshing the entry at ~0.1× input price. The policy is bounded on
  // every axis: ping only while economically alive (idle < I_max), never
  // past the ping budget, never after the entry went cold, and a circuit
  // breaker latches the whole feature off if ping volume ever exceeds what
  // the registry could legitimately produce.

  /**
   * Concatenative identity serialization: provider + model + each message.
   * Built so that a conversation extended by new turns serializes to a
   * string that startsWith() its previous serialization — that property is
   * what detects "this request grew out of that tracked prefix". Image and
   * document parts contribute a length+head fingerprint instead of their
   * full base64 payload.
   */
  private serializeForCacheIdentity(providerName: string, model: string, messages: LLMMessage[]): string {
    let out = providerName + '\u0000' + model + '\u0000';
    for (const m of messages) {
      out += m.role + '\u0001';
      if (typeof m.content === 'string') {
        out += m.content;
      } else {
        for (const part of m.content) {
          if (part.type === 'text') out += 't:' + part.text;
          else out += part.type[0] + ':' + part.data.length + ':' + part.data.slice(0, 64);
        }
      }
      out += '\u0002';
    }
    return out;
  }

  /** FNV-1a hash of the identity string — a log label, not the identity. */
  private static contentHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Derive the runtime policy from a provider's cache economics, or
   * undefined when the numbers make keepalive meaningless (TTL inside the
   * safety margin, or re-prefill no dearer than a cached read).
   */
  private static warmPolicyFrom(profile: CacheProfile): WarmPolicy | undefined {
    if (!(profile.ttlSeconds > LLMObject.WARM_TTL_MARGIN_S)) return undefined;
    if (!(profile.readRatio > 0) || !(profile.writeRatio > 0)) return undefined;
    const costRatio = profile.writeRatio / profile.readRatio - 1;
    if (!(costRatio > 0)) return undefined;
    const tauMs = (profile.ttlSeconds - LLMObject.WARM_TTL_MARGIN_S) * 1000;
    return {
      ttlMs: profile.ttlSeconds * 1000,
      tauMs,
      iMaxMs: tauMs * costRatio,
      maxPings: Math.ceil(costRatio),
      minPrefixTokens: Math.max(1, profile.minPrefixTokens),
    };
  }

  /**
   * Record a completed real request in the warm registry. Exact match →
   * refresh; a tracked prefix this request extends → superseded (keeping the
   * longer prefix warm refreshes the shorter one's blocks anyway); otherwise
   * a new entry, LRU-bounded. Never throws — warmth is an optimization and
   * must not break the request path.
   */
  private trackCacheWarmth(
    providerName: string | undefined,
    options: LLMCompletionOptions | undefined,
    messages: LLMMessage[],
    usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
  ): void {
    if (!this.cacheKeepaliveEnabled || this.cacheKeepaliveTripped || this._paused) return;
    try {
      const { provider, modelOverride, effortOverride } = this.resolveProviderAndModel(providerName, options?.tier);
      const effectiveOptions = this.applyRouting(options, modelOverride, effortOverride);
      const model = this.modelFor(provider, effectiveOptions);
      const profile = provider.cacheProfile?.(model);
      if (!profile) return;
      const policy = LLMObject.warmPolicyFrom(profile);
      if (!policy) return;

      // Prefix size = the whole prompt, cached portions included. Without
      // usage we can't verify the caching floor, so we don't arm.
      const prefixTokens = usage
        ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        : 0;
      if (prefixTokens < policy.minPrefixTokens) return;

      const now = Date.now();
      const serialized = this.serializeForCacheIdentity(provider.name, model, messages);
      let entry = this.warmEntries.find(e => e.serialized === serialized);
      if (!entry) {
        const grewFrom = this.warmEntries.find(e => serialized.startsWith(e.serialized));
        if (grewFrom) this.dropWarmEntry(grewFrom, 'superseded by longer prefix', true);
        entry = {
          id: LLMObject.contentHash(serialized),
          providerName: provider.name,
          model,
          messages,
          serialized,
          cacheKey: options?.cacheKey,
          prefixTokens,
          lastUsedAt: now,
          lastWarmAt: now,
          pingsRemaining: policy.maxPings,
          consecutiveFailures: 0,
          pingInFlight: false,
          policy,
        };
        this.warmEntries.push(entry);
        while (this.warmEntries.length > LLMObject.WARM_MAX_ENTRIES) {
          const oldest = this.warmEntries.reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
          this.dropWarmEntry(oldest, 'evicted (registry full)');
        }
        log.info(`cache-warm: tracking ${entry.id} (${provider.name}/${model}, ${prefixTokens} tok, ping every ${Math.round(policy.tauMs / 1000)}s, horizon ${Math.round(policy.iMaxMs / 60000)}min)`);
      } else {
        // A real request restarts the economics: fresh use clock, fresh
        // ping budget. (Pings never take this path.)
        entry.lastUsedAt = now;
        entry.lastWarmAt = now;
        entry.pingsRemaining = policy.maxPings;
        entry.consecutiveFailures = 0;
        entry.prefixTokens = prefixTokens;
        if (options?.cacheKey) entry.cacheKey = options.cacheKey;
      }
      this.scheduleWarmPing(entry);
      this.checkInvariants();
    } catch (err) {
      log.warn(`cache-warm: tracking failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * (Re)schedule an entry's single pending timer for lastWarmAt + τ*. There
   * is deliberately no setInterval anywhere in this machinery: one timer per
   * entry, and the next is set only after the previous ping settles, so a
   * hung ping cannot pile up successors.
   */
  private scheduleWarmPing(entry: WarmEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const delay = Math.max(entry.lastWarmAt + entry.policy.tauMs - Date.now(), 1000);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.warmPingTick(entry);
    }, delay);
    // Node returns a Timeout (unref keeps us from holding the process open);
    // browser returns a number, where the optional call is a no-op.
    (entry.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * One timer firing for one entry: decide drop / skip / ping. Every path
   * out of here either drops the entry or leaves exactly one timer pending.
   */
  private async warmPingTick(entry: WarmEntry): Promise<void> {
    if (!this.warmEntries.includes(entry)) return;
    if (!this.cacheKeepaliveEnabled || this.cacheKeepaliveTripped || this._paused) {
      this.dropWarmEntry(entry, 'keepalive off');
      return;
    }

    const now = Date.now();
    const sinceWarm = now - entry.lastWarmAt;
    const sinceUse = now - entry.lastUsedAt;
    // Clock anomalies drop the entry rather than pinging "to be safe" — the
    // failure mode of dropping is a re-prefill, the failure mode of trusting
    // a broken clock is unbounded spend.
    if (!Number.isFinite(sinceWarm) || !Number.isFinite(sinceUse) || sinceWarm < 0 || sinceUse < 0) {
      this.dropWarmEntry(entry, 'clock anomaly');
      return;
    }
    // Past the TTL the provider has evicted the entry; a "keepalive" now
    // would be a full-price speculative re-prefill. Never ping a cold entry.
    if (sinceWarm >= entry.policy.ttlMs) {
      this.dropWarmEntry(entry, 'went cold (TTL elapsed since last refresh)');
      return;
    }
    // Past break-even, warmth costs more than the re-prefill it prevents.
    if (sinceUse >= entry.policy.iMaxMs) {
      this.dropWarmEntry(entry, 'past break-even horizon');
      return;
    }
    if (entry.pingsRemaining <= 0) {
      this.dropWarmEntry(entry, 'ping budget exhausted');
      return;
    }
    // Real traffic refreshed the entry after this timer was set — the cache
    // is being kept warm for free. Just reschedule.
    if (sinceWarm < entry.policy.tauMs) {
      this.scheduleWarmPing(entry);
      return;
    }
    const provider = this.providers.get(entry.providerName);
    if (!provider) {
      this.dropWarmEntry(entry, 'provider no longer registered');
      return;
    }
    if (!this.recordWarmPingForBreaker()) return;

    entry.pingInFlight = true;
    entry.pingsRemaining--;
    this._warmStats.pings++;
    const pingNo = entry.policy.maxPings - entry.pingsRemaining;
    log.info(`cache-warm: ping ${entry.id} (${entry.providerName}/${entry.model}, ${entry.prefixTokens} tok, ping ${pingNo}/${entry.policy.maxPings}, ${Math.round((entry.policy.iMaxMs - sinceUse) / 60000)}min to break-even)`);
    let failed = false;
    try {
      const result = await provider.complete(entry.messages, {
        model: entry.model,
        maxTokens: LLMObject.WARM_PING_MAX_TOKENS,
        effort: 'none',
        ...(entry.cacheKey ? { cacheKey: entry.cacheKey } : {}),
      });
      // Success refreshes the TTL clock ONLY — lastUsedAt is real traffic's.
      entry.lastWarmAt = Date.now();
      entry.consecutiveFailures = 0;
      if (result.usage) {
        this._warmStats.pingInputTokens += result.usage.inputTokens + (result.usage.cacheReadTokens ?? 0) + (result.usage.cacheWriteTokens ?? 0);
        this._warmStats.pingOutputTokens += result.usage.outputTokens;
      }
    } catch (err) {
      failed = true;
      entry.consecutiveFailures++;
      this._warmStats.pingFailures++;
      log.warn(`cache-warm: ping ${entry.id} failed (${entry.consecutiveFailures}/${LLMObject.WARM_MAX_PING_FAILURES}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      entry.pingInFlight = false;
    }
    if (failed && entry.consecutiveFailures >= LLMObject.WARM_MAX_PING_FAILURES) {
      this.dropWarmEntry(entry, 'consecutive ping failures');
      return;
    }
    // A real request may have superseded/released the entry mid-ping.
    if (this.warmEntries.includes(entry)) {
      this.scheduleWarmPing(entry);
      this.checkInvariants();
    }
  }

  private dropWarmEntry(entry: WarmEntry, reason: string, quiet = false): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const idx = this.warmEntries.indexOf(entry);
    if (idx >= 0) {
      this.warmEntries.splice(idx, 1);
      this._warmStats.entriesDropped++;
      if (!quiet) log.info(`cache-warm: dropped ${entry.id} (${reason}; ${this.warmEntries.length} still tracked)`);
    }
  }

  private dropAllWarmEntries(reason: string): void {
    for (const entry of [...this.warmEntries]) this.dropWarmEntry(entry, reason, true);
    if (this._warmStats.pings > 0 || this._warmStats.entriesDropped > 0) {
      log.info(`cache-warm: cleared all entries (${reason})`);
    }
  }

  /**
   * Rolling-hour ping counter. Exceeding the ceiling means a bug this design
   * didn't foresee — latch the feature off and drop everything. Only an
   * explicit configure() resets the latch.
   */
  private recordWarmPingForBreaker(): boolean {
    const now = Date.now();
    this._warmPingTimes.push(now);
    const cutoff = now - 3_600_000;
    while (this._warmPingTimes.length > 0 && this._warmPingTimes[0] < cutoff) this._warmPingTimes.shift();
    if (this._warmPingTimes.length > LLMObject.WARM_MAX_PINGS_PER_HOUR) {
      this.cacheKeepaliveTripped = true;
      log.error(`cache-warm: CIRCUIT BREAKER TRIPPED — ${this._warmPingTimes.length} pings in the last hour (ceiling ${LLMObject.WARM_MAX_PINGS_PER_HOUR}). Keepalive disabled until reconfigured.`);
      this.dropAllWarmEntries('circuit breaker tripped');
      return false;
    }
    return true;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.warmEntries.length <= LLMObject.WARM_MAX_ENTRIES, `warm registry bounded (${this.warmEntries.length})`);
    for (const e of this.warmEntries) {
      invariant(e.pingsRemaining >= 0, 'warm entry ping budget never negative');
      invariant(e.timer !== undefined || e.pingInFlight, 'warm entry always has a pending timer or a ping in flight');
      invariant(e.policy.tauMs > 0 && e.policy.ttlMs > e.policy.tauMs, 'warm policy: 0 < τ* < TTL');
    }
  }

  protected override async onStop(): Promise<void> {
    this.dropAllWarmEntries('stopping');
    // Warm CLI sessions are live child processes holding pseudo-terminals;
    // without this they outlive the runtime that spawned them.
    await this.shutdownCliProviders();
    if (this.ledgerSaveTimer) {
      clearTimeout(this.ledgerSaveTimer);
      this.ledgerSaveTimer = undefined;
    }
    // Flush rather than losing up to a debounce window of recorded calls.
    try { await this.saveLedger(); } catch (err) { log.warn('Failed to flush LLM ledger on stop:', err); }
    await super.onStop();
  }

  /**
   * Shut down any registered provider that holds warm CLI sessions.
   *
   * Structural rather than by-name: a provider opts in by exposing
   * `shutdown()`, so a new CLI-backed provider is cleaned up without
   * touching this method.
   */
  private async shutdownCliProviders(): Promise<void> {
    const shutdowns: Array<Promise<void>> = [];
    for (const provider of this.providers.values()) {
      const disposable = provider as { shutdown?: () => Promise<void> };
      if (typeof disposable.shutdown !== 'function') continue;
      shutdowns.push(
        // One provider failing to close must not strand the others.
        disposable.shutdown().catch(err =>
          log.warn(`Failed to shut down provider '${provider.name}':`, err)),
      );
    }
    await Promise.all(shutdowns);
  }

  /**
   * Extract code from markdown-formatted response.
   */
  private extractCode(content: string, language: string): string {
    // Look for code blocks
    const codeBlockRegex = new RegExp(
      '```(?:' + language + ')?\\s*\\n([\\s\\S]*?)\\n```',
      'i'
    );
    const match = content.match(codeBlockRegex);

    if (match) {
      return match[1].trim();
    }

    // No code block, return as-is
    return content.trim();
  }

  // LLM usage/tiers/streaming guidance agents consult when adding AI features.
  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## LLM Usage Guide

### Basic Completion (chat-style)

  const result = await this.call(
    this.dep('LLM'), 'complete',
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Summarize this text: ...' }
      ],
      options: { tier: 'balanced' }
    });
  // result: { content: string, finishReason: 'stop'|'length'|'error',
  //           usage?: { inputTokens: number, outputTokens: number } }

### Code Generation Shorthand

  const code = await this.call(
    this.dep('LLM'), 'generateCode',
    { language: 'typescript', description: 'sort an array of numbers', context: 'optional existing code' });
  // Returns the generated code as a plain string

### Content Analysis Shorthand

  const analysis = await this.call(
    this.dep('LLM'), 'analyze',
    { content: 'some text to analyze', task: 'identify the main themes' });
  // Returns the analysis as a plain string

### Completion Options

The \`options\` object in \`complete\` accepts:
- tier: 'smart' | 'balanced' | 'fast' | 'code' — model quality tier (default: 'balanced'). 'code' is the code-generation tier; when unrouted it rides the smart tier's routing.
- temperature: number — controls randomness (0-1)
- maxTokens: number — limit response length
- stopSequences: string[] — stop generation at these strings

### Sending Images (vision)

Message content can be an array of parts, mixing text with images:

  { role: 'user', content: [
    { type: 'text', text: 'What is in this screenshot?' },
    { type: 'image', mediaType: 'image/png', data: '<base64>' },
  ]}

Not every configured model can see images. Before sending image content,
check the tier's capability and pick a tier whose vision is not false —
or send text only:

  const tiers = await this.call(this.dep('LLM'), 'describeTiers', {});
  // tiers.smart / tiers.balanced / tiers.fast:
  //   { provider, model, vision } — vision: true | false (text-only) | null (unknown)
  // tiers.visionFallback: optional substitute model for image steps when the
  // tier is text-only (null when not configured). To route a call to it:
  //   await this.call(this.dep('LLM'), 'complete', {
  //     messages, provider: tiers.visionFallback.provider,
  //     options: { tier: 'smart', model: tiers.visionFallback.model },
  //   });

### Per-Tier Routing

Each tier (smart, balanced, fast, code) can route to a different provider and model. The code tier serves code generation; unrouted, it falls back to smart.
This is configured via the Settings UI or the \`setTierRouting\` method:

  await this.call(this.dep('LLM'), 'setTierRouting', {
    tierRouting: {
      smart: { provider: 'anthropic', model: 'claude-opus-4-7' },
      balanced: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      fast: { provider: 'ollama', model: 'llama3:latest' },
    }
  });

### Provider Management

  const providers = await this.call(this.dep('LLM'), 'listProviders', {});
  // providers: ['anthropic', 'openai', 'ollama', 'openrouter', 'deepseek', 'grok', 'gemini']

  const models = await this.call(this.dep('LLM'), 'listProviderModels', { provider: 'anthropic' });
  // models: [{ id: 'claude-opus-4-7', name: 'Claude Opus 4.7' }, ...]

  await this.call(this.dep('LLM'), 'configure', {
    credentials: {
      anthropic: '...', openai: '...', ollama: 'http://localhost:11434',
      openrouter: '...', deepseek: '...', grok: '...', gemini: '...',
    },
    tierRouting: { smart: { provider: 'anthropic', model: 'claude-opus-4-7' } }
  });
  // Configure all providers and tier routing (all fields optional)

### IMPORTANT
- The interface ID is 'abjects:llm' (NOT 'abjects:llm-object').
- Message roles MUST be 'system', 'user', or 'assistant' — no other values.
- The messages array must contain at least one message.
- generateCode returns only the code string, not a completion result object.
- analyze returns only the analysis string, not a completion result object.`;
  }

  /**
   * Check if any provider is available.
   */
  async isAvailable(): Promise<boolean> {
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        return true;
      }
    }
    return false;
  }
}

// Well-known LLM object ID
export const LLM_OBJECT_ID = 'abjects:llm' as AbjectId;
