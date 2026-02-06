/**
 * Message bus for routing messages between local objects.
 */

import { AbjectMessage, AbjectId, AbjectError, InterfaceId } from '../core/types.js';
import { require, ensure, invariant, requireNonEmpty } from '../core/contracts.js';
import { request as createRequest } from '../core/message.js';
import { Mailbox } from './mailbox.js';

export type MessageHandler = (message: AbjectMessage) => void | Promise<void>;

interface Subscription {
  id: string;
  objectId: AbjectId;
  handler: MessageHandler;
}

/**
 * Central message routing for local objects.
 */
export class MessageBus {
  private mailboxes: Map<AbjectId, Mailbox> = new Map();
  private handlers: Map<AbjectId, MessageHandler> = new Map();
  private subscriptions: Subscription[] = [];
  private interceptors: MessageInterceptor[] = [];
  private messageCount = 0;
  private _running = false;

  /**
   * Register an object with the bus.
   */
  register(objectId: AbjectId, handler: MessageHandler): Mailbox {
    requireNonEmpty(objectId, 'objectId');
    require(!this.mailboxes.has(objectId), `Object ${objectId} already registered`);

    const mailbox = new Mailbox();
    this.mailboxes.set(objectId, mailbox);
    this.handlers.set(objectId, handler);

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
    this.handlers.delete(objectId);

    // Remove subscriptions for this object
    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.objectId !== objectId
    );

    this.checkInvariants();
  }

  /**
   * Check if an object is registered.
   */
  isRegistered(objectId: AbjectId): boolean {
    return this.mailboxes.has(objectId);
  }

  /**
   * Get all registered object IDs.
   */
  getRegisteredObjects(): AbjectId[] {
    return Array.from(this.mailboxes.keys());
  }

  /**
   * Send a message to a target object.
   */
  async send(message: AbjectMessage): Promise<void> {
    const oldCount = this.messageCount;

    // Preconditions
    require(message.header.messageId !== '', 'messageId must not be empty');
    requireNonEmpty(message.routing.to, 'recipient');

    // Run interceptors
    for (const interceptor of this.interceptors) {
      const result = await interceptor.intercept(message);
      if (result === 'drop') {
        return;
      }
      if (result !== 'pass') {
        message = result;
      }
    }

    const recipient = message.routing.to;

    // Check if recipient exists locally
    if (!this.mailboxes.has(recipient)) {
      // Could be a remote object - emit event for network layer
      this.notifyUndeliverable(message);
      return;
    }

    // Deliver to mailbox
    const mailbox = this.mailboxes.get(recipient)!;
    mailbox.send(message);
    this.messageCount++;

    // Invoke handler directly if available
    const handler = this.handlers.get(recipient);
    if (handler) {
      const msg = mailbox.tryReceive();
      if (msg) {
        await handler(msg);
      }
    }

    // Postconditions
    ensure(this.messageCount > oldCount, 'message count must increase');
    this.checkInvariants();
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
   * Notify that a message couldn't be delivered locally.
   * Network layer can intercept this.
   */
  private notifyUndeliverable(message: AbjectMessage): void {
    // Emit to subscriptions
    for (const sub of this.subscriptions) {
      if (sub.objectId === '*' || sub.objectId === 'undeliverable') {
        Promise.resolve(sub.handler(message)).catch(console.error);
      }
    }
  }

  /**
   * Check class invariants.
   */
  private checkInvariants(): void {
    invariant(this.mailboxes.size >= 0, 'mailbox count must be non-negative');
    invariant(
      this.mailboxes.size === this.handlers.size,
      'mailbox and handler counts must match'
    );
    invariant(this.messageCount >= 0, 'message count must be non-negative');
  }
}

/**
 * Message interceptor for transforming or filtering messages.
 */
export interface MessageInterceptor {
  /**
   * Intercept a message before delivery.
   * Return 'pass' to deliver unchanged, 'drop' to discard,
   * or a new message to deliver instead.
   */
  intercept(message: AbjectMessage): Promise<'pass' | 'drop' | AbjectMessage>;
}

/**
 * Logging interceptor for debugging.
 */
export class LoggingInterceptor implements MessageInterceptor {
  constructor(
    private readonly prefix: string = '[MSG]',
    private readonly filter?: (msg: AbjectMessage) => boolean
  ) {}

  async intercept(message: AbjectMessage): Promise<'pass'> {
    if (!this.filter || this.filter(message)) {
      console.log(
        `${this.prefix} ${message.header.type} ` +
          `${message.routing.from} -> ${message.routing.to} ` +
          `[${message.routing.interface}${message.routing.method ? '.' + message.routing.method : ''}]`
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

  async intercept(message: AbjectMessage): Promise<'pass' | AbjectMessage> {
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

  async intercept(message: AbjectMessage): Promise<'pass'> {
    const pairKey = `${message.routing.from}-${message.routing.to}`;
    const agreementId = this.trackedPairs.get(pairKey);

    if (agreementId) {
      if (message.header.type === 'error') {
        // Report error to HealthMonitor
        const errorPayload = message.payload as AbjectError;
        this.bus.send(
          createRequest(
            'health-interceptor' as AbjectId,
            this.healthMonitorId,
            'abjects:health-monitor' as InterfaceId,
            'recordError',
            { agreementId, error: errorPayload }
          )
        ).catch(() => { /* best-effort */ });
      } else if (message.header.type === 'reply') {
        // Report success to HealthMonitor
        this.bus.send(
          createRequest(
            'health-interceptor' as AbjectId,
            this.healthMonitorId,
            'abjects:health-monitor' as InterfaceId,
            'recordSuccess',
            { agreementId }
          )
        ).catch(() => { /* best-effort */ });
      }
    }

    // Always pass — we're just observing
    return 'pass';
  }
}
