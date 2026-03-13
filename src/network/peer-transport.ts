/**
 * Peer-to-peer transport using WebRTC DataChannel.
 *
 * Connection flow:
 * 1. WebRTC connection established via signaling (SDP + ICE)
 * 2. Exchange public keys over DataChannel, verify PeerId matches
 * 3. ECDH key agreement → derive AES-256-GCM session key
 * 4. All subsequent messages encrypted with session key
 */

import { AbjectMessage } from '../core/types.js';
import { require as precondition } from '../core/contracts.js';
import { serialize, deserialize } from '../core/message.js';
import { Transport, TransportConfig } from './transport.js';
import type { PeerId } from '../core/identity.js';
import {
  importExchangePublicKey,
  importSigningPublicKey,
  derivePeerIdFromJwk,
  deriveSessionKey,
  aesEncrypt,
  aesDecrypt,
} from '../core/identity.js';
import type { SignalingRelay } from './signaling.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Log } from '../core/timed-log.js';

const log = new Log('PeerTransport');

const PONG_MISS_LIMIT = 3;
const MAX_CHUNK_SIZE = 200_000; // 200KB per chunk (safe under 256KB SCTP limit)
const CHUNK_REASSEMBLY_TIMEOUT = 30_000; // 30s to receive all chunks

export interface PeerTransportConfig extends TransportConfig {
  localPeerId: PeerId;
  remotePeerId: PeerId;
  signalingClient: SignalingRelay;
  localPublicSigningKey: string;   // JWK
  localPublicExchangeKey: string;  // JWK
  localExchangePrivateKey: CryptoKey;
  iceServers?: RTCIceServer[];
}

type HandshakeState = 'none' | 'awaiting-keys' | 'verified' | 'encrypted';

/**
 * WebRTC DataChannel transport for peer-to-peer communication.
 * Provides application-layer encryption on top of DTLS.
 */
export class PeerTransport extends Transport {
  readonly localPeerId: PeerId;
  readonly remotePeerId: PeerId;

  private peerConnection?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private signalingClient: SignalingRelay;
  private localPublicSigningKey: string;
  private localPublicExchangeKey: string;
  private localExchangePrivateKey: CryptoKey;
  private sessionKey?: CryptoKey;
  private handshakeState: HandshakeState = 'none';
  private iceServers: RTCIceServer[];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private pingInterval?: ReturnType<typeof setInterval>;
  private lastPongReceived: number = 0;
  private chunkCounter = 0;
  private pendingChunks: Map<string, { total: number; parts: Map<number, string>; timer: ReturnType<typeof setTimeout> }> = new Map();

  constructor(config: PeerTransportConfig) {
    super({ ...config, heartbeatInterval: config.heartbeatInterval ?? 15_000 });
    this.localPeerId = config.localPeerId;
    this.remotePeerId = config.remotePeerId;
    this.signalingClient = config.signalingClient;
    this.localPublicSigningKey = config.localPublicSigningKey;
    this.localPublicExchangeKey = config.localPublicExchangeKey;
    this.localExchangePrivateKey = config.localExchangePrivateKey;
    this.iceServers = config.iceServers ?? [
      { urls: 'stun:stun.l.google.com:19302' },
    ];
  }

  /**
   * Initiate a connection to the remote peer (caller side).
   * Creates SDP offer and sends it via signaling.
   */
  async connect(_endpoint: string): Promise<void> {
    this.setState('connecting');
    this.createPeerConnection();

    // Create DataChannel (caller creates it)
    this.dataChannel = this.peerConnection!.createDataChannel('abjects', {
      ordered: true,
    });
    this.setupDataChannel(this.dataChannel);

    // Create and send SDP offer
    const offer = await this.peerConnection!.createOffer();
    await this.peerConnection!.setLocalDescription(offer);
    this.signalingClient.sendSdpOffer(
      this.localPeerId,
      this.remotePeerId,
      offer,
    );
  }

