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
import { Log } from '../core/timed-log.js';

const log = new Log('WorkerBus');

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
/** Message types sent between peer workers via direct MessagePort channels. */
export interface PeerMessage {
  type: 'peer:msg' | 'peer:reply';
  message: AbjectMessage;
}

export class WorkerBus implements MessageBusLike {
  private mailboxes: Map<AbjectId, Mailbox> = new Map();
  private replyHandlers: Map<AbjectId, ReplyHandler> = new Map();
  private postToMain: PostToMainFn;

  /** Direct MessagePort channels to peer workers, keyed by worker index. */
  private peerPorts: Map<number, MessagePort> = new Map();
  /** Maps remote object IDs to the peer worker index that hosts them. */
  private peerObjects: Map<AbjectId, number> = new Map();

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
   * Add a direct MessagePort channel to a peer worker.
   * Messages from the peer are delivered locally via deliverFromPeer().
   */
  addPeerPort(workerIndex: number, port: MessagePort): void {
    this.peerPorts.set(workerIndex, port);
    port.onmessage = (event: MessageEvent<PeerMessage>) => {
      const { type, message } = event.data;
      if (type === 'peer:reply') {
        this.deliverReplyFromPeer(message);
      } else {
        this.deliverFromPeer(message);
      }
    };
    port.start?.();
  }

  /**
   * Record that an object lives in a specific peer worker.
   */
  addPeerObject(objectId: AbjectId, workerIndex: number): void {
    this.peerObjects.set(objectId, workerIndex);
  }

  /**
   * Remove a peer object placement record.
   */
  removePeerObject(objectId: AbjectId): void {
    this.peerObjects.delete(objectId);
  }

  /**
   * Send a message. Three-tier routing:
   * 1. Local mailbox — deliver directly
   * 2. Known peer worker — send via direct MessagePort
   * 3. Neither — forward to main thread for routing
   */
  send(message: AbjectMessage): void {
    const recipient = message.routing.to;

    // 1. Local delivery
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

    // 2. Direct peer delivery
    const peerIdx = this.peerObjects.get(recipient);
    if (peerIdx !== undefined) {
      const port = this.peerPorts.get(peerIdx);
      if (port) {
        const isReply = (message.header.type === 'reply' || message.header.type === 'error')
                        && message.header.correlationId;
        const peerMsg: PeerMessage = {
          type: isReply ? 'peer:reply' : 'peer:msg',
          message,
        };
        port.postMessage(peerMsg);
        return;
      }
    }

    // 3. Main thread fallback (main-thread objects, dedicated workers, unknown recipients)
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
      log.warn(`Cannot deliver to ${recipient}: not registered locally`);
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

  /**
   * Deliver a message from a peer worker via direct MessagePort.
   */
  deliverFromPeer(message: AbjectMessage): void {
    const recipient = message.routing.to;
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      log.warn(`Cannot deliver peer message to ${recipient}: not registered locally`);
      return;
    }
    mailbox.send(message);
  }

  /**
   * Deliver a reply from a peer worker via the fast-path.
   */
  deliverReplyFromPeer(message: AbjectMessage): void {
    const recipient = message.routing.to;
    const replyHandler = this.replyHandlers.get(recipient);
    if (replyHandler) {
      replyHandler(message);
    } else {
      this.deliverFromPeer(message);
    }
  }
}
