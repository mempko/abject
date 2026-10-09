/**
 * The worker side of the Abject worker pool: spawns objects into this thread,
 * routes their messages, and reports heap use. The constructor table decides
 * which objects this thread can host; each edition's entry point passes its own.
 */

import { parentPort } from 'node:worker_threads';
import * as v8 from 'node:v8';
import { AbjectId, TypeId } from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { WorkerBus } from '../src/runtime/worker-bus.js';
import type { WorkerInboundMessage } from '../src/runtime/worker-bridge.js';
import { signalAllChildren } from '../src/runtime/child-processes.js';
import { require as contractRequire } from '../src/core/contracts.js';
import type { ObjectFactory } from './core-constructors.js';

export function runAbjectWorker(constructors: Map<string, ObjectFactory>): void {
  contractRequire(!!parentPort, 'an Abject worker must run inside a worker_threads Worker');
  contractRequire(constructors.size > 0, 'an Abject worker needs constructors to host anything');
  const port = parentPort!;

  // Global error handlers — report to main thread before the worker dies
  process.on('uncaughtException', (err) => {
    try { port.postMessage({ type: 'error', error: `uncaughtException: ${err.message}\n${err.stack}` }); } catch { /* dying */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { port.postMessage({ type: 'error', error: `unhandledRejection: ${reason}` }); } catch { /* dying */ }
  });

  // Worker state — pass parentPort.postMessage so WorkerBus routes via worker_threads
  const workerBus = new WorkerBus((data) => port.postMessage(data));
  const objects = new Map<AbjectId, Abject>();
  // An object that stops itself — a widget torn down with its window, a
  // Supervisor restart, a workspace switch — leaves the bus but was never
  // removed from here, because only an explicit `kill` from main did that.
  // It was then unreachable and still fully retained, with its state,
  // handlers, dependents and every closure they captured. Releasing it on
  // unregister is what makes a stopped object actually collectable.
  workerBus.onUnregistered = (objectId) => { objects.delete(objectId); };

  /**
   * Spawn an object inside this worker.
   */
  async function spawnObject(
    objectId: AbjectId,
    constructorName: string,
    constructorArgs?: unknown,
    registryId?: AbjectId,
    parentId?: AbjectId,
    typeId?: TypeId,
  ): Promise<void> {
    const factory = constructors.get(constructorName);
    if (!factory) {
      port.postMessage({
        type: 'error',
        objectId,
        error: `No constructor for '${constructorName}' in worker`,
      });
      return;
    }

    try {
      const obj = factory(constructorArgs);
      obj.setId(objectId);
      // The durable identity a main-thread spawn would carry: workspace objects
      // build their own typeIds from it, and privilege checks read it.
      if (typeId) obj.setTypeId(typeId);

      // Pre-seed registry hint so the object can discover dependencies
      if (registryId) {
        obj.setRegistryHint(registryId);
      }

      // Held before init, not after: an object that stops itself partway
      // through starting unregisters from the bus, and onUnregistered has to
      // find it here to release it. Setting it afterwards would re-add the
      // corpse the hook had just dropped.
      objects.set(objectId, obj);
      await obj.init(workerBus, parentId);

      port.postMessage({ type: 'spawned', objectId });
    } catch (err) {
      objects.delete(objectId);
      port.postMessage({
        type: 'error',
        objectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Kill an object inside this worker.
   */
  async function killObject(objectId: AbjectId): Promise<void> {
    const obj = objects.get(objectId);
    if (obj) {
      try {
        await obj.stop();
      } catch {
        // Object may already be stopped
      }
      objects.delete(objectId);
    }
    port.postMessage({ type: 'stopped', objectId });
  }

  // Handle messages from the main thread
  port.on('message', async (data: WorkerInboundMessage) => {
    const { type } = data;

    switch (type) {
      case 'spawn': {
        const { objectId, constructorName, constructorArgs, registryId, parentId, typeId } = data;
        await spawnObject(objectId!, constructorName!, constructorArgs, registryId, parentId, typeId);
        break;
      }

      case 'kill': {
        const { objectId } = data;
        await killObject(objectId!);
        break;
      }

      case 'bus:deliver': {
        // Main thread routing a message to a local object
        const { message } = data;
        if (message) {
          workerBus.deliverFromMain(message);
        }
        break;
      }

      case 'peer:port': {
        // Direct MessagePort from a peer worker — transferred in the message data
        const { workerIndex } = data;
        const peerPort = (data as { port?: import('node:worker_threads').MessagePort }).port;
        if (peerPort && workerIndex !== undefined) {
          workerBus.addPeerPort(workerIndex, peerPort as unknown as MessagePort);
        }
        break;
      }

      case 'peer:place': {
        const { objectId, workerIndex } = data;
        if (objectId && workerIndex !== undefined) {
          workerBus.addPeerObject(objectId, workerIndex);
        }
        break;
      }

      case 'live:add': {
        if (data.objectId) workerBus.addGlobalObject(data.objectId);
        break;
      }

      case 'live:remove': {
        if (data.objectId) {
          workerBus.removeGlobalObject(data.objectId);
          // A dead object cannot be a peer target either: a direct MessagePort
          // to the worker that hosted it posts into the void and the caller
          // sits out its full timeout. Route through main from now on, where
          // the answer is an immediate error.
          workerBus.removePeerObject(data.objectId);
        }
        break;
      }

      case 'peer:remove': {
        const { objectId } = data;
        if (objectId) {
          workerBus.removePeerObject(objectId);
        }
        break;
      }

      case 'peer:dead': {
        if (data.workerIndex !== undefined) workerBus.failPeer(data.workerIndex);
        break;
      }

      case 'children:signal': {
        // Shutdown, first step: every child process this worker started, now,
        // whatever later happens to the objects that own them.
        const children = signalAllChildren((data.signal ?? 'SIGTERM') as NodeJS.Signals);
        port.postMessage({ type: 'children:signalled', requestId: data.requestId, children });
        break;
      }

      default:
        console.warn(`[AbjectWorker:Node] Unknown message type: ${type}`);
    }
  });

  /**
   * Heap probe.
   *
   * A worker gets a fixed heap ceiling and is terminated on reaching it, so
   * the interesting question is never "did it die" but "how close is it, and
   * since when". Only code inside this isolate can answer that, so the
   * measurement happens here; every judgement about it belongs to the
   * HeapMonitor abject on main.
   *
   * Unref'd so an idle worker can still exit, and wrapped because a worker
   * being torn down mid-post is ordinary, not an error.
   */
  const HEAP_SAMPLE_MS = 30_000;
  function reportHeap(): void {
    const stats = v8.getHeapStatistics();
    try {
      port.postMessage({
        type: 'worker:heap',
        heap: {
          usedBytes: stats.used_heap_size,
          totalBytes: stats.total_heap_size,
          limitBytes: stats.heap_size_limit,
          objectCount: objects.size,
          at: Date.now(),
        },
      });
    } catch { /* worker going down */ }
  }
  const heapTimer = setInterval(reportHeap, HEAP_SAMPLE_MS);
  heapTimer.unref?.();
  // A baseline right away, so a worker is never unobserved for its first
  // half-minute and the monitor has something to compare against.
  reportHeap();

  // Signal ready
  port.postMessage({ type: 'ready' });

}