  /**
   * Handle an incoming SDP offer (callee side).
   * Creates SDP answer and sends it via signaling.
   */
  async handleSdpOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) {
      this.setState('connecting');
      this.createPeerConnection();
    }

    try {
      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      log.error(`Failed to set remote offer for ${this.remotePeerId.slice(0, 16)}:`, err);
      throw err;
    }

    // Apply any ICE candidates that arrived before the remote description
    for (const candidate of this.pendingCandidates) {
      try {
        await this.peerConnection!.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Stale candidates from ICE glare — safe to discard
      }
    }
    this.pendingCandidates = [];

    const answer = await this.peerConnection!.createAnswer();
    await this.peerConnection!.setLocalDescription(answer);
    this.signalingClient.sendSdpAnswer(
      this.localPeerId,
      this.remotePeerId,
      answer,
    );
  }

  /**
   * Handle an incoming SDP answer (caller side).
   */
  async handleSdpAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    precondition(this.peerConnection !== undefined, 'No peer connection');

    try {
      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      log.error(`Failed to set remote answer for ${this.remotePeerId.slice(0, 16)}:`, err);
      throw err;
    }

    // Apply any ICE candidates that arrived before the remote description
    for (const candidate of this.pendingCandidates) {
      try {
        await this.peerConnection!.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Stale candidates from ICE glare — safe to discard
      }
    }
    this.pendingCandidates = [];
  }

  /**
   * Handle an incoming ICE candidate from the signaling server.
   */
  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection ||
        !this.peerConnection.remoteDescription ||
        this.peerConnection.signalingState === 'have-local-offer') {
      // Queue if remote description not yet set (includes ICE glare scenarios
      // where candidates arrive for a rejected offer)
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // During ICE glare recovery, stale candidates may arrive — safe to discard
    }
  }

  /**
   * Reset the PeerConnection for ICE glare recovery (loser side).
   * Destroys the current PeerConnection without triggering disconnect events,
   * preserving queued pendingCandidates so the remote peer's trickled ICE
   * candidates survive into the new connection.
   *
   * Note: We can't use SDP rollback because node-datachannel's polyfill
   * silently ignores setLocalDescription({type: 'rollback'}).
   */
  resetForGlare(): void {
    // Detach ALL event handlers BEFORE close() so the 'closed'/'close'
    // events don't trigger handleDisconnect and cascade to onDisconnect
    // (which would delete the transport from PeerRegistry's map).
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = undefined;
    }

    if (this.peerConnection) {
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.close();
      this.peerConnection = undefined;
    }

    this.stopPing();
    this.sessionKey = undefined;
    this.handshakeState = 'none';
    // NOTE: pendingCandidates intentionally preserved
  }

  async disconnect(): Promise<void> {
    this.stopPing();
    this.sessionKey = undefined;
    this.handshakeState = 'none';
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = undefined;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = undefined;
    }
    this.handleDisconnect('Client disconnect');
  }

  /**
   * Send a message to the remote peer.
   * If session key is established, message is encrypted with AES-256-GCM.
   */
  async send(message: AbjectMessage): Promise<void> {
    precondition(this.dataChannel !== undefined, 'DataChannel not open');
    precondition(this.dataChannel!.readyState === 'open', 'DataChannel not open');

    const data = serialize(message);

    if (this.sessionKey) {
      const encoder = new TextEncoder();
      const encrypted = await aesEncrypt(this.sessionKey, encoder.encode(data));
      const payload = JSON.stringify({ enc: true, ...encrypted });

      // Compress and possibly chunk the encrypted payload
      const compressed = gzipSync(Buffer.from(payload));
      const b64 = compressed.toString('base64');

      if (b64.length <= MAX_CHUNK_SIZE) {
        // Single compressed message
        this.dataChannel!.send(JSON.stringify({ gz: true, data: b64 }));
      } else {
        // Split into chunks
        const chunkId = String(this.chunkCounter++);
        const total = Math.ceil(b64.length / MAX_CHUNK_SIZE);
        for (let i = 0; i < total; i++) {
          const slice = b64.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
          this.dataChannel!.send(JSON.stringify({ chunk: true, id: chunkId, idx: i, total, data: slice }));
        }
        log.info(`sent ${total} chunks (${b64.length} bytes compressed) to ${this.remotePeerId.slice(0, 16)}`);
      }
    } else {
      this.dataChannel!.send(data);
    }
  }

  /**
   * Whether the handshake is complete and messages are encrypted.
   */
  get isEncrypted(): boolean {
    return this.handshakeState === 'encrypted';
  }

  /**
   * Current signaling state of the underlying RTCPeerConnection.
   * Used by PeerRegistry for ICE glare detection.
   */
  get signalingState(): string {
    return this.peerConnection?.signalingState ?? 'closed';
  }

  /**
   * Get the underlying RTCPeerConnection for media track management.
   * Used by MediaStream capability to add/remove audio/video tracks.
   */
  get rtcPeerConnection(): RTCPeerConnection | undefined {
    return this.peerConnection;
  }

  /**
   * Set a handler for remote media tracks received via RTCPeerConnection.
   */
  onRemoteTrack(handler: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void): void {
    this.remoteTrackHandler = handler;
  }

  private remoteTrackHandler?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;

  // ==========================================================================
  // Internal
  // ==========================================================================

  private createPeerConnection(): void {
    this.peerConnection = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    // Forward ICE candidates to the remote peer via signaling
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendIceCandidate(
          this.localPeerId,
          this.remotePeerId,
          event.candidate.toJSON(),
        );
      }
    };

    // Handle ICE connection state changes
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.handleDisconnect(`ICE ${state}`);
      }
    };

    // Callee side: handle incoming DataChannel
    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel(this.dataChannel);
    };

    // Handle incoming media tracks (for MediaStream capability)
    this.peerConnection.ontrack = (event) => {
      this.remoteTrackHandler?.(event.track, event.streams);
    };
  }

  private setupDataChannel(dc: RTCDataChannel): void {
    let opened = false;
    const onOpen = () => {
      if (opened) return;
      opened = true;
      log.info(`DataChannel open with ${this.remotePeerId.slice(0, 16)}`);
      // Don't call handleConnect() here — defer until handshake completes
      // so PeerRouter knows about the connection before messages arrive.
      this.startHandshake();
    };

    dc.onopen = onOpen;

    dc.onclose = () => {
      this.handleDisconnect('DataChannel closed');
    };

    dc.onerror = (event) => {
      this.handleError(new Error(`DataChannel error: ${event}`));
    };

    dc.onmessage = (event) => {
      this.handleIncomingData(event.data as string);
    };

    // Callee may receive a DataChannel already in 'open' state via ondatachannel,
    // in which case onopen won't fire. Trigger manually.
    if (dc.readyState === 'open') {
      onOpen();
    }
  }

  /**
   * Start the identity handshake by sending our public keys.
   */
  private startHandshake(): void {
    this.handshakeState = 'awaiting-keys';
    const handshakeMsg = JSON.stringify({
      handshake: true,
      peerId: this.localPeerId,
      publicSigningKey: this.localPublicSigningKey,
      publicExchangeKey: this.localPublicExchangeKey,
    });
    this.dataChannel!.send(handshakeMsg);
  }

  /**
   * Handle incoming data from the DataChannel.
   */
  private async handleIncomingData(data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);

      // Ping/pong keepalive (handled before handshake/encryption checks)
      if (parsed.ping) {
        this.dataChannel?.send(JSON.stringify({ pong: true, ts: parsed.ts }));
        return;
      }
      if (parsed.pong) {
        this.lastPongReceived = Date.now();
        return;
      }

      // Handshake message
      if (parsed.handshake) {
        await this.handleHandshakeMessage(parsed);
        return;
      }

      // Chunked message — reassemble before processing
      if (parsed.chunk) {
        const reassembled = this.handleChunk(parsed);
        if (!reassembled) return; // waiting for more chunks
        // Reassembled data is gz-compressed — decompress and re-parse
        const decompressed = gunzipSync(Buffer.from(reassembled, 'base64')).toString();
        await this.handleIncomingData(decompressed);
        return;
      }

      // Compressed (non-chunked) message — decompress and re-parse
      if (parsed.gz) {
        const decompressed = gunzipSync(Buffer.from(parsed.data, 'base64')).toString();
        await this.handleIncomingData(decompressed);
        return;
      }

      // Encrypted message
      if (parsed.enc && this.sessionKey) {
        const plaintext = await aesDecrypt(this.sessionKey, parsed.iv, parsed.ciphertext);
        const decoder = new TextDecoder();
        const msgData = decoder.decode(plaintext);
        const message = deserialize(msgData);
        log.info(`recv encrypted from ${this.remotePeerId.slice(0, 16)}: to=${message.routing.to.slice(0, 20)} method=${(message.payload as any)?.method ?? '?'}`);
        this.events.onMessage?.(message);
        return;
      }

      // Encrypted message but no session key yet — drop it
      if (parsed.enc && !this.sessionKey) {
        log.warn(`recv encrypted msg from ${this.remotePeerId.slice(0, 16)} but no session key yet — dropping`);
        return;
      }

      // Unencrypted message (during handshake or if encryption not yet established)
      const message = deserialize(data);
      log.info(`recv unencrypted from ${this.remotePeerId.slice(0, 16)}: to=${message.routing.to.slice(0, 20)} method=${(message.payload as any)?.method ?? '?'}`);
      this.events.onMessage?.(message);
    } catch (err) {
      log.error('Failed to handle message:', err);
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Handle a chunk of a multi-part message. Returns the reassembled base64
   * string when all chunks are received, or null if still waiting.
   */
  private handleChunk(parsed: { id: string; idx: number; total: number; data: string }): string | null {
    let entry = this.pendingChunks.get(parsed.id);
    if (!entry) {
      const timer = setTimeout(() => {
        log.warn(`chunk reassembly timeout for id=${parsed.id}, discarding`);
        this.pendingChunks.delete(parsed.id);
      }, CHUNK_REASSEMBLY_TIMEOUT);
      entry = { total: parsed.total, parts: new Map(), timer };
      this.pendingChunks.set(parsed.id, entry);
    }

    entry.parts.set(parsed.idx, parsed.data);

    if (entry.parts.size < entry.total) return null;

    // All chunks received — reassemble
    clearTimeout(entry.timer);
    this.pendingChunks.delete(parsed.id);

    const pieces: string[] = [];
    for (let i = 0; i < entry.total; i++) {
      pieces.push(entry.parts.get(i)!);
    }
    const reassembled = pieces.join('');
    log.info(`reassembled ${entry.total} chunks (${reassembled.length} bytes) from ${this.remotePeerId.slice(0, 16)}`);
    return reassembled;
  }

  /**
   * Handle identity handshake message — verify PeerId matches public key.
   */
  private async handleHandshakeMessage(msg: {
    peerId: string;
    publicSigningKey: string;
    publicExchangeKey: string;
  }): Promise<void> {
    // Verify the peer's identity
    const computedPeerId = await derivePeerIdFromJwk(msg.publicSigningKey);
    if (computedPeerId !== msg.peerId) {
      log.error(`PeerId verification failed for ${msg.peerId.slice(0, 16)}`);
      await this.disconnect();
      return;
    }

    if (msg.peerId !== this.remotePeerId) {
      log.error(`Unexpected peer: expected ${this.remotePeerId.slice(0, 16)}, got ${msg.peerId.slice(0, 16)}`);
      await this.disconnect();
      return;
    }

    // Import remote exchange key and derive session key
    const remoteExchangeKey = await importExchangePublicKey(msg.publicExchangeKey);
    this.sessionKey = await deriveSessionKey(this.localExchangePrivateKey, remoteExchangeKey);
    this.handshakeState = 'encrypted';
    log.info(`Handshake complete with ${this.remotePeerId.slice(0, 16)}, AES-256-GCM session established`);

    // NOW signal connected — after identity is verified and encryption
    // is established. This ensures PeerRouter learns about the connection
    // (via contactConnected) before any application-level messages arrive.
    this.handleConnect();
    this.startPing();
  }

  /**
   * Start periodic ping to detect dead connections.
   */
  private startPing(): void {
    this.stopPing();
    this.lastPongReceived = Date.now();

    this.pingInterval = setInterval(() => {
      if (Date.now() - this.lastPongReceived > this.config.heartbeatInterval * PONG_MISS_LIMIT) {
        log.warn(`No pong from ${this.remotePeerId.slice(0, 16)} in ${PONG_MISS_LIMIT} intervals, disconnecting`);
        this.disconnect().catch(console.error);
        return;
      }

      if (this.dataChannel?.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({ ping: true, ts: Date.now() }));
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop the ping keepalive timer.
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  /**
   * Override to clean up ping timer on any disconnection path.
   */
  protected override handleDisconnect(reason?: string): void {
    this.stopPing();
    for (const [, entry] of this.pendingChunks) {
      clearTimeout(entry.timer);
    }
    this.pendingChunks.clear();
    super.handleDisconnect(reason);
  }
}
