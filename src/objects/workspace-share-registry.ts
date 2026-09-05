/**
 * WorkspaceShareRegistry — manages workspace sharing metadata and peer discovery.
 *
 * Tracks which local workspaces are shared, caches discovered remote workspaces,
 * and handles incoming/outgoing workspace discovery queries between peers.
 * Supports transitive multi-hop discovery (A→B→C).
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import {
  normalizeExposureSelectors,
  isExposureEmpty,
  matchesExposureSelectors,
  namesFromTypeIds,
} from './exposure-selectors.js';
import type { SharedWorkspaceInfo } from './workspace-manager.js';
import { isHostLocalObject } from './host-local-objects.js';

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
  /**
   * True when this entry was synthesized from a PeerRouter route announcement
   * rather than answered by a real query. Route announcements carry no name, so
   * such an entry is a placeholder holding a raw UUID: it must never count as a
   * fresh discovery (it would suppress the query that supplies the real name)
   * and a real result must be able to replace it at equal hops.
   */
  fromRoute?: boolean;
}

export interface WorkspaceMemberInfo {
  peerId: string;
  peerName?: string;
  joinedAt: number;
}

export interface WorkspaceJoinRequestPayload {
  workspaceId: string;
  peerId: string;
  peerName?: string;
  requestedAt?: number;
}

export interface WorkspaceJoinAckPayload {
  accepted: boolean;
  workspaceId: string;
  name?: string;
  ownerPeerId: string;
  registryId?: string;
  catalog?: ObjectRegistration[];
  activePeers?: WorkspaceMemberInfo[];
  /** Catalog sequence the returned snapshot corresponds to. */
  catalogSeq?: number;
  reason?: string;
}

export interface WorkspaceCatalogSnapshotPayload {
  workspaceId: string;
  ownerPeerId: string;
  objects: ObjectRegistration[];
  timestamp?: number;
}

export interface WorkspacePeerJoinedPayload {
  workspaceId: string;
  peerId: string;
  peerName?: string;
  joinedAt?: number;
}

export interface WorkspacePeerLeftPayload {
  workspaceId: string;
  peerId: string;
  reason?: string;
  leftAt?: number;
}

/** What changed in a workspace catalog. */
export type WorkspaceCatalogDeltaKind = 'abject_spawned' | 'abject_destroyed' | 'manifest_updated';

/**
 * One incremental change to a shared workspace's catalog. `seq` is per
 * workspace and strictly increasing — that is what lets a peer notice it
 * missed something while disconnected and ask for a replay.
 */
export interface WorkspaceCatalogDeltaPayload {
  workspaceId: string;
  ownerPeerId: string;
  kind: WorkspaceCatalogDeltaKind;
  seq: number;
  timestamp: number;
  objectId?: string;
  /** Present for spawn/manifest deltas; absent for destroys. */
  object?: ObjectRegistration;
}

/** A rejoining peer asking for everything it missed after `sinceSeq`. */
export interface WorkspaceCatalogSyncRequestPayload {
  workspaceId: string;
  peerId: string;
  sinceSeq: number;
}

/**
 * The host's answer: the missed deltas when the replay log still covers them,
 * otherwise a full snapshot to reset the requester's mirror.
 */
export interface WorkspaceCatalogSyncResponsePayload {
  workspaceId: string;
  ownerPeerId: string;
  fromSeq: number;
  currentSeq: number;
  deltas?: WorkspaceCatalogDeltaPayload[];
  snapshot?: ObjectRegistration[];
}

