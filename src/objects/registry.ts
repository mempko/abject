/**
 * Registry object - central directory of all objects in the system.
 */

import {
  AbjectId,
  TypeId,
  AbjectManifest,
  AbjectMessage,
  ObjectRegistration,
  DiscoveryQuery,
  AbjectStatus,
  InterfaceId,
  CapabilityId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Registry');

const REGISTRY_INTERFACE = 'abjects:registry' as InterfaceId;

export interface RegistryState {
  objects: Map<AbjectId, ObjectRegistration>;
  byInterface: Map<InterfaceId, Set<AbjectId>>;
  byCapability: Map<CapabilityId, Set<AbjectId>>;
  byName: Map<string, Set<AbjectId>>;
  byTypeId: Map<TypeId, AbjectId>;
}

/**
 * The Registry object manages object discovery and registration.
 */
export class Registry extends Abject {
  private objects: Map<AbjectId, ObjectRegistration> = new Map();
  private byInterface: Map<InterfaceId, Set<AbjectId>> = new Map();
  private byCapability: Map<CapabilityId, Set<AbjectId>> = new Map();
  private byName: Map<string, Set<AbjectId>> = new Map();
  private byTypeId: Map<TypeId, AbjectId> = new Map();
  private subscribers: Set<AbjectId> = new Set();
  private exposedObjectIds: Set<AbjectId> = new Set();
  private filteringConfigured = false;

  constructor() {
    super({
      manifest: {
        name: 'Registry',
        description:
          'Central directory for object discovery. Objects register here to be discoverable by others.',
        version: '1.0.0',
        interface: {
            id: REGISTRY_INTERFACE,
            name: 'Registry',
            description: 'Abject registration and discovery',
            methods: [
              {
                name: 'register',
                description: 'Register an Abject with the registry',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to register',
                  },
                  {
                    name: 'manifest',
                    type: { kind: 'reference', reference: 'AbjectManifest' },
                    description: 'The Abject manifest',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unregister',
                description: 'Remove an Abject from the registry',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to unregister',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'lookup',
                description: 'Look up an Abject by ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to look up',
                  },
                ],
                returns: {
                  kind: 'union',
                  variants: [
                    { kind: 'reference', reference: 'ObjectRegistration' },
                    { kind: 'primitive', primitive: 'null' },
                  ],
                },
              },
              {
                name: 'discover',
                description: 'Find Abjects matching a query',
                parameters: [
                  {
                    name: 'query',
                    type: { kind: 'reference', reference: 'DiscoveryQuery' },
                    description: 'The discovery query',
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ObjectRegistration' },
                },
              },
              {
                name: 'subscribe',
                description: 'Subscribe to registry changes',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unsubscribe',
                description: 'Unsubscribe from registry changes',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'list',
                description: 'List all registered Abjects',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ObjectRegistration' },
                },
              },
              {
                name: 'updateManifest',
                description: 'Update an Abject\'s manifest and re-index it',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to update',
                  },
                  {
                    name: 'manifest',
                    type: { kind: 'reference', reference: 'AbjectManifest' },
                    description: 'The new manifest',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'objectRegistered',
                description: 'Emitted when an Abject is registered',
                payload: { kind: 'reference', reference: 'ObjectRegistration' },
              },
              {
                name: 'objectUnregistered',
                description: 'Emitted when an Abject is unregistered',
                payload: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.REGISTRY_READ,
          Capabilities.REGISTRY_WRITE,
        ],
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Registry Usage Guide

### Methods
- \`list()\` — Returns an array of all ObjectRegistration entries. Each has: id, name, manifest, status, registeredAt, owner?, source?.
- \`discover({ name?, interface?, capability?, tags? })\` — Find objects matching a query. Returns ObjectRegistration[]. Use \`{ name: 'Chat' }\` to find by registration name (falls back to manifest name).
- \`lookup({ objectId })\` — Look up a single object by its AbjectId. Returns ObjectRegistration or null.
- \`subscribe()\` — Subscribe to registration events. The caller will receive \`objectRegistered\` events when new objects are registered.
- \`unsubscribe()\` — Unsubscribe from registration events.
- \`register({ objectId, manifest, status?, owner?, source?, name? })\` — Register an object (normally called by Factory). Optional name overrides manifest.name; auto-suffixed on collision.
- \`unregister({ objectId })\` — Remove an object (normally called by Factory).
- \`updateManifest({ objectId, manifest })\` — Update an object's manifest and re-index it.
- \`rename({ objectId, name })\` — Rename an object's registered name. Returns \`{ name }\` with the actual assigned name (may be suffixed on collision).

### Events
- \`objectRegistered\` — Sent to subscribers when a new object is registered. Payload is the ObjectRegistration.
- \`objectUnregistered\` — Sent to subscribers when an object is removed. Payload is the objectId string.

### Interface ID
\`abjects:registry\``;
  }

  private setupHandlers(): void {
    this.on('register', async (msg: AbjectMessage) => {
      const { objectId, manifest, status, owner, source, name, typeId } = msg.payload as {
        objectId: AbjectId;
        manifest: AbjectManifest;
        status?: AbjectStatus;
        owner?: AbjectId;
        source?: string;
        name?: string;
        typeId?: TypeId;
      };
      return this.registerObject(objectId, manifest, status, owner, source, name, typeId);
    });

    this.on('unregister', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.unregisterObject(objectId);
    });

    this.on('lookup', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.lookupObject(objectId);
    });

    this.on('discover', async (msg: AbjectMessage) => {
      const query = msg.payload as DiscoveryQuery;
      const results = await this.handleDiscover(query);
      return this.filterForCaller(results, msg.routing.from);
    });

    this.on('subscribe', async (msg: AbjectMessage) => {
      this.subscribers.add(msg.routing.from);
      return true;
    });

    this.on('unsubscribe', async (msg: AbjectMessage) => {
      this.subscribers.delete(msg.routing.from);
      return true;
    });

    this.on('list', async (msg: AbjectMessage) => {
      return this.filterForCaller(this.listObjects(), msg.routing.from);
    });

    this.on('setExposedObjectIds', async (msg: AbjectMessage) => {
      const { ids } = msg.payload as { ids: AbjectId[] };
      this.setExposedObjectIds(ids);
      return true;
    });

    this.on('getManifest', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      const reg = this.objects.get(objectId);
      return reg?.manifest ?? null;
    });

    this.on('getSource', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.getObjectSource(objectId);
    });

    this.on('updateSource', async (msg: AbjectMessage) => {
      const { objectId, source } = msg.payload as { objectId: AbjectId; source: string };
      const reg = this.objects.get(objectId);
      if (!reg) return false;
      reg.source = source;
      return true;
    });

    this.on('updateManifest', async (msg: AbjectMessage) => {
      const { objectId, manifest } = msg.payload as { objectId: AbjectId; manifest: AbjectManifest };
      const reg = this.objects.get(objectId);
      if (!reg) return false;

      const old = reg.manifest;

      // Remove old indices
      this.byInterface.get(old.interface.id)?.delete(objectId);
      for (const cap of old.providedCapabilities ?? []) {
        this.byCapability.get(cap)?.delete(objectId);
      }
      this.byName.get(reg.name)?.delete(objectId);

      // Update
      reg.manifest = manifest;

      // Re-index
      const newIfaceId = manifest.interface.id;
      if (!this.byInterface.has(newIfaceId)) this.byInterface.set(newIfaceId, new Set());
      this.byInterface.get(newIfaceId)!.add(objectId);
      for (const cap of manifest.providedCapabilities ?? []) {
        if (!this.byCapability.has(cap)) this.byCapability.set(cap, new Set());
        this.byCapability.get(cap)!.add(objectId);
      }
      if (!this.byName.has(reg.name)) this.byName.set(reg.name, new Set());
      this.byName.get(reg.name)!.add(objectId);

      return true;
    });

    this.on('resolveType', async (msg: AbjectMessage) => {
      const { typeId } = msg.payload as { typeId: TypeId };
      return this.byTypeId.get(typeId) ?? null;
    });

    this.on('rename', async (msg: AbjectMessage) => {
      const { objectId, name } = msg.payload as { objectId: AbjectId; name: string };
      const reg = this.objects.get(objectId);
      if (!reg) return false;
      // Remove old name from index
      this.byName.get(reg.name)?.delete(objectId);
      // Assign new unique name
      reg.name = this.makeUniqueName(name);
      if (!this.byName.has(reg.name)) this.byName.set(reg.name, new Set());
      this.byName.get(reg.name)!.add(objectId);
      return { name: reg.name };
    });
  }

  /**
   * Register an object with the registry.
   */
  registerObject(
    objectId: AbjectId,
    manifest: AbjectManifest,
    status?: AbjectStatus,
    owner?: AbjectId,
    source?: string,
    name?: string,
    typeId?: TypeId,
  ): boolean {
    require(objectId !== '', 'objectId must not be empty');
    require(manifest !== undefined, 'manifest is required');

    // Enforce TypeId uniqueness
    if (typeId) {
      const existing = this.byTypeId.get(typeId);
      require(
        !existing || existing === objectId,
        `TypeId '${typeId}' already registered to object ${existing}`,
      );
    }

    // Auto-generate unique name
    const baseName = name ?? manifest.name;
    const uniqueName = this.makeUniqueName(baseName);

    const registration: ObjectRegistration = {
      id: objectId,
      typeId,
      name: uniqueName,
      manifest,
      status: status ?? {
        id: objectId,
        typeId,
        state: 'ready',
        manifest,
        connections: [],
        errorCount: 0,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      },
      registeredAt: Date.now(),
      owner,
      source,
    };

    this.objects.set(objectId, registration);

    // Index by typeId
    if (typeId) {
      this.byTypeId.set(typeId, objectId);
    }

    // Index by interface
    const ifaceId = manifest.interface.id;
    if (!this.byInterface.has(ifaceId)) {
      this.byInterface.set(ifaceId, new Set());
    }
    this.byInterface.get(ifaceId)!.add(objectId);

    // Index by capability
    for (const cap of manifest.providedCapabilities ?? []) {
      if (!this.byCapability.has(cap)) {
        this.byCapability.set(cap, new Set());
      }
      this.byCapability.get(cap)!.add(objectId);
    }

    // Index by registration name
    if (!this.byName.has(uniqueName)) {
      this.byName.set(uniqueName, new Set());
    }
    this.byName.get(uniqueName)!.add(objectId);

    // Notify subscribers
    this.notifySubscribers('objectRegistered', registration);

    this.checkInvariants();
    return true;
  }

  /**
   * Generate a unique name within this registry.
   * If baseName is taken, appends -2, -3, etc.
   */
  private makeUniqueName(baseName: string): string {
    const existing = this.byName.get(baseName);
    if (!existing || existing.size === 0) return baseName;

    let n = 2;
    while (this.byName.has(`${baseName}-${n}`) && this.byName.get(`${baseName}-${n}`)!.size > 0) {
      n++;
    }
    return `${baseName}-${n}`;
  }

  /**
   * Unregister an object from the registry.
   */
  unregisterObject(objectId: AbjectId): boolean {
    const registration = this.objects.get(objectId);
    if (!registration) {
      return false;
    }

    const manifest = registration.manifest;

    // Remove from typeId index
    if (registration.typeId) {
      this.byTypeId.delete(registration.typeId);
    }

    // Remove from interface index
    this.byInterface.get(manifest.interface.id)?.delete(objectId);

    // Remove from capability index
    for (const cap of manifest.providedCapabilities ?? []) {
      this.byCapability.get(cap)?.delete(objectId);
    }

    // Remove from name index
    this.byName.get(registration.name)?.delete(objectId);

    this.objects.delete(objectId);

    // Notify subscribers
    this.notifySubscribers('objectUnregistered', objectId);

    this.checkInvariants();
    return true;
  }

  /**
   * Look up an object by ID.
   */
  lookupObject(objectId: AbjectId): ObjectRegistration | null {
    return this.objects.get(objectId) ?? null;
  }

  /**
   * Resolve a TypeId to the current AbjectId.
   */
  resolveType(typeId: TypeId): AbjectId | null {
    return this.byTypeId.get(typeId) ?? null;
  }

  /**
   * Handle a discover request. Override in subclasses to add fallback behavior.
   */
  protected async handleDiscover(query: DiscoveryQuery): Promise<ObjectRegistration[]> {
    return this.discoverObjects(query);
  }

  /**
   * Discover objects matching a query.
   */
  discoverObjects(query: DiscoveryQuery): ObjectRegistration[] {
    let candidates: Set<AbjectId> | undefined;

    // Filter by interface
    if (query.interface) {
      candidates = this.byInterface.get(query.interface);
      if (!candidates || candidates.size === 0) {
        return [];
      }
    }

    // Filter by capability
    if (query.capability) {
      const capCandidates = this.byCapability.get(query.capability);
      if (!capCandidates || capCandidates.size === 0) {
        return [];
      }
      if (candidates) {
        candidates = new Set([...candidates].filter((id) => capCandidates.has(id)));
      } else {
        candidates = capCandidates;
      }
    }

    // Filter by name — primary: registration.name (byName index), fallback: manifest.name
    if (query.name) {
      let nameCandidates = this.byName.get(query.name);
      if (!nameCandidates || nameCandidates.size === 0) {
        // Fallback: search by manifest.name for system objects
        nameCandidates = new Set<AbjectId>();
        for (const [id, reg] of this.objects) {
          if (reg.manifest.name === query.name) {
            nameCandidates.add(id);
          }
        }
      }
      if (nameCandidates.size === 0) {
        return [];
      }
      if (candidates) {
        candidates = new Set([...candidates].filter((id) => nameCandidates!.has(id)));
      } else {
        candidates = nameCandidates;
      }
    }

    // Get registrations
    const results: ObjectRegistration[] = [];
    const ids = candidates ?? this.objects.keys();

    for (const id of ids) {
      const reg = this.objects.get(id);
      if (!reg) continue;

      // Filter by tags
      if (query.tags && query.tags.length > 0) {
        const objTags = reg.manifest.tags ?? [];
        const hasAllTags = query.tags.every((tag) => objTags.includes(tag));
        if (!hasAllTags) continue;
      }

      results.push(reg);
    }

    return results;
  }

  /**
   * List all registered objects.
   */
  listObjects(): ObjectRegistration[] {
    return Array.from(this.objects.values());
  }

  /**
   * Get the source code for an object, if it's scriptable.
   */
  getObjectSource(objectId: AbjectId): string | null {
    const reg = this.objects.get(objectId);
    return reg?.source ?? null;
  }

  /**
   * Get the count of registered objects.
   */
  get objectCount(): number {
    return this.objects.size;
  }

  /**
   * Notify subscribers of changes.
   */
  private async notifySubscribers(
    eventName: string,
    payload: unknown
  ): Promise<void> {
    for (const subscriberId of this.subscribers) {
      try {
        this.send(
          event(this.id, subscriberId, eventName, payload)
        );
      } catch (err) {
        log.error(`Failed to notify subscriber ${subscriberId}:`, err);
      }
    }
  }

  /**
   * Set the IDs of objects that are exposed to remote (non-local) callers.
   * Empty set means nothing is visible to remote callers.
   */
  setExposedObjectIds(ids: AbjectId[]): void {
    this.exposedObjectIds = new Set(ids);
    this.filteringConfigured = true;
  }

  /**
   * Filter results for a caller: local callers see everything,
   * remote callers only see exposed objects.
   */
  private filterForCaller(results: ObjectRegistration[], callerId: AbjectId): ObjectRegistration[] {
    if (!this.filteringConfigured) return results;  // Global registry: no filtering
    if (this.objects.has(callerId)) return results;  // Registered in this registry — local
    if (this.bus.isRegistered(callerId)) return results;  // Same peer (e.g. system object querying workspace registry) — local
    if (this.exposedObjectIds.size === 0) return [];  // No exposed objects = nothing visible remotely
    return results.filter(r => this.exposedObjectIds.has(r.id));
  }

  /**
   * Check class invariants.
   */
  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.objects.size >= 0, 'object count must be non-negative');
  }
}

// Well-known registry ID
export const REGISTRY_ID = 'abjects:registry' as AbjectId;

/**
 * Create a request message to register an object.
 */
export function createRegisterRequest(
  fromId: AbjectId,
  objectId: AbjectId,
  manifest: AbjectManifest,
  status?: AbjectStatus
): AbjectMessage {
  return request(fromId, REGISTRY_ID, 'register', {
    objectId,
    manifest,
    status,
  });
}

/**
 * Create a request message to discover objects.
 */
export function createDiscoverRequest(
  fromId: AbjectId,
  query: DiscoveryQuery
): AbjectMessage {
  return request(fromId, REGISTRY_ID, 'discover', query);
}

/**
 * Create a request message to look up an object.
 */
export function createLookupRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, REGISTRY_ID, 'lookup', { objectId });
}

/**
 * Create a request message to get a manifest.
 */
export function createGetManifestRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, REGISTRY_ID, 'getManifest', {
    objectId,
  });
}
