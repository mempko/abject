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
import type { WorkspaceAccessMode } from '../objects/workspace-manager.js';
import { Log } from '../core/timed-log.js';

const log = new Log('PeerRouter');

const PEER_ROUTER_INTERFACE = 'abjects:peer-router';

export const PEER_ROUTER_ID = 'abjects:peer-router' as AbjectId;

const ROUTE_TTL = 5 * 60 * 1000; // 5 minutes
const ANNOUNCE_INTERVAL = 60_000; // 60s periodic anti-entropy
const GOSSIP_FANOUT = 4; // Phase 3: number of peers to gossip to
const MAX_CHANGELOG = 500; // Phase 2: max changelog entries
const PROPAGATION_EXPIRY = 30_000; // Phase 3: propagation dedup window
const MAX_GOSSIP_HOPS = 3; // Phase 3: max hops for gossip propagation

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

  /** System objects explicitly allowed for remote access */
  private allowedSystemObjects: Set<AbjectId> = new Set();

  /** Well-known name → local UUID mapping for inbound message resolution (legacy) */
  private wellKnownAliases: Map<AbjectId, AbjectId> = new Map();

  /** TypeId → local AbjectId mapping for inbound resolution */
  private typeIdToLocal: Map<TypeId, AbjectId> = new Map();

  /** Remote peer TypeId/well-known → UUID mappings: key = `${peerId}:${typeIdOrWellKnown}` */
  private remoteWellKnown: Map<string, AbjectId> = new Map();

  /** NAT table: local objectId → Map<peerId, expiryTimestamp> */
  private connTrack: Map<AbjectId, Map<PeerId, number>> = new Map();

  /** Inbound permission cache */
  private permissionCache: Map<AbjectId, PermissionCacheEntry> = new Map();

  /** Direct refs set during bootstrap */
  private _messageBus?: MessageBus;
  private peerRegistryRef?: PeerRegistry;
  private peerRegistryId?: AbjectId;
  private workspaceManagerId?: AbjectId;

  /** Periodic announcement timer */
  private announceTimer?: ReturnType<typeof setInterval>;

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
                name: 'allowSystemObject',
                description: 'Mark a system object as accessible to remote peers',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object ID to allow' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
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
   * Set the PeerRegistry reference for transport access.
   */
  setPeerRegistry(peerRegistry: PeerRegistry): void {
    this.peerRegistryRef = peerRegistry;
    peerRegistry.onPeerConnected((peerId: string) => {
      log.info(`direct peerConnected callback for ${peerId.slice(0, 16)}`);
      this.announceRoutesToPeer(peerId as PeerId).catch(() => {});
    });
  }

  /**
   * Mark a system object as accessible to remote peers (direct method, for bootstrap).
   */
  allowSystemObjectDirect(objectId: AbjectId, wellKnownId?: AbjectId, typeId?: TypeId): void {
    this.allowedSystemObjects.add(objectId);
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

    this.on('allowSystemObject', async (msg: AbjectMessage) => {
      const { objectId, wellKnownId, typeId } = msg.payload as { objectId: string; wellKnownId?: string; typeId?: string };
      this.allowedSystemObjects.add(objectId as AbjectId);
      if (wellKnownId) {
        this.wellKnownAliases.set(wellKnownId as AbjectId, objectId as AbjectId);
      }
      if (typeId) {
        this.typeIdToLocal.set(typeId as TypeId, objectId as AbjectId);
      }
      return true;
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
    this.allowedSystemObjects.add(this.id);

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
    // Every 60s, pick ONE random peer and exchange route digests.
    this.announceTimer = setInterval(() => {
      this.antiEntropyExchange().catch(() => { /* best-effort */ });
    }, ANNOUNCE_INTERVAL);

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

  protected override async onStop(): Promise<void> {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
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
  async intercept(message: AbjectMessage): Promise<'pass' | 'drop' | AbjectMessage> {
    const recipient = message.routing.to;

    if (!this.peerRegistryRef) {
      return 'pass';
    }

    // If the recipient is registered locally, always deliver locally —
    // never route a local object's messages to a remote peer.
    if (this._messageBus?.isRegistered(recipient)) {
      return 'pass';
    }

    // Look up route in routing table
    const route = this.getRoute(recipient);
    if (!route) {
      return 'pass'; // Local delivery
    }

    const transport = this.peerRegistryRef.getTransportForPeer(route.nextHop);
    if (!transport || !transport.isConnected) {
      log.warn(`Cannot route to ${recipient.slice(0, 8)}: peer ${route.nextHop.slice(0, 16)} not connected`);
      return 'pass'; // Fall through to normal undeliverable handling
    }

    try {
      // Filter list replies to enforce exposed-objects policy
      const outMsg = this.filterOutboundReply(message);
      await transport.send(outMsg);
      // NAT-like: record that this local object talked to this peer
      this.trackOutboundConnection(message.routing.from as AbjectId, route.nextHop);
      return 'drop'; // We handled delivery
    } catch (err) {
      log.error(`Failed to forward message to peer ${route.nextHop.slice(0, 16)}:`, err);
      return 'pass';
    }
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
  private trackOutboundConnection(localObjectId: AbjectId, remotePeerId: PeerId): void {
    let peers = this.connTrack.get(localObjectId);
    if (!peers) {
      peers = new Map();
      this.connTrack.set(localObjectId, peers);
    }
    peers.set(remotePeerId, Date.now() + ROUTE_TTL);
  }

  // ==========================================================================
  // Inbound message handling
  // ==========================================================================

  /**
   * Handle a message received from a remote peer.
   * Called by PeerRegistry when a message arrives via transport.
   */
  handleIncomingMessage(msg: AbjectMessage, fromPeerId: PeerId): void {
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
    const permOk = isReg ? (isReply || this.checkInboundPermission(targetId, fromPeerId)) : false;
    log.info(`isRegistered=${isReg} permissionOk=${permOk}`);

    if (this._messageBus && isReg) {
      // This peer is the destination — check permissions
      if (!permOk) {
        log.warn(`ACCESS_DENIED: ${fromPeerId.slice(0, 16)} → ${targetId.slice(0, 8)}`);
        // Send error reply back if it was a request
        if (msg.header.type === 'request') {
          const errMsg = createError(msg, 'ACCESS_DENIED', `Access denied to object ${targetId}`);
          const transport = this.peerRegistryRef?.getTransportForPeer(fromPeerId);
          if (transport?.isConnected) {
            transport.send(errMsg).catch(() => { /* best-effort */ });
          }
        }
        return;
      }

      // Inject into local bus
      this._messageBus.send(msg).catch((err) => {
        log.error('Failed to inject remote message:', err);
      });
      return;
    }

    // Check if target is in routing table pointing to a different peer (relay)
    const route = this.getRoute(targetId);
    if (route && route.nextHop !== fromPeerId) {
      const transport = this.peerRegistryRef?.getTransportForPeer(route.nextHop);
      if (transport?.isConnected) {
        transport.send(msg).catch((err) => {
          log.error(`Failed to relay message via ${route.nextHop.slice(0, 16)}:`, err);
        });
        return;
      }
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
      const transport = this.peerRegistryRef?.getTransportForPeer(fromPeerId);
      if (transport?.isConnected) {
        transport.send(errMsg).catch(() => { /* best-effort */ });
      }
    }
  }

  // ==========================================================================
  // Permission checking
  // ==========================================================================

  /**
   * Check if an inbound message from a remote peer is allowed to reach the target.
   * Synchronous — uses cached permission data, falls back to allow if no cache.
   */
  private checkInboundPermission(targetId: AbjectId, fromPeerId: PeerId): boolean {
    // System objects explicitly allowed
    if (this.allowedSystemObjects.has(targetId)) {
      return true;
    }

    // NAT-like: allow return traffic if this object previously talked to this peer
    const trackedPeers = this.connTrack.get(targetId);
    if (trackedPeers) {
      const expiry = trackedPeers.get(fromPeerId);
      if (expiry && Date.now() < expiry) {
        return true;
      }
      // Clean up expired entry
      if (expiry) trackedPeers.delete(fromPeerId);
      if (trackedPeers.size === 0) this.connTrack.delete(targetId);
    }

    // Check permission cache
    const cached = this.permissionCache.get(targetId);
    if (cached && Date.now() - cached.cachedAt < PERMISSION_CACHE_TTL) {
      return this.evaluatePermission(cached, fromPeerId, targetId);
    }

    // No cache — trigger async lookup for next time, allow this message
    this.refreshPermissionCache(targetId).catch(() => { /* best-effort */ });
    return true;
  }

  private evaluatePermission(entry: PermissionCacheEntry, fromPeerId: PeerId, targetId?: AbjectId): boolean {
    // First gate: access mode check
    let accessAllowed: boolean;
    switch (entry.accessMode) {
      case 'public':
        accessAllowed = true;
        break;
      case 'private':
        accessAllowed = entry.whitelist.includes(fromPeerId);
        break;
      case 'local':
        return false;
      default:
        return false;
    }
    if (!accessAllowed) return false;

    // Second gate: exposed objects check
    if (entry.exposedObjectIds.length === 0) {
      return false; // No objects exposed — deny remote access
    }
    if (targetId) {
      return entry.exposedObjectIds.includes(targetId);
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
          cachedAt: Date.now(),
        });
      } else {
        // Not in any workspace — treat as local (deny)
        this.permissionCache.set(targetId, {
          workspaceId: '',
          accessMode: 'local',
          whitelist: [],
          exposedObjectIds: [],
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

    return count;
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
        if (this.peerRegistryRef) {
          const transport = this.peerRegistryRef.getTransportForPeer(sysRoute.nextHop);
          if (transport?.isConnected) {
            sysRoute.ttl = now + ROUTE_TTL;
            return sysRoute;
          }
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
          if (this.peerRegistryRef) {
            const transport = this.peerRegistryRef.getTransportForPeer(wsRoute.nextHop);
            if (transport?.isConnected) {
              wsRoute.ttl = now + ROUTE_TTL;
              return {
                nextHop: wsRoute.nextHop,
                hops: wsRoute.hops,
                ttl: wsRoute.ttl,
              };
            }
          }
          this.objectToWorkspace.delete(objectId);
        } else {
          return {
            nextHop: wsRoute.nextHop,
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
        if (this.peerRegistryRef) {
          const transport = this.peerRegistryRef.getTransportForPeer(wsRoute.nextHop);
          if (transport?.isConnected) {
            wsRoute.ttl = now + ROUTE_TTL;
          } else {
            this.workspaceRoutes.delete(wsKey);
            continue;
          }
        } else {
          this.workspaceRoutes.delete(wsKey);
          continue;
        }
      }
      if (wsRoute.exposedObjectIds.includes(objectId) || wsRoute.registryId === objectId) {
        // Cache the mapping for future lookups
        this.objectToWorkspace.set(objectId, wsKey);
        return {
          nextHop: wsRoute.nextHop,
          hops: wsRoute.hops,
          ttl: wsRoute.ttl,
        };
      }
    }

    return undefined;
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
    if (!this.peerRegistryRef) {
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — skipped: no peerRegistryRef`);
      return false;
    }

    const transport = this.peerRegistryRef.getTransportForPeer(peerId);
    if (!transport?.isConnected) {
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — skipped: transport=${!!transport} connected=${transport?.isConnected}`);
      return false;
    }

    const localPeerId = this.peerRegistryRef.getLocalPeerId();

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
        await transport.send(announcement);
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
      await transport.send(announcement);
      // Update peer announce state
      const announcedRoutes = new Set(wsRoutes.map(r => `${r.ownerPeerId}/${r.workspaceId}`));
      this.peerAnnounceState.set(peerId, {
        lastVersion: this.routeVersion,
        announcedRoutes,
      });
      log.info(`announceRoutesToPeer(${peerId.slice(0, 16)}) — sent FULL OK`);
    } catch (err) {
      log.error(`Failed to announce routes to ${peerId.slice(0, 16)}:`, err);
      return false;
    }

    return true;
  }

  /**
   * Announce routes to all connected peers.
   */
  async announceRoutesToAll(): Promise<void> {
    if (!this.peerRegistryRef) return;

    const connectedPeers = this.peerRegistryRef.getConnectedPeers();
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

    for (const objId of this.allowedSystemObjects) {
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
    const localPeerId = this.peerRegistryRef?.getLocalPeerId() ?? '' as PeerId;

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
        }>>(
          createRequest(
            this.id, this.workspaceManagerId,
            'listWorkspacesDetailed', {},
          ),
        );

        for (const ws of workspaces) {
          const shouldInclude =
            ws.accessMode === 'public' ||
            (ws.accessMode === 'private' && ws.whitelist?.includes(peerId));

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
      // Skip if this object is local
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
    if (!this.peerRegistryRef) return;

    const connectedPeers = this.peerRegistryRef.getConnectedPeers()
      .filter(p => p !== excludePeerId);

    if (connectedPeers.length === 0) return;

    // Pick ceil(log2(connectedPeers)) random peers, capped at GOSSIP_FANOUT
    const fanout = Math.min(
      GOSSIP_FANOUT,
      Math.max(1, Math.ceil(Math.log2(connectedPeers.length + 1))),
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
   * Every 60s, pick ONE random peer and exchange route digests.
   */
  private async antiEntropyExchange(): Promise<void> {
    if (!this.peerRegistryRef) return;

    const connectedPeers = this.peerRegistryRef.getConnectedPeers();
    if (connectedPeers.length === 0) return;

    // Pick one random peer
    const randomPeer = connectedPeers[Math.floor(Math.random() * connectedPeers.length)];

    // Build digest of our workspace routes
    const digest: Array<{ workspaceKey: string; version: number }> = [];
    for (const [wsKey] of this.workspaceRoutes) {
      digest.push({ workspaceKey: wsKey, version: this.routeVersion });
    }

    // Send digest to peer
    const transport = this.peerRegistryRef.getTransportForPeer(randomPeer);
    if (!transport?.isConnected) return;

    const localPeerId = this.peerRegistryRef.getLocalPeerId();
    const digestMsg = createRequest(
      this.id, PEER_ROUTER_ID, 'handleRouteDigest',
      { digest, fromPeerId: localPeerId },
    );

    try {
      await transport.send(digestMsg);
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
    // Announce our routes to this peer (will send diff if possible)
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

  protected override getSourceForAsk(): string | undefined {
    return `## PeerRouter Usage Guide

### Register a route to a remote object

  await call(await dep('PeerRouter'), 'registerRoute', {
    objectId: 'remote-object-id', peerId: 'peer-id', hops: 1
  });

### Remove a route

  await call(await dep('PeerRouter'), 'removeRoute', { objectId: 'remote-object-id' });

### Clear all routes for a disconnected peer

  await call(await dep('PeerRouter'), 'clearRoutesForPeer', { peerId: 'peer-id' });

### Allow a system object to be routed

  await call(await dep('PeerRouter'), 'allowSystemObject', {
    objectId: 'local-object-id', wellKnownId: 'abjects:registry'
  });

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
