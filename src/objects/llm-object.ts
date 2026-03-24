/**
 * LLM Service object - provides LLM capabilities to other objects.
 */

import { AbjectId, AbjectMessage } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { Capabilities } from '../core/capability.js';
import * as msg from '../core/message.js';
import { event } from '../core/message.js';
import {
  LLMProvider,
  FetchDelegate,
  FetchResult,
  LLMMessage,
  LLMCompletionOptions,
  LLMCompletionResult,
  getTextContent,

  systemMessage,
  userMessage,
} from '../llm/provider.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAIProvider } from '../llm/openai.js';
import { OllamaProvider } from '../llm/ollama.js';
import type { HttpRequest, HttpResponse } from './capabilities/http-client.js';

const log = new Log('LLM');

const LLM_INTERFACE = 'abjects:llm';

export interface LLMQueryPayload {
  messages: LLMMessage[];
  options?: LLMCompletionOptions;
  provider?: string;
}

export interface LLMGenerateCodePayload {
  language: string;
  description: string;
  context?: string;
}

export interface LLMAnalyzePayload {
  content: string;
  task: string;
}

export interface LLMActiveRequest {
  id: string;
  callerId: AbjectId;
  callerName?: string;
  method: string;
  provider: string;
  startTime: number;
  inputChars: number;
  outputChars: number;
  streaming: boolean;
  killed: boolean;
  inputMessages?: string;
}

export interface LLMHistoryEntry {
  id: string;
  callerId: AbjectId;
  callerName?: string;
  method: string;
  provider: string;
  startTime: number;
  elapsedMs: number;
  inputChars: number;
  outputChars: number;
  inputMessages: string;
  outputContent: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMStats {
  totalRequests: number;
  totalInputChars: number;
  totalOutputChars: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalErrors: number;
  totalLatencyMs: number;
}

/**
 * The LLM object provides language model capabilities to the system.
 */
export class LLMObject extends Abject {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider?: string;
  private httpClientId?: AbjectId;

  // Stats and request tracking
  private _activeRequests: Map<string, LLMActiveRequest> = new Map();
  private _stats: LLMStats = {
    totalRequests: 0,
    totalInputChars: 0,
    totalOutputChars: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
  };
  private _paused = false;
  private _history: LLMHistoryEntry[] = [];
  private readonly _MAX_HISTORY = 50;
  private readonly _MAX_CONTENT_CHARS = 10_000;

