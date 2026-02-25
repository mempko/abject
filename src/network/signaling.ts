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

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SignalingMessage {
  type: 'register' | 'find' | 'found' | 'not-found' | 'unregister'
    | 'sdp-offer' | 'sdp-answer' | 'ice-candidate' | 'error' | 'registered';
  peerId?: string;
  targetPeerId?: string;
  publicSigningKey?: string;
  publicExchangeKey?: string;
  name?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  error?: string;
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
}

export class SignalingClient {
  private socket?: WebSocket;
  private state: SignalingState = 'disconnected';
  private events: SignalingEvents = {};
  private endpoint?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 2000;

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
   * Connect to a signaling server.
   */
  async connect(endpoint: string): Promise<void> {
    precondition(endpoint !== '', 'endpoint is required');
    this.endpoint = endpoint;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(endpoint);

        this.socket.onopen = () => {
          this.state = 'connected';
          this.reconnectAttempts = 0;
          this.events.onConnect?.();
          resolve();
        };

        this.socket.onclose = (event) => {
          this.state = 'disconnected';
          this.events.onDisconnect?.(event.reason || 'Connection closed');
          this.scheduleReconnect();
        };

        this.socket.onerror = () => {
          this.state = 'error';
          const error = new Error('Signaling WebSocket error');
          this.events.onError?.(error.message);
          reject(error);
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data as string);
        };
      } catch (err) {
        this.state = 'error';
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Disconnect from the signaling server.
   */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
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
          this.events.onError?.(msg.error ?? 'Unknown signaling error');
          break;
        case 'registered':
          // Acknowledgment — no action needed
          break;
      }
    } catch (err) {
      console.error('[Signaling] Failed to parse message:', err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (!this.endpoint) return;

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[Signaling] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.endpoint) {
        this.connect(this.endpoint).catch(console.error);
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
