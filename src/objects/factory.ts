/**
 * Factory object - spawns new objects from manifests and code.
 */

import {
  AbjectId,
  TypeId,
  AbjectManifest,
  AbjectMessage,
  ObjectRegistration,
  SpawnRequest,
  SpawnResult,
  CapabilityGrant,
} from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Factory');
import { request } from '../core/message.js';
import type { MessageBusLike } from '../runtime/message-bus.js';
import { type WorkerPool, workerIndexForId } from '../runtime/worker-pool.js';
import { ScriptableAbject, mergeScriptableManifest } from './scriptable-abject.js';
import { Organism, buildOrganismManifest } from './organism.js';
import type { OrganismSpec } from './organism.js';

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
  private workerRegistries: Map<AbjectId, AbjectId> = new Map(); // objectId → registryId

  constructor() {
    super({
      manifest: {
        name: 'Factory',
        description:
          'Creates new objects from manifests. Can spawn WASM objects or built-in types.',
        version: '1.0.0',
        interface: {
            id: FACTORY_INTERFACE,
            name: 'Factory',
            description: 'Abject creation and lifecycle management',
            methods: [
              {
                name: 'spawn',
                description: 'Create a new Abject from manifest',
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
                description: 'Stop and destroy an Abject',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to kill',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'respawn',
                description: 'Kill an Abject and respawn a fresh instance with the same ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to respawn',
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
                description: 'Clone an existing Abject (new instance with same manifest/source). Searches local registry first, then remote workspace registries. Pass registryHint to control which registry the clone lands in.',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to clone',
                  },
                  {
                    name: 'registryHint',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Optional registry ID to register the clone in (e.g. workspace registry). Defaults to global registry.',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'registerConstructor',
                description: 'Register a constructor for a named Abject type',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Abject type name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getObjectInfo',
                description: 'Get worker placement info for an Abject',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to query',
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
      const { objectId, registryHint } = msg.payload as { objectId: AbjectId; registryHint?: AbjectId };
      return this.clone(objectId, registryHint);
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

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Factory Usage Guide

### Methods
- \`spawn({ manifest, source?, code?, owner?, parentId? })\` — Spawn a new object. If a constructor is registered for the manifest name, uses that. If source is provided and manifest.tags includes 'organism', creates an Organism from a JSON OrganismSpec. If source is provided without the organism tag, creates a ScriptableAbject. Returns { objectId, status }.
- \`kill({ objectId })\` — Stop and destroy an object. Unregisters from Registry, removes from Supervisor, and stops the object. Returns boolean.
- \`clone({ objectId, registryHint? })\` — Clone an existing object (new instance with same manifest/source but new ID). Returns { objectId, status }. Works for Organisms -- the clone gets a fresh internal registry, organelles, and interface with new IDs. Searches local registry first, then remote workspace registries. Pass \`registryHint\` (a registry AbjectId) to register the clone in a specific registry (e.g. workspace registry) instead of the global one.
- \`respawn({ objectId, constructorName, parentId? })\` — Kill and re-create an object with the same ID. Used by Supervisor for restart.
- \`registerConstructor(name, factory)\` — Register a constructor function for a named object type.

### Organism
An Organism is a composite Abject with its own internal registry. Like a biological cell, it has organelles (internal ScriptableAbjects) hidden behind an interface (the membrane). To spawn one, pass \`source\` as a JSON-serialized OrganismSpec and include \`'organism'\` in \`manifest.tags\`. The spec defines an interface organelle (the externally visible face) and internal organelles that discover each other through the organism's internal registry. Organelles are not visible in the workspace Registry -- only the organism itself is.

### Object Inspection
- \`getObjectInfo({ objectId })\` — Returns \`{ isWorkerHosted, constructorName, workerIndex }\` or undefined if not found.

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
  async clone(objectId: AbjectId, registryHint?: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(this._factoryRegistryId !== undefined, 'Factory must have a registry');

    // Search local registry first
    let reg = await this.request<ObjectRegistration | null>(
      request(this.id, this._factoryRegistryId!, 'lookup', { objectId })
    );

    // If not found locally, search remote workspace registries
    if (!reg) {
      reg = await this.findInRemoteRegistries(objectId);
    }

    require(reg !== null, `Object '${objectId}' not found in any registry`);

    // Delegate to spawn with the same manifest and source
    const spawnReq: SpawnRequest = { manifest: reg!.manifest };
    if (reg!.source) {
      spawnReq.source = reg!.source;
      spawnReq.owner = reg!.owner;
    }
    if (registryHint) {
      spawnReq.registryHint = registryHint;
    }
    return this.spawn(spawnReq);
  }

  /**
   * Search remote workspace registries for an object by ID.
   */
  private async findInRemoteRegistries(objectId: AbjectId): Promise<ObjectRegistration | null> {
    try {
      const wsrId = await this.discoverDep('WorkspaceShareRegistry');
      if (!wsrId) return null;

      const workspaces = await this.request<Array<{ registryId: string }>>(
        request(this.id, wsrId, 'getDiscoveredWorkspaces', {})
      );

      for (const ws of workspaces) {
        try {
          const reg = await this.request<ObjectRegistration | null>(
            request(this.id, ws.registryId as AbjectId, 'lookup', { objectId })
          );
          if (reg) return reg;
        } catch { /* remote registry may be unreachable */ }
      }
    } catch { /* WorkspaceShareRegistry may not exist */ }

    return null;
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
            request(this.id, effectiveRegistryId, 'lookup', { objectId })
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
              'clearTimersForObject', { objectId }));
          }
        } catch { /* Timer may not be available */ }

        if (effectiveRegistryId) {
          try {
            await this.request(
              request(this.id, effectiveRegistryId, 'unregister', { objectId })
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
        interface: { id: 'abjects:unknown', name: constructorName, description: '', methods: [] }, requiredCapabilities: [] as never[], tags: ['system'] };
      const now = Date.now();
      const status = {
        id: objectId, state: 'ready' as const, manifest, connections: [] as AbjectId[],
        errorCount: 0, startedAt: now, lastActivity: now,
      };

      const preservedTypeId = existingReg?.typeId;

      if (effectiveRegistryId) {
        const regPayload: Record<string, unknown> = { objectId, manifest, status };
        if (preservedTypeId) regPayload.typeId = preservedTypeId;
        if (isScriptable && existingReg) {
          regPayload.source = existingReg.source;
          regPayload.owner = existingReg.owner;
        }
        await this.request(
          request(this.id, effectiveRegistryId, 'register', regPayload)
        );
      }

      return { objectId, typeId: preservedTypeId, status };
    }

    // Kill old instance if still tracked
    const old = this.spawned.get(objectId);
    const preservedTypeId = old?.typeId;
    if (old) {
      // Unregister from registry BEFORE stopping so cleanup notifications
      // fire while the object is still on the bus
      if (effectiveRegistryId) {
        try {
          await this.request(
            request(this.id, effectiveRegistryId, 'unregister', { objectId })
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
    if (preservedTypeId) obj.setTypeId(preservedTypeId);

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
      if (preservedTypeId) payload.typeId = preservedTypeId;
      if (obj instanceof Organism) {
        payload.source = obj.organismSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, effectiveRegistryId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      typeId: preservedTypeId,
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
    if (!factory && req.source && !req.manifest.tags?.includes('organism') && this._workerPool) {
      return this.spawnScriptableInWorker(req);
    }

    // Worker path for Organisms (entire organism runs in one worker)
    if (!factory && req.source && req.manifest.tags?.includes('organism') && this._workerPool) {
      return this.spawnOrganismInWorker(req);
    }

    let obj: Abject;

    if (factory) {
      // Use registered factory function
      obj = factory(req.constructorArgs);
    } else if (req.source && req.manifest.tags?.includes('organism')) {
      // Spawn an Organism from a JSON OrganismSpec (no worker pool)
      const spec = JSON.parse(req.source) as OrganismSpec;
      obj = new Organism(spec);
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

    // Set typeId if provided
    if (req.typeId) {
      obj.setTypeId(req.typeId);
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
      if (req.typeId) payload.typeId = req.typeId;
      if (obj instanceof Organism) {
        payload.source = obj.organismSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, targetRegistry, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      typeId: req.typeId,
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
      if (obj.typeId) payload.typeId = obj.typeId;
      if (obj instanceof Organism) {
        payload.source = obj.organismSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, this._factoryRegistryId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      typeId: obj.typeId,
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
    try {
      await this._workerPool!.spawnInWorker(objectId, req.manifest.name, {
        constructorArgs: req.constructorArgs,
        registryId: req.registryHint ?? this._factoryRegistryId,
        parentId: req.parentId ?? this.id,
      });
    } catch (err) {
      log.error(`Failed to spawn ${req.manifest.name} (${objectId.slice(0, 8)}) in worker:`, err);
      throw err;
    }

    // Track as worker-spawned
    this.workerSpawned.set(objectId, req.manifest.name);

    // Register with registry from main thread using the real manifest
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.typeId) regPayload.typeId = req.typeId;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
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

    // Compute the merged manifest (with introspect + editable methods) for registry
    const realManifest = mergeScriptableManifest(req.manifest);

    // Register with registry including source and owner (for AbjectStore)
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        owner: req.owner,
        source: req.source,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.typeId) regPayload.typeId = req.typeId;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
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
   * Spawn an Organism in a Web Worker.
   * The entire organism (internal registry + organelles + interface) runs in one worker.
   */
  private async spawnOrganismInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');
    require(req.source !== undefined, 'source is required for Organism');

    const spec = JSON.parse(req.source!) as OrganismSpec;
    const objectId = uuidv4() as AbjectId;

    await this._workerPool!.spawnInWorker(objectId, 'Organism', {
      constructorArgs: spec,
      registryId: req.registryHint ?? this._factoryRegistryId,
      parentId: req.parentId ?? this.id,
    });

    this.workerSpawned.set(objectId, 'Organism');

    // Build the merged manifest for registry registration
    const realManifest = buildOrganismManifest(spec);

    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        source: req.source,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.typeId) regPayload.typeId = req.typeId;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
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
   * Kill a worker-hosted object.
   */
  private async killWorkerObject(objectId: AbjectId): Promise<boolean> {
    if (!this._workerPool) return false;

    // Remove from Supervisor BEFORE stopping (prevents restart race)
    try {
      const supervisorId = await this.discoverDep('Supervisor');
      if (supervisorId) {
        await this.request(request(this.id, supervisorId,
          'removeChild', { childId: objectId }));
      }
    } catch { /* Supervisor may not be tracking this object */ }

    // Clear any active timers for this object so they stop firing immediately
    try {
      const timerId = await this.discoverDep('Timer');
      if (timerId) {
        await this.request(request(this.id, timerId,
          'clearTimersForObject', { objectId }));
      }
    } catch { /* Timer may not be available */ }

    // Unregister from the registry where the object was actually registered
    const objRegistry = this.workerRegistries.get(objectId) ?? this._factoryRegistryId;
    if (objRegistry) {
      try {
        await this.request(
          request(this.id, objRegistry, 'unregister', { objectId })
        );
      } catch { /* may not be registered */ }
    }

    // Remove from AbjectStore so it doesn't reappear on restart.
    // AbjectStore lives in the workspace registry, not the global one,
    // so we must discover it from the object's own registry.
    if (objRegistry) {
      try {
        const storeResults = await this.request<Array<{ id: AbjectId }>>(
          request(this.id, objRegistry, 'discover', { name: 'AbjectStore' })
        );
        if (storeResults.length > 0) {
          await this.request(
            request(this.id, storeResults[0].id, 'remove', { objectId })
          );
        }
      } catch { /* AbjectStore may not exist in this workspace */ }
    }

    // Kill in worker
    await this._workerPool.killInWorker(objectId);
    this.workerSpawned.delete(objectId);
    this.workerRegistries.delete(objectId);

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
          'removeChild', { childId: objectId }));
      }
    } catch { /* Supervisor may not be tracking this object */ }

    // Unregister from the registry where the object was actually registered
    // (workspace registry via registryHint, or global registry as fallback)
    const objRegistry = obj.getRegistryId() ?? this._factoryRegistryId;
    if (objRegistry) {
      await this.request(
        request(this.id, objRegistry, 'unregister', { objectId })
      );
    }

    // Remove from AbjectStore if it's a scriptable object.
    // AbjectStore lives in the workspace registry, not the global one,
    // so we must discover it from the object's own registry.
    if (obj.manifest.tags?.includes('scriptable') && objRegistry) {
      try {
        const storeResults = await this.request<Array<{ id: AbjectId }>>(
          request(this.id, objRegistry, 'discover', { name: 'AbjectStore' })
        );
        if (storeResults.length > 0) {
          await this.request(
            request(this.id, storeResults[0].id, 'remove', { objectId })
          );
        }
      } catch { /* AbjectStore may not exist in this workspace */ }
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
  override getRegistryId(): AbjectId | undefined {
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
  return request(fromId, FACTORY_ID, 'spawn', {
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
  return request(fromId, FACTORY_ID, 'clone', { objectId });
}

/**
 * Create a kill request message.
 */
export function createKillRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, FACTORY_ID, 'kill', { objectId });
}
