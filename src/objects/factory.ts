/**
 * Factory object - spawns new objects from manifests and code.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
  SpawnRequest,
  SpawnResult,
  CapabilityGrant,
} from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import { request } from '../core/message.js';
import type { MessageBusLike } from '../runtime/message-bus.js';
import { type WorkerPool, workerIndexForId } from '../runtime/worker-pool.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { CompositeAbject } from './composite-abject.js';
import type { CompositeSpec } from './composite-abject.js';

const FACTORY_INTERFACE = 'abjects:factory';

export type ObjectFactory = (args?: unknown) => Abject;

/**
 * The Factory object creates and manages object lifecycles.
 */
export class Factory extends Abject {
  private spawned: Map<AbjectId, Abject> = new Map();
  private constructors: Map<string, ObjectFactory> = new Map();
  private _factoryBus?: MessageBusLike;
  private _factoryRegistryId?: AbjectId;

  // Worker parallelism
  private _workerPool?: WorkerPool;
  private workerEligible: Set<string> = new Set();
  private workerSpawned: Map<AbjectId, string> = new Map(); // objectId → constructorName

  constructor() {
    super({
      manifest: {
        name: 'Factory',
        description:
          'Creates new objects from manifests. Can spawn WASM objects or built-in types.',
        version: '1.0.0',
        interfaces: [
          {
            id: FACTORY_INTERFACE,
            name: 'Factory',
            description: 'Object creation and lifecycle management',
            methods: [
              {
                name: 'spawn',
                description: 'Create a new object from manifest',
                parameters: [
                  {
                    name: 'request',
                    type: { kind: 'reference', reference: 'SpawnRequest' },
                    description: 'Spawn configuration',
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'kill',
                description: 'Stop and destroy an object',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to kill',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'respawn',
                description: 'Kill an object and respawn a fresh instance with the same ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to respawn',
                  },
                  {
                    name: 'constructorName',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The registered constructor name',
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'clone',
                description: 'Clone an existing object (new instance with same manifest/source)',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to clone',
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'registerConstructor',
                description: 'Register a constructor for a named object type',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object type name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getObjectInfo',
                description: 'Get worker placement info for an object',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to query',
                  },
                ],
                returns: { kind: 'object', properties: {
                  isWorkerHosted: { kind: 'primitive', primitive: 'boolean' },
                  constructorName: { kind: 'primitive', primitive: 'string' },
                  workerIndex: { kind: 'primitive', primitive: 'number' },
                }},
              },
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.FACTORY_SPAWN],
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('spawn', async (msg: AbjectMessage) => {
      const req = msg.payload as SpawnRequest;
      return this.spawn(req);
    });

    this.on('kill', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.kill(objectId);
    });

    this.on('clone', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.clone(objectId);
    });

    this.on('respawn', async (msg: AbjectMessage) => {
      const { objectId, constructorName, parentId, registryId } = msg.payload as {
        objectId: AbjectId;
        constructorName: string;
        parentId?: AbjectId;
        registryId?: AbjectId;
      };
      return this.respawn(objectId, constructorName, parentId, registryId);
    });

    this.on('getObjectInfo', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      const isWorker = this.workerSpawned.has(objectId);
      const constructorName = this.workerSpawned.get(objectId);
      const workerIndex = isWorker && this._workerPool
        ? workerIndexForId(objectId, this._workerPool.workerCount)
        : undefined;
      return { isWorkerHosted: isWorker, constructorName, workerIndex };
    });
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Factory Usage Guide

### Methods
- \`spawn({ manifest, source?, code?, owner?, parentId? })\` — Spawn a new object. If a constructor is registered for the manifest name, uses that. If source is provided and manifest.tags includes 'composite', creates a CompositeAbject from a JSON CompositeSpec. If source is provided without the composite tag, creates a ScriptableAbject. Returns { objectId, status }.
- \`kill({ objectId })\` — Stop and destroy an object. Unregisters from Registry, removes from Supervisor, and stops the object. Returns boolean.
- \`clone({ objectId })\` — Clone an existing object (new instance with same manifest/source but new ID). Returns { objectId, status }. Works for CompositeAbjects — the clone gets fresh children with new IDs.
- \`respawn({ objectId, constructorName, parentId? })\` — Kill and re-create an object with the same ID. Used by Supervisor for restart.
- \`registerConstructor(name, factory)\` — Register a constructor function for a named object type.

### CompositeAbject
A CompositeAbject groups multiple child ScriptableAbjects behind a single ID with unified interfaces. To spawn one, pass \`source\` as a JSON-serialized CompositeSpec and include \`'composite'\` in \`manifest.tags\`. The spec defines children (role + source + manifest), interfaces, and a routing table mapping "interfaceId::method" to strategies: delegate (single child), fanout (multiple children), or orchestrate (custom handler). Children are managed internally — they are not visible in the Registry unless exposeChildren is set.

### Key Constraints
- \`spawn()\` only works for pre-registered constructors or objects with source code. Use ObjectCreator to create entirely new objects from natural language prompts.
- \`clone()\` looks up the original object in the Registry and re-spawns with the same manifest and source.

### Interface ID
\`abjects:factory\``;
  }

  /**
   * Set the message bus for spawned objects.
   */
  setBus(bus: MessageBusLike): void {
    this._factoryBus = bus;
  }

  /**
   * Set the registry ID for object registration via message passing.
   */
  setRegistryId(id: AbjectId): void {
    this._factoryRegistryId = id;
  }

  /**
   * Set the worker pool for off-main-thread object execution.
   */
  setWorkerPool(pool: WorkerPool): void {
    this._workerPool = pool;
  }

  /**
   * Mark a constructor name as eligible for worker execution.
   */
  markWorkerEligible(name: string): void {
    this.workerEligible.add(name);
  }

  /**
   * Check if an object is hosted in a worker.
   */
  isWorkerHosted(objectId: AbjectId): boolean {
    return this.workerSpawned.has(objectId);
  }

  /**
   * Register a constructor for a named object type.
   */
  registerConstructor(name: string, factory: ObjectFactory): void {
    require(name !== '', 'name must not be empty');
    this.constructors.set(name, factory);
  }

  /**
   * Get a registered constructor by name.
   */
  getConstructor(name: string): ObjectFactory | undefined {
    return this.constructors.get(name);
  }

  /**
   * Clone an existing object — creates a new instance with the same manifest/source but a new ID.
   */
  async clone(objectId: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(this._factoryRegistryId !== undefined, 'Factory must have a registry');

    // Look up registration from Registry
    const reg = await this.request<ObjectRegistration | null>(
      request(this.id, this._factoryRegistryId!, 'abjects:registry' as InterfaceId, 'lookup', { objectId })
    );
    require(reg !== null, `Object '${objectId}' not found in registry`);

    // Delegate to spawn with the same manifest and source
    const spawnReq: SpawnRequest = { manifest: reg!.manifest };
    if (reg!.source) {
      spawnReq.source = reg!.source;
      spawnReq.owner = reg!.owner;
    }
    return this.spawn(spawnReq);
  }

  /**
   * Kill an old instance and spawn a fresh one with the same ID.
   * Used by Supervisor for same-ID restart.
   */
  async respawn(objectId: AbjectId, constructorName: string, parentId?: AbjectId, registryId?: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');

    // Use caller-provided registryId (e.g. workspace registry) or fall back to global
    const effectiveRegistryId = registryId ?? this._factoryRegistryId;

    // Worker path: if the constructor is worker-eligible OR the object is currently worker-hosted
    if (this._workerPool && (this.workerEligible.has(constructorName) || this.workerSpawned.has(objectId))) {
      // Look up existing registration before killing so we can capture source/manifest/owner
      let existingReg: ObjectRegistration | null = null;
      if (effectiveRegistryId) {
        try {
          existingReg = await this.request<ObjectRegistration | null>(
            request(this.id, effectiveRegistryId, 'abjects:registry' as InterfaceId, 'lookup', { objectId })
          );
        } catch { /* may not be registered */ }
      }

      // Kill old worker instance if tracked
      if (this.workerSpawned.has(objectId)) {
        // Clear timers before killing so they stop firing immediately
        try {
          const timerId = await this.discoverDep('Timer');
          if (timerId) {
            await this.request(request(this.id, timerId,
              'abjects:timer' as InterfaceId, 'clearTimersForObject', { objectId }));
          }
        } catch { /* Timer may not be available */ }

        if (effectiveRegistryId) {
          try {
            await this.request(
              request(this.id, effectiveRegistryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
            );
          } catch { /* may not be registered */ }
        }
        await this._workerPool.killInWorker(objectId);
        this.workerSpawned.delete(objectId);
      }

      // Respawn in worker with same ID, passing constructor args for ScriptableAbjects
      const isScriptable = constructorName === 'ScriptableAbject';
      if (isScriptable) {
        if (!existingReg?.source) {
          throw new Error(`Cannot respawn ScriptableAbject '${objectId}': registration/source not found in Registry`);
        }
        await this._workerPool.spawnInWorker(objectId, constructorName, {
          constructorArgs: {
            manifest: existingReg.manifest,
            source: existingReg.source,
            owner: existingReg.owner ?? '',
          },
          registryId: effectiveRegistryId,
          parentId: parentId ?? this.id,
        });
      } else {
        await this._workerPool.spawnInWorker(objectId, constructorName, {
          registryId: effectiveRegistryId,
          parentId: parentId ?? this.id,
        });
      }
      this.workerSpawned.set(objectId, constructorName);

      // Use real manifest from the existing registration if available, otherwise build a placeholder
      const manifest = existingReg?.manifest ?? { name: constructorName, description: '', version: '1.0.0',
        interfaces: [], requiredCapabilities: [] as never[], tags: ['system'] };
      const now = Date.now();
      const status = {
        id: objectId, state: 'ready' as const, manifest, connections: [] as AbjectId[],
        errorCount: 0, startedAt: now, lastActivity: now,
      };

      if (effectiveRegistryId) {
        const regPayload: Record<string, unknown> = { objectId, manifest, status };
        if (isScriptable && existingReg) {
          regPayload.source = existingReg.source;
          regPayload.owner = existingReg.owner;
        }
        await this.request(
          request(this.id, effectiveRegistryId, 'abjects:registry' as InterfaceId, 'register', regPayload)
        );
      }

      return { objectId, status };
    }

    // Kill old instance if still tracked
    const old = this.spawned.get(objectId);
    if (old) {
      // Unregister from registry BEFORE stopping so cleanup notifications
      // fire while the object is still on the bus
      if (effectiveRegistryId) {
        try {
          await this.request(
            request(this.id, effectiveRegistryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
          );
        } catch { /* may not be registered */ }
      }

      try {
        await old.stop();
      } catch {
        // Object may already be stopped/dead
      }
      this.spawned.delete(objectId);
    }

    // Create fresh instance with same ID
    const factory = this.constructors.get(constructorName);
    if (!factory) throw new Error(`No constructor for '${constructorName}'`);
    const obj = factory();
    obj.setId(objectId);

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    if (effectiveRegistryId) {
      obj.setRegistryHint(effectiveRegistryId);
    }

    // Initialize and register
    await obj.init(this._factoryBus!, parentId ?? this.id);
    this.spawned.set(obj.id, obj);

    if (effectiveRegistryId) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (obj instanceof CompositeAbject) {
        payload.source = obj.compositeSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, effectiveRegistryId, 'abjects:registry' as InterfaceId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      status: obj.status,
    };
  }

  /**
   * Spawn a new object from a manifest.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(req.manifest !== undefined, 'manifest is required');

    // Check if we have a registered factory
    const factory = this.constructors.get(req.manifest.name);

    // Worker path: if the constructor is worker-eligible, delegate to WorkerPool
    if (factory && this._workerPool && this.workerEligible.has(req.manifest.name)) {
      return this.spawnInWorker(req);
    }

    // Worker path for ScriptableAbjects (user-created objects with source code)
    if (!factory && req.source && !req.manifest.tags?.includes('composite') && this._workerPool) {
      return this.spawnScriptableInWorker(req);
    }

    let obj: Abject;

    if (factory) {
      // Use registered factory function
      obj = factory(req.constructorArgs);
    } else if (req.source && req.manifest.tags?.includes('composite')) {
      // Spawn a CompositeAbject from a JSON spec
      const spec = JSON.parse(req.source) as CompositeSpec;
      obj = new CompositeAbject(spec);
    } else if (req.source) {
      // Spawn a ScriptableAbject from handler source
      obj = new ScriptableAbject(
        req.manifest,
        req.source,
        req.owner ?? ('' as AbjectId)
      );
    } else if (req.code) {
      // TODO: Load WASM object
      throw new Error('WASM object spawning not yet implemented');
    } else {
      throw new Error(
        `No constructor registered for '${req.manifest.name}' and no code provided`
      );
    }

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    // Use registryHint from request if provided (workspace objects), else Factory's registry
    const hint = req.registryHint ?? this._factoryRegistryId;
    if (hint) {
      obj.setRegistryHint(hint);
    }

    // Initialize the object with parentId (default to Factory)
    await obj.init(this._factoryBus!, req.parentId ?? this.id);

    // Track spawned object
    this.spawned.set(obj.id, obj);

    // Register with the appropriate registry:
    // - If registryHint is specified, register there (workspace objects)
    // - Otherwise register in the global registry (unless skipGlobalRegistry)
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (obj instanceof CompositeAbject) {
        payload.source = obj.compositeSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, targetRegistry, 'abjects:registry' as InterfaceId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      status: obj.status,
    };
  }

  /**
   * Spawn an existing object instance.
   */
  async spawnInstance(obj: Abject, parentId?: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    if (this._factoryRegistryId) {
      obj.setRegistryHint(this._factoryRegistryId);
    }

    // Initialize the object
    await obj.init(this._factoryBus!, parentId);

    // Track spawned object
    this.spawned.set(obj.id, obj);

    // Register with registry via message passing
    if (this._factoryRegistryId) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (obj instanceof CompositeAbject) {
        payload.source = obj.compositeSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, this._factoryRegistryId, 'abjects:registry' as InterfaceId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      status: obj.status,
    };
  }

  /**
   * Spawn an object in a Web Worker via the WorkerPool.
   * The object runs off-main-thread; the main thread only holds its ID.
   */
  private async spawnInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');

    // Generate the object ID on the main thread (so we can register with Registry)
    const objectId = uuidv4() as AbjectId;

    // Create a temporary instance to get the real manifest (constructor name
    // in the constructors map may differ from manifest.name)
    const factory = this.constructors.get(req.manifest.name)!;
    const tempObj = factory(req.constructorArgs);
    const realManifest = tempObj.manifest;

    // Spawn in worker — pass registryId and parentId so the worker-side
    // object can discover dependencies and communicate with the bus hub
    await this._workerPool!.spawnInWorker(objectId, req.manifest.name, {
      constructorArgs: req.constructorArgs,
      registryId: req.registryHint ?? this._factoryRegistryId,
      parentId: req.parentId ?? this.id,
    });

    // Track as worker-spawned
    this.workerSpawned.set(objectId, req.manifest.name);

    // Register with registry from main thread using the real manifest
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) {
      const now = Date.now();
      await this.request(
        request(this.id, targetRegistry, 'abjects:registry' as InterfaceId, 'register', {
          objectId,
          manifest: realManifest,
          status: {
            id: objectId,
            state: 'ready',
            manifest: realManifest,
            connections: [] as AbjectId[],
            errorCount: 0,
            startedAt: now,
            lastActivity: now,
          },
        })
      );
    }

    const now = Date.now();
    return {
      objectId,
      status: {
        id: objectId,
        state: 'ready',
        manifest: realManifest,
        connections: [] as AbjectId[],
        errorCount: 0,
        startedAt: now,
        lastActivity: now,
      },
    };
  }

  /**
   * Spawn a ScriptableAbject in a Web Worker.
   * Unlike spawnInWorker(), this handles dynamic objects created from source code.
   */
  private async spawnScriptableInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');
    require(req.source !== undefined, 'source is required for ScriptableAbject');

    const objectId = uuidv4() as AbjectId;

    await this._workerPool!.spawnInWorker(objectId, 'ScriptableAbject', {
      constructorArgs: {
        manifest: req.manifest,
        source: req.source,
        owner: req.owner ?? '',
      },
      registryId: req.registryHint ?? this._factoryRegistryId,
      parentId: req.parentId ?? this.id,
    });

    this.workerSpawned.set(objectId, 'ScriptableAbject');

    // Register with registry including source and owner (for AbjectStore)
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) {
      const now = Date.now();
      await this.request(
        request(this.id, targetRegistry, 'abjects:registry' as InterfaceId, 'register', {
          objectId,
          manifest: req.manifest,
          owner: req.owner,
          source: req.source,
          status: {
            id: objectId,
            state: 'ready',
            manifest: req.manifest,
            connections: [] as AbjectId[],
            errorCount: 0,
            startedAt: now,
            lastActivity: now,
          },
        })
      );
    }

    const now = Date.now();
    return {
      objectId,
      status: {
        id: objectId,
        state: 'ready',
        manifest: req.manifest,
        connections: [] as AbjectId[],
        errorCount: 0,
        startedAt: now,
        lastActivity: now,
      },
    };
  }

