/**
 * Erlang-style Supervisor — manages object lifecycles using child specs.
 *
 * Objects are described declaratively via ChildSpec (constructor name, restart type).
 * When a child fails, the Supervisor asks Factory to respawn it with the same ID
 * so existing references remain valid.
 *
 * Restart types:
 *   permanent  — always restart
 *   transient  — restart only on abnormal exit (error)
 *   temporary  — never restart
 */

import { AbjectId, AbjectMessage, AbjectError } from '../core/types.js';
import { invariant, require as contractRequire } from '../core/contracts.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SUPERVISOR');

export type RestartStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';
export type RestartType = 'permanent' | 'transient' | 'temporary';

export interface ChildSpec {
  id: AbjectId;
  constructorName: string;
  restart: RestartType;
  parentId?: AbjectId;
}

interface ChildState {
  spec: ChildSpec;
  restarts: number[]; // timestamps of recent restarts
}

export interface SupervisorConfig {
  strategy: RestartStrategy;
  maxRestarts: number;
  maxTime: number; // Time window in ms
}

const SUPERVISOR_INTERFACE = 'abjects:supervisor';

/**
 * Supervises a group of objects and handles failures.
 * Uses child specs and Factory respawn for same-ID restart.
 */
export class Supervisor extends Abject {
  private children: Map<AbjectId, ChildState> = new Map();
  private factoryId?: AbjectId;
  private healthMonitorId?: AbjectId;

