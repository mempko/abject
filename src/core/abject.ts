/**
 * Base Abject class - the fundamental object in the system.
 *
 * Each Abject runs its own processing loop, pulling messages from its mailbox.
 * Replies bypass the mailbox via a fast-path to avoid deadlocks.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AbjectId,
  TypeId,
  AbjectManifest,
  AbjectMessage,
  AbjectState,
  AbjectStatus,
  AbjectError,
  CapabilityGrant,
} from './types.js';
import { require, invariant, requireNonEmpty } from './contracts.js';
import { reply, error, errorFromException, event, request, isRequest, isReply, isError } from './message.js';
import { Mailbox } from '../runtime/mailbox.js';
import type { MessageBusLike } from '../runtime/message-bus.js';
import { CapabilitySet, getDefaultCapabilities } from './capability.js';
import { INTROSPECT_METHODS, INTROSPECT_EVENTS, formatManifestAsDescription } from './introspect.js';
import type { InterfaceId } from './types.js';
import { Log } from './timed-log.js';
import type { ThemeData } from './theme-data.js';
import { MIDNIGHT_BLOOM } from './theme-data.js';

const log = new Log('ABJECT');

/**
 * Return this from a request handler to suppress the auto-reply.
 * The handler is responsible for sending the reply manually later via sendDeferredReply().
 */
export const DEFERRED_REPLY = Symbol('DEFERRED_REPLY');

export type MessageHandlerFn = (
  message: AbjectMessage
) => Promise<unknown> | unknown;

export interface AbjectOptions {
  manifest: AbjectManifest;
  capabilities?: CapabilityGrant[];
  initialState?: unknown;
}

/**
 * Base class for all objects in the system.
 *
 * Each object runs its own processing loop that pulls messages from its mailbox.
 * Replies are delivered via a fast-path that bypasses the mailbox to avoid deadlocks.
 */
export abstract class Abject {
  readonly id: AbjectId;
  private _typeId?: TypeId;
  readonly manifest: AbjectManifest;
  readonly capabilities: CapabilitySet;

  protected state: unknown;
  protected _status: AbjectState = 'initializing';
  protected errorCount = 0;
  protected lastError?: AbjectError;
  protected readonly startedAt: number;
  protected lastActivity: number;

