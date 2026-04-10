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
import { Log } from '../core/timed-log.js';
import type { SharedWorkspaceInfo } from './workspace-manager.js';

const log = new Log('WSR');

const WORKSPACE_SHARE_REGISTRY_INTERFACE: InterfaceId = 'abjects:workspace-share-registry';
const WORKSPACE_MANAGER_INTERFACE: InterfaceId = 'abjects:workspace-manager';
const PEER_REGISTRY_INTERFACE: InterfaceId = 'abjects:peer-registry';
const IDENTITY_INTERFACE: InterfaceId = 'abjects:identity';
const PEER_ROUTER_INTERFACE: InterfaceId = 'abjects:peer-router';

export interface DiscoveredWorkspace {
  workspaceId: string;
  name: string;
  description?: string;
  tags?: string[];
  ownerPeerId: string;
  ownerName: string;
  accessMode: string;
  registryId: string;
  discoveredAt: number;
  hops: number;
}

const MAX_HOPS = 3;
const STORAGE_KEY_DISCOVERED = 'wsr:discovered';
const DISCOVERY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const QUERY_DEBOUNCE_MS = 3000;

export class WorkspaceShareRegistry extends Abject {
  private workspaceManagerId?: AbjectId;
  private peerRegistryId?: AbjectId;
  private identityId?: AbjectId;
  private peerRouterId?: AbjectId;
  private storageId?: AbjectId;

  /** Local shared workspaces (kept in sync with WorkspaceManager). */
  private localShared: Map<string, SharedWorkspaceInfo> = new Map();

  /** Remote workspaces discovered from peers. Keyed by `${ownerPeerId}:${workspaceId}`. */
  private discoveredWorkspaces: Map<string, DiscoveredWorkspace> = new Map();

  /** Our own peer identity info. */
  private localPeerId?: string;
  private localPeerName?: string;

  /** Debounce: last query time per peer. */
  private lastQueryTime: Map<string, number> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceShareRegistry',
        description:
          'Manages workspace sharing metadata and handles peer discovery queries for shared workspaces.',
        version: '1.0.0',
        interface: {
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

