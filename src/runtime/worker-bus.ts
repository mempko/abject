/**
 * Worker-side message bus.
 *
 * Implements MessageBusLike and runs inside a Web Worker.
 * Local messages are delivered directly; cross-worker messages
 * are forwarded to the main thread via self.postMessage().
 */

import { AbjectMessage, AbjectId } from '../core/types.js';
import { Mailbox } from './mailbox.js';
import type { MessageBusLike, ReplyHandler } from './message-bus.js';

/** Function for posting messages back to the main thread. */
export type PostToMainFn = (data: unknown) => void;

/**
 * Message bus that runs inside a worker.
 *
 * Objects registered here get local mailboxes. When a message targets
 * an object not registered locally, it is forwarded to the main thread
 * for routing to the correct worker or main-thread object.
 *
 * Works in both Web Workers (self.postMessage) and Node.js worker_threads
 * (parentPort.postMessage) via the configurable postToMain callback.
 */
export class WorkerBus implements MessageBusLike {
  private mailboxes: Map<AbjectId, Mailbox> = new Map();
  private replyHandlers: Map<AbjectId, ReplyHandler> = new Map();
  private postToMain: PostToMainFn;

  constructor(postToMain?: PostToMainFn) {
    this.postToMain = postToMain ?? ((data: unknown) => self.postMessage(data));
  }

  /**
   * Register an object with this worker bus. Creates a local mailbox.
   */
  register(objectId: AbjectId): Mailbox {
    if (this.mailboxes.has(objectId)) {
      throw new Error(`Object ${objectId} already registered`);
    }
    const mailbox = new Mailbox();
    this.mailboxes.set(objectId, mailbox);
    return mailbox;
  }

  /**
   * Set a reply handler for an object (fast-path for reply/error messages).
   */
  setReplyHandler(objectId: AbjectId, handler: ReplyHandler): void {
    this.replyHandlers.set(objectId, handler);
  }

  /**
   * Remove the reply handler for an object.
   */
  removeReplyHandler(objectId: AbjectId): void {
    this.replyHandlers.delete(objectId);
  }

  /**
   * Unregister an object from this worker bus.
   */
  unregister(objectId: AbjectId): void {
    const mailbox = this.mailboxes.get(objectId);
    if (mailbox) {
      mailbox.close();
    }
    this.mailboxes.delete(objectId);
    this.replyHandlers.delete(objectId);
  }

  /**
   * Send a message. If the recipient is local, deliver directly.
   * Otherwise forward to the main thread for cross-worker routing.
   */
  async send(message: AbjectMessage): Promise<void> {
    const recipient = message.routing.to;

    // Check if recipient is local to this worker
    if (this.mailboxes.has(recipient)) {
      // Reply fast-path: resolve pending Promise directly, bypass mailbox
      if ((message.header.type === 'reply' || message.header.type === 'error')
          && message.header.correlationId) {
        const replyHandler = this.replyHandlers.get(recipient);
        if (replyHandler) {
          replyHandler(message);
          return;
        }
      }

      // Normal path: enqueue in local mailbox
      const mailbox = this.mailboxes.get(recipient)!;
      mailbox.send(message);
      return;
    }

    // Recipient not local — forward to main thread for routing
    this.postToMain({ type: 'bus:send', message });
  }

  /**
   * Check if an object is registered locally in this worker.
   */
  isRegistered(objectId: AbjectId): boolean {
    return this.mailboxes.has(objectId);
  }

  /**
   * Deliver a message from the main thread into a local object's mailbox.
   * Called when the main thread routes a message to this worker.
   */
  deliverFromMain(message: AbjectMessage): void {
    const recipient = message.routing.to;
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      console.warn(`[WorkerBus] Cannot deliver to ${recipient}: not registered locally`);
      return;
    }
    mailbox.send(message);
  }

  /**
   * Deliver a reply from the main thread via the fast-path.
   * Called when a reply/error is routed to an object in this worker.
   */
  deliverReplyFromMain(message: AbjectMessage): void {
    const recipient = message.routing.to;
    const replyHandler = this.replyHandlers.get(recipient);
    if (replyHandler) {
      replyHandler(message);
    } else {
      // Fall back to mailbox delivery
      this.deliverFromMain(message);
    }
  }
}
