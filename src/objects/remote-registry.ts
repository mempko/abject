/**
 * RemoteRegistry — distributed object discovery across connected peers.
 *
 * When a local object needs a service that isn't available locally,
 * RemoteRegistry queries connected peers' registries and caches results.
 * Discovered remote objects are registered in the NetworkBridge routing table.
 */

import { AbjectId, AbjectMessage, InterfaceId, AbjectManifest } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest, event as createEvent } from '../core/message.js';
import type { PeerId } from '../core/identity.js';
import type { NetworkBridge } from '../network/network-bridge.js';

const REMOTE_REGISTRY_INTERFACE = 'abjects:remote-registry' as InterfaceId;
const REGISTRY_INTERFACE = 'abjects:registry' as InterfaceId;
const PEER_REGISTRY_INTERFACE = 'abjects:peer-registry' as InterfaceId;

export const REMOTE_REGISTRY_ID = 'abjects:remote-registry' as AbjectId;

interface RemoteObjectEntry {
  objectId: AbjectId;
  peerId: PeerId;
  manifest: AbjectManifest;
  discoveredAt: number;
  ttl: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class RemoteRegistry extends Abject {
  private remoteObjects: Map<AbjectId, RemoteObjectEntry> = new Map();
  private peerRegistryId?: AbjectId;
  private networkBridge?: NetworkBridge;

  constructor() {
    super({
      manifest: {
        name: 'RemoteRegistry',
        description:
          'Distributed object discovery across connected peers. Queries remote registries, caches results, and registers routes in the NetworkBridge.',
        version: '1.0.0',
        interfaces: [
          {
            id: REMOTE_REGISTRY_INTERFACE as string,
            name: 'RemoteRegistry',
            description: 'Remote object discovery and lookup',
            methods: [
              {
                name: 'discoverRemote',
                description: 'Query connected peers for objects matching a name or interface',
                parameters: [
                  { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Object name to search for', optional: true },
                  { name: 'interfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Interface ID to search for', optional: true },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'RemoteObjectInfo' } },
              },
              {
                name: 'lookupRemote',
                description: 'Look up a specific remote object by ID',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object ID to look up' },
                ],
                returns: { kind: 'reference', reference: 'RemoteObjectInfo' },
              },
              {
                name: 'registerRemoteObject',
                description: 'Manually register a remote object and its route',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Remote object ID' },
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer that hosts it' },
                  { name: 'manifest', type: { kind: 'reference', reference: 'AbjectManifest' }, description: 'Object manifest' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'syncWithPeer',
                description: 'Sync the registry with a specific peer — discover all their objects',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer to sync with' },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'RemoteObjectInfo' } },
              },
              {
                name: 'listRemoteObjects',
                description: 'List all known remote objects',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'RemoteObjectInfo' } },
              },
            ],
            events: [
              {
                name: 'remoteObjectDiscovered',
                description: 'A new remote object was discovered',
                payload: { kind: 'reference', reference: 'RemoteObjectInfo' },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'peer'],
      },
    });
    this.setupHandlers();
  }

  /**
   * Set the NetworkBridge for route registration.
   * Called during bootstrap after both objects are created.
   */
  setNetworkBridge(bridge: NetworkBridge): void {
    this.networkBridge = bridge;
  }

  private setupHandlers(): void {
    this.on('discoverRemote', async (msg: AbjectMessage) => {
      const { name, interfaceId } = msg.payload as { name?: string; interfaceId?: string };
      return this.discoverRemoteImpl(name, interfaceId);
    });

    this.on('lookupRemote', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.lookupRemoteImpl(objectId);
    });

    this.on('registerRemoteObject', async (msg: AbjectMessage) => {
      const { objectId, peerId, manifest } = msg.payload as {
        objectId: string; peerId: string; manifest: AbjectManifest;
      };
      return this.registerRemoteObjectImpl(objectId, peerId, manifest);
    });

    this.on('syncWithPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.syncWithPeerImpl(peerId);
    });

    this.on('listRemoteObjects', async () => {
      return this.listRemoteObjectsImpl();
    });
  }

  protected override async onInit(): Promise<void> {
    this.peerRegistryId = (await this.discoverDep('PeerRegistry')) ?? undefined;
  }

  // ==========================================================================
  // Discovery
  // ==========================================================================