    this.on('addWorkspaceFromRoute', async (msg: AbjectMessage) => {
      const route = msg.payload as {
        ownerPeerId: string; workspaceId: string;
        accessMode: string; registryId: string;
        hops: number; exposedNames?: string[];
      };
      this.addWorkspaceFromRoute(route);
      return true;
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

      // PeerRouter: routesUpdated — new routes received from a peer
      // Phase 6a: Extract workspace metadata from route announcements
      if (aspect === 'routesUpdated') {
        const { fromPeerId } = value as { fromPeerId: string };
        // Synchronously update cached registryIds from PeerRouter's route data.
        // This handles the case where a peer restarted and got new UUIDs —
        // the route announcement arrives with the fresh registryId before any
        // WSR query completes.
        this.syncRegistryIdsFromRoutes(fromPeerId).catch(() => {});
        // Also query peer workspaces for full metadata (names, descriptions)
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
        log.info(`workspaceShared event: ${info.name} ${info.accessMode}`);
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
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    // Load local identity
    if (this.identityId) {
      try {
        const identity = await this.request<{ peerId: string; name: string }>(
          request(this.id, this.identityId, 'exportPublicKeys', {})
        );
        this.localPeerId = identity.peerId;
        this.localPeerName = identity.name;
      } catch { /* identity not ready */ }
      log.info(`identity: ${this.localPeerId?.slice(0, 16)} ${this.localPeerName}`);
    }

    // Register as dependent of PeerRegistry for connection events
    if (this.peerRegistryId) {
      try {
        await this.request(
          request(this.id, this.peerRegistryId, 'addDependent', {})
        );
      } catch { /* PeerRegistry may not be ready */ }
    }

    // Register as dependent of PeerRouter for route update events
    if (this.peerRouterId) {
      try {
        await this.request(
          request(this.id, this.peerRouterId, 'addDependent', {})
        );
      } catch { /* PeerRouter may not be ready */ }
    }

    // Register as dependent of WorkspaceManager for sharing events
    if (this.workspaceManagerId) {
      try {
        await this.request(
          request(this.id, this.workspaceManagerId, 'addDependent', {})
        );
      } catch { /* WorkspaceManager may not be ready */ }

      // Load initial shared workspaces
      try {
        const shared = await this.request<SharedWorkspaceInfo[]>(
          request(this.id, this.workspaceManagerId, 'listSharedWorkspaces', {})
        );
        for (const ws of shared) {
          this.localShared.set(ws.workspaceId, ws);
        }
        log.info(`init loaded ${this.localShared.size} shared workspaces`);
      } catch { /* WorkspaceManager may not be ready */ }
    }

    // Load cached discoveries from Storage
    await this.loadDiscoveryCache();
  }

  // ── Public Methods ──

  getSharedWorkspaces(): SharedWorkspaceInfo[] {
    return Array.from(this.localShared.values());
  }

  async queryPeerWorkspaces(peerId: string): Promise<DiscoveredWorkspace[]> {
    log.info(`queryPeerWorkspaces peerId=${peerId.slice(0, 16)}`);
    if (!this.peerRegistryId || !this.localPeerId) return [];

    // Debounce: return cached results if queried within QUERY_DEBOUNCE_MS
    const now = Date.now();
    const lastQuery = this.lastQueryTime.get(peerId);
    if (lastQuery && now - lastQuery < QUERY_DEBOUNCE_MS) {
      log.info(`debounce: peer ${peerId.slice(0, 16)} queried ${now - lastQuery}ms ago, returning cached`);
      return this.getDiscoveredWorkspacesForPeer(peerId);
    }
    this.lastQueryTime.set(peerId, now);

    // Resolve remote WSR UUID via PeerRouter
    const remoteWsrId = await this.resolveRemoteWsr(peerId);
    if (!remoteWsrId) {
      log.info(`No WSR route for peer ${peerId.slice(0, 16)}`);
      return [];
    }

    try {
      const results = await this.request<DiscoveredWorkspace[]>(
        request(
          this.id,
          remoteWsrId,
          'handleWorkspaceQuery',
          { fromPeerId: this.localPeerId, hops: 0, visited: [this.localPeerId] },
        )
      );

      log.info(`queryPeer got ${results.length} workspaces`);

      // Cache results
      let newDiscoveries = false;
      for (const dw of results) {
        const key = `${dw.ownerPeerId}:${dw.workspaceId}`;
        if (!this.discoveredWorkspaces.has(key)) newDiscoveries = true;
        this.discoveredWorkspaces.set(key, dw);
      }

      // Remove stale entries for this peer if they weren't in fresh results
      const returnedKeys = new Set(results.map(dw => `${dw.ownerPeerId}:${dw.workspaceId}`));
      for (const [key, dw] of this.discoveredWorkspaces) {
        if (dw.ownerPeerId === peerId && !returnedKeys.has(key)) {
          log.info(`removing stale cache entry ${key} (peer ${peerId.slice(0, 16)} no longer shares)`);
          this.discoveredWorkspaces.delete(key);
          newDiscoveries = true; // trigger persist + notify
        }
      }

      // Notify dependents (e.g. WorkspaceBrowser) if new workspaces found
      if (newDiscoveries) {
        this.changed('workspacesDiscovered', { count: results.length, peerId });
        this.persistDiscoveryCache().catch(() => { /* best-effort */ });
      }

      return results;
    } catch (err) {
      log.info(`queryPeer FAILED for ${peerId.slice(0, 16)}`, err);
      return [];
    }
  }

  async discoverWorkspaces(hops?: number): Promise<DiscoveredWorkspace[]> {
    const effectiveHops = Math.min(hops ?? 1, MAX_HOPS);
    log.info(`discoverWorkspaces hops=${effectiveHops} localPeerId=${this.localPeerId?.slice(0, 16)}`);

    if (!this.peerRegistryId || !this.localPeerId) return [];

    // Get list of connected peers (active transports, not just manually-added contacts)
    let connectedPeerIds: string[] = [];
    try {
      connectedPeerIds = await this.request<string[]>(
        request(this.id, this.peerRegistryId, 'getConnectedPeers', {})
      );
    } catch { return []; }

    log.info(`connected peers: ${connectedPeerIds.map(p => p.slice(0, 16)).join(', ')}`);

    // Phase 6a: Return cached results if they're fresh (populated by route announcements)
    const cachedResults = this.getDiscoveredWorkspaces();
    const freshCached = cachedResults.filter(dw => Date.now() - dw.discoveredAt < DISCOVERY_CACHE_TTL);
    if (freshCached.length > 0 && effectiveHops <= 1) {
      log.info(`returning ${freshCached.length} cached results from route announcements`);
      return freshCached;
    }

    const allResults: DiscoveredWorkspace[] = [];
    const visited = [this.localPeerId];

    for (const peer of connectedPeerIds) {
      // Resolve remote WSR UUID via PeerRouter
      const remoteWsrId = await this.resolveRemoteWsr(peer);
      if (!remoteWsrId) {
        log.info(`No WSR route for peer ${peer.slice(0, 16)}, skipping`);
        continue;
      }

      try {
        const results = await this.request<DiscoveredWorkspace[]>(
          request(
            this.id,
            remoteWsrId,
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
        log.info(`peer query result: ${results.length} workspaces`);
        allResults.push(...results);
      } catch (err) {
        log.info(`peer query failed for ${peer.slice(0, 16)}`, err);
      }
    }

    this.persistDiscoveryCache().catch(() => { /* best-effort */ });
    return this.getDiscoveredWorkspaces();
  }

  getDiscoveredWorkspaces(): DiscoveredWorkspace[] {
    return Array.from(this.discoveredWorkspaces.values());
  }

  getDiscoveredWorkspacesForPeer(peerId: string): DiscoveredWorkspace[] {
    return Array.from(this.discoveredWorkspaces.values()).filter(
      dw => dw.ownerPeerId === peerId
    );
  }

  /**
   * Phase 6a: Populate discovered workspaces from PeerRouter workspace route data.
   * Called when route announcements arrive, avoiding recursive peer queries.
   */
  addWorkspaceFromRoute(route: {
    ownerPeerId: string;
    workspaceId: string;
    accessMode: string;
    registryId: string;
    hops: number;
    exposedNames?: string[];
  }): void {
    const key = `${route.ownerPeerId}:${route.workspaceId}`;
    const existing = this.discoveredWorkspaces.get(key);

    // Keep existing entry if it has fewer hops
    if (existing && existing.hops <= route.hops) return;

    const entry: DiscoveredWorkspace = {
      workspaceId: route.workspaceId,
      name: route.workspaceId, // Name not available from route, use ID
      ownerPeerId: route.ownerPeerId,
      ownerName: '',
      accessMode: route.accessMode,
      registryId: route.registryId,
      discoveredAt: Date.now(),
      hops: route.hops,
    };

    const isNew = !this.discoveredWorkspaces.has(key);
    this.discoveredWorkspaces.set(key, entry);

    if (isNew) {
      this.changed('workspacesDiscovered', { count: 1, peerId: route.ownerPeerId });
    }
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
    log.info(`handleWorkspaceQuery from=${fromPeerId.slice(0, 16)} hops=${effectiveHops} localShared=${this.localShared.size}`);
    log.info(`localShared entries: ${JSON.stringify([...this.localShared.values()].map(w => ({ name: w.name, mode: w.accessMode })))}`);

    // Add self to visited (loop prevention)
    if (this.localPeerId) {
      if (visitedSet.has(this.localPeerId)) return []; // already visited
      visitedSet.add(this.localPeerId);
    }

    // Filter local shared workspaces for the requesting peer
    const directResults = this.filterWorkspacesForPeer(fromPeerId);
    log.info(`filtered results: ${directResults.length}`);
    const results: DiscoveredWorkspace[] = directResults.map(ws => ({
      workspaceId: ws.workspaceId,
      name: ws.name,
      description: ws.description,
      tags: ws.tags,
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
          request(this.id, this.peerRegistryId, 'listContacts', {})
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

    log.info(`handleWorkspaceQuery returning ${results.length} total`);
    return results;
  }

  /**
   * Resolve a remote peer's WSR UUID via PeerRouter's well-known mapping.
   */
  private async resolveRemoteWsr(peerId: string): Promise<AbjectId | null> {
    if (!this.peerRouterId) return null;
    try {
      const remoteId = await this.request<string | null>(
        request(this.id, this.peerRouterId,
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
   * Sync cached discoveredWorkspaces registryIds from PeerRouter's route data.
   * Route announcements carry the current registryId — if a peer restarted,
   * the route has the new UUID while our cache may have the old one.
   */
  private async syncRegistryIdsFromRoutes(fromPeerId: string): Promise<void> {
    if (!this.peerRouterId) return;

    // Check each cached discovery from this peer
    for (const [key, dw] of this.discoveredWorkspaces) {
      if (dw.ownerPeerId !== fromPeerId) continue;

      try {
        const currentRegistryId = await this.request<string | null>(
          request(this.id, this.peerRouterId, 'resolveWorkspaceRegistry', {
            ownerPeerId: dw.ownerPeerId,
            workspaceId: dw.workspaceId,
          })
        );
        if (currentRegistryId && currentRegistryId !== dw.registryId) {
          log.info(`updated stale registryId for ${dw.name}: ${dw.registryId.slice(0, 8)} → ${currentRegistryId.slice(0, 8)}`);
          dw.registryId = currentRegistryId;
          this.discoveredWorkspaces.set(key, dw);
        }
      } catch { /* PeerRouter not ready */ }
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

  // ── Discovery Cache Persistence ──

  private async loadDiscoveryCache(): Promise<void> {
    if (!this.storageId) return;
    try {
      const raw = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_DISCOVERED })
      );
      if (!raw) return;
      const entries: DiscoveredWorkspace[] = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      for (const entry of entries) {
        if (now - entry.discoveredAt < DISCOVERY_CACHE_TTL) {
          const key = `${entry.ownerPeerId}:${entry.workspaceId}`;
          this.discoveredWorkspaces.set(key, entry);
          loaded++;
        }
      }
      log.info(`loaded ${loaded} cached discoveries (${entries.length} total in storage)`);
    } catch { /* Storage not ready or corrupt data */ }
  }

  private async persistDiscoveryCache(): Promise<void> {
    if (!this.storageId) return;
    try {
      const entries = Array.from(this.discoveredWorkspaces.values());
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY_DISCOVERED,
          value: JSON.stringify(entries),
        })
      );
    } catch { /* best-effort */ }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WorkspaceShareRegistry Usage Guide

### Get locally shared workspaces

  const workspaces = await call(await dep('WorkspaceShareRegistry'), 'getSharedWorkspaces', {});
  // workspaces: [{ id, name, accessMode }]

### Query a specific peer's shared workspaces

  const peerWorkspaces = await call(await dep('WorkspaceShareRegistry'), 'queryPeerWorkspaces', {
    peerId: 'remote-peer-id'
  });
  // peerWorkspaces: [{ id, name, accessMode, peerId }]

### Discover workspaces across all connected peers

  await call(await dep('WorkspaceShareRegistry'), 'discoverWorkspaces', { hops: 1 });
  // Triggers async discovery — results arrive via events or getDiscoveredWorkspaces

### Get previously discovered remote workspaces

  const discovered = await call(await dep('WorkspaceShareRegistry'), 'getDiscoveredWorkspaces', {});
  // discovered: [{ id, name, accessMode, peerId }]

### IMPORTANT
- The interface ID is 'abjects:workspace-share-registry'.
- discoverWorkspaces is async — call getDiscoveredWorkspaces after a delay to read results.
- Only workspaces with non-local access mode (private or public) are shared.`;
  }
}

export const WORKSPACE_SHARE_REGISTRY_ID = 'abjects:workspace-share-registry' as AbjectId;
