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

export type ObjectConstructor = new (options: {
  manifest: AbjectManifest;
  capabilities?: CapabilityGrant[];
  initialState?: unknown;
}) => Abject;

/**
 * The Factory object creates and manages object lifecycles.
 */
export class Factory extends Abject {
  private spawned: Map<AbjectId, Abject> = new Map();
  private constructors: Map<string, ObjectConstructor> = new Map();
  private _factoryBus?: MessageBus;
  private _registryId?: AbjectId;
  private _uiServerId?: AbjectId;

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
    this._registryId = id;
  }

  /**
   * Set the UI server ID for injecting system context into ScriptableAbjects.
   */
  setUIServerId(id: AbjectId): void {
    this._uiServerId = id;
  }

  /**
   * Register a constructor for a named object type.
   */
  registerConstructor(name: string, constructor: ObjectConstructor): void {
    require(name !== '', 'name must not be empty');
    this.constructors.set(name, constructor);
  }

  /**
   * Spawn a new object from a manifest.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(req.manifest !== undefined, 'manifest is required');

    // Check if we have a registered constructor
    const Constructor = this.constructors.get(req.manifest.name);

    let obj: Abject;

    if (Constructor) {
      // Use registered constructor
      obj = new Constructor({
        manifest: req.manifest,
        capabilities: req.grantedCapabilities,
        initialState: req.initialState,
      });
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

    // Initialize the object
    await obj.init(this._factoryBus!);

    // Track spawned object
    this.spawned.set(obj.id, obj);

    // Inject system context into ScriptableAbjects
    if (obj instanceof ScriptableAbject && this._registryId && this._uiServerId) {
      obj.setSystemContext({
        registryId: this._registryId,
        uiServerId: this._uiServerId,
      });
    }

    // Register with registry via message passing
    if (this._registryId) {
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
        request(this.id, this._registryId, 'abjects:registry' as InterfaceId, 'register', payload)
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
  async spawnInstance(obj: Abject): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');

    // Initialize the object
    await obj.init(this._factoryBus!);

    // Track spawned object
    this.spawned.set(obj.id, obj);

    // Inject system context into ScriptableAbjects
    if (obj instanceof ScriptableAbject && this._registryId && this._uiServerId) {
      obj.setSystemContext({
        registryId: this._registryId,
        uiServerId: this._uiServerId,
      });
    }

    // Register with registry via message passing
    if (this._registryId) {
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
        request(this.id, this._registryId, 'abjects:registry' as InterfaceId, 'register', payload)
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
    if (this._registryId) {
      await this.request(
        request(this.id, this._registryId, 'abjects:registry' as InterfaceId, 'unregister', { objectId })
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
