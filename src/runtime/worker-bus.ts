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
import { resetSequence, error as createError } from '../core/message.js';
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
  /**
   * Global liveness view pushed from the main thread (live:add/live:remove):
   * every id registered anywhere in the system — main, dedicated workers,
   * other pool workers. Lets worker-hosted registries and sweepers answer
   * isRegistered() with the same truth the main bus has.
   */
  private globalObjects: Set<AbjectId> = new Set();
  /**
   * Requests sent straight to a peer worker and not yet answered. When main
   * reports that peer dead, each gets a WORKER_DEAD reply here, in the
   * sender's own worker; nothing else would ever answer them.
   */
  private peerInFlight: Map<string, { message: AbjectMessage; workerIndex: number; at: number }> = new Map();
  private static readonly PEER_IN_FLIGHT_MAX = 20_000;

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
    // Announce to the main thread so the main bus routes messages for this
    // id to our bridge. Factory-spawned objects are announced by the spawn
    // protocol too (idempotent), but objects constructed LOCALLY by another
    // worker object — e.g. every window/widget WidgetManager news up — are
    // only visible through this announcement. Without it, anything outside
    // this worker that replies or sends to them hits UNDELIVERABLE.
    this.postToMain({ type: 'bus:registered', objectId });
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
    this.postToMain({ type: 'bus:unregistered', objectId });
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

  /** Record a global-liveness fact pushed from the main thread. */
  addGlobalObject(objectId: AbjectId): void {
    this.globalObjects.add(objectId);
  }

  removeGlobalObject(objectId: AbjectId): void {
    this.globalObjects.delete(objectId);
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
        if (message.header.type === 'request') {
          if (this.peerInFlight.size >= WorkerBus.PEER_IN_FLIGHT_MAX) {
            const oldest = this.peerInFlight.keys().next().value;
            if (oldest !== undefined) this.peerInFlight.delete(oldest);
          }
          this.peerInFlight.set(message.header.messageId, { message, workerIndex: peerIdx, at: Date.now() });
        }
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
    return this.mailboxes.has(objectId)
      || this.peerObjects.has(objectId)
      || this.globalObjects.has(objectId);
  }

  /**
   * Deliver a message from the main thread into a local object's mailbox.
   */
  deliverFromMain(message: AbjectMessage): void {
    const recipient = message.routing.to;
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      log.warn(`Cannot deliver to ${recipient}: not registered locally`);
      this.failIfRequest(message);
      return;
    }
    mailbox.send(message);
  }

  /**
   * Deliver a message from a peer worker via direct MessagePort.
   */
  deliverFromPeer(message: AbjectMessage): void {
    if ((message.header.type === 'reply' || message.header.type === 'error') && message.header.correlationId) {
      this.peerInFlight.delete(message.header.correlationId);
    }
    const recipient = message.routing.to;
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      log.warn(`Cannot deliver peer message to ${recipient}: not registered locally`);
      this.failIfRequest(message);
      return;
    }
    mailbox.send(message);
  }

  /**
   * A peer worker died. Its port is useless, its placements are stale, and
   * every request we sent it is unanswerable: reply to each with an error so
   * the local caller fails now instead of at its timeout.
   */
  failPeer(workerIndex: number): void {
    this.peerPorts.delete(workerIndex);
    for (const [id, idx] of [...this.peerObjects]) if (idx === workerIndex) this.peerObjects.delete(id);
    let failed = 0;
    for (const [id, entry] of [...this.peerInFlight]) {
      if (entry.workerIndex !== workerIndex) continue;
      this.peerInFlight.delete(id);
      const reply = createError(entry.message, 'WORKER_DEAD',
        `Worker hosting ${entry.message.routing.to} exited before answering; the object is gone until it is rebuilt`);
      const mailbox = this.mailboxes.get(entry.message.routing.from);
      if (mailbox) { mailbox.send(reply); failed++; }
    }
    if (failed > 0) log.warn(`peer worker ${workerIndex} died with ${failed} of our request(s) in flight; each got a WORKER_DEAD reply`);
  }

  /**
   * When a request lands on an object this worker doesn't have (it was
   * destroyed, or routing is stale), send a correlated RECIPIENT_NOT_FOUND
   * error reply back to the sender so its request() rejects instantly instead
   * of waiting out the full timeout. Mirrors the main bus's fail-fast for
   * unregistered local recipients. Non-requests (events) are simply dropped.
   */
  private failIfRequest(message: AbjectMessage): void {
    if (message.header.type !== 'request') return;
    const reply = createError(
      message,
      'RECIPIENT_NOT_FOUND',
      `Recipient ${message.routing.to} is not registered (worker)`,
    );
    this.send(reply);
  }
}
