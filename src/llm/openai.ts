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

type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
}

interface OpenAIRequest {
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
        .map(id => ({ id, name: id }));
      return models;
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallbackModels();
    }
  }

  protected fallbackModels(): ModelInfo[] {
    return [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
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

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    require(this.apiKey !== undefined, 'API key is required');

    const request: OpenAIRequest = {
      model: this.resolveModel(options),
      messages: messages.map((m) => ({
        role: m.role,
        content: this.mapContent(m.content),
      })),
      max_completion_tokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stopSequences,
    };
    if (options.cacheKey) {
      request.prompt_cache_key = options.cacheKey;
    }

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
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');

    const request: OpenAIRequest = {
      model: this.resolveModel(options),
      messages: messages.map((m) => ({
        role: m.role,
        content: this.mapContent(m.content),
      })),
      max_completion_tokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stopSequences,
      stream: true,
    };
    if (options.cacheKey) {
      request.prompt_cache_key = options.cacheKey;
    }

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
          yield { content: '', done: true };
          return;
        }

        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta?.content;

          if (delta) {
            yield { content: delta, done: false };
          }

          if (event.choices?.[0]?.finish_reason) {
            yield { content: '', done: true };
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    yield { content: '', done: true };
  }

  /**
   * Map LLMMessage content to OpenAI API format.
   * String content passes through; ContentPart[] maps to OpenAI content parts.
   */
  protected mapContent(content: string | ContentPart[]): string | OpenAIContentPart[] {
    if (typeof content === 'string') return content;
    return content.map((part): OpenAIContentPart => {
      if (part.type === 'text') return { type: 'text', text: part.text };
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
