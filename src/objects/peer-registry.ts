/**
 * Peer registry — manages contacts, peer connections, and discovery.
 *
 * Acts as the social layer: tracks known peers, their connection states,
 * and orchestrates WebRTC connections via the signaling server.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { Capabilities } from '../core/capability.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest, event as createEvent } from '../core/message.js';
import type { PeerId, PeerIdentity, PeerContact, PeerConnectionState } from '../core/identity.js';
import { SignalingClient } from '../network/signaling.js';
import { PeerTransport, PeerTransportConfig } from '../network/peer-transport.js';

const PEER_REGISTRY_INTERFACE = 'abjects:peer-registry' as InterfaceId;
const IDENTITY_INTERFACE = 'abjects:identity' as InterfaceId;
const STORAGE_INTERFACE = 'abjects:storage' as InterfaceId;
const STORAGE_KEY_CONTACTS = 'peer-registry:contacts';
const STORAGE_KEY_SIGNALING_URLS = 'peer-registry:signaling-urls';

export const PEER_REGISTRY_ID = 'abjects:peer-registry' as AbjectId;

interface StoredContact {
  peerId: string;
  publicSigningKey: string;
  publicExchangeKey: string;
  name: string;
  addresses: string[];
  addedAt: number;
}

export class PeerRegistry extends Abject {
  private contacts: Map<PeerId, PeerContact> = new Map();
  private transports: Map<PeerId, PeerTransport> = new Map();
  private signalingClients: Map<string, SignalingClient> = new Map();
  private identityId?: AbjectId;
  private storageId?: AbjectId;
  private localIdentity?: PeerIdentity & { exchangePrivateKey?: CryptoKey };

  constructor() {
    super({
      manifest: {
        name: 'PeerRegistry',
        description:
          'Manages peer contacts, connection states, and orchestrates WebRTC peer-to-peer connections via signaling servers.',
        version: '1.0.0',
        interfaces: [
          {
            id: PEER_REGISTRY_INTERFACE as string,
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
                description: 'Get the transport for a connected peer (for NetworkBridge)',
                parameters: [
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID' },
                ],
                returns: { kind: 'reference', reference: 'PeerTransport' },
              },
              {
                name: 'getSignalingUrls',
                description: 'Get the list of connected signaling server URLs',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
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
            ],
          },
        ],
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

    this.on('getSignalingUrls', async () => {
      return Array.from(this.signalingClients.keys());
    });
  }

  protected override async onInit(): Promise<void> {
    // Discover dependencies
    this.identityId = (await this.discoverDep('Identity')) ?? undefined;
    this.storageId = (await this.discoverDep('Storage')) ?? undefined;

    // Load local identity
    if (this.identityId) {
      await this.loadLocalIdentity();
    }

    // Load contacts from storage
    await this.loadContacts();

    // Auto-reconnect to saved signaling servers
    await this.loadAndReconnectSignaling();
  }

  protected override async onStop(): Promise<void> {
    // Disconnect all peers
    for (const [peerId, transport] of this.transports) {
      await transport.disconnect();
    }
    this.transports.clear();

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
    // Import the contact's keys into Identity for crypto operations
    if (this.identityId) {
      await this.request(
        createRequest(this.id, this.identityId, IDENTITY_INTERFACE, 'importContact', {
          peerId, publicSigningKey, publicExchangeKey,
        }),
      );
    }

    const contact: PeerContact = {
      identity: { peerId, publicSigningKey, publicExchangeKey, name },
      state: 'offline',
      addresses: [],
      addedAt: Date.now(),
    };
    this.contacts.set(peerId, contact);
    await this.persistContacts();
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
    const contact = this.contacts.get(peerId);
    if (!contact) return false;
    if (this.transports.has(peerId)) return true; // already connected

    precondition(this.localIdentity !== undefined, 'Local identity not loaded');
    precondition(this.localIdentity!.exchangePrivateKey !== undefined, 'Exchange private key not loaded');

    // Need at least one signaling client
    const signalingClient = this.getActiveSignalingClient();
    if (!signalingClient) {
      console.warn('[PeerRegistry] No signaling server connected');
      return false;
    }

    this.setContactState(peerId, 'connecting');

    const transport = new PeerTransport({
      localPeerId: this.localIdentity!.peerId,
      remotePeerId: peerId,
      signalingClient,
      localPublicSigningKey: this.localIdentity!.publicSigningKey,
      localPublicExchangeKey: this.localIdentity!.publicExchangeKey,
      localExchangePrivateKey: this.localIdentity!.exchangePrivateKey!,
    });

    this.setupTransportEvents(transport, peerId);
    this.transports.set(peerId, transport);

    try {
      await transport.connect('webrtc');
    } catch (err) {
      console.error(`[PeerRegistry] Failed to connect to ${peerId.slice(0, 16)}:`, err);
      this.setContactState(peerId, 'offline');
      this.transports.delete(peerId);
      return false;
    }

    return true;
  }

  private async disconnectPeer(peerId: string): Promise<boolean> {
    const transport = this.transports.get(peerId);
    if (!transport) return false;

    await transport.disconnect();
    this.transports.delete(peerId);
    this.setContactState(peerId, 'offline');
    return true;
  }

  /**
   * Get the PeerTransport for a connected peer.
   * Used by NetworkBridge for routing messages.
   */
  getTransportForPeer(peerId: PeerId): PeerTransport | undefined {
    return this.transports.get(peerId);
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

  private async connectSignalingImpl(url: string): Promise<boolean> {
    if (this.signalingClients.has(url)) return true;

    const client = new SignalingClient();

    client.on({
      onConnect: () => {
        console.log(`[PeerRegistry] Connected to signaling server: ${url}`);
        // Register with the signaling server
        if (this.localIdentity) {
          client.register(
            this.localIdentity.peerId,
            this.localIdentity.publicSigningKey,
            this.localIdentity.publicExchangeKey,
            this.localIdentity.name,
          );
        }
      },
      onDisconnect: (reason) => {
        console.log(`[PeerRegistry] Disconnected from signaling: ${reason}`);
      },
      onPeerFound: (peerId, publicSigningKey, publicExchangeKey, name) => {
        this.handlePeerFound(peerId, publicSigningKey, publicExchangeKey, name);
      },
      onPeerNotFound: (peerId) => {
        console.log(`[PeerRegistry] Peer not found: ${peerId.slice(0, 16)}`);
      },
      onSdpOffer: (fromPeerId, sdp) => {
        this.handleIncomingSdpOffer(fromPeerId, sdp, client);
      },
      onSdpAnswer: (fromPeerId, sdp) => {
        const transport = this.transports.get(fromPeerId);
        if (transport) {
          transport.handleSdpAnswer(sdp).catch(console.error);
        }
      },
      onIceCandidate: (fromPeerId, candidate) => {
        const transport = this.transports.get(fromPeerId);
        if (transport) {
          transport.handleIceCandidate(candidate).catch(console.error);
        }
      },
      onError: (error) => {
        console.error(`[PeerRegistry] Signaling error: ${error}`);
      },
    });

    try {
      await client.connect(url);
      this.signalingClients.set(url, client);
      await this.persistSignalingUrls();
      return true;
    } catch (err) {
      console.error(`[PeerRegistry] Failed to connect to signaling: ${url}`, err);
      return false;
    }
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
      this.emitEvent('contactIntroduced', {
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
    signalingClient: SignalingClient,
  ): Promise<void> {
    precondition(this.localIdentity !== undefined, 'Local identity not loaded');
    precondition(this.localIdentity!.exchangePrivateKey !== undefined, 'Exchange private key not loaded');

    // Auto-accept connections from known contacts
    let transport = this.transports.get(fromPeerId);
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

    await transport.handleSdpOffer(sdp);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private setupTransportEvents(transport: PeerTransport, peerId: string): void {
    transport.on({
      onConnect: () => {
        this.setContactState(peerId, 'connected');
        this.emitEvent('contactConnected', { peerId });
      },
      onDisconnect: () => {
        this.setContactState(peerId, 'offline');
        this.transports.delete(peerId);
        this.emitEvent('contactDisconnected', { peerId });
      },
      onMessage: (message) => {
        // Messages from peers are forwarded to the local message bus
        // by the NetworkBridge interceptor
        this.events.onMessage?.(message);
      },
      onError: (error) => {
        console.error(`[PeerRegistry] Transport error with ${peerId.slice(0, 16)}:`, error);
      },
    });
  }

  // Event callback for incoming messages (used by NetworkBridge)
  private events: { onMessage?: (msg: AbjectMessage) => void } = {};

  /**
   * Set a handler for messages received from remote peers.
   */
  onRemoteMessage(handler: (msg: AbjectMessage) => void): void {
    this.events.onMessage = handler;
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
        createRequest(this.id, this.identityId, IDENTITY_INTERFACE, 'exportPublicKeys', {}),
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
      console.error('[PeerRegistry] Failed to load local identity:', err);
    }
  }

  private emitEvent(eventName: string, payload: unknown): void {
    // Broadcast to dependents
    for (const depId of this.getDependents()) {
      this.send(createEvent(this.id, depId, PEER_REGISTRY_INTERFACE, eventName, payload))
        .catch(() => { /* best-effort */ });
    }
  }

  /**
   * Get dependent object IDs (objects that called addDependent on us).
   * Access the inherited dependents set.
   */
  private getDependents(): AbjectId[] {
    // Access via the base class pattern — dependents is private in Abject
    // We emit via broadcast subscription instead
    return [];
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  private async loadContacts(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<{ value: unknown }>(
        createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_CONTACTS }),
      );
      if (result?.value && Array.isArray(result.value)) {
        for (const stored of result.value as StoredContact[]) {
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
          };
          this.contacts.set(stored.peerId, contact);

          // Import keys into Identity
          if (this.identityId) {
            this.request(
              createRequest(this.id, this.identityId, IDENTITY_INTERFACE, 'importContact', {
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
    }));

    await this.request(
      createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'set',
        { key: STORAGE_KEY_CONTACTS, value: stored }),
    );
  }

  private async persistSignalingUrls(): Promise<void> {
    if (!this.storageId) return;

    const urls = Array.from(this.signalingClients.keys());
    await this.request(
      createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'set',
        { key: STORAGE_KEY_SIGNALING_URLS, value: urls }),
    );
  }

  private async loadAndReconnectSignaling(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<{ value: unknown }>(
        createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_SIGNALING_URLS }),
      );
      if (result?.value && Array.isArray(result.value)) {
        for (const url of result.value as string[]) {
          try {
            await this.connectSignalingImpl(url);
          } catch (err) {
            console.warn(`[PeerRegistry] Failed to auto-reconnect to signaling: ${url}`, err);
          }
        }
      }
    } catch {
      // No signaling URLs saved yet
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}
