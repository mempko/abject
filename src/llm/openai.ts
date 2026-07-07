/**
 * OpenAI API integration.
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
} from './provider.js';
import { require } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('OPENAI');

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
  /**
   * Optional per-tier model override. Subclasses (OpenRouter, DeepSeek, Grok)
   * pass their own tier mapping while reusing OpenAI's chat-completions logic.
   */
  tierModels?: Record<ModelTier, string>;
  /**
   * Optional extra headers merged into every request (e.g. OpenRouter's
   * HTTP-Referer and X-Title attribution headers).
   */
  extraHeaders?: Record<string, string>;
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_completion_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
  /**
   * Pins this request's prefix hash to a routing bucket so the same long
   * prefix (e.g. a chat system prompt + history) lands on the same server
   * instance across calls, lifting cache hit rate. OpenAI-only.
   */
  prompt_cache_key?: string;
  /** Reasoning-effort control (GPT-5.x etc.). Not sent by providers that reject it. */
  reasoning_effort?: string;
  /** Output-length style hint (GPT-5.x). */
  verbosity?: string;
  /** Provider-specific extras (e.g. reasoning, reasoning_split) set by subclass hooks. */
  [key: string]: unknown;
}

/** Per-model reasoning capability + output ceiling, provided by each provider. */
export interface OpenAIReasoningProfile {
  /** Whether this model accepts `reasoning_effort` (sending it to one that
   * doesn't — e.g. Grok 4 — hard-fails the request). */
  supportsEffort: boolean;
  /** Whether the model reasons at all (drives output-cap headroom + streaming). */
  reasons: boolean;
  /** Model's max output-token ceiling (used to clamp the tier cap; also serves
   * as a small-context guard when set low for small-context models). */
  maxOutput: number;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

/**
 * OpenAI provider.
 */
export class OpenAIProvider extends BaseLLMProvider {
  name: string = 'openai';
  protected model: string;
  protected tierModels: Record<ModelTier, string>;
  protected extraHeaders: Record<string, string>;

  private static readonly DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
    smart: 'gpt-5.4',
    balanced: 'gpt-5.4-mini',
    fast: 'gpt-5.4-nano',
  };

