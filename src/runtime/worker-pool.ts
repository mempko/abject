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
      const worker = this.config.workerFactory();
      const bridge = new WorkerBridge(worker, this.bus);
      this.bridges.push(bridge);
    }

    // Wait for all workers to report ready
    await Promise.all(this.bridges.map((b) => b.waitReady()));

    this.started = true;
    console.log(`[WorkerPool] ${this.config.workerCount} workers ready`);
  }

  /**
   * Get the bridge for a specific worker-hosted object.
   */
  getBridgeForObject(objectId: AbjectId): WorkerBridge | undefined {
    return this.objectToBridge.get(objectId);
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

    console.log('[WorkerPool] Shut down');
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
