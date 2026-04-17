/**
 * Signaling server for peer discovery and WebRTC connection setup.
 *
 * Analogous to firestr's firelocator — registers peers, answers "where is peer X?"
 * queries, and relays SDP offers/answers and ICE candidates.
 *
 * No message content is routed through this server.
 */

import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { Log } from '../src/core/timed-log.js';

interface PeerRecord {
  peerId: string;
  publicSigningKey: string;
  publicExchangeKey: string;
  name: string;
  ws: WebSocket;
  lastSeen: number;
}

interface SignalingMessage {
  type: string;
  peerId?: string;
  targetPeerId?: string;
  publicSigningKey?: string;
  publicExchangeKey?: string;
  name?: string;
  sdp?: unknown;
  candidate?: unknown;
  error?: string;
  peers?: Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string }>;
}

interface FederationConfig {
  siblingUrls: string[];
}

interface FederationPeer {
  url: string;
  ws: WebSocket | null;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  lastSeen: number;
}

const DEFAULT_PORT = 7720;
const STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const log = new Log('Signaling');

/**
 * Parse and shape-validate an incoming signaling frame.
 * Returns undefined if the payload is not a well-formed SignalingMessage.
 */
function parseSignalingMessage(raw: string): SignalingMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.type !== 'string' || candidate.type.length === 0) {
    return undefined;
  }
  // Reject oversized optional string fields up front; these are identifiers,
  // not content payloads.
  for (const field of ['peerId', 'targetPeerId', 'name'] as const) {
    const val = candidate[field];
    if (val !== undefined && (typeof val !== 'string' || val.length > 1024)) {
      return undefined;
    }
  }
  return candidate as unknown as SignalingMessage;
}

export class SignalingServer {
  private wss: WsServer;
  private peers: Map<string, PeerRecord> = new Map();
  private wsToPeerId: Map<WebSocket, string> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private siblings: Map<string, FederationPeer> = new Map();
  private federationEnabled = false;

