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
  private _insideHandler = false;
  private _stoppedDuringHandler = false;
  protected handlers: Map<string, MessageHandlerFn> = new Map();
  private dependents: Set<AbjectId> = new Set();
  private pendingReplies: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    timeoutMs: number;
    timeoutMsg: string;
  }> = new Map();

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

    // Set up reply fast-path handler
    bus.setReplyHandler(this.id, this.handleReply.bind(this));

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
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        () => this.sendDeferredReply(msg, `[No LLM available] ${formatManifestAsDescription(this.manifest)}`).catch(() => {}),
      );

      return DEFERRED_REPLY;
    });

    this._status = 'ready';

    // Start the per-object processing loop
    this._processingLoop = this.processMessages();

    await this.onInit();

    this.checkInvariants();

    // Notify parent after full initialization
    if (this._parentId) {
      try {
        await this.send(event(this.id, this._parentId, 'childReady', {
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
   * Return source code for the ask handler. Override in ScriptableAbject.
   */
  protected getSourceForAsk(): string | undefined {
    return undefined;
  }

  /**
   * Handle an 'ask' request: use LLM if available, else fall back to manifest description.
   */
  private async handleAsk(question: string): Promise<string> {
    const manifestDesc = formatManifestAsDescription(this.manifest);
    const source = this.getSourceForAsk();

    // Try to discover LLM via Registry
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
        } catch {
          // No registry available
        }
      }

      if (regId) {
        // Discover LLM via Registry
        const results = await this.request<Array<{ id: AbjectId }>>(
          request(this.id, regId, 'discover', { name: 'LLM' })
        );

        if (results && results.length > 0) {
          const llmId = results[0].id;

          // Build context for LLM
          let context = `Object manifest:\n${manifestDesc}`;
          if (source) {
            context += `\n\nObject source code:\n${source}`;
          }

          const llmResult = await this.request<{ content: string }>(
            request(this.id, llmId, 'complete', {
              messages: [
                { role: 'system', content: `You are answering questions about an object in the Abjects system. Use the provided manifest and source code to give accurate, concise answers.\n\n${context}` },
                { role: 'user', content: question },
              ],
              options: { tier: 'fast' },
            }),
            60000
          );

          return llmResult.content;
        }
      }
    } catch {
      // LLM not available or failed — fall back
    }

    return `[No LLM available] ${manifestDesc}`;
  }

  /**
   * Per-object processing loop. Pulls messages from mailbox and handles them.
   * Runs until the object is stopped.
   */
  private async processMessages(): Promise<void> {
    const isStopped = () => (this._status as string) === 'stopped';
    while (!isStopped()) {
      let msg: AbjectMessage;
      try {
        msg = await this._mailbox!.receive();
      } catch {
        break; // Mailbox closed — exit loop
      }
      if (isStopped()) break;
      try {
        await this.handleMessage(msg);
      } catch (err) {
        log.error(`[${this.id}] Processing loop error:`, err);
      }
    }
  }

  /**
   * Handle a reply/error message via the fast-path (called by bus, not via mailbox).
   * Resolves the pending Promise for the corresponding request.
   */
  private handleReply(message: AbjectMessage): void {
    const pending = this.pendingReplies.get(message.header.correlationId!);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingReplies.delete(message.header.correlationId!);

      if (isError(message)) {
        const err = message.payload as AbjectError;
        pending.reject(new Error(`${err.code}: ${err.message}`));
      } else {
        pending.resolve(message.payload);
      }
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
    if (this._insideHandler) {
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
  protected async changed(aspect: string, value?: unknown): Promise<void> {
    for (const depId of this.dependents) {
      await this.send(event(this.id, depId, 'changed', {
        aspect,
        value,
      }));
    }
  }

  /**
   * Send a message to another object.
   */
  protected async send(message: AbjectMessage): Promise<void> {
    require(this._bus !== undefined, 'Object not initialized');
    require(this._status === 'ready' || this._status === 'busy', 'Object not ready');

    this.lastActivity = Date.now();
    await this._bus!.send(message);
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
        reject(new Error(timeoutMsg));
      }, timeoutMs);

      this.pendingReplies.set(message.header.messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        timeoutMs,
        timeoutMsg,
      });

      this.send(message).catch(reject);
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
      entry.reject(new Error(entry.timeoutMsg));
    }, entry.timeoutMs);
    return true;
  }

  /**
   * Send a deferred reply to a request whose auto-reply was suppressed via DEFERRED_REPLY.
   */
  protected async sendDeferredReply(originalMessage: AbjectMessage, result: unknown): Promise<void> {
    await this.send(reply(originalMessage, result !== undefined ? result : null));
  }

  /**
   * Handle an incoming message from the processing loop.
   * Replies are handled via handleReply() fast-path, not here.
   */
  private async handleMessage(message: AbjectMessage): Promise<void> {
    if (message === undefined) {
      log.error(`[${this.id}] handleMessage called with undefined message`);
      return;
    }

    this.lastActivity = Date.now();

    // Save status to handle re-entrant message delivery
    const prevStatus = this._status;

    try {
      // Find handler
      const method = message.routing.method ?? '';
      const handler = this.handlers.get(method) ?? this.handlers.get('*');

      if (!handler) {
        if (isRequest(message)) {
          await this.send(
            error(message, 'METHOD_NOT_FOUND', `No handler for method: ${method}`)
          );
        }
        return;
      }

      // Execute handler (track _insideHandler for stop() deadlock avoidance)
      this._status = 'busy';
      this._insideHandler = true;
      let result: unknown;
      try {
        result = await handler(message);
      } finally {
        this._insideHandler = false;
      }

      // If stop() was called during the handler, finalize deferred cleanup
      if (this._stoppedDuringHandler) {
        this._stoppedDuringHandler = false;

        // Send the reply directly via the bus (this.send() rejects on stopped status)
        if (isRequest(message) && this._bus && result !== DEFERRED_REPLY) {
          try {
            await this._bus.send(reply(message, result !== undefined ? result : null));
          } catch {
            // Bus may already have unregistered — that's OK
          }
        }

        // Finalize deferred cleanup (bus.unregister already done in stop())
        this._processingLoop = undefined;
        return; // Skip invariant check — the object is dead
      }

      this._status = prevStatus === 'busy' ? 'busy' : 'ready';

      // Send reply if this was a request (skip if handler returned DEFERRED_REPLY)
      if (isRequest(message) && result !== DEFERRED_REPLY) {
        await this.send(reply(message, result !== undefined ? result : null));
      }
    } catch (err) {
      this.errorCount++;
      this.lastError = {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };

      // If stop() was called during the handler that threw, finalize deferred cleanup
      if (this._stoppedDuringHandler) {
        this._stoppedDuringHandler = false;

        // Send error reply directly via bus
        if (isRequest(message) && this._bus) {
          try {
            await this._bus.send(errorFromException(message, err));
          } catch {
            // Bus may already have unregistered
          }
        }

        // Finalize deferred cleanup (bus.unregister already done in stop())
        this._processingLoop = undefined;
        log.error(`[${this.manifest.name}:${this.id}] Error handling message (method=${message.routing.method}):`, err);
        return;
      }

      // Send error reply while status is still 'busy' (send requires 'ready' or 'busy')
      if (isRequest(message)) {
        try {
          await this.send(errorFromException(message, err));
        } catch (sendErr) {
          log.error(`[${this.id}] Failed to send error reply:`, sendErr);
        }
      }

      // Only set error status if this is the outermost handler (not re-entrant)
      if (prevStatus !== 'busy') {
        this._status = 'error';
      }
      log.error(`[${this.manifest.name}:${this.id}] Error handling message (method=${message.routing.method}):`, err);
    }

    try {
      this.checkInvariants();
    } catch (err) {
      log.error(`[${this.id}] Invariant violation after message handling:`, err);
      this.errorCount++;
      if (this._status !== 'stopped') {
        this._status = 'error';
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
