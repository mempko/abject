/**
 * Main thread interface to the object runtime worker.
 */

import { AbjectId, AbjectMessage } from '../core/types.js';
import { require } from '../core/contracts.js';
import { serialize, deserialize } from '../core/message.js';
import type { MessageBusLike } from '../runtime/message-bus.js';

export type WorkerMessageType =
  | 'init'
  | 'spawn'
  | 'message'
  | 'kill'
  | 'status'
  | 'ready'
  | 'error'
  | 'log';

export interface WorkerMessage {
  type: WorkerMessageType;
  payload: unknown;
}

interface PendingSpawn {
  resolve: () => void;
  reject: (error: Error) => void;
}

type ObjectStatus = 'spawning' | 'ready' | 'stopped' | 'error';

/**
 * Manages communication with the object runtime worker.
 */
export class WorkerRuntime {
  private worker: Worker;
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private pendingSpawns: Map<AbjectId, PendingSpawn> = new Map();
  private objectStatus: Map<AbjectId, ObjectStatus> = new Map();
  private bus?: MessageBusLike;

  constructor(workerUrl: string | URL) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = this.handleWorkerMessage.bind(this);
    this.worker.onerror = this.handleWorkerError.bind(this);

    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // Send init message
    this.postMessage({ type: 'init', payload: null });
  }

  /**
   * Set the message bus for routing messages from objects.
   */
  setBus(bus: MessageBusLike): void {
    this.bus = bus;
  }

  /**
   * Wait for the worker to be ready.
   */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Check if the worker is ready.
   */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Spawn a WASM object in the worker.
   */
  async spawn(
    objectId: AbjectId,
    wasmCode: ArrayBuffer,
    initialState?: unknown
  ): Promise<void> {
    require(this.ready, 'Worker not ready');
    require(objectId !== '', 'objectId is required');
    require(wasmCode.byteLength > 0, 'wasmCode is required');

    return new Promise((resolve, reject) => {
      this.pendingSpawns.set(objectId, { resolve, reject });
      this.objectStatus.set(objectId, 'spawning');

      this.postMessage({
        type: 'spawn',
        payload: { objectId, wasmCode, initialState },
      });
    });
  }

  /**
   * Send a message to an object in the worker.
   */
  sendMessage(objectId: AbjectId, message: AbjectMessage): void {
    require(this.ready, 'Worker not ready');
    require(this.objectStatus.get(objectId) === 'ready', 'Object not ready');

    this.postMessage({
      type: 'message',
      payload: { objectId, message: serialize(message) },
    });
  }

  /**
   * Kill an object in the worker.
   */
  kill(objectId: AbjectId): void {
    this.postMessage({ type: 'kill', payload: { objectId } });
    this.objectStatus.delete(objectId);
    this.pendingSpawns.delete(objectId);
  }

  /**
   * Get the status of an object.
   */
  getObjectStatus(objectId: AbjectId): ObjectStatus | undefined {
    return this.objectStatus.get(objectId);
  }

  /**
   * Terminate the worker.
   */
  terminate(): void {
    this.worker.terminate();
    this.ready = false;
    this.objectStatus.clear();

    // Reject all pending spawns
    for (const [, pending] of this.pendingSpawns) {
      pending.reject(new Error('Worker terminated'));
    }
    this.pendingSpawns.clear();
  }

  /**
   * Post a message to the worker.
   */
  private postMessage(msg: WorkerMessage): void {
    this.worker.postMessage(msg);
  }

  /**
   * Handle messages from the worker.
   */
  private handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
    const { type, payload } = event.data;

    switch (type) {
      case 'ready':
        this.ready = true;
        this.readyResolve();
        console.log('[WORKER-RUNTIME] Worker ready');
        break;

      case 'status': {
        const { objectId, status } = payload as {
          objectId: AbjectId;
          status: string;
        };
        this.objectStatus.set(objectId, status as ObjectStatus);

        if (status === 'ready') {
          const pending = this.pendingSpawns.get(objectId);
          if (pending) {
            pending.resolve();
            this.pendingSpawns.delete(objectId);
          }
        }
        break;
      }

      case 'message': {
        const { objectId, message } = payload as {
          objectId: AbjectId;
          message: string;
        };
        const msg = deserialize(message);

        // Route through message bus
        if (this.bus) {
          this.bus.send(msg).catch(console.error);
        }
        break;
      }

      case 'error': {
        const { objectId, error } = payload as {
          objectId: AbjectId;
          error: string;
        };
        console.error(`[WORKER-RUNTIME] Object ${objectId} error:`, error);

        this.objectStatus.set(objectId, 'error');

        const pending = this.pendingSpawns.get(objectId);
        if (pending) {
          pending.reject(new Error(error));
          this.pendingSpawns.delete(objectId);
        }
        break;
      }

      case 'log': {
        const { objectId: logObjectId, level, message } = payload as {
          objectId: AbjectId;
          level: number;
          message: string;
        };
        const prefix = `[${logObjectId}]`;
        switch (level) {
          case 0:
            console.debug(prefix, message);
            break;
          case 1:
            console.log(prefix, message);
            break;
          case 2:
            console.warn(prefix, message);
            break;
          case 3:
            console.error(prefix, message);
            break;
          default:
            console.log(prefix, message);
        }
        break;
      }

      default:
        console.warn(`[WORKER-RUNTIME] Unknown message type: ${type}`);
    }
  }

  /**
   * Handle worker errors.
   */
  private handleWorkerError(event: ErrorEvent): void {
    console.error('[WORKER-RUNTIME] Worker error:', event.message);
  }
}

// Singleton worker runtime
let globalWorkerRuntime: WorkerRuntime | undefined;

/**
 * Get or create the global worker runtime.
 */
export function getWorkerRuntime(workerUrl?: string | URL): WorkerRuntime {
  if (!globalWorkerRuntime) {
    require(workerUrl !== undefined, 'workerUrl required for first call');
    globalWorkerRuntime = new WorkerRuntime(workerUrl!);
  }
  return globalWorkerRuntime;
}

/**
 * Reset the global worker runtime (for testing).
 */
export function resetWorkerRuntime(): void {
  if (globalWorkerRuntime) {
    globalWorkerRuntime.terminate();
    globalWorkerRuntime = undefined;
  }
}
