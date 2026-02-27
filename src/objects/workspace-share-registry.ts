/**
 * WorkspaceShareRegistry — manages workspace sharing metadata and peer discovery.
 *
 * Tracks which local workspaces are shared, caches discovered remote workspaces,
 * and handles incoming/outgoing workspace discovery queries between peers.
 * Supports transitive multi-hop discovery (A→B→C).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { invariant } from '../core/contracts.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import type { SharedWorkspaceInfo } from './workspace-manager.js';

const WORKSPACE_SHARE_REGISTRY_INTERFACE: InterfaceId = 'abjects:workspace-share-registry';
const WORKSPACE_MANAGER_INTERFACE: InterfaceId = 'abjects:workspace-manager';
const PEER_REGISTRY_INTERFACE: InterfaceId = 'abjects:peer-registry';
const IDENTITY_INTERFACE: InterfaceId = 'abjects:identity';
const PEER_ROUTER_INTERFACE: InterfaceId = 'abjects:peer-router';

export interface DiscoveredWorkspace {
  workspaceId: string;
  name: string;
  ownerPeerId: string;
  ownerName: string;
  accessMode: string;
  registryId: string;
  discoveredAt: number;
  hops: number;
}

const MAX_HOPS = 3;

export class WorkspaceShareRegistry extends Abject {
  private workspaceManagerId?: AbjectId;
  private peerRegistryId?: AbjectId;
  private identityId?: AbjectId;
  private peerRouterId?: AbjectId;

  /** Local shared workspaces (kept in sync with WorkspaceManager). */
  private localShared: Map<string, SharedWorkspaceInfo> = new Map();

  /** Remote workspaces discovered from peers. Keyed by `${ownerPeerId}:${workspaceId}`. */
  private discoveredWorkspaces: Map<string, DiscoveredWorkspace> = new Map();

  /** Our own peer identity info. */
  private localPeerId?: string;
  private localPeerName?: string;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceShareRegistry',
        description:
          'Manages workspace sharing metadata and handles peer discovery queries for shared workspaces.',
        version: '1.0.0',
        interfaces: [
          {
            id: WORKSPACE_SHARE_REGISTRY_INTERFACE,
            name: 'WorkspaceShareRegistry',
            description: 'Workspace sharing and discovery',
            methods: [
              {
                name: 'getSharedWorkspaces',
                description: 'Get locally shared workspaces',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SharedWorkspaceInfo' } },
              },
              {
                name: 'queryPeerWorkspaces',
                description: 'Query a specific peer for their shared workspaces',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to query' },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'DiscoveredWorkspace' } },
              },
              {
                name: 'discoverWorkspaces',
                description: 'Query all connected peers for shared workspaces',
                parameters: [
                  { name: 'hops', type: { kind: 'primitive', primitive: 'number' }, description: 'Max hops for transitive discovery', optional: true },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'DiscoveredWorkspace' } },
              },
              {
                name: 'getDiscoveredWorkspaces',
                description: 'Return cached discovered workspaces',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'DiscoveredWorkspace' } },
              },
              {
                name: 'handleWorkspaceQuery',
                description: 'Handle an incoming workspace query from a remote peer',
                parameters: [
                  { name: 'fromPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Requesting peer ID' },
                  { name: 'hops', type: { kind: 'primitive', primitive: 'number' }, description: 'Remaining hops', optional: true },
                  { name: 'visited', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Already visited peer IDs', optional: true },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'DiscoveredWorkspace' } },
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

  private setupHandlers(): void {
    this.on('getSharedWorkspaces', async () => {
      return this.getSharedWorkspaces();
    });

    this.on('queryPeerWorkspaces', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.queryPeerWorkspaces(peerId);
    });

    this.on('discoverWorkspaces', async (msg: AbjectMessage) => {
      const { hops } = msg.payload as { hops?: number };
      return this.discoverWorkspaces(hops);
    });

    this.on('getDiscoveredWorkspaces', async () => {
      return this.getDiscoveredWorkspaces();
    });

    this.on('handleWorkspaceQuery', async (msg: AbjectMessage) => {
      const { fromPeerId, hops, visited } = msg.payload as {
        fromPeerId: string;
        hops?: number;
        visited?: string[];
      };
      return this.handleWorkspaceQuery(fromPeerId, hops, visited);
    });

    // Listen for events from PeerRegistry and WorkspaceManager
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };

      // PeerRouter: routesUpdated — new routes received from a peer, query their workspaces
      if (aspect === 'routesUpdated') {
        const { fromPeerId } = value as { fromPeerId: string };
        this.queryPeerWorkspaces(fromPeerId).catch(() => { /* best-effort */ });
        return;
      }

      // PeerRegistry: contactConnected — auto-query new peer
      if (aspect === 'contactConnected') {
        const { peerId } = value as { peerId: string };
        // Query the new peer asynchronously (don't block the event)
        this.queryPeerWorkspaces(peerId).catch(() => { /* best-effort */ });
        return;
      }

      // PeerRegistry: contactDisconnected — remove discoveries from that peer
      if (aspect === 'contactDisconnected') {
        const { peerId } = value as { peerId: string };
        for (const [key, dw] of this.discoveredWorkspaces) {
          if (dw.ownerPeerId === peerId) {
            this.discoveredWorkspaces.delete(key);
          }
        }
        return;
      }

      // WorkspaceManager: workspaceShared — update local cache
      if (aspect === 'workspaceShared') {
        const info = value as SharedWorkspaceInfo;
        console.log(`[WSR] workspaceShared event:`, info.name, info.accessMode);
        this.localShared.set(info.workspaceId, info);
        return;
      }

      // WorkspaceManager: workspaceUnshared — remove from local cache
      if (aspect === 'workspaceUnshared') {
        const { workspaceId } = value as { workspaceId: string };
        this.localShared.delete(workspaceId);
        return;
      }
    });
  }

  protected override async onInit(): Promise<void> {
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    this.identityId = await this.discoverDep('Identity') ?? undefined;
    this.peerRouterId = await this.discoverDep('PeerRouter') ?? undefined;

    // Load local identity
    if (this.identityId) {
      try {
        const identity = await this.request<{ peerId: string; name: string }>(
          request(this.id, this.identityId, IDENTITY_INTERFACE, 'exportPublicKeys', {})
        );
        this.localPeerId = identity.peerId;
        this.localPeerName = identity.name;
      } catch { /* identity not ready */ }
      console.log('[WSR] identity:', this.localPeerId?.slice(0, 16), this.localPeerName);
    }

    // Register as dependent of PeerRegistry for connection events
    if (this.peerRegistryId) {
      try {
        await this.request(
          request(this.id, this.peerRegistryId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
        );
      } catch { /* PeerRegistry may not be ready */ }
    }

    // Register as dependent of PeerRouter for route update events
    if (this.peerRouterId) {
      try {
        await this.request(
          request(this.id, this.peerRouterId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
        );
      } catch { /* PeerRouter may not be ready */ }
    }

    // Register as dependent of WorkspaceManager for sharing events
    if (this.workspaceManagerId) {
      try {
        await this.request(
          request(this.id, this.workspaceManagerId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
        );
      } catch { /* WorkspaceManager may not be ready */ }

      // Load initial shared workspaces
      try {
        const shared = await this.request<SharedWorkspaceInfo[]>(
          request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'listSharedWorkspaces', {})
        );
        for (const ws of shared) {
          this.localShared.set(ws.workspaceId, ws);
        }
        console.log('[WSR] init loaded', this.localShared.size, 'shared workspaces');
      } catch { /* WorkspaceManager may not be ready */ }
    }
  }

  // ── Public Methods ──

  getSharedWorkspaces(): SharedWorkspaceInfo[] {
    return Array.from(this.localShared.values());
  }

  async queryPeerWorkspaces(peerId: string): Promise<DiscoveredWorkspace[]> {
    console.log(`[WSR] queryPeerWorkspaces peerId=${peerId.slice(0, 16)}`);
    if (!this.peerRegistryId || !this.localPeerId) return [];

    // Resolve remote WSR UUID via PeerRouter
    const remoteWsrId = await this.resolveRemoteWsr(peerId);
    if (!remoteWsrId) {
      console.log(`[WSR] No WSR route for peer ${peerId.slice(0, 16)}`);
      return [];
    }

    try {
      const results = await this.request<DiscoveredWorkspace[]>(
        request(
          this.id,
          remoteWsrId,
          WORKSPACE_SHARE_REGISTRY_INTERFACE,
          'handleWorkspaceQuery',
          { fromPeerId: this.localPeerId, hops: 0, visited: [this.localPeerId] },
        )
      );

      console.log('[WSR] queryPeer got', results.length, 'workspaces');

      // Cache results
      let newDiscoveries = false;
      for (const dw of results) {
        const key = `${dw.ownerPeerId}:${dw.workspaceId}`;
        if (!this.discoveredWorkspaces.has(key)) newDiscoveries = true;
        this.discoveredWorkspaces.set(key, dw);
      }

      // Notify dependents (e.g. WorkspaceBrowser) if new workspaces found
      if (newDiscoveries) {
        this.changed('workspacesDiscovered', { count: results.length, peerId });
      }

      return results;
    } catch (err) {
      console.log('[WSR] queryPeer FAILED for', peerId.slice(0, 16), err);
      return [];
    }
  }

  async discoverWorkspaces(hops?: number): Promise<DiscoveredWorkspace[]> {
    const effectiveHops = Math.min(hops ?? 1, MAX_HOPS);
    console.log(`[WSR] discoverWorkspaces hops=${effectiveHops} localPeerId=${this.localPeerId?.slice(0, 16)}`);

    if (!this.peerRegistryId || !this.localPeerId) return [];

    // Get list of connected peers
    let contacts: Array<{ peerId: string; state: string }> = [];
    try {
      contacts = await this.request<Array<{ peerId: string; state: string }>>(
        request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'listContacts', {})
      );
    } catch { return []; }

    const connectedPeers = contacts.filter(c => c.state === 'connected');
    console.log(`[WSR] connected peers:`, connectedPeers.map(c => c.peerId.slice(0, 16)));
    const allResults: DiscoveredWorkspace[] = [];
    const visited = [this.localPeerId];

    for (const peer of connectedPeers) {
      // Resolve remote WSR UUID via PeerRouter
      const remoteWsrId = await this.resolveRemoteWsr(peer.peerId);
      if (!remoteWsrId) {
        console.log(`[WSR] No WSR route for peer ${peer.peerId.slice(0, 16)}, skipping`);
        continue;
      }

      try {
        const results = await this.request<DiscoveredWorkspace[]>(
          request(
            this.id,
            remoteWsrId,
            WORKSPACE_SHARE_REGISTRY_INTERFACE,
            'handleWorkspaceQuery',
            { fromPeerId: this.localPeerId, hops: effectiveHops, visited },
          )
        );

        for (const dw of results) {
          const key = `${dw.ownerPeerId}:${dw.workspaceId}`;
          // Deduplicate: keep the one with fewer hops
          const existing = this.discoveredWorkspaces.get(key);
          if (!existing || dw.hops < existing.hops) {
            this.discoveredWorkspaces.set(key, dw);
          }
        }
        console.log('[WSR] peer query result:', results.length, 'workspaces');
        allResults.push(...results);
      } catch (err) {
        console.log('[WSR] peer query failed for', peer.peerId.slice(0, 16), err);
      }
    }

    return this.getDiscoveredWorkspaces();
  }

  getDiscoveredWorkspaces(): DiscoveredWorkspace[] {
    return Array.from(this.discoveredWorkspaces.values());
  }

  /**
   * Handle an incoming workspace query from a remote peer.
   * Returns applicable local workspaces + optionally forwards to other peers.
   */
  async handleWorkspaceQuery(
    fromPeerId: string,
    hops?: number,
    visited?: string[],
  ): Promise<DiscoveredWorkspace[]> {
    const effectiveHops = hops ?? 0;
    const visitedSet = new Set(visited ?? []);
    console.log(`[WSR] handleWorkspaceQuery from=${fromPeerId.slice(0, 16)} hops=${effectiveHops} localShared=${this.localShared.size}`);
    console.log(`[WSR] localShared entries:`, [...this.localShared.values()].map(w => ({ name: w.name, mode: w.accessMode })));

    // Add self to visited (loop prevention)
    if (this.localPeerId) {
      if (visitedSet.has(this.localPeerId)) return []; // already visited
      visitedSet.add(this.localPeerId);
    }

    // Filter local shared workspaces for the requesting peer
    const directResults = this.filterWorkspacesForPeer(fromPeerId);
    console.log('[WSR] filtered results:', directResults.length);
    const results: DiscoveredWorkspace[] = directResults.map(ws => ({
      workspaceId: ws.workspaceId,
      name: ws.name,
      ownerPeerId: this.localPeerId ?? '',
      ownerName: this.localPeerName ?? '',
      accessMode: ws.accessMode,
      registryId: ws.registryId ?? '',
      discoveredAt: Date.now(),
      hops: 0,
    }));

    // If hops > 0, forward query to connected peers (transitive discovery)
    if (effectiveHops > 0 && this.peerRegistryId && this.localPeerId) {
      let contacts: Array<{ peerId: string; state: string }> = [];
      try {
        contacts = await this.request<Array<{ peerId: string; state: string }>>(
          request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'listContacts', {})
        );
      } catch { /* no contacts available */ }

      const connectedPeers = contacts.filter(
        c => c.state === 'connected' && !visitedSet.has(c.peerId)
      );
      const newVisited = Array.from(visitedSet);

      for (const peer of connectedPeers) {
        // Resolve remote WSR UUID via PeerRouter
        const remoteWsrId = await this.resolveRemoteWsr(peer.peerId);
        if (!remoteWsrId) continue;

        try {
          const forwarded = await this.request<DiscoveredWorkspace[]>(
            request(
              this.id,
              remoteWsrId,
              WORKSPACE_SHARE_REGISTRY_INTERFACE,
              'handleWorkspaceQuery',
              { fromPeerId, hops: effectiveHops - 1, visited: newVisited },
            )
          );

          // Increment hops for forwarded results and deduplicate
          for (const dw of forwarded) {
            const adjusted: DiscoveredWorkspace = { ...dw, hops: dw.hops + 1 };
            const existing = results.find(r =>
              r.ownerPeerId === dw.ownerPeerId && r.workspaceId === dw.workspaceId
            );
            if (!existing) {
              results.push(adjusted);
            }
          }
        } catch {
          // Peer unreachable or doesn't support sharing
        }
      }
    }

    console.log('[WSR] handleWorkspaceQuery returning', results.length, 'total');
    return results;
  }

  /**
   * Resolve a remote peer's WSR UUID via PeerRouter's well-known mapping.
   */
  private async resolveRemoteWsr(peerId: string): Promise<AbjectId | null> {
    if (!this.peerRouterId) return null;
    try {
      const remoteId = await this.request<string | null>(
        request(this.id, this.peerRouterId, PEER_ROUTER_INTERFACE,
          'resolveRemoteObject', {
            peerId,
            wellKnownId: 'abjects:workspace-share-registry',
          })
      );
      return remoteId ? remoteId as AbjectId : null;
    } catch {
      return null;
    }
  }

  /**
   * Filter local shared workspaces based on access mode and whitelist.
   */
  private filterWorkspacesForPeer(peerId: string): SharedWorkspaceInfo[] {
    const results: SharedWorkspaceInfo[] = [];
    for (const ws of this.localShared.values()) {
      if (ws.accessMode === 'public') {
        results.push(ws);
      } else if (ws.accessMode === 'private' && ws.whitelist?.includes(peerId)) {
        results.push(ws);
      }
      // 'local' workspaces are never shared
    }
    return results;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}

export const WORKSPACE_SHARE_REGISTRY_ID = 'abjects:workspace-share-registry' as AbjectId;
