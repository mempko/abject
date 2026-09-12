/**
 * Worker pool manager.
 *
 * Manages N Web Workers with UUID-based sharding for deterministic
 * object placement. Each worker runs a WorkerBus and hosts a subset
 * of Abject instances.
 */

import { AbjectId } from '../core/types.js';
import { require, invariant } from '../core/contracts.js';
import { WorkerBridge } from './worker-bridge.js';
import type { WorkerLike } from './worker-bridge.js';
import type { MessageBus } from './message-bus.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WorkerPool');

export interface WorkerPoolConfig {
  workerCount: number;
  /** Factory callback that creates a WorkerLike instance (Web Worker or Node.js worker_threads). */
  workerFactory: () => WorkerLike;
}

/**
 * Compute the worker index for an object ID using UUID-based sharding.
 *
 * UUIDs (v4) are uniformly distributed, so parsing the first 8 hex chars
 * as a 32-bit integer and taking modulo workerCount gives even distribution.
 */
export function workerIndexForId(objectId: AbjectId, workerCount: number): number {
  const hex = objectId.replace(/-/g, '').slice(0, 8);
  const num = parseInt(hex, 16);
  return num % workerCount;
}

/**
 * Manages N workers and provides deterministic object placement.
 */
export class WorkerPool {
  private bridges: WorkerBridge[] = [];
  private bus: MessageBus;
  private config: WorkerPoolConfig;
  private objectToBridge: Map<AbjectId, WorkerBridge> = new Map();
  private started = false;
  /**
   * Called after a pool worker has died and been replaced. `lostIds` are the
   * objects it hosted; every route to them is already cut and every caller
   * now gets an immediate error. Rebuilding what they were is the runtime's
   * job, not the pool's.
   */
  onWorkerLost?: (lostIds: AbjectId[], workerIndex: number) => void;

  constructor(config: WorkerPoolConfig, bus: MessageBus) {
    require(config.workerCount > 0, 'workerCount must be positive');
    this.config = config;
    this.bus = bus;
  }

  /**
   * Start the worker pool — creates N workers and waits for all to be ready.
   */
  async start(): Promise<void> {
    require(!this.started, 'WorkerPool already started');

    for (let i = 0; i < this.config.workerCount; i++) {
      this.bridges.push(this.createBridge(i));
    }

    // Wait for all workers to report ready
    await Promise.all(this.bridges.map((b) => b.waitReady()));

    // Create full mesh of direct MessagePort channels between pool workers.
    // For N workers this creates N*(N-1)/2 channels — at most 28 for N=8.
    for (let i = 0; i < this.bridges.length; i++) {
      for (let j = i + 1; j < this.bridges.length; j++) {
        const { port1, port2 } = new MessageChannel();
        this.bridges[i].sendPeerPort(j, port1);
        this.bridges[j].sendPeerPort(i, port2);
      }
    }

    this.started = true;
    log.info(`${this.config.workerCount} workers ready (${this.bridges.length * (this.bridges.length - 1) / 2} peer channels)`);
  }

  private createBridge(index: number): WorkerBridge {
    const worker = this.config.workerFactory();
    const bridge = new WorkerBridge(worker, this.bus);
    // Objects constructed locally inside the worker (e.g. widgets newed up
    // by a worker-hosted WidgetManager) announce themselves via
    // bus:registered — keep the routing map current so the whole system
    // can reach them.
    bridge.onLocalRegistered = (objectId) => {
      this.objectToBridge.set(objectId, bridge);
    };
    bridge.onLocalUnregistered = (objectId) => {
      if (this.objectToBridge.get(objectId) === bridge) {
        this.objectToBridge.delete(objectId);
      }
    };
    bridge.onDead = (code, lost) => { void this.handleWorkerDeath(index, bridge, code, lost); };
    return bridge;
  }