  /**
   * Kill a worker-hosted object.
   */
  private async killWorkerObject(objectId: AbjectId): Promise<boolean> {
    if (!this._workerPool) return false;

    // Remove from Supervisor BEFORE stopping (prevents restart race)
    try {
      const supervisorId = await this.discoverDep('Supervisor');
      if (supervisorId) {
        await this.request(request(this.id, supervisorId,
          'abjects:supervisor' as InterfaceId, 'removeChild', { childId: objectId }));
      }
    } catch { /* Supervisor may not be tracking this object */ }

    // Clear any active timers for this object so they stop firing immediately
    try {
      const timerId = await this.discoverDep('Timer');
      if (timerId) {
        await this.request(request(this.id, timerId,
          'abjects:timer' as InterfaceId, 'clearTimersForObject', { objectId }));
      }
    } catch { /* Timer may not be available */ }

    // Unregister from registry
    if (this._factoryRegistryId) {
      try {
        await this.request(
          request(this.id, this._factoryRegistryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
        );
      } catch { /* may not be registered */ }
    }

    // Kill in worker
    await this._workerPool.killInWorker(objectId);
    this.workerSpawned.delete(objectId);

    return true;
  }

  /**
   * Kill an object.
   */
  async kill(objectId: AbjectId): Promise<boolean> {
    // Check if this is a worker-hosted object
    if (this.workerSpawned.has(objectId)) {
      return this.killWorkerObject(objectId);
    }

    const obj = this.spawned.get(objectId);
    if (!obj) {
      return false;
    }

    // Remove from Supervisor BEFORE stopping (prevents restart race)
    try {
      const supervisorId = await this.discoverDep('Supervisor');
      if (supervisorId) {
        await this.request(request(this.id, supervisorId,
          'abjects:supervisor' as InterfaceId, 'removeChild', { childId: objectId }));
      }
    } catch { /* Supervisor may not be tracking this object */ }

    // Unregister from registry BEFORE stopping so cleanup notifications
    // fire while the object is still on the bus
    if (this._factoryRegistryId) {
      await this.request(
        request(this.id, this._factoryRegistryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
      );
    }

    // Remove from AbjectStore if it's a scriptable object
    if (obj.manifest.tags?.includes('scriptable')) {
      try {
        const abjectStoreId = await this.discoverDep('AbjectStore');
        if (abjectStoreId) {
          await this.request(
            request(this.id, abjectStoreId, 'abjects:abject-store' as InterfaceId, 'remove', { objectId })
          );
        }
      } catch { /* AbjectStore may not exist */ }
    }

    await obj.stop();
    this.spawned.delete(objectId);

    this.checkInvariants();
    return true;
  }

  /**
   * Get a spawned object by ID.
   */
  getObject(objectId: AbjectId): Abject | undefined {
    return this.spawned.get(objectId);
  }

  /**
   * Get all spawned objects.
   */
  getAllObjects(): Abject[] {
    return Array.from(this.spawned.values());
  }

  /**
   * Get spawned object count.
   */
  get objectCount(): number {
    return this.spawned.size;
  }

  /**
   * Factory knows the Registry directly.
   */
  protected override getRegistryId(): AbjectId | undefined {
    return this._factoryRegistryId ?? super.getRegistryId();
  }

  /**
   * Check class invariants.
   */
  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.spawned.size >= 0, 'spawned count must be non-negative');
  }
}

// Well-known factory ID
export const FACTORY_ID = 'abjects:factory' as AbjectId;

/**
 * Create a spawn request message.
 */
export function createSpawnRequest(
  fromId: AbjectId,
  manifest: AbjectManifest,
  code?: ArrayBuffer,
  initialState?: unknown,
  grantedCapabilities?: CapabilityGrant[]
): AbjectMessage {
  return request(fromId, FACTORY_ID, FACTORY_INTERFACE, 'spawn', {
    manifest,
    code,
    initialState,
    grantedCapabilities,
  } as SpawnRequest);
}

/**
 * Create a clone request message.
 */
export function createCloneRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, FACTORY_ID, FACTORY_INTERFACE, 'clone', { objectId });
}

/**
 * Create a kill request message.
 */
export function createKillRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, FACTORY_ID, FACTORY_INTERFACE, 'kill', { objectId });
}
