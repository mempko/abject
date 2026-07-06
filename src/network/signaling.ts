/**
 * Signaling client for peer discovery and WebRTC connection setup.
 *
 * Connects to a signaling server (greeter) to:
 * - Register this peer's identity and presence
 * - Discover other peers by PeerId
 * - Relay SDP offers/answers and ICE candidates for WebRTC setup
 */

import { require as precondition } from '../core/contracts.js';
import type { PeerId } from '../core/identity.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Signaling');

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SignalingMessage {
  type: 'register' | 'find' | 'found' | 'not-found' | 'unregister'
    | 'sdp-offer' | 'sdp-answer' | 'ice-candidate' | 'error' | 'registered'
    | 'ping' | 'pong' | 'list-peers' | 'peer-list'
    | 'get-ice' | 'ice-servers';
  peerId?: string;
  targetPeerId?: string;
  publicSigningKey?: string;
  publicExchangeKey?: string;
  name?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  error?: string;
  peers?: Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string }>;
  iceServers?: RTCIceServer[];
}

export interface SignalingEvents {
  onConnect?: () => void;
  onDisconnect?: (reason?: string) => void;
  onPeerFound?: (peerId: PeerId, publicSigningKey: string, publicExchangeKey: string, name: string) => void;
  onPeerNotFound?: (peerId: PeerId) => void;
  onSdpOffer?: (fromPeerId: PeerId, sdp: RTCSessionDescriptionInit) => void;
  onSdpAnswer?: (fromPeerId: PeerId, sdp: RTCSessionDescriptionInit) => void;
  onIceCandidate?: (fromPeerId: PeerId, candidate: RTCIceCandidateInit) => void;
  onError?: (error: string) => void;
  onPeerList?: (peers: Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string }>) => void;
  onIceServers?: (iceServers: RTCIceServer[]) => void;
}

/**
 * Minimal interface for relaying WebRTC signaling (SDP + ICE).
 * Implemented by SignalingClient (server-based) and SignalingRelayObject (peer-based).
 */
export interface SignalingRelay {
  sendSdpOffer(fromPeerId: PeerId, targetPeerId: PeerId, sdp: RTCSessionDescriptionInit): void;
  sendSdpAnswer(fromPeerId: PeerId, targetPeerId: PeerId, sdp: RTCSessionDescriptionInit): void;
  sendIceCandidate(fromPeerId: PeerId, targetPeerId: PeerId, candidate: RTCIceCandidateInit): void;
}

export class SignalingClient implements SignalingRelay {
  private socket?: WebSocket;
  private state: SignalingState = 'disconnected';
  private events: SignalingEvents = {};
  private endpoint?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 2000;
  private pingTimer?: ReturnType<typeof setInterval>;
  private static readonly PING_INTERVAL = 120_000; // 2 minutes
  private persistent = false;
  /** Resolvers awaiting an `ice-servers` reply (see requestIceServers). */
  private pendingIceResolvers: Array<(servers: RTCIceServer[]) => void> = [];

  get connectionState(): SignalingState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  on(events: SignalingEvents): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * Enable persistent reconnect — ignores maxReconnectAttempts and always retries.
   */
  setPersistent(v: boolean): void {
    this.persistent = v;
  }

