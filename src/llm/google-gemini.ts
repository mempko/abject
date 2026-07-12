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
  LLMProviderDescription,
  LLMStreamChunk,
  ModelTier,
  ModelInfo,
  ContentPart,
  defaultIsRetryable,
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
    thinkingConfig?: { thinkingLevel?: string };
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

  // Verified ids: bare gemini-3.1-pro / -flash are not callable on v1beta;
  // -pro-preview and gemini-3.5-flash are the current accepted ids.
  private static readonly TIER_MODELS: Record<ModelTier, string> = {
    smart: 'gemini-3.1-pro-preview',
    balanced: 'gemini-3.5-flash',
    fast: 'gemini-3.1-flash-lite',
    code: 'gemini-3.1-pro-preview',
  };

  // Thinking counts against maxOutputTokens (default is only ~8192), so size it
  // generously per tier and drive depth with thinkingLevel. Pro can't disable
  // thinking; flash-lite runs near-minimal.
  private static readonly TIER_MAX_OUTPUT: Record<ModelTier, number> = {
    smart: 32768, balanced: 16384, fast: 8192, code: 32768,
  };
  private static readonly TIER_THINKING_LEVEL: Record<ModelTier, string> = {
    smart: 'high', balanced: 'medium', fast: 'minimal', code: 'high',
  };
  private static readonly MODEL_MAX_OUTPUT = 65536;

  override resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    return options?.tier ? GeminiProvider.TIER_MODELS[options.tier] : this.model;
  }

  constructor(config: GeminiConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://generativelanguage.googleapis.com',
      fetchFn: config.fetchFn,
    });
    this.model = config.model ?? 'gemini-3.5-flash';
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  /**
   * Transcription rides generateContent with an inline audio part, which is
   * JSON in and out, so the existing text-only fetch plumbing serves it.
   * Synthesis stays unsupported here: Gemini TTS returns raw PCM from a
   * preview model and would need WAV framing; revisit when it stabilizes.
   */
  override supportsSpeech(): { transcribe: boolean; synthesize: boolean } {
    return { transcribe: !!this.apiKey, synthesize: false };
  }

  async transcribe(
    audio: { base64: string; mimeType: string },
    options?: { model?: string; language?: string },
  ): Promise<{ text: string }> {
    require(this.apiKey !== undefined, 'API key is required');
    require(audio.base64.length > 0, 'audio base64 must be non-empty');
    const model = options?.model ?? GeminiProvider.TIER_MODELS.fast;
    const instruction = options?.language
      ? `Transcribe this audio exactly. The speech is in ${options.language}. Reply with only the transcript, nothing else.`
      : 'Transcribe this audio exactly. Reply with only the transcript, nothing else.';

    return this.withRetries(async () => {
      const response = await this.fetch(
        `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: instruction },
                { inline_data: { mime_type: audio.mimeType, data: audio.base64 } },
              ],
            }],
          }),
        },
        { timeout: 120000 },
      );

      const data = JSON.parse(response.body) as GeminiResponse;
      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new Error('No transcription returned');
      }
      const text = (candidate.content?.parts ?? []).map(p => p.text ?? '').join('').trim();
      return { text };
    }, { label: 'gemini.transcribe' });
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
          // Every current Gemini generateContent model is multimodal
          vision: true,
        }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', vision: true },
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', vision: true },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', vision: true },
      ];
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'gemini',
      label: 'Gemini',
      storageSuffix: 'geminiApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'Google Gemini API Key',
      credentialPlaceholder: 'AIza...',
      models: [
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', vision: true },
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', vision: true },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', vision: true },
      ],
      defaultTierModels: GeminiProvider.TIER_MODELS,
    };
  }

  async complete(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {},
  ): Promise<LLMCompletionResult> {
    require(this.apiKey !== undefined, 'API key is required');

    const model = this.resolveModel(options);
    const request = this.buildRequest(messages, options);

    return this.withRetries(async () => {
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
    }, { label: 'gemini.complete' });
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {},
  ): AsyncIterable<LLMStreamChunk> {
    require(this.apiKey !== undefined, 'API key is required');

    const model = this.resolveModel(options);
    const request = this.buildRequest(messages, options);

    const maxAttempts = 3;
    const initialDelayMs = 1000;
    const backoffFactor = 2;
    const maxDelayMs = 10000;
    let yielded = false;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        for await (const chunk of this.streamOnce(model, request)) {
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
        console.warn(`[gemini.stream] attempt ${attempt}/${maxAttempts} failed: ${msg.slice(0, 200)} — retrying in ${delay}ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  private async *streamOnce(model: string, request: GeminiRequest): AsyncIterable<LLMStreamChunk> {
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
    if (options.stopSequences) gc.stopSequences = options.stopSequences;
    const tier = options.tier;
    if (tier) {
      gc.maxOutputTokens = Math.min(
        GeminiProvider.MODEL_MAX_OUTPUT,
        Math.max(GeminiProvider.TIER_MAX_OUTPUT[tier], options.maxTokens ?? 0),
      );
      gc.thinkingConfig = { thinkingLevel: GeminiProvider.TIER_THINKING_LEVEL[tier] };
    } else if (options.maxTokens !== undefined) {
      gc.maxOutputTokens = options.maxTokens;
    }
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
