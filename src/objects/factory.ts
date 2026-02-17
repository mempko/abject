/**
 * Factory object - spawns new objects from manifests and code.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  SpawnRequest,
  SpawnResult,
  CapabilityGrant,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { ScriptableAbject } from './scriptable-abject.js';

const FACTORY_INTERFACE = 'abjects:factory';

export type ObjectFactory = () => Abject;

/**
 * The Factory object creates and manages object lifecycles.
 */
export class Factory extends Abject {
  private spawned: Map<AbjectId, Abject> = new Map();
  private constructors: Map<string, ObjectFactory> = new Map();
  private _factoryBus?: MessageBus;
  private _factoryRegistryId?: AbjectId;

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

    this.on('respawn', async (msg: AbjectMessage) => {
      const { objectId, constructorName, parentId } = msg.payload as {
        objectId: AbjectId;
        constructorName: string;
        parentId?: AbjectId;
      };
      return this.respawn(objectId, constructorName, parentId);
    });
  }

  /**
   * Set the message bus for spawned objects.
   */
  setBus(bus: MessageBus): void {
    this._factoryBus = bus;
  }

  /**
   * Set the registry ID for object registration via message passing.
   */
  setRegistryId(id: AbjectId): void {
    this._factoryRegistryId = id;
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
   * Kill an old instance and spawn a fresh one with the same ID.
   * Used by Supervisor for same-ID restart.
   */
  async respawn(objectId: AbjectId, constructorName: string, parentId?: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');

    // Kill old instance if still tracked
    const old = this.spawned.get(objectId);
    if (old) {
      try {
        await old.stop();
      } catch {
        // Object may already be stopped/dead
      }
      this.spawned.delete(objectId);

      // Unregister from registry
      if (this._factoryRegistryId) {
        try {
          await this.request(
            request(this.id, this._factoryRegistryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
          );
        } catch { /* may not be registered */ }
      }
    }

    // Create fresh instance with same ID
    const factory = this.constructors.get(constructorName);
    if (!factory) throw new Error(`No constructor for '${constructorName}'`);
    const obj = factory();
    obj.setId(objectId);

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    if (this._factoryRegistryId) {
      obj.setRegistryHint(this._factoryRegistryId);
    }

    // Initialize and register
    await obj.init(this._factoryBus!, parentId ?? this.id);
    this.spawned.set(obj.id, obj);

    if (this._factoryRegistryId) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (obj instanceof ScriptableAbject) {
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
   * Spawn a new object from a manifest.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(req.manifest !== undefined, 'manifest is required');

    // Check if we have a registered factory
    const factory = this.constructors.get(req.manifest.name);

    let obj: Abject;

    if (factory) {
      // Use registered factory function
      obj = factory();
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
    if (this._factoryRegistryId) {
      obj.setRegistryHint(this._factoryRegistryId);
    }

    // Initialize the object with parentId (default to Factory)
    await obj.init(this._factoryBus!, req.parentId ?? this.id);

    // Track spawned object
    this.spawned.set(obj.id, obj);

    // Register with registry via message passing
    if (this._factoryRegistryId) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (obj instanceof ScriptableAbject) {
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
      if (obj instanceof ScriptableAbject) {
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
   * Kill an object.
   */
  async kill(objectId: AbjectId): Promise<boolean> {
    const obj = this.spawned.get(objectId);
    if (!obj) {
      return false;
    }

    await obj.stop();
    this.spawned.delete(objectId);

    // Unregister from registry via message passing
    if (this._factoryRegistryId) {
      await this.request(
        request(this.id, this._factoryRegistryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
      );
    }

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
 * Create a kill request message.
 */
export function createKillRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, FACTORY_ID, FACTORY_INTERFACE, 'kill', { objectId });
}
