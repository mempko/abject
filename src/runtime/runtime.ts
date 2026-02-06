/**
 * Main runtime - orchestrates system bootstrap and core services.
 */

import { AbjectId } from '../core/types.js';
import { require, ensure, invariant } from '../core/contracts.js';
import { MessageBus, LoggingInterceptor } from './message-bus.js';
import { Registry } from '../objects/registry.js';
import { Factory } from '../objects/factory.js';
import { Abject } from '../core/abject.js';

export interface RuntimeConfig {
  debug?: boolean;
  workerEnabled?: boolean;
}

export type RuntimeState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * The main runtime that bootstraps and manages the Abjects system.
 */
export class Runtime {
  private state: RuntimeState = 'created';
  private bus: MessageBus;
  private registry: Registry;
  private factory: Factory;
  private coreObjects: Map<AbjectId, Abject> = new Map();

  constructor(private readonly _config: RuntimeConfig = {}) {
    this.bus = new MessageBus();
    this.registry = new Registry();
    this.factory = new Factory();

    if (this._config.debug) {
      this.bus.addInterceptor(new LoggingInterceptor('[ABJECTS]'));
    }
  }

  /**
   * Get current runtime state.
   */
  get currentState(): RuntimeState {
    return this.state;
  }

  /**
   * Get the message bus.
   */
  get messageBus(): MessageBus {
    return this.bus;
  }

  /**
   * Get the registry.
   */
  get objectRegistry(): Registry {
    return this.registry;
  }

  /**
   * Get the factory.
   */
  get objectFactory(): Factory {
    return this.factory;
  }

  /**
   * Start the runtime.
   */
  async start(): Promise<void> {
    require(this.state === 'created', 'Runtime already started');

    this.state = 'starting';

    // Bootstrap core objects
    await this.bootstrapCore();

    this.state = 'running';

    console.log('[RUNTIME] Abjects runtime started');
    console.log(`[RUNTIME] Registry: ${this.registry.objectCount} objects`);

    this.checkInvariants();
  }

  /**
   * Stop the runtime.
   */
  async stop(): Promise<void> {
    require(
      this.state === 'running',
      `Cannot stop runtime in state: ${this.state}`
    );

    this.state = 'stopping';

    // Stop all spawned objects
    for (const obj of this.factory.getAllObjects()) {
      await obj.stop();
    }

    // Stop core objects
    await this.registry.stop();
    await this.factory.stop();

    this.state = 'stopped';

    console.log('[RUNTIME] Abjects runtime stopped');
  }

  /**
   * Register a core object that should be available at startup.
   */
  registerCoreObject(obj: Abject): void {
    require(
      this.state === 'created',
      'Cannot register core objects after startup'
    );
    this.coreObjects.set(obj.id, obj);
  }

  /**
   * Spawn a new object through the factory.
   */
  async spawn(obj: Abject): Promise<void> {
    require(this.state === 'running', 'Runtime not running');
    await this.factory.spawnInstance(obj);
  }

  /**
   * Get an object by ID.
   */
  getObject(objectId: AbjectId): Abject | undefined {
    return this.factory.getObject(objectId);
  }

  /**
   * Bootstrap core system objects.
   */
  private async bootstrapCore(): Promise<void> {
    // Wire up factory with bus and registry ID
    this.factory.setBus(this.bus);
    this.factory.setRegistryId(this.registry.id);

    // Initialize registry first (it registers itself)
    await this.registry.init(this.bus);
    this.registry.registerObject(
      this.registry.id,
      this.registry.manifest,
      this.registry.status
    );

    // Initialize factory
    await this.factory.init(this.bus);
    this.registry.registerObject(
      this.factory.id,
      this.factory.manifest,
      this.factory.status
    );

    // Spawn any pre-registered core objects
    for (const [, obj] of this.coreObjects) {
      await this.factory.spawnInstance(obj);
    }

    ensure(
      this.registry.objectCount >= 2,
      'At least registry and factory must be registered'
    );
  }

  /**
   * Check class invariants.
   */
  private checkInvariants(): void {
    invariant(
      this.state !== 'running' || this.registry.objectCount >= 2,
      'Running runtime must have at least 2 core objects'
    );
  }
}

// Singleton runtime instance
let globalRuntime: Runtime | undefined;

/**
 * Get or create the global runtime instance.
 */
export function getRuntime(config?: RuntimeConfig): Runtime {
  if (!globalRuntime) {
    globalRuntime = new Runtime(config);
  }
  return globalRuntime;
}

/**
 * Reset the global runtime (for testing).
 */
export function resetRuntime(): void {
  globalRuntime = undefined;
}
