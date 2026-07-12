/**
 * Anthropic Claude API integration.
 */

import {
  BaseLLMProvider,
  FetchDelegate,
  LLMMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMProviderDescription,
  LLMStreamChunk,
  ModelTier,
  ModelInfo,
  ContentPart,
  EffortLevel,
  defaultIsRetryable,
  getTextContent,
} from './provider.js';
import { require } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ANTHROPIC');

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

type CacheControl = { type: 'ephemeral' };

type AnthropicContentBlock = {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
} | {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
  cache_control?: CacheControl;
} | {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
  title?: string;
  cache_control?: CacheControl;
};

type AnthropicSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
};

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicThinking =
  | { type: 'adaptive' }
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens: number };

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: AnthropicThinking;
  output_config?: { effort: EffortLevel };
}

/**
 * How a model's extended thinking is controlled, plus its output ceiling.
 * The newer Claude models replaced manual `budget_tokens` with adaptive
 * thinking + an `effort` control; Haiku 4.5 and older still use a manual
 * budget. `max_tokens` is a HARD cap on total output (thinking + answer), so
 * an undersized cap starves the answer — the model can spend the whole budget
 * thinking and emit zero text (stop_reason=max_tokens, block_types=[thinking]).
 */
interface ModelThinkingProfile {
  // 'adaptive-optin'  → send thinking:{type:'adaptive'} to enable (Opus 4.8/4.7/4.6)
  // 'adaptive-default'→ thinking on by default; effort controls depth (Sonnet 5, Fable/Mythos 5)
  // 'manual'          → send thinking:{type:'enabled',budget_tokens} to enable (Haiku 4.5, Opus 4.5)
  // 'none'            → no extended-thinking config (unknown/legacy models)
  mode: 'adaptive-optin' | 'adaptive-default' | 'manual' | 'none';
  supportsEffort: boolean;
  maxOutput: number;
}

/**
 * Resolved per-call generation settings (max_tokens + optional effort/thinking)
 * derived from the model profile and the requested tier.
 */
interface GenerationConfig {
  maxTokens: number;
  effort?: EffortLevel;
  thinking?: AnthropicThinking;
  thinkingEnabled: boolean;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: { type: string; text: string }[];
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Anthropic Claude provider.
 */
export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'anthropic';
  private model: string;

  private static readonly TIER_MODELS: Record<ModelTier, string> = {
    smart: 'claude-opus-4-8',
    balanced: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5-20251001',
    code: 'claude-opus-4-8',
  };

