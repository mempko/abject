/**
 * Ollama local LLM integration.
 */

import * as http from 'node:http';
import {
  BaseLLMProvider,
  FetchDelegate,
  LLMMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMStreamChunk,
  ModelTier,
  ContentPart,
  ImagePart,
  getTextContent,
} from './provider.js';
import { Log } from '../core/timed-log.js';

const log = new Log('OLLAMA');

export interface OllamaConfig {
  model?: string;
  tierModels?: Partial<Record<ModelTier, string>>;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
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
  private model: string | undefined;
  private tierModels: Partial<Record<ModelTier, string>> = {};

  private resolveModel(tier?: ModelTier): string {
    if (tier && this.tierModels[tier]) return this.tierModels[tier]!;
    if (this.tierModels.balanced) return this.tierModels.balanced;
    if (this.model) return this.model;
    throw new Error('No Ollama model configured. Run autoDetectModel() or setModel().');
  }

  constructor(config: OllamaConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? 'http://localhost:11434',
      fetchFn: config.fetchFn,
    });
    this.model = config.model;
    this.tierModels = config.tierModels ?? {};
  }

  /**
   * Auto-detect: pick the first available model from Ollama if none configured.
   */
  async autoDetectModel(): Promise<string | undefined> {
    if (this.model || Object.keys(this.tierModels).length > 0) return this.model;
    const models = await this.listModels();
    if (models.length > 0) {
      this.model = models[0];
      log.info(`Auto-detected model: ${this.model}`);
    }
    return this.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
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
    // Use Node.js http.request directly to bypass undici's headersTimeout (300s)
    // and bodyTimeout (300s) which silently kill long-running Ollama requests.
    // Ollama is always localhost so we don't need TLS or fancy HTTP features.
    const req: OllamaRequest = {
      model: this.resolveModel(options.tier),
      messages: messages.map((m) => this.mapMessage(m)),
      stream: true,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        stop: options.stopSequences,
      },
    };

    const url = new URL(`${this.baseUrl}/api/chat`);
    const body = JSON.stringify(req);

    return new Promise<LLMCompletionResult>((resolve, reject) => {
      const httpReq = http.request(
        {
          hostname: url.hostname,
          port: url.port || 11434,
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 1800000, // 30 minutes socket timeout
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
            res.on('end', () => reject(new Error(`Ollama API error (${res.statusCode}): ${errBody}`)));
            return;
          }

          let buffer = '';
          let content = '';
          let lastData: OllamaResponse | undefined;

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line) as OllamaResponse;
                content += data.message?.content ?? '';
                if (data.done) lastData = data;
              } catch { /* ignore parse errors */ }
            }
          });

          res.on('end', () => {
            resolve({
              content,
              finishReason: lastData?.done ? 'stop' : 'length',
              usage: {
                inputTokens: lastData?.prompt_eval_count ?? 0,
                outputTokens: lastData?.eval_count ?? 0,
              },
            });
          });

          res.on('error', (err) => reject(new Error(`Ollama response error: ${err.message}`)));
        },
      );

      httpReq.on('error', (err) => reject(new Error(`Ollama request error: ${err.message}`)));
      httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Ollama request timed out (30min)')); });
      httpReq.write(body);
      httpReq.end();
    });
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    const req: OllamaRequest = {
      model: this.resolveModel(options.tier),
      messages: messages.map((m) => this.mapMessage(m)),
      stream: true,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        stop: options.stopSequences,
      },
    };

    const url = new URL(`${this.baseUrl}/api/chat`);
    const body = JSON.stringify(req);

    // Use an async iterator backed by http.request to avoid undici timeout issues
    const chunks: LLMStreamChunk[] = [];
    let streamResolve: (() => void) | undefined;
    let streamReject: ((err: Error) => void) | undefined;
    let streamDone = false;
    let streamError: Error | undefined;

    const waitForData = () => new Promise<void>((resolve, reject) => {
      if (streamError) { reject(streamError); return; }
      if (chunks.length > 0 || streamDone) { resolve(); return; }
      streamResolve = resolve;
      streamReject = reject;
    });

    const notify = () => { if (streamResolve) { const r = streamResolve; streamResolve = undefined; streamReject = undefined; r(); } };
    const fail = (err: Error) => { streamError = err; if (streamReject) { const r = streamReject; streamResolve = undefined; streamReject = undefined; r(err); } };

    const httpReq = http.request(
      {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 1800000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
          res.on('end', () => fail(new Error(`Ollama API error: ${res.statusCode} ${errBody}`)));
          return;
        }

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line) as OllamaResponse;
              chunks.push({ content: data.message?.content ?? '', done: data.done });
            } catch { /* ignore */ }
          }
          notify();
        });
        res.on('end', () => { streamDone = true; notify(); });
        res.on('error', (err) => fail(new Error(`Ollama stream error: ${err.message}`)));
      },
    );

    httpReq.on('error', (err) => fail(new Error(`Ollama request error: ${err.message}`)));
    httpReq.on('timeout', () => { httpReq.destroy(); fail(new Error('Ollama stream timed out (30min)')); });
    httpReq.write(body);
    httpReq.end();

    while (true) {
      await waitForData();
      while (chunks.length > 0) {
        const chunk = chunks.shift()!;
        yield chunk;
        if (chunk.done) return;
      }
      if (streamDone) {
        yield { content: '', done: true };
        return;
      }
    }
  }

  /**
   * Map LLMMessage to Ollama format.
   * Ollama vision models (llava) use a separate `images` field for base64 data.
   */
  private mapMessage(msg: LLMMessage): OllamaMessage {
    if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
    const text = getTextContent(msg);
    const images = (msg.content.filter((p): p is ImagePart => p.type === 'image')).map(p => p.data);
    const result: OllamaMessage = { role: msg.role, content: text };
    if (images.length > 0) result.images = images;
    return result;
  }

  /**
   * List available models.
   * Uses native fetch directly since Ollama is always a local service
   * and the HttpClient delegate blocks localhost for SSRF protection.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return [];

      const data = await response.json() as {
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

  setTierModel(tier: ModelTier, model: string): void {
    this.tierModels[tier] = model;
  }

  setTierModels(models: Partial<Record<ModelTier, string>>): void {
    this.tierModels = { ...models };
  }

  getTierModels(): Partial<Record<ModelTier, string>> {
    return { ...this.tierModels };
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

  log.warn('Local Ollama not available');
  return undefined;
}