  /**
   * Connect to a signaling server.
   */
  async connect(endpoint: string, timeoutMs = 5000): Promise<void> {
    precondition(endpoint !== '', 'endpoint is required');
    this.endpoint = endpoint;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.socket) {
          this.socket.onopen = null;
          this.socket.onerror = null;
          this.socket.onclose = null;
          this.socket.onmessage = null;
          this.socket.close();
          this.socket = undefined;
        }
        this.state = 'error';
        reject(new Error(`Signaling connection to ${endpoint} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        this.socket = new WebSocket(endpoint);

        this.socket.onopen = () => {
          clearTimeout(timer);
          this.state = 'connected';
          this.reconnectAttempts = 0;
          this.startPing();
          this.events.onConnect?.();
          resolve();
        };

        this.socket.onclose = (event) => {
          this.state = 'disconnected';
          this.stopPing();
          this.events.onDisconnect?.(event.reason || 'Connection closed');
          this.scheduleReconnect();
        };

        this.socket.onerror = () => {
          clearTimeout(timer);
          this.state = 'error';
          const error = new Error('Signaling WebSocket error');
          this.events.onError?.(error.message);
          reject(error);
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data as string);
        };
      } catch (err) {
        clearTimeout(timer);
        this.state = 'error';
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Disconnect from the signaling server.
   */
  async disconnect(): Promise<void> {
    this.persistent = false;
    this.clearReconnectTimer();
    this.stopPing();
    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = undefined;
    }
    this.state = 'disconnected';
  }

  /**
   * Register this peer with the signaling server.
   */
  register(peerId: PeerId, publicSigningKey: string, publicExchangeKey: string, name: string): void {
    this.sendMessage({
      type: 'register',
      peerId,
      publicSigningKey,
      publicExchangeKey,
      name,
    });
  }

  /**
   * Unregister this peer from the signaling server.
   */
  unregister(peerId: PeerId): void {
    this.sendMessage({ type: 'unregister', peerId });
  }

  /**
   * Find a peer by their PeerId.
   */
  findPeer(peerId: PeerId): void {
    this.sendMessage({ type: 'find', targetPeerId: peerId });
  }

  /**
   * Request the list of all peers registered on this signaling server.
   */
  listPeers(myPeerId: PeerId): void {
    this.sendMessage({ type: 'list-peers', peerId: myPeerId });
  }

  /**
   * Ask the signaling server for ICE servers (STUN + freshly-minted TURN
   * credentials). Resolves to an empty array on timeout or if not connected,
   * so callers can fall back to their own defaults rather than failing.
   */
  requestIceServers(timeoutMs = 3000): Promise<RTCIceServer[]> {
    if (this.state !== 'connected' || !this.socket) {
      return Promise.resolve([]);
    }
    return new Promise<RTCIceServer[]>((resolve) => {
      let settled = false;
      const finish = (servers: RTCIceServer[]) => {
        if (settled) return;
        settled = true;
        const idx = this.pendingIceResolvers.indexOf(wrapped);
        if (idx !== -1) this.pendingIceResolvers.splice(idx, 1);
        resolve(servers);
      };
      const wrapped = (servers: RTCIceServer[]) => finish(servers);
      this.pendingIceResolvers.push(wrapped);
      setTimeout(() => finish([]), timeoutMs);
      try {
        this.socket!.send(JSON.stringify({ type: 'get-ice' }));
      } catch {
        finish([]);
      }
    });
  }

  /**
   * Send an SDP offer to a remote peer via the signaling server.
   */
  sendSdpOffer(fromPeerId: PeerId, targetPeerId: PeerId, sdp: RTCSessionDescriptionInit): void {
    this.sendMessage({
      type: 'sdp-offer',
      peerId: fromPeerId,
      targetPeerId,
      sdp,
    });
  }

  /**
   * Send an SDP answer to a remote peer via the signaling server.
   */
  sendSdpAnswer(fromPeerId: PeerId, targetPeerId: PeerId, sdp: RTCSessionDescriptionInit): void {
    this.sendMessage({
      type: 'sdp-answer',
      peerId: fromPeerId,
      targetPeerId,
      sdp,
    });
  }

  /**
   * Send an ICE candidate to a remote peer via the signaling server.
   */
  sendIceCandidate(fromPeerId: PeerId, targetPeerId: PeerId, candidate: RTCIceCandidateInit): void {
    this.sendMessage({
      type: 'ice-candidate',
      peerId: fromPeerId,
      targetPeerId,
      candidate,
    });
  }

  private sendMessage(msg: SignalingMessage): void {
    precondition(this.socket !== undefined, 'Not connected to signaling server');
    precondition(this.state === 'connected', 'Not connected to signaling server');
    this.socket!.send(JSON.stringify(msg));
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as SignalingMessage;
      switch (msg.type) {
        case 'found':
          this.events.onPeerFound?.(
            msg.peerId!,
            msg.publicSigningKey!,
            msg.publicExchangeKey!,
            msg.name ?? '',
          );
          break;
        case 'not-found':
          this.events.onPeerNotFound?.(msg.targetPeerId!);
          break;
        case 'sdp-offer':
          this.events.onSdpOffer?.(msg.peerId!, msg.sdp!);
          break;
        case 'sdp-answer':
          this.events.onSdpAnswer?.(msg.peerId!, msg.sdp!);
          break;
        case 'ice-candidate':
          this.events.onIceCandidate?.(msg.peerId!, msg.candidate!);
          break;
        case 'error':
          // An older signaling server that predates `get-ice` answers our
          // probe with a generic "Unknown message type" error. Treat it as a
          // benign capability miss: resolve any pending ICE request to empty
          // (→ STUN fallback) instead of surfacing a scary error to callers.
          if ((msg.error ?? '').includes('get-ice')) {
            const resolvers = this.pendingIceResolvers.splice(0);
            for (const r of resolvers) r([]);
            break;
          }
          this.events.onError?.(msg.error ?? 'Unknown signaling error');
          break;
        case 'registered':
          // Acknowledgment — no action needed
          break;
        case 'pong':
          // Keepalive acknowledgment — no action needed
          break;
        case 'peer-list':
          this.events.onPeerList?.(msg.peers ?? []);
          break;
        case 'ice-servers': {
          const servers = msg.iceServers ?? [];
          // Drain pending requestIceServers() promises.
          const resolvers = this.pendingIceResolvers.splice(0);
          for (const r of resolvers) r(servers);
          this.events.onIceServers?.(servers);
          break;
        }
      }
    } catch (err) {
      log.error('Failed to parse message:', err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (!this.persistent && this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (!this.endpoint) return;

    this.reconnectAttempts++;
    const maxDelay = this.persistent ? 60_000 : Infinity;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), maxDelay);
    const label = this.persistent
      ? `${this.reconnectAttempts}`
      : `${this.reconnectAttempts}/${this.maxReconnectAttempts}`;
    log.info(`Reconnecting in ${delay}ms (attempt ${label})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const endpoint = this.endpoint;
      if (endpoint) {
        // A reconnect failure is expected (e.g. a signaling server that is
        // down). Log a quiet one-liner — the backoff schedule already reports
        // the next attempt — instead of dumping a full stack trace each retry.
        this.connect(endpoint).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Reconnect to ${endpoint} failed: ${msg}`);
        });
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.state === 'connected' && this.socket) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, SignalingClient.PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
