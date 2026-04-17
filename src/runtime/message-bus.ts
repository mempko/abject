/**
 * Message bus for routing messages between local objects.
 *
 * Non-blocking design: send() enqueues messages in the recipient's mailbox
 * and returns immediately. Each object runs its own processing loop.
 * All messages (including replies) flow through the mailbox.
 */

import { AbjectMessage, AbjectId, AbjectError } from '../core/types.js';
import { require, ensure, invariant, requireNonEmpty } from '../core/contracts.js';
import { request as createRequest, error as createError, resetSequence } from '../core/message.js';
import { Mailbox } from './mailbox.js';
import type { WorkerPool } from './worker-pool.js';
import type { WorkerBridge } from './worker-bridge.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MessageBus');

export type MessageHandler = (message: AbjectMessage) => void | Promise<void>;

/**
 * The subset of MessageBus that Abject.init() depends on.
 * Both MessageBus (main thread) and WorkerBus (worker thread) implement this.
 */
export interface MessageBusLike {
  register(objectId: AbjectId): Mailbox;
  unregister(objectId: AbjectId): void;
  send(message: AbjectMessage): void;
  isRegistered(objectId: AbjectId): boolean;
}

interface Subscription {
  id: string;
  objectId: AbjectId;
  handler: MessageHandler;
}

/**
 * Central message routing for local objects.
 *
 * Non-blocking: send() enqueues in mailbox, never awaits handler completion.
 * All messages (including replies) are delivered via mailbox.
 */
export class MessageBus implements MessageBusLike {
  private mailboxes: Map<AbjectId, Mailbox> = new Map();
  private subscriptions: Subscription[] = [];
  private interceptors: MessageInterceptor[] = [];
  private messageCount = 0;
  private _running = false;

  // Worker parallelism — set of object IDs hosted in workers
  private workerObjects: Set<AbjectId> = new Set();
  private _workerPool?: WorkerPool;

  // Dedicated worker bridges (UI, P2P) — registered separately from the pool
  private dedicatedBridges: Map<AbjectId, WorkerBridge> = new Map();

  /**
   * Register an object with the bus. Creates a mailbox for the object.
   */
  register(objectId: AbjectId): Mailbox {
    requireNonEmpty(objectId, 'objectId');
    require(!this.mailboxes.has(objectId), `Object ${objectId} already registered`);

    const mailbox = new Mailbox();
    this.mailboxes.set(objectId, mailbox);

    this.checkInvariants();
    return mailbox;
  }

  /**
   * Unregister an object from the bus.
   */
  unregister(objectId: AbjectId): void {
    requireNonEmpty(objectId, 'objectId');

    const mailbox = this.mailboxes.get(objectId);
    if (mailbox) {
      mailbox.close();
    }

    this.mailboxes.delete(objectId);

    // Remove subscriptions for this object
    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.objectId !== objectId
    );

    resetSequence(objectId);

