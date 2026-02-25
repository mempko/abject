/**
 * Signaling server for peer discovery and WebRTC connection setup.
 *
 * Analogous to firestr's firelocator — registers peers, answers "where is peer X?"
 * queries, and relays SDP offers/answers and ICE candidates.
 *
 * No message content is routed through this server.
 */

import { WebSocketServer as WsServer, WebSocket } from 'ws';

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
}

const DEFAULT_PORT = 7720;
const STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export class SignalingServer {
  private wss: WsServer;
  private peers: Map<string, PeerRecord> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(port = DEFAULT_PORT, host?: string) {
    this.wss = new WsServer({ port, host });

    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as SignalingMessage;
          this.handleMessage(ws, msg);
        } catch (err) {
          console.error('[Signaling] Failed to parse message:', err);
        }
      });

      ws.on('close', () => {
        this.removePeerBySocket(ws);
      });

      ws.on('error', (err) => {
        console.error('[Signaling] WebSocket error:', err.message);
      });
    });

    // Periodically clean up stale peers
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [peerId, record] of this.peers) {
        if (now - record.lastSeen > STALE_TIMEOUT) {
          this.peers.delete(peerId);
          console.log(`[Signaling] Removed stale peer: ${peerId.slice(0, 16)}`);
        }
      }
    }, 60000);

    console.log(`[Signaling] Server listening on port ${port}`);
  }

  private handleMessage(ws: WebSocket, msg: SignalingMessage): void {
    switch (msg.type) {
      case 'register':
        this.handleRegister(ws, msg);
        break;
      case 'unregister':
        this.handleUnregister(msg);
        break;
      case 'find':
        this.handleFind(ws, msg);
        break;
      case 'sdp-offer':
      case 'sdp-answer':
      case 'ice-candidate':
        this.handleRelay(ws, msg);
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

    this.peers.set(msg.peerId, {
      peerId: msg.peerId,
      publicSigningKey: msg.publicSigningKey,
      publicExchangeKey: msg.publicExchangeKey,
      name: msg.name ?? '',
      ws,
      lastSeen: Date.now(),
    });

    console.log(`[Signaling] Registered peer: ${msg.peerId.slice(0, 16)} (${msg.name ?? 'unnamed'})`);
    this.sendMessage(ws, { type: 'registered', peerId: msg.peerId });
  }

  private handleUnregister(msg: SignalingMessage): void {
    if (msg.peerId) {
      this.peers.delete(msg.peerId);
      console.log(`[Signaling] Unregistered peer: ${msg.peerId.slice(0, 16)}`);
    }
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
      this.sendMessage(ws, { type: 'not-found', targetPeerId: msg.targetPeerId });
    }
  }

  /**
   * Relay signaling messages (SDP offers/answers, ICE candidates) to the target peer.
   */
  private handleRelay(ws: WebSocket, msg: SignalingMessage): void {
    if (!msg.targetPeerId) {
      this.sendMessage(ws, { type: 'error', error: 'Missing targetPeerId for relay' });
      return;
    }

    const target = this.peers.get(msg.targetPeerId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      this.sendMessage(ws, { type: 'error', error: `Peer ${msg.targetPeerId.slice(0, 16)} not connected` });
      return;
    }

    // Update sender's lastSeen
    if (msg.peerId) {
      const sender = this.peers.get(msg.peerId);
      if (sender) sender.lastSeen = Date.now();
    }

    // Forward the message to the target peer
    this.sendMessage(target.ws, msg);
  }

  private removePeerBySocket(ws: WebSocket): void {
    for (const [peerId, record] of this.peers) {
      if (record.ws === ws) {
        this.peers.delete(peerId);
        console.log(`[Signaling] Peer disconnected: ${peerId.slice(0, 16)}`);
        break;
      }
    }
  }

  private sendMessage(ws: WebSocket, msg: SignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  get peerCount(): number {
    return this.peers.size;
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    return new Promise((resolve, reject) => {
      for (const [, record] of this.peers) {
        record.ws.close(1000, 'Server shutting down');
      }
      this.peers.clear();
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
    console.log('[Signaling] Shutting down...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[Signaling] Signaling server running on port ${port}`);
  console.log(`[Signaling] Peers: ${server.peerCount}`);
}