  constructor(
    private readonly config: SupervisorConfig = {
      strategy: 'one_for_one',
      maxRestarts: 3,
      maxTime: 5000,
    }
  ) {
    super({
      manifest: {
        name: 'Supervisor',
        description: `Erlang-style supervisor using ${config.strategy} strategy. Monitors child objects and restarts them on failure.`,
        version: '1.0.0',
        interface: {
            id: SUPERVISOR_INTERFACE,
            name: 'Supervisor',
            description: 'Object supervision and restart management',
            methods: [
              {
                name: 'addChild',
                description: 'Register a child spec for supervision',
                parameters: [
                  {
                    name: 'spec',
                    type: { kind: 'reference', reference: 'ChildSpec' },
                    description: 'The child specification',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'removeChild',
                description: 'Remove a child from supervision',
                parameters: [
                  {
                    name: 'childId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the child to remove',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getChildren',
                description: 'List all supervised children',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ChildSpec' },
                },
              },
            ],
            events: [
              {
                name: 'childFailed',
                description: 'Notification that a supervised child has failed',
                payload: {
                  kind: 'object',
                  properties: {
                    childId: { kind: 'primitive', primitive: 'string' },
                    error: { kind: 'reference', reference: 'AbjectError' },
                  },
                },
              },
              {
                name: 'childRestarted',
                description: 'Notification that a child was successfully restarted',
                payload: {
                  kind: 'object',
                  properties: {
                    childId: { kind: 'primitive', primitive: 'string' },
                    constructorName: { kind: 'primitive', primitive: 'string' },
                  },
                },
              },
              {
                name: 'childGaveUp',
                description: 'Notification that restart limit was exceeded for a child',
                payload: {
                  kind: 'object',
                  properties: {
                    childId: { kind: 'primitive', primitive: 'string' },
                  },
                },
              },
            ],
          },
        requiredCapabilities: [],
        tags: ['system', 'supervisor'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('addChild', async (msg: AbjectMessage) => {
      const spec = msg.payload as ChildSpec;
      return this.addChild(spec);
    });

    this.on('removeChild', async (msg: AbjectMessage) => {
      const { childId } = msg.payload as { childId: AbjectId };
      return this.removeChild(childId);
    });

    this.on('getChildren', async () => {
      return this.getChildren();
    });

    this.on('childFailed', async (msg: AbjectMessage) => {
      const { childId, error } = msg.payload as {
        childId: AbjectId;
        error: AbjectError;
      };
      await this.handleChildFailure(childId, error);
    });
  }

  protected override async onInit(): Promise<void> {
    // Discover Factory via Registry
    try {
      this.factoryId = await this.requireDep('Factory');
    } catch {
      log.warn('Could not discover Factory — restarts will fail');
    }

    // Discover HealthMonitor (to re-mark objects ready after restart)
    try {
      this.healthMonitorId = await this.discoverDep('HealthMonitor') ?? undefined;
    } catch {
      // HealthMonitor may not be spawned yet
    }
  }

  /**
   * Add a child spec to supervision.
   */
  addChild(spec: ChildSpec): boolean {
    contractRequire(spec.id !== '', 'child spec must have an id');
    contractRequire(spec.constructorName !== '', 'child spec must have a constructorName');

    if (this.children.has(spec.id)) {
      // Update the spec if child already registered
      this.children.get(spec.id)!.spec = spec;
      return true;
    }

    this.children.set(spec.id, {
      spec,
      restarts: [],
    });

    this.checkInvariants();
    return true;
  }

  /**
   * Remove a child from supervision.
   */
  removeChild(childId: AbjectId): boolean {
    const removed = this.children.delete(childId);
    this.checkInvariants();
    return removed;
  }

  /**
   * Get all supervised child specs.
   */
  getChildren(): ChildSpec[] {
    return Array.from(this.children.values()).map(c => c.spec);
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

    log.info(`Child ${childId} (${child.spec.constructorName}) failed: ${error.message}`);

    // Temporary children are never restarted
    if (child.spec.restart === 'temporary') {
      log.info(`Child ${childId} is temporary — not restarting`);
      this.children.delete(childId);
      return;
    }

    // Check if we should restart
    const now = Date.now();
    child.restarts = child.restarts.filter(
      (t) => now - t < this.config.maxTime
    );

    if (child.restarts.length >= this.config.maxRestarts) {
      log.error(
        `Child ${childId} exceeded max restarts (${this.config.maxRestarts} in ${this.config.maxTime}ms), giving up`
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
   * Restart a single child via Factory respawn.
   */
  private async restartOne(childId: AbjectId): Promise<void> {
    const child = this.children.get(childId);
    if (!child || !this.factoryId) {
      log.error(`Cannot restart ${childId} — no factory or child spec`);
      return;
    }

    log.info(`Restarting child ${childId} (${child.spec.constructorName})`);

    try {
      await this.request(
        request(this.id, this.factoryId, 'respawn', {
          objectId: childId,
          constructorName: child.spec.constructorName,
          parentId: child.spec.parentId,
        })
      );
      log.info(`Child ${childId} restarted successfully`);

      // Notify HealthMonitor the object is ready for pings again
      await this.notifyHealthMonitorReady(childId);
    } catch (err) {
      log.error(`Failed to restart child ${childId}:`, err);
    }
  }

  /**
   * Restart all children.
   */
  private async restartAll(): Promise<void> {
    if (!this.factoryId) {
      return;
    }

    log.info('Restarting all children');

    for (const [childId] of this.children) {
      await this.restartOne(childId);
    }
  }

  /**
   * Restart children after (and including) the failed one.
   */
  private async restartRest(failedId: AbjectId): Promise<void> {
    if (!this.factoryId) {
      return;
    }

    log.info(`Restarting children from ${failedId}`);

    const ids = Array.from(this.children.keys());
    const failedIndex = ids.indexOf(failedId);
    if (failedIndex < 0) {
      return;
    }

    for (let i = failedIndex; i < ids.length; i++) {
      await this.restartOne(ids[i]);
    }
  }

  /**
   * Tell HealthMonitor the restarted child is ready for liveness pings.
   */
  private async notifyHealthMonitorReady(childId: AbjectId): Promise<void> {
    // Lazily discover HealthMonitor if not found at init time
    if (!this.healthMonitorId) {
      try {
        this.healthMonitorId = await this.discoverDep('HealthMonitor') ?? undefined;
      } catch {
        // Still no HealthMonitor
      }
    }
    if (!this.healthMonitorId) return;

    try {
      await this.request(
        request(this.id, this.healthMonitorId,
          'markObjectReady', { objectId: childId })
      );
    } catch {
      // best effort
    }
  }

  /**
   * Handle when max restarts exceeded.
   */
  private async handleMaxRestartsExceeded(childId: AbjectId): Promise<void> {
    // Remove from supervision
    this.children.delete(childId);

    log.error(`Child ${childId} permanently failed`);
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

  protected override getSourceForAsk(): string | undefined {
    return `## Supervisor Usage Guide

### Add a supervised child

  await call(await dep('Supervisor'), 'addChild', {
    id: 'child-object-id', constructorName: 'MyObject', restart: 'permanent'
  });

Restart types:
- 'permanent' — always restarted when it stops
- 'transient' — restarted only if it stops abnormally (with an error)
- 'temporary' — never restarted

### Remove a supervised child

  await call(await dep('Supervisor'), 'removeChild', { childId: 'child-object-id' });

### List supervised children

  const children = await call(await dep('Supervisor'), 'getChildren', {});
  // children: [{ id, constructorName, restart, restarts }]

### Report a child failure

  await call(await dep('Supervisor'), 'childFailed', {
    childId: 'child-object-id', error: { code: 'CRASH', message: 'unexpected error' }
  });

### IMPORTANT
- The interface ID is 'abjects:supervisor'.
- The Supervisor uses Factory to respawn crashed children.
- Restart intensity is rate-limited — too many restarts in a short window stops the child permanently.`;
  }
}

// Well-known supervisor ID
export const SUPERVISOR_ID = 'abjects:supervisor' as AbjectId;