const MAX_HOPS = 3;
/** How many deltas per workspace stay replayable for a reconnecting peer. */
const CATALOG_DELTA_LOG_LIMIT = 250;
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

  /** Active members joined per workspace. Keyed by workspaceId -> Map of peerId -> WorkspaceMemberInfo */
  private activeMembers: Map<string, Map<string, WorkspaceMemberInfo>> = new Map();

  /** Joined remote workspaces tracking. Keyed by workspaceId -> { ownerPeerId, registryId, joinedAt } */
  private joinedWorkspaces: Map<string, { name?: string; ownerPeerId: string; registryId?: string; joinedAt: number }> = new Map();

  /** Our own peer identity info. */
  private localPeerId?: string;
  private localPeerName?: string;

  /** Debounce: last query time per peer. */
  private lastQueryTime: Map<string, number> = new Map();

  /** Per-workspace monotonic catalog sequence, for workspaces we host. */
  private catalogSeq: Map<string, number> = new Map();

  /** Bounded replay log of emitted deltas per hosted workspace. */
  private catalogDeltaLog: Map<string, WorkspaceCatalogDeltaPayload[]> = new Map();

  /** Last delta sequence applied per joined workspace. Keyed `${ownerPeerId}:${workspaceId}`. */
  private appliedCatalogSeq: Map<string, number> = new Map();

  /** Workspace registries we subscribed to for lifecycle events. */
  private subscribedRegistries: Set<AbjectId> = new Set();

  /** Which workspace each subscribed registry backs — registry events carry no workspace stamp. */
  private registryWorkspaces: Map<AbjectId, string> = new Map();

  /** Reconciliations in flight, keyed like appliedCatalogSeq, so they do not overlap. */
  private reconcilingWorkspaces: Set<string> = new Set();

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
              {
                name: 'joinWorkspace',
                description: 'Initiate join handshake to a remote shared workspace',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Owner peer ID' },
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID to join' },
                ],
                returns: { kind: 'reference', reference: 'WorkspaceJoinAckPayload' },
              },
              {
                name: 'leaveWorkspace',
                description: 'Leave a shared workspace and notify peers',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Owner peer ID' },
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID to leave' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getActiveMembers',
                description: 'Get list of active joined peers for a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID' },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'WorkspaceMemberInfo' } },
              },
              {
                name: 'getJoinedWorkspaces',
                description: 'Get list of joined remote workspaces',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'JoinedWorkspaceInfo' } },
              },
              {
                name: 'dropJoinedWorkspace',
                description: 'Forget the joined entry for a workspace. Local bookkeeping only — does not notify the host or the WorkspaceManager',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'reconcileCatalog',
                description: 'Re-sync a joined workspace catalog from its host, replaying catalog deltas missed while disconnected',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Owner peer ID' },
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID' },
                  { name: 'sinceSeq', type: { kind: 'primitive', primitive: 'number' }, description: 'Override the last applied catalog sequence', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getCatalogSeq',
                description: 'Current catalog sequence number for a locally hosted shared workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID' },
                ],
                returns: { kind: 'primitive', primitive: 'number' },
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

    this.on('getJoinedWorkspaces', async () => {
      return this.getJoinedWorkspaces();
    });

    this.on('dropJoinedWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.dropJoinedWorkspace(workspaceId);
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

    // P2P Join/Leave Handshake & Mesh Presence Protocol Handlers
    this.on('workspace:join_request', async (msg: AbjectMessage) => {
      const payload = msg.payload as WorkspaceJoinRequestPayload;
      return this.handleJoinRequest(payload);
    });

    this.on('workspace:join_ack', async (msg: AbjectMessage) => {
      const payload = msg.payload as WorkspaceJoinAckPayload;
      return this.handleJoinAck(payload);
    });

    this.on('workspace:catalog_snapshot', async (msg: AbjectMessage) => {
      const payload = msg.payload as WorkspaceCatalogSnapshotPayload;
      return this.handleCatalogSnapshot(payload);
    });

    this.on('workspace:peer_joined', async (msg: AbjectMessage) => {
      const payload = msg.payload as WorkspacePeerJoinedPayload;
      return this.handlePeerJoined(payload);
    });

    this.on('workspace:peer_left', async (msg: AbjectMessage) => {
      const payload = msg.payload as WorkspacePeerLeftPayload;
      return this.handlePeerLeft(payload);
    });

    this.on('joinWorkspace', async (msg: AbjectMessage) => {
      const { peerId, workspaceId } = msg.payload as { peerId: string; workspaceId: string };
      return this.joinWorkspace(peerId, workspaceId);
    });

    this.on('leaveWorkspace', async (msg: AbjectMessage) => {
      const { peerId, workspaceId } = msg.payload as { peerId: string; workspaceId: string };
      return this.leaveWorkspace(peerId, workspaceId);
    });

    this.on('getActiveMembers', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getActiveMembers(workspaceId);
    });

    // ── Catalog delta wire protocol ──

    this.on('workspace:catalog_delta', async (msg: AbjectMessage) => {
      return this.handleCatalogDelta(msg.payload as WorkspaceCatalogDeltaPayload);
    });

    this.on('workspace:catalog_sync_request', async (msg: AbjectMessage) => {
      return this.handleCatalogSyncRequest(msg.payload as WorkspaceCatalogSyncRequestPayload);
    });

    this.on('reconcileCatalog', async (msg: AbjectMessage) => {
      const { peerId, workspaceId, sinceSeq } = msg.payload as {
        peerId: string; workspaceId: string; sinceSeq?: number;
      };
      return this.reconcileCatalog(peerId, workspaceId, sinceSeq);
    });

    this.on('getCatalogSeq', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.catalogSeq.get(workspaceId) ?? 0;
    });

    // Registry subscription events — the delta source for workspaces we host.
    // The base Registry fans these out to its subscriber set; we relay each one
    // to the workspace mesh as an incremental catalog delta.
    this.on('objectRegistered', async (msg: AbjectMessage) => {
      this.handleRegistryEvent(msg, 'abject_spawned');
    });

    this.on('objectUpdated', async (msg: AbjectMessage) => {
      this.handleRegistryEvent(msg, 'manifest_updated');
    });

    this.on('manifestUpdated', async (msg: AbjectMessage) => {
      this.handleRegistryEvent(msg, 'manifest_updated');
    });

    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      this.handleRegistryEvent(msg, 'abject_destroyed');
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
        // A route announcement is the earliest proof this peer is reachable
        // again, and it can arrive without a `contactConnected` ever firing (the
        // contact was never marked disconnected, or it reconnected under fresh
        // UUIDs). Catch up here too, so a joiner whose resync failed against a
        // stale route recovers on the next announcement instead of at restart.
        this.reconcileJoinedWorkspacesForPeer(fromPeerId).catch(() => { /* best-effort */ });
        return;
      }

      // PeerRegistry: contactConnected — auto-query new peer
      if (aspect === 'contactConnected') {
        const { peerId } = value as { peerId: string };
        // Query the new peer asynchronously (don't block the event)
        this.queryPeerWorkspaces(peerId).catch(() => { /* best-effort */ });
        // Deltas emitted while we were disconnected never reached us: catch up
        // on every workspace we joined from this peer.
        this.reconcileJoinedWorkspacesForPeer(peerId).catch(() => { /* best-effort */ });
        return;
      }

      // PeerRegistry: contactDisconnected — remove discoveries from that peer and cleanup presence
      if (aspect === 'contactDisconnected') {
        const { peerId } = value as { peerId: string };
        for (const [key, dw] of this.discoveredWorkspaces) {
          if (dw.ownerPeerId === peerId) {
            this.discoveredWorkspaces.delete(key);
          }
        }
        this.handlePeerDisconnected(peerId).catch(() => {});
        return;
      }

      // WorkspaceManager: workspaceShared — update local cache
      if (aspect === 'workspaceShared') {
        const info = value as SharedWorkspaceInfo;
        log.info(`workspaceShared event: ${info.name} ${info.accessMode}`);
        this.localShared.set(info.workspaceId, info);
        // Start relaying that workspace's spawns/destroys to joined peers.
        await this.ensureRegistrySubscription(info);
        return;
      }

      // WorkspaceManager: workspaceUnshared — remove from local cache
      if (aspect === 'workspaceUnshared') {
        const { workspaceId } = value as { workspaceId: string };
        this.localShared.delete(workspaceId);
        await this.dropRegistrySubscription(workspaceId);
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

    // Cold boot: workspaces joined in an earlier run were restored by
    // WorkspaceManager but are unknown to this object until we ask.
    this.hydrateJoinedWorkspaces().catch((err) => {
      log.warn('hydrateJoinedWorkspaces: unexpected failure during init:', err);
    });

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
          await this.ensureRegistrySubscription(ws);
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
    // Resolve remote WSR UUID via PeerRouter
    const remoteWsrId = await this.resolveRemoteWsr(peerId);
    if (!remoteWsrId) {
      // Only a query that actually reached the wire may arm the debounce
      // window. At startup the route lands milliseconds after the first
      // attempt, and the announcement carrying it is what triggers the retry —
      // stamping here would suppress that retry for QUERY_DEBOUNCE_MS and leave
      // the browse list empty long after the peer became reachable.
      this.lastQueryTime.delete(peerId);
      log.info(`No WSR route for peer ${peerId.slice(0, 16)}`);
      return [];
    }
    this.lastQueryTime.set(peerId, Date.now());

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
        // A query result carries the real name, so it is never a placeholder —
        // whatever the sender happened to put in the field.
        this.discoveredWorkspaces.set(key, { ...dw, fromRoute: false });
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
      // A failed query must not suppress the next attempt either.
      this.lastQueryTime.delete(peerId);
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

    // Freshness is decided per peer, never globally. A single fresh entry from
    // one peer used to short-circuit the whole loop, so a peer that had never
    // been discovered stayed undiscovered for up to DISCOVERY_CACHE_TTL while
    // some unrelated entry kept being refreshed — a millisecond startup race
    // became a five-minute empty browse list. Placeholders built from route
    // announcements are excluded: they hold a UUID for a name, so they must not
    // stand in for the query that would supply the real one.
    const now = Date.now();
    const freshPeers = new Set<string>();
    for (const dw of this.discoveredWorkspaces.values()) {
      if (!dw.fromRoute && now - dw.discoveredAt < DISCOVERY_CACHE_TTL) {
        freshPeers.add(dw.ownerPeerId);
      }
    }

    const peersToQuery = effectiveHops <= 1
      ? connectedPeerIds.filter(peer => !freshPeers.has(peer))
      : connectedPeerIds;

    const skipped = connectedPeerIds.length - peersToQuery.length;
    if (skipped > 0) {
      log.info(`skipping ${skipped} peer(s) with fresh cached results, querying ${peersToQuery.length}`);
    }

    const allResults: DiscoveredWorkspace[] = [];
    const visited = [this.localPeerId];

    for (const peer of peersToQuery) {
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
          // Prefer the shorter path, but a real named result also replaces a
          // route-derived placeholder at equal hops — otherwise the UUID name
          // survives every successful query.
          if (!existing || dw.hops < existing.hops || (existing.fromRoute && dw.hops <= existing.hops)) {
            this.discoveredWorkspaces.set(key, { ...dw, fromRoute: false });
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

  /**
   * Forget the joined entry for a workspace, touching nothing outside this
   * object.
   *
   * `leaveWorkspace` is the peer-facing path: it tells the host we left, then
   * calls back into WorkspaceManager to release the local record. This is the
   * mirror image, for when WorkspaceManager is the one initiating — it has
   * already removed the record and only needs our bookkeeping cleared. Left
   * behind, the entry keeps surfacing through `getJoinedWorkspaces`, which is
   * what feeds the remote shim a workspace that no longer exists locally.
   *
   * Deliberately makes no outbound requests. Calling back into
   * WorkspaceManager (as `cleanupRemoteObjectsForWorkspace` would, via
   * `resolveLocalRegistryId`) would re-enter the manager while it is awaiting
   * this very reply. The remote objects need no separate sweep here: both
   * paths that call this destroy the workspace's registry outright.
   */
  async dropJoinedWorkspace(workspaceId: string): Promise<boolean> {
    if (!workspaceId) return false;
    const info = this.joinedWorkspaces.get(workspaceId);
    if (!info) return false;

    this.joinedWorkspaces.delete(workspaceId);
    this.activeMembers.delete(workspaceId);
    this.appliedCatalogSeq.delete(`${info.ownerPeerId}:${workspaceId}`);

    log.info(`dropJoinedWorkspace: cleared joined entry for ${workspaceId} (owner ${info.ownerPeerId})`);
    return true;
  }

  getJoinedWorkspaces(): Array<{ workspaceId: string; name?: string; ownerPeerId: string; registryId?: string; joinedAt: number }> {
    return Array.from(this.joinedWorkspaces.entries()).map(([workspaceId, info]) => ({
      workspaceId,
      name: info.name,
      ownerPeerId: info.ownerPeerId,
      registryId: info.registryId,
      joinedAt: info.joinedAt,
    }));
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

    // When a real (queried) entry already exists for this key we are only
    // improving its hop count and routing fields — keep its metadata rather
    // than degrading the name back to a raw UUID.
    const named = existing && !existing.fromRoute ? existing : undefined;

    const entry: DiscoveredWorkspace = {
      workspaceId: route.workspaceId,
      // Name not available from route; fall back to the ID and mark it as a
      // placeholder so a query result can replace it.
      name: named?.name ?? route.workspaceId,
      ownerPeerId: route.ownerPeerId,
      ownerName: named?.ownerName ?? '',
      accessMode: route.accessMode,
      registryId: route.registryId,
      discoveredAt: Date.now(),
      hops: route.hops,
      fromRoute: named === undefined,
    };
    if (named?.description !== undefined) entry.description = named.description;
    if (named?.tags !== undefined) entry.tags = named.tags;

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
      } else if (ws.accessMode === 'shared' && ws.whitelist?.includes(peerId)) {
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

  // ── P2P Join/Leave Handshake & Mesh Presence Protocol ──

  /**
   * Handle an incoming join request from a remote peer for a local shared workspace.
   */
  async handleJoinRequest(
    payload: WorkspaceJoinRequestPayload,
  ): Promise<WorkspaceJoinAckPayload> {
    log.info(`handleJoinRequest workspace=${payload.workspaceId} from peer=${payload.peerId}`);
    const ws = this.localShared.get(payload.workspaceId);
    if (!ws) {
      return {
        accepted: false,
        workspaceId: payload.workspaceId,
        ownerPeerId: this.localPeerId ?? '',
        reason: `Workspace ${payload.workspaceId} not found or not shared locally`,
      };
    }

    // Access verification
    if (!this.peerMayAccess(ws, payload.peerId)) {
      log.info(`join request rejected for peer ${payload.peerId} on workspace ${payload.workspaceId} (mode: ${ws.accessMode})`);
      return {
        accepted: false,
        workspaceId: payload.workspaceId,
        ownerPeerId: this.localPeerId ?? '',
        reason: `Access denied for workspace ${payload.workspaceId}`,
      };
    }

    // Track member presence
    let members = this.activeMembers.get(payload.workspaceId);
    if (!members) {
      members = new Map();
      this.activeMembers.set(payload.workspaceId, members);
    }
    members.set(payload.peerId, {
      peerId: payload.peerId,
      peerName: payload.peerName,
      joinedAt: payload.requestedAt ?? Date.now(),
    });

    // Make sure this workspace's registry is feeding us lifecycle events before
    // we hand out a catalog, so anything spawned after this snapshot arrives at
    // the joiner as a delta rather than being missed until the next full sync.
    await this.ensureRegistrySubscription(ws);
    const catalog = await this.readWorkspaceCatalog(ws);
    log.info(`join_request: acking peer ${payload.peerId} for workspace ${payload.workspaceId} with catalogLength=${catalog.length} catalogSeq=${this.catalogSeq.get(payload.workspaceId) ?? 0} registry=${ws.registryId ?? 'none'}`);

    // Broadcast mesh presence to other active workspace peers
    this.broadcastMeshEvent(payload.workspaceId, 'workspace:peer_joined', {
      workspaceId: payload.workspaceId,
      peerId: payload.peerId,
      peerName: payload.peerName,
      joinedAt: Date.now(),
    }, [payload.peerId]).catch(() => {});

    this.changed('peerJoined', {
      workspaceId: payload.workspaceId,
      peerId: payload.peerId,
      peerName: payload.peerName,
    });

    return {
      accepted: true,
      workspaceId: payload.workspaceId,
      name: ws.name,
      ownerPeerId: this.localPeerId ?? '',
      registryId: ws.registryId,
      catalog,
      catalogSeq: this.catalogSeq.get(payload.workspaceId) ?? 0,
      activePeers: Array.from(members.values()),
    };
  }

  /**
   * Join a remote shared workspace via P2P handshake.
   */
  async joinWorkspace(ownerPeerId: string, workspaceId: string): Promise<WorkspaceJoinAckPayload> {
    log.info(`joinWorkspace ownerPeerId=${ownerPeerId} workspaceId=${workspaceId}`);
    if (!this.localPeerId) {
      return {
        accepted: false,
        workspaceId,
        ownerPeerId,
        reason: 'Local identity not initialized',
      };
    }

    const remoteWsrId = await this.resolveRemoteWsr(ownerPeerId);
    if (!remoteWsrId) {
      return {
        accepted: false,
        workspaceId,
        ownerPeerId,
        reason: `Unable to resolve WorkspaceShareRegistry for peer ${ownerPeerId}`,
      };
    }

    try {
      const ack = await this.request<WorkspaceJoinAckPayload>(
        request(this.id, remoteWsrId, 'workspace:join_request', {
          workspaceId,
          peerId: this.localPeerId,
          peerName: this.localPeerName,
          requestedAt: Date.now(),
        } as WorkspaceJoinRequestPayload)
      );

      if (ack.accepted) {
        log.info(`joinWorkspace: ack accepted for ${workspaceId} from ${ownerPeerId} catalogLength=${ack.catalog?.length ?? 0} catalogSeq=${ack.catalogSeq ?? 0} activePeers=${ack.activePeers?.length ?? 0} remoteRegistry=${ack.registryId ?? 'none'}`);
        this.joinedWorkspaces.set(workspaceId, {
          name: ack.name,
          ownerPeerId,
          registryId: ack.registryId,
          joinedAt: Date.now(),
        });

        // Materialize the joined workspace as a first-class local record with
        // its own registry BEFORE syncing the catalog, so the remote proxies
        // land in that dedicated registry instead of the Default workspace's.
        await this.materializeJoinedWorkspace(
          workspaceId,
          ack.name,
          ownerPeerId,
          (ack.activePeers ?? []).map((p) => p.peerId),
        );

        // The ack's catalog is the state at this sequence; deltas after it are
        // what we expect to receive next.
        this.appliedCatalogSeq.set(`${ownerPeerId}:${workspaceId}`, ack.catalogSeq ?? 0);

        // Populate active members
        if (ack.activePeers && ack.activePeers.length > 0) {
          let members = this.activeMembers.get(workspaceId);
          if (!members) {
            members = new Map();
            this.activeMembers.set(workspaceId, members);
          }
          for (const member of ack.activePeers) {
            members.set(member.peerId, member);
          }
        }

        // Sync the catalog snapshot into the joined workspace's own registry.
        if (ack.catalog && ack.catalog.length > 0) {
          await this.syncCatalogToLocalRegistry(workspaceId, ownerPeerId, ack.catalog);
        } else {
          log.warn(`joinWorkspace: host ${ownerPeerId} returned an empty catalog for ${workspaceId}; the joined workspace starts empty`);
        }

        this.changed('workspaceJoined', { workspaceId, ownerPeerId, ack });
      }

      return ack;
    } catch (err) {
      log.info(`joinWorkspace request failed for ${workspaceId} on peer ${ownerPeerId}`, err);
      return {
        accepted: false,
        workspaceId,
        ownerPeerId,
        reason: `Join handshake request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Leave a shared workspace and notify participants.
   */
  async leaveWorkspace(ownerPeerId: string, workspaceId: string): Promise<boolean> {
    log.info(`leaveWorkspace ownerPeerId=${ownerPeerId} workspaceId=${workspaceId}`);
    const remoteWsrId = await this.resolveRemoteWsr(ownerPeerId);
    if (remoteWsrId && this.localPeerId) {
      try {
        await this.request(
          request(this.id, remoteWsrId, 'workspace:peer_left', {
            workspaceId,
            peerId: this.localPeerId,
            leftAt: Date.now(),
          } as WorkspacePeerLeftPayload)
        );
      } catch { /* best effort */ }
    }

    // Also broadcast peer left to any other active peers in mesh
    await this.broadcastMeshEvent(workspaceId, 'workspace:peer_left', {
      workspaceId,
      peerId: this.localPeerId ?? '',
      leftAt: Date.now(),
    });

    this.joinedWorkspaces.delete(workspaceId);
    this.activeMembers.delete(workspaceId);
    this.appliedCatalogSeq.delete(`${ownerPeerId}:${workspaceId}`);
    await this.cleanupRemoteObjectsForWorkspace(workspaceId);

    // Drop this instance's reference to the shared workspace. Leaving tears
    // down the local mirror only — the workspace itself is reference-counted
    // across participants and survives while any other instance holds it.
    await this.releaseJoinedWorkspace(workspaceId);

    this.changed('workspaceLeft', { workspaceId, ownerPeerId });
    return true;
  }

  /**
   * Handle a join ack received from a host.
   */
  async handleJoinAck(payload: WorkspaceJoinAckPayload): Promise<boolean> {
    log.info(`handleJoinAck accepted=${payload.accepted} workspace=${payload.workspaceId} catalogLength=${payload.catalog?.length ?? 0} catalogSeq=${payload.catalogSeq ?? 0} activePeers=${payload.activePeers?.length ?? 0}`);
    if (payload.accepted) {
      await this.materializeJoinedWorkspace(
        payload.workspaceId,
        payload.name,
        payload.ownerPeerId,
        (payload.activePeers ?? []).map((p) => p.peerId),
      );
      if (payload.catalog && payload.catalog.length > 0) {
        await this.syncCatalogToLocalRegistry(payload.workspaceId, payload.ownerPeerId, payload.catalog);
      } else {
        log.warn(`handleJoinAck: no catalog in ack for workspace ${payload.workspaceId}`);
      }
    }
    return true;
  }

  /**
   * Handle an incoming catalog snapshot update from a peer.
   */
  async handleCatalogSnapshot(payload: WorkspaceCatalogSnapshotPayload): Promise<{ success: boolean; count: number }> {
    log.info(`handleCatalogSnapshot workspace=${payload.workspaceId} objects=${payload.objects.length}`);
    await this.syncCatalogToLocalRegistry(payload.workspaceId, payload.ownerPeerId, payload.objects);
    this.changed('catalogSnapshot', payload);
    return { success: true, count: payload.objects.length };
  }

  /**
   * Handle mesh peer joined notification.
   */
  async handlePeerJoined(payload: WorkspacePeerJoinedPayload): Promise<boolean> {
    log.info(`handlePeerJoined peer=${payload.peerId} workspace=${payload.workspaceId}`);
    let members = this.activeMembers.get(payload.workspaceId);
    if (!members) {
      members = new Map();
      this.activeMembers.set(payload.workspaceId, members);
    }
    members.set(payload.peerId, {
      peerId: payload.peerId,
      peerName: payload.peerName,
      joinedAt: payload.joinedAt ?? Date.now(),
    });

    this.changed('peerJoined', payload);
    return true;
  }

  /**
   * Handle mesh peer left notification.
   */
  async handlePeerLeft(payload: WorkspacePeerLeftPayload): Promise<boolean> {
    log.info(`handlePeerLeft peer=${payload.peerId} workspace=${payload.workspaceId}`);
    const members = this.activeMembers.get(payload.workspaceId);
    if (members) {
      members.delete(payload.peerId);
    }

    await this.cleanupRemoteObjectsForPeer(payload.workspaceId, payload.peerId);
    this.changed('peerLeft', payload);
    return true;
  }

  /**
   * Handle peer disconnection across all shared and joined workspaces.
   */
  private async handlePeerDisconnected(peerId: string): Promise<void> {
    log.info(`handlePeerDisconnected peer=${peerId}`);
    for (const [wsId, members] of this.activeMembers) {
      if (members.has(peerId)) {
        members.delete(peerId);
        await this.cleanupRemoteObjectsForPeer(wsId, peerId);
        this.changed('peerLeft', { workspaceId: wsId, peerId, reason: 'contactDisconnected' });
        // Broadcast peer left to other members if we host this workspace
        if (this.localShared.has(wsId)) {
          this.broadcastMeshEvent(wsId, 'workspace:peer_left', {
            workspaceId: wsId,
            peerId,
            reason: 'contactDisconnected',
            leftAt: Date.now(),
          }, [peerId]).catch(() => {});
        }
      }
    }
  }

  /**
   * Whether `peerId` may take part in a locally hosted workspace: anyone for
   * 'public', whitelisted peers for 'shared', nobody for 'local'.
   */
  private peerMayAccess(ws: { accessMode: string; whitelist?: string[] }, peerId: string): boolean {
    return ws.accessMode === 'public'
      || (ws.accessMode === 'shared' && (ws.whitelist ?? []).includes(peerId));
  }

  /**
   * Broadcast an event to all active peers in a shared workspace mesh.
   */
  private async broadcastMeshEvent(
    workspaceId: string,
    method: string,
    payload: unknown,
    excludePeerIds: string[] = [],
  ): Promise<void>
  {
    const excludes = new Set([...excludePeerIds, this.localPeerId ?? '']);
    const memberIds = (() => {
      const members = this.activeMembers.get(workspaceId);
      if (!members) return [] as string[];
      return [...members.keys()].filter((id) => !excludes.has(id));
    })();

    // Fall back to connected peers when no joined members are tracked (e.g. the
    // peer synced via the cold-boot/hydrate + catalog_sync_request path and never
    // sent a join_request). Without this, deltas are recorded locally but sent
    // nowhere. The fallback still honours the workspace's access rule: a
    // 'shared' workspace's deltas go only to whitelisted peers.
    let targetIds = memberIds;
    const ws = this.localShared.get(workspaceId);
    if (targetIds.length === 0 && this.peerRegistryId && ws) {
      try {
        const res = await this.request<unknown>(
          request(this.id, this.peerRegistryId, 'getConnectedPeers', {})
        );
        const peers: string[] = Array.isArray(res)
          ? (res as unknown[]).filter((p): p is string => typeof p === 'string')
          : typeof res === 'object' && res !== null && Array.isArray((res as { peers?: unknown }).peers)
            ? ((res as { peers: unknown[] }).peers.filter((p): p is string => typeof p === 'string'))
            : typeof res === 'object' && res !== null && Array.isArray((res as { connectedPeers?: unknown }).connectedPeers)
              ? ((res as { connectedPeers: unknown[] }).connectedPeers.filter((p): p is string => typeof p === 'string'))
              : [];
        targetIds = peers.filter((id) => !excludes.has(id) && this.peerMayAccess(ws, id));
        if (targetIds.length > 0) {
          log.info(`broadcastMeshEvent ${method} workspace=${workspaceId}: no joined members, falling back to ${targetIds.length} connected peer(s)`);
        }
      } catch { /* best-effort fallback */ }
    }

    if (targetIds.length === 0) {
      log.info(`broadcastMeshEvent ${method} workspace=${workspaceId}: no active members, delta recorded but not delivered`);
      return;
    }

    log.info(`broadcastMeshEvent ${method} workspace=${workspaceId} targets=${targetIds.length}`);
    for (const peerId of targetIds) {
      const remoteWsrId = await this.resolveRemoteWsr(peerId);
      if (!remoteWsrId) continue;

      try {
        await this.request(
          request(this.id, remoteWsrId, method, payload)
        );
      } catch {
        // best effort delivery across mesh
      }
    }
  }

  /**
   * Get active members in a workspace.
   */
  getActiveMembers(workspaceId: string): WorkspaceMemberInfo[] {
    const members = this.activeMembers.get(workspaceId);
    return members ? Array.from(members.values()) : [];
  }

  // ── Reactive catalog synchronization ──

  /**
   * Subscribe to a shared workspace's registry so local spawns, destroys and
   * manifest changes arrive here as events and can be relayed to the mesh as
   * incremental deltas. Idempotent — a re-share does not re-subscribe.
   */
  private async ensureRegistrySubscription(ws: SharedWorkspaceInfo): Promise<void> {
    if (!ws.registryId) return;
    const registryId = ws.registryId as AbjectId;
    this.registryWorkspaces.set(registryId, ws.workspaceId);
    if (this.subscribedRegistries.has(registryId)) return;
    try {
      await this.request(request(this.id, registryId, 'subscribe', {}));
      this.subscribedRegistries.add(registryId);
      log.info(`subscribed to registry ${String(registryId).slice(0, 8)} for workspace ${ws.workspaceId}`);
    } catch {
      // Registry not ready yet — the next share/join event retries.
    }
  }

  /** Stop relaying deltas for a workspace we no longer share. */
  private async dropRegistrySubscription(workspaceId: string): Promise<void> {
    for (const [registryId, wsId] of Array.from(this.registryWorkspaces)) {
      if (wsId !== workspaceId) continue;
      this.registryWorkspaces.delete(registryId);
      if (!this.subscribedRegistries.delete(registryId)) continue;
      try {
        await this.request(request(this.id, registryId, 'unsubscribe', {}));
      } catch { /* best effort */ }
    }
    this.catalogSeq.delete(workspaceId);
    this.catalogDeltaLog.delete(workspaceId);
  }

  /**
   * Turn a registry subscription event into a catalog delta. These events carry
   * no workspace stamp, so the owning workspace is resolved from the sender —
   * `routing.from` is the registry that emitted it.
   */
  private handleRegistryEvent(msg: AbjectMessage, kind: WorkspaceCatalogDeltaKind): void {
    const workspaceId = this.registryWorkspaces.get(msg.routing.from);
    if (!workspaceId) return;
    if (!this.localShared.has(workspaceId)) return;

    // objectUnregistered carries the bare id; the others carry the registration.
    const raw = msg.payload as unknown;
    let objectId: string | undefined;
    let object: ObjectRegistration | undefined;
    if (typeof raw === 'string') {
      objectId = raw;
    } else if (raw && typeof raw === 'object') {
      const reg = raw as ObjectRegistration & { objectId?: string };
      objectId = (reg.id ?? reg.objectId) as string | undefined;
      if (reg.manifest) object = reg;
    }
    if (!objectId) return;

    // P1-3: a single-entry delta goes through exactly the same curation the
    // snapshot path uses, so an object created AFTER a joiner took its snapshot
    // cannot slip past the whitelist on a 'public' workspace.
    void this.emitCuratedCatalogDelta(workspaceId, kind, objectId, object);
  }

  /**
   * Curate one outbound delta, then emit it (P1-3).
   *
   * `applyCuration` is the single push-side gate: for 'shared' it reduces to
   * the host-local exclusion (so shared workspaces behave exactly as they did
   * before this gate existed), and for 'public' it enforces the durable
   * whitelist. A delta whose object does not survive curation is dropped
   * without consuming a sequence number, so joiners see no gap and no resync.
   */
  private async emitCuratedCatalogDelta(
    workspaceId: string,
    kind: WorkspaceCatalogDeltaKind,
    objectId: string,
    object?: ObjectRegistration,
  ): Promise<void> {
    if (object) {
      // 'user-local' never leaves the host, curation or not.
      if (!this.isShareable(object)) {
        log.info(`catalog delta ${kind} withheld by shareability: workspace=${workspaceId} object=${objectId.slice(0, 8)} name=${object.name ?? 'unknown'} sharing=${object.manifest?.sharing ?? 'unknown'}`);
        return;
      }
      const ws = this.localShared.get(workspaceId);
      if (ws) {
        try {
          const kept = await this.applyCuration(ws, [object]);
          if (kept.length === 0) {
            log.info(
              `catalog delta ${kind} withheld by curation: workspace=${workspaceId} object=${objectId.slice(0, 8)} name=${object.name ?? 'unknown'}`
            );
            return;
          }
        } catch (err) {
          // Fail closed: if curation cannot be evaluated we do not publish.
          log.warn(`catalog delta curation failed for workspace ${workspaceId}; withholding delta:`, err);
          return;
        }
      }
    }
    this.emitCatalogDelta(workspaceId, kind, objectId, object);
  }

  /**
   * Record a delta against the workspace's monotonic sequence, keep it in the
   * bounded replay log, and fan it out to every joined peer.
   */
  private emitCatalogDelta(
    workspaceId: string,
    kind: WorkspaceCatalogDeltaKind,
    objectId: string,
    object?: ObjectRegistration,
  ): void {
    // Same gate, per-change. A destroy delta carries no object and so cannot be
    // classified — it goes out regardless, which is harmless: removing an id a
    // peer never received is a no-op on their side.
    // (Curation itself is applied by `emitCuratedCatalogDelta`, the only caller
    // on the live path; this stays as the last-resort shareability gate.)
    if (object && !this.isShareable(object)) {
      log.info(`catalog delta ${kind} withheld by shareability: workspace=${workspaceId} object=${objectId.slice(0, 8)} name=${object.name ?? 'unknown'} sharing=${object.manifest?.sharing ?? 'unknown'}`);
      return;
    }

    const seq = (this.catalogSeq.get(workspaceId) ?? 0) + 1;
    this.catalogSeq.set(workspaceId, seq);

    const delta: WorkspaceCatalogDeltaPayload = {
      workspaceId,
      ownerPeerId: this.localPeerId ?? '',
      kind,
      seq,
      timestamp: Date.now(),
      objectId,
      object,
    };

    let history = this.catalogDeltaLog.get(workspaceId);
    if (!history) {
      history = [];
      this.catalogDeltaLog.set(workspaceId, history);
    }
    history.push(delta);
    if (history.length > CATALOG_DELTA_LOG_LIMIT) {
      history.splice(0, history.length - CATALOG_DELTA_LOG_LIMIT);
    }

    log.info(`catalog delta ${kind} seq=${seq} workspace=${workspaceId} object=${objectId.slice(0, 8)}`);
    this.broadcastMeshEvent(workspaceId, 'workspace:catalog_delta', delta).catch(() => {});
    this.changed('catalogDelta', delta);
  }

  /**
   * Apply an incremental catalog delta from a workspace host. Sequences are
   * per-workspace and monotonic: an older sequence is a duplicate, and a gap
   * means deltas were missed while we were away, which triggers reconciliation.
   */
  async handleCatalogDelta(
    payload: WorkspaceCatalogDeltaPayload,
  ): Promise<{ applied: boolean; resync: boolean }> {
    const key = `${payload.ownerPeerId}:${payload.workspaceId}`;
    const last = this.appliedCatalogSeq.get(key) ?? 0;

    if (payload.seq > 0 && payload.seq <= last) {
      if (payload.seq !== 1) return { applied: false, resync: false }; // duplicate
      // A sequence of 1 below our watermark can only mean the host restarted
      // and reset its counter: adopt the fresh sequence and re-sync from it.
      log.info(`catalog sequence reset on ${key} (watermark was ${last})`);
      await this.applyCatalogDelta(payload);
      this.appliedCatalogSeq.set(key, 1);
      this.reconcileCatalog(payload.ownerPeerId, payload.workspaceId, 1).catch(() => {});
      return { applied: true, resync: true };
    }

    const gap = last > 0 && payload.seq > last + 1;
    await this.applyCatalogDelta(payload);
    this.appliedCatalogSeq.set(key, Math.max(last, payload.seq));
    this.changed('catalogDelta', payload);

    if (gap) {
      log.info(`catalog gap on ${key}: expected ${last + 1}, received ${payload.seq} — reconciling`);
      this.reconcileCatalog(payload.ownerPeerId, payload.workspaceId, last).catch(() => {});
    }
    return { applied: true, resync: gap };
  }

  /** Mirror one delta into the local registry. Idempotent by construction. */
  private async applyCatalogDelta(delta: WorkspaceCatalogDeltaPayload): Promise<void> {
    const registryId = await this.resolveLocalRegistryId(delta.workspaceId);
    if (!registryId) return;

    if (delta.kind === 'abject_destroyed') {
      if (!delta.objectId) return;
      try {
        await this.request(
          request(this.id, registryId, 'unregisterRemote', { objectId: delta.objectId })
        );
      } catch { /* best effort */ }
      return;
    }

    const obj = delta.object;
    if (!obj) return;
    try {
      await this.request(
        request(this.id, registryId, 'registerRemote', {
          objectId: obj.id,
          manifest: obj.manifest,
          name: obj.name,
          typeId: obj.typeId,
          source: obj.source,
          ownerPeerId: delta.ownerPeerId,
          workspaceId: delta.workspaceId,
        })
      );
    } catch { /* best effort */ }
  }

  /**
   * Answer a peer's catch-up request: the deltas it missed while the replay log
   * still reaches back that far, otherwise a full snapshot.
   */
  async handleCatalogSyncRequest(
    payload: WorkspaceCatalogSyncRequestPayload,
  ): Promise<WorkspaceCatalogSyncResponsePayload> {
    const { workspaceId, sinceSeq } = payload;
    const currentSeq = this.catalogSeq.get(workspaceId) ?? 0;
    const base = {
      workspaceId,
      ownerPeerId: this.localPeerId ?? '',
      fromSeq: sinceSeq,
      currentSeq,
    };
    log.info(`catalog sync request workspace=${workspaceId} from=${payload.peerId} since=${sinceSeq} current=${currentSeq}`);

    const ws = this.localShared.get(workspaceId);
    if (!ws) return { ...base, deltas: [] };
    // The same gate join_request applies: a sync request is the cold-boot
    // substitute for the join handshake, so it must not hand the catalog to a
    // peer the handshake would have refused.
    if (!this.peerMayAccess(ws, payload.peerId)) {
      log.info(`catalog sync request rejected for peer ${payload.peerId} on workspace ${workspaceId} (mode: ${ws.accessMode})`);
      return { ...base, deltas: [] };
    }

    // An authorised sync request proves the requester is an active mesh member
    // even when it never completed the join handshake (cold-boot/hydrate path).
    // Track it so subsequent catalog deltas have somewhere to go instead of
    // being silently dropped.
    let syncMembers = this.activeMembers.get(workspaceId);
    if (!syncMembers) {
      syncMembers = new Map();
      this.activeMembers.set(workspaceId, syncMembers);
    }
    if (!syncMembers.has(payload.peerId)) {
      syncMembers.set(payload.peerId, { peerId: payload.peerId, joinedAt: Date.now() });
    }

    if (sinceSeq > currentSeq) {
      // The requester applied a higher sequence than we ever emitted: we
      // restarted and lost the log, so reset its mirror with a full snapshot.
      return { ...base, snapshot: await this.readWorkspaceCatalog(ws) };
    }
    // A requester at seq 0 has applied nothing yet. It must get the snapshot,
    // never a delta list, even when the log happens to start at seq 1: our
    // catalog may hold objects restored from storage at boot, which register
    // before the registry subscription exists and so never produced a delta.
    // Only a requester that already holds some prefix can be brought up to
    // date by replaying the tail.
    if (sinceSeq > 0) {
      if (sinceSeq === currentSeq) return { ...base, deltas: [] };

      const history = this.catalogDeltaLog.get(workspaceId) ?? [];
      if (history.length > 0 && history[0].seq <= sinceSeq + 1) {
        return { ...base, deltas: history.filter((d) => d.seq > sinceSeq) };
      }
    }

    // The log no longer covers the gap — send the whole catalog instead.
    return { ...base, snapshot: await this.readWorkspaceCatalog(ws) };
  }

  /**
   * Re-sync a joined workspace's catalog from its host. Used after a reconnect
   * and whenever an incoming delta reveals a sequence gap.
   */
  async reconcileCatalog(ownerPeerId: string, workspaceId: string, sinceSeq?: number): Promise<boolean> {
    const key = `${ownerPeerId}:${workspaceId}`;
    if (this.reconcilingWorkspaces.has(key)) return false;
    this.reconcilingWorkspaces.add(key);
    try {
      if (!this.localPeerId) return false;
      const remoteWsrId = await this.resolveRemoteWsr(ownerPeerId);
      if (!remoteWsrId) return false;

      const from = sinceSeq ?? this.appliedCatalogSeq.get(key) ?? 0;
      const res = await this.request<WorkspaceCatalogSyncResponsePayload>(
        request(this.id, remoteWsrId, 'workspace:catalog_sync_request', {
          workspaceId,
          peerId: this.localPeerId,
          sinceSeq: from,
        } as WorkspaceCatalogSyncRequestPayload)
      );

      if (res.snapshot) {
        // Full re-sync: drop what we mirrored for this peer first, so objects
        // destroyed while we were away do not linger in the local catalog.
        await this.cleanupRemoteObjectsForPeer(workspaceId, ownerPeerId);
        await this.syncCatalogToLocalRegistry(workspaceId, ownerPeerId, res.snapshot);
        this.appliedCatalogSeq.set(key, res.currentSeq ?? 0);
      } else {
        for (const delta of (res.deltas ?? []).slice().sort((a, b) => a.seq - b.seq)) {
          await this.applyCatalogDelta(delta);
        }
        this.appliedCatalogSeq.set(
          key,
          Math.max(this.appliedCatalogSeq.get(key) ?? 0, res.currentSeq ?? from),
        );
      }

      log.info(`reconciled ${key}: ${res.snapshot ? `snapshot of ${res.snapshot.length}` : `${res.deltas?.length ?? 0} delta(s)`} → seq ${this.appliedCatalogSeq.get(key)}`);
      this.changed('catalogReconciled', {
        workspaceId,
        ownerPeerId,
        fromSeq: from,
        currentSeq: res.currentSeq,
        replayed: res.deltas?.length ?? 0,
        snapshot: !!res.snapshot,
      });
      return true;
    } catch (err) {
      log.info(`reconcileCatalog failed for ${key}`, err);
      return false;
    } finally {
      this.reconcilingWorkspaces.delete(key);
    }
  }

  /**
   * Cold boot: re-establish the mirrors for workspaces joined in an earlier run.
   *
   * `joinedWorkspaces` lives in memory only, so after a restart it is empty even
   * though WorkspaceManager has restored those workspaces from storage. Nothing
   * then triggers a catalog sync — the restored workspace's registry holds no
   * remote objects until the user re-joins by hand — and `contactConnected` has
   * no entry to reconcile either. Repopulating the map repairs both: it requests
   * one sync now, and leaves the reconnect path able to catch up later.
   */
  private async hydrateJoinedWorkspaces(): Promise<void> {
    const wmId = await this.resolveWorkspaceManagerId();
    if (!wmId) {
      log.warn('hydrateJoinedWorkspaces: no WorkspaceManager available; joined workspaces will not resync until a manual re-join');
      return;
    }

    let joined: Array<{ workspaceId: string; name?: string; ownerPeerId?: string; registryId?: string }> = [];
    try {
      joined = await this.request<Array<{ workspaceId: string; name?: string; ownerPeerId?: string; registryId?: string }>>(
        request(this.id, wmId, 'listJoinedWorkspaces', {})
      ) ?? [];
    } catch (err) {
      log.warn('hydrateJoinedWorkspaces: unable to list joined workspaces from WorkspaceManager:', err);
      return;
    }

    const restored: Array<{ workspaceId: string; ownerPeerId: string }> = [];
    for (const ws of joined) {
      if (!ws.ownerPeerId) {
        log.warn(`hydrateJoinedWorkspaces: joined workspace ${ws.workspaceId} has no owner peer recorded; cannot resync its catalog`);
        continue;
      }
      if (this.joinedWorkspaces.has(ws.workspaceId)) continue;
      this.joinedWorkspaces.set(ws.workspaceId, {
        name: ws.name,
        ownerPeerId: ws.ownerPeerId,
        registryId: ws.registryId,
        joinedAt: Date.now(),
      });
      restored.push({ workspaceId: ws.workspaceId, ownerPeerId: ws.ownerPeerId });
    }

    if (restored.length === 0) return;
    log.info(`hydrateJoinedWorkspaces: restored ${restored.length} joined workspace(s); requesting catalog resync`);

    // Detached: an owner that is offline must not hold up initialization. Each
    // attempt reports its own outcome, and `contactConnected` retries whenever
    // the peer comes back, so a failure here costs a delay rather than the sync.
    void (async () => {
      for (const { workspaceId, ownerPeerId } of restored) {
        try {
          const synced = await this.reconcileCatalog(ownerPeerId, workspaceId);
          if (synced) {
            log.info(`hydrateJoinedWorkspaces: catalog resynced for workspace ${workspaceId} from owner ${ownerPeerId.slice(0, 16)}`);
          } else {
            log.warn(`hydrateJoinedWorkspaces: catalog resync for workspace ${workspaceId} did not complete (owner ${ownerPeerId.slice(0, 16)} unreachable?); will retry when that peer reconnects`);
          }
        } catch (err) {
          log.warn(`hydrateJoinedWorkspaces: catalog resync failed for workspace ${workspaceId}:`, err);
        }
      }
    })();
  }

  /** Re-sync every workspace we joined from a peer that just reconnected. */
  private async reconcileJoinedWorkspacesForPeer(peerId: string): Promise<void> {
    for (const [workspaceId, info] of Array.from(this.joinedWorkspaces)) {
      if (info.ownerPeerId !== peerId) continue;
      await this.reconcileCatalog(peerId, workspaceId);
    }
  }

  /** Read the current object catalog of a locally hosted shared workspace. */
  private async readWorkspaceCatalog(ws: SharedWorkspaceInfo): Promise<ObjectRegistration[]> {
    return (await this.readWorkspaceCatalogRaw(ws)).filter((reg) => this.isShareable(reg));
  }

  /**
   * Policy gate on the outbound path: a 'user-local' object never enters a
   * peer's catalog. This has to happen here, before anything is handed to a
   * joiner or a sync request, because filtering on receipt would already have
   * put the object on the wire.
   */
  private isShareable(reg: ObjectRegistration): boolean {
    return reg?.manifest?.sharing !== 'user-local';
  }

  private async readWorkspaceCatalogRaw(ws: SharedWorkspaceInfo): Promise<ObjectRegistration[]> {
    if (!ws.registryId) return [];
    const registryId = ws.registryId as AbjectId;
    let entries: ObjectRegistration[] = [];
    try {
      entries = await this.request<ObjectRegistration[]>(
        request(this.id, registryId, 'listLocal', {})
      );
    } catch {
      try {
        entries = await this.request<ObjectRegistration[]>(
          request(this.id, registryId, 'listObjects', {})
        );
      } catch {
        return [];
      }
    }
    return this.applyCuration(ws, entries);
  }

  /**
   * Host-side curation. When the user has explicitly curated the workspace's
   * exposure list, only the objects on it are offered to a joiner; otherwise
   * every shareable object is offered exactly as before. This only narrows what
   * leaves the host — it does not change the meaning of `isShareable`, which
   * still excludes 'user-local' objects whether or not curation is in force.
   *
   * Curation is read from the explicit `curated` flag, never inferred from a
   * non-empty exposure list. Sharing a workspace seeds `exposedObjectIds` with
   * the workspace registry (and SharedState) as infrastructure, so "the list is
   * non-empty" is true of every shared workspace and would silently withhold
   * every object the user never named.
   */
  private async applyCuration(ws: SharedWorkspaceInfo, entries: ObjectRegistration[]): Promise<ObjectRegistration[]> {
    // A 'shared' workspace is collaborative among known members, so its abjects
    // go to them automatically: no whitelist, and no curation to keep in step
    // with objects created after the fact. Only this host's own shell and
    // infrastructure stay behind. The workspace registry is exempt from even
    // that — it is the joiner's entry point, and the one object that resolves
    // the others by name once their ids have rotated across a restart.
    //
    // 'public' keeps the strict whitelist below: an unauthenticated joiner is
    // told only what the user named, never everything the workspace happens to
    // hold.
    if (ws.accessMode === 'shared') {
      const kept = entries.filter(
        (reg) => reg.id === ws.registryId || !isHostLocalObject(reg?.manifest?.name)
      );
      log.info(
        `applyCuration: workspace=${ws.workspaceId} shared/auto-expose ${entries.length} -> ${kept.length} object(s)`
      );
      return kept;
    }

    const curated = await this.readCuratedExposure(ws);
    // P1-2: the SAME predicate the registry's `isExposedToRemote` uses on the
    // pull side — id OR durable typeId OR durable registered name — imported
    // from one module so push and pull agree by construction rather than by
    // two hand-written filters happening to match.
    const selectors = normalizeExposureSelectors({
      ids: curated.objectIds,
      typeIds: curated.typeIds,
      names: curated.names,
    });
    // Uncurated, or curated down to nothing: share everything, as before.
    if (!curated.curated || isExposureEmpty(selectors)) return entries;
    const kept = entries.filter((reg) =>
      // The workspace registry is the joiner's entry point into the workspace;
      // curation must never strip it or the mirror has nothing to talk to.
      reg.id === ws.registryId ||
      matchesExposureSelectors(reg, selectors)
    );
    log.info(`applyCuration: workspace=${ws.workspaceId} curated ${entries.length} -> ${kept.length} object(s)`);
    return kept;
  }

  /**
   * The workspace's curated exposure list, read from WorkspaceManager.
   *
   * `localShared` is filled from `workspaceShared` events, but a later curation
   * change emits `workspaceAccessChanged` — an aspect this object does not
   * subscribe to — so the cached copy can carry a stale exposure list. Asking
   * WorkspaceManager at catalog-read time keeps curation authoritative; the
   * cached copy is the fallback for when it cannot be reached.
   */
  private async readCuratedExposure(
    ws: SharedWorkspaceInfo
  ): Promise<{ objectIds: string[]; typeIds: string[]; names: string[]; curated: boolean }> {
    const fallback = {
      objectIds: ws.exposedObjectIds ?? [],
      typeIds: ws.exposedTypeIds ?? [],
      // Durable names are recoverable from the durable typeIds
      // (`<scope>/<Name>`), so curation survives AbjectId churn without a
      // second persisted list.
      names: namesFromTypeIds(ws.exposedTypeIds ?? []),
      curated: ws.curated === true,
    };
    const wmId = await this.resolveWorkspaceManagerId();
    if (!wmId) return fallback;
    try {
      const shared = await this.request<SharedWorkspaceInfo[]>(
        request(this.id, wmId, 'listSharedWorkspaces', {})
      );
      const live = shared?.find((s) => s.workspaceId === ws.workspaceId);
      if (!live) return fallback;
      return {
        objectIds: live.exposedObjectIds ?? [],
        typeIds: live.exposedTypeIds ?? [],
        names: namesFromTypeIds(live.exposedTypeIds ?? []),
        curated: live.curated === true,
      };
    } catch (err) {
      log.warn(`readCuratedExposure: falling back to cached exposure for workspace ${ws.workspaceId}:`, err);
      return fallback;
    }
  }

  /** Resolve the WorkspaceManager, if one is reachable on this instance. */
  private async resolveWorkspaceManagerId(): Promise<AbjectId | undefined> {
    try {
      return (await this.discoverDep('WorkspaceManager')) as AbjectId | undefined;
    } catch (err) {
      log.warn('Unable to resolve WorkspaceManager:', err);
      return undefined;
    }
  }

  /**
   * Ask WorkspaceManager to materialize a joined workspace as a first-class
   * local record with its own WorkspaceRegistry and UI scaffolding. Best
   * effort: an instance with no WorkspaceManager can still join, it just has
   * no dedicated registry to host the remote proxies.
   */
  private async materializeJoinedWorkspace(
    workspaceId: string,
    name: string | undefined,
    ownerPeerId: string,
    participants: string[],
  ): Promise<AbjectId | undefined> {
    const wmId = await this.resolveWorkspaceManagerId();
    if (!wmId) {
      log.warn(`materializeJoinedWorkspace: no WorkspaceManager available; workspace ${workspaceId} will have no dedicated local registry`);
      return undefined;
    }
    try {
      const res = await this.request<{ workspaceId: string; registryId: AbjectId; created: boolean }>(
        request(this.id, wmId, 'materializeJoinedWorkspace', { workspaceId, name, ownerPeerId, participants })
      );
      log.info(`materializeJoinedWorkspace: workspace=${workspaceId} owner=${ownerPeerId} registry=${res?.registryId} created=${res?.created} participants=${participants.length}`);
      return res?.registryId;
    } catch (err) {
      log.warn(`materializeJoinedWorkspace failed for workspace ${workspaceId}:`, err);
      return undefined;
    }
  }

  /**
   * Drop this instance's reference to a shared workspace. The workspace is
   * reference-counted across participating instances — this tears down the
   * local mirror only, and the workspace lives on wherever another participant
   * still holds a reference.
   */
  private async releaseJoinedWorkspace(workspaceId: string): Promise<void> {
    const wmId = await this.resolveWorkspaceManagerId();
    if (!wmId) {
      log.warn(`releaseJoinedWorkspace: no WorkspaceManager available; local record for ${workspaceId} not released`);
      return;
    }
    try {
      const res = await this.request<{ released: boolean; remaining: string[]; deleted: boolean }>(
        request(this.id, wmId, 'releaseJoinedWorkspace', {
          workspaceId,
          peerId: this.localPeerId ?? undefined,
          destroy: true,
        })
      );
      log.info(`releaseJoinedWorkspace: workspace=${workspaceId} released=${res?.released} remaining=${res?.remaining?.length ?? 0} deleted=${res?.deleted}`);
    } catch (err) {
      log.warn(`releaseJoinedWorkspace failed for workspace ${workspaceId}:`, err);
    }
  }

  /**
   * The registry that mirrors remote catalog entries for a workspace.
   *
   * A joined workspace is materialized locally as a first-class record with its
   * own WorkspaceRegistry, so ask WorkspaceManager for that registry first.
   * Falling through to a discovered 'WorkspaceRegistry'/'Registry' means
   * writing remote proxies into whatever registry answers — in practice the
   * local Default workspace — which is the pollution this ordering exists to
   * prevent, so the fallback warns loudly rather than passing silently.
   */
  private async resolveLocalRegistryId(workspaceId: string): Promise<AbjectId | undefined> {
    const wmId = await this.resolveWorkspaceManagerId();
    if (wmId) {
      try {
        const dedicated = await this.request<AbjectId | null>(
          request(this.id, wmId, 'getWorkspaceRegistryId', { workspaceId })
        );
        if (dedicated) return dedicated as AbjectId;
        log.warn(`resolveLocalRegistryId: WorkspaceManager has no record for workspace ${workspaceId}`);
      } catch (err) {
        log.warn(`resolveLocalRegistryId: getWorkspaceRegistryId failed for workspace ${workspaceId}:`, err);
      }
    }

    const localWs = this.localShared.get(workspaceId);
    if (localWs?.registryId) return localWs.registryId as AbjectId;

    const fallback = ((await this.discoverDep('WorkspaceRegistry'))
      ?? (await this.discoverDep('Registry'))) as AbjectId | undefined;
    if (fallback) {
      log.warn(`resolveLocalRegistryId: no dedicated registry for workspace ${workspaceId}; falling back to ${fallback} — remote objects may land in the wrong workspace`);
    } else {
      log.warn(`resolveLocalRegistryId: no registry at all resolvable for workspace ${workspaceId}`);
    }
    return fallback;
  }

  /**
   * Synchronize remote catalog objects into the local WorkspaceRegistry.
   */
  private async syncCatalogToLocalRegistry(
    workspaceId: string,
    ownerPeerId: string,
    catalog: ObjectRegistration[],
  ): Promise<void> {
    log.info(`syncCatalogToLocalRegistry: entry workspace=${workspaceId} owner=${ownerPeerId} catalogLength=${catalog.length}`);

    const localRegistryId = await this.resolveLocalRegistryId(workspaceId);
    if (!localRegistryId) {
      log.warn(`syncCatalogToLocalRegistry: no target registry for workspace ${workspaceId}; dropping ${catalog.length} catalog entries`);
      return;
    }
    log.info(`syncCatalogToLocalRegistry: target registry=${localRegistryId} workspace=${workspaceId}`);

    let registered = 0;
    let failed = 0;
    for (const obj of catalog) {
      try {
        await this.request(
          request(this.id, localRegistryId, 'registerRemote', {
            objectId: obj.id,
            manifest: obj.manifest,
            name: obj.name,
            typeId: obj.typeId,
            source: obj.source,
            ownerPeerId,
            workspaceId,
          })
        );
        registered++;
        log.info(`syncCatalogToLocalRegistry: registered '${obj.name}' (${obj.id}) into ${localRegistryId}`);
      } catch (err) {
        failed++;
        log.warn(`syncCatalogToLocalRegistry: registerRemote failed for '${obj.name}' (${obj.id}) on registry ${localRegistryId}:`, err);
      }
    }
    log.info(`syncCatalogToLocalRegistry: done workspace=${workspaceId} registered=${registered} failed=${failed} of ${catalog.length}`);
  }

  /**
   * Cleanup remote objects for a specific peer in a workspace.
   */
  private async cleanupRemoteObjectsForPeer(workspaceId: string, peerId: string): Promise<void> {
    const localRegistryId = await this.resolveLocalRegistryId(workspaceId);
    if (!localRegistryId) {
      log.warn(`cleanupRemoteObjectsForPeer: no target registry for workspace ${workspaceId}; objects from peer ${peerId} left in place`);
      return;
    }
    try {
      await this.request(
        request(this.id, localRegistryId, 'unregisterRemoteForPeer', { workspaceId, peerId })
      );
      log.info(`cleanupRemoteObjectsForPeer: cleared peer ${peerId} from registry ${localRegistryId} (workspace ${workspaceId})`);
    } catch (err) {
      log.warn(`cleanupRemoteObjectsForPeer: unregisterRemoteForPeer failed on ${localRegistryId} for peer ${peerId}:`, err);
    }
  }

  /**
   * Cleanup all remote objects when leaving a workspace.
   */
  private async cleanupRemoteObjectsForWorkspace(workspaceId: string): Promise<void> {
    const localRegistryId = await this.resolveLocalRegistryId(workspaceId);
    if (!localRegistryId) {
      log.warn(`cleanupRemoteObjectsForWorkspace: no target registry for workspace ${workspaceId}; remote objects left in place`);
      return;
    }
    try {
      await this.request(
        request(this.id, localRegistryId, 'unregisterRemoteForWorkspace', { workspaceId })
      );
      log.info(`cleanupRemoteObjectsForWorkspace: cleared workspace ${workspaceId} from registry ${localRegistryId}`);
    } catch (err) {
      log.warn(`cleanupRemoteObjectsForWorkspace: unregisterRemoteForWorkspace failed on ${localRegistryId}:`, err);
    }
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
