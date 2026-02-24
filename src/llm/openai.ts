/**
 * OpenAI API integration.
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

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
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
  };
}

/**
 * OpenAI provider.
 */
export class OpenAIProvider extends BaseLLMProvider {
  readonly name = 'openai';
  private model: string;

  private static readonly TIER_MODELS: Record<ModelTier, string> = {
    smart: 'gpt-4o',
    balanced: 'gpt-4-turbo-preview',
    fast: 'gpt-4o-mini',
  };

  private resolveModel(tier?: ModelTier): string {
    return tier ? OpenAIProvider.TIER_MODELS[tier] : this.model;
  }

  constructor(config: OpenAIConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.openai.com',
      fetchFn: config.fetchFn,
    });
    this.model = config.model ?? 'gpt-4-turbo-preview';
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
      model: this.resolveModel(options.tier),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stopSequences,
    };

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
      },
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');
    require(!this.fetchFn, 'Streaming is not supported when using HttpClient delegate');

    const request: OpenAIRequest = {
      model: this.resolveModel(options.tier),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stopSequences,
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
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

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
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
    console.warn('[OPENAI] No API key found');
    return undefined;
  }

  return new OpenAIProvider({ apiKey });
}