  /**
   * A pool worker died (out of memory, an uncaught error). Three things must
   * happen, in this order: every route to the objects it hosted is cut, on
   * the main bus and in every other worker, so callers fail now instead of
   * posting into a terminated thread for their full timeout; a fresh worker
   * takes the dead one's shard, so later spawns and Supervisor restarts land
   * somewhere alive; and the runtime is told what was lost so it can rebuild.
   */
  private async handleWorkerDeath(index: number, dead: WorkerBridge, code: number, lost: AbjectId[]): Promise<void> {
    const lostIds = new Set<AbjectId>(lost);
    // Ids the bridge hosted but never announced back (spawned before it
    // could report) still route to it; sweep them too.
    for (const [id, b] of this.objectToBridge) if (b === dead) lostIds.add(id);
    log.error(`pool worker ${index} died (code ${code}); ${lostIds.size} objects lost. Cutting routes and replacing the worker.`);
    for (const id of lostIds) {
      if (this.objectToBridge.get(id) === dead) this.objectToBridge.delete(id);
      this.bus.unregisterWorkerObject(id);
      for (const b of this.bridges) if (b !== dead) b.sendPeerRemove(id);
    }
    // The other workers may have requests outstanding on the dead one over
    // their direct channels; nothing will answer those unless they are told.
    for (const b of this.bridges) if (b !== dead) b.sendPeerDead(index);

    try {
      const fresh = this.createBridge(index);
      await fresh.waitReady();
      for (let j = 0; j < this.bridges.length; j++) {
        if (j === index) continue;
        const { port1, port2 } = new MessageChannel();
        fresh.sendPeerPort(j, port1);
        this.bridges[j].sendPeerPort(index, port2);
      }
      this.bridges[index] = fresh;
      // The newcomer knows nothing about where its peers' objects live; tell
      // it, or every message it sends takes the slower path through main.
      for (const [id, b] of this.objectToBridge) {
        const at = this.bridges.indexOf(b);
        if (at >= 0 && at !== index) fresh.sendPeerPlace(id, at);
      }
      this.bus.announceLivenessTo(fresh);
      log.info(`pool worker ${index} replaced`);
    } catch (err) {
      log.error(`pool worker ${index} could not be replaced: ${err instanceof Error ? err.message : String(err)}. Its shard stays dead until restart.`);
    }

    try { this.onWorkerLost?.([...lostIds], index); } catch (err) {
      log.error(`worker-loss handler threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get the bridge for a specific worker-hosted object.
   */
  getBridgeForObject(objectId: AbjectId): WorkerBridge | undefined {
    return this.objectToBridge.get(objectId);
  }

  /** Push one liveness fact to every pool worker. */
  broadcastLiveness(objectId: AbjectId, alive: boolean): void {
    for (const bridge of this.bridges) {
      bridge.sendLiveness(objectId, alive);
    }
  }

  /**
   * Spawn an object in its deterministic worker (based on UUID sharding).
   * Registers the object route on the main-thread bus.
   */
  async spawnInWorker(objectId: AbjectId, constructorName: string, options?: {
    constructorArgs?: unknown;
    registryId?: AbjectId;
    parentId?: AbjectId;
  }): Promise<void> {
    require(this.started, 'WorkerPool not started');

    const index = workerIndexForId(objectId, this.bridges.length);
    const bridge = this.bridges[index];

    // Register route on the main bus BEFORE spawning so that messages sent
    // by the object during init/onInit can be routed back correctly.
    this.objectToBridge.set(objectId, bridge);
    this.bus.registerWorkerObject(objectId);

    try {
      await bridge.spawnInWorker(objectId, constructorName, options);
    } catch (err) {
      // Roll back main bus registration on spawn failure
      this.objectToBridge.delete(objectId);
      this.bus.unregisterWorkerObject(objectId);
      throw err;
    }

    // Broadcast placement to all OTHER pool workers so they can route directly
    for (let i = 0; i < this.bridges.length; i++) {
      if (i !== index) {
        this.bridges[i].sendPeerPlace(objectId, index);
      }
    }
  }

  /**
   * Kill a worker-hosted object.
   */
  async killInWorker(objectId: AbjectId): Promise<void> {
    const bridge = this.objectToBridge.get(objectId);
    if (!bridge) return;

    await bridge.killInWorker(objectId);

    this.objectToBridge.delete(objectId);
    this.bus.unregisterWorkerObject(objectId);

    // Broadcast removal to all pool workers
    for (const b of this.bridges) {
      b.sendPeerRemove(objectId);
    }
  }

  /**
   * Check if an object is hosted in this pool.
   */
  isHosted(objectId: AbjectId): boolean {
    return this.objectToBridge.has(objectId);
  }

  /**
   * Shut down all workers. Kills all worker-hosted objects first.
   */
  async shutdown(): Promise<void> {
    // Kill all hosted objects
    const objectIds = Array.from(this.objectToBridge.keys());
    for (const objectId of objectIds) {
      try {
        await this.killInWorker(objectId);
      } catch {
        // Best effort during shutdown
      }
    }

    // Terminate all workers
    for (const bridge of this.bridges) {
      bridge.terminate();
    }

    this.bridges = [];
    this.objectToBridge.clear();
    this.started = false;

    log.info('Shut down');
  }

  /**
   * Get the number of workers.
   */
  get workerCount(): number {
    return this.bridges.length;
  }

  /**
   * Get the number of hosted objects.
   */
  get objectCount(): number {
    return this.objectToBridge.size;
  }
}
