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

export interface LLMActiveRequest {
  id: string;
  callerId: AbjectId;
  callerName?: string;
  method: string;
  provider: string;
  model: string;
  startTime: number;
  inputChars: number;
  outputChars: number;
  streaming: boolean;
  killed: boolean;
  inputMessages?: string;
}

export interface LLMHistoryEntry {
  id: string;
  callerId: AbjectId;
  callerName?: string;
  method: string;
  provider: string;
  model: string;
  startTime: number;
  elapsedMs: number;
  inputChars: number;
  outputChars: number;
  inputMessages: string;
  outputContent: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMStats {
  totalRequests: number;
  totalInputChars: number;
  totalOutputChars: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalErrors: number;
  totalLatencyMs: number;
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

  // Stats and request tracking
  private _activeRequests: Map<string, LLMActiveRequest> = new Map();
  private _stats: LLMStats = {
    totalRequests: 0,
    totalInputChars: 0,
    totalOutputChars: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
  };
  private _paused = false;
  private _history: LLMHistoryEntry[] = [];
  private readonly _MAX_HISTORY = 50;
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
                description: 'Get LLM stats, active requests, and paused state',
                parameters: [],
                returns: { kind: 'object', properties: {
                  stats: { kind: 'reference', reference: 'LLMStats' },
                  activeRequests: { kind: 'array', elementType: { kind: 'reference', reference: 'LLMActiveRequest' } },
                  paused: { kind: 'primitive', primitive: 'boolean' },
                }},
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
      const { messages, options, provider } = m.payload as LLMQueryPayload;
      this.checkPromptSize(messages);
      const result = await this.complete(messages, options, provider, m.routing.from, m.header.messageId);
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
      const { messages, options } = m.payload as {
        messages: LLMMessage[];
        options?: CompressOptions;
      };
      return this.compressMessages(messages, options ?? {}, m.routing.from, m.header.messageId);
    });

    this.on('stream', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { messages, options, provider: providerName } = m.payload as LLMQueryPayload;
      this.checkPromptSize(messages);
      const { provider, modelOverride, effortOverride } = this.resolveProviderAndModel(providerName, options?.tier);
      const effectiveOptions = this.applyRouting(options, modelOverride, effortOverride);

      const callerId = m.routing.from;
      const correlationId = m.header.messageId;

      // If provider doesn't support streaming, fall back to complete
      if (!provider.stream) {
        const result = await this.complete(messages, options, providerName, callerId, correlationId);
        // 'length' is the provider-agnostic signal for a truncated response.
        return { content: result.content, stopReason: result.finishReason === 'length' ? 'max_tokens' : result.finishReason };
      }

      const totalChars = messages.reduce((sum, m2) => sum + getTextContent(m2).length, 0);
      log.info(`→ ${provider.name} stream | ${messages.length} msgs | ${totalChars} chars | model=${effectiveOptions?.model ?? 'provider-default'}`);
      const start = Date.now();

      const activeReq = await this.trackRequestStart(
        correlationId, callerId, 'stream', provider.name,
        this.modelFor(provider, effectiveOptions), totalChars, true, messages,
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
      const tokenSummary = usage
        ? ` | tokens=${usage.inputTokens}in/${usage.outputTokens}out${usage.reasoningTokens ? `/reasoning=${usage.reasoningTokens}` : ''}`
        : '';
      // A stream that ends without a finish frame is suspect: the generation
      // may have been cut off upstream. Name it so truncation hunts don't
      // have to infer it from a bare 'unknown'.
      const reasonNote = stopReason === undefined && fullContent.length > 0
        ? 'unknown (no finish frame — possible truncation)'
        : (stopReason ?? 'unknown');
      log.info(`← ${provider.name} stream | ${fullContent.length} chars | ${elapsed}ms | reason=${reasonNote}${tokenSummary}`);
      this.trackRequestEnd(correlationId, fullContent, usage);
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
      return {
        stats: { ...this._stats },
        activeRequests: Array.from(this._activeRequests.values()),
        history: this._history,
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

    this.on('getRequestDetail', async (m: AbjectMessage) => {
      const { requestId } = m.payload as { requestId: string };
      // Check history first (most common case)
      const entry = this._history.find(h => h.id === requestId);
      if (entry) return entry;
      // Check active requests (no output content yet)
      const active = this._activeRequests.get(requestId);
      if (active) {
        return {
          id: active.id,
          callerId: active.callerId,
          callerName: active.callerName,
          method: active.method,
          provider: active.provider,
          startTime: active.startTime,
          elapsedMs: Date.now() - active.startTime,
          inputChars: active.inputChars,
          outputChars: active.outputChars,
          inputMessages: active.inputMessages ?? '',
          outputContent: '(still in progress)',
        } as LLMHistoryEntry;
      }
      return null;
    });

    this.on('killRequest', async (m: AbjectMessage) => {
      const { requestId } = m.payload as { requestId: string };
      const req = this._activeRequests.get(requestId);
      if (!req) return false;
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
    this.registerProvider(new ClaudeCliProvider());
    this.registerProvider(new CodexCliProvider());

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
  ): Promise<LLMCompletionResult> {
    const { provider, modelOverride, effortOverride } = this.resolveProviderAndModel(providerName, options?.tier);
    const effectiveOptions = this.applyRouting(options, modelOverride, effortOverride);

    const totalChars = messages.reduce((sum, m2) => sum + getTextContent(m2).length, 0);
    log.info(`→ ${provider.name} | ${messages.length} msgs | ${totalChars} chars | tier=${options?.tier ?? 'default'} model=${effectiveOptions?.model ?? 'provider-default'}${effectiveOptions?.effort ? ` effort=${effectiveOptions.effort}` : ''} maxTokens=${options?.maxTokens ?? 'default'}`);
    const start = Date.now();

    // Track active request
    const trackId = requestId ?? `internal-${Date.now()}`;
    if (callerId) {
      await this.trackRequestStart(trackId, callerId, 'complete', provider.name, this.modelFor(provider, effectiveOptions), totalChars, false, messages);
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
      if (callerId) this.trackRequestEnd(trackId, result.content, result.usage);
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
          const summary = await this.distillText(text, taskHint, callerId, `${baseId}-m${i}`, () => distillSeq++);
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
          summaries[ci] = await this.distillText(serialized, taskHint, callerId, `${baseId}-c${ci}`, () => distillSeq++);
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
    new CodexCliProvider(),
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

  private async trackRequestStart(
    requestId: string,
    callerId: AbjectId,
    method: string,
    providerName: string,
    model: string,
    inputChars: number,
    streaming: boolean,
    messages?: LLMMessage[],
  ): Promise<LLMActiveRequest> {
    const callerName = await this.resolveCallerName(callerId);
    const activeReq: LLMActiveRequest = {
      id: requestId,
      callerId,
      callerName,
      method,
      provider: providerName,
      model,
      startTime: Date.now(),
      inputChars,
      outputChars: 0,
      streaming,
      killed: false,
      inputMessages: messages ? this.serializeMessages(messages) : undefined,
    };
    this._activeRequests.set(requestId, activeReq);
    this._stats.totalRequests++;
    this.changed('requestStarted', { ...activeReq });
    return activeReq;
  }

  /**
   * Record completion of a tracked request and save to history.
   */
  private trackRequestEnd(
    requestId: string,
    outputContent: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    const req = this._activeRequests.get(requestId);
    if (!req) return;
    const elapsed = Date.now() - req.startTime;
    const outChars = outputContent.length;
    this._stats.totalLatencyMs += elapsed;
    this._stats.totalInputChars += req.inputChars;
    this._stats.totalOutputChars += outChars;
    if (usage) {
      this._stats.totalInputTokens += usage.inputTokens;
      this._stats.totalOutputTokens += usage.outputTokens;
    }
    // Save to history before deleting
    this._history.push({
      id: req.id,
      callerId: req.callerId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      model: req.model,
      startTime: req.startTime,
      elapsedMs: elapsed,
      inputChars: req.inputChars,
      outputChars: outChars,
      inputMessages: req.inputMessages ?? '',
      outputContent: this.truncate(outputContent),
      usage,
    });
    if (this._history.length > this._MAX_HISTORY) {
      this._history.shift();
    }
    this._activeRequests.delete(requestId);
    this.changed('requestCompleted', {
      id: requestId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      model: req.model,
      elapsedMs: elapsed,
      inputChars: req.inputChars,
      outputChars: outChars,
      usage,
    });
  }

  /**
   * Record an error on a tracked request and save to history.
   */
  private trackRequestError(requestId: string, error: string): void {
    const req = this._activeRequests.get(requestId);
    if (!req) return;
    const elapsed = Date.now() - req.startTime;
    this._stats.totalErrors++;
    this._stats.totalLatencyMs += elapsed;
    // Save error to history
    this._history.push({
      id: req.id,
      callerId: req.callerId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      model: req.model,
      startTime: req.startTime,
      elapsedMs: elapsed,
      inputChars: req.inputChars,
      outputChars: 0,
      inputMessages: req.inputMessages ?? '',
      outputContent: '',
      error,
    });
    if (this._history.length > this._MAX_HISTORY) {
      this._history.shift();
    }
    this._activeRequests.delete(requestId);
    this.changed('requestError', {
      id: requestId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      model: req.model,
      elapsedMs: elapsed,
      error,
    });
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
    await super.onStop();
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
