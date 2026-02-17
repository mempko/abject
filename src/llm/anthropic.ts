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
} from './provider.js';
import { require } from '../core/contracts.js';

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
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
  };
}

/**
 * Anthropic Claude provider.
 */
export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'anthropic';
  private model: string;

  private static readonly TIER_MODELS: Record<ModelTier, string> = {
    smart: 'claude-opus-4-6',
    balanced: 'claude-sonnet-4-5-20250929',
    fast: 'claude-haiku-4-5-20251001',
  };

  private resolveModel(tier?: ModelTier): string {
    return tier ? AnthropicProvider.TIER_MODELS[tier] : this.model;
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
    this.model = config.model ?? 'claude-sonnet-4-5-20250929';
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
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Convert to Anthropic format
    const anthropicMessages: AnthropicMessage[] = conversationMessages.map(
      (m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })
    );

    const request: AnthropicRequest = {
      model: this.resolveModel(options.tier),
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
      temperature: options.temperature,
      stop_sequences: options.stopSequences,
    };

    if (systemMessage) {
      request.system = systemMessage.content;
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
    });

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
      },
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');
    require(!this.fetchFn, 'Streaming is not supported when using HttpClient delegate');

    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const anthropicMessages: AnthropicMessage[] = conversationMessages.map(
      (m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })
    );

    const request: AnthropicRequest = {
      model: this.resolveModel(options.tier),
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
      temperature: options.temperature,
      stop_sequences: options.stopSequences,
      stream: true,
    };

    if (systemMessage) {
      request.system = systemMessage.content;
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
    console.warn('[ANTHROPIC] No API key found');
    return undefined;
  }

  return new AnthropicProvider({ apiKey });
}
