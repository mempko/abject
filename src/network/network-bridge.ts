/**
 * NetworkBridge — MessageInterceptor that routes messages to/from remote peers.
 *
 * Plugs into the MessageBus interceptor pipeline. When a message targets an object
 * that lives on a remote peer, the bridge serializes and forwards it via the
 * appropriate PeerTransport. Incoming messages from peers are injected into the
 * local MessageBus.
 */

import { AbjectMessage, AbjectId } from '../core/types.js';
import type { MessageInterceptor } from '../runtime/message-bus.js';
import type { MessageBus } from '../runtime/message-bus.js';
import type { PeerRegistry } from '../objects/peer-registry.js';
import type { PeerId } from '../core/identity.js';

/**
 * Routing table entry: maps an AbjectId to the PeerId that hosts it.
 */
interface RouteEntry {
  peerId: PeerId;
  ttl: number;     // timestamp when this entry expires
}

const ROUTE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * NetworkBridge intercepts outbound messages and routes them to remote peers
 * when the target object isn't local. It also injects inbound messages from
 * remote peers into the local MessageBus.
 */
export class NetworkBridge implements MessageInterceptor {
  private routingTable: Map<AbjectId, RouteEntry> = new Map();
  private bus: MessageBus;
  private peerRegistry: PeerRegistry;
  private localObjects: Set<AbjectId> = new Set();

  constructor(bus: MessageBus, peerRegistry: PeerRegistry) {
    this.bus = bus;
    this.peerRegistry = peerRegistry;

    // Listen for incoming messages from remote peers
    this.peerRegistry.onRemoteMessage((msg) => {
      this.handleIncomingMessage(msg);
    });
  }

  /**
   * Register a remote object's location in the routing table.
   */
  registerRoute(objectId: AbjectId, peerId: PeerId): void {
    this.routingTable.set(objectId, {
      peerId,
      ttl: Date.now() + ROUTE_TTL,
    });
  }

  /**
   * Remove a route.
   */
  removeRoute(objectId: AbjectId): void {
    this.routingTable.delete(objectId);
  }

  /**
   * Clear all routes for a specific peer (e.g., on disconnect).
   */
  clearRoutesForPeer(peerId: PeerId): void {
    for (const [objectId, entry] of this.routingTable) {
      if (entry.peerId === peerId) {
        this.routingTable.delete(objectId);
      }
    }
  }

  /**
   * Get the peer that hosts a given object.
   */
  getRoute(objectId: AbjectId): PeerId | undefined {
    const entry = this.routingTable.get(objectId);
    if (!entry) return undefined;
    if (Date.now() > entry.ttl) {
      this.routingTable.delete(objectId);
      return undefined;
    }
    return entry.peerId;
  }

  /**
   * MessageInterceptor.intercept — called for every outbound message.
   *
   * If the recipient is a known remote object, forward via PeerTransport
   * and return 'drop' (we've handled delivery). Otherwise return 'pass'.
   */
  async intercept(message: AbjectMessage): Promise<'pass' | 'drop' | AbjectMessage> {
    const recipient = message.routing.to;

    // Check if recipient is known to be remote
    const peerId = this.getRoute(recipient);
    if (!peerId) {
      return 'pass'; // Not a remote object — let normal delivery proceed
    }

    // Get the transport for this peer
    const transport = this.peerRegistry.getTransportForPeer(peerId);
    if (!transport || !transport.isConnected) {
      // Peer not connected — can't deliver
      console.warn(`[NetworkBridge] Cannot route to ${recipient.slice(0, 8)}: peer ${peerId.slice(0, 16)} not connected`);
      return 'pass'; // Fall through to normal undeliverable handling
    }

    // Forward via PeerTransport
    try {
      await transport.send(message);
      return 'drop'; // We handled delivery
    } catch (err) {
      console.error(`[NetworkBridge] Failed to forward message to peer ${peerId.slice(0, 16)}:`, err);
      return 'pass'; // Fall through to normal error handling
    }
  }

  /**
   * Handle a message received from a remote peer.
   * Inject it into the local MessageBus for delivery.
   */
  private handleIncomingMessage(message: AbjectMessage): void {
    // Record the sender's location for reply routing
    const senderPeerId = this.findPeerForMessage(message);
    if (senderPeerId) {
      this.routingTable.set(message.routing.from, {
        peerId: senderPeerId,
        ttl: Date.now() + ROUTE_TTL,
      });
    }

    // Inject into local bus
    this.bus.send(message).catch((err) => {
      console.error('[NetworkBridge] Failed to inject remote message:', err);
    });
  }

  /**
   * Determine which peer sent a message by checking all connected transports.
   */
  private findPeerForMessage(message: AbjectMessage): PeerId | undefined {
    // Check if we already have a route for the sender
    const existing = this.routingTable.get(message.routing.from);
    if (existing && Date.now() < existing.ttl) {
      return existing.peerId;
    }

    // Check connected peers — the message came from one of them
    for (const peerId of this.peerRegistry.getConnectedPeers()) {
      // The peer that the message came from is determined by the transport layer
      // For now, use the routing table or assume it's a known peer
      return peerId;
    }

    return undefined;
  }

  /**
   * Get current routing table size.
   */
  get routeCount(): number {
    return this.routingTable.size;
  }
}
