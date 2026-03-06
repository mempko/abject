/**
 * PeerDiscoveryObject — gossip-based peer discovery for resilient mesh networking.
 *
 * Enables peers to discover each other through gossip rather than relying solely
 * on a central signaling server. Implements:
 * - Peer exchange: connected peers share their peer lists periodically
 * - Find peer gossip: flood-based query to find a specific peer (TTL-limited)
 * - Speculative mesh connections: proactively connect to discovered peers
 * - Discovery cache with TTL-based eviction
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { event as createEvent } from '../core/message.js';
import type { PeerId, PeerIdentity } from '../core/identity.js';
import type { PeerRegistry } from './peer-registry.js';
import type { SignalingRelayObject } from './signaling-relay.js';

const PEER_DISCOVERY_INTERFACE = 'abjects:peer-discovery' as InterfaceId;
const PEER_REGISTRY_ID = 'abjects:peer-registry' as AbjectId;

export const PEER_DISCOVERY_ID = 'abjects:peer-discovery' as AbjectId;

const MAX_CACHE = 200;
const CACHE_TTL = 10 * 60 * 1000;  // 10 minutes
const EXCHANGE_INTERVAL = 3 * 60 * 1000;  // 3 minutes
const MAX_PER_EXCHANGE = 50;
const FIND_TIMEOUT = 5000;  // 5 seconds
const FIND_MAX_TTL = 2;
const SPECULATIVE_COOLDOWN = EXCHANGE_INTERVAL;  // 1 per exchange interval

interface DiscoveryCacheEntry {
  identity: PeerIdentity;
  reachableVia: Set<PeerId>;
  lastSeen: number;
}

export class PeerDiscoveryObject extends Abject {
  private peerRegistry?: PeerRegistry;
  private signalingRelay?: SignalingRelayObject;
  private localPeerId?: PeerId;

  private discoveryCache: Map<PeerId, DiscoveryCacheEntry> = new Map();
  private pendingFinds: Map<string, { resolve: (found: boolean) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private exchangeTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private lastSpeculativeConnect = 0;

  constructor() {
    super({
      manifest: {
        name: 'PeerDiscovery',
        description:
          'Gossip-based peer discovery. Peers exchange peer lists and find each other through the mesh without a central server.',
        version: '1.0.0',
        interface: {
          id: PEER_DISCOVERY_INTERFACE,
          name: 'PeerDiscovery',
          description: 'Gossip-based peer discovery',
          methods: [
            {
              name: 'findPeer',
              description: 'Find a peer through gossip (returns true if found within timeout)',
              parameters: [
                { name: 'targetPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to find' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getDiscoveryStats',
              description: 'Get discovery statistics',
              parameters: [],
              returns: { kind: 'object', properties: {
                cacheSize: { kind: 'primitive', primitive: 'number' },
                connectedNetworkPeers: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'getDiscoveredPeers',
              description: 'List all discovered peer identities in cache',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'PeerIdentity' } },
            },
          ],
          events: [
            {
              name: 'peerDiscovered',
              description: 'A new peer was discovered via gossip',
              payload: { kind: 'object', properties: {
                peerId: { kind: 'primitive', primitive: 'string' },
                name: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'peerExchangeReceived',
              description: 'A peer exchange was received from a connected peer',
              payload: { kind: 'object', properties: {
                fromPeerId: { kind: 'primitive', primitive: 'string' },
                peerCount: { kind: 'primitive', primitive: 'number' },
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

  /**
   * Wire dependencies.
   */
  setPeerRegistry(registry: PeerRegistry): void {
    this.peerRegistry = registry;
    this.localPeerId = registry.getLocalPeerId();

    // Listen for gossip messages from remote peers
    registry.onPeerDiscoveryMessage((msg, fromPeerId) => {
      this.handleGossipMessage(msg, fromPeerId);
    });
  }

  setSignalingRelay(relay: SignalingRelayObject): void {
    this.signalingRelay = relay;
  }

  protected override async onInit(): Promise<void> {
    // Start periodic exchange and cleanup
    this.exchangeTimer = setInterval(() => {
      this.sendPeerExchangeToAll();
    }, EXCHANGE_INTERVAL);

    this.cleanupTimer = setInterval(() => {
      this.evictStaleEntries();
    }, CACHE_TTL / 2);
  }

  protected override async onStop(): Promise<void> {
    if (this.exchangeTimer) {
      clearInterval(this.exchangeTimer);
      this.exchangeTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    // Cancel pending finds
    for (const [, pending] of this.pendingFinds) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingFinds.clear();
    this.discoveryCache.clear();
  }

  // ==========================================================================
  // Handlers
  // ==========================================================================

  private setupHandlers(): void {
    this.on('findPeer', async (msg: AbjectMessage) => {
      const { targetPeerId } = msg.payload as { targetPeerId: string };
      return this.findPeerImpl(targetPeerId);
    });

    this.on('getDiscoveryStats', async () => {
      return {
        cacheSize: this.discoveryCache.size,
        connectedNetworkPeers: this.peerRegistry?.getConnectedPeers().length ?? 0,
      };
    });

    this.on('getDiscoveredPeers', async () => {
      return Array.from(this.discoveryCache.values()).map(entry => entry.identity);
    });
  }

  // ==========================================================================
  // Find Peer
  // ==========================================================================

  private async findPeerImpl(targetPeerId: string): Promise<boolean> {
    if (!this.peerRegistry) return false;

    // 1. Already connected?
    if (this.peerRegistry.hasTransportTo(targetPeerId)) return true;

    // 2. In discovery cache with known relay?
    const cached = this.discoveryCache.get(targetPeerId);
    if (cached && cached.reachableVia.size > 0) {
      // Try connecting via relay
      const relayPeerId = cached.reachableVia.values().next().value;
      if (relayPeerId && this.signalingRelay && this.peerRegistry.hasTransportTo(relayPeerId)) {
        this.peerRegistry.connectToPeerViaRelay(targetPeerId, this.signalingRelay).catch(() => {});
        return true;
      }
    }

    // 3. Send _findPeer gossip and wait
    const queryId = `find-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFinds.delete(queryId);
        resolve(false);
      }, FIND_TIMEOUT);

      this.pendingFinds.set(queryId, { resolve, timer });

      // Broadcast find request to all connected peers
      this.broadcastFindPeer(targetPeerId, queryId, FIND_MAX_TTL);
    });

    return found;
  }

  private broadcastFindPeer(targetPeerId: string, queryId: string, ttl: number): void {
    if (!this.peerRegistry || !this.localPeerId) return;

    const connectedPeers = this.peerRegistry.getConnectedPeers();
    for (const peerId of connectedPeers) {
      const findMsg = createEvent(this.id, PEER_REGISTRY_ID, '_findPeer', {
        targetPeerId,
        originPeerId: this.localPeerId,
        queryId,
        ttl,
      });
      this.peerRegistry.sendToPeer(peerId, findMsg).catch(console.error);
    }
  }

  // ==========================================================================
  // Peer Exchange
  // ==========================================================================

  /**
   * Send our connected peer list to all connected peers.
   */
  private sendPeerExchangeToAll(): void {
    if (!this.peerRegistry || !this.localPeerId) return;

    const connectedPeers = this.peerRegistry.getConnectedPeers();
    if (connectedPeers.length === 0) return;

    // Build peer list (only currently connected peers, capped at MAX_PER_EXCHANGE)
    const peerList = connectedPeers.slice(0, MAX_PER_EXCHANGE).map(peerId => ({
      peerId,
      name: '',  // We don't have names for all peers
    }));

    for (const peerId of connectedPeers) {
      const exchangeMsg = createEvent(this.id, PEER_REGISTRY_ID, '_peerExchange', {
        fromPeerId: this.localPeerId,
        peers: peerList.filter(p => p.peerId !== peerId),  // Don't include recipient in their own list
      });
      this.peerRegistry.sendToPeer(peerId, exchangeMsg).catch(console.error);
    }
  }

  /**
   * Send a peer exchange to a specific newly connected peer.
   */
  sendPeerExchangeTo(peerId: PeerId): void {
    if (!this.peerRegistry || !this.localPeerId) return;

    const connectedPeers = this.peerRegistry.getConnectedPeers();
    const peerList = connectedPeers
      .filter(p => p !== peerId)
      .slice(0, MAX_PER_EXCHANGE)
      .map(p => ({ peerId: p, name: '' }));

    if (peerList.length === 0) return;

    const exchangeMsg = createEvent(this.id, PEER_REGISTRY_ID, '_peerExchange', {
      fromPeerId: this.localPeerId,
      peers: peerList,
    });
    this.peerRegistry.sendToPeer(peerId, exchangeMsg).catch(console.error);
  }

  // ==========================================================================
  // Gossip Message Handling
  // ==========================================================================

  private handleGossipMessage(msg: AbjectMessage, fromPeerId: PeerId): void {
    const method = msg.routing.method;

    if (method === '_peerExchange') {
      this.handlePeerExchange(msg, fromPeerId);
    } else if (method === '_findPeer') {
      this.handleFindPeer(msg, fromPeerId);
    } else if (method === '_peerFound') {
      this.handlePeerFound(msg);
    }
  }

  private handlePeerExchange(msg: AbjectMessage, fromPeerId: PeerId): void {
    const { peers } = msg.payload as {
      fromPeerId: string;
      peers: Array<{ peerId: string; name: string }>;
    };

    this.changed('peerExchangeReceived', { fromPeerId, peerCount: peers.length });

    let newPeersDiscovered = 0;
    for (const peer of peers) {
      if (peer.peerId === this.localPeerId) continue;

      const existing = this.discoveryCache.get(peer.peerId);
      if (existing) {
        existing.reachableVia.add(fromPeerId);
        existing.lastSeen = Date.now();
      } else {
        this.discoveryCache.set(peer.peerId, {
          identity: {
            peerId: peer.peerId,
            publicSigningKey: '',
            publicExchangeKey: '',
            name: peer.name || peer.peerId.slice(0, 12) + '...',
          },
          reachableVia: new Set([fromPeerId]),
          lastSeen: Date.now(),
        });
        newPeersDiscovered++;
        this.changed('peerDiscovered', {
          peerId: peer.peerId,
          name: peer.name || peer.peerId.slice(0, 12) + '...',
        });
      }
    }

    // Prune cache if over limit
    this.pruneCache();

    // Speculative mesh connection
    if (newPeersDiscovered > 0) {
      this.maybeSpeculativeConnect();
    }
  }

  private handleFindPeer(msg: AbjectMessage, fromPeerId: PeerId): void {
    const { targetPeerId, originPeerId, queryId, ttl } = msg.payload as {
      targetPeerId: string; originPeerId: string; queryId: string; ttl: number;
    };

    if (!this.peerRegistry || !this.localPeerId) return;

    // If we're connected to the target, reply with _peerFound
    if (this.peerRegistry.hasTransportTo(targetPeerId)) {
      const foundMsg = createEvent(this.id, PEER_REGISTRY_ID, '_peerFound', {
        targetPeerId,
        originPeerId,
        queryId,
        foundByPeerId: this.localPeerId,
      });
      // Reply to the origin peer (via the sender if needed)
      this.peerRegistry.sendToPeer(fromPeerId, foundMsg).catch(console.error);
      return;
    }

    // Forward to other connected peers with TTL-1
    if (ttl > 1) {
      const connectedPeers = this.peerRegistry.getConnectedPeers();
      for (const peerId of connectedPeers) {
        if (peerId === fromPeerId || peerId === originPeerId) continue;
        const fwdMsg = createEvent(this.id, PEER_REGISTRY_ID, '_findPeer', {
          targetPeerId,
          originPeerId,
          queryId,
          ttl: ttl - 1,
        });
        this.peerRegistry.sendToPeer(peerId, fwdMsg).catch(console.error);
      }
    }
  }

  private handlePeerFound(msg: AbjectMessage): void {
    const { targetPeerId, queryId, foundByPeerId } = msg.payload as {
      targetPeerId: string; originPeerId: string; queryId: string; foundByPeerId: string;
    };

    // Update discovery cache
    const existing = this.discoveryCache.get(targetPeerId);
    if (existing) {
      existing.reachableVia.add(foundByPeerId);
      existing.lastSeen = Date.now();
    } else {
      this.discoveryCache.set(targetPeerId, {
        identity: {
          peerId: targetPeerId,
          publicSigningKey: '',
          publicExchangeKey: '',
          name: targetPeerId.slice(0, 12) + '...',
        },
        reachableVia: new Set([foundByPeerId]),
        lastSeen: Date.now(),
      });
    }

    // Resolve pending find if it's ours
    const pending = this.pendingFinds.get(queryId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingFinds.delete(queryId);
      pending.resolve(true);
    }
  }

  // ==========================================================================
  // Speculative Mesh
  // ==========================================================================

  private maybeSpeculativeConnect(): void {
    if (!this.peerRegistry || !this.signalingRelay) return;

    // Rate limit
    if (Date.now() - this.lastSpeculativeConnect < SPECULATIVE_COOLDOWN) return;

    const connectedPeers = new Set(this.peerRegistry.getConnectedPeers());
    const networkPeerCount = connectedPeers.size;

    // Only speculate if below MAX_NETWORK_PEERS
    if (networkPeerCount >= 20) return;

    // Find a discovered peer we're not connected to, preferring those reachable via multiple intermediaries
    let bestPeer: PeerId | undefined;
    let bestScore = 0;

    for (const [peerId, entry] of this.discoveryCache) {
      if (peerId === this.localPeerId) continue;
      if (connectedPeers.has(peerId)) continue;

      const score = entry.reachableVia.size;
      if (score > bestScore) {
        bestScore = score;
        bestPeer = peerId;
      }
    }

    if (bestPeer) {
      this.lastSpeculativeConnect = Date.now();
      console.log(`[PeerDiscovery] Speculative connect to ${bestPeer.slice(0, 16)} (score=${bestScore})`);
      this.peerRegistry.connectToPeerViaRelay(bestPeer, this.signalingRelay).catch(() => {});
    }
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  private pruneCache(): void {
    if (this.discoveryCache.size <= MAX_CACHE) return;

    // Sort by lastSeen, remove oldest
    const entries = Array.from(this.discoveryCache.entries())
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);

    while (this.discoveryCache.size > MAX_CACHE && entries.length > 0) {
      const [peerId] = entries.shift()!;
      this.discoveryCache.delete(peerId);
    }
  }

  private evictStaleEntries(): void {
    const now = Date.now();
    for (const [peerId, entry] of this.discoveryCache) {
      if (now - entry.lastSeen > CACHE_TTL) {
        this.discoveryCache.delete(peerId);
      }
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}
