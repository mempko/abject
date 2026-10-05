/**
 * RemoteLLMProvider — an LLM provider implemented by another abject.
 *
 * Any abject can become a provider: it sends `registerProvider` to the LLM
 * object (usually from its `startup` handler, see docs/LLM_PROVIDERS.md) and
 * the LLM object then routes the calls tier routing assigns to it by message.
 * The abject answers:
 *
 *   providerComplete { messages, options }
 *     → { content, finishReason?, usage? }
 *
 *   providerStream { streamId, messages, options }       (when registered with streaming)
 *     emits providerChunk { streamId, content } events to the LLM object, then
 *     → { chunks?, stopReason?, usage? }                  (chunks = how many it emitted)
 *
 *   providerModels {}                                     (when registered with liveModels)
 *     → ModelInfo[]
 *
 * Liveness uses the built-in `ping` every abject answers.
 *
 * Several abjects may back one provider name when they come from the same
 * installed package (a package spawns in every workspace): calls go to the
 * first that answers, and a backend that has gone away is dropped. Everything
 * else about the call (tier routing, fallbacks, the ledger, goal budgets,
 * streaming to callers) is LLMObject's, exactly as for a built-in provider.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AbjectId } from '../core/types.js';
import type {
  LLMProvider, LLMMessage, LLMCompletionOptions, LLMCompletionResult, LLMStreamChunk,
  LLMProviderDescription, ModelInfo, ModelTier, EffortLevel,
} from './provider.js';

/** What a provider abject sends with `registerProvider`. */
export interface RemoteProviderSpec {
  /** Provider id used in tier routing and the ledger. */
  name: string;
  /** Label for the provider dropdown. Defaults to the name. */
  label?: string;
  /** Models to offer in tier dropdowns (also the fallback when liveModels fails). */
  models?: ModelInfo[];
  /** Model to use per tier when routing names no model. */
  defaultTierModels?: Partial<Record<ModelTier, string>>;
  /** The abject implements providerStream and emits providerChunk events. */
  streaming?: boolean;
  /** The abject implements providerModels for a live model list. */
  liveModels?: boolean;
  /** Longest a single call may take, in ms (default 10 minutes). */
  timeoutMs?: number;
}

/** The LLM object's side of the conversation with provider abjects. */
export interface RemoteProviderHost {
  /** Send a request to a provider abject and wait for its reply. */
  request<T>(to: AbjectId, method: string, payload: unknown, timeoutMs: number): Promise<T>;
  /** Route providerChunk events for this stream id (from this backend only) to the sink. */
  openStream(streamId: string, backend: AbjectId, sink: (content: string) => void): void;
  closeStream(streamId: string): void;
}

export const DEFAULT_REMOTE_TIMEOUT_MS = 10 * 60 * 1000;
const PING_TIMEOUT_MS = 3000;
const MODELS_TIMEOUT_MS = 15000;
/** After a stream's reply, how long to wait for chunk events still in flight. */
const STREAM_DRAIN_MS = 250;

type Usage = LLMCompletionResult['usage'];

/** True when an error means the backend abject no longer exists. */
function isGone(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  const text = err instanceof Error ? err.message : String(err);
  return code === 'RECIPIENT_NOT_FOUND' || /RECIPIENT_NOT_FOUND|Object stopped/.test(text);
}

export class RemoteLLMProvider implements LLMProvider {
  readonly name: string;
  private spec: RemoteProviderSpec;
  /** Backends in preference order; the first alive one serves calls. */
  private backends: AbjectId[];

  constructor(
    spec: RemoteProviderSpec,
    backend: AbjectId,
    /** The package owner shared by every backend, or undefined for a single abject. */
    readonly owner: string | undefined,
    private readonly host: RemoteProviderHost,
  ) {
    this.name = spec.name;
    this.spec = spec;
    this.backends = [backend];
  }

  // ── Backends ─────────────────────────────────────────────────────

  hasBackend(id: AbjectId): boolean {
    return this.backends.includes(id);
  }

  addBackend(id: AbjectId): void {
    if (!this.backends.includes(id)) this.backends.push(id);
  }

  /** Remove a backend; returns how many remain. */
  removeBackend(id: AbjectId): number {
    this.backends = this.backends.filter(b => b !== id);
    return this.backends.length;
  }

  backendIds(): AbjectId[] {
    return [...this.backends];
  }