  private async discoverRemoteImpl(
    name?: string,
    interfaceId?: string,
  ): Promise<Array<{ objectId: string; peerId: string; manifest: AbjectManifest }>> {
    // First check cache
    const cached = this.searchCache(name, interfaceId);
    if (cached.length > 0) return cached;

    // Query all connected peers
    if (!this.peerRegistryId) return [];

    const results: Array<{ objectId: string; peerId: string; manifest: AbjectManifest }> = [];

    try {
      const contacts = await this.request<Array<{ peerId: string; state: string }>>(
        createRequest(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'listContacts', {}),
      );

      for (const contact of contacts) {
        if (contact.state !== 'connected') continue;

        try {
          const peerResults = await this.queryPeerRegistry(contact.peerId, name, interfaceId);
          results.push(...peerResults);
        } catch {
          // Peer's registry query failed — skip
        }
      }
    } catch {
      // PeerRegistry not available
    }

    return results;
  }

  /**
   * Query a remote peer's registry for objects matching the given criteria.
   * This sends a message to the remote peer's Registry object via NetworkBridge.
   */
  private async queryPeerRegistry(
    peerId: string,
    name?: string,
    interfaceId?: string,
  ): Promise<Array<{ objectId: string; peerId: string; manifest: AbjectManifest }>> {
    // For now, this requires that we've already synced with the peer
    // Full implementation would send a discovery request to the peer's registry
    // via the NetworkBridge and wait for the response
    return this.searchCacheForPeer(peerId, name, interfaceId);
  }

  private lookupRemoteImpl(objectId: string): { objectId: string; peerId: string; manifest: AbjectManifest } | null {
    const entry = this.remoteObjects.get(objectId as AbjectId);
    if (!entry) return null;
    if (Date.now() > entry.discoveredAt + entry.ttl) {
      this.remoteObjects.delete(objectId as AbjectId);
      return null;
    }
    return { objectId: entry.objectId, peerId: entry.peerId, manifest: entry.manifest };
  }

  private registerRemoteObjectImpl(
    objectId: string,
    peerId: string,
    manifest: AbjectManifest,
  ): boolean {
    this.remoteObjects.set(objectId as AbjectId, {
      objectId: objectId as AbjectId,
      peerId,
      manifest,
      discoveredAt: Date.now(),
      ttl: CACHE_TTL,
    });

    // Register route in NetworkBridge
    if (this.networkBridge) {
      this.networkBridge.registerRoute(objectId as AbjectId, peerId);
    }

    return true;
  }

  private async syncWithPeerImpl(
    peerId: string,
  ): Promise<Array<{ objectId: string; peerId: string; manifest: AbjectManifest }>> {
    // This would send a 'list' request to the peer's Registry
    // For now, return cached objects for this peer
    return this.searchCacheForPeer(peerId);
  }

  private listRemoteObjectsImpl(): Array<{ objectId: string; peerId: string; name: string; state: string }> {
    const now = Date.now();
    const results: Array<{ objectId: string; peerId: string; name: string; state: string }> = [];

    for (const [, entry] of this.remoteObjects) {
      const expired = now > entry.discoveredAt + entry.ttl;
      results.push({
        objectId: entry.objectId,
        peerId: entry.peerId,
        name: entry.manifest.name,
        state: expired ? 'expired' : 'active',
      });
    }

    return results;
  }

  // ==========================================================================
  // Cache
  // ==========================================================================

  private searchCache(
    name?: string,
    interfaceId?: string,
  ): Array<{ objectId: string; peerId: string; manifest: AbjectManifest }> {
    const now = Date.now();
    const results: Array<{ objectId: string; peerId: string; manifest: AbjectManifest }> = [];

    for (const [, entry] of this.remoteObjects) {
      if (now > entry.discoveredAt + entry.ttl) continue;

      if (name && entry.manifest.name !== name) continue;
      if (interfaceId && !entry.manifest.interfaces.some(i => i.id === interfaceId)) continue;

      results.push({ objectId: entry.objectId, peerId: entry.peerId, manifest: entry.manifest });
    }

    return results;
  }

  private searchCacheForPeer(
    peerId: string,
    name?: string,
    interfaceId?: string,
  ): Array<{ objectId: string; peerId: string; manifest: AbjectManifest }> {
    const now = Date.now();
    const results: Array<{ objectId: string; peerId: string; manifest: AbjectManifest }> = [];

    for (const [, entry] of this.remoteObjects) {
      if (entry.peerId !== peerId) continue;
      if (now > entry.discoveredAt + entry.ttl) continue;
      if (name && entry.manifest.name !== name) continue;
      if (interfaceId && !entry.manifest.interfaces.some(i => i.id === interfaceId)) continue;

      results.push({ objectId: entry.objectId, peerId: entry.peerId, manifest: entry.manifest });
    }

    return results;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}
