/**
 * Google Gemini (generativelanguage.googleapis.com) API integration.
 *
 * Unlike OpenAI-compatible providers, Gemini uses its own request/response
 * schema: system messages ride in `systemInstruction`, assistant messages use
 * role `'model'`, and content is split into `parts` of `{ text }` or
 * `{ inline_data }`. Usage metadata has different field names too.
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

const log = new Log('GEMINI');

export interface GeminiConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiRequest {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
}

interface GeminiModelsResponse {
  models?: Array<{
    name: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
}

export class GeminiProvider extends BaseLLMProvider {
  readonly name = 'gemini';
  private model: string;

  private static readonly TIER_MODELS: Record<ModelTier, string> = {
    smart: 'gemini-3.1-pro',
    balanced: 'gemini-3.1-flash',
    fast: 'gemini-3.1-flash-lite',
  };

  private resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    return options?.tier ? GeminiProvider.TIER_MODELS[options.tier] : this.model;
  }

  constructor(config: GeminiConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://generativelanguage.googleapis.com',
      fetchFn: config.fetchFn,
    });
    this.model = config.model ?? 'gemini-3.1-flash';
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(
        `${this.baseUrl}/v1beta/models?key=${this.apiKey}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      );
      const data = JSON.parse(response.body) as GeminiModelsResponse;
      const models = data.models ?? [];
      return models
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({
          id: m.name.replace(/^models\//, ''),
          name: m.displayName ?? m.name,
        }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
        { id: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash' },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
      ];
    }
  }

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {},
  ): Promise<LLMCompletionResult> {
    require(this.apiKey !== undefined, 'API key is required');

    const model = this.resolveModel(options);
    const request = this.buildRequest(messages, options);

    const response = await this.fetch(
      `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      { timeout: 300000 },
    );

    const data = JSON.parse(response.body) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('No completion returned');
    }

    const text = (candidate.content?.parts ?? [])
      .map(p => p.text ?? '')
      .join('');

    return {
      content: text,
      finishReason: this.mapFinishReason(candidate.finishReason),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        cacheReadTokens: data.usageMetadata?.cachedContentTokenCount,
      },
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {},
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');

    const model = this.resolveModel(options);
    const request = this.buildRequest(messages, options);

    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${body}`);
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
        const payload = line.slice(6).trim();
        if (!payload) continue;

        try {
          const chunk = JSON.parse(payload) as GeminiStreamChunk;
          const candidate = chunk.candidates?.[0];
          const delta = candidate?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
          if (delta) {
            yield { content: delta, done: false };
          }
          if (candidate?.finishReason) {
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

  private buildRequest(messages: LLMMessage[], options: LLMCompletionOptions): GeminiRequest {
    const systemParts: Array<{ text: string }> = [];
    const contents: GeminiContent[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push({ text: getTextContent(m) });
        continue;
      }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: this.mapParts(m.content),
      });
    }

    const request: GeminiRequest = { contents };
    if (systemParts.length > 0) {
      request.systemInstruction = { parts: systemParts };
    }

    const gc: GeminiRequest['generationConfig'] = {};
    if (options.temperature !== undefined) gc.temperature = options.temperature;
    if (options.maxTokens !== undefined) gc.maxOutputTokens = options.maxTokens;
    if (options.stopSequences) gc.stopSequences = options.stopSequences;
    if (Object.keys(gc).length > 0) request.generationConfig = gc;

    return request;
  }

  private mapParts(content: string | ContentPart[]): GeminiPart[] {
    if (typeof content === 'string') return [{ text: content }];
    return content.map((part): GeminiPart => {
      if (part.type === 'text') return { text: part.text };
      return { inline_data: { mime_type: part.mediaType, data: part.data } };
    });
  }

  private mapFinishReason(reason?: string): 'stop' | 'length' | 'error' {
    if (reason === 'STOP') return 'stop';
    if (reason === 'MAX_TOKENS') return 'length';
    if (!reason) return 'stop';
    return 'error';
  }
}

export function createGeminiProvider(): GeminiProvider | undefined {
  const gt = globalThis as Record<string, unknown>;
  const apiKey = (gt.GOOGLE_API_KEY ?? gt.GEMINI_API_KEY) as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new GeminiProvider({ apiKey });
}
