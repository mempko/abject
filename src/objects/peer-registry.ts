/**
 * Peer registry — manages contacts, peer connections, and discovery.
 *
 * Acts as the social layer: tracks known peers, their connection states,
 * and orchestrates WebRTC connections via the signaling server.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { Capabilities } from '../core/capability.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest, event as createEvent } from '../core/message.js';
import type { PeerId, PeerIdentity, PeerContact, PeerConnectionState } from '../core/identity.js';
import { SignalingClient } from '../network/signaling.js';
import type { SignalingRelay } from '../network/signaling.js';
import { PeerTransport, PeerTransportConfig } from '../network/peer-transport.js';
import { Log } from '../core/timed-log.js';

const log = new Log('PeerRegistry');

const PEER_REGISTRY_INTERFACE = 'abjects:peer-registry' as InterfaceId;
const IDENTITY_INTERFACE = 'abjects:identity' as InterfaceId;
const STORAGE_INTERFACE = 'abjects:storage' as InterfaceId;
const STORAGE_KEY_CONTACTS = 'peer-registry:contacts';
const STORAGE_KEY_SIGNALING_URLS = 'peer-registry:signaling-urls';
const STORAGE_KEY_REMOVED_SIGNALING = 'peer-registry:removed-signaling-urls';
const STORAGE_KEY_BLOCKED = 'peer-registry:blocked-peers';
const STORAGE_KEY_GOSSIP_PEERS = 'peer-registry:gossip-peers';
const MAX_GOSSIP_PEERS = 30;
const DEFAULT_SIGNALING_URL = 'wss://signal.abject.world';

export const PEER_REGISTRY_ID = 'abjects:peer-registry' as AbjectId;

interface NetworkPeerEntry {
  identity: { peerId: string; publicSigningKey: string; publicExchangeKey: string; name: string };
  connectedAt: number;
}

interface StoredContact {
  peerId: string;
  publicSigningKey: string;
  publicExchangeKey: string;
  name: string;
  addresses: string[];
  addedAt: number;
  lastSeen?: number;
}

interface StoredGossipPeer {
  peerId: string;
  publicSigningKey: string;
  publicExchangeKey: string;
  name: string;
  signalingUrls: string[];
  lastSeen: number;
}

export class PeerRegistry extends Abject {
  private contacts: Map<PeerId, PeerContact> = new Map();
  private blockedPeers: Set<PeerId> = new Set();
  private transports: Map<PeerId, PeerTransport> = new Map();
  private signalingClients: Map<string, SignalingClient> = new Map();
  private savedSignalingUrls: Set<string> = new Set();
  /** URLs the user explicitly removed — prevents gossip from re-adding them. */
  private removedSignalingUrls: Set<string> = new Set();
  private identityId?: AbjectId;
  private storageId?: AbjectId;
  private localIdentity?: PeerIdentity & { exchangePrivateKey?: CryptoKey };

  // Signaling relay fallback (peer-based relay when servers are down)
  private signalingRelayRef?: SignalingRelay;

  // Auto-connect state
  private manuallyDisconnected: Set<PeerId> = new Set();
  private autoConnectTimer?: ReturnType<typeof setInterval>;
  private static readonly AUTO_CONNECT_INTERVAL = 30_000; // 30s
  private static readonly STALE_OFFER_TIMEOUT = 15_000; // 15s
  private offerTimestamps: Map<string, number> = new Map();

  // Network peers (non-contact connected peers, transient — not persisted)
  private networkPeers: Map<PeerId, NetworkPeerEntry> = new Map();
  // Phase 6c: Configurable connection limit (default 20)
  private maxNetworkPeers = 20;

  // Signaling peers (all peers registered on each signaling server)
  private signalingPeers: Map<string, Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string }>> = new Map();

  // Persisted gossip peers (non-contacts seen on signaling servers)
  private gossipPeers: Map<string, StoredGossipPeer> = new Map();

  // Track which signaling URL facilitated each transport
  private transportSignalingUrl: Map<string, string> = new Map();

  // Pending introductions awaiting user acceptance
  private pendingIntroductions: Map<PeerId, {
    peerId: string;
    publicSigningKey: string;
    publicExchangeKey: string;
    name: string;
    fromPeerId: string;
    receivedAt: number;
  }> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'PeerRegistry',
        description:
          'Manages peer contacts, connection states, and orchestrates WebRTC peer-to-peer connections via signaling servers.',
        version: '1.0.0',
        interface: {
            id: PEER_REGISTRY_INTERFACE,
            name: 'PeerRegistry',
            description: 'Peer contact management and connection control',
            methods: [
              {
                name: 'addContact',
                description: 'Add a peer as a contact',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to add' },
                  { name: 'publicSigningKey', type: { kind: 'primitive', primitive: 'string' }, description: 'JWK signing key' },
                  { name: 'publicExchangeKey', type: { kind: 'primitive', primitive: 'string' }, description: 'JWK exchange key' },
                  { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Display name', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'removeContact',
                description: 'Remove a peer contact',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to remove' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listContacts',
                description: 'List all known contacts with their connection states',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'PeerContact' } },
              },
              {
                name: 'getContactState',
                description: 'Get the connection state of a specific contact',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'connectToPeer',
                description: 'Initiate a WebRTC connection to a peer',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to connect to' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'disconnectPeer',
                description: 'Disconnect from a peer',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to disconnect' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'connectSignaling',
                description: 'Connect to a signaling server',
                parameters: [
                  { name: 'url', type: { kind: 'primitive', primitive: 'string' }, description: 'WebSocket URL of signaling server' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'findPeer',
                description: 'Search for a peer via signaling servers',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to search for' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getTransport',
                description: 'Get the transport for a connected peer (for PeerRouter)',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID' },
                ],
                returns: { kind: 'reference', reference: 'PeerTransport' },
              },
              {
                name: 'disconnectSignaling',
                description: 'Disconnect from a signaling server by URL',
                parameters: [
                  { name: 'url', type: { kind: 'primitive', primitive: 'string' }, description: 'WebSocket URL of signaling server' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getSignalingUrls',
                description: 'Get the list of connected signaling server URLs',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'listSignalingServers',
                description: 'List all configured signaling servers with their connection status',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SignalingServerInfo' } },
              },
              {
                name: 'removeSignalingServer',
                description: 'Remove a signaling server (disconnect and forget)',
                parameters: [
                  { name: 'url', type: { kind: 'primitive', primitive: 'string' }, description: 'WebSocket URL of signaling server' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'introduceContact',
                description: 'Introduce one of your contacts to another connected peer',
                parameters: [
                  { name: 'contactId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID of the contact to introduce' },
                  { name: 'toPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID of the recipient' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'acceptIntroduction',
                description: 'Accept a pending contact introduction',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID from the introduction' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'rejectIntroduction',
                description: 'Reject a pending contact introduction',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID from the introduction' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listPendingIntroductions',
                description: 'List all pending contact introductions awaiting acceptance',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'PendingIntroduction' } },
              },
              {
                name: 'getMediaPeerConnection',
                description: 'Get the RTCPeerConnection for a peer (for MediaStream track management)',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID' },
                ],
                returns: { kind: 'reference', reference: 'RTCPeerConnection' },
              },
              {
                name: 'getConnectedPeers',
                description: 'Get all connected peer IDs',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'listNetworkPeers',
                description: 'List non-contact connected peers (network mesh participants)',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'NetworkPeerInfo' } },
              },
              {
                name: 'promoteToContact',
                description: 'Promote a network peer to a trusted contact',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to promote' },
                  { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Display name', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getNetworkPeerCount',
                description: 'Get the count of connected network peers',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'listSignalingPeers',
                description: 'List peers registered on connected signaling servers (excluding self and contacts)',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SignalingPeerInfo' } },
              },
              {
                name: 'blockPeer',
                description: 'Block a peer — disconnect, remove from contacts/network, prevent future connections',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to block' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unblockPeer',
                description: 'Unblock a previously blocked peer',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to unblock' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listBlockedPeers',
                description: 'List all blocked peer IDs',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'isBlocked',
                description: 'Check if a peer is blocked',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID to check' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'contactConnected',
                description: 'A contact has connected',
                payload: { kind: 'object', properties: { peerId: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'contactDisconnected',
                description: 'A contact has disconnected',
                payload: { kind: 'object', properties: { peerId: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'contactIntroduced',
                description: 'A new contact was discovered via signaling',
                payload: { kind: 'reference', reference: 'PeerIdentity' },
              },
              {
                name: 'signalingStateChanged',
                description: 'A signaling server changed connection state',
                payload: { kind: 'object', properties: {
                  url: { kind: 'primitive', primitive: 'string' },
                  status: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'introductionReceived',
                description: 'A contact introduction was received from a connected peer',
                payload: { kind: 'object', properties: {
                  fromPeerId: { kind: 'primitive', primitive: 'string' },
                  introducedPeerId: { kind: 'primitive', primitive: 'string' },
                  introducedName: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'networkPeerConnected',
                description: 'A non-contact peer has connected (network mesh participant)',
                payload: { kind: 'object', properties: {
                  peerId: { kind: 'primitive', primitive: 'string' },
                  name: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'networkPeerDisconnected',
                description: 'A non-contact peer has disconnected',
                payload: { kind: 'object', properties: {
                  peerId: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'signalingPeersUpdated',
                description: 'The list of peers on signaling servers has been refreshed',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'peerBlocked',
                description: 'A peer has been blocked',
                payload: { kind: 'object', properties: { peerId: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'peerUnblocked',
                description: 'A peer has been unblocked',
                payload: { kind: 'object', properties: { peerId: { kind: 'primitive', primitive: 'string' } } },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.PEER_CONNECT,
          Capabilities.PEER_DISCOVER,
        ],
        tags: ['system', 'peer'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('addContact', async (msg: AbjectMessage) => {
      const { peerId, publicSigningKey, publicExchangeKey, name } = msg.payload as {
        peerId: string; publicSigningKey: string; publicExchangeKey: string; name?: string;
      };
      return this.addContact(peerId, publicSigningKey, publicExchangeKey, name ?? '');
    });

    this.on('removeContact', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.removeContactImpl(peerId);
    });

    this.on('listContacts', async () => {
      return this.listContactsImpl();
    });

    this.on('getContactState', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      const contact = this.contacts.get(peerId);
      return contact?.state ?? 'offline';
    });

    this.on('connectToPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.connectToPeer(peerId);
    });

    this.on('disconnectPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.disconnectPeer(peerId);
    });

    this.on('connectSignaling', async (msg: AbjectMessage) => {
      const { url } = msg.payload as { url: string };
      // User explicitly connecting — clear from removed list and persist
      this.removedSignalingUrls.delete(url);
      this.savedSignalingUrls.add(url);
      await this.persistSignalingUrls();
      await this.persistRemovedSignalingUrls();
      return this.connectSignalingImpl(url);
    });

    this.on('findPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      this.findPeerViaSignaling(peerId);
      return true;
    });

    this.on('getTransport', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      const transport = this.transports.get(peerId);
      return transport ? { connected: transport.isConnected, encrypted: transport.isEncrypted } : null;
    });

    this.on('disconnectSignaling', async (msg: AbjectMessage) => {
      const { url } = msg.payload as { url: string };
      return this.disconnectSignalingImpl(url);
    });

    this.on('getSignalingUrls', async () => {
      return this.getSignalingUrls();
    });

    this.on('addSignalingUrl', async (msg: AbjectMessage) => {
      const { url } = msg.payload as { url: string };
      return this.addSignalingUrl(url);
    });

    this.on('listSignalingServers', async () => {
      return this.listSignalingServersImpl();
    });

    this.on('removeSignalingServer', async (msg: AbjectMessage) => {
      const { url } = msg.payload as { url: string };
      return this.removeSignalingServer(url);
    });

    this.on('introduceContact', async (msg: AbjectMessage) => {
      const { contactId, toPeerId } = msg.payload as { contactId: string; toPeerId: string };
      return this.introduceContactImpl(contactId, toPeerId);
    });

    this.on('acceptIntroduction', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.acceptIntroductionImpl(peerId);
    });

    this.on('rejectIntroduction', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.rejectIntroductionImpl(peerId);
    });

    this.on('listPendingIntroductions', async () => {
      return Array.from(this.pendingIntroductions.values()).map(i => ({
        peerId: i.peerId,
        name: i.name,
        fromPeerId: i.fromPeerId,
        receivedAt: i.receivedAt,
      }));
    });

    this.on('getMediaPeerConnection', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      const transport = this.transports.get(peerId);
      if (!transport?.isConnected) return null;
      const pc = transport.rtcPeerConnection;
      return pc ? { peerConnection: pc } : null;
    });

    this.on('getConnectedPeers', async () => {
      return this.getConnectedPeers();
    });

    this.on('listNetworkPeers', async () => {
      return this.listNetworkPeersImpl();
    });

    this.on('promoteToContact', async (msg: AbjectMessage) => {
      const { peerId, name } = msg.payload as { peerId: string; name?: string };
      return this.promoteToContactImpl(peerId, name);
    });

    this.on('getNetworkPeerCount', async () => {
      return this.networkPeers.size;
    });

    this.on('listSignalingPeers', async () => {
      return this.listSignalingPeersImpl();
    });

    this.on('blockPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.blockPeerImpl(peerId);
    });

    this.on('unblockPeer', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.unblockPeerImpl(peerId);
    });

    this.on('listBlockedPeers', async () => {
      return Array.from(this.blockedPeers);
    });

    this.on('isBlocked', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.blockedPeers.has(peerId);
    });
  }

  protected override async onInit(): Promise<void> {
    // Require dependencies — PeerRegistry needs both Identity and Storage
    this.identityId = await this.requireDep('Identity');
    this.storageId = await this.requireDep('Storage');

    // Load local identity
    await this.loadLocalIdentity();

    // Load blocked peers from storage
    await this.loadBlockedPeers();

    // Load contacts from storage
    await this.loadContacts();

    // Load persisted gossip peers
    await this.loadGossipPeers();

    // Load removed signaling URLs before reconnecting (prevents gossip re-addition)
    await this.loadRemovedSignalingUrls();

    // Auto-reconnect to saved signaling servers (non-blocking — reconnect runs in background)
    this.loadAndReconnectSignaling().catch(() => {});

    // Start auto-connect for contacts
    this.startAutoConnect();
    this.autoConnectAll();
  }

  protected override async onStop(): Promise<void> {
    this.stopAutoConnect();

    // Disconnect all peers
    for (const [, transport] of this.transports) {
      await transport.disconnect();
    }
    this.transports.clear();
    this.networkPeers.clear();

    // Disconnect all signaling clients
    for (const [, client] of this.signalingClients) {
      await client.disconnect();
    }
    this.signalingClients.clear();
  }

  // ==========================================================================
  // Contact Management
  // ==========================================================================

  private async addContact(
    peerId: string,
    publicSigningKey: string,
    publicExchangeKey: string,
    name: string,
  ): Promise<boolean> {
    // Reject adding a blocked peer as contact
    if (this.blockedPeers.has(peerId)) return false;

    // Import the contact's keys into Identity for crypto operations
    if (this.identityId) {
      await this.request(
        createRequest(this.id, this.identityId, 'importContact', {
          peerId, publicSigningKey, publicExchangeKey,
        }),
      );
    }

    // If peer was a gossip peer, migrate their signaling URLs to contact addresses
    const gossipPeer = this.gossipPeers.get(peerId);
    const addresses = gossipPeer ? gossipPeer.signalingUrls.slice() : [];
    if (gossipPeer) {
      this.gossipPeers.delete(peerId);
      this.persistGossipPeers().catch(() => {});
    }

    const contact: PeerContact = {
      identity: { peerId, publicSigningKey, publicExchangeKey, name },
      state: 'offline',
      addresses,
      addedAt: Date.now(),
    };
    this.contacts.set(peerId, contact);

    // If there's already a connected transport for this peer (e.g. they connected
    // to us before we added them as a contact), sync the contact state immediately.
    const existingTransport = this.transports.get(peerId);
    if (existingTransport?.isConnected) {
      contact.state = 'connected';
      contact.lastSeen = Date.now();
      this.changed('contactConnected', { peerId });
    }

    await this.persistContacts();
    this.autoConnectAll();
    return true;
  }

  private async removeContactImpl(peerId: string): Promise<boolean> {
    // Disconnect if connected
    const transport = this.transports.get(peerId);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(peerId);
    }

    const removed = this.contacts.delete(peerId);
    if (removed) {
      this.manuallyDisconnected.delete(peerId);
      await this.persistContacts();
    }
    return removed;
  }

  private listContactsImpl(): Array<{
    peerId: string; name: string; state: PeerConnectionState;
    addedAt: number; lastSeen?: number;
  }> {
    return Array.from(this.contacts.values()).map(c => ({
      peerId: c.identity.peerId,
      name: c.identity.name,
      state: c.state,
      addedAt: c.addedAt,
      lastSeen: c.lastSeen,
    }));
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  private async connectToPeer(peerId: string): Promise<boolean> {
    // User-initiated connect: remove from manually disconnected
    this.manuallyDisconnected.delete(peerId);

    const contact = this.contacts.get(peerId);
    if (!contact) return false;
    if (this.transports.has(peerId)) return true; // already connected

    precondition(this.localIdentity !== undefined, 'Local identity not loaded');
    precondition(this.localIdentity!.exchangePrivateKey !== undefined, 'Exchange private key not loaded');

    // Try signaling server first, then relay fallback
    let signalingRelay: SignalingRelay | undefined =
      this.getActiveSignalingClient() ?? this.signalingRelayRef;

    // Fallback: try signaling servers from contact's stored addresses
    if (!signalingRelay && contact.addresses.length > 0) {
      for (const addr of contact.addresses) {
        if (this.signalingClients.has(addr) || this.removedSignalingUrls.has(addr)) continue;
        try {
          await this.connectSignalingImpl(addr);
          signalingRelay = this.getActiveSignalingClient();
          if (signalingRelay) break;
        } catch { /* try next */ }
      }
    }

    if (!signalingRelay) {
      log.warn('No signaling server or relay available');
      return false;
    }

    // Track which signaling URL facilitated this connection
    const sigUrl = this.findSignalingUrlForRelay(signalingRelay);
    if (sigUrl) this.transportSignalingUrl.set(peerId, sigUrl);

    this.setContactState(peerId, 'connecting');

    const transport = new PeerTransport({
      localPeerId: this.localIdentity!.peerId,
      remotePeerId: peerId,
      signalingClient: signalingRelay,
      localPublicSigningKey: this.localIdentity!.publicSigningKey,
      localPublicExchangeKey: this.localIdentity!.publicExchangeKey,
      localExchangePrivateKey: this.localIdentity!.exchangePrivateKey!,
    });

    this.setupTransportEvents(transport, peerId);
    this.transports.set(peerId, transport);
    this.offerTimestamps.set(peerId, Date.now());

    try {
      await transport.connect('webrtc');
    } catch (err) {
      log.error(`Failed to connect to ${peerId.slice(0, 16)}:`, err);
      this.setContactState(peerId, 'offline');
      this.transports.delete(peerId);
      this.offerTimestamps.delete(peerId);
      return false;
    }

    return true;
  }

  private async disconnectPeer(peerId: string): Promise<boolean> {
    const transport = this.transports.get(peerId);
    if (!transport) return false;

    // Mark as manually disconnected so auto-connect skips it
    this.manuallyDisconnected.add(peerId);

    await transport.disconnect();
    this.transports.delete(peerId);
    this.setContactState(peerId, 'offline');
    return true;
  }

  /**
   * Get the PeerTransport for a connected peer.
   * Used by PeerRouter for routing messages.
   */
  getTransportForPeer(peerId: PeerId): PeerTransport | undefined {
    return this.transports.get(peerId);
  }

  /**
   * Get the local peer ID.
   */
  getLocalPeerId(): PeerId {
    return (this.localIdentity?.peerId ?? '') as PeerId;
  }

  /**
   * Phase 6c: Set the maximum number of network peer connections.
   * Default is 20. With 20 connections per peer, network diameter for
   * 10K peers ≈ log₂₀(10000) ≈ 3.3 hops.
   */
  setMaxNetworkPeers(max: number): void {
    this.maxNetworkPeers = Math.max(1, Math.floor(max));
  }

  getMaxNetworkPeers(): number {
    return this.maxNetworkPeers;
  }

  /**
   * Set a SignalingRelay fallback for when no signaling server is available.
   */
  setSignalingRelay(relay: SignalingRelay): void {
    this.signalingRelayRef = relay;
  }

  /**
   * Get all connected peer IDs.
   */
  getConnectedPeers(): PeerId[] {
    return Array.from(this.transports.entries())
      .filter(([, t]) => t.isConnected)
      .map(([peerId]) => peerId);
  }

  // ==========================================================================
  // Signaling
  // ==========================================================================

  /**
   * Get all known signaling server URLs (connected + saved).
   */
  getSignalingUrls(): string[] {
    const urls = new Set<string>(this.signalingClients.keys());
    for (const url of this.savedSignalingUrls) urls.add(url);
    return Array.from(urls);
  }

  /**
   * Add a signaling server URL (from gossip or federation).
   * Persists the URL and attempts connection.
   */
  async addSignalingUrl(url: string): Promise<boolean> {
    if (this.removedSignalingUrls.has(url)) return false;
    if (this.savedSignalingUrls.has(url) || this.signalingClients.has(url)) {
      return true; // Already known
    }
    this.savedSignalingUrls.add(url);
    await this.persistSignalingUrls();
    // Best-effort connection
    this.connectSignalingImpl(url).catch(() => {});
    return true;
  }

  /**
   * Add a signaling URL received via gossip (best-effort, no await).
   */
  addSignalingUrlFromGossip(url: string): void {
    if (this.removedSignalingUrls.has(url)) return;
    if (this.savedSignalingUrls.has(url) || this.signalingClients.has(url)) return;
    this.savedSignalingUrls.add(url);
    this.persistSignalingUrls().catch(() => {});
    this.connectSignalingImpl(url).catch(() => {});
  }

  private async connectSignalingImpl(url: string): Promise<boolean> {
    if (this.signalingClients.has(url)) return true;

    const client = new SignalingClient();
    client.setPersistent(true);

    client.on({
      onConnect: () => {
        log.info(`Connected to signaling server: ${url}`);
        // Register with the signaling server
        if (this.localIdentity) {
          client.register(
            this.localIdentity.peerId,
            this.localIdentity.publicSigningKey,
            this.localIdentity.publicExchangeKey,
            this.localIdentity.name,
          );
          // Request the list of all registered peers
          client.listPeers(this.localIdentity.peerId);
        }
        // Trigger auto-connect now that we have a signaling server
        this.autoConnectAll();
        this.changed('signalingStateChanged', { url, status: 'connected' });
      },
      onDisconnect: (reason) => {
        log.info(`Disconnected from signaling: ${reason}`);
        this.changed('signalingStateChanged', { url, status: 'disconnected' });
      },
      onPeerFound: (peerId, publicSigningKey, publicExchangeKey, name) => {
        this.handlePeerFound(peerId, publicSigningKey, publicExchangeKey, name);
      },
      onPeerNotFound: (peerId) => {
        log.info(`Peer not found: ${peerId.slice(0, 16)}`);
      },
      onSdpOffer: (fromPeerId, sdp) => {
        this.handleIncomingSdpOffer(fromPeerId, sdp, client).catch(e => {
          log.warn('handleIncomingSdpOffer failed, cleaning up transport:', e instanceof Error ? e.message : e);
          // Remove the broken transport so the next auto-connect cycle starts fresh
          const broken = this.transports.get(fromPeerId);
          if (broken) {
            this.transports.delete(fromPeerId);
            this.offerTimestamps.delete(fromPeerId);
          }
        });
      },
      onSdpAnswer: (fromPeerId, sdp) => {
        const transport = this.transports.get(fromPeerId);
        if (transport) {
          transport.handleSdpAnswer(sdp).catch(e => log.error('handleSdpAnswer failed:', e));
        }
      },
      onIceCandidate: (fromPeerId, candidate) => {
        const transport = this.transports.get(fromPeerId);
        if (transport) {
          transport.handleIceCandidate(candidate).catch(e => log.error('handleIceCandidate failed:', e));
        }
      },
      onPeerList: (peers) => {
        this.signalingPeers.set(url, peers);
        this.changed('signalingPeersUpdated', {});

        // Persist gossip peers with their signaling URLs
        for (const peer of peers) {
          if (peer.peerId === this.localIdentity?.peerId) continue;
          if (this.contacts.has(peer.peerId)) {
            // Update contact addresses with this signaling URL
            const contact = this.contacts.get(peer.peerId)!;
            if (!contact.addresses.includes(url)) {
              contact.addresses.push(url);
              if (contact.addresses.length > 5) contact.addresses.shift();
            }
          } else {
            // Store as gossip peer
            this.updateGossipPeer(peer.peerId, peer.publicSigningKey,
              peer.publicExchangeKey, peer.name, url);
          }
        }

        // Auto-connect to signaling peers for gossip bootstrap
        this.autoConnectSignalingPeers(url, client);
      },
      onError: (error) => {
        log.error(`Signaling error: ${error}`);
      },
    });

    // Always add to signalingClients so it can reconnect in the background
    this.signalingClients.set(url, client);

    try {
      await client.connect(url);
      return true;
    } catch (err) {
      log.error(`Failed to connect to signaling: ${url}`, err);
      // Client is still in the map — persistent reconnect will retry
      return false;
    }
  }

  private async disconnectSignalingImpl(url: string): Promise<boolean> {
    const client = this.signalingClients.get(url);
    if (!client) return false;

    await client.disconnect();
    this.signalingClients.delete(url);
    return true;
  }

  private async removeSignalingServer(url: string): Promise<boolean> {
    await this.disconnectSignalingImpl(url);
    this.savedSignalingUrls.delete(url);
    this.removedSignalingUrls.add(url);
    await this.persistSignalingUrls();
    await this.persistRemovedSignalingUrls();
    return true;
  }

  private listSignalingServersImpl(): Array<{ url: string; status: string }> {
    return Array.from(this.savedSignalingUrls).map(url => {
      const client = this.signalingClients.get(url);
      return { url, status: client?.connectionState ?? 'disconnected' };
    });
  }

  private findPeerViaSignaling(peerId: string): void {
    for (const [, client] of this.signalingClients) {
      if (client.isConnected) {
        client.findPeer(peerId);
      }
    }
  }

  /**
   * Handle a peer found via signaling — auto-add as contact if not known.
   */
  private handlePeerFound(
    peerId: string,
    publicSigningKey: string,
    publicExchangeKey: string,
    name: string,
  ): void {
    if (!this.contacts.has(peerId)) {
      // Emit event for discovered peer
      this.changed('contactIntroduced', {
        peerId, publicSigningKey, publicExchangeKey, name,
      });
    }
  }

  /**
   * Handle incoming SDP offer — create a PeerTransport for the caller.
   */
  private async handleIncomingSdpOffer(
    fromPeerId: string,
    sdp: RTCSessionDescriptionInit,
    signalingClient: SignalingRelay,
  ): Promise<void> {
    precondition(this.localIdentity !== undefined, 'Local identity not loaded');
    precondition(this.localIdentity!.exchangePrivateKey !== undefined, 'Exchange private key not loaded');

    // Reject inbound offers from blocked peers
    if (this.blockedPeers.has(fromPeerId)) {
      log.info(`Rejecting SDP offer from blocked peer ${fromPeerId.slice(0, 16)}`);
      return;
    }

    // Reject network peer connections when at capacity
    if (!this.contacts.has(fromPeerId) && !this.transports.has(fromPeerId)) {
      if (this.networkPeers.size >= this.maxNetworkPeers) {
        log.info(`Rejecting network peer ${fromPeerId.slice(0, 16)}: at capacity (${this.maxNetworkPeers})`);
        return;
      }
    }

    // Mark known contacts as 'connecting' for accurate UI feedback
    this.setContactState(fromPeerId, 'connecting');

    // Auto-accept connections from known contacts
    let transport = this.transports.get(fromPeerId);

    // ICE glare detection: if we already have a transport with a pending local
    // offer, both peers sent offers simultaneously. Use a tiebreaker: the peer
    // with the lexicographically lower peerId keeps their offer (acts as caller).
    if (transport && transport.signalingState === 'have-local-offer') {
      if (this.localIdentity!.peerId < fromPeerId) {
        // We have priority — but our original offer may have been lost (peer wasn't
        // online yet). Since the remote peer is clearly online now (they just sent us
        // an offer), destroy the stale transport and create a fresh one.
        log.info(`ICE glare with ${fromPeerId.slice(0, 16)}: we win tiebreak, re-sending offer`);
        transport.resetForGlare();
        this.transports.delete(fromPeerId);
        this.offerTimestamps.delete(fromPeerId);

        const newTransport = new PeerTransport({
          localPeerId: this.localIdentity!.peerId,
          remotePeerId: fromPeerId,
          signalingClient,
          localPublicSigningKey: this.localIdentity!.publicSigningKey,
          localPublicExchangeKey: this.localIdentity!.publicExchangeKey,
          localExchangePrivateKey: this.localIdentity!.exchangePrivateKey!,
        });
        this.setupTransportEvents(newTransport, fromPeerId);
        this.transports.set(fromPeerId, newTransport);
        this.offerTimestamps.set(fromPeerId, Date.now());
        newTransport.connect('webrtc').catch((err) => {
          log.error(`Re-offer to ${fromPeerId.slice(0, 16)} failed:`, err);
          this.transports.delete(fromPeerId);
          this.offerTimestamps.delete(fromPeerId);
          this.setContactState(fromPeerId, 'offline');
        });
        return;
      }
      // They have priority — reset PeerConnection and accept their offer.
      // resetForGlare() destroys the PeerConnection without triggering
      // disconnect events, preserving queued ICE candidates from the winner.
      log.info(`ICE glare with ${fromPeerId.slice(0, 16)}: they win tiebreak, accepting remote offer`);
      transport.resetForGlare();
      // handleSdpOffer below will create a fresh PeerConnection
    }

    if (!transport) {
      transport = new PeerTransport({
        localPeerId: this.localIdentity!.peerId,
        remotePeerId: fromPeerId,
        signalingClient,
        localPublicSigningKey: this.localIdentity!.publicSigningKey,
        localPublicExchangeKey: this.localIdentity!.publicExchangeKey,
        localExchangePrivateKey: this.localIdentity!.exchangePrivateKey!,
      });
      this.setupTransportEvents(transport, fromPeerId);
      this.transports.set(fromPeerId, transport);
    }

    // Track signaling URL for this incoming connection
    const incomingSigUrl = this.findSignalingUrlForRelay(signalingClient);
    if (incomingSigUrl) this.transportSignalingUrl.set(fromPeerId, incomingSigUrl);

    await transport.handleSdpOffer(sdp);
  }

  // ==========================================================================
  // Auto-Connect
  // ==========================================================================

  private startAutoConnect(): void {
    if (this.autoConnectTimer) return;
    this.autoConnectTimer = setInterval(() => {
      this.autoConnectAll();
    }, PeerRegistry.AUTO_CONNECT_INTERVAL);
  }

  private stopAutoConnect(): void {
    if (this.autoConnectTimer) {
      clearInterval(this.autoConnectTimer);
      this.autoConnectTimer = undefined;
    }
  }

  /**
   * Try to connect to all offline contacts that haven't been manually disconnected.
   * Silently catches errors — auto-connect is best-effort.
   */
  private autoConnectAll(): void {
    if (!this.localIdentity) return;

    // Clean up stale offers — transports stuck in have-local-offer where the
    // remote peer never responded (e.g. they weren't online when we sent it)
    const now = Date.now();
    for (const [peerId, timestamp] of this.offerTimestamps) {
      if (now - timestamp < PeerRegistry.STALE_OFFER_TIMEOUT) continue;
      const transport = this.transports.get(peerId);
      if (transport && transport.signalingState === 'have-local-offer') {
        log.info(`Cleaning up stale offer to ${peerId.slice(0, 16)} (${Math.round((now - timestamp) / 1000)}s old)`);
        transport.resetForGlare();
        this.transports.delete(peerId);
        this.offerTimestamps.delete(peerId);
        this.setContactState(peerId, 'offline');
      } else {
        // Transport connected or was replaced — timestamp no longer relevant
        this.offerTimestamps.delete(peerId);
      }
    }

    const activeSignaling = this.getActiveSignalingClient();
    const hasSignaling = !!activeSignaling || !!this.signalingRelayRef;

    // If no signaling is available, try connecting to signaling servers
    // where gossip peers or contacts were last seen
    if (!hasSignaling) {
      this.tryAlternativeSignaling();
    }

    // Re-poll signaling for fresh peer lists so we discover peers that
    // (re)registered since our last list-peers request.
    if (activeSignaling && this.localIdentity) {
      activeSignaling.listPeers(this.localIdentity.peerId);
    }

    for (const [peerId, contact] of this.contacts) {
      if (contact.state !== 'offline') continue;
      if (this.blockedPeers.has(peerId)) continue;
      if (this.manuallyDisconnected.has(peerId)) continue;
      if (this.transports.has(peerId)) continue;

      this.connectToPeer(peerId).catch(() => {
        // Silently ignore — will retry on next interval
      });
    }
  }

  // ==========================================================================
  // Contact Introductions
  // ==========================================================================

  private async introduceContactImpl(contactId: string, toPeerId: string): Promise<boolean> {
    const contact = this.contacts.get(contactId);
    if (!contact) return false;

    const transport = this.transports.get(toPeerId);
    if (!transport?.isConnected) return false;

    // Send the contact's public identity to the target peer via DataChannel
    const introMsg = createEvent(this.id, PEER_REGISTRY_ID, '_introduction', {
      fromPeerId: this.localIdentity!.peerId,
      peerId: contact.identity.peerId,
      publicSigningKey: contact.identity.publicSigningKey,
      publicExchangeKey: contact.identity.publicExchangeKey,
      name: contact.identity.name,
    });

    await transport.send(introMsg);
    return true;
  }

  /**
   * Handle an introduction message received from a remote peer.
   * Called by the transport event handler when we get an _introduction message.
   */
  handleIntroductionMessage(msg: AbjectMessage): void {
    const { fromPeerId, peerId, publicSigningKey, publicExchangeKey, name } = msg.payload as {
      fromPeerId: string; peerId: string; publicSigningKey: string;
      publicExchangeKey: string; name: string;
    };

    // Don't accept introductions for ourselves or contacts we already have
    if (peerId === this.localIdentity?.peerId) return;
    if (this.contacts.has(peerId)) return;
    if (this.pendingIntroductions.has(peerId)) return;

    this.pendingIntroductions.set(peerId, {
      peerId, publicSigningKey, publicExchangeKey, name,
      fromPeerId, receivedAt: Date.now(),
    });

    this.changed('introductionReceived', {
      fromPeerId,
      introducedPeerId: peerId,
      introducedName: name,
    });
  }

  private async acceptIntroductionImpl(peerId: string): Promise<boolean> {
    const intro = this.pendingIntroductions.get(peerId);
    if (!intro) return false;
    if (this.blockedPeers.has(peerId)) return false;

    this.pendingIntroductions.delete(peerId);
    await this.addContact(
      intro.peerId,
      intro.publicSigningKey,
      intro.publicExchangeKey,
      intro.name,
    );
    return true;
  }

  private rejectIntroductionImpl(peerId: string): boolean {
    return this.pendingIntroductions.delete(peerId);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private setupTransportEvents(transport: PeerTransport, peerId: string): void {
    transport.on({
      onConnect: () => {
        // Only process if this transport is still the active one for this peer
        // (ICE glare can replace the transport before async events fire)
        if (this.transports.get(peerId) !== transport) return;
        this.offerTimestamps.delete(peerId);

        // Record signaling URL on contact or gossip peer
        const sigUrl = this.transportSignalingUrl.get(peerId);
        if (sigUrl) {
          const contact = this.contacts.get(peerId);
          if (contact && !contact.addresses.includes(sigUrl)) {
            contact.addresses.push(sigUrl);
            if (contact.addresses.length > 5) contact.addresses.shift();
            this.persistContacts().catch(() => {});
          }
          this.transportSignalingUrl.delete(peerId);
        }

        if (this.contacts.has(peerId)) {
          this.setContactState(peerId, 'connected');
          this.changed('contactConnected', { peerId });
        } else {
          // This is a network peer (not a contact)
          const name = transport.remotePeerId.slice(0, 12) + '...';
          this.networkPeers.set(peerId, {
            identity: { peerId, publicSigningKey: '', publicExchangeKey: '', name },
            connectedAt: Date.now(),
          });
          this.changed('networkPeerConnected', { peerId, name });

          // Update gossip peer with signaling URL if known
          if (sigUrl) {
            const np = this.networkPeers.get(peerId as any);
            if (np) {
              this.updateGossipPeer(peerId, np.identity.publicSigningKey,
                np.identity.publicExchangeKey, np.identity.name, sigUrl);
            }
          }
        }
        this.peerConnectedHandler?.(peerId);
      },
      onDisconnect: () => {
        // Only clean up if this transport is still the active one for this peer
        // (ICE glare can replace the transport before async events fire)
        if (this.transports.get(peerId) !== transport) return;
        this.offerTimestamps.delete(peerId);

        if (this.contacts.has(peerId)) {
          this.setContactState(peerId, 'offline');
        }
        if (this.networkPeers.has(peerId)) {
          this.networkPeers.delete(peerId);
          this.changed('networkPeerDisconnected', { peerId });
        }
        this.transports.delete(peerId);
        this.changed('contactDisconnected', { peerId });
      },
      onMessage: (message) => {
        // Intercept introduction messages before forwarding
        if (message.routing.method === '_introduction' &&
            message.routing.to === PEER_REGISTRY_ID) {
          this.handleIntroductionMessage(message);
          return;
        }

        // Intercept signaling relay messages
        if (message.routing.method === '_signalingRelay' &&
            message.routing.to === PEER_REGISTRY_ID) {
          this.signalingRelayHandler?.(message, peerId);
          return;
        }

        // Intercept peer exchange / find gossip messages
        if ((message.routing.method === '_peerExchange' ||
             message.routing.method === '_findPeer' ||
             message.routing.method === '_peerFound') &&
            message.routing.to === PEER_REGISTRY_ID) {
          this.peerDiscoveryHandler?.(message, peerId);
          return;
        }

        log.info(`inbound message from ${peerId.slice(0, 16)} to=${message.routing.to.slice(0, 20)} method=${(message.payload as any)?.method ?? '?'}`);
        // Messages from peers are forwarded to the local message bus
        // by the PeerRouter interceptor
        this.events.onMessage?.(message, peerId);
      },
      onError: (error) => {
        log.error(`Transport error with ${peerId.slice(0, 16)}:`, error);
      },
    });
  }

  // Event callback for incoming messages (used by PeerRouter)
  private events: { onMessage?: (msg: AbjectMessage, fromPeerId: PeerId) => void } = {};

  // Handler callbacks for SignalingRelay and PeerDiscovery objects
  private signalingRelayHandler?: (msg: AbjectMessage, fromPeerId: PeerId) => void;
  private peerDiscoveryHandler?: (msg: AbjectMessage, fromPeerId: PeerId) => void;
  private peerConnectedHandler?: (peerId: string) => void;

  /**
   * Set a handler for messages received from remote peers.
   */
  onRemoteMessage(handler: (msg: AbjectMessage, fromPeerId: PeerId) => void): void {
    this.events.onMessage = handler;
  }

  /**
   * Set a handler for signaling relay messages received from remote peers.
   */
  onSignalingRelayMessage(handler: (msg: AbjectMessage, fromPeerId: PeerId) => void): void {
    this.signalingRelayHandler = handler;
  }

  /**
   * Set a handler for peer discovery/gossip messages received from remote peers.
   */
  onPeerDiscoveryMessage(handler: (msg: AbjectMessage, fromPeerId: PeerId) => void): void {
    this.peerDiscoveryHandler = handler;
  }

  /**
   * Set a direct callback for when any peer connects (contact or network).
   * Bypasses the MessageBus to avoid bootstrap race conditions.
   */
  onPeerConnected(handler: (peerId: string) => void): void {
    this.peerConnectedHandler = handler;
  }

  /**
   * Send a raw message to a connected peer via their transport.
   * Used by SignalingRelayObject and PeerDiscoveryObject.
   */
  async sendToPeer(peerId: PeerId, message: AbjectMessage): Promise<boolean> {
    const transport = this.transports.get(peerId);
    if (!transport?.isConnected) return false;
    await transport.send(message);
    return true;
  }

  /**
   * Check if we have an active transport to a specific peer.
   */
  hasTransportTo(peerId: PeerId): boolean {
    const transport = this.transports.get(peerId);
    return !!transport?.isConnected;
  }

  /**
   * Initiate a WebRTC connection to a peer using a specific signaling relay.
   * Used by SignalingRelayObject for peer-relayed connections.
   */
  async connectToPeerViaRelay(peerId: string, relay: SignalingRelay): Promise<boolean> {
    if (this.blockedPeers.has(peerId)) return false;
    if (this.transports.has(peerId)) return true; // already connected

    precondition(this.localIdentity !== undefined, 'Local identity not loaded');
    precondition(this.localIdentity!.exchangePrivateKey !== undefined, 'Exchange private key not loaded');

    // Reject if at network peer capacity (for non-contacts)
    if (!this.contacts.has(peerId) && this.networkPeers.size >= this.maxNetworkPeers) {
      return false;
    }

    const transport = new PeerTransport({
      localPeerId: this.localIdentity!.peerId,
      remotePeerId: peerId,
      signalingClient: relay,
      localPublicSigningKey: this.localIdentity!.publicSigningKey,
      localPublicExchangeKey: this.localIdentity!.publicExchangeKey,
      localExchangePrivateKey: this.localIdentity!.exchangePrivateKey!,
    });

    this.setupTransportEvents(transport, peerId);
    this.transports.set(peerId, transport);
    this.offerTimestamps.set(peerId, Date.now());

    try {
      await transport.connect('webrtc');
    } catch (err) {
      log.error(`Failed to connect via relay to ${peerId.slice(0, 16)}:`, err);
      this.transports.delete(peerId);
      this.offerTimestamps.delete(peerId);
      return false;
    }

    return true;
  }

  private autoConnectSignalingPeers(url: string, client: SignalingClient): void {
    const peers = this.signalingPeers.get(url);
    if (!peers) return;
    const myPeerId = this.localIdentity?.peerId;
    if (!myPeerId) return;

    for (const peer of peers) {
      if (peer.peerId === myPeerId) continue;
      if (this.blockedPeers.has(peer.peerId)) continue;
      if (this.contacts.has(peer.peerId)) continue;
      if (this.transports.has(peer.peerId)) continue;
      this.connectToPeerViaRelay(peer.peerId, client).catch(() => {});
    }
  }

  private setContactState(peerId: string, state: PeerConnectionState): void {
    const contact = this.contacts.get(peerId);
    if (contact) {
      contact.state = state;
      if (state === 'connected') {
        contact.lastSeen = Date.now();
      }
    }
  }

  private getActiveSignalingClient(): SignalingClient | undefined {
    for (const [, client] of this.signalingClients) {
      if (client.isConnected) return client;
    }
    return undefined;
  }

  private async loadLocalIdentity(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<PeerIdentity>(
        createRequest(this.id, this.identityId, 'exportPublicKeys', {}),
      );
      // We also need the private exchange key for ECDH — import it
      // The IdentityObject handles crypto internally, but PeerTransport needs the raw key
      // for direct ECDH derivation. We'll derive it via IdentityObject.
      this.localIdentity = {
        ...identity,
        // The exchange private key is managed by IdentityObject;
        // PeerTransport will need it for session key derivation.
        // For now, generate a per-session ephemeral key and use the Identity object for persistent crypto.
      };

      // Generate ephemeral ECDH keys for PeerTransport sessions
      const ephemeral = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits', 'deriveKey'],
      );

      // Export and use the ephemeral keys for transport
      const pubJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
      this.localIdentity.publicExchangeKey = JSON.stringify(pubJwk);
      this.localIdentity.exchangePrivateKey = ephemeral.privateKey;
    } catch (err) {
      log.error('Failed to load local identity:', err);
    }
  }


  // ==========================================================================
  // Network Peers
  // ==========================================================================

  private listSignalingPeersImpl(): Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string; serverUrl: string }> {
    const myPeerId = this.localIdentity?.peerId;
    const contactIds = new Set(this.contacts.keys());
    const result: Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string; serverUrl: string }> = [];
    for (const [serverUrl, peers] of this.signalingPeers) {
      for (const p of peers) {
        if (p.peerId === myPeerId) continue;
        if (this.blockedPeers.has(p.peerId)) continue;
        if (contactIds.has(p.peerId)) continue;
        if (this.transports.has(p.peerId)) continue;
        result.push({ peerId: p.peerId, name: p.name, publicSigningKey: p.publicSigningKey, publicExchangeKey: p.publicExchangeKey, serverUrl });
      }
    }
    return result;
  }

  private listNetworkPeersImpl(): Array<{ peerId: string; name: string; connectedAt: number }> {
    return Array.from(this.networkPeers.values()).map(np => ({
      peerId: np.identity.peerId,
      name: np.identity.name,
      connectedAt: np.connectedAt,
    }));
  }

  private async promoteToContactImpl(peerId: string, name?: string): Promise<boolean> {
    const networkPeer = this.networkPeers.get(peerId);
    if (!networkPeer) return false;

    // Move from network peers to contacts
    this.networkPeers.delete(peerId);
    await this.addContact(
      networkPeer.identity.peerId,
      networkPeer.identity.publicSigningKey,
      networkPeer.identity.publicExchangeKey,
      name ?? networkPeer.identity.name,
    );
    return true;
  }

  // ==========================================================================
  // Block / Unblock
  // ==========================================================================

  private async blockPeerImpl(peerId: string): Promise<boolean> {
    this.blockedPeers.add(peerId);
    await this.persistBlockedPeers();

    // Disconnect transport if connected
    const transport = this.transports.get(peerId);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(peerId);
    }

    // Remove from contacts if present
    if (this.contacts.has(peerId)) {
      this.contacts.delete(peerId);
      this.manuallyDisconnected.delete(peerId);
      await this.persistContacts();
    }

    // Remove from network peers if present
    this.networkPeers.delete(peerId);

    // Remove from pending introductions
    this.pendingIntroductions.delete(peerId);

    this.changed('peerBlocked', { peerId });
    return true;
  }

  private async unblockPeerImpl(peerId: string): Promise<boolean> {
    const removed = this.blockedPeers.delete(peerId);
    if (removed) {
      await this.persistBlockedPeers();
      this.changed('peerUnblocked', { peerId });
    }
    return removed;
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  private async loadContacts(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<StoredContact[] | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_KEY_CONTACTS }),
      );
      if (Array.isArray(result)) {
        for (const stored of result) {
          const contact: PeerContact = {
            identity: {
              peerId: stored.peerId,
              publicSigningKey: stored.publicSigningKey,
              publicExchangeKey: stored.publicExchangeKey,
              name: stored.name,
            },
            state: 'offline',
            addresses: stored.addresses,
            addedAt: stored.addedAt,
            lastSeen: stored.lastSeen,
          };
          this.contacts.set(stored.peerId, contact);

          // Import keys into Identity
          if (this.identityId) {
            this.request(
              createRequest(this.id, this.identityId, 'importContact', {
                peerId: stored.peerId,
                publicSigningKey: stored.publicSigningKey,
                publicExchangeKey: stored.publicExchangeKey,
              }),
            ).catch(() => { /* best-effort */ });
          }
        }
      }
    } catch {
      // No contacts saved yet
    }
  }

  private async persistContacts(): Promise<void> {
    if (!this.storageId) return;

    const stored: StoredContact[] = Array.from(this.contacts.values()).map(c => ({
      peerId: c.identity.peerId,
      publicSigningKey: c.identity.publicSigningKey,
      publicExchangeKey: c.identity.publicExchangeKey,
      name: c.identity.name,
      addresses: c.addresses,
      addedAt: c.addedAt,
      lastSeen: c.lastSeen,
    }));

    await this.request(
      createRequest(this.id, this.storageId, 'set',
        { key: STORAGE_KEY_CONTACTS, value: stored }),
    );
  }

  private async persistSignalingUrls(): Promise<void> {
    if (!this.storageId) return;

    const urls = Array.from(this.savedSignalingUrls);
    await this.request(
      createRequest(this.id, this.storageId, 'set',
        { key: STORAGE_KEY_SIGNALING_URLS, value: urls }),
    );
  }

  private async persistRemovedSignalingUrls(): Promise<void> {
    if (!this.storageId) return;

    const urls = Array.from(this.removedSignalingUrls);
    await this.request(
      createRequest(this.id, this.storageId, 'set',
        { key: STORAGE_KEY_REMOVED_SIGNALING, value: urls }),
    );
  }

  private async loadRemovedSignalingUrls(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<string[] | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_KEY_REMOVED_SIGNALING }),
      );
      if (Array.isArray(result)) {
        for (const url of result) {
          this.removedSignalingUrls.add(url);
        }
      }
    } catch { /* not yet saved */ }
  }

  private async loadBlockedPeers(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<string[] | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_KEY_BLOCKED }),
      );
      if (Array.isArray(result)) {
        for (const peerId of result) {
          this.blockedPeers.add(peerId);
        }
      }
    } catch {
      // No blocked peers saved yet
    }
  }

  private async persistBlockedPeers(): Promise<void> {
    if (!this.storageId) return;

    const peerIds = Array.from(this.blockedPeers);
    await this.request(
      createRequest(this.id, this.storageId, 'set',
        { key: STORAGE_KEY_BLOCKED, value: peerIds }),
    );
  }

  // ==========================================================================
  // Gossip Peer Persistence
  // ==========================================================================

  private updateGossipPeer(peerId: string, publicSigningKey: string,
      publicExchangeKey: string, name: string, signalingUrl: string): void {
    const existing = this.gossipPeers.get(peerId);
    if (existing) {
      if (!existing.signalingUrls.includes(signalingUrl)) {
        existing.signalingUrls.push(signalingUrl);
        if (existing.signalingUrls.length > 5) existing.signalingUrls.shift();
      }
      existing.lastSeen = Date.now();
      existing.name = name;
    } else {
      // Evict oldest if at capacity
      if (this.gossipPeers.size >= MAX_GOSSIP_PEERS) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of this.gossipPeers) {
          if (v.lastSeen < oldestTime) { oldestTime = v.lastSeen; oldestKey = k; }
        }
        if (oldestKey) this.gossipPeers.delete(oldestKey);
      }
      this.gossipPeers.set(peerId, {
        peerId, publicSigningKey, publicExchangeKey, name,
        signalingUrls: [signalingUrl], lastSeen: Date.now(),
      });
    }
    this.persistGossipPeers().catch(() => {});
  }

  private async persistGossipPeers(): Promise<void> {
    if (!this.storageId) return;

    const stored = Array.from(this.gossipPeers.values());
    await this.request(
      createRequest(this.id, this.storageId, 'set',
        { key: STORAGE_KEY_GOSSIP_PEERS, value: stored }),
    );
  }

  private async loadGossipPeers(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<StoredGossipPeer[] | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_KEY_GOSSIP_PEERS }),
      );
      if (Array.isArray(result)) {
        for (const gp of result) {
          this.gossipPeers.set(gp.peerId, gp);
        }
      }
    } catch {
      // No gossip peers saved yet
    }
  }

  // ==========================================================================
  // Alternative Signaling Bootstrap
  // ==========================================================================

  private tryAlternativeSignaling(): void {
    // Collect signaling URLs from contacts and gossip peers
    const urlsToTry = new Set<string>();
    for (const contact of this.contacts.values()) {
      for (const addr of contact.addresses) urlsToTry.add(addr);
    }
    for (const gp of this.gossipPeers.values()) {
      for (const addr of gp.signalingUrls) urlsToTry.add(addr);
    }

    for (const url of urlsToTry) {
      // Skip URLs we're already trying (persistent reconnect handles them)
      if (this.signalingClients.has(url)) continue;

      this.connectSignalingImpl(url).catch(() => {});
    }
  }

  private findSignalingUrlForRelay(relay: SignalingRelay): string | undefined {
    for (const [url, client] of this.signalingClients) {
      if (client === relay) return url;
    }
    return undefined;
  }

  private async loadAndReconnectSignaling(): Promise<void> {
    if (!this.storageId) return;

    let urls: string[] = [];
    let hasStoredKey = false;
    try {
      const result = await this.request<string[] | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_KEY_SIGNALING_URLS }),
      );
      if (Array.isArray(result)) {
        hasStoredKey = true;
        urls = result;
      }
    } catch {
      // No signaling URLs saved yet
    }

    // First run only: no key in storage → use default.
    // An empty array means the user explicitly removed all servers — respect that.
    if (!hasStoredKey) {
      urls = [DEFAULT_SIGNALING_URL];
    }

    // Populate saved set first — ensures URLs are tracked even if connection fails
    for (const url of urls) {
      this.savedSignalingUrls.add(url);
    }
    // Then attempt connections (best effort)
    for (const url of urls) {
      try {
        await this.connectSignalingImpl(url);
      } catch (err) {
        log.warn(`Failed to auto-reconnect to signaling: ${url}`, err);
      }
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## PeerRegistry Usage Guide

### Add a contact

  await call(await dep('PeerRegistry'), 'addContact', {
    peerId: 'remote-peer-id',
    publicSigningKey: '...', publicExchangeKey: '...',
    name: 'Alice'
  });

### List contacts

  const contacts = await call(await dep('PeerRegistry'), 'listContacts', {});
  // contacts: [{ peerId, name, state }]

### Connect to a peer

  await call(await dep('PeerRegistry'), 'connectToPeer', { peerId: 'remote-peer-id' });
  // Initiates WebRTC connection via signaling server

### Disconnect a peer

  await call(await dep('PeerRegistry'), 'disconnectPeer', { peerId: 'remote-peer-id' });

### Get contact connection state

  const state = await call(await dep('PeerRegistry'), 'getContactState', { peerId: 'remote-peer-id' });
  // state: 'disconnected' | 'connecting' | 'connected'

### Signaling server management

  await call(await dep('PeerRegistry'), 'connectSignaling', { url: 'ws://localhost:7720' });
  await call(await dep('PeerRegistry'), 'disconnectSignaling', { url: 'ws://localhost:7720' });
  const servers = await call(await dep('PeerRegistry'), 'listSignalingServers', {});
  await call(await dep('PeerRegistry'), 'removeSignalingServer', { url: 'ws://localhost:7720' });

### Find a peer on signaling servers

  const found = await call(await dep('PeerRegistry'), 'findPeer', { peerId: 'remote-peer-id' });

### Events
- contactConnected: { peerId } — a peer's WebRTC connection is established
- contactDisconnected: { peerId } — a peer's WebRTC connection was lost

### IMPORTANT
- The interface ID is 'abjects:peer-registry'.
- connectToPeer requires a signaling server connection and the contact already added.
- WebRTC connections include an identity handshake with AES-256-GCM encryption.`;
  }
}
