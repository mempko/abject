/**
 * PeerRouter — Abject + MessageInterceptor that provides transparent
 * multi-hop message routing with permission-aware route propagation.
 *
 * Replaces NetworkBridge. An AbjectId UUID is the only address — senders
 * never know or care whether the target is local or remote. Routes are
 * propagated automatically based on workspace access mode (public/private/local).
 * Remote well-known objects are resolved to UUIDs via `resolveRemoteObject`.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest, error as createError } from '../core/message.js';
import type { MessageInterceptor, MessageBus } from '../runtime/message-bus.js';
import type { PeerId } from '../core/identity.js';
import type { PeerRegistry } from '../objects/peer-registry.js';
import type { WorkspaceAccessMode } from '../objects/workspace-manager.js';

const PEER_ROUTER_INTERFACE = 'abjects:peer-router' as InterfaceId;
const PEER_REGISTRY_INTERFACE = 'abjects:peer-registry' as InterfaceId;
const WORKSPACE_MANAGER_INTERFACE = 'abjects:workspace-manager' as InterfaceId;
const INTROSPECT_INTERFACE = 'abjects:introspect' as InterfaceId;

export const PEER_ROUTER_ID = 'abjects:peer-router' as AbjectId;

const ROUTE_TTL = 5 * 60 * 1000; // 5 minutes
const ANNOUNCE_INTERVAL = 60_000; // 60s periodic re-announce

interface RouteEntry {
  nextHop: PeerId;
  hops: number;
  ttl: number; // expiry timestamp
}

interface PermissionCacheEntry {
  workspaceId: string;
  accessMode: WorkspaceAccessMode;
  whitelist: string[];
  cachedAt: number;
}

const PERMISSION_CACHE_TTL = 30_000; // 30s

export class PeerRouter extends Abject implements MessageInterceptor {
  /** The routing table: AbjectId → next-hop peer */
  private routes: Map<AbjectId, RouteEntry> = new Map();

  /** System objects explicitly allowed for remote access */
  private allowedSystemObjects: Set<AbjectId> = new Set();

  /** Well-known name → local UUID mapping for inbound message resolution */
  private wellKnownAliases: Map<AbjectId, AbjectId> = new Map();

  /** Remote peer well-known → UUID mappings: key = `${peerId}:${wellKnownId}` */
  private remoteWellKnown: Map<string, AbjectId> = new Map();

  /** Inbound permission cache */
  private permissionCache: Map<AbjectId, PermissionCacheEntry> = new Map();

  /** Direct refs set during bootstrap */
  private _messageBus?: MessageBus;
  private peerRegistryRef?: PeerRegistry;
  private peerRegistryId?: AbjectId;
  private workspaceManagerId?: AbjectId;

  /** Periodic announcement timer */
  private announceTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super({
      manifest: {
        name: 'PeerRouter',
        description:
          'Transparent multi-hop message router with permission-aware route propagation. Routes messages to remote peers based on AbjectId, enforces workspace access permissions on inbound messages.',
        version: '1.0.0',
        interfaces: [
          {
            id: PEER_ROUTER_INTERFACE,
            name: 'PeerRouter',
            description: 'Message routing and route management',
            methods: [
              {
                name: 'registerRoute',
                description: 'Register an AbjectId → nextHop mapping',
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
                description: 'Receive route announcements from a peer',
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
            ],
            events: [
              {
                name: 'routeAdded',
                description: 'A new route was added',
                payload: { kind: 'object', properties: {
                  objectId: { kind: 'primitive', primitive: 'string' },
                  nextHop: { kind: 'primitive', primitive: 'string' },
                  hops: { kind: 'primitive', primitive: 'number' },
                } },
              },
              {
                name: 'routeRemoved',
                description: 'A route was removed',
                payload: { kind: 'object', properties: {
                  objectId: { kind: 'primitive', primitive: 'string' },
                } },
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
  }

  /**
   * Mark a system object as accessible to remote peers (direct method, for bootstrap).
   */
  allowSystemObjectDirect(objectId: AbjectId, wellKnownId?: AbjectId): void {
    this.allowedSystemObjects.add(objectId);
    if (wellKnownId) {
      this.wellKnownAliases.set(wellKnownId, objectId);
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
      return this.registerRouteImpl(objectId as AbjectId, peerId, hops ?? 0);
    });

    this.on('removeRoute', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.removeRouteImpl(objectId as AbjectId);
    });

    this.on('clearRoutesForPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.clearRoutesForPeerImpl(peerId);
    });

    this.on('allowSystemObject', async (msg: AbjectMessage) => {
      const { objectId, wellKnownId } = msg.payload as { objectId: string; wellKnownId?: string };
      this.allowedSystemObjects.add(objectId as AbjectId);
      if (wellKnownId) {
        this.wellKnownAliases.set(wellKnownId as AbjectId, objectId as AbjectId);
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
      const { routes, fromPeerId } = msg.payload as {
        routes: Array<{ objectId: string; hops: number; wellKnownId?: string }>;
        fromPeerId: string;
      };
      return this.handleRouteAnnouncementImpl(routes, fromPeerId);
    });

    this.on('resolveRemoteObject', async (msg: AbjectMessage) => {
      const { peerId, wellKnownId } = msg.payload as { peerId: string; wellKnownId: string };
      const key = `${peerId}:${wellKnownId}`;
      const result = this.remoteWellKnown.get(key) ?? null;
      console.log(`[PeerRouter] resolveRemoteObject key="${key.slice(0, 50)}" → ${result ? result.slice(0, 8) : 'null'} (map size=${this.remoteWellKnown.size}, keys=[${[...this.remoteWellKnown.keys()].map(k => k.slice(0, 40)).join(', ')}])`);
      return result;
    });

    // Listen for events from PeerRegistry and WorkspaceManager
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };

      // PeerRegistry: new peer connected — announce routes immediately
      if (aspect === 'contactConnected') {
        const { peerId } = value as { peerId: string };
        console.log(`[PeerRouter] contactConnected event for ${peerId.slice(0, 16)}, announcing routes`);
        this.announceRoutesToPeer(peerId as PeerId).catch(() => { /* best-effort */ });
        return;
      }

      if (aspect === 'workspaceAccessChanged' || aspect === 'workspaceShared' || aspect === 'workspaceUnshared') {
        // Invalidate permission cache
        this.permissionCache.clear();
        // Re-announce routes to all connected peers
        this.announceRoutesToAll().catch(() => { /* best-effort */ });
      }
    });
  }

  protected override async onInit(): Promise<void> {
    console.log('[PeerRouter] onInit starting');
    this.peerRegistryId = (await this.discoverDep('PeerRegistry')) ?? undefined;
    this.workspaceManagerId = (await this.discoverDep('WorkspaceManager')) ?? undefined;
    console.log(`[PeerRouter] onInit deps: peerRegistryId=${!!this.peerRegistryId} workspaceManagerId=${!!this.workspaceManagerId}`);

    // Subscribe to PeerRegistry events (contactConnected triggers route announcement)
    if (this.peerRegistryId) {
      try {
        await this.request(
          createRequest(this.id, this.peerRegistryId, INTROSPECT_INTERFACE, 'addDependent', {}),
        );
        console.log('[PeerRouter] subscribed to PeerRegistry events');
      } catch { /* PeerRegistry may not support addDependent yet */ }
    }

    // Subscribe to WorkspaceManager events for cache invalidation
    if (this.workspaceManagerId) {
      try {
        await this.request(
          createRequest(this.id, this.workspaceManagerId, INTROSPECT_INTERFACE, 'addDependent', {}),
        );
      } catch { /* WorkspaceManager may not be ready yet */ }
    }

    // Start periodic route announcements
    this.announceTimer = setInterval(() => {
      this.announceRoutesToAll().catch(() => { /* best-effort */ });
    }, ANNOUNCE_INTERVAL);
    console.log('[PeerRouter] onInit complete, announce timer started (60s)');
  }

  protected override async onStop(): Promise<void> {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = undefined;
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

    // Look up route in routing table
    const route = this.getRoute(recipient);
    if (!route) {
      return 'pass'; // Local delivery
    }

    const transport = this.peerRegistryRef.getTransportForPeer(route.nextHop);
    if (!transport || !transport.isConnected) {
      console.warn(`[PeerRouter] Cannot route to ${recipient.slice(0, 8)}: peer ${route.nextHop.slice(0, 16)} not connected`);
      return 'pass'; // Fall through to normal undeliverable handling
    }

    try {
      await transport.send(message);
      return 'drop'; // We handled delivery
    } catch (err) {
      console.error(`[PeerRouter] Failed to forward message to peer ${route.nextHop.slice(0, 16)}:`, err);
      return 'pass';
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
    // Record sender's route for reply routing
    this.routes.set(msg.routing.from, {
      nextHop: fromPeerId,
      hops: 0,
      ttl: Date.now() + ROUTE_TTL,
    });

    let targetId = msg.routing.to;
    console.log(`[PeerRouter] inbound: to=${msg.routing.to.slice(0, 20)} from=${msg.routing.from.slice(0, 8)} type=${msg.header.type} method=${(msg.payload as any)?.method ?? '?'}`);

    // Messages addressed to PEER_ROUTER_ID are for this PeerRouter itself
    if (targetId === PEER_ROUTER_ID) {
      targetId = this.id;
      msg = { ...msg, routing: { ...msg.routing, to: this.id } };
      console.log('[PeerRouter] self-addressed, resolved to', this.id.slice(0, 8));
    }

    // Resolve well-known alias to actual registered UUID
    const resolvedId = this.wellKnownAliases.get(targetId);
    if (resolvedId) {
      targetId = resolvedId;
      msg = { ...msg, routing: { ...msg.routing, to: resolvedId } };
      console.log('[PeerRouter] alias resolved:', targetId.slice(0, 8));
    }

    // Check if target is registered locally on the bus
    const isReg = this._messageBus?.isRegistered(targetId) ?? false;
    const permOk = isReg ? this.checkInboundPermission(targetId, fromPeerId) : false;
    console.log('[PeerRouter] isRegistered=', isReg, 'permissionOk=', permOk);

    if (this._messageBus && isReg) {
      // This peer is the destination — check permissions
      if (!permOk) {
        console.warn(`[PeerRouter] ACCESS_DENIED: ${fromPeerId.slice(0, 16)} → ${targetId.slice(0, 8)}`);
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
        console.error('[PeerRouter] Failed to inject remote message:', err);
      });
      return;
    }

    // Check if target is in routing table pointing to a different peer (relay)
    const route = this.getRoute(targetId);
    if (route && route.nextHop !== fromPeerId) {
      const transport = this.peerRegistryRef?.getTransportForPeer(route.nextHop);
      if (transport?.isConnected) {
        transport.send(msg).catch((err) => {
          console.error(`[PeerRouter] Failed to relay message via ${route.nextHop.slice(0, 16)}:`, err);
        });
        return;
      }
    }

    // Undeliverable — send error reply immediately via transport, then try local bus as fallback
    console.log('[PeerRouter] UNDELIVERABLE for', targetId.slice(0, 20));
    if (msg.header.type === 'request') {
      const errMsg = createError(msg, 'RECIPIENT_NOT_FOUND',
        `Remote object ${targetId} is not available on this peer`);
      const transport = this.peerRegistryRef?.getTransportForPeer(fromPeerId);
      if (transport?.isConnected) {
        transport.send(errMsg).catch(() => { /* best-effort */ });
      }
    }
    if (this._messageBus) {
      this._messageBus.send(msg).catch(() => {
        console.warn(`[PeerRouter] Undeliverable remote message for ${targetId.slice(0, 8)}`);
      });
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

    // Check permission cache
    const cached = this.permissionCache.get(targetId);
    if (cached && Date.now() - cached.cachedAt < PERMISSION_CACHE_TTL) {
      return this.evaluatePermission(cached, fromPeerId);
    }

    // No cache — trigger async lookup for next time, allow this message
    this.refreshPermissionCache(targetId).catch(() => { /* best-effort */ });
    return true;
  }

  private evaluatePermission(entry: PermissionCacheEntry, fromPeerId: PeerId): boolean {
    switch (entry.accessMode) {
      case 'public':
        return true;
      case 'private':
        return entry.whitelist.includes(fromPeerId);
      case 'local':
        return false;
      default:
        return false;
    }
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
      } | null>(
        createRequest(
          this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE,
          'findWorkspaceForObject', { objectId: targetId },
        ),
      );

      if (result) {
        this.permissionCache.set(targetId, {
          workspaceId: result.workspaceId,
          accessMode: result.accessMode,
          whitelist: result.whitelist,
          cachedAt: Date.now(),
        });
      } else {
        // Not in any workspace — treat as local (deny)
        this.permissionCache.set(targetId, {
          workspaceId: '',
          accessMode: 'local',
          whitelist: [],
          cachedAt: Date.now(),
        });
      }
    } catch {
      // WorkspaceManager not ready — will retry on next message
    }
  }

  // ==========================================================================
  // Route management
  // ==========================================================================

  private registerRouteImpl(objectId: AbjectId, peerId: PeerId, hops: number): boolean {
    const existing = this.routes.get(objectId);
    // Keep shorter routes
    if (existing && existing.hops <= hops && Date.now() < existing.ttl) {
      return false;
    }

    this.routes.set(objectId, {
      nextHop: peerId,
      hops,
      ttl: Date.now() + ROUTE_TTL,
    });
    return true;
  }

  private removeRouteImpl(objectId: AbjectId): boolean {
    return this.routes.delete(objectId);
  }

  private clearRoutesForPeerImpl(peerId: PeerId): number {
    let count = 0;
    for (const [objectId, entry] of this.routes) {
      if (entry.nextHop === peerId) {
        this.routes.delete(objectId);
        count++;
      }
    }
    // Clean up well-known mappings for this peer
    for (const key of this.remoteWellKnown.keys()) {
      if (key.startsWith(`${peerId}:`)) {
        this.remoteWellKnown.delete(key);
      }
    }
    return count;
  }

  private getRoute(objectId: AbjectId): RouteEntry | undefined {
    const entry = this.routes.get(objectId);
    if (!entry) return undefined;
    if (Date.now() > entry.ttl) {
      this.routes.delete(objectId);
      return undefined;
    }
    return entry;
  }

  private getRoutesImpl(): Array<{ objectId: string; nextHop: string; hops: number; ttl: number }> {
    const now = Date.now();
    const result: Array<{ objectId: string; nextHop: string; hops: number; ttl: number }> = [];
    for (const [objectId, entry] of this.routes) {
      if (now < entry.ttl) {
        result.push({
          objectId,
          nextHop: entry.nextHop,
          hops: entry.hops,
          ttl: entry.ttl - now,
        });
      }
    }
    return result;
  }

  // ==========================================================================
  // Route propagation
  // ==========================================================================

  /**
   * Announce local routes to a specific peer.
   * Filters by workspace access mode.
   */
  async announceRoutesToPeer(peerId: PeerId): Promise<boolean> {
    if (!this.peerRegistryRef) {
      console.log(`[PeerRouter] announceRoutesToPeer(${peerId.slice(0, 16)}) — skipped: no peerRegistryRef`);
      return false;
    }

    const transport = this.peerRegistryRef.getTransportForPeer(peerId);
    if (!transport?.isConnected) {
      console.log(`[PeerRouter] announceRoutesToPeer(${peerId.slice(0, 16)}) — skipped: transport=${!!transport} connected=${transport?.isConnected}`);
      return false;
    }

    const announcedRoutes = await this.collectRoutesForPeer(peerId);
    if (announcedRoutes.length === 0) {
      console.log(`[PeerRouter] announceRoutesToPeer(${peerId.slice(0, 16)}) — no routes to announce`);
      return true;
    }

    const localPeerId = this.peerRegistryRef.getLocalPeerId();
    console.log(`[PeerRouter] announceRoutesToPeer(${peerId.slice(0, 16)}) — ${announcedRoutes.length} routes, localPeerId=${localPeerId.slice(0, 16)}`, announcedRoutes.map(r => ({ obj: r.objectId.slice(0, 8), wk: r.wellKnownId, hops: r.hops })));

    // Send route announcement as a message to the remote peer's PeerRouter
    const announcement = createRequest(
      this.id,
      PEER_ROUTER_ID,
      PEER_ROUTER_INTERFACE,
      'handleRouteAnnouncement',
      { routes: announcedRoutes, fromPeerId: localPeerId },
    );
    try {
      await transport.send(announcement);
      console.log(`[PeerRouter] announceRoutesToPeer(${peerId.slice(0, 16)}) — sent OK`);
    } catch (err) {
      console.error(`[PeerRouter] Failed to announce routes to ${peerId.slice(0, 16)}:`, err);
      return false;
    }

    return true;
  }

  /**
   * Announce routes to all connected peers.
   */
  private async announceRoutesToAll(): Promise<void> {
    if (!this.peerRegistryRef) return;

    const connectedPeers = this.peerRegistryRef.getConnectedPeers();
    console.log(`[PeerRouter] announceRoutesToAll — ${connectedPeers.length} connected peers: [${connectedPeers.map(p => p.slice(0, 16)).join(', ')}]`);
    for (const peerId of connectedPeers) {
      await this.announceRoutesToPeer(peerId).catch(() => { /* best-effort */ });
    }
  }

  /**
   * Collect routes appropriate for a specific peer based on workspace access.
   */
  private async collectRoutesForPeer(
    peerId: PeerId,
  ): Promise<Array<{ objectId: string; hops: number; wellKnownId?: string }>> {
    const result: Array<{ objectId: string; hops: number; wellKnownId?: string }> = [];

    // Include allowed system objects (with well-known alias if known)
    for (const objId of this.allowedSystemObjects) {
      let wkId: string | undefined;
      for (const [alias, uuid] of this.wellKnownAliases) {
        if (uuid === objId) { wkId = alias; break; }
      }
      result.push({ objectId: objId, hops: 0, wellKnownId: wkId });
    }

    // Lazy-resolve WorkspaceManager if not yet known (spawned after PeerRouter)
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = (await this.discoverDep('WorkspaceManager')) ?? undefined;
    }

    // Query WorkspaceManager for shared workspace objects
    if (this.workspaceManagerId) {
      try {
        const workspaces = await this.request<Array<{
          workspaceId: string;
          name: string;
          accessMode: WorkspaceAccessMode;
          whitelist?: string[];
          childIds?: AbjectId[];
        }>>(
          createRequest(
            this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE,
            'listWorkspacesDetailed', {},
          ),
        );

        for (const ws of workspaces) {
          const shouldInclude =
            ws.accessMode === 'public' ||
            (ws.accessMode === 'private' && ws.whitelist?.includes(peerId));

          if (shouldInclude && ws.childIds) {
            for (const childId of ws.childIds) {
              result.push({ objectId: childId, hops: 0 });
            }
          }
        }
      } catch {
        // WorkspaceManager not ready or doesn't support listWorkspacesDetailed yet
      }
    }

    // Also re-announce routes we know about from OTHER peers (transitive relay)
    // Only public workspace routes (we can't know private access for third parties)
    const now = Date.now();
    for (const [objectId, entry] of this.routes) {
      if (entry.nextHop === peerId) continue; // Don't announce back
      if (now > entry.ttl) continue;
      // Only relay routes we're confident about (hops < 3)
      if (entry.hops < 3) {
        // Check if we already included this
        if (!result.some(r => r.objectId === objectId)) {
          result.push({ objectId, hops: entry.hops + 1 });
        }
      }
    }

    return result;
  }

  /**
   * Handle incoming route announcement from a peer.
   */
  private handleRouteAnnouncementImpl(
    routes: Array<{ objectId: string; hops: number; wellKnownId?: string }>,
    fromPeerId: PeerId,
  ): boolean {
    console.log(`[PeerRouter] handleRouteAnnouncement from=${fromPeerId.slice(0, 16)}, ${routes.length} routes`);
    let newRoutes = false;

    for (const announced of routes) {
      const objectId = announced.objectId as AbjectId;
      const newHops = announced.hops + 1;

      // Store well-known → UUID mapping for this peer
      if (announced.wellKnownId) {
        const key = `${fromPeerId}:${announced.wellKnownId}`;
        this.remoteWellKnown.set(key, objectId);
        console.log(`[PeerRouter] remoteWellKnown["${key.slice(0, 40)}..."] = ${objectId.slice(0, 8)}`);
      }

      // Skip if we already have a shorter/equal route
      const existing = this.routes.get(objectId);
      if (existing && existing.hops <= newHops && Date.now() < existing.ttl) {
        continue;
      }

      // Skip if this object is local
      if (this._messageBus?.isRegistered(objectId)) {
        continue;
      }

      this.routes.set(objectId, {
        nextHop: fromPeerId,
        hops: newHops,
        ttl: Date.now() + ROUTE_TTL,
      });
      newRoutes = true;
    }

    // Re-announce newly learned routes to our other peers (transitive propagation)
    if (newRoutes) {
      this.announceRoutesToAll().catch(() => { /* best-effort */ });
      // Notify dependents (e.g. WSR) that new routes are available
      this.changed('routesUpdated', { fromPeerId });
    }

    return true;
  }

  // ==========================================================================
  // Convenience accessors
  // ==========================================================================

  get routeCount(): number {
    return this.routes.size;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}
