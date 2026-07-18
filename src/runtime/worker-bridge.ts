/**
 * Main-thread bridge to a single Web Worker.
 *
 * Manages communication between the main-thread MessageBus and one worker.
 * Tracks which objects are hosted in this worker, forwards messages into
 * the worker, and relays outbound messages from the worker back to the bus.
 */

import { AbjectMessage, AbjectId } from '../core/types.js';
import { error as errorMessage } from '../core/message.js';
import type { MessageBus } from './message-bus.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WorkerBridge');

/**
 * Cross-platform worker interface.
 *
 * Abstracts both Web Workers (browser) and worker_threads (Node.js)
 * so that WorkerBridge can work in either environment.
 */
export interface WorkerLike {
  postMessage(data: unknown, transferList?: unknown[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onexit: ((event: { code: number }) => void) | null;
}

/** Message types sent from main thread to worker. */
export interface WorkerInboundMessage {
  type: 'init' | 'spawn' | 'kill' | 'bus:deliver'
      | 'peer:port' | 'peer:place' | 'peer:remove'
      | 'live:add' | 'live:remove';
  objectId?: AbjectId;
  constructorName?: string;
  constructorArgs?: unknown;
  registryId?: AbjectId;
  parentId?: AbjectId;
  message?: AbjectMessage;
  workerIndex?: number;
  port?: unknown;  // MessagePort (transferred)
}

/** Message types sent from worker to main thread. */
export interface WorkerOutboundMessage {
  type: 'ready' | 'spawned' | 'stopped' | 'bus:send' | 'error'
      | 'bus:registered' | 'bus:unregistered';
  objectId?: AbjectId;
  message?: AbjectMessage;
  error?: string;
}

/**
 * Manages a single worker from the main thread.
 *
 * Works with both Web Workers (browser) and worker_threads (Node.js)
 * via the WorkerLike interface.
 */
export class WorkerBridge {
  readonly hostedObjects: Set<AbjectId> = new Set();

  protected worker: WorkerLike;
  protected bus: MessageBus;
  private readyResolve?: () => void;
  private readyPromise: Promise<void>;
  private pendingSpawns: Map<AbjectId, { resolve: () => void; reject: (err: Error) => void }> = new Map();
  private pendingKills: Map<AbjectId, { resolve: () => void; reject: (err: Error) => void }> = new Map();
  private _dead = false;

  get isDead(): boolean { return this._dead; }

  /**
   * Invoked when an object registers/unregisters on this worker's bus
   * OUTSIDE the spawn protocol (constructed locally by another worker
   * object). The pool hooks these to keep its objectToBridge map current.
   */
  onLocalRegistered?: (objectId: AbjectId) => void;
  onLocalUnregistered?: (objectId: AbjectId) => void;

  /**
   * Invoked once when the worker exits. Dedicated workers (UI, P2P) hook
   * this to announce the loss loudly — their objects are registered via
   * registerDedicatedBridge rather than hostedObjects, so the generic
   * "lost N objects" line under-reports what actually died.
   */
  onDead?: (code: number) => void;

  constructor(worker: WorkerLike, bus: MessageBus) {
    this.worker = worker;
    this.bus = bus;

    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.worker.onmessage = this.handleWorkerMessage.bind(this);
    this.worker.onerror = (e) => {
      log.error('Worker error:', e.message);
      // Reject pending ready if worker errors during init
      if (this.readyResolve) {
        this.readyResolve = undefined;
      }
    };
    this.worker.onexit = (e) => {
      this._dead = true;
      const objectIds = [...this.hostedObjects];
      log.error(`Worker exited (code ${e.code}), lost ${objectIds.length} objects: [${objectIds.map(id => id.slice(0, 8)).join(', ')}]`);
      // Unregister all hosted objects from the bus so senders get immediate errors
      for (const objectId of objectIds) {
        this.bus.unregister(objectId);
      }
      this.hostedObjects.clear();
      // Reject all pending operations
      for (const [, pending] of this.pendingSpawns) {
        pending.reject(new Error(`Worker exited with code ${e.code}`));
      }
      this.pendingSpawns.clear();
      for (const [, pending] of this.pendingKills) {
        pending.reject(new Error(`Worker exited with code ${e.code}`));
      }
      this.pendingKills.clear();
      try { this.onDead?.(e.code); } catch { /* observer error must not mask the exit */ }
    };
  }

  /**
   * Wait for the worker to report ready.
   */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Deliver a normal message to an object in this worker.
   */
  deliverMessage(message: AbjectMessage): void {
    if (this._dead) {
      log.warn(`DEAD WORKER: dropping ${message.header.type} ${message.routing.method ?? '?'} to=${message.routing.to.slice(0, 8)}`);
      // Fail requests FAST: without an error reply every caller sits out its
      // full request timeout (30s default), and a per-frame animation loop
      // against a dead worker turns that into a timeout storm.
      if (message.header.type === 'request') {
        try {
          this.bus.send(errorMessage(
            message,
            'WORKER_DEAD',
            `Worker hosting ${message.routing.to} has exited; the object is gone until a restart`,
          ));
        } catch { /* sender already gone */ }
      }
      return;
    }
    const msg: WorkerInboundMessage = {
      type: 'bus:deliver',
      message,
    };
    try {
      this.worker.postMessage(msg);
    } catch (err) {
      log.error(`Failed to deliver ${message.header.type} ${message.routing.method ?? '?'} to worker (to=${message.routing.to.slice(0,8)}):`, err);
    }
  }

  /**
   * Spawn an object inside this worker.
   */
  async spawnInWorker(objectId: AbjectId, constructorName: string, options?: {
    constructorArgs?: unknown;
    registryId?: AbjectId;
    parentId?: AbjectId;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingSpawns.set(objectId, { resolve, reject });
      const msg: WorkerInboundMessage = {
        type: 'spawn',
        objectId,
        constructorName,
        constructorArgs: options?.constructorArgs,
        registryId: options?.registryId,
        parentId: options?.parentId,
      };
      this.worker.postMessage(msg);
    });
  }

  /**
   * Kill an object inside this worker.
   */
  async killInWorker(objectId: AbjectId): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingKills.set(objectId, { resolve, reject });
      const msg: WorkerInboundMessage = {
        type: 'kill',
        objectId,
      };
      this.worker.postMessage(msg);
    });
  }

  /**
   * Send a direct MessagePort to this worker for peer-to-peer communication.
   * The port is transferred (not cloned) to the worker.
   */
  sendPeerPort(workerIndex: number, port: unknown): void {
    this.worker.postMessage(
      { type: 'peer:port', workerIndex, port } as WorkerInboundMessage,
      [port as unknown as Transferable],
    );
  }

  /**
   * Push a global-liveness fact to this worker: `objectId` exists (or no
   * longer exists) SOMEWHERE in the system — main thread, a dedicated
   * worker, or any pool worker. WorkerBus.isRegistered folds these in so
   * worker-hosted registries/sweepers see the same liveness the main bus
   * sees, instead of declaring everything non-local dead.
   */
  sendLiveness(objectId: AbjectId, alive: boolean): void {
    if (this._dead) return;
    try {
      this.worker.postMessage({ type: alive ? 'live:add' : 'live:remove', objectId } as WorkerInboundMessage);
    } catch { /* worker going down */ }
  }

  /**
   * Notify this worker that an object has been placed in a peer worker.
   */
  sendPeerPlace(objectId: AbjectId, workerIndex: number): void {
    this.worker.postMessage({ type: 'peer:place', objectId, workerIndex } as WorkerInboundMessage);
  }

  /**
   * Notify this worker that an object has been removed from a peer worker.
   */
  sendPeerRemove(objectId: AbjectId): void {
    this.worker.postMessage({ type: 'peer:remove', objectId } as WorkerInboundMessage);
  }

  /**
   * Terminate the worker.
   */
  terminate(): void {
    this.worker.terminate();
    this.hostedObjects.clear();

    // Reject pending operations
    for (const [, pending] of this.pendingSpawns) {
      pending.reject(new Error('Worker terminated'));
    }
    this.pendingSpawns.clear();
    for (const [, pending] of this.pendingKills) {
      pending.reject(new Error('Worker terminated'));
    }
    this.pendingKills.clear();
  }

  /**
   * Handle messages from the worker.
   * Protected so DedicatedWorkerBridge can override to intercept custom message types.
   */
  protected handleWorkerMessage(event: { data: unknown }): void {
    const data = event.data as WorkerOutboundMessage;
    const { type } = data;

    switch (type) {
      case 'ready':
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = undefined;
        }
        break;

      case 'spawned': {
        const objectId = data.objectId!;
        this.hostedObjects.add(objectId);
        const pending = this.pendingSpawns.get(objectId);
        if (pending) {
          this.pendingSpawns.delete(objectId);
          pending.resolve();
        }
        break;
      }

      case 'stopped': {
        const objectId = data.objectId!;
        this.hostedObjects.delete(objectId);
        // Remove from the main bus's worker-routing table so the bus stops
        // forwarding to this worker and instead fails fast (RECIPIENT_NOT_FOUND)
        // for any later call. Without this, the bus only drops a worker object
        // on killInWorker — an object that stops/destroys itself (e.g. a widget
        // torn down with its window) would linger in workerObjects, and calls to
        // it would hang to the request timeout instead of rejecting instantly.
        this.bus.unregisterWorkerObject(objectId);
        const pending = this.pendingKills.get(objectId);
        if (pending) {
          this.pendingKills.delete(objectId);
          pending.resolve();
        }
        break;
      }

      case 'bus:registered': {
        // A worker-local object came onto the worker's bus (e.g. a widget
        // constructed by WidgetManager). Route its id to this bridge so
        // replies and sends from anywhere reach it.
        const objectId = data.objectId!;
        this.hostedObjects.add(objectId);
        // Set the route BEFORE marking the id worker-hosted on the main bus:
        // registerWorkerObject flushes messages parked for this id, and a
        // flush landing before the route exists takes the no-worker-bridge
        // path and drops the message.
        this.onLocalRegistered?.(objectId);
        this.bus.registerWorkerObject(objectId);
        break;
      }

      case 'bus:unregistered': {
        const objectId = data.objectId!;
        this.hostedObjects.delete(objectId);
        // Drop the route before the worker-hosted flag so an in-flight
        // message fails fast against a known-gone route instead of racing a
        // half-torn-down registration.
        this.onLocalUnregistered?.(objectId);
        this.bus.unregisterWorkerObject(objectId);
        break;
      }

      case 'bus:send': {
        // Worker-side object wants to send a message — route through main bus
        const message = data.message!;
        this.bus.send(message);
        break;
      }

      case 'error': {
        const objectId = data.objectId;
        const errorMsg = data.error ?? 'Unknown worker error';
        log.error(`Worker error for ${objectId}:`, errorMsg);

        // Reject pending spawn if applicable
        if (objectId) {
          const pending = this.pendingSpawns.get(objectId);
          if (pending) {
            this.pendingSpawns.delete(objectId);
            pending.reject(new Error(errorMsg));
          }
        }
        break;
      }

      default:
        log.warn(`Unknown message type from worker: ${type}`);
    }
  }
}
