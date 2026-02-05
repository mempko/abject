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
import { reply, error, errorFromException, isRequest, isReply, isError } from './message.js';
import { Mailbox } from '../runtime/mailbox.js';
import { MessageBus } from '../runtime/message-bus.js';
import { CapabilitySet, getDefaultCapabilities } from './capability.js';

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
  private handlers: Map<string, MessageHandlerFn> = new Map();
  private pendingReplies: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  constructor(options: AbjectOptions) {
    require(options.manifest !== undefined, 'manifest is required');
    requireNonEmpty(options.manifest.name, 'manifest.name');

    this.id = uuidv4();
    this.manifest = options.manifest;
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
   * Initialize the object. Called after registration with the bus.
   */
  async init(bus: MessageBus): Promise<void> {
    require(this._status === 'initializing', 'Object must be initializing');
    require(this._bus === undefined, 'Object already initialized');

    this._bus = bus;
    this._mailbox = bus.register(this.id, this.handleMessage.bind(this));

    this._status = 'ready';

    await this.onInit();

    this.checkInvariants();
  }

  /**
   * Override this to perform custom initialization.
   */
  protected async onInit(): Promise<void> {
    // Default: no-op
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

    // Reject all pending replies
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Object stopped'));
    }
    this.pendingReplies.clear();
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
    require(message !== undefined, 'message is required');

    this.lastActivity = Date.now();

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
      this._status = 'ready';

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
      this._status = 'error';

      if (isRequest(message)) {
        await this.send(errorFromException(message, err));
      }

      console.error(`[${this.id}] Error handling message:`, err);
    }

    this.checkInvariants();
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