  constructor(port = DEFAULT_PORT, host?: string) {
    this.wss = new WsServer({ port, host });

    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = parseSignalingMessage(data.toString());
        if (!msg) {
          log.warn('Dropping malformed signaling message');
          return;
        }
        this.handleMessage(ws, msg);
      });

      ws.on('close', () => {
        this.removePeerBySocket(ws);
      });

      ws.on('error', (err) => {
        log.error('WebSocket error:', err.message);
      });
    });

    // Periodically clean up stale peers
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [peerId, record] of this.peers) {
        if (now - record.lastSeen > STALE_TIMEOUT) {
          this.peers.delete(peerId);
          this.wsToPeerId.delete(record.ws);
          log.info(`Removed stale peer: ${peerId.slice(0, 16)}`);
        }
      }
    }, 60000);

    log.info(`Server listening on port ${port}`);
  }

  private handleMessage(ws: WebSocket, msg: SignalingMessage): void {
    switch (msg.type) {
      case 'register':
        this.handleRegister(ws, msg);
        break;
      case 'unregister':
        this.handleUnregister(ws, msg);
        break;
      case 'find':
        this.handleFind(ws, msg);
        break;
      case 'sdp-offer':
      case 'sdp-answer':
      case 'ice-candidate':
        this.handleRelay(ws, msg);
        break;
      case 'list-peers':
        this.handleListPeers(ws, msg);
        break;
      case 'federate-peers':
        this.handleFederatePeers(ws, msg);
        break;
      case 'federate-find':
        this.handleFederateFind(ws, msg);
        break;
      case 'ping':
        this.handlePing(ws);
        break;
      default:
        this.sendMessage(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  }

  private handleRegister(ws: WebSocket, msg: SignalingMessage): void {
    if (!msg.peerId || !msg.publicSigningKey || !msg.publicExchangeKey) {
      this.sendMessage(ws, { type: 'error', error: 'Missing required fields for register' });
      return;
    }

    // One peerId per socket. If this socket was already bound to a different
    // peerId, drop the prior binding so identity is not laundered silently.
    const previousPeerId = this.wsToPeerId.get(ws);
    if (previousPeerId && previousPeerId !== msg.peerId) {
      this.peers.delete(previousPeerId);
    }

    this.peers.set(msg.peerId, {
      peerId: msg.peerId,
      publicSigningKey: msg.publicSigningKey,
      publicExchangeKey: msg.publicExchangeKey,
      name: msg.name ?? '',
      ws,
      lastSeen: Date.now(),
    });
    this.wsToPeerId.set(ws, msg.peerId);

    log.info(`Registered peer: ${msg.peerId.slice(0, 16)} (${msg.name ?? 'unnamed'})`);
    this.sendMessage(ws, { type: 'registered', peerId: msg.peerId });

    // Broadcast updated peer-list to all other connected peers so they can
    // discover and reconnect to the newly registered peer immediately.
    this.broadcastPeerList(msg.peerId);
  }

  private handleUnregister(ws: WebSocket, msg: SignalingMessage): void {
    if (!msg.peerId) return;
    const boundPeerId = this.wsToPeerId.get(ws);
    if (boundPeerId !== msg.peerId) {
      this.sendMessage(ws, { type: 'error', error: 'peerId does not match this connection' });
      return;
    }
    this.peers.delete(msg.peerId);
    this.wsToPeerId.delete(ws);
    log.info(`Unregistered peer: ${msg.peerId.slice(0, 16)}`);
  }

  private handleFind(ws: WebSocket, msg: SignalingMessage): void {
    if (!msg.targetPeerId) {
      this.sendMessage(ws, { type: 'error', error: 'Missing targetPeerId for find' });
      return;
    }

    const peer = this.peers.get(msg.targetPeerId);
    if (peer) {
      this.sendMessage(ws, {
        type: 'found',
        peerId: peer.peerId,
        publicSigningKey: peer.publicSigningKey,
        publicExchangeKey: peer.publicExchangeKey,
        name: peer.name,
      });
    } else {
      // Phase 5: Forward to sibling servers if not found locally
      if (this.federationEnabled) {
        for (const [, sibling] of this.siblings) {
          if (sibling.ws?.readyState === WebSocket.OPEN) {
            this.sendMessage(sibling.ws, { type: 'federate-find', targetPeerId: msg.targetPeerId });
          }
        }
      }
      this.sendMessage(ws, { type: 'not-found', targetPeerId: msg.targetPeerId });
    }
  }

  /**
   * Relay signaling messages (SDP offers/answers, ICE candidates) to the target peer.
   * The claimed sender (msg.peerId) must match the peerId bound to this socket
   * at register time; otherwise we reject to prevent identity spoofing.
   */
  private handleRelay(ws: WebSocket, msg: SignalingMessage): void {
    if (!msg.targetPeerId) {
      this.sendMessage(ws, { type: 'error', error: 'Missing targetPeerId for relay' });
      return;
    }

    const boundPeerId = this.wsToPeerId.get(ws);
    if (!boundPeerId) {
      this.sendMessage(ws, { type: 'error', error: 'Register before relaying' });
      return;
    }
    if (msg.peerId && msg.peerId !== boundPeerId) {
      log.warn(`Relay rejected: claimed sender ${msg.peerId.slice(0, 16)} but socket bound to ${boundPeerId.slice(0, 16)}`);
      this.sendMessage(ws, { type: 'error', error: 'peerId does not match this connection' });
      return;
    }

    const target = this.peers.get(msg.targetPeerId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      this.sendMessage(ws, { type: 'error', error: `Peer ${msg.targetPeerId.slice(0, 16)} not connected` });
      return;
    }

    // Sender is authoritative here, not whatever msg.peerId said.
    const sender = this.peers.get(boundPeerId);
    if (sender) sender.lastSeen = Date.now();

    // Stamp the authenticated sender so targets can trust msg.peerId.
    this.sendMessage(target.ws, { ...msg, peerId: boundPeerId });
  }

  private handleListPeers(ws: WebSocket, msg: SignalingMessage): void {
    const excludeId = msg.peerId ?? '';
    const peers = Array.from(this.peers.values())
      .filter(r => r.peerId !== excludeId)
      .map(r => ({
        peerId: r.peerId,
        name: r.name,
        publicSigningKey: r.publicSigningKey,
        publicExchangeKey: r.publicExchangeKey,
      }));
    this.sendMessage(ws, { type: 'peer-list', peers } as SignalingMessage);
  }

  private handlePing(ws: WebSocket): void {
    const peerId = this.wsToPeerId.get(ws);
    if (peerId) {
      const record = this.peers.get(peerId);
      if (record) record.lastSeen = Date.now();
    }
    this.sendMessage(ws, { type: 'pong' });
  }

  /**
   * Send updated peer-list to all connected peers except the one that just registered.
   */
  private broadcastPeerList(excludePeerId: string): void {
    for (const [peerId, record] of this.peers) {
      if (peerId === excludePeerId) continue;
      if (record.ws.readyState !== WebSocket.OPEN) continue;
      const peers = Array.from(this.peers.values())
        .filter(r => r.peerId !== peerId)
        .map(r => ({
          peerId: r.peerId,
          name: r.name,
          publicSigningKey: r.publicSigningKey,
          publicExchangeKey: r.publicExchangeKey,
        }));
      this.sendMessage(record.ws, { type: 'peer-list', peers } as SignalingMessage);
    }
  }

  private removePeerBySocket(ws: WebSocket): void {
    const peerId = this.wsToPeerId.get(ws);
    if (peerId) {
      this.peers.delete(peerId);
      this.wsToPeerId.delete(ws);
      log.info(`Peer disconnected: ${peerId.slice(0, 16)}`);
    }
  }

  private sendMessage(ws: WebSocket, msg: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ==========================================================================
  // Federation (Phase 5)
  // ==========================================================================

  /**
   * Phase 5: Enable federation with sibling signaling servers.
   */
  enableFederation(config: FederationConfig): void {
    this.federationEnabled = true;
    for (const url of config.siblingUrls) {
      this.connectToSibling(url);
    }
  }

  private connectToSibling(url: string): void {
    if (this.siblings.has(url)) return;

    const entry: FederationPeer = { url, ws: null, lastSeen: 0 };
    this.siblings.set(url, entry);

    this.attemptSiblingConnection(url);
  }

  private attemptSiblingConnection(url: string): void {
    const entry = this.siblings.get(url);
    if (!entry) return;

    try {
      const ws = new WebSocket(url);

      ws.on('open', () => {
        log.info(`Federation connected to ${url}`);
        entry.ws = ws;
        entry.lastSeen = Date.now();
        // Exchange peer registries
        this.sendFederatePeers(ws);
      });

      ws.on('message', (data: Buffer | string) => {
        const msg = parseSignalingMessage(data.toString());
        if (msg) this.handleFederationMessage(url, msg);
      });

      ws.on('close', () => {
        entry.ws = null;
        // Reconnect after 30s
        entry.reconnectTimer = setTimeout(() => {
          this.attemptSiblingConnection(url);
        }, 30_000);
      });

      ws.on('error', () => {
        // Will trigger close
      });
    } catch {
      // Retry after 30s
      entry.reconnectTimer = setTimeout(() => {
        this.attemptSiblingConnection(url);
      }, 30_000);
    }
  }

  private sendFederatePeers(ws: WebSocket): void {
    const peers = Array.from(this.peers.values()).map(r => ({
      peerId: r.peerId,
      name: r.name,
      publicSigningKey: r.publicSigningKey,
      publicExchangeKey: r.publicExchangeKey,
    }));
    this.sendMessage(ws, { type: 'federate-peers', peers } as SignalingMessage);
  }

  private handleFederatePeers(_ws: WebSocket, msg: SignalingMessage): void {
    // Peers from sibling servers are informational — we don't store them
    // but can use them for federate-find responses
    log.info(`Federation received ${msg.peers?.length ?? 0} peer records`);
  }

  private handleFederateFind(ws: WebSocket, msg: SignalingMessage): void {
    if (!msg.targetPeerId) return;

    const peer = this.peers.get(msg.targetPeerId);
    if (peer) {
      // Found locally — respond with found
      this.sendMessage(ws, {
        type: 'found',
        peerId: peer.peerId,
        publicSigningKey: peer.publicSigningKey,
        publicExchangeKey: peer.publicExchangeKey,
        name: peer.name,
      });
    } else {
      this.sendMessage(ws, { type: 'not-found', targetPeerId: msg.targetPeerId });
    }
  }

  private handleFederationMessage(fromUrl: string, msg: SignalingMessage): void {
    const entry = this.siblings.get(fromUrl);
    if (entry) entry.lastSeen = Date.now();

    // Handle federate-peers and found/not-found responses
    if (msg.type === 'federate-peers') {
      log.info(`Federation from ${fromUrl}: ${msg.peers?.length ?? 0} peers`);
    }
  }

  get peerCount(): number {
    return this.peers.size;
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);

    // Clean up federation connections
    for (const [, sibling] of this.siblings) {
      if (sibling.reconnectTimer) clearTimeout(sibling.reconnectTimer);
      if (sibling.ws) sibling.ws.close(1000, 'Server shutting down');
    }
    this.siblings.clear();

    return new Promise((resolve, reject) => {
      for (const [, record] of this.peers) {
        record.ws.close(1000, 'Server shutting down');
      }
      this.peers.clear();
      this.wsToPeerId.clear();
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// =============================================================================
// Standalone entry point
// =============================================================================

if (typeof process !== 'undefined' && process.argv[1]?.includes('signaling-server')) {
  const port = parseInt(process.env.SIGNALING_PORT ?? String(DEFAULT_PORT), 10);
  const server = new SignalingServer(port);

  const shutdown = async () => {
    log.info('Shutting down...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(`Signaling server running on port ${port}`);
  log.info(`Peers: ${server.peerCount}`);
}
