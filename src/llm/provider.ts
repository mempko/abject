/**
 * LLM provider interface - provider-agnostic abstraction.
 */

import { require, requireNonEmpty } from '../core/contracts.js';

export interface TextPart { type: 'text'; text: string; }
export interface ImagePart { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string; }
/** A document (e.g. a PDF) sent as base64. `name` is an optional display label. */
export interface DocumentPart { type: 'document'; mediaType: 'application/pdf'; data: string; name?: string; }
export type ContentPart = TextPart | ImagePart | DocumentPart;

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
  /**
   * Provider stop reason, set on the terminal (done) chunk when known.
   * 'length'/'max_tokens' means the response was truncated mid-generation —
   * consumers must not treat truncated output as a complete answer.
   */
  stopReason?: string;
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

// ─── Retry plumbing ──────────────────────────────────────────────────────

export interface RetryOptions {
  /** Total attempts including the first try. Defaults to 3. */
  maxAttempts?: number;
  /** Backoff before retry #2. Doubles up to maxDelayMs per attempt. */
  initialDelayMs?: number;
  /** Cap on backoff between attempts. */
  maxDelayMs?: number;
  /** Multiplier applied to delay after each failure. */
  backoffFactor?: number;
  /**
   * Decide whether an error is worth retrying. Return false for permanent
   * failures (auth, 4xx other than 408/429, malformed argv) so we don't
   * hammer a known-broken endpoint. Default: see `defaultIsRetryable`.
   */
  isRetryable?: (err: unknown) => boolean;
  /** Hook for logging — called once before each retry sleep. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Diagnostic label used by onRetry's default formatter. */
  label?: string;
}

const DEFAULT_RETRY_OPTS: Required<Omit<RetryOptions, 'isRetryable' | 'onRetry' | 'label'>> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
};

/**
 * Errors we don't retry: auth/permission, model-not-found, bad request,
 * unknown CLI flags, missing binary. These will keep failing identically;
 * retrying just delays the user-visible failure.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /\b(401|403|404)\b/,                      // HTTP auth / forbidden / not found
  /\bAPI[- ]?key\b/i,
  /\bunauthor/i,
  /\bauth(entication)?\s+(failed|required)/i,
  /\binvalid_request/i,
  /\bmodel\s+not\s+found/i,
  /\bunsupported\s+model/i,
  /\bunknown\s+option/i,                    // CLI version mismatch
  /\bENOENT\b/,                             // binary missing
  /\bcommand\s+not\s+found\b/i,
];

/** Default retryability check: assume transient unless the message matches a known permanent pattern. */
export function defaultIsRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // 4xx other than 408 (timeout) and 429 (rate limit) are permanent. Match
  // before the broad permanent patterns so 429 stays retryable.
  if (/\b429\b/.test(msg)) return true;
  if (/\b408\b/.test(msg)) return true;
  if (/\b4\d\d\b/.test(msg) && !/\b(408|429)\b/.test(msg)) return false;
  return !PERMANENT_PATTERNS.some(re => re.test(msg));
}

