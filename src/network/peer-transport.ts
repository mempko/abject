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
  aesEncryptBytes,
  aesDecryptBytes,
} from '../core/identity.js';
import type { SignalingRelay } from './signaling.js';
import { deflateSync, inflateSync } from 'fflate';
import { Log } from '../core/timed-log.js';

// ── Binary frame format for encrypted DataChannel traffic ───────────────
//
// All encrypted payloads ride as Uint8Array frames. This avoids base64
// inflation (~33%) and the JSON envelope overhead that plagued the old
// gz+base64-in-JSON wrapping. Handshake and ping/pong stay as small JSON
// strings — they predate the session key anyway.
//
// Complete frame:
//   byte 0:        type (0x01–0x04 — see FRAME_* below)
//   bytes 1–12:    IV (12 bytes for AES-GCM)
//   bytes 13+:     ciphertext (compressed-then-encrypted if type even)
//
// Chunk frame (when a complete frame exceeds MAX_CHUNK_SIZE):
//   byte 0:        0x05
//   bytes 1–4:     chunk id (uint32 BE)
//   bytes 5–6:     idx       (uint16 BE)
//   bytes 7–8:     total     (uint16 BE)
//   bytes 9+:      slice of the original complete-frame bytes
//
// Reassembled chunks concat into a complete-frame byte sequence starting
// at byte 0 — which is then parsed by the same code path.
const FRAME_ENC_MSG       = 0x01; // encrypted AbjectMessage, plaintext uncompressed
const FRAME_ENC_MSG_GZ    = 0x02; // encrypted AbjectMessage, plaintext deflate-compressed
const FRAME_ENC_RAW       = 0x03; // encrypted raw UI payload, plaintext uncompressed
const FRAME_ENC_RAW_GZ    = 0x04; // encrypted raw UI payload, plaintext deflate-compressed
const FRAME_CHUNK         = 0x05;
const COMPRESS_THRESHOLD  = 256;  // bytes — skip deflate for small payloads

const log = new Log('PeerTransport');

