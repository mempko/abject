/**
 * RemoteUIAccess — global system Abject that lets paired remote browsers
 * (e.g. a phone visiting client.abject.world) connect to this server's
 * BackendUI over an encrypted WebRTC DataChannel.
 *
 * Flow:
 *   1. User clicks "Generate Pairing QR" in GlobalSettings → Auth.
 *   2. We mint a single-use token (TTL ~5 min) and emit a QR payload that
 *      encodes our peerId, public keys, signaling URL, and the token.
 *   3. The browser scans the QR, opens client.abject.world?pair=…, generates
 *      its own keypair, finds us via signaling, and establishes a PeerTransport.
 *   4. After the encrypted handshake, the browser sends the first raw message:
 *        - {type:'pair', token, clientName} → token consumed, peerId persisted
 *        - {type:'reconnect'}               → peerId checked against authorized list
 *   5. On success, the PeerTransport is wrapped in a WebRTCUITransport and
 *      attached to BackendUI (via the bootstrap-supplied attachHandler).
 *
 * RemoteUIAccess uses its own keypair distinct from IdentityObject, so it
 * registers on the signaling server under a separate peerId. This avoids any
 * routing overlap with PeerNetwork / PeerRegistry.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import {
  PeerId,
  exportKeyToJwk,
  importSigningPublicKey,
  importSigningPrivateKey,
  importExchangePublicKey,
  importExchangePrivateKey,
  derivePeerId,
} from '../core/identity.js';
import { SignalingClient } from '../network/signaling.js';
import { PeerTransport } from '../network/peer-transport.js';
import { WebRTCUITransport, UITransportLike } from '../network/webrtc-ui-transport.js';
import QRCode from 'qrcode';

const log = new Log('RemoteUIAccess');

const REMOTE_UI_INTERFACE = 'abjects:remote-ui-access' as InterfaceId;
export const REMOTE_UI_ACCESS_ID = 'abjects:remote-ui-access' as AbjectId;

const STORAGE_IDENTITY = 'remote-ui:identity';
const STORAGE_CLIENTS = 'remote-ui:clients';
const STORAGE_ENABLED = 'remote-ui:enabled';
const STORAGE_SIGNALING_URL = 'remote-ui:signaling-url';
const STORAGE_DEVICE_LABEL = 'remote-ui:device-label';

const DEFAULT_SIGNALING_URL = 'wss://signal.abject.world';
const DEFAULT_CLIENT_BASE = 'https://client.abject.world';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const PRE_AUTH_TIMEOUT_MS = 30_000;

interface AuthorizedClient {
  peerId: string;
  publicSigningKey: string;
  publicExchangeKey: string;
  name: string;
  addedAt: number;
  lastConnected?: number;
}

interface PendingToken {
  expires: number;
  name: string;
}

interface PendingAuth {
  peerTransport: PeerTransport;
  authTimer: ReturnType<typeof setTimeout>;
}

interface PairingPayload {
  v: number;
  peerId: string;
  signKey: string;
  exKey: string;
  signalingUrl: string;
  token: string;
  expires: number;
  name: string;
}

export class RemoteUIAccess extends Abject {
  private signingKeyPair?: CryptoKeyPair;
  private exchangeKeyPair?: CryptoKeyPair;
  private peerId?: PeerId;
  private signingPubJwk?: string;
  private exchangePubJwk?: string;

  private storageId?: AbjectId;
  private signalingClient?: SignalingClient;
  private signalingUrl: string = DEFAULT_SIGNALING_URL;
  private clientBaseUrl: string = DEFAULT_CLIENT_BASE;
  private deviceLabel = '';
  private enabled = false;

  private pendingTokens: Map<string, PendingToken> = new Map();
  private authorizedClients: Map<string, AuthorizedClient> = new Map();
  private connectedTransports: Map<string, PeerTransport> = new Map();
  private pendingAuth: Map<string, PendingAuth> = new Map();

  /** Set by server bootstrap so we can hand the encrypted channel to BackendUI. */
  private attachHandler?: (peerId: string, transport: UITransportLike, meta?: { name?: string }) => void;

  constructor() {
    super({
      manifest: {
        name: 'RemoteUIAccess',
        description:
          'Allows paired remote browsers (e.g. a phone) to connect to this server over an encrypted WebRTC DataChannel and render the UI. Clients pair by scanning a QR shown in the Auth tab; subsequent reconnects use a stored peerId.',
        version: '1.0.0',
        interface: {
          id: REMOTE_UI_INTERFACE,
          name: 'RemoteUIAccess',
          description: 'Pairing and management of remote UI clients',
          methods: [
            {
              name: 'generatePairingToken',
              description: 'Mint a one-time pairing token and return a QR payload + dataURL.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional device label hint', optional: true },
              ],
              returns: { kind: 'reference', reference: 'PairingTokenResult' },
            },
            {
              name: 'listClients',
              description: 'List all paired remote UI clients.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'AuthorizedClient' } },
            },
            {
              name: 'revokeClient',
              description: 'Remove a paired client and disconnect any active session.',
              parameters: [
                { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'PeerId of the client to revoke' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'renameClient',
              description: 'Update a paired client\'s display name.',
              parameters: [
                { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'PeerId of the client' },
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'New display name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'setEnabled',
              description: 'Turn remote UI access on or off.',
              parameters: [
                { name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether to listen for remote clients' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'setDeviceLabel',
              description: 'Set the human-readable label this server advertises.',
              parameters: [
                { name: 'label', type: { kind: 'primitive', primitive: 'string' }, description: 'Display label' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getStatus',
              description: 'Get current status: enabled, peerId, signaling URL, connected count.',
              parameters: [],
              returns: { kind: 'reference', reference: 'RemoteUIStatus' },
            },
          ],
          events: [
            {
              name: 'clientsChanged',
              description: 'Emitted when authorized clients or active connections change',
              payload: {
                kind: 'object',
                properties: {
                  connectedCount: { kind: 'primitive', primitive: 'number' },
                  authorizedCount: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'remote-ui'],
      },
    });
    this.setupHandlers();
  }

  /**
   * Wire the callback that BackendUI bootstrap uses to attach a paired
   * WebRTC channel to BackendUI.addTransport (directly or via worker port relay).
   */
  setAttachHandler(handler: (peerId: string, transport: UITransportLike, meta?: { name?: string }) => void): void {
    this.attachHandler = handler;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    this.storageId = (await this.discoverDep('Storage')) ?? undefined;

    if (!await this.loadIdentity()) {
      await this.generateIdentity();
      await this.persistIdentity();
    }
    await this.loadAuthorizedClients();
    await this.loadConfig();

    if (this.enabled) {
      try {
        await this.startListening();
      } catch (err) {
        log.warn(`startListening failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.checkInvariants();
  }

  protected override async onStop(): Promise<void> {
    await this.stopListening();
  }

  override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.peerId !== undefined || !this.enabled, 'enabled requires peerId');
  }

  // ── Handlers ─────────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('generatePairingToken', async (msg: AbjectMessage) => {
      const { name } = (msg.payload as { name?: string }) ?? {};
      return this.handleGeneratePairingToken(name ?? '');
    });

    this.on('listClients', async () => {
      return this.snapshotClients();
    });

    this.on('revokeClient', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      precondition(typeof peerId === 'string' && peerId.length > 0, 'peerId required');
      return this.handleRevokeClient(peerId);
    });

    this.on('renameClient', async (msg: AbjectMessage) => {
      const { peerId, name } = msg.payload as { peerId: string; name: string };
      precondition(typeof peerId === 'string' && peerId.length > 0, 'peerId required');
      precondition(typeof name === 'string', 'name must be a string');
      return this.handleRenameClient(peerId, name);
    });

    this.on('setEnabled', async (msg: AbjectMessage) => {
      const { enabled } = msg.payload as { enabled: boolean };
      precondition(typeof enabled === 'boolean', 'enabled must be a boolean');
      return this.handleSetEnabled(enabled);
    });

    this.on('setDeviceLabel', async (msg: AbjectMessage) => {
      const { label } = msg.payload as { label: string };
      precondition(typeof label === 'string', 'label must be a string');
      this.deviceLabel = label;
      await this.persistConfig();
      return true;
    });

    this.on('getStatus', async () => this.handleGetStatus());
  }

  // ── Pairing ──────────────────────────────────────────────────────────

  private async handleGeneratePairingToken(name: string): Promise<{
    token: string;
    expires: number;
    payload: PairingPayload;
    qrUrl: string;
    qrDataUrl: string;
  }> {
    precondition(this.peerId !== undefined, 'identity not initialized');
    precondition(this.signingPubJwk !== undefined, 'signing key not exported');
    precondition(this.exchangePubJwk !== undefined, 'exchange key not exported');

    const token = randomTokenBase64(32);
    const expires = Date.now() + TOKEN_TTL_MS;
    this.pendingTokens.set(token, { expires, name });
    this.pruneExpiredTokens();

    const payload: PairingPayload = {
      v: 1,
      peerId: this.peerId!,
      signKey: this.signingPubJwk!,
      exKey: this.exchangePubJwk!,
      signalingUrl: this.signalingUrl,
      token,
      expires,
      name: this.deviceLabel || name || 'Abjects',
    };

    const encoded = base64UrlEncode(JSON.stringify(payload));
    const qrUrl = `${this.clientBaseUrl}/?pair=${encoded}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 512,
      margin: 4,
      errorCorrectionLevel: 'M',
    });

    return { token, expires, payload, qrUrl, qrDataUrl };
  }

  private handleSetEnabled = async (enabled: boolean): Promise<boolean> => {
    if (enabled === this.enabled) return true;
    this.enabled = enabled;
    await this.persistConfig();
    if (enabled) {
      await this.startListening();
    } else {
      await this.stopListening();
    }
    this.emitClientsChanged();
    return true;
  };

  private handleGetStatus(): {
    enabled: boolean;
    peerId: string;
    signalingUrl: string;
    deviceLabel: string;
    connectedCount: number;
    authorizedCount: number;
  } {
    return {
      enabled: this.enabled,
      peerId: this.peerId ?? '',
      signalingUrl: this.signalingUrl,
      deviceLabel: this.deviceLabel,
      connectedCount: this.connectedTransports.size,
      authorizedCount: this.authorizedClients.size,
    };
  }

  private snapshotClients(): AuthorizedClient[] {
    return Array.from(this.authorizedClients.values()).map((c) => ({ ...c }));
  }

  private async handleRevokeClient(peerId: string): Promise<boolean> {
    const removed = this.authorizedClients.delete(peerId);
    const transport = this.connectedTransports.get(peerId);
    if (transport) {
      this.connectedTransports.delete(peerId);
      try { await transport.disconnect(); } catch { /* ignore */ }
    }
    if (removed) {
      await this.persistAuthorizedClients();
      this.emitClientsChanged();
    }
    return removed;
  }

  private async handleRenameClient(peerId: string, name: string): Promise<boolean> {
    const client = this.authorizedClients.get(peerId);
    if (!client) return false;
    client.name = name;
    await this.persistAuthorizedClients();
    this.emitClientsChanged();
    return true;
  }

  // ── Signaling / transport ────────────────────────────────────────────

  private async startListening(): Promise<void> {
    if (this.signalingClient) return;
    if (!this.peerId || !this.signingPubJwk || !this.exchangePubJwk) return;

    const client = new SignalingClient();
    client.setPersistent(true);
    client.on({
      onConnect: () => {
        client.register(this.peerId!, this.signingPubJwk!, this.exchangePubJwk!,
          `ui-bridge:${this.deviceLabel || 'abjects'}`);
      },
      onSdpOffer: (fromPeerId, sdp) => this.handleIncomingOffer(fromPeerId, sdp).catch((err) => {
        log.warn(`incoming offer failed for ${fromPeerId.slice(0, 16)}: ${err}`);
      }),
      onSdpAnswer: (fromPeerId, sdp) => {
        const t = this.connectedTransports.get(fromPeerId) ?? this.pendingAuth.get(fromPeerId)?.peerTransport;
        if (t) t.handleSdpAnswer(sdp).catch(() => {});
      },
      onIceCandidate: (fromPeerId, candidate) => {
        const t = this.connectedTransports.get(fromPeerId) ?? this.pendingAuth.get(fromPeerId)?.peerTransport;
        if (t) t.handleIceCandidate(candidate).catch(() => {});
      },
      onError: (err) => log.warn(`signaling error: ${err}`),
    });

    try {
      await client.connect(this.signalingUrl);
      this.signalingClient = client;
      log.info(`Listening for remote UI clients via ${this.signalingUrl} as ${this.peerId.slice(0, 16)}`);
    } catch (err) {
      log.warn(`failed to connect to signaling: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  private async stopListening(): Promise<void> {
    for (const [peerId, t] of this.connectedTransports) {
      try { await t.disconnect(); } catch { /* ignore */ }
      void peerId;
    }
    this.connectedTransports.clear();
    for (const [, p] of this.pendingAuth) {
      clearTimeout(p.authTimer);
      try { await p.peerTransport.disconnect(); } catch { /* ignore */ }
    }
    this.pendingAuth.clear();
    if (this.signalingClient) {
      try { await this.signalingClient.disconnect(); } catch { /* ignore */ }
      this.signalingClient = undefined;
    }
  }

  private async handleIncomingOffer(fromPeerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.signalingClient || !this.peerId) return;
    if (this.connectedTransports.has(fromPeerId) || this.pendingAuth.has(fromPeerId)) {
      // Already handling this peer; ignore duplicate offer
      return;
    }

    const transport = new PeerTransport({
      localPeerId: this.peerId,
      remotePeerId: fromPeerId,
      signalingClient: this.signalingClient,
      localPublicSigningKey: this.signingPubJwk!,
      localPublicExchangeKey: this.exchangePubJwk!,
      localExchangePrivateKey: this.exchangeKeyPair!.privateKey,
    });

    transport.on({
      onConnect: () => this.beginPreAuth(fromPeerId, transport),
      onDisconnect: () => this.cleanupTransport(fromPeerId),
      onError: (err) => log.warn(`peer transport error ${fromPeerId.slice(0, 16)}: ${err.message}`),
    });

    await transport.handleSdpOffer(sdp);
  }

  /**
   * After encrypted handshake completes, hold the channel until the client
   * sends either {type:'pair'} with a valid token or {type:'reconnect'}
   * matching an authorized peerId. Drop the connection if neither arrives
   * within PRE_AUTH_TIMEOUT_MS.
   */
  private beginPreAuth(peerId: string, transport: PeerTransport): void {
    const authTimer = setTimeout(() => {
      log.warn(`pre-auth timeout for ${peerId.slice(0, 16)}`);
      transport.disconnect().catch(() => {});
    }, PRE_AUTH_TIMEOUT_MS);

    this.pendingAuth.set(peerId, { peerTransport: transport, authTimer });

    transport.onRawMessage((data: string) => {
      void this.handlePreAuthMessage(peerId, transport, data);
    });
  }

  private async handlePreAuthMessage(peerId: string, transport: PeerTransport, data: string): Promise<void> {
    if (!this.pendingAuth.has(peerId)) return; // already authenticated
    let parsed: { type?: string; token?: string; clientName?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      log.warn(`pre-auth: invalid JSON from ${peerId.slice(0, 16)}`);
      await transport.disconnect();
      return;
    }

    if (parsed.type === 'pair') {
      await this.handlePairMessage(peerId, transport, parsed.token ?? '', parsed.clientName ?? '');
      return;
    }
    if (parsed.type === 'reconnect') {
      await this.handleReconnectMessage(peerId, transport);
      return;
    }
    log.warn(`pre-auth: unexpected message type from ${peerId.slice(0, 16)}: ${parsed.type}`);
    await transport.disconnect();
  }

  private async handlePairMessage(peerId: string, transport: PeerTransport, token: string, clientName: string): Promise<void> {
    this.pruneExpiredTokens();
    const pending = this.pendingTokens.get(token);
    if (!pending || pending.expires < Date.now()) {
      log.warn(`pair: invalid or expired token from ${peerId.slice(0, 16)}`);
      await transport.disconnect();
      return;
    }
    this.pendingTokens.delete(token); // single-use

    const remoteKeys = await this.fetchRemoteKeysFromHandshake(transport);

    const client: AuthorizedClient = {
      peerId,
      publicSigningKey: remoteKeys.signKey,
      publicExchangeKey: remoteKeys.exKey,
      name: clientName || pending.name || 'Remote',
      addedAt: Date.now(),
      lastConnected: Date.now(),
    };
    this.authorizedClients.set(peerId, client);
    await this.persistAuthorizedClients();

    await this.acceptAuthorized(peerId, transport, 'pair');
  }

  private async handleReconnectMessage(peerId: string, transport: PeerTransport): Promise<void> {
    const client = this.authorizedClients.get(peerId);
    if (!client) {
      log.warn(`reconnect: unknown peerId ${peerId.slice(0, 16)}`);
      await transport.disconnect();
      return;
    }
    client.lastConnected = Date.now();
    await this.persistAuthorizedClients();
    await this.acceptAuthorized(peerId, transport, 'reconnect');
  }

  private async fetchRemoteKeysFromHandshake(_transport: PeerTransport): Promise<{ signKey: string; exKey: string }> {
    // PeerTransport already validated the remote peer's keys during the
    // handshake (peerId == sha256(pubSigningKey)). For storage we capture
    // whatever the peer presented. We currently only need to remember the
    // peerId for reconnect — the keys are not required for the reconnect
    // flow because PeerTransport will re-verify them on every connection.
    // We persist empty placeholders; future versions can capture the JWKs
    // by extending PeerTransport's handshake API.
    return { signKey: '', exKey: '' };
  }

  private async acceptAuthorized(peerId: string, transport: PeerTransport, mode: 'pair' | 'reconnect'): Promise<void> {
    const pending = this.pendingAuth.get(peerId);
    if (pending) {
      clearTimeout(pending.authTimer);
      this.pendingAuth.delete(peerId);
    }
    this.connectedTransports.set(peerId, transport);

    if (this.attachHandler) {
      const ui = new WebRTCUITransport(transport);
      const client = this.authorizedClients.get(peerId);
      this.attachHandler(peerId, ui, { name: client?.name });
      log.info(`accepted ${mode} from ${peerId.slice(0, 16)} (${this.connectedTransports.size} active)`);
    } else {
      log.warn(`no attachHandler set; closing ${peerId.slice(0, 16)}`);
      await transport.disconnect();
      return;
    }

    this.emitClientsChanged();
  }

  private cleanupTransport(peerId: string): void {
    const wasConnected = this.connectedTransports.delete(peerId);
    const pending = this.pendingAuth.get(peerId);
    if (pending) {
      clearTimeout(pending.authTimer);
      this.pendingAuth.delete(peerId);
    }
    if (wasConnected) this.emitClientsChanged();
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private async loadIdentity(): Promise<boolean> {
    if (!this.storageId) return false;
    try {
      const stored = await this.request<{
        signingPub: string; signingPriv: string;
        exchangePub: string; exchangePriv: string;
      } | null>(createRequest(this.id, this.storageId, 'get', { key: STORAGE_IDENTITY }));
      if (!stored?.signingPub || !stored?.signingPriv) return false;
      this.signingKeyPair = {
        publicKey: await importSigningPublicKey(stored.signingPub),
        privateKey: await importSigningPrivateKey(stored.signingPriv),
      };
      this.exchangeKeyPair = {
        publicKey: await importExchangePublicKey(stored.exchangePub),
        privateKey: await importExchangePrivateKey(stored.exchangePriv),
      };
      this.signingPubJwk = stored.signingPub;
      this.exchangePubJwk = stored.exchangePub;
      this.peerId = await derivePeerId(this.signingKeyPair.publicKey);
      log.info(`loaded identity ${this.peerId.slice(0, 16)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async generateIdentity(): Promise<void> {
    this.signingKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    this.exchangeKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits', 'deriveKey'],
    );
    this.signingPubJwk = await exportKeyToJwk(this.signingKeyPair.publicKey);
    this.exchangePubJwk = await exportKeyToJwk(this.exchangeKeyPair.publicKey);
    this.peerId = await derivePeerId(this.signingKeyPair.publicKey);
    log.info(`generated remote-ui identity ${this.peerId.slice(0, 16)}`);
  }

  private async persistIdentity(): Promise<void> {
    if (!this.storageId || !this.signingKeyPair || !this.exchangeKeyPair) return;
    const value = {
      signingPub: await exportKeyToJwk(this.signingKeyPair.publicKey),
      signingPriv: await exportKeyToJwk(this.signingKeyPair.privateKey),
      exchangePub: await exportKeyToJwk(this.exchangeKeyPair.publicKey),
      exchangePriv: await exportKeyToJwk(this.exchangeKeyPair.privateKey),
    };
    await this.request(createRequest(this.id, this.storageId, 'set',
      { key: STORAGE_IDENTITY, value }));
  }

  private async loadAuthorizedClients(): Promise<void> {
    if (!this.storageId) return;
    try {
      const stored = await this.request<AuthorizedClient[] | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_CLIENTS }));
      if (Array.isArray(stored)) {
        for (const client of stored) {
          this.authorizedClients.set(client.peerId, client);
        }
      }
    } catch { /* ignore */ }
  }

  private async persistAuthorizedClients(): Promise<void> {
    if (!this.storageId) return;
    await this.request(createRequest(this.id, this.storageId, 'set', {
      key: STORAGE_CLIENTS,
      value: Array.from(this.authorizedClients.values()),
    }));
  }

  private async loadConfig(): Promise<void> {
    // Env vars take precedence over Storage so dev/CI can pin endpoints
    // without mutating persisted state.
    const envSignaling = (typeof process !== 'undefined' && process.env?.REMOTE_UI_SIGNALING_URL) || '';
    const envClientBase = (typeof process !== 'undefined' && process.env?.REMOTE_UI_CLIENT_BASE_URL) || '';
    if (envSignaling) this.signalingUrl = envSignaling;
    if (envClientBase) this.clientBaseUrl = envClientBase;

    if (!this.storageId) return;
    try {
      const enabled = await this.request<string | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_ENABLED }));
      this.enabled = enabled === 'true';
      if (!envSignaling) {
        const url = await this.request<string | null>(
          createRequest(this.id, this.storageId, 'get', { key: STORAGE_SIGNALING_URL }));
        if (url && url.length > 0) this.signalingUrl = url;
      }
      const label = await this.request<string | null>(
        createRequest(this.id, this.storageId, 'get', { key: STORAGE_DEVICE_LABEL }));
      if (label) this.deviceLabel = label;
    } catch { /* ignore */ }
  }

  private async persistConfig(): Promise<void> {
    if (!this.storageId) return;
    await this.request(createRequest(this.id, this.storageId, 'set',
      { key: STORAGE_ENABLED, value: this.enabled ? 'true' : 'false' }));
    await this.request(createRequest(this.id, this.storageId, 'set',
      { key: STORAGE_SIGNALING_URL, value: this.signalingUrl }));
    await this.request(createRequest(this.id, this.storageId, 'set',
      { key: STORAGE_DEVICE_LABEL, value: this.deviceLabel }));
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private pruneExpiredTokens(): void {
    const now = Date.now();
    for (const [token, info] of this.pendingTokens) {
      if (info.expires < now) this.pendingTokens.delete(token);
    }
  }

  private emitClientsChanged(): void {
    this.changed('clientsChanged', {
      connectedCount: this.connectedTransports.size,
      authorizedCount: this.authorizedClients.size,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (module-private)
// ────────────────────────────────────────────────────────────────────────

function randomTokenBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