    this.checkInvariants();
  }

  /**
   * Check if an object is registered (locally or in a worker).
   */
  isRegistered(objectId: AbjectId): boolean {
    return this.mailboxes.has(objectId) || this.workerObjects.has(objectId);
  }

  /**
   * Get all registered object IDs.
   */
  getRegisteredObjects(): AbjectId[] {
    return Array.from(this.mailboxes.keys());
  }

  /**
   * Send a message to a target object (non-blocking).
   * All messages (including replies) are delivered via the recipient's mailbox.
   */
  send(message: AbjectMessage): void {
    // Run interceptors synchronously
    for (const interceptor of this.interceptors) {
      const result = interceptor.intercept(message);
      if (result === 'drop') {
        return;
      }
      if (result !== 'pass') {
        message = result;
      }
    }

    const recipient = message.routing.to;

    // Worker routing: if recipient is in a worker, forward via bridge
    if (this.workerObjects.has(recipient)) {
      const bridge = this.getBridgeForObject(recipient);
      if (bridge) {
        bridge.deliverMessage(message);
        this.messageCount++;
        return;
      }
      log.warn(`UNDELIVERABLE (no worker bridge): ${message.header.type} ${message.routing.method ?? '?'} from=${message.routing.from.slice(0,8)} to=${recipient.slice(0,8)}`);
      this.notifyUndeliverable(message);
      return;
    }

    // Check if recipient exists locally
    if (!recipient || !this.mailboxes.has(recipient)) {
      log.warn(`UNDELIVERABLE: ${message.header.type} ${message.routing.method ?? '?'} from=${message.routing.from?.slice(0,8) ?? '?'} to=${recipient?.slice(0,8) ?? 'undefined'} (not registered)`);

      // For undeliverable requests, send an error reply to the sender's
      // mailbox so request() rejects instantly instead of timing out.
      if (message.header.type === 'request') {
        const sender = message.routing.from;
        const errorReply = createError(
          message,
          'RECIPIENT_NOT_FOUND',
          `Recipient ${recipient} is not registered`,
        );
        const senderMailbox = this.mailboxes.get(sender);
        if (senderMailbox) {
          senderMailbox.send(errorReply);
          this.messageCount++;
        } else if (this.workerObjects.has(sender)) {
          const senderBridge = this.getBridgeForObject(sender);
          if (senderBridge) {
            senderBridge.deliverMessage(errorReply);
            this.messageCount++;
          }
        }
      }

      this.notifyUndeliverable(message);
      return;
    }

    // Deliver to mailbox (non-blocking)
    const mailbox = this.mailboxes.get(recipient)!;
    mailbox.send(message);
    this.messageCount++;
  }

  /**
   * Subscribe to all messages (for monitoring, debugging).
   */
  subscribe(objectId: AbjectId, handler: MessageHandler): string {
    requireNonEmpty(objectId, 'objectId');

    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.subscriptions.push({ id, objectId, handler });
    return id;
  }

  /**
   * Unsubscribe from messages.
   */
  unsubscribe(subscriptionId: string): void {
    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.id !== subscriptionId
    );
  }

  /**
   * Add a message interceptor.
   */
  addInterceptor(interceptor: MessageInterceptor): void {
    this.interceptors.push(interceptor);
  }

  /**
   * Remove a message interceptor.
   */
  removeInterceptor(interceptor: MessageInterceptor): void {
    const idx = this.interceptors.indexOf(interceptor);
    if (idx >= 0) {
      this.interceptors.splice(idx, 1);
    }
  }

  /**
   * Tear down bus state. Closes every mailbox and drops all interceptors,
   * subscriptions, worker-routing entries, and the undeliverable handler so
   * a fresh Runtime instance cannot inherit stale references.
   */
  stop(): void {
    for (const mailbox of this.mailboxes.values()) {
      mailbox.close();
    }
    this.mailboxes.clear();
    this.subscriptions = [];
    this.interceptors = [];
    this.workerObjects.clear();
    this.dedicatedBridges.clear();
    this._undeliverableHandler = undefined;
    this._workerPool = undefined;
    this._running = false;
  }

  /**
   * Get the mailbox for an object.
   */
  getMailbox(objectId: AbjectId): Mailbox | undefined {
    return this.mailboxes.get(objectId);
  }

  /**
   * Get the total message count.
   */
  get totalMessages(): number {
    return this.messageCount;
  }

  /**
   * Get the number of registered objects.
   */
  get objectCount(): number {
    return this.mailboxes.size;
  }

  /**
   * Set the worker pool for cross-worker message routing.
   */
  setWorkerPool(pool: WorkerPool): void {
    this._workerPool = pool;
  }

  /**
   * Register an object ID as worker-hosted (lives in a Web Worker, not main thread).
   */
  registerWorkerObject(objectId: AbjectId): void {
    this.workerObjects.add(objectId);
  }

  /**
   * Unregister a worker-hosted object.
   */
  unregisterWorkerObject(objectId: AbjectId): void {
    this.workerObjects.delete(objectId);
  }

  /**
   * Check if an object is hosted in a worker.
   */
  isWorkerObject(objectId: AbjectId): boolean {
    return this.workerObjects.has(objectId);
  }

  /**
   * Register a dedicated worker bridge for a specific object ID.
   * Used for dedicated workers (UI, P2P) that are not part of the WorkerPool.
   */
  registerDedicatedBridge(objectId: AbjectId, bridge: WorkerBridge): void {
    this.dedicatedBridges.set(objectId, bridge);
    this.workerObjects.add(objectId);
  }

  /**
   * Unregister a dedicated worker bridge.
   */
  unregisterDedicatedBridge(objectId: AbjectId): void {
    this.dedicatedBridges.delete(objectId);
    this.workerObjects.delete(objectId);
  }

  /**
   * Find the bridge for a worker-hosted object (dedicated or pool).
   */
  private getBridgeForObject(objectId: AbjectId): WorkerBridge | undefined {
    return this.dedicatedBridges.get(objectId) ?? this._workerPool?.getBridgeForObject(objectId);
  }

  private _undeliverableHandler?: (message: AbjectMessage) => void;

  /**
   * Set a handler for undeliverable messages.
   * Used by PeerRouter to catch messages for remote objects that aren't
   * yet in the routing table (late discovery).
   */
  setUndeliverableHandler(handler: (message: AbjectMessage) => void): void {
    this._undeliverableHandler = handler;
  }

  /**
   * Remove the undeliverable handler.
   */
  removeUndeliverableHandler(): void {
    this._undeliverableHandler = undefined;
  }

  /**
   * Notify that a message couldn't be delivered locally.
   * Network layer can intercept this.
   */
  private notifyUndeliverable(message: AbjectMessage): void {
    // Fire dedicated handler (PeerRouter)
    if (this._undeliverableHandler) {
      this._undeliverableHandler(message);
    }

    // Emit to subscriptions
    for (const sub of this.subscriptions) {
      if (sub.objectId === '*' || sub.objectId === 'undeliverable') {
        Promise.resolve(sub.handler(message)).catch((err) => log.error('Subscription handler error:', err));
      }
    }
  }

  /**
   * Check class invariants.
   */
  private checkInvariants(): void {
    invariant(this.mailboxes.size >= 0, 'mailbox count must be non-negative');
    invariant(this.messageCount >= 0, 'message count must be non-negative');
  }
}