/**
 * Run `fn` with bounded retries and exponential backoff. Returns whatever
 * `fn` returns on the first success; throws the last error if every attempt
 * fails or the error is classified permanent.
 *
 * The provided `isRetryable` predicate is called per attempt; a `false`
 * result short-circuits and re-throws immediately.
 */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_OPTS, ...opts };
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const label = opts.label ?? 'llm-call';
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= cfg.maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const delay = Math.min(
        cfg.initialDelayMs * Math.pow(cfg.backoffFactor, attempt - 1),
        cfg.maxDelayMs,
      );
      if (opts.onRetry) {
        try { opts.onRetry(err, attempt, delay); } catch { /* never let logging crash retry */ }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[${label}] attempt ${attempt}/${cfg.maxAttempts} failed: ${msg.slice(0, 200)} — retrying in ${delay}ms`);
      }
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Retry classifier for CLI-driven providers. Subprocess-specific transient
 * failures (idle-timeout kills, broken pipes, signal-killed) get retried;
 * authentication, missing binaries, and unknown-flag errors do not.
 */
export function cliIsRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // CLI-specific transient signals. Match these BEFORE delegating to the
  // default classifier so we don't accidentally drop them under a 4xx test.
  if (/idle for \d+ms/i.test(msg)) return true;
  if (/subprocess killed/i.test(msg)) return true;
  if (/\b(ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED)\b/.test(msg)) return true;
  if (/SIGTERM|SIGKILL|signal\s+\d+/i.test(msg)) return true;
  return defaultIsRetryable(err);
}

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
   * Wrap an async call in retry-with-backoff. Subclasses pick the right
   * `isRetryable` (e.g. `cliIsRetryable` for subprocess providers); HTTP
   * subclasses leave it default.
   */
  protected withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    return withRetries(fn, { label: this.name, ...opts });
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

// ── Conversation size utilities ─────────────────────────────────────────────
// Shared by LLMObject's `compress` method and AgentAbject's conversation
// budget enforcement.

/** A message shape loose enough for both LLMMessage and agent conversations. */
export interface SizedMessage {
  role: string;
  content: string | ContentPart[];
}

/**
 * Truncate a string keeping head and tail with an elision marker. Head gets
 * the larger share — openings carry instructions/structure; tails carry the
 * most recent values.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…[${text.length - maxChars} chars elided to fit context budget]…\n${text.slice(-tail)}`;
}

/** Total text chars in one message (image/document parts count 0). */
export function messageTextChars(msg: SizedMessage): number {
  if (typeof msg.content === 'string') return msg.content.length;
  let total = 0;
  for (const part of msg.content) {
    if ('text' in part && typeof part.text === 'string') total += part.text.length;
  }
  return total;
}

/** Total text chars across a conversation. */
export function conversationTextChars(msgs: SizedMessage[]): number {
  return msgs.reduce((sum, m) => sum + messageTextChars(m), 0);
}

/** Shrink one message's text content to roughly `target` chars in place. */
export function truncateMessageTo(msg: SizedMessage, target: number): void {
  if (typeof msg.content === 'string') {
    msg.content = truncateText(msg.content, target);
    return;
  }
  // Multi-part content: shrink the largest text part until the total fits.
  // Non-text parts (images, documents) are left alone.
  for (let guard = 0; guard < msg.content.length + 1; guard++) {
    const total = messageTextChars(msg);
    if (total <= target) return;
    let largestIdx = -1;
    let largestLen = 0;
    msg.content.forEach((part, i) => {
      if ('text' in part && typeof part.text === 'string' && part.text.length > largestLen) {
        largestLen = part.text.length;
        largestIdx = i;
      }
    });
    if (largestIdx === -1) return;
    const part = msg.content[largestIdx] as { text: string };
    part.text = truncateText(part.text, Math.max(1000, largestLen - (total - target)));
  }
}

/**
 * Hard guarantee that a conversation fits `maxChars`: repeatedly
 * head+tail-truncate the largest message until under budget. Deterministic,
 * no LLM involved, position-blind, always converges (each pass shrinks the
 * current largest message toward `floorChars`).
 */
export function enforceConversationCharBudget(
  msgs: SizedMessage[],
  maxChars: number,
  floorChars = 4000,
): void {
  for (let guard = 0; guard < msgs.length * 2; guard++) {
    const total = conversationTextChars(msgs);
    if (total <= maxChars) return;

    let largestIdx = -1;
    let largestLen = floorChars;
    msgs.forEach((m, i) => {
      const len = messageTextChars(m);
      if (len > largestLen) {
        largestLen = len;
        largestIdx = i;
      }
    });
    if (largestIdx === -1) return; // everything at floor — nothing left to shrink

    // Shrink by the overage (plus marker allowance), never below the floor.
    const target = Math.max(floorChars, largestLen - (total - maxChars) - 200);
    truncateMessageTo(msgs[largestIdx], target);
  }
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
