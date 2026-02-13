/**
 * Base Abject class - the fundamental object in the system.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AbjectId,
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
import { MessageBus } from '../runtime/message-bus.js';
import { CapabilitySet, getDefaultCapabilities } from './capability.js';
import { INTROSPECT_INTERFACE, INTROSPECT_INTERFACE_ID, formatManifestAsDescription } from './introspect.js';
import type { InterfaceId } from './types.js';

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
 */
export abstract class Abject {
  readonly id: AbjectId;
  readonly manifest: AbjectManifest;
  readonly capabilities: CapabilitySet;

  protected state: unknown;
  protected _status: AbjectState = 'initializing';
  protected errorCount = 0;
  protected lastError?: AbjectError;
  protected readonly startedAt: number;
  protected lastActivity: number;

  private _bus?: MessageBus;
  private _mailbox?: Mailbox;
  private _parentId?: AbjectId;
  private _registryId?: AbjectId;
  private handlers: Map<string, MessageHandlerFn> = new Map();
  private dependents: Set<AbjectId> = new Set();
  private pendingReplies: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  constructor(options: AbjectOptions) {
    require(options.manifest !== undefined, 'manifest is required');
    requireNonEmpty(options.manifest.name, 'manifest.name');

    this.id = uuidv4();
    // Append the introspect interface to every Abject's manifest
    const hasIntrospect = options.manifest.interfaces.some(
      (i) => i.id === INTROSPECT_INTERFACE_ID
    );
    this.manifest = hasIntrospect
      ? options.manifest
      : {
          ...options.manifest,
          interfaces: [...options.manifest.interfaces, INTROSPECT_INTERFACE],
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
  protected get bus(): MessageBus {
    require(this._bus !== undefined, 'Object not initialized');
    return this._bus!;
  }

  /**
   * Initialize the object. Called after registration with the bus.
   */
  async init(bus: MessageBus, parentId?: AbjectId): Promise<void> {
    require(this._status === 'initializing', 'Object must be initializing');
    require(this._bus === undefined, 'Object already initialized');

    this._bus = bus;
    this._parentId = parentId;
    this._mailbox = bus.register(this.id, this.handleMessage.bind(this));

    // Register the introspect handler on every Abject
    this.on('describe', () => ({
      manifest: this.manifest,
      description: formatManifestAsDescription(this.manifest),
    }));

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
            request(this.id, this._parentId, INTROSPECT_INTERFACE_ID, 'getRegistry', {})
          );
          if (id) this._registryId = id as AbjectId;
          return id;
        } catch {
          return null;
        }
      }
      return null;
    });

    // LLM-powered ask handler
    this.on('ask', async (msg: AbjectMessage) => {
      const { question } = msg.payload as { question: string };
      return this.handleAsk(question);
    });

    this._status = 'ready';

    await this.onInit();

    this.checkInvariants();

    // Notify parent after full initialization
    if (this._parentId) {
      try {
        await this.send(event(this.id, this._parentId, INTROSPECT_INTERFACE_ID, 'childReady', {
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
   */
  protected getRegistryId(): AbjectId | undefined {
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
          request(this.id, this._parentId, INTROSPECT_INTERFACE_ID, 'getRegistry', {})
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
      request(this.id, regId, 'abjects:registry' as InterfaceId, 'discover', { name })
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
            request(this.id, this._parentId, INTROSPECT_INTERFACE_ID, 'getRegistry', {})
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
          request(this.id, regId, 'abjects:registry' as InterfaceId, 'discover', { name: 'LLM' })
        );

        if (results && results.length > 0) {
          const llmId = results[0].id;

          // Build context for LLM
          let context = `Object manifest:\n${manifestDesc}`;
          if (source) {
            context += `\n\nObject source code:\n${source}`;
          }

          const llmResult = await this.request<{ content: string }>(
            request(this.id, llmId, 'abjects:llm' as InterfaceId, 'complete', {
              messages: [
                { role: 'system', content: `You are answering questions about an object in the Abjects system. Use the provided manifest and source code to give accurate, concise answers.\n\n${context}` },
                { role: 'user', content: question },
              ],
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
   * Stop the object.
   */
  async stop(): Promise<void> {
    this._status = 'stopped';
    await this.onStop();

    if (this._bus) {
      this._bus.unregister(this.id);
    }

    // Clear dependents
    this.dependents.clear();

    // Reject all pending replies
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Object stopped'));
    }
    this.pendingReplies.clear();
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
      await this.send(event(this.id, depId, INTROSPECT_INTERFACE_ID, 'changed', {
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
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(message.header.messageId);
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingReplies.set(message.header.messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.send(message).catch(reject);
    });
  }

  /**
   * Handle an incoming message.
   */
  private async handleMessage(message: AbjectMessage): Promise<void> {
    if (message === undefined) {
      console.error(`[${this.id}] handleMessage called with undefined message`);
      return;
    }

    this.lastActivity = Date.now();

    // Save status to handle re-entrant message delivery (the message bus
    // may call handleMessage recursively when a handler sends a message
    // whose recipient sends a message back to this object).
    const prevStatus = this._status;

    try {
      // Check for reply to pending request
      if (isReply(message) || isError(message)) {
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
          return;
        }
      }

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

      // Execute handler
      this._status = 'busy';
      const result = await handler(message);
      this._status = prevStatus === 'busy' ? 'busy' : 'ready';

      // Send reply if this was a request
      if (isRequest(message) && result !== undefined) {
        await this.send(reply(message, result));
      }
    } catch (err) {
      this.errorCount++;
      this.lastError = {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };

      // Send error reply while status is still 'busy' (send requires 'ready' or 'busy')
      if (isRequest(message)) {
        try {
          await this.send(errorFromException(message, err));
        } catch (sendErr) {
          console.error(`[${this.id}] Failed to send error reply:`, sendErr);
        }
      }

      // Only set error status if this is the outermost handler (not re-entrant)
      if (prevStatus !== 'busy') {
        this._status = 'error';
      }
      console.error(`[${this.id}] Error handling message:`, err);
    }

    try {
      this.checkInvariants();
    } catch (err) {
      console.error(`[${this.id}] Invariant violation after message handling:`, err);
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
        interfaces: [],
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
