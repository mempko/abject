/**
 * PeerRouter — Abject + MessageInterceptor that provides transparent
 * multi-hop message routing with permission-aware route propagation.
 *
 * Replaces NetworkBridge. An AbjectId UUID is the only address — senders
 * never know or care whether the target is local or remote. Routes are
 * propagated automatically based on workspace access mode (public/private/local).
 * Remote well-known objects are resolved to UUIDs via `resolveRemoteObject`.
 *
 * Scale-up design (Phases 1-3):
 *   Phase 1: Workspace-level route aggregation — one route per workspace instead
 *            of one per object. Reduces route table from ~100K to ~10K entries at scale.
 *   Phase 2: Incremental route diffs — only send route changes, not full tables.
 *   Phase 3: Gossip-based route propagation — O(log n) fanout instead of flood.
 */

import { AbjectId, TypeId, AbjectMessage } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest, error as createError } from '../core/message.js';
import type { MessageInterceptor, MessageBus } from '../runtime/message-bus.js';
import type { PeerId } from '../core/identity.js';
import type { PeerRegistry } from '../objects/peer-registry.js';
import type { DedicatedWorkerBridge } from '../runtime/dedicated-worker-bridge.js';
import type { WorkspaceAccessMode } from '../objects/workspace-manager.js';
import { Log } from '../core/timed-log.js';

const log = new Log('PeerRouter');

const PEER_ROUTER_INTERFACE = 'abjects:peer-router';

export const PEER_ROUTER_ID = 'abjects:peer-router' as AbjectId;

const ROUTE_TTL = 3 * 60 * 1000; // 3 minutes (reduced from 5 for faster stale cleanup)
const ANNOUNCE_INTERVAL = 30_000; // 30s periodic anti-entropy (reduced from 60s)
const ANNOUNCE_JITTER = 15_000; // jitter range added to anti-entropy interval
const GOSSIP_FANOUT = 4; // Phase 3: max peers to gossip to
const GOSSIP_FANOUT_MIN = 2; // Phase 3: always gossip to at least 2 peers
const MAX_CHANGELOG = 500; // Phase 2: max changelog entries
const PROPAGATION_EXPIRY = 30_000; // Phase 3: propagation dedup window

/**
 * P2-2 — minimal signaling/routing surface reachable from remote peers.
 *
 * `allowedSystemObjects` is a bypass around workspace curation, so it is no
 * longer a bare set of ids: each admitted object carries the exact set of
 * methods a REMOTE peer may invoke on it. Anything else addressed to that
 * object falls through to the normal curation check, so a permitted system
 * object cannot be used as a universal proxy.
 */
const PEER_ROUTER_REMOTE_METHODS: ReadonlySet<string> = new Set([
  'registerRoute',
  'removeRoute',
  'clearRoutesForPeer',
  'announceRoutes',
  'handleRouteAnnouncement',
  'handleRouteDigest',
  'resolveRemoteObject',
  'resolveWorkspaceRegistry',
  'getRoutes',
]);

/** Workspace signaling protocol — the only WSR surface a peer may reach. */
const WORKSPACE_SHARE_REGISTRY_REMOTE_METHODS: ReadonlySet<string> = new Set([
  'workspace:join_request',
  'workspace:join_ack',
  'workspace:peer_joined',
  'workspace:peer_left',
  'workspace:catalog_snapshot',
  'workspace:catalog_delta',
  'workspace:catalog_sync_request',
  'handleWorkspaceQuery',
  'getCatalogSeq',
]);

/** Well-known id (not ephemeral UUID) → its permitted remote method set. */
const SIGNALING_SYSTEM_OBJECTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['abjects:workspace-share-registry', WORKSPACE_SHARE_REGISTRY_REMOTE_METHODS],
]);
const MAX_GOSSIP_HOPS = 3; // Phase 3: max hops for gossip propagation

// Rate limiting: token bucket per peer
const RATE_LIMIT_CAPACITY = 100; // max burst
const RATE_LIMIT_REFILL = 50; // tokens per second

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}


// Phase 1: Per-object route entry (kept only for system objects ~20 entries)
interface RouteEntry {
  nextHop: PeerId;
  hops: number;
  ttl: number; // expiry timestamp
  typeId?: TypeId;
}

// Phase 1: Workspace-level route entry
interface WorkspaceRoute {
  ownerPeerId: PeerId;
  workspaceId: string;
  nextHop: PeerId;
  hops: number;
  ttl: number;
  accessMode: WorkspaceAccessMode;
  registryId: AbjectId;       // entry point for on-demand object resolution
  exposedNames: string[];      // object names (not UUIDs) for routing hints
  exposedObjectIds: AbjectId[]; // actual exposed object IDs for permission checks
}

// Phase 2: Route changelog entry
interface RouteChange {
  version: number;
  type: 'add' | 'remove' | 'update';
  workspaceKey: string;
  route?: WorkspaceRoute;
}

// Phase 2: Per-peer announcement state
interface PeerAnnounceState {
  lastVersion: number;
  announcedRoutes: Set<string>; // workspaceKeys
}

interface PermissionCacheEntry {
  workspaceId: string;
  accessMode: WorkspaceAccessMode;
  whitelist: string[];
  exposedObjectIds: AbjectId[];
  /** P2-2/P1-2: durable curation selectors — survive AbjectId churn. */
  exposedTypeIds: string[];
  exposedNames: string[];
  cachedAt: number;
}

const PERMISSION_CACHE_TTL = 30_000; // 30s

export class PeerRouter extends Abject implements MessageInterceptor {
  // Phase 1: Workspace-level routing (primary route table)
  private workspaceRoutes: Map<string, WorkspaceRoute> = new Map(); // key: `${ownerPeerId}/${workspaceId}`
  private objectToWorkspace: Map<AbjectId, string> = new Map(); // cache: AbjectId → workspaceKey
  private systemRoutes: Map<AbjectId, RouteEntry> = new Map(); // per-object for system objects only (~20)

  // Phase 2: Incremental diffs
  private routeVersion = 0;
  private routeChangelog: RouteChange[] = [];
  private peerAnnounceState: Map<PeerId, PeerAnnounceState> = new Map();

  // Phase 3: Gossip dedup
  private seenPropagations: Map<string, number> = new Map(); // propagationId → expiry

  /**
   * System objects explicitly allowed for remote access (P2-2: minimised).
   * objectId → the method names a remote peer may invoke on it. Admission is
   * restricted to the well-known signaling/routing objects above.
   */
  private allowedSystemObjects: Map<AbjectId, ReadonlySet<string>> = new Map();

  /** Well-known name → local UUID mapping for inbound message resolution (legacy) */
  private wellKnownAliases: Map<AbjectId, AbjectId> = new Map();

  /** TypeId → local AbjectId mapping for inbound resolution */
  private typeIdToLocal: Map<TypeId, AbjectId> = new Map();

  /** Remote peer TypeId/well-known → UUID mappings: key = `${peerId}:${typeIdOrWellKnown}` */
  private remoteWellKnown: Map<string, AbjectId> = new Map();

  /** NAT table: local objectId → Map<peerId, expiryTimestamp> */
  private connTrack: Map<AbjectId, Map<PeerId, number>> = new Map();

  /**
   * P2-2: precisely scoped NAT table. The coarse connTrack map above is used
   * only for speculative ROUTING. Inbound PERMISSION reuse keys on the exact
   * (localObject, peer, remoteObject) triple that actually initiated, and a
   * hit here never bypasses curation — it is re-checked on every reuse.
   * Key: `${localObjectId}|${peerId}|${remoteObjectId}` → expiry timestamp.
   */
  private connTrackPairs: Map<string, number> = new Map();