const PONG_MISS_LIMIT = 3;
const MAX_CHUNK_SIZE = 200_000; // 200KB per chunk (safe under 256KB SCTP limit)
const CHUNK_REASSEMBLY_TIMEOUT = 30_000; // 30s to receive all chunks
const CHUNK_REASSEMBLY_WARN_AT = 8_000;  // warn after 8s if still waiting
const CONNECTION_TIMEOUT = 20_000; // 20s max to establish DataChannel

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
  private offerGeneration = 0;  // incremented on each new SDP offer/answer cycle
  private pingInterval?: ReturnType<typeof setInterval>;
  private lastPongReceived: number = 0;
  private chunkCounter = 0;
  private pendingChunks: Map<string, { total: number; parts: Map<number, Uint8Array>; size: number; timer: ReturnType<typeof setTimeout>; warnTimer: ReturnType<typeof setTimeout> }> = new Map();
  private connectionTimer?: ReturnType<typeof setTimeout>;

  // Throttled recv logging — per-message logs at 60fps UI traffic drown the
  // log, so aggregate and emit a summary at most once per window.
  private recvLogCount = 0;
  private recvLogLastEmit = 0;
  private droppedNoConsumerCount = 0;
  private droppedNoConsumerLastEmit = 0;
  private static readonly RECV_LOG_INTERVAL_MS = 5_000;

  constructor(config: PeerTransportConfig) {
    super({ ...config, heartbeatInterval: config.heartbeatInterval ?? 10_000 });
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
    this.offerGeneration++;
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

    // Auto-disconnect if DataChannel doesn't open within timeout
    this.connectionTimer = setTimeout(() => {
      if (this.state === 'connecting') {
        log.warn(`Connection timeout for ${this.remotePeerId.slice(0, 16)} (${CONNECTION_TIMEOUT / 1000}s)`);
        this.disconnect();
      }
    }, CONNECTION_TIMEOUT);
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

    // New negotiation context — increment generation so stale candidates are ignored
    this.offerGeneration++;
    const gen = this.offerGeneration;

    try {
      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      log.warn(`Failed to set remote offer for ${this.remotePeerId.slice(0, 16)}: ${err instanceof Error ? err.message : err}`);
      // Reset the PeerConnection so the next attempt starts clean
      this.resetForGlare();
      throw err;
    }

    // Apply only ICE candidates from the current generation
    for (const candidate of this.pendingCandidates) {
      const candidateGen = (candidate as RTCIceCandidateInit & { _generation?: number })._generation;
      if (candidateGen !== undefined && candidateGen !== gen) continue; // stale
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

    const gen = this.offerGeneration;

    try {
      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      log.error(`Failed to set remote answer for ${this.remotePeerId.slice(0, 16)}:`, err);
      throw err;
    }

    // Apply only ICE candidates from the current generation
    for (const candidate of this.pendingCandidates) {
      const candidateGen = (candidate as RTCIceCandidateInit & { _generation?: number })._generation;
      if (candidateGen !== undefined && candidateGen !== gen) continue; // stale
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
    // [ICE-DIAG] Log remote candidate type (what the peer is offering).
    {
      const c = candidate.candidate ?? '';
      const typ = /typ (\w+)/.exec(c)?.[1] ?? '?';
      log.info(`[ICE-DIAG] REMOTE cand from ${this.remotePeerId.slice(0, 12)}: typ=${typ} ${c.slice(0, 80)}`);
    }
    if (!this.peerConnection ||
        !this.peerConnection.remoteDescription ||
        this.peerConnection.signalingState === 'have-local-offer') {
      // Queue if remote description not yet set (includes ICE glare scenarios
      // where candidates arrive for a rejected offer).
      // Tag with current generation so stale candidates can be filtered later.
      (candidate as RTCIceCandidateInit & { _generation?: number })._generation = this.offerGeneration;
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
    if (this.connectionTimer) { clearTimeout(this.connectionTimer); this.connectionTimer = undefined; }
    this.sessionKey = undefined;
    this.handshakeState = 'none';
    // Clear stale candidates from previous negotiation context.
    // Old candidates have ufrag/pwd that won't match the new offer,
    // causing libdatachannel to reject the SDP with "Invalid ICE settings".
    // Fresh candidates will arrive after the new offer/answer exchange.
    this.pendingCandidates = [];
  }

  async disconnect(): Promise<void> {
    this.stopPing();
    if (this.connectionTimer) { clearTimeout(this.connectionTimer); this.connectionTimer = undefined; }
    this.sessionKey = undefined;
    this.handshakeState = 'none';
    this.pendingCandidates = [];
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
      await this.sendEncryptedString(data);
    } else if (!this.trySend(data)) {
      throw new Error('DataChannel send failed (channel closed or native throw)');
    }
  }

  /**
   * Centralized DataChannel send. Re-checks readyState immediately before
   * the native call and wraps the call in try/catch so a synchronous throw
   * from libdatachannel (which can otherwise propagate as Napi::Error into
   * a noexcept native frame and terminate the process) lands on a single
   * catchable path. Triggers a clean disconnect on any failure.
   */
  private trySend(data: string | Uint8Array<ArrayBuffer>): boolean {
    try {
      const dc = this.dataChannel;
      if (!dc || dc.readyState !== 'open') return false;
      // Branched call: RTCDataChannel.send is overloaded per payload type
      // and rejects a string | Uint8Array union.
      if (typeof data === 'string') {
        dc.send(data);
      } else {
        dc.send(data);
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`DataChannel send failed for ${this.remotePeerId.slice(0, 16)}: ${msg}`);
      this.handleDisconnect(`Send threw: ${msg}`);
      return false;
    }
  }

  /**
   * Send a raw string (UI protocol JSON) over the encrypted DataChannel,
   * bypassing AbjectMessage serialize/deserialize. Compression and chunking
   * still apply. Used by WebRTCUITransport for browser ↔ server UI traffic.
   */
  async sendRaw(data: string): Promise<void> {
    precondition(this.dataChannel !== undefined, 'DataChannel not open');
    precondition(this.dataChannel!.readyState === 'open', 'DataChannel not open');
    precondition(this.sessionKey !== undefined, 'Session key not established');
    await this.sendEncryptedString(data, true);
  }

  /**
   * Register a handler for raw string messages received post-handshake.
   * These are messages sent via sendRaw — i.e. UI protocol JSON, not AbjectMessage.
   */
  onRawMessage(handler: (data: string) => void): void {
    this.rawMessageHandler = handler;
  }

  private rawMessageHandler?: (data: string) => void;

  /**
   * Internal: compress (if worthwhile) → encrypt → frame → chunk → send.
   * Encrypted payloads ride as binary Uint8Array frames over the DataChannel;
   * see the FRAME_* layout at the top of this file. The raw flag distinguishes
   * UI-protocol bytes (delivered via onRawMessage) from AbjectMessage JSON.
   */
  private async sendEncryptedString(data: string, raw = false): Promise<void> {
    const encoder = new TextEncoder();
    let plaintext: Uint8Array = encoder.encode(data);
    let compressed = false;
    if (plaintext.byteLength >= COMPRESS_THRESHOLD) {
      const deflated = deflateSync(plaintext) as Uint8Array;
      // Only adopt the compressed form if it actually shrank — for already
      // dense payloads deflate can grow them slightly.
      if (deflated.byteLength < plaintext.byteLength) {
        plaintext = deflated;
        compressed = true;
      }
    }

    const { iv, ciphertext } = await aesEncryptBytes(this.sessionKey!, plaintext);

    const type = raw
      ? (compressed ? FRAME_ENC_RAW_GZ : FRAME_ENC_RAW)
      : (compressed ? FRAME_ENC_MSG_GZ : FRAME_ENC_MSG);

    const frame = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength);
    frame[0] = type;
    frame.set(iv, 1);
    frame.set(ciphertext, 1 + iv.byteLength);

    if (frame.byteLength <= MAX_CHUNK_SIZE) {
      if (!this.trySend(frame)) {
        throw new Error('DataChannel send failed');
      }
      return;
    }

    const chunkId = this.chunkCounter++;
    const payloadPerChunk = MAX_CHUNK_SIZE - 9; // 1 type + 4 id + 2 idx + 2 total
    const total = Math.ceil(frame.byteLength / payloadPerChunk);
    for (let i = 0; i < total; i++) {
      const slice = frame.subarray(i * payloadPerChunk, (i + 1) * payloadPerChunk);
      const chunkFrame = new Uint8Array(9 + slice.byteLength);
      const dv = new DataView(chunkFrame.buffer);
      chunkFrame[0] = FRAME_CHUNK;
      dv.setUint32(1, chunkId, false);
      dv.setUint16(5, i, false);
      dv.setUint16(7, total, false);
      chunkFrame.set(slice, 9);
      if (!this.trySend(chunkFrame)) {
        throw new Error(`DataChannel send failed mid-chunk (${i + 1}/${total})`);
      }
    }
    log.info(`sent ${total} chunks (${frame.byteLength} bytes binary) to ${this.remotePeerId.slice(0, 16)}`);
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

    // [ICE-DIAG] Log the ICE servers actually applied to this connection so we
    // can confirm TURN creds reached the transport.
    const turnUrls = this.iceServers.flatMap(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.filter(u => u.startsWith('turn'));
    });
    log.info(`[ICE-DIAG] PC for ${this.remotePeerId.slice(0, 12)}: ${this.iceServers.length} iceServers, turn=[${turnUrls.join(',')}], hasUser=${this.iceServers.some(s => !!s.username)}`);

    // Forward ICE candidates to the remote peer via signaling
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        // [ICE-DIAG] Log local candidate type (host/srflx/relay).
        const c = event.candidate.candidate;
        const typ = /typ (\w+)/.exec(c)?.[1] ?? '?';
        log.info(`[ICE-DIAG] LOCAL cand to ${this.remotePeerId.slice(0, 12)}: typ=${typ} ${c.slice(0, 80)}`);
        this.signalingClient.sendIceCandidate(
          this.localPeerId,
          this.remotePeerId,
          event.candidate.toJSON(),
        );
      } else {
        log.info(`[ICE-DIAG] LOCAL gathering complete for ${this.remotePeerId.slice(0, 12)}`);
      }
    };

    // Handle ICE connection state changes
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      if (state === 'failed' || state === 'closed') {
        this.handleDisconnect(`ICE ${state}`);
      } else if (state === 'disconnected') {
        // Temporary disconnection (network blip, laptop sleep/wake).
        // Wait 3s, then disconnect if still not recovered.
        // ICE restart would be ideal but node-datachannel doesn't support
        // iceRestart in createOffer options reliably, so we fall back to
        // a timed disconnect that triggers fast reconnect in PeerRegistry.
        log.info(`ICE disconnected for ${this.remotePeerId.slice(0, 16)}, waiting 3s for recovery...`);
        setTimeout(() => {
          if (this.peerConnection?.iceConnectionState === 'disconnected') {
            this.handleDisconnect('ICE disconnected (no recovery)');
          }
        }, 3_000);
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
    // Receive binary frames as ArrayBuffer (default in browsers is 'blob',
    // which forces an async .arrayBuffer() round-trip per message).
    try { dc.binaryType = 'arraybuffer'; } catch { /* not supported on this stack */ }

    let opened = false;
    const onOpen = () => {
      if (opened) return;
      opened = true;
      // Clear connection timeout — DataChannel is open
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
      }
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
      const d = event.data as unknown;
      if (typeof d === 'string') {
        this.handleIncomingString(d);
      } else if (d instanceof ArrayBuffer) {
        this.handleIncomingBinary(new Uint8Array(d));
      } else if (ArrayBuffer.isView(d)) {
        this.handleIncomingBinary(new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength));
      } else if (d && typeof (d as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
        // Blob fallback (some WebRTC stacks deliver binary as Blob)
        void (d as Blob).arrayBuffer().then((ab) => this.handleIncomingBinary(new Uint8Array(ab)));
      } else {
        log.warn(`unexpected DataChannel message type: ${typeof d}`);
      }
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
    this.trySend(handshakeMsg);
  }

  /**
   * Log an inbound routed message, throttled: the first message logs
   * immediately, then at most one summary line per RECV_LOG_INTERVAL_MS
   * carrying the count of messages received since the last line.
   */
  private logRecv(kind: 'encrypted' | 'unencrypted', message: AbjectMessage): void {
    this.recvLogCount++;
    const now = Date.now();
    if (now - this.recvLogLastEmit < PeerTransport.RECV_LOG_INTERVAL_MS) return;
    const suppressed = this.recvLogCount - 1;
    const tail = suppressed > 0 ? ` (+${suppressed} more in last ${Math.round((now - this.recvLogLastEmit) / 1000)}s)` : '';
    log.info(`recv ${kind} from ${this.remotePeerId.slice(0, 16)}: to=${message.routing.to.slice(0, 20)} type=${message.header.type} method=${message.routing.method ?? '?'}${tail}`);
    this.recvLogCount = 0;
    this.recvLogLastEmit = now;
  }

  /**
   * A routed AbjectMessage arrived but no onMessage consumer is wired (e.g. a
   * RemoteUIAccess transport, which only handles raw UI traffic). The message
   * is dropped; warn (throttled) so this never becomes a silent black hole.
   */
  private logDroppedNoConsumer(message: AbjectMessage): void {
    this.droppedNoConsumerCount++;
    const now = Date.now();
    if (now - this.droppedNoConsumerLastEmit < PeerTransport.RECV_LOG_INTERVAL_MS) return;
    log.warn(`dropping routed message from ${this.remotePeerId.slice(0, 16)} — no onMessage consumer on this transport (to=${message.routing.to.slice(0, 20)} method=${message.routing.method ?? '?'}, ${this.droppedNoConsumerCount} dropped since last report)`);
    this.droppedNoConsumerCount = 0;
    this.droppedNoConsumerLastEmit = now;
  }

  /**
   * Handle an incoming JSON-string DataChannel message: handshake, ping/pong,
   * or (during handshake) an unencrypted AbjectMessage. All encrypted payloads
   * arrive as binary frames via handleIncomingBinary().
   */
  private async handleIncomingString(data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);

      if (parsed.ping) {
        this.trySend(JSON.stringify({ pong: true, ts: parsed.ts }));
        return;
      }
      if (parsed.pong) {
        this.lastPongReceived = Date.now();
        return;
      }

      if (parsed.handshake) {
        await this.handleHandshakeMessage(parsed);
        return;
      }

      // Pre-handshake unencrypted AbjectMessage
      const message = deserialize(data);
      this.logRecv('unencrypted', message);
      if (this.events.onMessage) {
        this.events.onMessage(message);
      } else {
        this.logDroppedNoConsumer(message);
      }
    } catch (err) {
      log.error('Failed to handle string message:', err);
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Handle an incoming binary DataChannel frame — see FRAME_* layout at the
   * top of this file. Reassembles chunks, decrypts, decompresses, and
   * dispatches via onMessage (AbjectMessage) or onRawMessage (UI bytes).
   */
  private async handleIncomingBinary(frame: Uint8Array): Promise<void> {
    try {
      if (frame.byteLength === 0) return;
      const type = frame[0];

      if (type === FRAME_CHUNK) {
        const reassembled = this.handleChunk(frame);
        if (!reassembled) return;
        await this.handleIncomingBinary(reassembled);
        return;
      }

      if (type !== FRAME_ENC_MSG && type !== FRAME_ENC_MSG_GZ
          && type !== FRAME_ENC_RAW && type !== FRAME_ENC_RAW_GZ) {
        log.warn(`unknown binary frame type 0x${type.toString(16)} from ${this.remotePeerId.slice(0, 16)}`);
        return;
      }

      if (!this.sessionKey) {
        log.warn(`recv encrypted binary from ${this.remotePeerId.slice(0, 16)} but no session key yet — dropping`);
        return;
      }

      const iv = frame.subarray(1, 13);
      const ciphertext = frame.subarray(13);
      let plaintext = await aesDecryptBytes(this.sessionKey, iv, ciphertext);
      if (type === FRAME_ENC_MSG_GZ || type === FRAME_ENC_RAW_GZ) {
        plaintext = inflateSync(plaintext);
      }

      const msgData = new TextDecoder().decode(plaintext);

      if (type === FRAME_ENC_RAW || type === FRAME_ENC_RAW_GZ) {
        this.rawMessageHandler?.(msgData);
        return;
      }

      const message = deserialize(msgData);
      this.logRecv('encrypted', message);
      if (this.events.onMessage) {
        this.events.onMessage(message);
      } else {
        this.logDroppedNoConsumer(message);
      }
    } catch (err) {
      log.error('Failed to handle binary frame:', err);
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Handle a binary chunk frame — see FRAME_CHUNK layout at the top of this
   * file. Returns the reassembled complete-frame bytes when all chunks have
   * arrived, or null if still waiting.
   */
  private handleChunk(frame: Uint8Array): Uint8Array | null {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const chunkId = String(dv.getUint32(1, false));
    const idx = dv.getUint16(5, false);
    const total = dv.getUint16(7, false);
    const slice = frame.subarray(9);

    let entry = this.pendingChunks.get(chunkId);
    if (!entry) {
      const timer = setTimeout(() => {
        log.warn(`chunk reassembly timeout for id=${chunkId}, discarding`);
        this.pendingChunks.delete(chunkId);
      }, CHUNK_REASSEMBLY_TIMEOUT);
      const warnTimer = setTimeout(() => {
        const current = this.pendingChunks.get(chunkId);
        if (!current) return;
        log.warn(
          `chunk reassembly slow for id=${chunkId}: ${current.parts.size}/${current.total} after ${CHUNK_REASSEMBLY_WARN_AT}ms from ${this.remotePeerId.slice(0, 16)}`
        );
      }, CHUNK_REASSEMBLY_WARN_AT);
      entry = { total, parts: new Map(), size: 0, timer, warnTimer };
      this.pendingChunks.set(chunkId, entry);
    }

    if (!entry.parts.has(idx)) {
      // subarray shares the backing ArrayBuffer with the original event; copy
      // so the entry survives independent of future incoming frames.
      const copy = new Uint8Array(slice.byteLength);
      copy.set(slice);
      entry.parts.set(idx, copy);
      entry.size += copy.byteLength;
    }

    if (entry.parts.size < entry.total) return null;

    clearTimeout(entry.timer);
    clearTimeout(entry.warnTimer);
    this.pendingChunks.delete(chunkId);

    const out = new Uint8Array(entry.size);
    let off = 0;
    for (let i = 0; i < entry.total; i++) {
      const part = entry.parts.get(i)!;
      out.set(part, off);
      off += part.byteLength;
    }
    log.info(`reassembled ${entry.total} chunks (${out.byteLength} bytes binary) from ${this.remotePeerId.slice(0, 16)}`);
    return out;
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

      this.trySend(JSON.stringify({ ping: true, ts: Date.now() }));
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
      clearTimeout(entry.warnTimer);
    }
    this.pendingChunks.clear();
    super.handleDisconnect(reason);
  }
}
