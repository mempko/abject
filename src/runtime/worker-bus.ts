/**
 * Worker-side message bus.
 *
 * Implements MessageBusLike and runs inside a Web Worker.
 * Local messages are delivered to the mailbox; cross-worker messages
 * are forwarded to the main thread via postMessage().
 * All messages (including replies) flow through the mailbox.
 */

import { AbjectMessage, AbjectId } from '../core/types.js';
import { Mailbox } from './mailbox.js';
import type { MessageBusLike } from './message-bus.js';
import { resetSequence } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WorkerBus');

/** Function for posting messages back to the main thread. */
export type PostToMainFn = (data: unknown) => void;

/** Message types sent between peer workers via direct MessagePort channels. */
export interface PeerMessage {
  type: 'peer:msg';
  message: AbjectMessage;
}

export class WorkerBus implements MessageBusLike {
  private mailboxes: Map<AbjectId, Mailbox> = new Map();
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
   * Unregister an object from this worker bus.
   */
  unregister(objectId: AbjectId): void {
    const mailbox = this.mailboxes.get(objectId);
    if (mailbox) {
      mailbox.close();
    }
    this.mailboxes.delete(objectId);
    resetSequence(objectId);
  }

  /**
   * Add a direct MessagePort channel to a peer worker.
   */
  addPeerPort(workerIndex: number, port: MessagePort): void {
    this.peerPorts.set(workerIndex, port);
    port.onmessage = (event: MessageEvent<PeerMessage>) => {
      const { message } = event.data;
      this.deliverFromPeer(message);
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
   * 1. Local mailbox
   * 2. Known peer worker via direct MessagePort
   * 3. Main thread fallback
   */
  send(message: AbjectMessage): void {
    const recipient = message.routing.to;

    // 1. Local delivery via mailbox
    if (this.mailboxes.has(recipient)) {
      const mailbox = this.mailboxes.get(recipient)!;
      mailbox.send(message);
      return;
    }

    // 2. Direct peer delivery
    const peerIdx = this.peerObjects.get(recipient);
    if (peerIdx !== undefined) {
      const port = this.peerPorts.get(peerIdx);
      if (port) {
        const peerMsg: PeerMessage = { type: 'peer:msg', message };
        port.postMessage(peerMsg);
        return;
      }
    }

    // 3. Main thread fallback
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
}
