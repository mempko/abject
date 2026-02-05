/**
 * Supervision tree for managing object lifecycles and failures.
 */

import { AbjectId, AbjectMessage, AbjectError } from '../core/types.js';
import { invariant } from '../core/contracts.js';
import { Abject } from '../core/abject.js';
import { Factory } from '../objects/factory.js';

export type RestartStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';

export interface SupervisorConfig {
  strategy: RestartStrategy;
  maxRestarts: number;
  maxTime: number; // Time window in ms
}

interface ChildState {
  object: Abject;
  restarts: number[];
}

/**
 * Supervises a group of objects and handles failures.
 */
export class Supervisor extends Abject {
  private children: Map<AbjectId, ChildState> = new Map();
  private factory?: Factory;

  constructor(
    name: string,
    private readonly config: SupervisorConfig = {
      strategy: 'one_for_one',
      maxRestarts: 3,
      maxTime: 5000,
    }
  ) {
    super({
      manifest: {
        name,
        description: `Supervisor using ${config.strategy} strategy`,
        version: '1.0.0',
        interfaces: [],
        requiredCapabilities: [],
        tags: ['system', 'supervisor'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('childFailed', async (msg: AbjectMessage) => {
      const { childId, error } = msg.payload as {
        childId: AbjectId;
        error: AbjectError;
      };
      await this.handleChildFailure(childId, error);
    });
  }

  /**
   * Set the factory for restarting children.
   */
  setFactory(factory: Factory): void {
    this.factory = factory;
  }

  /**
   * Add a child object to supervise.
   */
  addChild(obj: Abject): void {
    this.children.set(obj.id, {
      object: obj,
      restarts: [],
    });
    this.checkInvariants();
  }

  /**
   * Remove a child from supervision.
   */
  removeChild(objectId: AbjectId): boolean {
    const removed = this.children.delete(objectId);
    this.checkInvariants();
    return removed;
  }

  /**
   * Handle a child failure.
   */
  private async handleChildFailure(
    childId: AbjectId,
    error: AbjectError
  ): Promise<void> {
    const child = this.children.get(childId);
    if (!child) {
      return;
    }

    console.log(`[SUPERVISOR] Child ${childId} failed: ${error.message}`);

    // Check if we should restart
    const now = Date.now();
    child.restarts = child.restarts.filter(
      (t) => now - t < this.config.maxTime
    );

    if (child.restarts.length >= this.config.maxRestarts) {
      console.error(
        `[SUPERVISOR] Child ${childId} exceeded max restarts, giving up`
      );
      await this.handleMaxRestartsExceeded(childId);
      return;
    }

    // Apply restart strategy
    switch (this.config.strategy) {
      case 'one_for_one':
        await this.restartOne(childId);
        break;
      case 'one_for_all':
        await this.restartAll();
        break;
      case 'rest_for_one':
        await this.restartRest(childId);
        break;
    }

    child.restarts.push(now);
  }

  /**
   * Restart a single child.
   */
  private async restartOne(childId: AbjectId): Promise<void> {
    const child = this.children.get(childId);
    if (!child || !this.factory) {
      return;
    }

    console.log(`[SUPERVISOR] Restarting child ${childId}`);

    // Stop the failed object
    await child.object.stop();

    // Re-spawn it
    await this.factory.spawnInstance(child.object);
  }

  /**
   * Restart all children.
   */
  private async restartAll(): Promise<void> {
    if (!this.factory) {
      return;
    }

    console.log('[SUPERVISOR] Restarting all children');

    // Stop all children
    for (const [, child] of this.children) {
      await child.object.stop();
    }

    // Restart all children
    for (const [, child] of this.children) {
      await this.factory.spawnInstance(child.object);
    }
  }

  /**
   * Restart children after (and including) the failed one.
   */
  private async restartRest(failedId: AbjectId): Promise<void> {
    if (!this.factory) {
      return;
    }

    console.log(`[SUPERVISOR] Restarting children from ${failedId}`);

    // Find the failed child's position
    const ids = Array.from(this.children.keys());
    const failedIndex = ids.indexOf(failedId);
    if (failedIndex < 0) {
      return;
    }

    // Stop and restart from failed child onwards
    for (let i = failedIndex; i < ids.length; i++) {
      const child = this.children.get(ids[i])!;
      await child.object.stop();
    }

    for (let i = failedIndex; i < ids.length; i++) {
      const child = this.children.get(ids[i])!;
      await this.factory.spawnInstance(child.object);
    }
  }

  /**
   * Handle when max restarts exceeded.
   */
  private async handleMaxRestartsExceeded(childId: AbjectId): Promise<void> {
    // Remove from supervision
    this.children.delete(childId);

    // Escalate to parent supervisor (if any)
    // For now, just log
    console.error(`[SUPERVISOR] Child ${childId} permanently failed`);
  }

  /**
   * Get child count.
   */
  get childCount(): number {
    return this.children.size;
  }

  /**
   * Check class invariants.
   */
  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.children.size >= 0, 'child count must be non-negative');
  }
}