/**
 * Message interceptor for transforming or filtering messages.
 */
export interface MessageInterceptor {
  /**
   * Intercept a message before delivery (synchronous — bus never awaits).
   * Return 'pass' to deliver unchanged, 'drop' to discard,
   * or a new message to deliver instead.
   */
  intercept(message: AbjectMessage): 'pass' | 'drop' | AbjectMessage;
}

/**
 * Logging interceptor for debugging.
 */
export class LoggingInterceptor implements MessageInterceptor {
  private readonly _log: Log;
  constructor(
    prefix: string = 'MSG',
    private readonly filter?: (msg: AbjectMessage) => boolean
  ) {
    this._log = new Log(prefix.replace(/^\[|\]$/g, ''));
  }

  intercept(message: AbjectMessage): 'pass' {
    if (!this.filter || this.filter(message)) {
      this._log.info(
        `${message.header.type} ` +
          `${message.routing.from} -> ${message.routing.to} ` +
          `[${message.routing.method ?? ''}]`
      );
    }
    return 'pass';
  }
}

/**
 * Proxy interceptor that routes messages through a proxy.
 */
export class ProxyInterceptor implements MessageInterceptor {
  constructor(
    private readonly sourceId: AbjectId,
    private readonly targetId: AbjectId,
    private readonly proxyId: AbjectId
  ) {}

  intercept(message: AbjectMessage): 'pass' | AbjectMessage {
    // Route messages between source and target through proxy
    if (
      message.routing.from === this.sourceId &&
      message.routing.to === this.targetId
    ) {
      return {
        ...message,
        routing: {
          ...message.routing,
          to: this.proxyId,
        },
      };
    }
    if (
      message.routing.from === this.targetId &&
      message.routing.to === this.sourceId
    ) {
      return {
        ...message,
        routing: {
          ...message.routing,
          to: this.proxyId,
        },
      };
    }
    return 'pass';
  }
}

/**
 * Health interceptor that passively watches for error messages on tracked connections
 * and reports them to the HealthMonitor via message passing.
 */
export class HealthInterceptor implements MessageInterceptor {
  private trackedPairs: Map<string, string> = new Map(); // "from-to" → agreementId

  constructor(
    private readonly healthMonitorId: AbjectId,
    private readonly bus: MessageBus
  ) {}

  /**
   * Track a connection pair for health monitoring.
   */
  track(sourceId: AbjectId, targetId: AbjectId, agreementId: string): void {
    this.trackedPairs.set(`${sourceId}-${targetId}`, agreementId);
    this.trackedPairs.set(`${targetId}-${sourceId}`, agreementId);
  }

  /**
   * Stop tracking a connection pair.
   */
  untrack(sourceId: AbjectId, targetId: AbjectId): void {
    this.trackedPairs.delete(`${sourceId}-${targetId}`);
    this.trackedPairs.delete(`${targetId}-${sourceId}`);
  }

  intercept(message: AbjectMessage): 'pass' {
    const pairKey = `${message.routing.from}-${message.routing.to}`;
    const agreementId = this.trackedPairs.get(pairKey);

    if (agreementId) {
      // Self-report: sender is the HealthMonitor itself, since this is its
      // own observation of the bus. Avoids a forged 'health-interceptor' id
      // that isn't registered anywhere.
      if (message.header.type === 'error') {
        const errorPayload = message.payload as AbjectError;
        this.bus.send(
          createRequest(
            this.healthMonitorId,
            this.healthMonitorId,
            'recordError',
            { agreementId, error: errorPayload }
          )
        );
      } else if (message.header.type === 'reply') {
        this.bus.send(
          createRequest(
            this.healthMonitorId,
            this.healthMonitorId,
            'recordSuccess',
            { agreementId }
          )
        );
      }
    }

    return 'pass';
  }
}