  /** Re-registration from a current backend refreshes what it offers. */
  update(spec: RemoteProviderSpec): void {
    this.spec = { ...spec, name: this.name };
  }

  private get timeoutMs(): number {
    return this.spec.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  }

  /**
   * Run a call against the first backend that is still there, dropping the
   * ones that have gone away. Any other failure is the provider's answer and
   * is returned to the caller unchanged.
   */
  private async withBackend<T>(call: (backend: AbjectId) => Promise<T>): Promise<T> {
    while (this.backends.length > 0) {
      const backend = this.backends[0];
      try {
        return await call(backend);
      } catch (err) {
        if (!isGone(err)) throw err;
        this.removeBackend(backend);
      }
    }
    throw new Error(`LLM provider '${this.name}' has no running abject behind it`);
  }

  // ── LLMProvider ──────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    for (const backend of [...this.backends]) {
      try {
        await this.host.request(backend, 'ping', {}, PING_TIMEOUT_MS);
        return true;
      } catch (err) {
        if (isGone(err)) this.removeBackend(backend);
      }
    }
    return false;
  }

  resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    const tiers = this.spec.defaultTierModels ?? {};
    return (options?.tier && tiers[options.tier]) || tiers.balanced || this.spec.models?.[0]?.id || 'default';
  }

  /** The options sent to the abject, with the model it should run on filled in. */
  private optionsFor(options?: LLMCompletionOptions): LLMCompletionOptions {
    return { ...(options ?? {}), model: this.resolveModel(options) };
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const reply = await this.withBackend(backend => this.host.request<Partial<LLMCompletionResult>>(
      backend, 'providerComplete', { messages, options: this.optionsFor(options) }, this.timeoutMs));
    if (!reply || typeof reply.content !== 'string') {
      throw new Error(`LLM provider '${this.name}' returned no content`);
    }
    return {
      content: reply.content,
      finishReason: reply.finishReason === 'length' || reply.finishReason === 'error' ? reply.finishReason : 'stop',
      ...(reply.usage ? { usage: reply.usage } : {}),
    };
  }

  /** Present only for providers registered with streaming. */
  get stream(): ((messages: LLMMessage[], options?: LLMCompletionOptions) => AsyncIterable<LLMStreamChunk>) | undefined {
    return this.spec.streaming ? (messages, options) => this.streamFrom(messages, options) : undefined;
  }

  private async *streamFrom(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk> {
    const pending: string[] = [];
    let received = 0;
    let wake: (() => void) | undefined;
    const notify = () => { const w = wake; wake = undefined; w?.(); };
    let finished: { chunks?: number; stopReason?: string; usage?: Usage } | undefined;
    let failure: unknown;
    let finishedAt = 0;

    // Start the call on a live backend; chunks arriving before the reply are
    // queued. A backend that has gone away before sending anything is
    // dropped and the next one tried, as for complete().
    const streamId = uuidv4();
    this.withBackend(async backend => {
      this.host.openStream(streamId, backend, content => { pending.push(content); received++; notify(); });
      try {
        return await this.host.request<{ chunks?: number; stopReason?: string; usage?: Usage; content?: string }>(
          backend, 'providerStream', { streamId, messages, options: this.optionsFor(options) }, this.timeoutMs);
      } catch (err) {
        if (isGone(err) && received === 0) this.host.closeStream(streamId);
        throw err;
      }
    }).then(
      reply => {
        // A provider that streams nothing but returns content is one chunk.
        if (reply?.content && received === 0) { pending.push(reply.content); received++; }
        finished = { chunks: reply?.chunks, stopReason: reply?.stopReason, usage: reply?.usage };
        finishedAt = Date.now();
        notify();
      },
      err => { failure = err; notify(); },
    );

    try {
      for (;;) {
        while (pending.length > 0) yield { content: pending.shift()!, done: false };
        if (failure) throw failure;
        if (finished) {
          // The reply can overtake chunk events still in flight. Wait for the
          // count the provider reported, or briefly when it reported none,
          // but never longer than a bounded drain.
          const expected = finished.chunks;
          const waited = Date.now() - finishedAt;
          if (expected !== undefined ? received >= expected : waited >= STREAM_DRAIN_MS) break;
          if (waited >= STREAM_DRAIN_MS * 8) break;
          await new Promise<void>(resolve => {
            wake = resolve;
            setTimeout(() => { if (wake === resolve) notify(); }, 50);
          });
          continue;
        }
        await new Promise<void>(resolve => { wake = resolve; });
      }
      yield {
        content: '',
        done: true,
        ...(finished?.stopReason ? { stopReason: finished.stopReason } : {}),
        ...(finished?.usage ? { usage: finished.usage } : {}),
      };
    } finally {
      this.host.closeStream(streamId);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.spec.liveModels) {
      try {
        const models = await this.withBackend(backend =>
          this.host.request<ModelInfo[]>(backend, 'providerModels', {}, MODELS_TIMEOUT_MS));
        if (Array.isArray(models)) return sanitizeModels(models);
      } catch { /* fall back to the registered list */ }
    }
    return [...(this.spec.models ?? [])];
  }

  supportedEfforts(modelId: string): EffortLevel[] {
    return this.spec.models?.find(m => m.id === modelId)?.efforts ?? [];
  }

  describe(): LLMProviderDescription {
    const tiers = this.spec.defaultTierModels ?? {};
    return {
      id: this.name,
      label: this.spec.label || this.name,
      storageSuffix: `${this.name}Provider`,
      // The provider abject holds its own credentials (package settings);
      // there is nothing for the AI tab to ask for.
      credentialMode: 'none',
      models: [...(this.spec.models ?? [])],
      defaultTierModels: {
        smart: tiers.smart ?? '', balanced: tiers.balanced ?? '', fast: tiers.fast ?? '', code: tiers.code ?? '',
      },
      capabilities: { chat: true },
    };
  }
}

