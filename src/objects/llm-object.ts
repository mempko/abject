/**
 * LLM Service object - provides LLM capabilities to other objects.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import * as msg from '../core/message.js';
import {
  LLMProvider,
  FetchDelegate,
  FetchResult,
  LLMMessage,
  LLMCompletionOptions,
  LLMCompletionResult,

  systemMessage,
  userMessage,
} from '../llm/provider.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAIProvider } from '../llm/openai.js';
import { OllamaProvider } from '../llm/ollama.js';
import type { HttpRequest, HttpResponse } from './capabilities/http-client.js';

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

/**
 * The LLM object provides language model capabilities to the system.
 */
export class LLMObject extends Abject {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider?: string;
  private httpClientId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'LLM',
        description:
          'Language model service. Provides completion, code generation, and analysis capabilities.',
        version: '1.0.0',
        interfaces: [
          {
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
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.LLM_QUERY],
        tags: ['system', 'llm', 'ai'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('complete', async (msg: AbjectMessage) => {
      const { messages, options, provider } = msg.payload as LLMQueryPayload;
      return this.complete(messages, options, provider);
    });

    this.on('generateCode', async (msg: AbjectMessage) => {
      const { language, description, context } = msg.payload as LLMGenerateCodePayload;
      return this.generateCode(language, description, context);
    });

    this.on('analyze', async (msg: AbjectMessage) => {
      const { content, task } = msg.payload as LLMAnalyzePayload;
      return this.analyze(content, task);
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
      };
      this.configure(config);
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

      const timeout = options?.timeout ?? 120000;

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
        'abjects:http' as InterfaceId,
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
  configure(config: {
    anthropicApiKey?: string;
    openaiApiKey?: string;
    ollamaUrl?: string;
  }): void {
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
      this.registerProvider(
        new OllamaProvider({ baseUrl: config.ollamaUrl, fetchFn })
      );
    }
  }

  /**
   * Complete a conversation.
   */
  async complete(
    messages: LLMMessage[],
    options?: LLMCompletionOptions,
    providerName?: string
  ): Promise<LLMCompletionResult> {
    const provider = this.getProvider(providerName);
    require(provider !== undefined, 'No LLM provider available');

    return provider!.complete(messages, options);
  }

  /**
   * Generate code from a description.
   */
  async generateCode(
    language: string,
    description: string,
    context?: string
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
    ], { tier: 'smart' });

    // Extract code from markdown if present
    return this.extractCode(result.content, language);
  }

  /**
   * Analyze content.
   */
  async analyze(content: string, task: string): Promise<string> {
    const result = await this.complete([
      systemMessage(
        'You are an expert analyst. Provide clear, structured analysis.'
      ),
      userMessage(`${task}\n\nContent:\n${content}`),
    ], { tier: 'balanced' });

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