  /**
   * Requests handed to a peer's wire and not yet answered, keyed by the
   * ORIGINAL messageId — which is exactly the correlationId the peer's reply
   * will carry, so an inbound reply cancels the timeout below.
   */
  private pendingWireRequests: Map<string, {
    peerId: PeerId;
    request: AbjectMessage;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  /**
   * Requests that arrived FROM a peer and were delivered locally, keyed by
   * messageId. The local reply to one of these has to go back out to that peer,
   * and the recipient id alone cannot say so: the remote caller holds no
   * mailbox here and usually no announced route either, so a reply addressed to
   * it would find neither local delivery nor a next hop. Correlation is exact
   * where the recipient id carries no routing information at all.
   */
  private inboundRequestOrigins: Map<string, { peerId: PeerId; expiresAt: number }> = new Map();

  /** Fail just inside the caller's own 30s request timeout, so this error wins. */
  private readonly wireRequestTimeoutMs = 25_000;
  private readonly inboundOriginTtlMs = 60_000;
  private rateLimitBuckets: Map<PeerId, TokenBucket> = new Map();

  /** Hint map: registryId/objectId → ownerPeerId, populated from workspace route announcements.
   *  Persists beyond workspace route TTL to help speculative routing. */
  private registryOwnerHints: Map<AbjectId, PeerId> = new Map();

  /** Inbound permission cache */
  private permissionCache: Map<AbjectId, PermissionCacheEntry> = new Map();

  /** Direct refs set during bootstrap */
  private _messageBus?: MessageBus;
  private peerRegistryRef?: PeerRegistry;          // direct mode (main thread)
  private p2pBridge?: DedicatedWorkerBridge;         // bridge mode (P2P in worker)
  private connectedPeersCache: Set<PeerId> = new Set(); // bridge mode: updated via peer-status
  private localPeerIdCache?: PeerId;                 // bridge mode: set once at startup
  private peerRegistryId?: AbjectId;
  private workspaceManagerId?: AbjectId;

  /** Anti-entropy timer (setTimeout with jitter, reschedules itself) */
  private announceTimer?: ReturnType<typeof setTimeout>;

  /** Debounce timer for re-announcements triggered by incoming routes */
  private reannounceTimer?: ReturnType<typeof setTimeout>;

  /** Phase 3: Propagation dedup cleanup timer */
  private propagationCleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super({
      manifest: {
        name: 'PeerRouter',
        description:
          'Transparent multi-hop message router with permission-aware route propagation. Routes messages to remote peers based on AbjectId, enforces workspace access permissions on inbound messages. Uses workspace-level route aggregation, incremental diffs, and gossip propagation for scalability.',
        version: '2.0.0',
        interface: {
            id: PEER_ROUTER_INTERFACE,
            name: 'PeerRouter',
            description: 'Message routing and route management',
            methods: [
              {
                name: 'registerRoute',
                description: 'Register an AbjectId → nextHop mapping (system objects only)',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object ID to route' },
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Next-hop peer ID' },
                  { name: 'hops', type: { kind: 'primitive', primitive: 'number' }, description: 'Hop count', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'removeRoute',
                description: 'Remove a route',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object ID' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'clearRoutesForPeer',
                description: 'Clear all routes through a given peer',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID' },
                ],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'getRoutes',
                description: 'Dump current routing table (debugging)',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'RouteInfo' } },
              },
              {
                name: 'announceRoutes',
                description: 'Push local routes to a specific peer',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer to announce to' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'handleRouteAnnouncement',
                description: 'Receive route announcements from a peer (full or diff)',
                parameters: [
                  { name: 'routes', type: { kind: 'array', elementType: { kind: 'reference', reference: 'AnnouncedRoute' } }, description: 'Announced routes' },
                  { name: 'fromPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Announcing peer' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'resolveRemoteObject',
                description: 'Resolve a remote peer well-known ID to a routable UUID',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Remote peer ID' },
                  { name: 'wellKnownId', type: { kind: 'primitive', primitive: 'string' }, description: 'Well-known object ID to resolve' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'handleRouteDigest',
                description: 'Handle anti-entropy route digest exchange',
                parameters: [
                  { name: 'digest', type: { kind: 'array', elementType: { kind: 'reference', reference: 'DigestEntry' } }, description: 'Route digests' },
                  { name: 'fromPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer sending digest' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'resolveWorkspaceRegistry',
                description: 'Look up the current registryId for a workspace from the route table',
                parameters: [
                  { name: 'ownerPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Owner peer ID' },
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace ID' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
            ],
            events: [
              {
                name: 'routeAdded',
                description: 'A new workspace route was added',
                payload: { kind: 'object', properties: {
                  workspaceKey: { kind: 'primitive', primitive: 'string' },
                  ownerPeerId: { kind: 'primitive', primitive: 'string' },
                  workspaceId: { kind: 'primitive', primitive: 'string' },
                  nextHop: { kind: 'primitive', primitive: 'string' },
                  hops: { kind: 'primitive', primitive: 'number' },
                } },
              },
              {
                name: 'routeRemoved',
                description: 'A workspace route was removed',
                payload: { kind: 'object', properties: {
                  workspaceKey: { kind: 'primitive', primitive: 'string' },
                } },
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

  // ==========================================================================
  // Bootstrap wiring (called from index.ts before init)
  // ==========================================================================

  /**
   * Set the MessageBus reference for injecting inbound messages.
   */
  setBus(bus: MessageBus): void {
    this._messageBus = bus;
  }

  /**
   * Set the PeerRegistry reference for transport access (direct mode).
   */
  setPeerRegistry(peerRegistry: PeerRegistry): void {
    this.peerRegistryRef = peerRegistry;
    peerRegistry.onPeerConnected((peerId: string) => {
      log.info(`direct peerConnected callback for ${peerId.slice(0, 16)}`);
      this.announceRoutesToPeer(peerId as PeerId).catch(() => {});
    });
  }

  /**
   * Set the P2P bridge for transport access (bridge mode — P2P in worker).
   * Replaces setPeerRegistry() when P2P objects run in a dedicated worker.
   */
  setP2PBridge(bridge: DedicatedWorkerBridge): void {
    this.p2pBridge = bridge;
  }

  /**
   * Update the cached set of connected peers (bridge mode).
   * Called from main thread when P2P worker posts peer-status events.
   */
  updateConnectedPeers(peers: PeerId[]): void {
    this.connectedPeersCache = new Set(peers);
  }

  /**
   * Set the local peer ID cache (bridge mode).
   * Called once after P2P worker reports identity.
   */
  setLocalPeerId(peerId: PeerId): void {
    this.localPeerIdCache = peerId;
  }

  // ── Unified peer access (works in both direct and bridge mode) ──────

  private isPeerConnected(peerId: PeerId): boolean {
    if (this.peerRegistryRef) {
      const transport = this.peerRegistryRef.getTransportForPeer(peerId);
      return !!transport?.isConnected;
    }
    return this.connectedPeersCache.has(peerId);
  }

  private async sendToPeerTransport(peerId: PeerId, message: AbjectMessage): Promise<void> {
    if (this.peerRegistryRef) {
      const transport = this.peerRegistryRef.getTransportForPeer(peerId);
      if (transport?.isConnected) {
        await transport.send(message);
      }
      return;
    }
    if (this.p2pBridge) {
      this.p2pBridge.sendCustom({ type: 'send-to-peer', peerId: peerId as string, message });
    }
  }

  // ==========================================================================
  // Wire request tracking
  //
  // A request handed to a peer's transport is on its own until that peer
  // answers. If the peer is offline, drops mid-flight, or simply never replies,
  // the caller would otherwise sit out its full 30s request timeout and then
  // report a generic failure. Tracking the message here lets us answer the
  // caller with a specific error the moment we know no reply is coming.
  // ==========================================================================

  /**
   * Put a message on a peer's wire verbatim, bypassing the route table. The
   * caller names the peer, so this is the escape hatch for a delivery the
   * routing table cannot express. Nothing is re-sent onto the local bus, and
   * the recipient's own reply travels straight back to the original sender.
   *
   * No in-tree caller remains now that remote ids route natively through
   * `intercept()`; it stays as the bus-reachable `forwardToPeer` method.
   */
  private async forwardToPeerImpl(
    peerId: PeerId, message: AbjectMessage, expectReply: boolean,
  ): Promise<boolean> {
    if (!this.isPeerConnected(peerId)) {
      this.failWireRequest(message, 'PEER_OFFLINE', `Peer ${peerId.slice(0, 16)} is not connected`);
      return false;
    }

    if (expectReply) this.trackWireRequest(peerId, message);

    try {
      await this.sendToPeerTransport(peerId, message);
      return true;
    } catch (err) {
      this.clearWireRequest(message.header.messageId);
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`forwardToPeer ${peerId.slice(0, 16)} failed: ${reason}`);
      this.failWireRequest(message, 'PEER_SEND_FAILED',
        `Send to peer ${peerId.slice(0, 16)} failed: ${reason}`);
      return false;
    }
  }

  private trackWireRequest(peerId: PeerId, message: AbjectMessage): void {
    const messageId = message.header.messageId;
    this.clearWireRequest(messageId);

    const timer = setTimeout(() => {
      this.pendingWireRequests.delete(messageId);
      log.warn(`wire request ${messageId.slice(0, 8)} to ${peerId.slice(0, 16)} timed out`);
      this.failWireRequest(message, 'PEER_REQUEST_TIMEOUT',
        `No reply from peer ${peerId.slice(0, 16)} within ${this.wireRequestTimeoutMs}ms`);
    }, this.wireRequestTimeoutMs);
    // Housekeeping only — must never hold a Node process open on its own.
    (timer as unknown as { unref?: () => void }).unref?.();

    this.pendingWireRequests.set(messageId, { peerId, request: message, timer });
  }

  /** Settle a tracked request. True if one really was in flight. */
  private clearWireRequest(messageId: string): boolean {
    const entry = this.pendingWireRequests.get(messageId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingWireRequests.delete(messageId);
    return true;
  }

  /** Fail every request still in flight to a peer that has gone away. */
  private failWireRequestsForPeer(peerId: PeerId, code: string, reason: string): number {
    let failed = 0;
    for (const [messageId, entry] of Array.from(this.pendingWireRequests.entries())) {
      if (entry.peerId !== peerId) continue;
      clearTimeout(entry.timer);
      this.pendingWireRequests.delete(messageId);
      this.failWireRequest(entry.request, code, reason);
      failed++;
    }
    return failed;
  }

  /**
   * Synthesize the reply the peer will never send. `createError` addresses it
   * back to the original caller with the original messageId as correlationId,
   * so the caller's pending promise rejects now instead of at its own timeout.
   */
  private failWireRequest(message: AbjectMessage, code: string, text: string): void {
    if (message.header.type !== 'request') return;
    try {
      this._messageBus?.send(createError(message, code, text));
    } catch (err) {
      log.error('Failed to deliver synthesized wire error:', err);
    }
  }

  /** Correlation id of a reply/error, read defensively — it rides the wire. */
  private correlationOf(message: AbjectMessage): string | undefined {
    return (message.header as unknown as { correlationId?: string }).correlationId;
  }

  /** Note which peer a locally-delivered request came from, so its reply can go home. */
  private rememberInboundOrigin(messageId: string, peerId: PeerId): void {
    if (this.inboundRequestOrigins.size > 512) {
      const now = Date.now();
      for (const [id, entry] of Array.from(this.inboundRequestOrigins.entries())) {
        if (entry.expiresAt <= now) this.inboundRequestOrigins.delete(id);
      }
    }
    this.inboundRequestOrigins.set(messageId, {
      peerId, expiresAt: Date.now() + this.inboundOriginTtlMs,
    });
  }

  private getConnectedPeersList(): PeerId[] {
    if (this.peerRegistryRef) {
      return this.peerRegistryRef.getConnectedPeers();
    }
    return Array.from(this.connectedPeersCache);
  }

  private getLocalPeer(): PeerId {
    if (this.peerRegistryRef) {
      return this.peerRegistryRef.getLocalPeerId();
    }
    return this.localPeerIdCache ?? '' as PeerId;
  }

  /** Whether P2P is available at all (either direct or bridged). */
  private get hasPeerAccess(): boolean {
    return !!(this.peerRegistryRef || this.p2pBridge);
  }

  /**
   * Mark a system object as accessible to remote peers (direct method, for bootstrap).
   *
   * P2-2: only the well-known signaling/routing objects in
   * SIGNALING_SYSTEM_OBJECTS may be admitted, and only for their declared
   * method set. Any other object is refused outright — the bypass set is not a
   * general-purpose escape hatch from workspace curation.
   */
  allowSystemObjectDirect(objectId: AbjectId, wellKnownId?: AbjectId, typeId?: TypeId): void {
    const methods = wellKnownId ? SIGNALING_SYSTEM_OBJECTS.get(wellKnownId as string) : undefined;
    if (!methods) {
      log.info(`REFUSED system-object admission for ${String(wellKnownId ?? objectId)} — not a well-known signaling/routing object`);
      return;
    }
    this.allowedSystemObjects.set(objectId, methods);
    if (wellKnownId) {
      this.wellKnownAliases.set(wellKnownId, objectId);
    }
    if (typeId) {
      this.typeIdToLocal.set(typeId, objectId);
    }
  }

  // ==========================================================================
  // Handlers
  // ==========================================================================

  private setupHandlers(): void {
    this.on('registerRoute', async (msg: AbjectMessage) => {
      const { objectId, peerId, hops } = msg.payload as {
        objectId: string; peerId: string; hops?: number;
      };
      return this.registerSystemRoute(objectId as AbjectId, peerId, hops ?? 0);
    });

    this.on('removeRoute', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.removeSystemRoute(objectId as AbjectId);
    });

    this.on('clearRoutesForPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.clearRoutesForPeerImpl(peerId);
    });

    // P2-2: the bus-reachable `allowSystemObject` handler is REMOVED. It let
    // any sender widen the curation bypass to an arbitrary object id and had
    // zero callers. Bootstrap uses allowSystemObjectDirect(), which admits only
    // the well-known signaling/routing objects.

    // Explicit hand-off of a message bound for an object on a NAMED peer.
    // This resolves as soon as the transport accepts the message: the remote
    // object's own reply travels straight back to the original caller, never
    // through this reply. Ordinary sends to a remote object do not come
    // through here — intercept() captures them and routes from the table.
    this.on('forwardToPeer', async (msg: AbjectMessage) => {
      const { peerId, message, expectReply } = msg.payload as {
        peerId: string; message: AbjectMessage; expectReply?: boolean;
      };
      precondition(!!peerId, 'peerId is required');
      precondition(!!message, 'message is required');
      return this.forwardToPeerImpl(
        peerId as PeerId,
        message,
        expectReply ?? (message.header.type === 'request'),
      );
    });

    this.on('getRoutes', async () => {
      return this.getRoutesImpl();
    });

    this.on('announceRoutes', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.announceRoutesToPeer(peerId);
    });

    this.on('handleRouteAnnouncement', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        type?: 'full' | 'diff';
        // Phase 2: full or diff format
        workspaceRoutes?: Array<{
          ownerPeerId: string; workspaceId: string; hops: number;
          accessMode: string; registryId: string;
          exposedNames?: string[]; exposedObjectIds?: string[];
          wellKnownId?: string; typeId?: string;
        }>;
        added?: Array<{
          ownerPeerId: string; workspaceId: string; hops: number;
          accessMode: string; registryId: string;
          exposedNames?: string[]; exposedObjectIds?: string[];
        }>;
        removed?: string[]; // workspaceKeys
        version?: number;
        propagationId?: string;
        hopsRemaining?: number;
        // Legacy format (backward compat)
        routes?: Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }>;
        fromPeerId: string;
        // System routes always included
        systemRoutes?: Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }>;
      };
      return this.handleRouteAnnouncementImpl(payload);
    });

    this.on('resolveRemoteObject', async (msg: AbjectMessage) => {
      const { peerId, wellKnownId } = msg.payload as { peerId: string; wellKnownId: string };
      const key = `${peerId}:${wellKnownId}`;
      const result = this.remoteWellKnown.get(key) ?? null;
      log.info(`resolveRemoteObject key="${key.slice(0, 50)}" → ${result ? result.slice(0, 8) : 'null'} (map size=${this.remoteWellKnown.size})`);
      return result;
    });

    this.on('resolveWorkspaceRegistry', async (msg: AbjectMessage) => {
      const { ownerPeerId, workspaceId } = msg.payload as { ownerPeerId: string; workspaceId: string };
      const wsKey = `${ownerPeerId}/${workspaceId}`;
      const wsRoute = this.workspaceRoutes.get(wsKey);
      if (wsRoute && Date.now() < wsRoute.ttl) {
        return wsRoute.registryId;
      }
      return null;
    });


    this.on('handleRouteDigest', async (msg: AbjectMessage) => {
      const { digest, fromPeerId } = msg.payload as {
        digest: Array<{ workspaceKey: string; version: number }>;
        fromPeerId: string;
      };
      return this.handleRouteDigest(digest, fromPeerId as PeerId);
    });

    // Listen for events from PeerRegistry and WorkspaceManager
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };

      // PeerRegistry: new peer connected — announce routes immediately
      if (aspect === 'contactConnected') {
        const { peerId } = value as { peerId: string };
        log.info(`contactConnected event for ${peerId.slice(0, 16)}, announcing routes`);
        this.announceRoutesToPeer(peerId as PeerId).catch(() => { /* best-effort */ });
        return;
      }

      if (aspect === 'contactDisconnected') {
        const { peerId } = value as { peerId: string };
        log.info(`contactDisconnected event for ${peerId.slice(0, 16)}, clearing routes`);
        this.clearRoutesForPeerImpl(peerId as PeerId);
        return;
      }

      if (aspect === 'workspaceAccessChanged' || aspect === 'workspaceShared' ||
          aspect === 'workspaceUnshared' || aspect === 'workspaceObjectsChanged') {
        // Invalidate permission cache
        this.permissionCache.clear();
        // Re-announce routes to all connected peers
        this.announceRoutesToAll().catch(() => { /* best-effort */ });
      }
    });
  }

  protected override async onInit(): Promise<void> {
    log.info('onInit starting');

    // Allow inbound messages addressed to PeerRouter itself (route announcements)
    this.allowedSystemObjects.set(this.id, PEER_ROUTER_REMOTE_METHODS);

    this.peerRegistryId = (await this.discoverDep('PeerRegistry')) ?? undefined;
    this.workspaceManagerId = (await this.discoverDep('WorkspaceManager')) ?? undefined;
    log.info(`onInit deps: peerRegistryId=${!!this.peerRegistryId} workspaceManagerId=${!!this.workspaceManagerId}`);

    // Subscribe to PeerRegistry events (contactConnected triggers route announcement)
    if (this.peerRegistryId) {
      try {
        await this.request(
          createRequest(this.id, this.peerRegistryId, 'addDependent', {}),
        );
        log.info('subscribed to PeerRegistry events');
      } catch { /* PeerRegistry may not support addDependent yet */ }
    }

    // Subscribe to WorkspaceManager events for cache invalidation
    if (this.workspaceManagerId) {
      try {
        await this.request(
          createRequest(this.id, this.workspaceManagerId, 'addDependent', {}),
        );
      } catch { /* WorkspaceManager may not be ready yet */ }
    }

    // Phase 3: Anti-entropy replaces periodic full announcements.
    // Every ~30-45s (with jitter), pick ONE random peer and exchange route digests.
    this.scheduleAntiEntropy();

    // Phase 3: Clean up expired propagation IDs
    this.propagationCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, expiry] of this.seenPropagations) {
        if (now > expiry) this.seenPropagations.delete(id);
      }
    }, PROPAGATION_EXPIRY);

    log.info('onInit complete, anti-entropy timer started (60s)');

    // Catch peers that connected before setPeerRegistry was called
    setTimeout(() => {
      this.announceRoutesToAll().catch(() => {});
    }, 10000);
  }

  private scheduleAntiEntropy(): void {
    if (this.announceTimer) return;
    const delay = ANNOUNCE_INTERVAL + Math.floor(Math.random() * ANNOUNCE_JITTER);
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      this.antiEntropyExchange().catch(() => { /* best-effort */ });
      this.scheduleAntiEntropy(); // schedule next round
    }, delay);
  }

  protected override async onStop(): Promise<void> {
    for (const entry of this.pendingWireRequests.values()) clearTimeout(entry.timer);
    this.pendingWireRequests.clear();
    this.inboundRequestOrigins.clear();

    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = undefined;
    }
    if (this.propagationCleanupTimer) {
      clearInterval(this.propagationCleanupTimer);
      this.propagationCleanupTimer = undefined;
    }
  }

  // ==========================================================================
  // MessageInterceptor — outbound routing
  // ==========================================================================

  /**
   * Called by MessageBus for every outgoing message.
   * If the recipient is a known remote object, forward via transport.
   * All routing is done via UUID lookup in the routing table.
   */
  intercept(message: AbjectMessage): 'pass' | 'drop' | AbjectMessage {
    const recipient = message.routing.to;

    if (!this.hasPeerAccess) {
      return 'pass';
    }

    // A reply correlated to a request that arrived from a peer belongs on the
    // wire back to that peer. The remote caller's id holds no local mailbox
    // and usually no announced route, so neither check below could place this
    // reply anywhere. Correlation is what carries it home, and it runs first
    // so a reply always reaches the peer that asked, whatever the id resolves to.
    if (message.header.type === 'reply' || message.header.type === 'error') {
      const correlated = this.correlationOf(message);
      const origin = correlated ? this.inboundRequestOrigins.get(correlated) : undefined;
      if (correlated && origin) {
        this.inboundRequestOrigins.delete(correlated);
        if (this.isPeerConnected(origin.peerId)) {
          this.sendToPeerTransport(origin.peerId, this.filterOutboundReply(message)).catch((err) => {
            log.error(`Failed to return reply to peer ${origin.peerId.slice(0, 16)}:`, err);
          });
          return 'drop';
        }
      }
    }

    // If the recipient is registered locally, always deliver locally —
    // never route a local object's messages to a remote peer. No stand-in is
    // ever mounted for a peer's object, so this predicate means strictly
    // "lives here": a pooled remote id matches nothing and falls through to
    // the route table below, which is how remote sends reach their owner.
    if (this._messageBus?.isRegistered(recipient)) {
      return 'pass';
    }

    // Look up route in routing table
    const route = this.getRoute(recipient);
    if (!route) {
      // No explicit route. Speculative forwarding is a best-effort GUESS at
      // which connected peer holds the recipient. For fire-and-forget events
      // that's fine (a wrong guess just loses the event). For a REQUEST a wrong
      // guess is harmful: the guessed peer doesn't have the object, doesn't
      // reply, and the caller hangs to the full request timeout (~30s) — the
      // exact symptom when a request targets a stale/destroyed LOCAL id. So we
      // do NOT speculate on requests; we fall through to 'pass' and let the
      // bus's local fail-fast answer RECIPIENT_NOT_FOUND instantly. Genuine
      // cross-peer calls to exposed objects have an ANNOUNCED explicit route
      // (handled above), so they are unaffected.
      if (message.header.type === 'request') {
        return 'pass';
      }
      const specPeer = this.speculateNextHop(message.routing.from as AbjectId, recipient);
      if (specPeer && this.isPeerConnected(specPeer)) {
        const outMsg = this.filterOutboundReply(message);
        // Fire-and-forget: transport send is async but bus must not block
        this.sendToPeerTransport(specPeer, outMsg).catch(() => { /* best-effort */ });
        this.trackOutboundConnection(
          message.routing.from as AbjectId, specPeer, message.routing.to as AbjectId,
        );
        return 'drop';
      }
      return 'pass'; // Local delivery
    }

    if (!this.isPeerConnected(route.nextHop)) {
      log.warn(`Cannot route to ${recipient.slice(0, 8)}: peer ${route.nextHop.slice(0, 16)} not connected`);
      if (message.header.type === 'request') {
        // We hold the ONLY route to this object and it runs through a peer that
        // is offline, so no local delivery can succeed either. Fail the caller
        // now rather than let it hang for its full timeout. Deferred to a
        // microtask so we never re-enter the bus from inside interception.
        const offlinePeer = route.nextHop;
        queueMicrotask(() => this.failWireRequest(message, 'PEER_OFFLINE',
          `Peer ${offlinePeer.slice(0, 16)} owning ${recipient.slice(0, 8)} is offline`));
        return 'drop';
      }
      return 'pass'; // Fall through to normal undeliverable handling
    }

    // Filter list replies to enforce exposed-objects policy
    const outMsg = this.filterOutboundReply(message);
    // Fire-and-forget: transport send is async but bus must not block
    this.sendToPeerTransport(route.nextHop, outMsg).catch((err) => {
      log.error(`Failed to forward message to peer ${route.nextHop.slice(0, 16)}:`, err);
    });
    // NAT-like: record that this local object talked to this peer
    this.trackOutboundConnection(
      message.routing.from as AbjectId, route.nextHop, message.routing.to as AbjectId,
    );
    return 'drop'; // We handled delivery
  }

  /**
   * Speculative next-hop: when no explicit route exists, guess the peer.
   * Tier 1: connTrack — sender previously talked to a peer, recipient likely lives there.
   * Tier 2: registryOwnerHints — recipient matches a previously-seen registryId/objectId.
   * Tier 3: Exactly one connected peer — forward to them (no ambiguity).
   * No system routes are cached for speculative forwards.
   */
  private speculateNextHop(senderId: AbjectId, recipientId: AbjectId): PeerId | undefined {
    if (!this.hasPeerAccess) return undefined;
    const now = Date.now();

    // Tier 1: connTrack — sender previously talked to a peer
    const senderPeers = this.connTrack.get(senderId);
    if (senderPeers) {
      let bestPeer: PeerId | undefined;
      let bestExpiry = 0;
      for (const [peerId, expiry] of senderPeers) {
        if (now < expiry && expiry > bestExpiry) {
          if (this.isPeerConnected(peerId)) {
            bestPeer = peerId;
            bestExpiry = expiry;
          }
        }
      }
      if (bestPeer) return bestPeer;
    }

    // Tier 2: registryOwnerHints — recipient matches a known registryId/objectId
    const hintPeer = this.registryOwnerHints.get(recipientId);
    if (hintPeer && this.isPeerConnected(hintPeer)) {
      return hintPeer;
    }

    // Tier 3: Exactly one connected peer
    const connected = this.getConnectedPeersList();
    if (connected.length === 1) return connected[0];

    return undefined;
  }

  /**
   * Filter outbound reply messages to only include exposed objects.
   * Prevents Registry `list` replies from leaking non-exposed object IDs.
   */
  private filterOutboundReply(msg: AbjectMessage): AbjectMessage {
    if (msg.header.type !== 'reply' || msg.routing.method !== 'list') return msg;
    if (!Array.isArray(msg.payload)) return msg;

    const cached = this.permissionCache.get(msg.routing.from as AbjectId);
    if (!cached) return msg;  // No cache entry — pass through (will be caught by other checks)
    if (cached.exposedObjectIds.length === 0) return { ...msg, payload: [] };  // Nothing exposed

    const allowed = new Set(cached.exposedObjectIds);
    const filtered = (msg.payload as Array<{ id: string }>)
      .filter(item => allowed.has(item.id as AbjectId));

    return { ...msg, payload: filtered };
  }

  /**
   * Record that a local object sent a message to a remote peer.
   * Enables NAT-like return path: the peer can send back to this object.
   */
  private trackOutboundConnection(
    localObjectId: AbjectId, remotePeerId: PeerId, remoteObjectId?: AbjectId,
  ): void {
    let peers = this.connTrack.get(localObjectId);
    if (!peers) {
      peers = new Map();
      this.connTrack.set(localObjectId, peers);
    }
    peers.set(remotePeerId, Date.now() + ROUTE_TTL);
    // P2-2: remember the exact pair for the inbound return path.
    if (remoteObjectId) {
      this.connTrackPairs.set(
        `${localObjectId}|${remotePeerId}|${remoteObjectId}`,
        Date.now() + ROUTE_TTL,
      );
    }
  }

  // ==========================================================================
  // Inbound message handling
  // ==========================================================================

  /**
   * Handle a message received from a remote peer.
   * Called by PeerRegistry when a message arrives via transport.
   */
  handleIncomingMessage(msg: AbjectMessage, fromPeerId: PeerId): void {
    // Rate limit: drop messages from peers that exceed the token bucket
    if (!this.consumeRateLimitToken(fromPeerId)) {
      log.warn(`RATE_LIMITED: dropping message from ${fromPeerId.slice(0, 16)}`);
      if (msg.header.type === 'request') {
        const errMsg = createError(msg, 'RATE_LIMITED', 'Too many messages — slow down');
        this.sendToPeerTransport(fromPeerId, errMsg).catch(() => { /* best-effort */ });
      }
      return;
    }

    // Record sender's route for reply routing — but ONLY for requests/events.
    // For reply/error messages, msg.routing.from is the TARGET of the original
    // request (e.g. the remote registry), NOT the actual peer that generated it.
    // Recording it would create a bogus systemRoute that shadows the correct
    // workspace route, causing a routing loop.
    //
    // Also skip if the sender ID is registered locally — a remote SharedState
    // (or similar P2P object) may share the same well-known pattern but have a
    // different UUID. If a local object exists with this ID, creating a remote
    // route would shadow it, causing local messages to be mis-routed to the
    // remote peer.
    if (msg.header.type === 'request' || msg.header.type === 'event') {
      const senderId = msg.routing.from;
      if (!this._messageBus?.isRegistered(senderId as AbjectId)) {
        this.systemRoutes.set(senderId as AbjectId, {
          nextHop: fromPeerId,
          hops: 0,
          ttl: Date.now() + ROUTE_TTL,
        });
      }
    }

    // A reply/error off the wire settles whatever outbound request it
    // correlates to, so that request's timeout must not fire afterwards.
    if (msg.header.type === 'reply' || msg.header.type === 'error') {
      const correlated = this.correlationOf(msg);
      if (correlated) this.clearWireRequest(correlated);
    }

    let targetId = msg.routing.to;
    log.info(`inbound: to=${msg.routing.to.slice(0, 20)} from=${msg.routing.from.slice(0, 8)} type=${msg.header.type} method=${msg.routing.method ?? '?'}`);

    // Messages addressed to PEER_ROUTER_ID are for this PeerRouter itself
    if (targetId === PEER_ROUTER_ID) {
      targetId = this.id;
      msg = { ...msg, routing: { ...msg.routing, to: this.id } };
      log.info('self-addressed, resolved to ' + this.id.slice(0, 8));
    }

    // Resolve typeId to local AbjectId
    const typeResolved = this.typeIdToLocal.get(targetId as TypeId);
    if (typeResolved) {
      targetId = typeResolved;
      msg = { ...msg, routing: { ...msg.routing, to: typeResolved } };
      log.info('typeId resolved: ' + targetId.slice(0, 8));
    }

    // Resolve well-known alias to actual registered UUID
    const resolvedId = this.wellKnownAliases.get(targetId);
    if (resolvedId) {
      targetId = resolvedId;
      msg = { ...msg, routing: { ...msg.routing, to: resolvedId } };
      log.info('alias resolved: ' + targetId.slice(0, 8));
    }

    // Check if target is registered locally on the bus
    const isReg = this._messageBus?.isRegistered(targetId) ?? false;
    const isReply = msg.header.type === 'reply' || msg.header.type === 'error';
    const permOk = isReg
      ? (isReply || this.checkInboundPermission(targetId, fromPeerId, msg.routing.from as AbjectId, msg.routing.method))
      : false;
    log.info(`isRegistered=${isReg} permissionOk=${permOk}`);

    if (this._messageBus && isReg) {
      // This peer is the destination — check permissions
      if (!permOk) {
        // Distinguish cache miss (no entry or expired) from explicit deny
        const cached = this.permissionCache.get(targetId);
        const isCacheMiss = !cached || (Date.now() - cached.cachedAt >= PERMISSION_CACHE_TTL);

        if (isCacheMiss && !isReply) {
          // Cache miss on a request or event: defer decision until async refresh completes
          log.info(`permission cache miss for ${targetId.slice(0, 8)}, deferring check`);
          this.deferPermissionCheck(msg, targetId, fromPeerId);
          return;
        }

        // Explicit deny from cache, or non-request message type
        log.warn(`ACCESS_DENIED: ${fromPeerId.slice(0, 16)} → ${targetId.slice(0, 8)}`);
        if (msg.header.type === 'request') {
          const errMsg = createError(msg, 'ACCESS_DENIED', `Access denied to object ${targetId}`);
          this.sendToPeerTransport(fromPeerId, errMsg).catch(() => { /* best-effort */ });
        }
        return;
      }

      // Remember where this request came from. The local reply is addressed
      // to the caller's AbjectId, which lives on the remote peer's bus; a
      // caller is not an announced object, so it may have no route entry of
      // its own. This messageId correlation is the only thing that says the
      // reply belongs on the wire back to this peer.
      if (msg.header.type === 'request') {
        this.rememberInboundOrigin(msg.header.messageId, fromPeerId);
      }

      // Inject into local bus
      try {
        this._messageBus.send(msg);
      } catch (err) {
        log.error('Failed to inject remote message:', err);
      }
      return;
    }

    // Check if target is in routing table pointing to a different peer (relay)
    const route = this.getRoute(targetId);
    if (route && route.nextHop !== fromPeerId && this.isPeerConnected(route.nextHop)) {
      this.sendToPeerTransport(route.nextHop, msg).catch((err) => {
        log.error(`Failed to relay message via ${route.nextHop.slice(0, 16)}:`, err);
      });
      return;
    }

    // Undeliverable — send error reply back via transport for requests.
    // Do NOT fall back to _messageBus.send() here: the message already came
    // from a remote peer and has no local recipient. Putting it on the bus
    // would run through the interceptor, which may find a stale systemRoute
    // and bounce the message back to the originating peer, creating a loop.
    log.info('UNDELIVERABLE for ' + targetId.slice(0, 20));
    if (msg.header.type === 'request') {
      const errMsg = createError(msg, 'RECIPIENT_NOT_FOUND',
        `Remote object ${targetId} is not available on this peer`);
      this.sendToPeerTransport(fromPeerId, errMsg).catch(() => { /* best-effort */ });
    }
  }

  // ==========================================================================
  // Permission checking
  // ==========================================================================

  /**
   * Check if an inbound message from a remote peer is allowed to reach the target.
   * Synchronous and FAIL-CLOSED (P2-2): a conntrack hit no longer grants blanket
   * access — it is scoped to the exact (peer, object) pair that initiated and
   * curation is re-checked on every reuse. A permission-cache miss returns
   * false; the caller resolves it and denies unless curation explicitly allows.
   */
  private checkInboundPermission(
    targetId: AbjectId, fromPeerId: PeerId, fromObjectId?: AbjectId, method?: string,
  ): boolean {
    // System objects explicitly allowed (minimal set: signaling/routing only).
    // P2-2: the bypass is scoped to that object's declared signaling/routing
    // methods — any other method to the same object still goes through the
    // curation check below, so it cannot act as a universal proxy.
    const allowedMethods = this.allowedSystemObjects.get(targetId);
    if (allowedMethods && method !== undefined && allowedMethods.has(method)) {
      return true;
    }

    // P2-2: expire the pair entry if stale; a live pair is only a routing hint
    // and still must pass the curation check below.
    if (fromObjectId) {
      const pairKey = `${targetId}|${fromPeerId}|${fromObjectId}`;
      const pairExpiry = this.connTrackPairs.get(pairKey);
      if (pairExpiry !== undefined && Date.now() >= pairExpiry) this.connTrackPairs.delete(pairKey);
    }

    // Prune the coarse (routing-only) table so it does not grow unbounded.
    const trackedPeers = this.connTrack.get(targetId);
    if (trackedPeers) {
      const expiry = trackedPeers.get(fromPeerId);
      if (expiry !== undefined && Date.now() >= expiry) trackedPeers.delete(fromPeerId);
      if (trackedPeers.size === 0) this.connTrack.delete(targetId);
    }

    // Curation check — required for BOTH fresh and return traffic.
    const cached = this.permissionCache.get(targetId);
    if (cached && Date.now() - cached.cachedAt < PERMISSION_CACHE_TTL) {
      return this.evaluatePermission(cached, fromPeerId, targetId);
    }

    // No usable cache: fail closed. The caller resolves the curation state and
    // delivers only if it then explicitly allows this peer.
    return false;
  }

  /**
   * Cache-miss resolution (P2-2). Resolves the curation state for the target
   * and delivers ONLY if the freshly resolved curation allows this peer. Any
   * failure to resolve — WorkspaceManager unreachable, no workspace, empty
   * curation — denies. Nothing is delivered on an unresolved permission.
   */
  private async deferPermissionCheck(
    msg: AbjectMessage, targetId: AbjectId, fromPeerId: PeerId,
  ): Promise<void> {
    try {
      await this.refreshPermissionCache(targetId);
      const cached = this.permissionCache.get(targetId);
      if (cached && this.evaluatePermission(cached, fromPeerId, targetId)) {
        log.info(`deferred permission ALLOWED: ${fromPeerId.slice(0, 16)} → ${targetId.slice(0, 8)}`);
        if (msg.header.type === 'request') {
          this.rememberInboundOrigin(msg.header.messageId, fromPeerId);
        }
        this._messageBus?.send(msg);
        return;
      }
    } catch { /* refresh failed — fail closed below */ }

    log.warn(`ACCESS_DENIED (unresolved curation): ${fromPeerId.slice(0, 16)} → ${targetId.slice(0, 8)}`);
    if (msg.header.type === 'request') {
      const errMsg = createError(msg, 'ACCESS_DENIED', `Access denied to object ${targetId}`);
      this.sendToPeerTransport(fromPeerId, errMsg).catch(() => { /* best-effort */ });
    }
  }

  private evaluatePermission(entry: PermissionCacheEntry, fromPeerId: PeerId, targetId?: AbjectId): boolean {
    // First gate: access mode check
    let accessAllowed: boolean;
    switch (entry.accessMode) {
      case 'public':
        accessAllowed = true;
        break;
      case 'shared':
        accessAllowed = entry.whitelist.includes(fromPeerId);
        break;
      case 'local':
        // Genuinely private, and a hard deny. A joined mirror does NOT reach
        // this case: it is advertised as 'local' but reports its PARTICIPATION
        // access through WorkspaceManager.findWorkspaceForObject ('shared' +
        // owner/participants), so the case above admits exactly the workspace's
        // own members and nobody else.
        return false;
      default:
        return false;
    }
    if (!accessAllowed) return false;

    // Second gate: curation check, keyed on the durable selectors of P1-2
    // (id OR typeId OR registered name) so a restart's fresh AbjectIds do not
    // silently widen or narrow what a peer may reach.
    const curatedAnything =
      entry.exposedObjectIds.length > 0 ||
      entry.exposedTypeIds.length > 0 ||
      entry.exposedNames.length > 0;
    if (!curatedAnything) {
      return false; // Nothing curated — deny remote access (P2-3 default)
    }
    if (targetId) {
      if (entry.exposedObjectIds.includes(targetId)) return true;
      const key = targetId as unknown as string;
      return entry.exposedTypeIds.includes(key) || entry.exposedNames.includes(key);
    }
    return true;
  }

  /**
   * Async refresh of permission cache for an object.
   */
  private async refreshPermissionCache(targetId: AbjectId): Promise<void> {
    if (!this.workspaceManagerId) return;

    try {
      const result = await this.request<{
        workspaceId: string;
        accessMode: WorkspaceAccessMode;
        whitelist: string[];
        exposedObjectIds: string[];
        exposedTypeIds?: string[];
        exposedNames?: string[];
      } | null>(
        createRequest(
          this.id, this.workspaceManagerId,
          'findWorkspaceForObject', { objectId: targetId },
        ),
      );

      if (result) {
        this.permissionCache.set(targetId, {
          workspaceId: result.workspaceId,
          accessMode: result.accessMode,
          whitelist: result.whitelist,
          exposedObjectIds: (result.exposedObjectIds ?? []) as AbjectId[],
          exposedTypeIds: result.exposedTypeIds ?? [],
          exposedNames: result.exposedNames ?? [],
          cachedAt: Date.now(),
        });
      } else {
        // Not in any workspace — treat as local (deny)
        this.permissionCache.set(targetId, {
          workspaceId: '',
          accessMode: 'local',
          whitelist: [],
          exposedObjectIds: [],
          exposedTypeIds: [],
          exposedNames: [],
          cachedAt: Date.now(),
        });
      }
    } catch {
      // WorkspaceManager not ready — will retry on next message
    }
  }

  // ==========================================================================
  // Route management — Phase 1: Workspace-level + system object routes
  // ==========================================================================

  /**
   * Register a system-object route (per-object, not workspace-level).
   */
  private registerSystemRoute(objectId: AbjectId, peerId: PeerId, hops: number): boolean {
    const existing = this.systemRoutes.get(objectId);
    if (existing && existing.hops <= hops && Date.now() < existing.ttl) {
      return false;
    }
    this.systemRoutes.set(objectId, {
      nextHop: peerId,
      hops,
      ttl: Date.now() + ROUTE_TTL,
    });
    return true;
  }

  private removeSystemRoute(objectId: AbjectId): boolean {
    // Try system routes first
    if (this.systemRoutes.delete(objectId)) return true;
    // Also remove from objectToWorkspace cache
    this.objectToWorkspace.delete(objectId);
    return false;
  }

  private clearRoutesForPeerImpl(peerId: PeerId): number {
    // The peer is gone: nothing we handed to its wire will ever be answered.
    // Fail those callers now instead of leaving each to its own timeout.
    const failedInFlight = this.failWireRequestsForPeer(peerId, 'PEER_DISCONNECTED',
      `Peer ${peerId.slice(0, 16)} disconnected before replying`);
    if (failedInFlight > 0) {
      log.warn(`failed ${failedInFlight} in-flight request(s) to ${peerId.slice(0, 16)}`);
    }
    for (const [messageId, entry] of Array.from(this.inboundRequestOrigins.entries())) {
      if (entry.peerId === peerId) this.inboundRequestOrigins.delete(messageId);
    }

    let count = 0;

    // Clear system routes
    for (const [objectId, entry] of this.systemRoutes) {
      if (entry.nextHop === peerId) {
        this.systemRoutes.delete(objectId);
        count++;
      }
    }

    // Clear workspace routes and record changes
    for (const [wsKey, route] of this.workspaceRoutes) {
      if (route.nextHop === peerId) {
        this.workspaceRoutes.delete(wsKey);
        this.recordRouteChange('remove', wsKey);
        count++;
      }
    }

    // Clear objectToWorkspace cache entries pointing to removed workspaces
    for (const [objId, wsKey] of this.objectToWorkspace) {
      if (!this.workspaceRoutes.has(wsKey)) {
        this.objectToWorkspace.delete(objId);
      }
    }

    // Clean up connection tracking entries for this peer
    for (const [objId, peers] of this.connTrack) {
      peers.delete(peerId as PeerId);
      if (peers.size === 0) this.connTrack.delete(objId);
    }
    // Clean up well-known and typeId mappings for this peer
    for (const key of this.remoteWellKnown.keys()) {
      if (key.startsWith(`${peerId}:`)) {
        this.remoteWellKnown.delete(key);
      }
    }
    // Clean up announcement state
    this.peerAnnounceState.delete(peerId as PeerId);
    // Clean up rate limit bucket
    this.rateLimitBuckets.delete(peerId as PeerId);

    return count;
  }

  /**
   * Token bucket rate limiter. Returns true if a token was consumed, false if exhausted.
   */
  private consumeRateLimitToken(peerId: PeerId): boolean {
    const now = Date.now();
    let bucket = this.rateLimitBuckets.get(peerId);
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
      this.rateLimitBuckets.set(peerId, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000; // seconds
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsed * RATE_LIMIT_REFILL);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Phase 1: Unified route lookup.
   * 1. Check system routes (per-object, ~20 entries)
   * 2. Check objectToWorkspace cache (populated on first resolve)
   * 3. On miss, search workspace routes by exposed object IDs
   */
  private getRoute(objectId: AbjectId): RouteEntry | undefined {
    const now = Date.now();

    // 1. System routes (per-object, for system objects + reply paths)
    const sysRoute = this.systemRoutes.get(objectId);
    if (sysRoute) {
      if (now > sysRoute.ttl) {
        // TTL expired — renew if the peer is still connected (avoids gap
        // between anti-entropy announcements and the 5-minute TTL).
        if (this.isPeerConnected(sysRoute.nextHop)) {
          sysRoute.ttl = now + ROUTE_TTL;
          return sysRoute;
        }
        this.systemRoutes.delete(objectId);
      } else {
        return sysRoute;
      }
    }

    // 2. objectToWorkspace cache hit
    const cachedWsKey = this.objectToWorkspace.get(objectId);
    if (cachedWsKey) {
      const wsRoute = this.workspaceRoutes.get(cachedWsKey);
      if (wsRoute) {
        if (now > wsRoute.ttl) {
          // Renew if peer still connected
          const bestHop = this.bestNextHopForWsRoute(wsRoute);
          if (bestHop) {
            wsRoute.ttl = now + ROUTE_TTL;
            return {
              nextHop: bestHop,
              hops: wsRoute.hops,
              ttl: wsRoute.ttl,
            };
          }
          this.objectToWorkspace.delete(objectId);
        } else {
          return {
            nextHop: this.bestNextHopForWsRoute(wsRoute) ?? wsRoute.nextHop,
            hops: wsRoute.hops,
            ttl: wsRoute.ttl,
          };
        }
      } else {
        // Stale cache entry
        this.objectToWorkspace.delete(objectId);
      }
    }

    // 3. Search workspace routes by exposed object IDs
    for (const [wsKey, wsRoute] of this.workspaceRoutes) {
      if (now > wsRoute.ttl) {
        // Renew if peer still connected
        const bestHop = this.bestNextHopForWsRoute(wsRoute);
        if (bestHop) {
          wsRoute.ttl = now + ROUTE_TTL;
        } else {
          this.workspaceRoutes.delete(wsKey);
          continue;
        }
      }
      if (wsRoute.exposedObjectIds.includes(objectId) || wsRoute.registryId === objectId) {
        // Cache the mapping for future lookups
        this.objectToWorkspace.set(objectId, wsKey);
        return {
          nextHop: this.bestNextHopForWsRoute(wsRoute) ?? wsRoute.nextHop,
          hops: wsRoute.hops,
          ttl: wsRoute.ttl,
        };
      }
    }

    return undefined;
  }

  /**
   * For a workspace route, prefer routing directly to ownerPeerId if we're
   * connected to them. Gossipped routes may have nextHop set to the relaying
   * peer rather than the actual owner, so a direct link is always better.
   * Returns the best nextHop, or undefined if no connected peer is available.
   */
  private bestNextHopForWsRoute(wsRoute: WorkspaceRoute): PeerId | undefined {
    if (!this.hasPeerAccess) return undefined;

    // Prefer direct connection to owner
    if (wsRoute.ownerPeerId !== wsRoute.nextHop) {
      if (this.isPeerConnected(wsRoute.ownerPeerId)) {
        return wsRoute.ownerPeerId;
      }
    }

    // Fall back to stored nextHop (relay peer)
    if (this.isPeerConnected(wsRoute.nextHop)) {
      return wsRoute.nextHop;
    }

    return undefined;
  }

  /**
   * Record registryId → ownerPeerId hint from a workspace route.
   * These hints survive beyond workspace route TTL expiry, helping
   * speculative routing when workspace routes haven't propagated yet.
   */
  private recordRegistryOwnerHint(wsRoute: WorkspaceRoute): void {
    this.registryOwnerHints.set(wsRoute.registryId, wsRoute.ownerPeerId);
    for (const objId of wsRoute.exposedObjectIds) {
      this.registryOwnerHints.set(objId, wsRoute.ownerPeerId);
    }
  }

  private getRoutesImpl(): Array<{ objectId: string; nextHop: string; hops: number; ttl: number; workspaceKey?: string }> {
    const now = Date.now();
    const result: Array<{ objectId: string; nextHop: string; hops: number; ttl: number; workspaceKey?: string }> = [];

    // System routes
    for (const [objectId, entry] of this.systemRoutes) {
      if (now < entry.ttl) {
        result.push({
          objectId,
          nextHop: entry.nextHop,
          hops: entry.hops,
          ttl: entry.ttl - now,
        });
      }
    }

    // Workspace routes (one entry per workspace)
    for (const [wsKey, route] of this.workspaceRoutes) {
      if (now < route.ttl) {
        result.push({
          objectId: route.registryId,
          nextHop: route.nextHop,
          hops: route.hops,
          ttl: route.ttl - now,
          workspaceKey: wsKey,
        });
      }
    }

    return result;
  }

  // ==========================================================================
  // Phase 2: Route changelog for incremental diffs
  // ==========================================================================

  private recordRouteChange(type: 'add' | 'remove' | 'update', workspaceKey: string, route?: WorkspaceRoute): void {
    this.routeVersion++;
    this.routeChangelog.push({
      version: this.routeVersion,
      type,
      workspaceKey,
      route,
    });
    // Cap changelog size
    if (this.routeChangelog.length > MAX_CHANGELOG) {
      this.routeChangelog = this.routeChangelog.slice(-MAX_CHANGELOG);
    }
  }

  /**
   * Build a diff since a given version for a peer.
   * Returns null if the changelog doesn't cover the gap (requires full announcement).
   */
  private buildDiffSince(sinceVersion: number): { added: WorkspaceRoute[]; removed: string[] } | null {
    if (this.routeChangelog.length === 0) return null;
    const oldestVersion = this.routeChangelog[0].version;
    if (sinceVersion < oldestVersion) return null; // Gap too large

    const added = new Map<string, WorkspaceRoute>();
    const removed = new Set<string>();

    for (const change of this.routeChangelog) {
      if (change.version <= sinceVersion) continue;
      if (change.type === 'remove') {
        removed.add(change.workspaceKey);
        added.delete(change.workspaceKey);
      } else {
        // add or update
        removed.delete(change.workspaceKey);
        if (change.route) {
          added.set(change.workspaceKey, change.route);
        }
      }
    }

    return {
      added: Array.from(added.values()),
      removed: Array.from(removed),
    };
  }

  // ==========================================================================
  // Route propagation — Phases 1-3
  // ==========================================================================

  /**
   * Announce local routes to a specific peer.
   * Phase 2: Sends diff if possible, full otherwise.
   */
  async announceRoutesToPeer(peerId: PeerId): Promise<boolean> {
    if (!this.hasPeerAccess) {
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — skipped: no peer access`);
      return false;
    }

    if (!this.isPeerConnected(peerId)) {
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — skipped: not connected`);
      return false;
    }

    const localPeerId = this.getLocalPeer();

    // Collect system routes (always sent as full)
    const systemRouteEntries = this.collectSystemRoutesForPeer(peerId);

    // Phase 2: Check if we can send a diff
    const peerState = this.peerAnnounceState.get(peerId);
    const diff = peerState ? this.buildDiffSince(peerState.lastVersion) : null;

    if (diff && peerState) {
      // Send diff
      const wsRoutesForPeer = await this.collectWorkspaceRoutesForPeer(peerId);
      // Filter diff to only include routes appropriate for this peer
      const peerWorkspaceKeys = new Set(wsRoutesForPeer.map(r => `${r.ownerPeerId}/${r.workspaceId}`));
      const filteredAdded = diff.added.filter(r => peerWorkspaceKeys.has(`${r.ownerPeerId}/${r.workspaceId}`));
      const filteredRemoved = diff.removed.filter(k => peerState.announcedRoutes.has(k));

      if (filteredAdded.length === 0 && filteredRemoved.length === 0 && systemRouteEntries.length === 0) {
        return true; // Nothing changed for this peer
      }

      const announcement = createRequest(
        this.id, PEER_ROUTER_ID, 'handleRouteAnnouncement',
        {
          type: 'diff' as const,
          added: filteredAdded.map(r => ({
            ownerPeerId: r.ownerPeerId,
            workspaceId: r.workspaceId,
            hops: r.hops,
            accessMode: r.accessMode,
            registryId: r.registryId,
            exposedNames: r.exposedNames,
            exposedObjectIds: r.exposedObjectIds,
          })),
          removed: filteredRemoved,
          version: this.routeVersion,
          systemRoutes: systemRouteEntries,
          fromPeerId: localPeerId,
        },
      );

      try {
        await this.sendToPeerTransport(peerId, announcement);
        // Update peer state
        for (const r of filteredAdded) {
          peerState.announcedRoutes.add(`${r.ownerPeerId}/${r.workspaceId}`);
        }
        for (const k of filteredRemoved) {
          peerState.announcedRoutes.delete(k);
        }
        peerState.lastVersion = this.routeVersion;
        log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — sent DIFF: +${filteredAdded.length} -${filteredRemoved.length}`);
        return true;
      } catch (err) {
        log.error(`Failed to announce diff to ${peerId.slice(0, 16)}:`, err);
        this.scheduleAnnouncementRetry(peerId);
        return false;
      }
    }

    // Full announcement
    const wsRoutes = await this.collectWorkspaceRoutesForPeer(peerId);

    if (wsRoutes.length === 0 && systemRouteEntries.length === 0) {
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — no routes to announce`);
      return true;
    }

    log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — ${wsRoutes.length} workspace routes, ${systemRouteEntries.length} system routes`);

    // Build legacy routes array for backward compat with old peers
    const legacyRoutes = [...systemRouteEntries];

    const announcement = createRequest(
      this.id, PEER_ROUTER_ID, 'handleRouteAnnouncement',
      {
        type: 'full' as const,
        workspaceRoutes: wsRoutes.map(r => ({
          ownerPeerId: r.ownerPeerId,
          workspaceId: r.workspaceId,
          hops: r.hops,
          accessMode: r.accessMode,
          registryId: r.registryId,
          exposedNames: r.exposedNames,
          exposedObjectIds: r.exposedObjectIds,
        })),
        version: this.routeVersion,
        systemRoutes: systemRouteEntries,
        routes: legacyRoutes,  // backward compat: old peers read this field
        fromPeerId: localPeerId,
      },
    );

    try {
      await this.sendToPeerTransport(peerId, announcement);
      // Update peer announce state
      const announcedRoutes = new Set(wsRoutes.map(r => `${r.ownerPeerId}/${r.workspaceId}`));
      this.peerAnnounceState.set(peerId, {
        lastVersion: this.routeVersion,
        announcedRoutes,
      });
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — sent FULL OK`);
    } catch (err) {
      log.error(`Failed to announce routes to ${peerId.slice(0, 16)}:`, err);
      this.scheduleAnnouncementRetry(peerId);
      return false;
    }

    return true;
  }

  /**
   * Schedule a retry announcement after a failed attempt (5s delay).
   */
  private scheduleAnnouncementRetry(peerId: PeerId): void {
    setTimeout(() => {
      if (this.isPeerConnected(peerId)) {
        this.announceRoutesToPeer(peerId).catch(() => { /* give up after retry */ });
      }
    }, 5_000);
  }

  /**
   * Announce routes to all connected peers.
   */
  async announceRoutesToAll(): Promise<void> {
    if (!this.hasPeerAccess) return;

    const connectedPeers = this.getConnectedPeersList();
    log.info(`announceRoutesToAll — ${connectedPeers.length} connected peers`);
    for (const peerId of connectedPeers) {
      await this.announceRoutesToPeer(peerId).catch(() => { /* best-effort */ });
    }
  }

  /**
   * Collect system object routes for a peer (always included).
   */
  private collectSystemRoutesForPeer(
    _peerId: PeerId,
  ): Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }> {
    const result: Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }> = [];

    for (const objId of this.allowedSystemObjects.keys()) {
      let wkId: string | undefined;
      let tId: string | undefined;
      for (const [alias, uuid] of this.wellKnownAliases) {
        if (uuid === objId) { wkId = alias; break; }
      }
      for (const [tid, uuid] of this.typeIdToLocal) {
        if (uuid === objId) { tId = tid; break; }
      }
      result.push({ objectId: objId, hops: 0, wellKnownId: wkId, typeId: tId });
    }

    return result;
  }

  /**
   * Phase 1: Collect workspace-level routes for a specific peer.
   * One entry per shared workspace instead of one per exposed object.
   */
  private async collectWorkspaceRoutesForPeer(
    peerId: PeerId,
  ): Promise<WorkspaceRoute[]> {
    const result: WorkspaceRoute[] = [];
    const localPeerId = this.getLocalPeer();

    // Lazy-resolve WorkspaceManager if not yet known (spawned after PeerRouter)
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = (await this.discoverDep('WorkspaceManager')) ?? undefined;
      if (this.workspaceManagerId) {
        this.request(
          createRequest(this.id, this.workspaceManagerId, 'addDependent', {}),
        ).catch(() => { /* best-effort */ });
      }
    }

    // Query WorkspaceManager for shared workspace objects
    if (this.workspaceManagerId) {
      try {
        const workspaces = await this.request<Array<{
          workspaceId: string;
          name: string;
          accessMode: WorkspaceAccessMode;
          whitelist?: string[];
          exposedObjectIds?: AbjectId[];
          childIds?: AbjectId[];
          registryId?: AbjectId;
          /** Mirror of a remote peer's workspace -- never announceable. */
          joined?: boolean;
        }>>(
          createRequest(
            this.id, this.workspaceManagerId,
            'listWorkspacesDetailed', {},
          ),
        );

        for (const ws of workspaces) {
          // A joined mirror is never announced. We mirror that workspace, we
          // do not host it, so advertising it would hand peers a route to a
          // copy whose real owner is someone else. listWorkspacesDetailed
          // already reports mirrors as 'local' (participation access is
          // exposed only through findWorkspaceForObject, for permission), so
          // this guard is the explicit belt to that braces: hosting and
          // participation must not be able to drift back together here.
          const shouldInclude =
            !ws.joined &&
            (ws.accessMode === 'public' ||
              (ws.accessMode === 'shared' && ws.whitelist?.includes(peerId)));

          if (shouldInclude && ws.registryId) {
            const exposed = ws.exposedObjectIds ?? [];
            result.push({
              ownerPeerId: localPeerId,
              workspaceId: ws.workspaceId,
              nextHop: '' as PeerId, // local, not used for outbound
              hops: 0,
              ttl: Date.now() + ROUTE_TTL,
              accessMode: ws.accessMode,
              registryId: ws.registryId,
              exposedNames: [], // Could extract from childTypeIds in future
              exposedObjectIds: exposed,
            });
          }
        }
      } catch {
        // WorkspaceManager not ready or doesn't support listWorkspacesDetailed yet
      }
    }

    // Also re-announce workspace routes we know about from OTHER peers (transitive relay)
    const now = Date.now();
    for (const [, wsRoute] of this.workspaceRoutes) {
      if (wsRoute.nextHop === peerId) continue; // Don't announce back
      if (now > wsRoute.ttl) continue;
      if (wsRoute.hops < MAX_GOSSIP_HOPS) {
        const key = `${wsRoute.ownerPeerId}/${wsRoute.workspaceId}`;
        // Don't double-announce local workspaces
        if (!result.some(r => `${r.ownerPeerId}/${r.workspaceId}` === key)) {
          result.push({
            ...wsRoute,
            hops: wsRoute.hops + 1,
          });
        }
      }
    }

    return result;
  }

  /**
   * Handle incoming route announcement from a peer.
   * Phase 2: Accepts both 'full' and 'diff' formats.
   * Phase 3: Uses gossip propagation instead of flood.
   */
  private handleRouteAnnouncementImpl(
    payload: {
      type?: 'full' | 'diff';
      workspaceRoutes?: Array<{
        ownerPeerId: string; workspaceId: string; hops: number;
        accessMode: string; registryId: string;
        exposedNames?: string[]; exposedObjectIds?: string[];
        wellKnownId?: string; typeId?: string;
      }>;
      added?: Array<{
        ownerPeerId: string; workspaceId: string; hops: number;
        accessMode: string; registryId: string;
        exposedNames?: string[]; exposedObjectIds?: string[];
      }>;
      removed?: string[];
      version?: number;
      propagationId?: string;
      hopsRemaining?: number;
      routes?: Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }>;
      fromPeerId: string;
      systemRoutes?: Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }>;
    },
  ): boolean {
    const fromPeerId = payload.fromPeerId as PeerId;
    log.info(`handleRouteAnnouncement from=${fromPeerId.slice(0, 16)}, type=${payload.type ?? 'legacy'}`);

    // Phase 3: Dedup propagation
    if (payload.propagationId) {
      if (this.seenPropagations.has(payload.propagationId)) {
        return true; // Already processed
      }
      this.seenPropagations.set(payload.propagationId, Date.now() + PROPAGATION_EXPIRY);
    }

    let newRoutes = false;

    // Handle system routes (always per-object)
    const sysRoutes = payload.systemRoutes ?? [];
    for (const announced of sysRoutes) {
      const objectId = announced.objectId as AbjectId;
      const newHops = announced.hops + 1;

      // Store well-known → UUID mapping for this peer
      if (announced.wellKnownId) {
        const key = `${fromPeerId}:${announced.wellKnownId}`;
        this.remoteWellKnown.set(key, objectId);
      }
      if (announced.typeId) {
        const key = `${fromPeerId}:${announced.typeId}`;
        this.remoteWellKnown.set(key, objectId);
      }

      // Skip if we already have a shorter/equal route
      const existing = this.systemRoutes.get(objectId);
      if (existing && existing.hops <= newHops && Date.now() < existing.ttl) {
        continue;
      }
      // Skip if this object is local. Nothing is mounted here for a peer's
      // object any more, so this no longer discards the announced routes for
      // exactly the ids that need them — it only keeps a genuinely local
      // object from being shadowed by a remote announcement.
      if (this._messageBus?.isRegistered(objectId)) {
        continue;
      }

      this.systemRoutes.set(objectId, {
        nextHop: fromPeerId,
        hops: newHops,
        ttl: Date.now() + ROUTE_TTL,
        typeId: announced.typeId as TypeId | undefined,
      });
      newRoutes = true;
    }

    // Legacy format: convert per-object routes to workspace-level handling
    if (payload.routes && !payload.workspaceRoutes && !payload.added) {
      return this.handleLegacyRouteAnnouncement(payload.routes, fromPeerId);
    }

    // Phase 1+2: Handle workspace-level routes
    if (payload.type === 'full' && payload.workspaceRoutes) {
      // Full announcement: replace all routes from this peer
      // First, remove old routes from this peer
      for (const [wsKey, route] of this.workspaceRoutes) {
        if (route.nextHop === fromPeerId) {
          this.workspaceRoutes.delete(wsKey);
          this.recordRouteChange('remove', wsKey);
        }
      }

      // Add new routes
      for (const announced of payload.workspaceRoutes) {
        const wsKey = `${announced.ownerPeerId}/${announced.workspaceId}`;
        const newHops = announced.hops + 1;

        const wsRoute: WorkspaceRoute = {
          ownerPeerId: announced.ownerPeerId as PeerId,
          workspaceId: announced.workspaceId,
          nextHop: fromPeerId,
          hops: newHops,
          ttl: Date.now() + ROUTE_TTL,
          accessMode: announced.accessMode as WorkspaceAccessMode,
          registryId: announced.registryId as AbjectId,
          exposedNames: announced.exposedNames ?? [],
          exposedObjectIds: (announced.exposedObjectIds ?? []) as AbjectId[],
        };

        // Skip if we already have a shorter route via different peer
        const existing = this.workspaceRoutes.get(wsKey);
        if (existing && existing.hops <= newHops && existing.nextHop !== fromPeerId && Date.now() < existing.ttl) {
          continue;
        }

        this.workspaceRoutes.set(wsKey, wsRoute);
        this.recordRouteChange('add', wsKey, wsRoute);
        newRoutes = true;
        this.recordRegistryOwnerHint(wsRoute);

        // Cache object → workspace mappings for exposed objects
        for (const objId of wsRoute.exposedObjectIds) {
          this.objectToWorkspace.set(objId, wsKey);
        }
        this.objectToWorkspace.set(wsRoute.registryId, wsKey);
      }
    } else if (payload.type === 'diff') {
      // Diff announcement: apply incremental changes
      if (payload.added) {
        for (const announced of payload.added) {
          const wsKey = `${announced.ownerPeerId}/${announced.workspaceId}`;
          const newHops = announced.hops + 1;

          const wsRoute: WorkspaceRoute = {
            ownerPeerId: announced.ownerPeerId as PeerId,
            workspaceId: announced.workspaceId,
            nextHop: fromPeerId,
            hops: newHops,
            ttl: Date.now() + ROUTE_TTL,
            accessMode: announced.accessMode as WorkspaceAccessMode,
            registryId: announced.registryId as AbjectId,
            exposedNames: announced.exposedNames ?? [],
            exposedObjectIds: (announced.exposedObjectIds ?? []) as AbjectId[],
          };

          const existing = this.workspaceRoutes.get(wsKey);
          if (existing && existing.hops <= newHops && existing.nextHop !== fromPeerId && Date.now() < existing.ttl) {
            continue;
          }

          this.workspaceRoutes.set(wsKey, wsRoute);
          this.recordRouteChange(existing ? 'update' : 'add', wsKey, wsRoute);
          newRoutes = true;
          this.recordRegistryOwnerHint(wsRoute);

          for (const objId of wsRoute.exposedObjectIds) {
            this.objectToWorkspace.set(objId, wsKey);
          }
          this.objectToWorkspace.set(wsRoute.registryId, wsKey);
        }
      }
      if (payload.removed) {
        for (const wsKey of payload.removed) {
          const existing = this.workspaceRoutes.get(wsKey);
          if (existing && existing.nextHop === fromPeerId) {
            this.workspaceRoutes.delete(wsKey);
            this.recordRouteChange('remove', wsKey);
            newRoutes = true;
          }
        }
      }
    }

    // Phase 3: Gossip propagation — forward to random subset instead of all peers
    if (newRoutes) {
      const hopsRemaining = payload.hopsRemaining ?? MAX_GOSSIP_HOPS;
      if (hopsRemaining > 0) {
        this.gossipForward(fromPeerId, payload.propagationId, hopsRemaining - 1);
      }
      // Notify dependents (e.g. WSR) that new routes are available
      this.changed('routesUpdated', { fromPeerId });
    }

    return true;
  }

  /**
   * Legacy format handler for backward compatibility.
   * Converts per-object route announcements to the system routes table.
   */
  private handleLegacyRouteAnnouncement(
    routes: Array<{ objectId: string; hops: number; wellKnownId?: string; typeId?: string }>,
    fromPeerId: PeerId,
  ): boolean {
    log.info(`handleLegacyRouteAnnouncement from=${fromPeerId.slice(0, 16)}, ${routes.length} routes`);
    let newRoutes = false;

    for (const announced of routes) {
      const objectId = announced.objectId as AbjectId;
      const newHops = announced.hops + 1;

      if (announced.wellKnownId) {
        const key = `${fromPeerId}:${announced.wellKnownId}`;
        this.remoteWellKnown.set(key, objectId);
      }
      if (announced.typeId) {
        const key = `${fromPeerId}:${announced.typeId}`;
        this.remoteWellKnown.set(key, objectId);
      }

      const existing = this.systemRoutes.get(objectId);
      if (existing && existing.hops <= newHops && Date.now() < existing.ttl) {
        continue;
      }
      // Same "never shadow a local object" guard as the delta path above, and
      // the same consequence: with no stand-ins, a peer's announced route is
      // learned instead of being dropped on arrival.
      if (this._messageBus?.isRegistered(objectId)) {
        continue;
      }

      this.systemRoutes.set(objectId, {
        nextHop: fromPeerId,
        hops: newHops,
        ttl: Date.now() + ROUTE_TTL,
        typeId: announced.typeId as TypeId | undefined,
      });
      newRoutes = true;
    }

    if (newRoutes) {
      if (!this.reannounceTimer) {
        this.reannounceTimer = setTimeout(() => {
          this.reannounceTimer = undefined;
          this.announceRoutesToAll().catch(() => { /* best-effort */ });
        }, 500);
      }
      this.changed('routesUpdated', { fromPeerId });
    }

    return true;
  }

  // ==========================================================================
  // Phase 3: Gossip propagation
  // ==========================================================================

  /**
   * Forward route changes to a random subset of connected peers (gossip).
   * O(log n) fanout instead of O(n) flood.
   */
  private gossipForward(excludePeerId: PeerId, propagationId: string | undefined, hopsRemaining: number): void {
    if (!this.hasPeerAccess) return;

    const connectedPeers = this.getConnectedPeersList()
      .filter(p => p !== excludePeerId);

    if (connectedPeers.length === 0) return;

    // Pick ceil(log2(connectedPeers)) random peers, with floor of GOSSIP_FANOUT_MIN
    // and cap of GOSSIP_FANOUT. The floor ensures routes propagate even in small clusters.
    const fanout = Math.min(
      GOSSIP_FANOUT,
      Math.max(GOSSIP_FANOUT_MIN, Math.ceil(Math.log2(connectedPeers.length + 1))),
      connectedPeers.length,
    );

    const selected = this.selectRandom(connectedPeers, fanout);
    const propId = propagationId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    for (const peerId of selected) {
      // Schedule a diff announcement to this peer
      this.announceRoutesToPeer(peerId).catch(() => { /* best-effort */ });
    }
  }

  /**
   * Phase 3: Anti-entropy exchange.
   * Every ~30-45s (with jitter), pick ONE random peer and exchange route digests.
   */
  private async antiEntropyExchange(): Promise<void> {
    if (!this.hasPeerAccess) return;

    const connectedPeers = this.getConnectedPeersList();
    if (connectedPeers.length === 0) return;

    // Pick one random peer
    const randomPeer = connectedPeers[Math.floor(Math.random() * connectedPeers.length)];

    // Build digest of our workspace routes
    const digest: Array<{ workspaceKey: string; version: number }> = [];
    for (const [wsKey] of this.workspaceRoutes) {
      digest.push({ workspaceKey: wsKey, version: this.routeVersion });
    }

    // Send digest to peer
    if (!this.isPeerConnected(randomPeer)) return;

    const localPeerId = this.getLocalPeer();
    const digestMsg = createRequest(
      this.id, PEER_ROUTER_ID, 'handleRouteDigest',
      { digest, fromPeerId: localPeerId },
    );

    try {
      await this.sendToPeerTransport(randomPeer, digestMsg);
    } catch { /* best-effort */ }

    // Also do a full announce to this peer to ensure convergence
    await this.announceRoutesToPeer(randomPeer).catch(() => {});
  }

  /**
   * Handle anti-entropy digest from a peer.
   * Respond with routes they're missing.
   */
  private async handleRouteDigest(
    digest: Array<{ workspaceKey: string; version: number }>,
    fromPeerId: PeerId,
  ): Promise<boolean> {
    // Compare digest against what we think we've sent this peer.
    // If the peer is missing workspace routes we think we announced,
    // reset announce state so the next call sends a FULL (forces convergence).
    const peerState = this.peerAnnounceState.get(fromPeerId);
    if (peerState) {
      const peerWsKeys = new Set(digest.map(d => d.workspaceKey));
      let peerMissing = false;
      for (const wsKey of peerState.announcedRoutes) {
        if (!peerWsKeys.has(wsKey) && this.workspaceRoutes.has(wsKey)) {
          peerMissing = true;
          break;
        }
      }
      if (peerMissing) {
        this.peerAnnounceState.delete(fromPeerId);
      }
    }

    // Announce our routes to this peer (full if state was reset, diff otherwise)
    await this.announceRoutesToPeer(fromPeerId).catch(() => {});
    return true;
  }

  /**
   * Select n random elements from an array.
   */
  private selectRandom<T>(arr: T[], n: number): T[] {
    if (n >= arr.length) return [...arr];
    const copy = [...arr];
    const result: T[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * copy.length);
      result.push(copy[idx]);
      copy[idx] = copy[copy.length - 1];
      copy.pop();
    }
    return result;
  }

  // ==========================================================================
  // Convenience accessors
  // ==========================================================================

  get routeCount(): number {
    return this.systemRoutes.size + this.workspaceRoutes.size;
  }

  get workspaceRouteCount(): number {
    return this.workspaceRoutes.size;
  }

  get systemRouteCount(): number {
    return this.systemRoutes.size;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## PeerRouter Usage Guide

### Register a route to a remote object

  await call(await dep('PeerRouter'), 'registerRoute', {
    objectId: 'remote-object-id', peerId: 'peer-id', hops: 1
  });

### Remove a route

  await call(await dep('PeerRouter'), 'removeRoute', { objectId: 'remote-object-id' });

### Clear all routes for a disconnected peer

  await call(await dep('PeerRouter'), 'clearRoutesForPeer', { peerId: 'peer-id' });

### Get all routes

  const routes = await call(await dep('PeerRouter'), 'getRoutes', {});
  // routes: entries of { objectId, peerId, hops, workspaceKey? }

### Announce routes to a peer

  await call(await dep('PeerRouter'), 'announceRoutes', { peerId: 'peer-id' });

### Resolve a well-known object on a remote peer

  const objectId = await call(await dep('PeerRouter'), 'resolveRemoteObject', {
    peerId: 'peer-id', wellKnownId: 'abjects:registry'
  });

### IMPORTANT
- The interface ID is 'abjects:peer-router'.
- Routes are workspace-level for scalability (one route per workspace, not per object).
- System routes are per-object (~20 entries) for bootstrap objects.
- Incremental diffs and gossip propagation minimize network overhead.
- Multi-hop routing is transparent — messages are forwarded along the shortest path.`;
  }
}
