/**
 * Types for writing script abjects in TypeScript.
 *
 * A script abject is one handler-map expression: an object literal whose
 * methods answer messages. It runs as a ScriptableAbject in a sandbox with no
 * Node or browser globals (no fetch, require, timers beyond setTimeout /
 * setInterval, no crypto); everything else is reached by message through
 * `this`. `pnpm forge` compiles the TypeScript and erases these types, so
 * import them with `import type` only:
 *
 *   import type { AbjectHandlers, AbjectMessage } from '../../sdk/script/abject';
 *
 *   interface State { count: number }
 *
 *   ({
 *     async add(msg: AbjectMessage<{ by?: number }>) {
 *       this.data.count = (this.data.count ?? 0) + (msg.payload.by ?? 1);
 *       await this.saveData();
 *       return this.data.count;
 *     },
 *   }) satisfies AbjectHandlers<State>;
 *
 * Inside the methods `this` is typed as AbjectThis<State> plus the handler
 * map's own members (pass the map's type as the second parameter of
 * AbjectHandlers to check those calls too).
 */

/** An AbjectId: a UUID, or a well-known id such as 'abjects:registry'. */
export type AbjectId = string;

/** Where a call goes: an id, or a pending id from `this.dep()` / `this.find()`. */
export type Target = AbjectId | Promise<AbjectId>;

export interface AbjectMessage<P = unknown> {
  header: {
    messageId: string;
    correlationId?: string;
    sequenceNumber: number;
    timestamp: number;
    type: 'request' | 'reply' | 'event' | 'error';
  };
  routing: { from: AbjectId; to: AbjectId; interface?: string; method?: string };
  payload: P;
  protocol: { version: string };
}

/** What `this` offers inside a script abject's methods. */
export interface AbjectThis<D extends object = Record<string, unknown>> {
  /** This object's AbjectId. */
  readonly id: AbjectId;
  /**
   * Durable data: a plain JSON object carried by clones and kept across
   * restarts once saved. Do not keep secrets here; `ask` shows it to the model.
   */
  data: Partial<D>;
  /** Persist `this.data` (coalesced; resolves once the save covering it is stored). */
  saveData(): Promise<void>;

  /** Send a request and wait for the reply (30 s unless `timeout` is given). */
  call<T = unknown>(to: Target, method: string, payload?: unknown, options?: { timeout?: number }): Promise<T>;
  /**
   * The id of a dependency by name, found through the Registry (cached).
   * Throws when it does not exist.
   */
  dep(name: string): Promise<AbjectId>;
  /**
   * Find an object by name, or null: 'Name' in this workspace (and system
   * objects), 'workspace.Name' in another local workspace, or
   * 'peer.workspace.Name' in a peer's shared workspace.
   */
  find(name: string): Promise<AbjectId | null>;
  /** Tell this object's dependents that an aspect changed. */
  changed(aspect: string, value?: unknown): void;
  /** Send a one-way event to another object. */
  emit(to: Target, event: string, payload?: unknown): Promise<void>;
  /**
   * Become a dependent of another object: its `changed` notifications arrive
   * here as a `changed` message with payload `{ aspect, value }`.
   */
  observe(target: Target): Promise<void>;

  /** Postcondition check: throws ContractViolation when false. */
  ensure(cond: unknown, message?: string): void;
  /** Invariant check (call from `_checkInvariants`): throws when false. */
  invariant(cond: unknown, message?: string): void;
}

/**
 * The type a handler map `satisfies`. `D` is the shape of `this.data`; `Self`
 * describes the map's own members when you want calls between them checked
 * (by default they are loosely typed).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AbjectHandlers<D extends object = Record<string, unknown>, Self = Record<string, any>> =
  Record<string, unknown> & ThisType<AbjectThis<D> & Self>;

// ── LLM providers (docs/LLM_PROVIDERS.md) ─────────────────────────────

export type ModelTier = 'smart' | 'balanced' | 'fast' | 'code';
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LLMModel {
  id: string;
  name: string;
  vision?: boolean;
  efforts?: EffortLevel[];
  contextWindow?: number;
}

/** What a provider abject sends to the LLM object with `registerProvider`. */
export interface LLMProviderSpec {
  /** Provider id: lowercase letters, digits, ".", "_" or "-". Built-in names are reserved. */
  name: string;
  label?: string;
  models?: LLMModel[];
  defaultTierModels?: Partial<Record<ModelTier, string>>;
  /** You implement providerStream and emit providerChunk events. */
  streaming?: boolean;
  /** You implement providerModels for a live model list. */
  liveModels?: boolean;
  /** Longest a call may run without progress, 5000 to 3600000 ms. */
  timeoutMs?: number;
}

export interface RegisterProviderReply {
  name: string;
  registered: true;
  /** How many abjects serve this provider (one per workspace for a package). */
  backends: number;
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'document'; mediaType: 'application/pdf'; data: string; name?: string };

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentPart[];
  cacheBreakpoint?: boolean;
}

/** Call options as a provider receives them: the model is always filled in. */
export interface LLMCallOptions {
  model: string;
  tier?: ModelTier;
  maxTokens?: number;
  stopSequences?: string[];
  effort?: EffortLevel;
  cacheKey?: string;
  jsonMode?: boolean;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** What the call cost; when reported it prices the call in the ledger. */
  costUsd?: number;
}

/** `providerComplete` payload. */
export interface ProviderCompleteRequest {
  messages: LLMMessage[];
  options: LLMCallOptions;
}

export interface ProviderCompleteReply {
  content: string;
  finishReason?: 'stop' | 'length' | 'error';
  usage?: LLMUsage;
}

/** `providerStream` payload: emit `providerChunk { streamId, content }` events to the sender. */
export interface ProviderStreamRequest extends ProviderCompleteRequest {
  streamId: string;
}

export interface ProviderStreamReply {
  /** How many providerChunk events you emitted. */
  chunks?: number;
  stopReason?: string;
  usage?: LLMUsage;
}

/** HttpClient `request` reply. */
export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
}

/** What `Packages.getSettings` returns to a package's own abjects. */
export interface PackageSettings<V extends { [K in keyof V]: string | number | boolean } = Record<string, string | number | boolean>> {
  package: string;
  values: Partial<V>;
}
