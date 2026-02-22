/**
 * Registry object - central directory of all objects in the system.
 */

import {
  AbjectId,
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

const REGISTRY_INTERFACE = 'abjects:registry';

export interface RegistryState {
  objects: Map<AbjectId, ObjectRegistration>;
  byInterface: Map<InterfaceId, Set<AbjectId>>;
  byCapability: Map<CapabilityId, Set<AbjectId>>;
  byName: Map<string, Set<AbjectId>>;
}

/**
 * The Registry object manages object discovery and registration.
 */
export class Registry extends Abject {
  private objects: Map<AbjectId, ObjectRegistration> = new Map();
  private byInterface: Map<InterfaceId, Set<AbjectId>> = new Map();
  private byCapability: Map<CapabilityId, Set<AbjectId>> = new Map();
  private byName: Map<string, Set<AbjectId>> = new Map();
  private subscribers: Set<AbjectId> = new Set();

  constructor() {
    super({
      manifest: {
        name: 'Registry',
        description:
          'Central directory for object discovery. Objects register here to be discoverable by others.',
        version: '1.0.0',
        interfaces: [
          {
            id: REGISTRY_INTERFACE,
            name: 'Registry',
            description: 'Object registration and discovery',
            methods: [
              {
                name: 'register',
                description: 'Register an object with the registry',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to register',
                  },
                  {
                    name: 'manifest',
                    type: { kind: 'reference', reference: 'AbjectManifest' },
                    description: 'The object manifest',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unregister',
                description: 'Remove an object from the registry',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to unregister',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'lookup',
                description: 'Look up an object by ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to look up',
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
                description: 'Find objects matching a query',
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
                description: 'List all registered objects',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ObjectRegistration' },
                },
              },
              {
                name: 'updateManifest',
                description: 'Update an object\'s manifest and re-index it',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to update',
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
                description: 'Emitted when an object is registered',
                payload: { kind: 'reference', reference: 'ObjectRegistration' },
              },
              {
                name: 'objectUnregistered',
                description: 'Emitted when an object is unregistered',
                payload: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        ],
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
- \`list()\` — Returns an array of all ObjectRegistration entries. Each has: id, manifest, status, registeredAt, owner?, source?.
- \`discover({ name?, interface?, capability?, tags? })\` — Find objects matching a query. Returns ObjectRegistration[]. Use \`{ name: 'Chat' }\` to find by manifest name.
- \`lookup({ objectId })\` — Look up a single object by its AbjectId. Returns ObjectRegistration or null.
- \`subscribe()\` — Subscribe to registration events. The caller will receive \`objectRegistered\` events when new objects are registered.
- \`unsubscribe()\` — Unsubscribe from registration events.
- \`register({ objectId, manifest, status?, owner?, source? })\` — Register an object (normally called by Factory).
- \`unregister({ objectId })\` — Remove an object (normally called by Factory).
- \`updateManifest({ objectId, manifest })\` — Update an object's manifest and re-index it.

### Events
- \`objectRegistered\` — Sent to subscribers when a new object is registered. Payload is the ObjectRegistration.
- \`objectUnregistered\` — Sent to subscribers when an object is removed. Payload is the objectId string.

### Interface ID
\`abjects:registry\``;
  }

  private setupHandlers(): void {
    this.on('register', async (msg: AbjectMessage) => {
      const { objectId, manifest, status, owner, source } = msg.payload as {
        objectId: AbjectId;
        manifest: AbjectManifest;
        status?: AbjectStatus;
        owner?: AbjectId;
        source?: string;
      };
      return this.registerObject(objectId, manifest, status, owner, source);
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
      return this.discoverObjects(query);
    });

    this.on('subscribe', async (msg: AbjectMessage) => {
      this.subscribers.add(msg.routing.from);
      return true;
    });

    this.on('unsubscribe', async (msg: AbjectMessage) => {
      this.subscribers.delete(msg.routing.from);
      return true;
    });

    this.on('list', async () => {
      return this.listObjects();
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
      for (const iface of old.interfaces) {
        this.byInterface.get(iface.id)?.delete(objectId);
      }
      for (const cap of old.providedCapabilities ?? []) {
        this.byCapability.get(cap)?.delete(objectId);
      }
      this.byName.get(old.name)?.delete(objectId);

      // Update
      reg.manifest = manifest;

      // Re-index
      for (const iface of manifest.interfaces) {
        if (!this.byInterface.has(iface.id)) this.byInterface.set(iface.id, new Set());
        this.byInterface.get(iface.id)!.add(objectId);
      }
      for (const cap of manifest.providedCapabilities ?? []) {
        if (!this.byCapability.has(cap)) this.byCapability.set(cap, new Set());
        this.byCapability.get(cap)!.add(objectId);
      }
      if (!this.byName.has(manifest.name)) this.byName.set(manifest.name, new Set());
      this.byName.get(manifest.name)!.add(objectId);

      return true;
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
    source?: string
  ): boolean {
    require(objectId !== '', 'objectId must not be empty');
    require(manifest !== undefined, 'manifest is required');

    const registration: ObjectRegistration = {
      id: objectId,
      manifest,
      status: status ?? {
        id: objectId,
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

    // Index by interface
    for (const iface of manifest.interfaces) {
      if (!this.byInterface.has(iface.id)) {
        this.byInterface.set(iface.id, new Set());
      }
      this.byInterface.get(iface.id)!.add(objectId);
    }

    // Index by capability
    for (const cap of manifest.providedCapabilities ?? []) {
      if (!this.byCapability.has(cap)) {
        this.byCapability.set(cap, new Set());
      }
      this.byCapability.get(cap)!.add(objectId);
    }

    // Index by name
    if (!this.byName.has(manifest.name)) {
      this.byName.set(manifest.name, new Set());
    }
    this.byName.get(manifest.name)!.add(objectId);

    // Notify subscribers
    this.notifySubscribers('objectRegistered', registration);

    this.checkInvariants();
    return true;
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

    // Remove from interface index
    for (const iface of manifest.interfaces) {
      this.byInterface.get(iface.id)?.delete(objectId);
    }

    // Remove from capability index
    for (const cap of manifest.providedCapabilities ?? []) {
      this.byCapability.get(cap)?.delete(objectId);
    }

    // Remove from name index
    this.byName.get(manifest.name)?.delete(objectId);

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

    // Filter by name
    if (query.name) {
      const nameCandidates = this.byName.get(query.name);
      if (!nameCandidates || nameCandidates.size === 0) {
        return [];
      }
      if (candidates) {
        candidates = new Set([...candidates].filter((id) => nameCandidates.has(id)));
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
        await this.send(
          event(this.id, subscriberId, REGISTRY_INTERFACE, eventName, payload)
        );
      } catch (err) {
        console.error(`Failed to notify subscriber ${subscriberId}:`, err);
      }
    }
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
  return request(fromId, REGISTRY_ID, REGISTRY_INTERFACE, 'register', {
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
  return request(fromId, REGISTRY_ID, REGISTRY_INTERFACE, 'discover', query);
}

/**
 * Create a request message to look up an object.
 */
export function createLookupRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, REGISTRY_ID, REGISTRY_INTERFACE, 'lookup', { objectId });
}

/**
 * Create a request message to get a manifest.
 */
export function createGetManifestRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, REGISTRY_ID, REGISTRY_INTERFACE, 'getManifest', {
    objectId,
  });
}