  private _bus?: MessageBusLike;
  private _mailbox?: Mailbox;
  private _parentId?: AbjectId;
  private _registryId?: AbjectId;
  private _processingLoop?: Promise<void>;
  private _handlerCount = 0;
  private _stoppedDuringHandler = false;
  protected handlers: Map<string, MessageHandlerFn> = new Map();
  private dependents: Set<AbjectId> = new Set();
  private _themeId?: AbjectId;
  private pendingReplies: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    timeoutMs: number;
    timeoutMsg: string;
    targetId: AbjectId;
  }> = new Map();

  /**
   * Tracks senders of requests currently being handled (sync or async). Used to
   * bubble progress events back to the originators so any progress anywhere in
   * the call tree resets every ancestor's stall timer.
   */
  private _handlingRequestSenders: Set<import('./types.js').AbjectId> = new Set();

  constructor(options: AbjectOptions) {
    require(options.manifest !== undefined, 'manifest is required');
    requireNonEmpty(options.manifest.name, 'manifest.name');

    this.id = uuidv4();
    // Merge introspect methods and events into the single interface
    const iface = options.manifest.interface;
    const hasDescribe = iface.methods.some(m => m.name === 'describe');
    this.manifest = hasDescribe
      ? options.manifest
      : {
          ...options.manifest,
          interface: {
            ...iface,
            methods: [...iface.methods, ...INTROSPECT_METHODS],
            events: [...(iface.events ?? []), ...INTROSPECT_EVENTS],
          },
        };
    this.state = options.initialState;
    this.startedAt = Date.now();
    this.lastActivity = this.startedAt;

    // Setup capabilities
    const grants = [
      ...getDefaultCapabilities(this.id),
      ...(options.capabilities ?? []),
    ];
    this.capabilities = new CapabilitySet(grants);
  }

  /**
   * Get current status.
   */
  get status(): AbjectStatus {
    return {
      id: this.id,
      typeId: this._typeId,
      state: this._status,
      manifest: this.manifest,
      connections: [], // TODO: track connections
      errorCount: this.errorCount,
      lastError: this.lastError,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
    };
  }

  /**
   * Protected accessor for the message bus (for spawning children).
   */
  protected get bus(): MessageBusLike {
    require(this._bus !== undefined, 'Object not initialized');
    return this._bus!;
  }

  /**
   * Scoped, durable type identity. Survives restarts. Like a DNS name.
   * Format: {peerId}/{workspaceId}/{objectName}
   */
  get typeId(): TypeId | undefined {
    return this._typeId;
  }

  /**
   * Override ID before initialization. Used by Supervisor for same-ID restart.
   */
  setId(id: AbjectId): void {
    require(this._status === 'initializing', 'Can only set ID before initialization');
    (this as { id: AbjectId }).id = id;
  }

  /**
   * Set the type identity before initialization.
   */
  setTypeId(typeId: TypeId): void {
    require(this._status === 'initializing', 'Can only set typeId before initialization');
    this._typeId = typeId;
  }

  /**
   * Pre-seed the registry ID before initialization.
   * Avoids the need to ask the parent chain during onInit().
   */
  setRegistryHint(registryId: AbjectId): void {
    this._registryId = registryId;
  }

  /**
   * Initialize the object. Called after registration with the bus.
   * Starts the per-object processing loop.
   */
  async init(bus: MessageBusLike, parentId?: AbjectId): Promise<void> {
    require(this._status === 'initializing', 'Object must be initializing');
    require(this._bus === undefined, 'Object already initialized');

    this._bus = bus;
    this._parentId = parentId;
    this._mailbox = bus.register(this.id);

    // Register the introspect handler on every Abject
    this.on('describe', () => ({
      manifest: this.manifest,
      description: formatManifestAsDescription(this.manifest),
    }));

    // Universal ping handler for liveness checks (don't overwrite if subclass defined one)
    if (!this.handlers.has('ping')) {
      this.on('ping', () => ({ alive: true, timestamp: Date.now() }));
    }

    // Universal dependency protocol (Smalltalk addDependent:/removeDependent:/changed:)
    this.on('addDependent', (msg: AbjectMessage) => {
      this.dependents.add(msg.routing.from);
      return true;
    });

    this.on('removeDependent', (msg: AbjectMessage) => {
      this.dependents.delete(msg.routing.from);
      return true;
    });

    // Pull-based registry discovery chain
    this.on('getRegistry', async () => {
      const known = this.getRegistryId();
      if (known) return known;
      if (this._parentId) {
        try {
          const id = await this.request<string>(
            request(this.id, this._parentId, 'getRegistry', {})
          );
          if (id) this._registryId = id as AbjectId;
          return id;
        } catch {
          return null;
        }
      }
      return null;
    });

    // LLM-powered ask handler (non-blocking via DEFERRED_REPLY)
    this.on('ask', (msg: AbjectMessage) => {
      const { question } = msg.payload as { question: string };

      // Fire off the LLM work async, send deferred reply when done
      this.handleAsk(question).then(
        (result) => { try { this.sendDeferredReply(msg, result); } catch { /* stopped */ } },
        () => { try { this.sendDeferredReply(msg, `[No LLM available] ${formatManifestAsDescription(this.manifest)}`); } catch { /* stopped */ } },
      );

      return DEFERRED_REPLY;
    });

    // Default progress handler: reset all pending request timers, then bubble
    // progress upstream to whoever called us. This makes any progress event
    // anywhere in the call tree reset every ancestor's stall timer.
    this.on('progress', (msg: AbjectMessage) => {
      const pendingCount = this.pendingReplies.size;
      const upstreamCount = this._handlingRequestSenders.size;
      if (pendingCount > 0 || upstreamCount > 0) {
        log.info(`[${this.manifest.name}:${this.id.slice(0, 8)}] PROGRESS from=${msg.routing.from.slice(0, 8)} resetting=${pendingCount} bubble_to=${upstreamCount}`);
      }
      // Reset stall timers for every outbound request we're awaiting
      for (const id of this.pendingReplies.keys()) {
        this.resetRequestTimeout(id);
      }
      // Bubble: forward a progress event to every upstream request sender,
      // skipping the sender of this progress event to avoid ping-pong loops.
      const from = msg.routing.from;
      for (const upstream of this._handlingRequestSenders) {
        if (upstream === from) continue;
        try {
          this.send(event(this.id, upstream, 'progress', msg.payload ?? {}));
        } catch { /* bus gone */ }
      }
    });

    this._status = 'ready';

    // Start the per-object processing loop
    this._processingLoop = this.processMessages();

    await this.onInit();

    this.checkInvariants();

    // Notify parent after full initialization
    if (this._parentId) {
      try {
        this.send(event(this.id, this._parentId, 'childReady', {
          childId: this.id, name: this.manifest.name,
        }));
      } catch {
        // Parent may not handle childReady — that's OK
      }
    }
  }

  /**
   * Override this to perform custom initialization.
   */
  protected async onInit(): Promise<void> {
    // Default: no-op
  }

  /**
   * Get the cached Registry ID. Override in subclasses that know the Registry directly.
   * Public so Factory can determine which registry an object belongs to at kill time.
   */
  getRegistryId(): AbjectId | undefined {
    return this._registryId;
  }

  /**
   * Resolve and cache the Registry ID (via parent chain).
   */
  protected async resolveRegistryId(): Promise<AbjectId | null> {
    const known = this.getRegistryId();
    if (known) return known;
    if (this._parentId) {
      try {
        const id = await this.request<string>(
          request(this.id, this._parentId, 'getRegistry', {})
        );
        if (id) {
          this._registryId = id as AbjectId;
          return this._registryId;
        }
      } catch { /* no registry available */ }
    }
    return null;
  }

  /**
   * Discover a dependency by manifest name via Registry.
   * Returns null if not found.
   */
  protected async discoverDep(name: string): Promise<AbjectId | null> {
    const regId = await this.resolveRegistryId();
    if (!regId) return null;
    const results = await this.request<Array<{ id: AbjectId }>>(
      request(this.id, regId, 'discover', { name })
    );
    return results.length > 0 ? results[0].id : null;
  }

  /**
   * Discover a dependency by manifest name. Throws if not found.
   */
  protected async requireDep(name: string): Promise<AbjectId> {
    const id = await this.discoverDep(name);
    if (!id) throw new Error(`Required dependency '${name}' not found in Registry`);
    return id;
  }

  /**
   * Get the current theme. Returns cached theme or MIDNIGHT_BLOOM default.
   * WidgetAbject overrides this field directly (set from config).
   */
  protected theme: ThemeData = MIDNIGHT_BLOOM;

  /**
   * Discover the Theme object, fetch the current theme, cache it, and
   * subscribe as a dependent so themeChanged events keep the cache fresh.
   */
  protected async fetchTheme(): Promise<ThemeData> {
    try {
      const themeId = await this.discoverDep('Theme');
      if (themeId) {
        this._themeId = themeId;
        const themeData = await this.request<ThemeData>(
          request(this.id, themeId, 'getTheme', {})
        );
        this.theme = themeData;
        // Subscribe as dependent so we get themeChanged events
        try {
          await this.request(request(this.id, themeId, 'addDependent', {}));
        } catch { /* best effort */ }
      }
    } catch { /* Theme not available — use default */ }
    return this.theme;
  }

  /**
   * Build the system prompt for an ask question. Override to customize the
   * context the LLM sees when answering questions about this object.
   * Default: manifest description.
   */
  protected askPrompt(_question: string): string {
    return `## System Model
This is a message-passing object system called Abjects. Every object (Abject) has a mailbox, a manifest declaring its capabilities, and an ask handler for answering questions about itself. Objects communicate exclusively by sending messages to each other. The Registry knows about all objects in the system. Objects discover each other by asking the Registry, learn what other objects can do by sending them ask messages, then send messages to accomplish tasks. Every object is autonomous and processes messages from its mailbox sequentially.

## About This Object
${formatManifestAsDescription(this.manifest)}

You are this object. Your capabilities are exactly what the manifest above describes. Answer questions based on your actual capabilities, not hypothetical ones.`;
  }

  /**
   * Send a prompt + question to the LLM and return the response.
   * Discovers LLM via Registry. Falls back to manifest description if unavailable.
   * Reusable helper for any override that builds its own prompts.
   */
  protected async askLlm(systemPrompt: string, question: string, tier = 'fast'): Promise<string> {
    try {
      let regId = this.getRegistryId();
      if (!regId && this._parentId) {
        try {
          const id = await this.request<string>(
            request(this.id, this._parentId, 'getRegistry', {})
          );
          if (id) {
            regId = id as AbjectId;
            this._registryId = regId;
          }
        } catch { /* No registry available */ }
      }

      if (regId) {
        const results = await this.request<Array<{ id: AbjectId }>>(
          request(this.id, regId, 'discover', { name: 'LLM' })
        );

        if (results && results.length > 0) {
          const llmId = results[0].id;
          const llmResult = await this.request<{ content: string }>(
            request(this.id, llmId, 'complete', {
              messages: [
                { role: 'system', content: `You are "${this.manifest.name}": ${this.manifest.description}\n${systemPrompt}` },
                { role: 'user', content: question },
              ],
              options: { tier },
            }),
            60000,
          );
          return llmResult.content;
        }
      }
    } catch { /* LLM not available */ }

    return `[No LLM available] ${formatManifestAsDescription(this.manifest)}`;
  }

  /**
   * Handle an 'ask' request. Override for custom behavior (e.g., querying
   * Registry to discover which objects can help before answering).
   * Default: build prompt via askPrompt(), send to LLM via askLlm().
   */
  protected async handleAsk(question: string): Promise<string> {
    const prompt = this.askPrompt(question);
    return this.askLlm(prompt, question);
  }

  /**
   * Per-object processing loop. Pulls messages from mailbox and handles them.
   * Replies are resolved here (Erlang-style: replies are just messages in the mailbox).
   * Only await point is mailbox.receive().
   */
  private async processMessages(): Promise<void> {
    const isStopped = () => (this._status as string) === 'stopped';
    while (!isStopped()) {
      let msg: AbjectMessage;
      try {
        msg = await this._mailbox!.receive();
      } catch {
        break; // Mailbox closed
      }
      if (isStopped()) break;

      // Reply/error messages resolve pending request Promises directly
      if ((msg.header.type === 'reply' || msg.header.type === 'error')
          && msg.header.correlationId) {
        const pending = this.pendingReplies.get(msg.header.correlationId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingReplies.delete(msg.header.correlationId);
          if (isError(msg)) {
            const err = msg.payload as AbjectError;
            pending.reject(new Error(`${err.code}: ${err.message}`));
          } else {
            pending.resolve(msg.payload);
          }
        }
        continue; // Never dispatch replies to handlers
      }

      this.handleMessage(msg);
    }
  }

  /**
   * Stop the object.
   */
  async stop(): Promise<void> {
    this._status = 'stopped';
    await this.onStop();

    // Reject all pending replies
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Object stopped'));
    }
    this.pendingReplies.clear();

    // Always unregister from bus immediately — this is safe and idempotent.
    if (this._bus) {
      this._bus.unregister(this.id);
    }

    // If called from inside a handler, defer only the processing-loop await
    // to avoid a circular Promise chain (stop awaits processingLoop which
    // awaits handleMessage which called stop).
    if (this._handlerCount > 0) {
      this._stoppedDuringHandler = true;
      this.dependents.clear();
      return;
    }

    // Wait for processing loop to finish
    if (this._processingLoop) {
      await this._processingLoop;
      this._processingLoop = undefined;
    }

    // Clear dependents
    this.dependents.clear();
  }

  /**
   * Recover from error state, returning to ready.
   */
  recover(): void {
    require(this._status === 'error', 'Can only recover from error state');
    this._status = 'ready';
  }

  /**
   * Override this to perform custom cleanup.
   */
  protected async onStop(): Promise<void> {
    // Default: no-op
  }

  /**
   * Register a message handler for a method.
   */
  protected on(method: string, handler: MessageHandlerFn): void {
    requireNonEmpty(method, 'method');
    this.handlers.set(method, handler);
  }

  /**
   * Remove a message handler for a method.
   */
  protected off(method: string): void {
    this.handlers.delete(method);
  }

  /**
   * Notify all dependents of a change (Smalltalk changed: protocol).
   * Sends a 'changed' event message to each dependent via the bus.
   */
  protected changed(aspect: string, value?: unknown): void {
    for (const depId of this.dependents) {
      this.send(event(this.id, depId, 'changed', {
        aspect,
        value,
      }));
    }
  }

  /**
   * Send a message to another object (synchronous — bus never blocks).
   */
  protected send(message: AbjectMessage): void {
    require(this._bus !== undefined, 'Object not initialized');
    require(this._status === 'ready' || this._status === 'busy', 'Object not ready');

    this.lastActivity = Date.now();
    this._bus!.send(message);
  }

  /**
   * Send a request and wait for reply.
   */
  protected async request<T>(
    message: AbjectMessage,
    timeoutMs = 30000
  ): Promise<T> {
    require(message.header.type === 'request', 'Must be a request message');

    return new Promise((resolve, reject) => {
      const target = message.routing.to;
      const method = message.routing.method ?? '?';
      const timeoutMsg =
        `Request timeout after ${timeoutMs}ms: ${this.manifest.name}(${this.id}) → ${target} ${method}`;

      const timeout = setTimeout(() => {
        this.pendingReplies.delete(message.header.messageId);
        log.warn(`[${this.manifest.name}:${this.id.slice(0, 8)}] TIMEOUT (no progress for ${timeoutMs}ms) → ${target.slice(0, 8)} ${method}`);
        reject(new Error(timeoutMsg));
      }, timeoutMs);

      this.pendingReplies.set(message.header.messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        timeoutMs,
        timeoutMsg,
        targetId: target,
      });

      try {
        this.send(message);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Reset the timeout on a pending request. Used for heartbeat-style keep-alive
   * when the callee sends progress events during long-running operations.
   */
  protected resetRequestTimeout(messageId: string): boolean {
    const entry = this.pendingReplies.get(messageId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      this.pendingReplies.delete(messageId);
      log.warn(`[${this.manifest.name}:${this.id.slice(0, 8)}] TIMEOUT (no progress for ${entry.timeoutMs}ms) ${entry.timeoutMsg}`);
      entry.reject(new Error(entry.timeoutMsg));
    }, entry.timeoutMs);
    return true;
  }

  /**
   * Reject all pending request replies whose target matches `targetId`.
   * Useful when an external signal indicates the target can no longer
   * deliver a reply, so the caller should not wait for its stall timer
   * to expire.
   */
  protected rejectPendingRequestsTo(targetId: AbjectId, error: Error): number {
    let count = 0;
    for (const [msgId, entry] of this.pendingReplies) {
      if (entry.targetId === targetId) {
        clearTimeout(entry.timeout);
        this.pendingReplies.delete(msgId);
        entry.reject(error);
        count++;
      }
    }
    return count;
  }

  /**
   * Send a deferred reply to a request whose auto-reply was suppressed via DEFERRED_REPLY.
   */
  protected sendDeferredReply(originalMessage: AbjectMessage, result: unknown): void {
    this.send(reply(originalMessage, result !== undefined ? result : null));
  }

  /**
   * Show a modal confirmation dialog. Returns true if the user confirmed, false otherwise.
   * Falls back to true (confirmed) if no WidgetManager is available.
   */
  protected async confirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }): Promise<boolean> {
    const wmId = await this.discoverDep('WidgetManager');
    if (!wmId) return true; // no UI → default to confirmed
    return this.request<boolean>(
      request(this.id, wmId, 'showConfirmDialog', opts),
      60000 // 60s timeout for user think time
    );
  }

  /**
   * Handle an incoming message from the processing loop (synchronous).
   *
   * Calls the handler but never awaits it. If the handler returns a Promise
   * (async), the reply is auto-sent when the Promise resolves. If the handler
   * returns a value (sync), the reply is sent immediately. This makes every
   * async handler implicitly non-blocking (Erlang-style deferred work).
   */
  private handleMessage(message: AbjectMessage): void {
    if (message === undefined) {
      log.error(`[${this.id}] handleMessage called with undefined message`);
      return;
    }

    this.lastActivity = Date.now();

    // Auto-update cached theme on themeChanged events from Theme object
    if (message.routing.from === this._themeId
        && message.routing.method === 'changed'
        && message.header.type === 'event') {
      const payload = message.payload as { aspect?: string; value?: unknown } | undefined;
      if (payload?.aspect === 'themeChanged' && payload.value) {
        this.theme = payload.value as ThemeData;
      }
    }

    // Save status to handle re-entrant message delivery
    const prevStatus = this._status;

    // Find handler
    const method = message.routing.method ?? '';
    const handler = this.handlers.get(method) ?? this.handlers.get('*');

    if (!handler) {
      if (isRequest(message)) {
        this.send(
          error(message, 'METHOD_NOT_FOUND', `No handler for method: ${method}`)
        );
      }
      return;
    }

    // Execute handler — don't await
    this._status = 'busy';
    this._handlerCount++;

    // Track request handling so progress events received during the handler
    // can be bubbled back to the originator.
    const isReq = isRequest(message);
    if (isReq) this._handlingRequestSenders.add(message.routing.from);

    const cleanupHandling = () => {
      if (isReq) this._handlingRequestSenders.delete(message.routing.from);
    };

    let result: unknown;
    try {
      result = handler(message); // Call handler — don't await
    } catch (err) {
      // Sync handler threw — send error reply immediately
      this._handlerCount--;
      cleanupHandling();
      this.errorCount++;
      this.lastError = {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };

      if (this._stoppedDuringHandler) {
        this._stoppedDuringHandler = false;
        if (isRequest(message) && this._bus) {
          try { this._bus.send(errorFromException(message, err)); } catch { /* bus gone */ }
        }
        this._processingLoop = undefined;
        log.error(`[${this.manifest.name}:${this.id}] Error handling message (method=${message.routing.method}):`, err);
        return;
      }

      if (isRequest(message)) {
        try { this.send(errorFromException(message, err)); } catch (sendErr) {
          log.error(`[${this.id}] Failed to send error reply:`, sendErr);
        }
      }
      if (prevStatus !== 'busy') this._status = 'error';
      log.error(`[${this.manifest.name}:${this.id}] Error handling message (method=${message.routing.method}):`, err);
      return;
    }

    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      // Async handler — reply when Promise resolves (non-blocking).
      // Use thenable check instead of instanceof to handle cross-realm Promises
      // (e.g. from vm.createContext sandboxes used by ScriptableAbject).
      (result as Promise<unknown>).then(
        (val) => {
          this._handlerCount--;
          cleanupHandling();

          if (this._stoppedDuringHandler) {
            this._stoppedDuringHandler = false;
            if (isRequest(message) && this._bus && val !== DEFERRED_REPLY) {
              try { this._bus.send(reply(message, val !== undefined ? val : null)); } catch { /* bus gone */ }
            }
            this._processingLoop = undefined;
            return;
          }

          this._status = prevStatus === 'busy' ? 'busy' : 'ready';

          if (isRequest(message) && val !== DEFERRED_REPLY) {
            this.send(reply(message, val !== undefined ? val : null));
          }

          try { this.checkInvariants(); } catch (err) {
            log.error(`[${this.id}] Invariant violation after message handling:`, err);
            this.errorCount++;
            if ((this._status as string) !== 'stopped') this._status = 'error';
          }
        },
        (err) => {
          this._handlerCount--;
          cleanupHandling();
          this.errorCount++;
          this.lastError = {
            code: 'HANDLER_ERROR',
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          };

          if (this._stoppedDuringHandler) {
            this._stoppedDuringHandler = false;
            if (isRequest(message) && this._bus) {
              try { this._bus.send(errorFromException(message, err)); } catch { /* bus gone */ }
            }
            this._processingLoop = undefined;
            log.error(`[${this.manifest.name}:${this.id}] Error handling message (method=${message.routing.method}):`, err);
            return;
          }

          if (isRequest(message)) {
            // If the object is already stopped, this.send()'s status
            // precondition rejects. Route the error reply through the bus
            // directly so the caller's request() doesn't hang 30s waiting
            // for a reply. This can happen when stop() is called from a
            // sibling handler and then a concurrent handler errors out
            // AFTER _stoppedDuringHandler has been cleared by the first
            // handler's completion.
            const sendError = errorFromException(message, err);
            try {
              if ((this._status as string) === 'stopped' && this._bus) {
                this._bus.send(sendError);
              } else {
                this.send(sendError);
              }
            } catch (sendErr) {
              // Last-chance fallback: try the bus directly before giving up.
              try { this._bus?.send(sendError); }
              catch { log.error(`[${this.id}] Failed to send error reply:`, sendErr); }
            }
          }
          if (prevStatus !== 'busy') this._status = 'error';
          log.error(`[${this.manifest.name}:${this.id}] Error handling message (method=${message.routing.method}):`, err);
        },
      );
    } else {
      // Sync handler — reply immediately
      this._handlerCount--;
      // Note: for DEFERRED_REPLY the work is async via sendDeferredReply,
      // but we still clear here since the handler invocation itself returned.
      // Progress events from the deferred work won't bubble through this Abject,
      // which is acceptable -- the work runs independently.
      cleanupHandling();

      if (this._stoppedDuringHandler) {
        this._stoppedDuringHandler = false;
        if (isRequest(message) && this._bus && result !== DEFERRED_REPLY) {
          try { this._bus.send(reply(message, result !== undefined ? result : null)); } catch { /* bus gone */ }
        }
        this._processingLoop = undefined;
        return;
      }

      this._status = prevStatus === 'busy' ? 'busy' : 'ready';

      if (isRequest(message) && result !== DEFERRED_REPLY) {
        this.send(reply(message, result !== undefined ? result : null));
      }

      try { this.checkInvariants(); } catch (err) {
        log.error(`[${this.id}] Invariant violation after message handling:`, err);
        this.errorCount++;
        if ((this._status as string) !== 'stopped') this._status = 'error';
      }
    }
  }

  /**
   * Check class invariants.
   */
  protected checkInvariants(): void {
    invariant(this.id !== '', 'id must not be empty');
    invariant(this.manifest !== undefined, 'manifest must be defined');
    invariant(this.errorCount >= 0, 'errorCount must be non-negative');
    invariant(this.startedAt > 0, 'startedAt must be positive');
    invariant(this.lastActivity >= this.startedAt, 'lastActivity must be >= startedAt');
  }
}

/**
 * Simple object that can be created with just handlers.
 */
export class SimpleAbject extends Abject {
  constructor(
    name: string,
    description: string,
    handlers: Record<string, MessageHandlerFn>,
    options: Partial<AbjectOptions> = {}
  ) {
    super({
      manifest: {
        name,
        description,
        version: '1.0.0',
        interface: { id: 'abjects:simple' as InterfaceId, name: 'Simple', description, methods: [] },
        requiredCapabilities: [],
        ...options.manifest,
      },
      capabilities: options.capabilities,
      initialState: options.initialState,
    });

    for (const [method, handler] of Object.entries(handlers)) {
      this.on(method, handler);
    }
  }
}
