/**
 * Anthropic Claude API integration.
 */

import {
  BaseLLMProvider,
  FetchDelegate,
  LLMMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMStreamChunk,
  ModelTier,
  ModelInfo,
  ContentPart,
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

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
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
    smart: 'claude-opus-4-7',
    balanced: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5-20251001',
  };

  private resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    return options?.tier ? AnthropicProvider.TIER_MODELS[options.tier] : this.model;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      return this.fallbackModels();
    }
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models?limit=1000`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      const parsed = JSON.parse(response.body) as {
        data?: Array<{ id: string; display_name?: string }>;
      };
      const rows = parsed.data ?? [];
      if (rows.length === 0) return this.fallbackModels();
      return rows.map(r => ({ id: r.id, name: r.display_name ?? r.id }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallbackModels();
    }
  }

  private fallbackModels(): ModelInfo[] {
    return [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ];
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

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    require(this.apiKey !== undefined, 'API key is required');

    // Separate system message from conversation
    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Convert to Anthropic format
    const anthropicMessages: AnthropicMessage[] = conversationMessages.map(
      (m) => ({
        role: m.role as 'user' | 'assistant',
        content: this.mapContent(m.content),
      })
    );
    this.applyCacheBreakpoint(anthropicMessages);

    const request: AnthropicRequest = {
      model: this.resolveModel(options),
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
      temperature: options.temperature,
      stop_sequences: options.stopSequences,
    };

    const systemBlocks = this.buildSystem(systemMsg);
    if (systemBlocks) {
      request.system = systemBlocks;
    }

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
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');

    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const anthropicMessages: AnthropicMessage[] = conversationMessages.map(
      (m) => ({
        role: m.role as 'user' | 'assistant',
        content: this.mapContent(m.content),
      })
    );
    this.applyCacheBreakpoint(anthropicMessages);

    const request: AnthropicRequest = {
      model: this.resolveModel(options),
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
      temperature: options.temperature,
      stop_sequences: options.stopSequences,
      stream: true,
    };

    const systemBlocks = this.buildSystem(systemMsg);
    if (systemBlocks) {
      request.system = systemBlocks;
    }

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
      throw new Error(`Anthropic API error: ${response.status}`);
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

      // Parse SSE events
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

          if (event.type === 'content_block_delta') {
            yield {
              content: event.delta?.text ?? '',
              done: false,
            };
          } else if (event.type === 'message_stop') {
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
   * Map LLMMessage content to Anthropic API format.
   * String content passes through; ContentPart[] maps to Anthropic content blocks.
   */
  private mapContent(content: string | ContentPart[]): string | AnthropicContentBlock[] {
    if (typeof content === 'string') return content;
    return content.map((part): AnthropicContentBlock => {
      if (part.type === 'text') return { type: 'text', text: part.text };
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