  constructor() {
    super({
      manifest: {
        name: 'LLM',
        description:
          'Language model service. Provides completion, code generation, and analysis capabilities. Use cases: generate text completions, analyze or summarize text, generate code from natural language.',
        version: '1.0.0',
        interface: {
            id: LLM_INTERFACE,
            name: 'LLM',
            description: 'Language model operations',
            methods: [
              {
                name: 'complete',
                description: 'Complete a conversation',
                parameters: [
                  {
                    name: 'messages',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'LLMMessage' },
                    },
                    description: 'Conversation messages',
                  },
                  {
                    name: 'options',
                    type: { kind: 'reference', reference: 'LLMCompletionOptions' },
                    description: 'Completion options',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'LLMCompletionResult' },
              },
              {
                name: 'generateCode',
                description: 'Generate code from description',
                parameters: [
                  {
                    name: 'language',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Programming language',
                  },
                  {
                    name: 'description',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What the code should do',
                  },
                  {
                    name: 'context',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Additional context (e.g., existing code)',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'analyze',
                description: 'Analyze content',
                parameters: [
                  {
                    name: 'content',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Content to analyze',
                  },
                  {
                    name: 'task',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Analysis task',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'stream',
                description: 'Stream a conversation completion. Sends llmChunk events for each token, returns full accumulated content.',
                parameters: [
                  {
                    name: 'messages',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'LLMMessage' },
                    },
                    description: 'Conversation messages',
                  },
                  {
                    name: 'options',
                    type: { kind: 'reference', reference: 'LLMCompletionOptions' },
                    description: 'Completion options',
                    optional: true,
                  },
                ],
                returns: { kind: 'object', properties: {
                  content: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'listProviders',
                description: 'List available LLM providers',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'primitive', primitive: 'string' },
                },
              },
              {
                name: 'setProvider',
                description: 'Set the default provider',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Provider name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getStats',
                description: 'Get LLM stats, active requests, and paused state',
                parameters: [],
                returns: { kind: 'object', properties: {
                  stats: { kind: 'reference', reference: 'LLMStats' },
                  activeRequests: { kind: 'array', elementType: { kind: 'reference', reference: 'LLMActiveRequest' } },
                  paused: { kind: 'primitive', primitive: 'boolean' },
                }},
              },
              {
                name: 'killRequest',
                description: 'Kill an active LLM request',
                parameters: [
                  { name: 'requestId', type: { kind: 'primitive', primitive: 'string' }, description: 'The request ID to kill' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'pause',
                description: 'Pause the LLM object, rejecting new requests',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unpause',
                description: 'Unpause the LLM object, accepting requests again',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getRequestDetail',
                description: 'Get the full detail of a request including prompt and output',
                parameters: [
                  { name: 'requestId', type: { kind: 'primitive', primitive: 'string' }, description: 'The request ID' },
                ],
                returns: { kind: 'reference', reference: 'LLMHistoryEntry' },
              },
            ],
            events: [
              { name: 'requestStarted', description: 'Emitted when a new LLM request begins', payload: { kind: 'reference', reference: 'LLMActiveRequest' } },
              { name: 'requestCompleted', description: 'Emitted when an LLM request finishes', payload: { kind: 'object', properties: {} } },
              { name: 'requestError', description: 'Emitted when an LLM request fails', payload: { kind: 'object', properties: {} } },
              { name: 'requestProgress', description: 'Emitted periodically during streaming with output progress', payload: { kind: 'object', properties: {} } },
              { name: 'paused', description: 'Emitted when the LLM is paused', payload: { kind: 'primitive', primitive: 'boolean' } },
              { name: 'unpaused', description: 'Emitted when the LLM is unpaused', payload: { kind: 'primitive', primitive: 'boolean' } },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.LLM_QUERY],
        tags: ['system', 'llm', 'ai'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('complete', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { messages, options, provider } = m.payload as LLMQueryPayload;
      return this.complete(messages, options, provider, m.routing.from, m.header.messageId);
    });

    this.on('generateCode', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { language, description, context } = m.payload as LLMGenerateCodePayload;
      return this.generateCode(language, description, context, m.routing.from, m.header.messageId);
    });

    this.on('analyze', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { content, task } = m.payload as LLMAnalyzePayload;
      return this.analyze(content, task, m.routing.from, m.header.messageId);
    });

    this.on('stream', async (m: AbjectMessage) => {
      require(!this._paused, 'LLM is paused');
      const { messages, options, provider: providerName } = m.payload as LLMQueryPayload;
      const provider = this.getProvider(providerName);
      require(provider !== undefined, 'No LLM provider available');

      const callerId = m.routing.from;
      const correlationId = m.header.messageId;

      // If provider doesn't support streaming, fall back to complete
      if (!provider!.stream) {
        const result = await this.complete(messages, options, providerName, callerId, correlationId);
        return { content: result.content };
      }

      const totalChars = messages.reduce((sum, m2) => sum + getTextContent(m2).length, 0);
      log.info(`→ ${provider!.name} stream | ${messages.length} msgs | ${totalChars} chars`);
      const start = Date.now();

      const activeReq = await this.trackRequestStart(
        correlationId, callerId, 'stream', provider!.name, totalChars, true, messages,
      );

      let fullContent = '';
      try {
        for await (const chunk of provider!.stream(messages, options)) {
          if (activeReq.killed) {
            log.info(`Request ${correlationId} killed during streaming`);
            break;
          }
          fullContent += chunk.content;
          activeReq.outputChars = fullContent.length;
          // Send each chunk as an event back to the requester
          this.send(event(this.id, callerId, 'llmChunk', {
            correlationId,
            content: chunk.content,
            done: chunk.done,
          }));
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`${provider!.name} stream | ${elapsed}ms | ${errMsg}`);
        this.trackRequestError(correlationId, errMsg);
        throw err;
      }

      const elapsed = Date.now() - start;
      log.info(`← ${provider!.name} stream | ${fullContent.length} chars | ${elapsed}ms`);
      this.trackRequestEnd(correlationId, fullContent);
      return { content: fullContent };
    });

    this.on('listProviders', async () => {
      return this.listProviders();
    });

    this.on('setProvider', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.setDefaultProvider(name);
    });

    this.on('configure', async (msg: AbjectMessage) => {
      const config = msg.payload as {
        anthropicApiKey?: string;
        openaiApiKey?: string;
        ollamaUrl?: string;
        ollamaModel?: string;
        ollamaTierModels?: Partial<Record<string, string>>;
      };
      await this.configure(config);
      return true;
    });

    this.on('listOllamaModels', async (m: AbjectMessage) => {
      const { baseUrl } = (m.payload ?? {}) as { baseUrl?: string };
      // Use existing provider or create a temporary one for listing.
      // Ollama uses native fetch (local service), no need for fetchFn delegate.
      let provider = this.providers.get('ollama') as OllamaProvider | undefined;
      if (!provider) {
        provider = new OllamaProvider({ baseUrl: baseUrl ?? 'http://localhost:11434' });
      }
      return provider.listModels();
    });

    this.on('setOllamaModel', async (msg: AbjectMessage) => {
      const { model } = msg.payload as { model: string };
      const provider = this.providers.get('ollama') as OllamaProvider | undefined;
      if (!provider) return false;
      provider.setModel(model);
      log.info(`Ollama model set to: ${model}`);
      return true;
    });

    this.on('setOllamaTierModels', async (msg: AbjectMessage) => {
      const { tierModels } = msg.payload as { tierModels: Partial<Record<string, string>> };
      const provider = this.providers.get('ollama') as OllamaProvider | undefined;
      if (!provider) return false;
      provider.setTierModels(tierModels as Partial<Record<import('../llm/provider.js').ModelTier, string>>);
      log.info(`Ollama tier models set: ${JSON.stringify(tierModels)}`);
      return true;
    });

    this.on('getStats', async () => {
      return {
        stats: { ...this._stats },
        activeRequests: Array.from(this._activeRequests.values()),
        history: this._history,
        paused: this._paused,
      };
    });

    this.on('getRequestDetail', async (m: AbjectMessage) => {
      const { requestId } = m.payload as { requestId: string };
      // Check history first (most common case)
      const entry = this._history.find(h => h.id === requestId);
      if (entry) return entry;
      // Check active requests (no output content yet)
      const active = this._activeRequests.get(requestId);
      if (active) {
        return {
          id: active.id,
          callerId: active.callerId,
          callerName: active.callerName,
          method: active.method,
          provider: active.provider,
          startTime: active.startTime,
          elapsedMs: Date.now() - active.startTime,
          inputChars: active.inputChars,
          outputChars: active.outputChars,
          inputMessages: active.inputMessages ?? '',
          outputContent: '(still in progress)',
        } as LLMHistoryEntry;
      }
      return null;
    });

    this.on('killRequest', async (m: AbjectMessage) => {
      const { requestId } = m.payload as { requestId: string };
      const req = this._activeRequests.get(requestId);
      if (!req) return false;
      req.killed = true;
      log.info(`Kill requested for ${requestId}`);
      return true;
    });

    this.on('pause', async () => {
      this._paused = true;
      log.info('LLM paused');
      this.changed('paused', true);
      return true;
    });

    this.on('unpause', async () => {
      this._paused = false;
      log.info('LLM unpaused');
      this.changed('unpaused', true);
      return true;
    });

  }

  /**
   * Register an LLM provider.
   */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
  }

  /**
   * Create a FetchDelegate that routes HTTP requests through the HttpClient abject.
   */
  private createFetchDelegate(): FetchDelegate {
    const self = this;
    return async (url: string, init: RequestInit, options?: { timeout?: number }): Promise<FetchResult> => {
      require(self.httpClientId !== undefined, 'httpClientId not set');

      const timeout = options?.timeout ?? 300000;

      // Resolve relative URLs (e.g. /api/anthropic/v1/messages) to absolute
      const resolvedUrl = url.startsWith('/') && typeof window !== 'undefined'
        ? new URL(url, window.location.origin).href
        : url;

      const httpRequest: HttpRequest = {
        method: (init.method as HttpRequest['method']) ?? 'GET',
        url: resolvedUrl,
        headers: init.headers as Record<string, string> | undefined,
        body: init.body as string | undefined,
        timeout,
      };

      const requestMsg = msg.request(
        self.id,
        self.httpClientId!,
        'request',
        httpRequest
      );

      const response = await self.request<HttpResponse>(requestMsg, timeout + 5000);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        ok: response.ok,
      };
    };
  }

  /**
   * Configure from API keys.
   */
  async configure(config: {
    anthropicApiKey?: string;
    openaiApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    ollamaTierModels?: Partial<Record<string, string>>;
  }): Promise<void> {
    const fetchFn = this.httpClientId ? this.createFetchDelegate() : undefined;

    if (config.anthropicApiKey) {
      this.registerProvider(
        new AnthropicProvider({ apiKey: config.anthropicApiKey, fetchFn })
      );
    }

    if (config.openaiApiKey) {
      this.registerProvider(
        new OpenAIProvider({ apiKey: config.openaiApiKey, fetchFn })
      );
    }

    if (config.ollamaUrl) {
      // Ollama uses native fetch (local service), no need for fetchFn delegate
      const provider = new OllamaProvider({
        baseUrl: config.ollamaUrl,
        model: config.ollamaModel,
        tierModels: config.ollamaTierModels as Partial<Record<import('../llm/provider.js').ModelTier, string>> | undefined,
      });
      // Auto-detect model only if neither single model nor tier models specified
      if (!config.ollamaModel && !config.ollamaTierModels) {
        await provider.autoDetectModel();
      }
      this.registerProvider(provider);
    }
  }

  /**
   * Complete a conversation.
   */
  async complete(
    messages: LLMMessage[],
    options?: LLMCompletionOptions,
    providerName?: string,
    callerId?: AbjectId,
    requestId?: string,
  ): Promise<LLMCompletionResult> {
    const provider = this.getProvider(providerName);
    require(provider !== undefined, 'No LLM provider available');

    const totalChars = messages.reduce((sum, m2) => sum + getTextContent(m2).length, 0);
    log.info(`→ ${provider!.name} | ${messages.length} msgs | ${totalChars} chars | tier=${options?.tier ?? 'default'} maxTokens=${options?.maxTokens ?? 'default'}`);
    const start = Date.now();

    // Track active request
    const trackId = requestId ?? `internal-${Date.now()}`;
    if (callerId) {
      await this.trackRequestStart(trackId, callerId, 'complete', provider!.name, totalChars, false, messages);
    }

    // Send keep-alive progress events every 30s so upstream timeouts don't fire
    const KEEPALIVE_MS = 30000;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    if (callerId) {
      keepaliveTimer = setInterval(() => {
        this.send(
          event(this.id, callerId, 'progress', {
            phase: 'llm-waiting',
            message: `LLM request in progress (${Math.round((Date.now() - start) / 1000)}s)`,
          })
        );
      }, KEEPALIVE_MS);
    }

    try {
      const result = await provider!.complete(messages, options);
      const elapsed = Date.now() - start;
      log.info(`← ${provider!.name} | ${result.content.length} chars | ${elapsed}ms | reason=${result.finishReason} | tokens=${result.usage?.inputTokens ?? '?'}in/${result.usage?.outputTokens ?? '?'}out`);
      if (callerId) this.trackRequestEnd(trackId, result.content, result.usage);
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`${provider!.name} | ${elapsed}ms | ${errMsg}`);
      if (callerId) this.trackRequestError(trackId, errMsg);
      throw err;
    } finally {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    }
  }

  /**
   * Generate code from a description.
   */
  async generateCode(
    language: string,
    description: string,
    context?: string,
    callerId?: AbjectId,
    requestId?: string,
  ): Promise<string> {
    const systemPrompt = `You are a code generator. Generate clean, well-documented ${language} code.
Only output the code, no explanations. Use proper formatting and comments.`;

    let userPrompt = `Generate ${language} code that: ${description}`;
    if (context) {
      userPrompt += `\n\nContext:\n${context}`;
    }

    const result = await this.complete([
      systemMessage(systemPrompt),
      userMessage(userPrompt),
    ], { tier: 'smart' }, undefined, callerId, requestId);

    // Extract code from markdown if present
    return this.extractCode(result.content, language);
  }

  /**
   * Analyze content.
   */
  async analyze(
    content: string,
    task: string,
    callerId?: AbjectId,
    requestId?: string,
  ): Promise<string> {
    const result = await this.complete([
      systemMessage(
        'You are an expert analyst. Provide clear, structured analysis.'
      ),
      userMessage(`${task}\n\nContent:\n${content}`),
    ], { tier: 'balanced' }, undefined, callerId, requestId);

    return result.content;
  }

  /**
   * List available providers.
   */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Set the default provider.
   */
  setDefaultProvider(name: string): boolean {
    if (!this.providers.has(name)) {
      return false;
    }
    this.defaultProvider = name;
    return true;
  }

  /**
   * Resolve an AbjectId to a human-readable name by asking the caller directly.
   * Every Abject has a built-in 'describe' handler that returns its manifest.
   */
  private async resolveCallerName(callerId: AbjectId): Promise<string | undefined> {
    try {
      const result = await this.request<{ manifest: { name: string } }>(
        msg.request(this.id, callerId, 'describe', {}),
        5000,
      );
      return result?.manifest?.name;
    } catch {
      return undefined;
    }
  }

  /**
   * Begin tracking an active request.
   */
  private truncate(s: string): string {
    if (s.length <= this._MAX_CONTENT_CHARS) return s;
    return s.slice(0, this._MAX_CONTENT_CHARS) + '\n...(truncated)';
  }

  private serializeMessages(messages: LLMMessage[]): string {
    return this.truncate(
      messages.map(m => `[${m.role}]: ${getTextContent(m)}`).join('\n\n')
    );
  }

  private async trackRequestStart(
    requestId: string,
    callerId: AbjectId,
    method: string,
    providerName: string,
    inputChars: number,
    streaming: boolean,
    messages?: LLMMessage[],
  ): Promise<LLMActiveRequest> {
    const callerName = await this.resolveCallerName(callerId);
    const activeReq: LLMActiveRequest = {
      id: requestId,
      callerId,
      callerName,
      method,
      provider: providerName,
      startTime: Date.now(),
      inputChars,
      outputChars: 0,
      streaming,
      killed: false,
      inputMessages: messages ? this.serializeMessages(messages) : undefined,
    };
    this._activeRequests.set(requestId, activeReq);
    this._stats.totalRequests++;
    this.changed('requestStarted', { ...activeReq });
    return activeReq;
  }

  /**
   * Record completion of a tracked request and save to history.
   */
  private trackRequestEnd(
    requestId: string,
    outputContent: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    const req = this._activeRequests.get(requestId);
    if (!req) return;
    const elapsed = Date.now() - req.startTime;
    const outChars = outputContent.length;
    this._stats.totalLatencyMs += elapsed;
    this._stats.totalInputChars += req.inputChars;
    this._stats.totalOutputChars += outChars;
    if (usage) {
      this._stats.totalInputTokens += usage.inputTokens;
      this._stats.totalOutputTokens += usage.outputTokens;
    }
    // Save to history before deleting
    this._history.push({
      id: req.id,
      callerId: req.callerId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      startTime: req.startTime,
      elapsedMs: elapsed,
      inputChars: req.inputChars,
      outputChars: outChars,
      inputMessages: req.inputMessages ?? '',
      outputContent: this.truncate(outputContent),
      usage,
    });
    if (this._history.length > this._MAX_HISTORY) {
      this._history.shift();
    }
    this._activeRequests.delete(requestId);
    this.changed('requestCompleted', {
      id: requestId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      elapsedMs: elapsed,
      inputChars: req.inputChars,
      outputChars: outChars,
      usage,
    });
  }

  /**
   * Record an error on a tracked request and save to history.
   */
  private trackRequestError(requestId: string, error: string): void {
    const req = this._activeRequests.get(requestId);
    if (!req) return;
    const elapsed = Date.now() - req.startTime;
    this._stats.totalErrors++;
    this._stats.totalLatencyMs += elapsed;
    // Save error to history
    this._history.push({
      id: req.id,
      callerId: req.callerId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      startTime: req.startTime,
      elapsedMs: elapsed,
      inputChars: req.inputChars,
      outputChars: 0,
      inputMessages: req.inputMessages ?? '',
      outputContent: '',
      error,
    });
    if (this._history.length > this._MAX_HISTORY) {
      this._history.shift();
    }
    this._activeRequests.delete(requestId);
    this.changed('requestError', {
      id: requestId,
      callerName: req.callerName,
      method: req.method,
      provider: req.provider,
      elapsedMs: elapsed,
      error,
    });
  }

  /**
   * Get a provider by name or the default.
   */
  private getProvider(name?: string): LLMProvider | undefined {
    if (name) {
      return this.providers.get(name);
    }
    if (this.defaultProvider) {
      return this.providers.get(this.defaultProvider);
    }
    // Return first available
    return this.providers.values().next().value;
  }

  /**
   * Extract code from markdown-formatted response.
   */
  private extractCode(content: string, language: string): string {
    // Look for code blocks
    const codeBlockRegex = new RegExp(
      '```(?:' + language + ')?\\s*\\n([\\s\\S]*?)\\n```',
      'i'
    );
    const match = content.match(codeBlockRegex);

    if (match) {
      return match[1].trim();
    }

    // No code block, return as-is
    return content.trim();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## LLM Usage Guide

### Basic Completion (chat-style)

  const result = await this.call(
    this.dep('LLM'), 'complete',
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Summarize this text: ...' }
      ],
      options: { tier: 'balanced' }
    });
  // result: { content: string, finishReason: 'stop'|'length'|'error',
  //           usage?: { inputTokens: number, outputTokens: number } }

### Code Generation Shorthand

