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
  model?: string;
  /**
   * Stable identifier that providers may use to improve prompt-cache routing
   * (e.g. OpenAI's `prompt_cache_key`). Set to a per-conversation or per-task
   * string so repeated calls hash to the same server instance. Providers that
   * don't support routed caching (Anthropic, Ollama) ignore this.
   */
  cacheKey?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
}

/**
 * How a provider authenticates: HTTP API key, base URL (Ollama), an
 * external CLI binary that manages its own auth (claude/codex), or
 * nothing at all. Drives the GlobalSettings AI tab — `apiKey` and
 * `url` render a credential input; `cli` renders a binary-detection
 * status row; `none` renders nothing.
 */
export type CredentialMode = 'apiKey' | 'url' | 'cli' | 'none';

/**
 * Self-describing UI metadata for a provider. GlobalSettings reads this
 * via `LLMObject.listProviderDescriptions` and uses it to build the
 * provider dropdown, credential field, default tier models, and the
 * cached model list seed — without hardcoding per-provider knowledge.
 *
 * Each provider returns one of these from `describe()`. The base
 * implementation supplies sane defaults; subclasses override only the
 * fields where they differ.
 */
export interface LLMProviderDescription {
  /** Stable id used in tier routing and storage (e.g. 'anthropic'). */
  id: string;
  /** Human label for the provider dropdown (e.g. 'Anthropic'). */
  label: string;
  /** Storage key suffix (e.g. 'anthropicApiKey' → 'global-settings:anthropicApiKey'). */
  storageSuffix: string;
  /** How the user authenticates with this provider. */
  credentialMode: CredentialMode;
  /** Label for the credential input row when credentialMode is apiKey/url. */
  credentialLabel?: string;
  /** Placeholder for the credential input. */
  credentialPlaceholder?: string;
  /**
   * For `cli` providers: the binary name to detect on PATH and the
   * one-line install hint shown when it isn't found.
   */
  cli?: { binary: string; installHint: string };
  /**
   * Static fallback model list shown in tier dropdowns before any live
   * fetch completes. Live `listModels()` results override this.
   */
  models: ModelInfo[];
  /**
   * Default model id per tier — used when migrating a legacy
   * single-provider config to the new per-tier router, and when no
   * other selection exists. Use empty strings when the provider has no
   * stable defaults (Ollama).
   */
  defaultTierModels: { smart: string; balanced: string; fast: string };
  /**
   * Declarative migration map for saved tier-routing model ids — `{ from
   * → to }`. Applied once at GlobalSettings init. Useful when an upstream
   * API drops a model name (e.g. codex's `gpt-5` → `auto` under ChatGPT
   * login). A function would be cleaner but descriptions cross worker
   * boundaries via structured clone, which can't transport closures.
   */
  modelMigrations?: Record<string, string>;
}

export interface LLMCompletionResult {
  content: string;
  finishReason: 'stop' | 'length' | 'error';
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
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

  /**
   * List available models for this provider.
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Self-describing UI metadata: credential mode, default tier models,
   * static model list seed, etc. GlobalSettings consumes this to build
   * the AI tab without per-provider hardcoding.
   */
  describe(): LLMProviderDescription;
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

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  /**
   * Default self-description. Subclasses override to supply real
   * defaults; the base form returns minimum-viable metadata so any
   * unconfigured provider still renders a usable row in the AI tab.
   */
  describe(): LLMProviderDescription {
    return {
      id: this.name,
      label: this.name,
      storageSuffix: `${this.name}ApiKey`,
      credentialMode: 'apiKey',
      credentialLabel: `${this.name} API Key`,
      credentialPlaceholder: '',
      models: [],
      defaultTierModels: { smart: '', balanced: '', fast: '' },
    };
  }

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