// ── Validation of what a provider abject sends ─────────────────────

const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const TIERS: readonly ModelTier[] = ['smart', 'balanced', 'fast', 'code'];
const EFFORTS: readonly EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function sanitizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  for (const m of raw.slice(0, 500)) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id === '') continue;
    out.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name !== '' ? r.name : r.id,
      ...(typeof r.vision === 'boolean' ? { vision: r.vision } : {}),
      ...(Array.isArray(r.efforts) ? { efforts: r.efforts.filter((e): e is EffortLevel => EFFORTS.includes(e as EffortLevel)) } : {}),
      ...(typeof r.contextWindow === 'number' && r.contextWindow > 0 ? { contextWindow: r.contextWindow } : {}),
    });
  }
  return out;
}

/**
 * Validate a registration. Throws with a message meant for the provider's
 * author on anything malformed; returns the normalized spec.
 */
export function parseRemoteProviderSpec(raw: unknown): RemoteProviderSpec {
  if (!raw || typeof raw !== 'object') throw new Error('registerProvider needs a payload object');
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !PROVIDER_NAME.test(r.name)) {
    throw new Error('registerProvider: name must be 1-48 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit');
  }
  const spec: RemoteProviderSpec = { name: r.name };
  if (r.label !== undefined) {
    if (typeof r.label !== 'string' || r.label.length > 64) throw new Error('registerProvider: label must be a string of at most 64 characters');
    spec.label = r.label;
  }
  if (r.models !== undefined) {
    if (!Array.isArray(r.models)) throw new Error('registerProvider: models must be an array of { id, name }');
    spec.models = sanitizeModels(r.models);
  }
  if (r.defaultTierModels !== undefined) {
    if (!r.defaultTierModels || typeof r.defaultTierModels !== 'object') throw new Error('registerProvider: defaultTierModels must map tiers to model ids');
    const tiers: Partial<Record<ModelTier, string>> = {};
    for (const [tier, model] of Object.entries(r.defaultTierModels as Record<string, unknown>)) {
      if (!TIERS.includes(tier as ModelTier)) throw new Error(`registerProvider: unknown tier '${tier}' (smart, balanced, fast, code)`);
      if (typeof model !== 'string') throw new Error(`registerProvider: the ${tier} model must be a string`);
      tiers[tier as ModelTier] = model;
    }
    spec.defaultTierModels = tiers;
  }
  if (r.streaming !== undefined) spec.streaming = r.streaming === true;
  if (r.liveModels !== undefined) spec.liveModels = r.liveModels === true;
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs !== 'number' || !(r.timeoutMs >= 5000 && r.timeoutMs <= 60 * 60 * 1000)) {
      throw new Error('registerProvider: timeoutMs must be between 5000 and 3600000');
    }
    spec.timeoutMs = r.timeoutMs;
  }
  return spec;
}
