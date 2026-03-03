/**
 * LLM provider interface - provider-agnostic abstraction.
 */

import { require, requireNonEmpty } from '../core/contracts.js';

export interface TextPart { type: 'text'; text: string; }
export interface ImagePart { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string; }
export type ContentPart = TextPart | ImagePart;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export type ModelTier = 'smart' | 'balanced' | 'fast';

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  stream?: boolean;
  tier?: ModelTier;
}

export interface LLMCompletionResult {
  content: string;
  finishReason: 'stop' | 'length' | 'error';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
}

export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
}

export type FetchDelegate = (
  url: string,
  init: RequestInit,
  options?: { timeout?: number }
) => Promise<FetchResult>;

/**
 * Abstract LLM provider interface.
 */
export interface LLMProvider {
  /**
   * Provider name for identification.
   */
  readonly name: string;

  /**
   * Check if the provider is available and configured.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Complete a conversation.
   */
  complete(
    messages: LLMMessage[],
    options?: LLMCompletionOptions
  ): Promise<LLMCompletionResult>;

  /**
   * Stream a completion (optional).
   */
  stream?(
    messages: LLMMessage[],
    options?: LLMCompletionOptions
  ): AsyncIterable<LLMStreamChunk>;
}

/**
 * Base class for LLM providers with common functionality.
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;
  protected apiKey?: string;
  protected baseUrl?: string;
  protected fetchFn?: FetchDelegate;

  constructor(config: { apiKey?: string; baseUrl?: string; fetchFn?: FetchDelegate } = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.fetchFn = config.fetchFn;
  }

  abstract isAvailable(): Promise<boolean>;
  abstract complete(
    messages: LLMMessage[],
    options?: LLMCompletionOptions
  ): Promise<LLMCompletionResult>;

  /**
   * Make an HTTP request to the API.
   * Returns FetchResult. Uses fetchFn delegate when available, falls back to native fetch.
   */
  protected async fetch(
    url: string,
    options: RequestInit,
    fetchOptions?: { timeout?: number }
  ): Promise<FetchResult> {
    if (this.fetchFn) {
      const result = await this.fetchFn(url, options, fetchOptions);
      if (!result.ok) {
        throw new Error(`LLM API error (${result.status}): ${result.body}`);
      }
      return result;
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`LLM API error (${response.status}): ${errorText}`);
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const body = await response.text();

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      ok: response.ok,
    };
  }

  /**
   * Build headers for API requests.
   */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }
}

/**
 * LLM provider registry.
 */
export class LLMProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider?: string;

  /**
   * Register a provider.
   */
  register(provider: LLMProvider): void {
    requireNonEmpty(provider.name, 'provider.name');
    this.providers.set(provider.name, provider);

    // First provider becomes default
    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
  }

  /**
   * Get a provider by name.
   */
  get(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get the default provider.
   */
  getDefault(): LLMProvider | undefined {
    if (!this.defaultProvider) {
      return undefined;
    }
    return this.providers.get(this.defaultProvider);
  }

  /**
   * Set the default provider.
   */
  setDefault(name: string): void {
    require(this.providers.has(name), `Provider '${name}' not registered`);
    this.defaultProvider = name;
  }

  /**
   * Get all provider names.
   */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Find an available provider.
   */
  async findAvailable(): Promise<LLMProvider | undefined> {
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        return provider;
      }
    }
    return undefined;
  }
}

// Global provider registry
const globalRegistry = new LLMProviderRegistry();

export function getProviderRegistry(): LLMProviderRegistry {
  return globalRegistry;
}

/**
 * Extract the text content from an LLMMessage (ignoring image parts).
 */
export function getTextContent(msg: LLMMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('');
}

/**
 * Create a user message with text and images.
 */
export function userMessageWithImages(text: string, images: Array<{ mediaType: ImagePart['mediaType']; data: string }>): LLMMessage {
  const parts: ContentPart[] = [{ type: 'text', text }];
  for (const img of images) parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
  return { role: 'user', content: parts };
}

/**
 * Helper to format messages for display/debugging.
 */
export function formatMessages(messages: LLMMessage[]): string {
  return messages
    .map((m) => {
      const text = getTextContent(m);
      return `[${m.role}] ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`;
    })
    .join('\n');
}

/**
 * Create a system message.
 */
export function systemMessage(content: string): LLMMessage {
  return { role: 'system', content };
}

/**
 * Create a user message.
 */
export function userMessage(content: string): LLMMessage {
  return { role: 'user', content };
}

/**
 * Create an assistant message.
 */
export function assistantMessage(content: string): LLMMessage {
  return { role: 'assistant', content };
}