  protected resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    return options?.tier ? this.tierModels[options.tier] : this.model;
  }

  /**
   * Whether a model id accepts image input; undefined = unknown. Base =
   * OpenAI: the modern chat families (GPT-4o/4.1/5.x, o-series) are
   * multimodal; legacy text models are not. Subclasses override with their
   * own catalogs (DeepSeek all-text, Grok 4+ multimodal, ...). OpenRouter
   * overrides listModels entirely and uses live modality data instead.
   */
  protected modelVision(modelId: string): boolean | undefined {
    if (/^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o[134])/i.test(modelId)) return true;
    if (/^(gpt-3\.5|gpt-4-\d|chatgpt)/i.test(modelId)) return false;
    return undefined;
  }

  // ── Per-tier generation defaults (shared across OpenAI-compatible providers) ──
  // Same philosophy as the Anthropic provider: reasoning tokens share the output
  // cap, so an undersized cap starves the answer (empty / finish_reason=length).
  // Size the cap generously when reasoning is active. Subclasses override
  // reasoningProfile()/applyReasoning() for their model-specific semantics.

  protected static readonly TIER_EFFORT: Record<ModelTier, EffortLevel> = {
    smart: 'high',
    balanced: 'medium',
    fast: 'low',
  };

  protected static readonly TIER_MAX_TOKENS: Record<ModelTier, number> = {
    smart: 32000,
    balanced: 16000,
    fast: 4000,
  };

  /** Floor on the output cap whenever reasoning is active, so the answer fits. */
  protected static readonly MIN_REASONING_MAX_TOKENS = 16000;

  /** Above this, a non-streaming request risks the long-request limit; route to streaming. */
  protected static readonly NON_STREAMING_MAX_TOKENS = 20000;

  /**
   * Model reasoning capability + output ceiling. Base = OpenAI GPT-5.x
   * (reasoning_effort supported, 128k output). Subclasses override.
   */
  protected reasoningProfile(_model: string): OpenAIReasoningProfile {
    return { supportsEffort: true, reasons: true, maxOutput: 128000 };
  }

  /**
   * Effort for this call: explicit override, else per-tier default. Untiered
   * calls get none (legacy behavior).
   */
  protected resolveEffort(options: LLMCompletionOptions): EffortLevel | undefined {
    return options.effort ?? (options.tier ? OpenAIProvider.TIER_EFFORT[options.tier] : undefined);
  }

  /**
   * Apply reasoning fields to the request. Base = OpenAI: set `reasoning_effort`
   * (+ a `verbosity` hint) when the model supports it. Returns whether reasoning
   * will actually run (drives cap sizing + the streaming route). Subclasses
   * override for their own reasoning API (or to send nothing).
   */
  protected applyReasoning(request: OpenAIRequest, model: string, options: LLMCompletionOptions): { reasoningActive: boolean } {
    const profile = this.reasoningProfile(model);
    if (!profile.supportsEffort) return { reasoningActive: profile.reasons };
    const effort = this.resolveEffort(options);
    if (effort) request.reasoning_effort = effort;
    return { reasoningActive: profile.reasons && effort !== 'none' };
  }

  /** Output-token cap: tier default (floored by caller request and by the
   * reasoning minimum), clamped to the model's output ceiling. */
  protected resolveMaxTokens(model: string, options: LLMCompletionOptions, reasoningActive: boolean): number {
    const profile = this.reasoningProfile(model);
    const tier = options.tier;
    let cap = tier ? OpenAIProvider.TIER_MAX_TOKENS[tier] : (options.maxTokens ?? 4096);
    cap = Math.max(cap, options.maxTokens ?? 0);
    if (reasoningActive) cap = Math.max(cap, OpenAIProvider.MIN_REASONING_MAX_TOKENS);
    return Math.min(cap, profile.maxOutput);
  }

  /** Build the shared request with reasoning + cap applied. */
  protected buildRequest(messages: LLMMessage[], options: LLMCompletionOptions, stream: boolean): { request: OpenAIRequest; reasoningActive: boolean } {
    const model = this.resolveModel(options);
    const request: OpenAIRequest = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: this.mapContent(m.content) })),
      temperature: options.temperature,
      stop: options.stopSequences,
    };
    if (stream) request.stream = true;
    if (options.cacheKey) request.prompt_cache_key = options.cacheKey;
    const { reasoningActive } = this.applyReasoning(request, model, options);
    request.max_completion_tokens = this.resolveMaxTokens(model, options, reasoningActive);
    return { request, reasoningActive };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      return this.fallbackModels();
    }
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const parsed = JSON.parse(response.body) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };
      const rows = parsed.data ?? [];
      if (rows.length === 0) return this.fallbackModels();
      // Keep chat-capable text models; drop embeddings/audio/image/moderation/realtime.
      const excluded = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|davinci|babbage|ada|curie)/i;
      const filtered = rows
        .map(r => r.id)
        .filter(id => !excluded.test(id))
        .sort();
      const models = (filtered.length > 0 ? filtered : rows.map(r => r.id))
        .map(id => ({ id, name: id, vision: this.modelVision(id) }));
      return models;
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallbackModels();
    }
  }

  protected fallbackModels(): ModelInfo[] {
    return [
      { id: 'gpt-5.4', name: 'GPT-5.4', vision: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', vision: true },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', vision: true },
    ];
  }

  /**
   * Self-description for the AI tab. OpenAI-compatible subclasses
   * (OpenRouter, DeepSeek, Grok, Kimi, MiniMax) override this with
   * their own id/label/defaults but reuse the shared OpenAI HTTP path.
   */
  override describe(): LLMProviderDescription {
    return {
      id: 'openai',
      label: 'OpenAI',
      storageSuffix: 'openaiApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'OpenAI API Key',
      credentialPlaceholder: 'sk-...',
      models: this.fallbackModels(),
      defaultTierModels: this.tierModels,
    };
  }

  constructor(config: OpenAIConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.openai.com',
      fetchFn: config.fetchFn,
    });
    this.tierModels = config.tierModels ?? OpenAIProvider.DEFAULT_TIER_MODELS;
    this.model = config.model ?? this.tierModels.balanced;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  /**
   * Speech APIs are first-party OpenAI only: the OpenAI-compatible
   * subclasses (OpenRouter, DeepSeek, Grok, Kimi, MiniMax) reuse the chat
   * path but serve neither /v1/audio/transcriptions nor /v1/audio/speech,
   * so gate on the provider name they reassign.
   */
  override supportsSpeech(): { transcribe: boolean; synthesize: boolean } {
    const firstParty = this.name === 'openai' && !!this.apiKey;
    return { transcribe: firstParty, synthesize: firstParty };
  }

  /**
   * Speech endpoints move raw audio bytes, and the FetchDelegate/FetchResult
   * plumbing is text-only (body: string), so both methods use global fetch
   * directly: transcribe uploads a binary multipart part, synthesize receives
   * a binary audio body.
   */
  async transcribe(
    audio: { base64: string; mimeType: string },
    options?: { model?: string; language?: string },
  ): Promise<{ text: string }> {
    require(this.apiKey !== undefined, 'API key is required');
    require(audio.base64.length > 0, 'audio base64 must be non-empty');
    const model = options?.model ?? 'whisper-1';

    // Build the multipart body by hand from the base64 buffer so the file
    // part stays binary-safe end to end.
    const boundary = `----abjects-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const ext = audio.mimeType.includes('wav') ? 'wav'
      : audio.mimeType.includes('mp4') ? 'm4a'
      : audio.mimeType.includes('mpeg') ? 'mp3'
      : audio.mimeType.includes('ogg') ? 'ogg'
      : 'webm';
    const fields: string[] = [`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`];
    if (options?.language) {
      fields.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${options.language}\r\n`);
    }
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${audio.mimeType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;
    const encoder = new TextEncoder();
    const head = encoder.encode(fields.join('') + fileHeader);
    const bytes = Uint8Array.from(atob(audio.base64), c => c.charCodeAt(0));
    const tail = encoder.encode(closing);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    return this.withRetries(async () => {
      const response = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: body as BodyInit,
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenAI transcription error (${response.status}): ${errorText}`);
      }
      const data = await response.json() as { text?: string };
      return { text: data.text ?? '' };
    }, { label: `${this.name}.transcribe` });
  }

  async synthesize(
    text: string,
    options?: { model?: string; voice?: string },
  ): Promise<{ base64: string; mimeType: string }> {
    require(this.apiKey !== undefined, 'API key is required');
    require(text.length > 0, 'text must be non-empty');
    const model = options?.model ?? 'gpt-4o-mini-tts';

    return this.withRetries(async () => {
      const response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice: options?.voice ?? 'alloy',
          response_format: 'mp3',
        }),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenAI speech error (${response.status}): ${errorText}`);
      }
      const buf = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      return { base64: btoa(binary), mimeType: 'audio/mpeg' };
    }, { label: `${this.name}.synthesize` });
  }

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    require(this.apiKey !== undefined, 'API key is required');

    const { request } = this.buildRequest(messages, options, false);

    // A large output cap (reasoning models) can't be served by the plain
    // endpoint without risking the long-request limit; collect via streaming.
    if ((request.max_completion_tokens ?? 0) > OpenAIProvider.NON_STREAMING_MAX_TOKENS) {
      return this.completeViaStream(messages, options);
    }

    return this.withRetries(async () => {
      const response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(request),
      }, { timeout: 300000 });

      const data = JSON.parse(response.body) as OpenAIResponse;

      const choice = data.choices[0];
      if (!choice) {
        throw new Error('No completion returned');
      }

      return {
        content: choice.message.content,
        finishReason: choice.finish_reason === 'stop' ? 'stop' : 'length',
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens,
        },
      };
    }, { label: `${this.name}.complete` });
  }

  /** Non-streaming result assembled from the streaming path, for large-cap
   * (reasoning) calls the plain endpoint can't serve. */
  protected async completeViaStream(messages: LLMMessage[], options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    let content = '';
    let stopReason: string | undefined;
    for await (const chunk of this.stream(messages, options)) {
      if (chunk.content) content += chunk.content;
      if (chunk.done) stopReason = chunk.stopReason;
    }
    return {
      content,
      finishReason: stopReason === 'stop' || stopReason === undefined ? 'stop' : 'length',
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');

    const { request } = this.buildRequest(messages, options, true);

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
        console.warn(`[${this.name}.stream] attempt ${attempt}/${maxAttempts} failed: ${msg.slice(0, 200)} — retrying in ${delay}ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  private async *streamOnce(request: OpenAIRequest): AsyncIterable<LLMStreamChunk> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${body}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6);
        if (data === '[DONE]') {
          yield { content: '', done: true, stopReason };
          return;
        }

        try {
          const event = JSON.parse(data);
          // Reasoning models put the answer in delta.content; the hidden
          // reasoning goes to a separate field (reasoning_content /
          // reasoning_details), which we intentionally do not surface.
          const delta = event.choices?.[0]?.delta?.content;

          if (delta) {
            yield { content: delta, done: false };
          }

          const fr = event.choices?.[0]?.finish_reason;
          if (fr) {
            stopReason = String(fr);
            yield { content: '', done: true, stopReason };
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    yield { content: '', done: true, stopReason };
  }

  /**
   * Map LLMMessage content to OpenAI API format.
   * String content passes through; ContentPart[] maps to OpenAI content parts.
   */
  protected mapContent(content: string | ContentPart[]): string | OpenAIContentPart[] {
    if (typeof content === 'string') return content;
    return content.map((part): OpenAIContentPart => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'document') {
        return { type: 'file', file: { filename: part.name ?? 'document.pdf', file_data: `data:${part.mediaType};base64,${part.data}` } };
      }
      return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
    });
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }
}

/**
 * Create an OpenAI provider from environment.
 */
export function createOpenAIProvider(): OpenAIProvider | undefined {
  const apiKey =
    (globalThis as Record<string, unknown>).OPENAI_API_KEY as string | undefined;

  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }

  return new OpenAIProvider({ apiKey });
}
