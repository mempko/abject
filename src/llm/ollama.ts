/**
 * Ollama local LLM integration.
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

export interface OllamaConfig {
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    stop?: string[];
  };
}

interface OllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama local LLM provider.
 */
export class OllamaProvider extends BaseLLMProvider {
  readonly name = 'ollama';
  private model: string;

  private resolveModel(_tier?: ModelTier): string {
    return this.model;  // Ollama: single local model for all tiers
  }

  constructor(config: OllamaConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? 'http://localhost:11434',
      fetchFn: config.fetchFn,
    });
    this.model = config.model ?? 'llama3.2';
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (this.fetchFn) {
        const result = await this.fetchFn(
          `${this.baseUrl}/api/tags`,
          { method: 'GET' },
          { timeout: 5000 }
        );
        return result.ok;
      }
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    const request: OllamaRequest = {
      model: this.resolveModel(options.tier),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        stop: options.stopSequences,
      },
    };

    const response = await this.fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(request),
    }, { timeout: 300000 });

    const data = JSON.parse(response.body) as OllamaResponse;

    return {
      content: data.message.content,
      finishReason: data.done ? 'stop' : 'length',
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    require(!this.fetchFn, 'Streaming is not supported when using HttpClient delegate');

    const request: OllamaRequest = {
      model: this.resolveModel(options.tier),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        stop: options.stopSequences,
      },
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
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

      // Ollama sends newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line) as OllamaResponse;

          yield {
            content: data.message?.content ?? '',
            done: data.done,
          };

          if (data.done) {
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
   * List available models.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      const data = JSON.parse(response.body) as {
        models: { name: string }[];
      };

      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Set the model to use.
   */
  setModel(model: string): void {
    this.model = model;
  }
}

/**
 * Create an Ollama provider with auto-detection.
 */
export async function createOllamaProvider(): Promise<OllamaProvider | undefined> {
  const provider = new OllamaProvider();

  if (await provider.isAvailable()) {
    return provider;
  }

  console.warn('[OLLAMA] Local Ollama not available');
  return undefined;
}