  const code = await this.call(
    this.dep('LLM'), 'generateCode',
    { language: 'typescript', description: 'sort an array of numbers', context: 'optional existing code' });
  // Returns the generated code as a plain string

### Content Analysis Shorthand

  const analysis = await this.call(
    this.dep('LLM'), 'analyze',
    { content: 'some text to analyze', task: 'identify the main themes' });
  // Returns the analysis as a plain string

### Completion Options

The \`options\` object in \`complete\` accepts:
- tier: 'smart' | 'balanced' | 'fast' — model quality tier (default: 'balanced')
- temperature: number — controls randomness (0-1)
- maxTokens: number — limit response length
- stopSequences: string[] — stop generation at these strings

### Provider Management

  const providers = await this.call(this.dep('LLM'), 'listProviders', {});
  // providers: [{ name: 'anthropic', available: true }, { name: 'openai', available: false }, ...]

  await this.call(this.dep('LLM'), 'setProvider', { name: 'ollama' });
  // Switch the active/default provider

  await this.call(this.dep('LLM'), 'configure', {
    anthropicApiKey: '...', openaiApiKey: '...', ollamaUrl: 'http://localhost:11434'
  });
  // Configure provider settings (all fields optional)

### IMPORTANT
- The interface ID is 'abjects:llm' (NOT 'abjects:llm-object').
- Message roles MUST be 'system', 'user', or 'assistant' — no other values.
- The messages array must contain at least one message.
- generateCode returns only the code string, not a completion result object.
- analyze returns only the analysis string, not a completion result object.`;
  }

  /**
   * Check if any provider is available.
   */
  async isAvailable(): Promise<boolean> {
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        return true;
      }
    }
    return false;
  }
}

// Well-known LLM object ID
export const LLM_OBJECT_ID = 'abjects:llm' as AbjectId;