  override resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    return options?.tier ? AnthropicProvider.TIER_MODELS[options.tier] : this.model;
  }

  // ── Per-model / per-tier generation defaults ───────────────────────────
  // Empirically-tuned (not just the vendor line): high is the everyday smart
  // default with xhigh reserved for hard build steps and max avoided (it
  // overthinks structured/coding output); the balanced tier caps at medium and
  // escalates to smart rather than paying for Sonnet-at-xhigh (dominated by
  // Opus on cost); fast doesn't think. max_tokens is sized so thinking (which
  // tapers off ~15k tokens) plus the answer both fit, fixing the truncation.

  private static readonly TIER_EFFORT: Record<ModelTier, EffortLevel> = {
    smart: 'high',
    balanced: 'medium',
    fast: 'low',
    code: 'high',
  };

  private static readonly TIER_MAX_TOKENS: Record<ModelTier, number> = {
    smart: 64000,
    balanced: 32000,
    fast: 12000,
    code: 64000,
  };

  /** Floor on max_tokens whenever thinking is active, so the answer always
   * has room after the thinking budget (which tapers off ~15k tokens). */
  private static readonly MIN_THINKING_MAX_TOKENS = 16000;

  /** Manual thinking budget per tier, for models still on manual budgets. */
  private static readonly TIER_THINKING_BUDGET: Record<ModelTier, number> = {
    smart: 12000,
    balanced: 8000,
    fast: 0, // disabled — the fast tier answers directly
    code: 12000,
  };

  private static profileForModel(model: string): ModelThinkingProfile {
    const m = model.toLowerCase();
    if (m.includes('opus-4-8') || m.includes('opus-4-7') || m.includes('opus-4-6')) {
      return { mode: 'adaptive-optin', supportsEffort: true, maxOutput: 128000 };
    }
    if (m.includes('sonnet-5') || m.includes('sonnet-4-6') || m.includes('fable-5') || m.includes('mythos-5')) {
      return { mode: 'adaptive-default', supportsEffort: true, maxOutput: 128000 };
    }
    if (m.includes('opus-4-5')) {
      return { mode: 'manual', supportsEffort: true, maxOutput: 64000 };
    }
    if (m.includes('haiku-4-5')) {
      return { mode: 'manual', supportsEffort: false, maxOutput: 64000 };
    }
    // Unknown/legacy: send nothing model-specific and keep a modest cap so we
    // never trip a 400 on an unsupported field.
    return { mode: 'none', supportsEffort: false, maxOutput: 8192 };
  }

  /**
   * Resolve max_tokens + effort + thinking for a call from the model profile
   * and the requested tier. Callers may override effort (`options.effort`) and
   * raise max_tokens (`options.maxTokens` acts as a floor, capped at the model
   * ceiling). With no tier, behaves like the legacy path (no effort/thinking).
   */
  private resolveGenerationConfig(model: string, options: LLMCompletionOptions): GenerationConfig {
    const profile = AnthropicProvider.profileForModel(model);
    const tier = options.tier;

    // base max_tokens: tier default as a floor, honoring a larger caller
    // request, capped at the model's output ceiling. No tier → legacy default.
    const tierMax = tier ? AnthropicProvider.TIER_MAX_TOKENS[tier] : (options.maxTokens ?? 4096);
    let maxTokens = Math.min(profile.maxOutput, Math.max(tierMax, options.maxTokens ?? 0));

    // effort: caller override, else tier default — only for effort-capable models.
    let effort: EffortLevel | undefined;
    if (profile.supportsEffort) {
      effort = options.effort ?? (tier ? AnthropicProvider.TIER_EFFORT[tier] : undefined);
    }

    // The smart/balanced/code tiers reason; the fast tier and untiered utility
    // calls answer directly (preserving legacy behavior for the latter).
    const wantThink = tier === 'smart' || tier === 'balanced' || tier === 'code';

    // thinking field + whether the model will actually produce thinking.
    let thinking: AnthropicThinking | undefined;
    let thinkingActive = false;
    const budget = tier ? AnthropicProvider.TIER_THINKING_BUDGET[tier] : 0;
    switch (profile.mode) {
      case 'adaptive-optin':
        // Off unless we opt in; opt in for smart/balanced.
        if (wantThink) { thinking = { type: 'adaptive' }; thinkingActive = true; }
        break;
      case 'adaptive-default':
        // On by default server-side; leave the field unset and let effort set
        // depth. It thinks regardless of tier, so treat as active for sizing.
        thinkingActive = true;
        break;
      case 'manual':
        if (wantThink && budget > 0) { thinking = { type: 'enabled', budget_tokens: budget }; thinkingActive = true; }
        break;
      case 'none':
        break;
    }

    // Whenever thinking is active, guarantee headroom so thinking (which tapers
    // off ~15k tokens) plus the answer both fit — this is the core truncation fix.
    if (thinkingActive) {
      maxTokens = Math.min(profile.maxOutput, Math.max(maxTokens, AnthropicProvider.MIN_THINKING_MAX_TOKENS));
    }
    // Manual budget must stay strictly below max_tokens.
    if (thinking?.type === 'enabled' && thinking.budget_tokens >= maxTokens) {
      thinking = { type: 'enabled', budget_tokens: Math.max(1024, maxTokens - 4096) };
    }

    return { maxTokens, effort, thinking, thinkingEnabled: thinkingActive };
  }

  /** Build the shared request body with per-model generation settings applied. */
  private buildRequest(messages: LLMMessage[], options: LLMCompletionOptions, stream: boolean): AnthropicRequest {
    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const anthropicMessages: AnthropicMessage[] = conversationMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: this.mapContent(m.content),
    }));
    this.applyCacheBreakpoint(anthropicMessages);

    const model = this.resolveModel(options);
    const cfg = this.resolveGenerationConfig(model, options);

    const request: AnthropicRequest = {
      model,
      max_tokens: cfg.maxTokens,
      messages: anthropicMessages,
      temperature: options.temperature,
      stop_sequences: options.stopSequences,
    };
    if (stream) request.stream = true;
    if (cfg.thinking) request.thinking = cfg.thinking;
    if (cfg.effort) request.output_config = { effort: cfg.effort };

    const systemBlocks = this.buildSystem(systemMsg);
    if (systemBlocks) request.system = systemBlocks;

    return request;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      log.warn('listModels: no API key on this provider instance; returning the fallback catalog. The dynamic model list only loads for a provider registered with a credential.');
      return this.fallbackModels();
    }
    try {
      const url = `${this.baseUrl}/v1/models?limit=1000`;
      const response = await this.fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (!response.ok) {
        log.warn(`listModels: GET ${url} returned ${response.status} ${response.statusText}; falling back. Body: ${String(response.body).slice(0, 300)}`);
        return this.fallbackModels();
      }
      const parsed = JSON.parse(response.body) as {
        data?: Array<{ id: string; display_name?: string }>;
      };
      const rows = parsed.data ?? [];
      if (rows.length === 0) {
        log.warn(`listModels: GET ${url} returned 0 models (unexpected response shape?); falling back. Body: ${String(response.body).slice(0, 300)}`);
        return this.fallbackModels();
      }
      log.info(`listModels: fetched ${rows.length} live Anthropic models`);
      // Every current Claude chat model accepts image input
      return rows.map(r => ({ id: r.id, name: r.display_name ?? r.id, vision: true }));
    } catch (err) {
      log.warn(`listModels: fetch failed (${err instanceof Error ? err.message : String(err)}); falling back to the hardcoded catalog`);
      return this.fallbackModels();
    }
  }

  private fallbackModels(): ModelInfo[] {
    return [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', vision: true },
      { id: 'claude-fable-5', name: 'Claude Fable 5', vision: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', vision: true },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', vision: true },
    ];
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'anthropic',
      label: 'Anthropic',
      storageSuffix: 'anthropicApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'Anthropic API Key',
      credentialPlaceholder: 'sk-ant-...',
      models: this.fallbackModels(),
      defaultTierModels: AnthropicProvider.TIER_MODELS,
    };
  }

  constructor(config: AnthropicConfig) {
    // Use Vite proxy in dev to avoid CORS
    const defaultBase = typeof window !== 'undefined' && window.location?.hostname === 'localhost'
      ? '/api/anthropic'
      : 'https://api.anthropic.com';
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? defaultBase,
      fetchFn: config.fetchFn,
    });
    this.model = config.model ?? 'claude-sonnet-4-6';
  }

  private buildSystem(systemMsg: LLMMessage | undefined): AnthropicSystemBlock[] | undefined {
    if (!systemMsg) return undefined;
    const text = getTextContent(systemMsg);
    if (!text) return undefined;
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  /**
   * Place a cache breakpoint on the final content block of the last message.
   *
   * Claude caches everything up to and including each breakpoint. Marking the
   * tail means turn N+1 of an ongoing conversation reuses turn N's cached
   * prefix: system + all prior messages get served from cache instead of
   * re-tokenized. Combined with the system-prompt breakpoint, agent loops
   * (AgentAbject's think/act iterations, Chat's rolling history, ObjectCreator
   * retries) all benefit automatically.
   *
   * Breakpoints below Anthropic's cache threshold are ignored by the API at
   * no extra cost, so we always apply this; callers do not need to opt in.
   * We use at most 2 of the 4 breakpoints Anthropic allows per request.
   */
  private applyCacheBreakpoint(messages: AnthropicMessage[]): void {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];

    if (typeof last.content === 'string') {
      if (!last.content) return;
      last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
      return;
    }

    const blocks = last.content;
    if (blocks.length === 0) return;
    blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  /** Max output tokens for a NON-streaming request. Above this Anthropic
   * expects streaming (long-request limit), so complete() routes to the
   * streaming path instead of risking a 400 / long-request timeout. */
  private static readonly NON_STREAMING_MAX_TOKENS = 20000;

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    require(this.apiKey !== undefined, 'API key is required');

    const model = this.resolveModel(options);
    const cfg = this.resolveGenerationConfig(model, options);

    // Thinking-enabled answers need a large max_tokens (thinking + answer share
    // the cap), and the non-streaming endpoint can't serve that size. Collect
    // via the streaming path so the answer is never truncated by the cap.
    if (cfg.thinkingEnabled || cfg.maxTokens > AnthropicProvider.NON_STREAMING_MAX_TOKENS) {
      return this.completeViaStream(messages, options);
    }

    const request = this.buildRequest(messages, options, false);

    return this.withRetries(async () => {
      const response = await this.fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'x-api-key': this.apiKey!,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(request),
      }, { timeout: 300000 });

      const data = JSON.parse(response.body) as AnthropicResponse;

      // Extract text content
      const content = data.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');

      return {
        content,
        finishReason: data.stop_reason === 'end_turn' ? 'stop' : 'length',
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          cacheReadTokens: data.usage.cache_read_input_tokens,
          cacheWriteTokens: data.usage.cache_creation_input_tokens,
        },
      };
    }, { label: 'anthropic.complete' });
  }

  /**
   * Non-streaming result assembled from the streaming path. Used when thinking
   * is enabled or max_tokens is large, where the plain endpoint would truncate
   * or reject. Usage is captured from the stream's terminal chunk.
   */
  private async completeViaStream(
    messages: LLMMessage[],
    options: LLMCompletionOptions,
  ): Promise<LLMCompletionResult> {
    let content = '';
    let stopReason: string | undefined;
    let usage: LLMCompletionResult['usage'];
    for await (const chunk of this.stream(messages, options)) {
      if (chunk.content) content += chunk.content;
      if (chunk.done) {
        stopReason = chunk.stopReason;
        if (chunk.usage) usage = chunk.usage;
      }
    }
    return {
      content,
      finishReason: stopReason === 'end_turn' ? 'stop' : (stopReason ? 'length' : 'stop'),
      usage,
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');

    const request = this.buildRequest(messages, options, true);

    const maxAttempts = 3;
    const initialDelayMs = 1000;
    const backoffFactor = 2;
    const maxDelayMs = 10000;
    let yielded = false;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        for await (const chunk of this.streamOnce(request)) {
          if (chunk.content.length > 0) yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        lastErr = err;
        if (yielded) throw err;
        if (attempt >= maxAttempts) throw err;
        if (!defaultIsRetryable(err)) throw err;
        const delay = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[anthropic.stream] attempt ${attempt}/${maxAttempts} failed: ${msg.slice(0, 200)} — retrying in ${delay}ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  private async *streamOnce(request: AnthropicRequest): AsyncIterable<LLMStreamChunk> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      // Surface the API's own error detail — a bare status code is
      // unactionable (400 alone doesn't say "prompt too long" vs "roles must
      // alternate" vs "max_tokens too large").
      const errorText = await response.text().catch(() => '');
      let detail = errorText;
      try {
        const parsed = JSON.parse(errorText) as { error?: { type?: string; message?: string } };
        if (parsed.error?.message) {
          detail = parsed.error.type ? `${parsed.error.type}: ${parsed.error.message}` : parsed.error.message;
        }
      } catch { /* not JSON — use raw text */ }
      throw new Error(`Anthropic API error: ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ''}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    // Diagnostics: when the stream ends with no text content, emitting a
    // single warning line listing what events DID arrive turns "0 chars"
    // mysteries (refusals, unhandled delta types, content moderation hits)
    // into actionable debugging data.
    let emittedTextChars = 0;
    const eventTypeCounts = new Map<string, number>();
    const blockTypes: string[] = [];
    const deltaTypes: string[] = [];
    let stopReason: string | undefined;
    let usage: LLMStreamChunk['usage'];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6);
        if (data === '[DONE]') {
          if (emittedTextChars === 0) this.warnEmptyStream(eventTypeCounts, blockTypes, deltaTypes, stopReason);
          yield { content: '', done: true, stopReason, usage };
          return;
        }

        try {
          const event = JSON.parse(data);
          if (typeof event?.type === 'string') {
            eventTypeCounts.set(event.type, (eventTypeCounts.get(event.type) ?? 0) + 1);
          }

          if (event.type === 'message_start' && event.message?.usage) {
            const u = event.message.usage;
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens,
              cacheWriteTokens: u.cache_creation_input_tokens,
            };
          } else if (event.type === 'content_block_start' && event.content_block?.type) {
            blockTypes.push(String(event.content_block.type));
          } else if (event.type === 'content_block_delta') {
            const deltaType = event.delta?.type;
            if (deltaType) deltaTypes.push(String(deltaType));
            const text = event.delta?.text ?? '';
            if (text) emittedTextChars += text.length;
            yield {
              content: text,
              done: false,
            };
          } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) stopReason = String(event.delta.stop_reason);
            if (event.usage?.output_tokens != null && usage) usage.outputTokens = event.usage.output_tokens;
          } else if (event.type === 'message_stop') {
            if (emittedTextChars === 0) this.warnEmptyStream(eventTypeCounts, blockTypes, deltaTypes, stopReason);
            yield { content: '', done: true, stopReason, usage };
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    if (emittedTextChars === 0) this.warnEmptyStream(eventTypeCounts, blockTypes, deltaTypes, stopReason);
    yield { content: '', done: true, stopReason, usage };
  }

  /**
   * Emit a structured warning when a stream completed with no text content.
   * Captures stop_reason, content block types, and delta types so the next
   * incident has actionable debugging data without re-running the request.
   */
  private warnEmptyStream(
    eventTypeCounts: Map<string, number>,
    blockTypes: string[],
    deltaTypes: string[],
    stopReason: string | undefined,
  ): void {
    const eventSummary = [...eventTypeCounts.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const blockSummary = blockTypes.length > 0 ? blockTypes.join(', ') : '(none)';
    const deltaSummary = deltaTypes.length > 0 ? [...new Set(deltaTypes)].join(', ') : '(none)';
    log.warn(
      `Anthropic stream produced 0 text chars. ` +
        `stop_reason=${stopReason ?? 'unknown'} ` +
        `block_types=[${blockSummary}] ` +
        `delta_types=[${deltaSummary}] ` +
        `events=[${eventSummary || '(none)'}]`,
    );
  }

  /**
   * Map LLMMessage content to Anthropic API format.
   * String content passes through; ContentPart[] maps to Anthropic content blocks.
   */
  private mapContent(content: string | ContentPart[]): string | AnthropicContentBlock[] {
    if (typeof content === 'string') return content;
    return content.map((part): AnthropicContentBlock => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'document') {
        return { type: 'document', source: { type: 'base64', media_type: part.mediaType, data: part.data }, title: part.name };
      }
      return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } };
    });
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
  }
}

/**
 * Create an Anthropic provider from environment.
 */
export function createAnthropicProvider(): AnthropicProvider | undefined {
  // In browser, check for global config
  const apiKey =
    (globalThis as Record<string, unknown>).ANTHROPIC_API_KEY as string | undefined;

  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }

  return new AnthropicProvider({ apiKey });
}
