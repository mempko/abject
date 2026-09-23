/**
 * WebRTC implementation of ClientTransport.
 *
 * Reuses the existing PeerTransport + SignalingClient from src/network/.
 * The browser holds its own keypair (via identity-store) and connects to a
 * known desktop's peerId. Once the encrypted DataChannel is up, sends a
 * single pairing/reconnect message (JSON) and then carries the regular UI
 * protocol as binary wire-codec frames over sendRaw.
 */

import type { ClientTransport } from './transport.js';
import type { PairingPayload } from './pairing.js';
import { SignalingClient } from '../src/network/signaling.js';
import { PeerTransport } from '../src/network/peer-transport.js';
import { getBrowserIdentity, BrowserIdentity } from './identity-store.js';
import {
  PairedDesktop,
  savePairedDesktop,
  touchLastConnected,
  removePairedDesktop,
  getPairedDesktop,
} from './paired-desktops.js';

export interface WebRTCTransportOptions {
  /** Set when this is a fresh pairing (from `?pair=…`). */
  pairing?: { payload: PairingPayload; clientName: string };
  /** Set when reconnecting to an already-paired desktop. */
  reconnect?: { desktop: PairedDesktop };
}

export class WebRTCClientTransport implements ClientTransport {
  readonly kind = 'webrtc' as const;
  private opts: WebRTCTransportOptions;
  private identity?: BrowserIdentity;
  private signaling?: SignalingClient;
  private peer?: PeerTransport;
  private iceServers?: RTCIceServer[];

  private msgHandler?: (data: string | Uint8Array) => void;
  private openHandler?: () => void;
  private closeHandler?: () => void;
  private firstOpenResolve?: () => void;
  private firstOpenReject?: (err: Error) => void;
  private firstOpenSettled = false;

  private closed = false;
  private reconnectAttempt = 0;
  /**
   * Pending reconnect timer. Only one reconnect chain may exist at a time:
   * every failure path funnels through scheduleReconnect, and a second call
   * while a timer is pending is a no-op. Without this, a stale peer's
   * onDisconnect and a fresh signaling onConnect could each start their own
   * handshake, and the desktop (which treats any new offer from a paired
   * peer as "the old transport is stale") would tear down the healthy
   * session on every offer, reconnecting the phone every couple of seconds.
   */
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: WebRTCTransportOptions) {
    if (!opts.pairing && !opts.reconnect) {
      throw new Error('WebRTCClientTransport requires either pairing or reconnect options');
    }
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.firstOpenResolve = resolve;
      this.firstOpenReject = reject;
      this.firstOpenSettled = false;
      void this.openPeerConnection();
    });
  }

  send(data: string | Uint8Array): void {
    if (this.peer && this.peer.isEncrypted) {
      void this.peer.sendRaw(data).catch((err) => {
        console.warn('[webrtc-transport] sendRaw failed:', err);
      });
    }
  }

  onMessage(handler: (data: string | Uint8Array) => void): void {
    this.msgHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.teardownCurrent();
  }

  /**
   * Drop the current peer and signaling client. References are cleared
   * BEFORE disconnect() runs: PeerTransport fires onDisconnect on a local
   * disconnect too, and every handler below checks that it still belongs
   * to the current peer/signaling before acting, so a torn-down instance
   * can never schedule a reconnect of its own.
   */
  private teardownCurrent(): void {
    const peer = this.peer;
    const signaling = this.signaling;
    this.peer = undefined;
    this.signaling = undefined;
    if (peer) void peer.disconnect().catch(() => {});
    if (signaling) void signaling.disconnect().catch(() => {});
  }

  get ready(): boolean {
    return !this.closed && !!this.peer && this.peer.isEncrypted;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private remoteInfo(): { peerId: string; signKey: string; exKey: string; signalingUrl: string; name: string } {
    if (this.opts.pairing) {
      const p = this.opts.pairing.payload;
      return { peerId: p.peerId, signKey: p.signKey, exKey: p.exKey, signalingUrl: p.signalingUrl, name: p.name };
    }
    const d = this.opts.reconnect!.desktop;
    return { peerId: d.peerId, signKey: d.signKey, exKey: d.exKey, signalingUrl: d.signalingUrl, name: d.name };
  }

  private async openPeerConnection(): Promise<void> {
    if (this.closed) return;
    // Single-flight: a peer or signaling client already in progress means a
    // connection attempt is underway. Its own success/failure path decides
    // what happens next; starting a parallel attempt would only race it.
    if (this.peer || this.signaling) return;
    const remote = this.remoteInfo();
    console.log(`[webrtc-transport] connecting to ${remote.peerId.slice(0, 16)}… via ${remote.signalingUrl}`);

    try {
      this.identity = await getBrowserIdentity();
    } catch (err) {
      this.handleFatal(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const signaling = new SignalingClient();
    signaling.setPersistent(true);
    this.signaling = signaling;

    signaling.on({
      onConnect: () => {
        // A torn-down signaling client can still fire (its socket may open
        // after teardownCurrent ran); it no longer speaks for this transport.
        if (this.signaling !== signaling || this.closed) return;
        signaling.register(this.identity!.peerId,
          this.identity!.publicSigningKeyJwk,
          this.identity!.publicExchangeKeyJwk,
          'remote-ui-client');
        // The signaling socket is persistent and fires onConnect again on
        // every reconnect of its own (server ping timeout, network blip,
        // phone waking up). An established DataChannel does not need
        // signaling at all, so a later onConnect only re-registers: the
        // desktop treats any fresh offer from a paired peer as "the old
        // transport is stale" and drops the live session, so re-offering
        // over a healthy DataChannel produced a perpetual reconnect loop.
        // A peer still negotiating may have lost its answer with the old
        // socket; that one is replaced by a fresh offer.
        const current = this.peer;
        if (current) {
          if (current.isEncrypted) return;
          console.log('[webrtc-transport] signaling reconnected mid-handshake; re-offering');
          this.peer = undefined;
          void current.disconnect().catch(() => {});
        }
        // Fetch ICE servers (STUN + TURN relay creds) from the signaling
        // server, then initiate the SDP offer. TURN lets the DataChannel
        // form even on symmetric-NAT cell networks where direct fails.
        void (async () => {
          try {
            const servers = await signaling.requestIceServers();
            if (servers.length > 0) this.iceServers = servers;
          } catch { /* fall back to default STUN */ }
          if (this.signaling !== signaling || this.closed || this.peer) return;
          await this.initiatePeerHandshake(remote);
        })();
      },
      onSdpAnswer: (fromPeerId, sdp) => {
        if (this.signaling !== signaling) return;
        if (fromPeerId === remote.peerId && this.peer) {
          void this.peer.handleSdpAnswer(sdp).catch((err) => {
            console.warn('[webrtc-transport] handleSdpAnswer failed:', err);
          });
        }
      },
      onIceCandidate: (fromPeerId, candidate) => {
        if (this.signaling !== signaling) return;
        if (fromPeerId === remote.peerId && this.peer) {
          void this.peer.handleIceCandidate(candidate).catch(() => { /* ignore */ });
        }
      },
      onError: (err) => console.warn('[webrtc-transport] signaling error:', err),
    });

    try {
      await signaling.connect(remote.signalingUrl);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }

  private async initiatePeerHandshake(remote: { peerId: string }): Promise<void> {
    if (!this.identity || !this.signaling || this.closed) return;

    const peer = new PeerTransport({
      localPeerId: this.identity.peerId,
      remotePeerId: remote.peerId,
      signalingClient: this.signaling,
      localPublicSigningKey: this.identity.publicSigningKeyJwk,
      localPublicExchangeKey: this.identity.publicExchangeKeyJwk,
      localExchangePrivateKey: this.identity.exchangeKeyPair.privateKey,
      iceServers: this.iceServers,
    });
    this.peer = peer;

    // Every handler checks it still belongs to the current peer: a peer that
    // teardownCurrent or a mid-handshake re-offer replaced keeps firing
    // events (PeerTransport reports its own local disconnect), and those
    // must not disturb the peer that replaced it.
    peer.onRawMessage((data) => {
      if (this.peer !== peer) return;
      this.msgHandler?.(data);
    });

    peer.on({
      onConnect: () => {
        if (this.peer !== peer) return;
        // PeerTransport's onConnect fires after the encrypted handshake.
        void this.sendPairOrReconnect(peer);
      },
      onDisconnect: (reason) => {
        if (this.peer !== peer) return;
        console.log(`[webrtc-transport] peer disconnected: ${reason ?? 'unknown'}`);
        this.scheduleReconnect();
      },
      onError: (err) => {
        if (this.peer !== peer) return;
        console.warn('[webrtc-transport] peer error:', err);
      },
    });

    try {
      await peer.connect('webrtc');
    } catch (err) {
      if (this.peer !== peer) return;
      this.scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async sendPairOrReconnect(peer: PeerTransport): Promise<void> {
    if (this.peer !== peer) return;
    try {
      if (this.opts.pairing) {
        const p = this.opts.pairing.payload;
        await peer.sendRaw(JSON.stringify({
          type: 'pair',
          token: p.token,
          clientName: this.opts.pairing.clientName,
        }));
        // Persist the pairing locally so future visits can reconnect.
        const desktop: PairedDesktop = {
          peerId: p.peerId,
          signKey: p.signKey,
          exKey: p.exKey,
          signalingUrl: p.signalingUrl,
          name: p.name,
          pairedAt: Date.now(),
          lastConnected: Date.now(),
        };
        savePairedDesktop(desktop);
        // Switch internal state to "reconnect mode" so any future reconnect
        // sends `reconnect` instead of `pair` (the token is single-use).
        this.opts = { reconnect: { desktop } };
      } else {
        await peer.sendRaw(JSON.stringify({ type: 'reconnect' }));
        const d = this.opts.reconnect!.desktop;
        touchLastConnected(d.peerId);
      }
      if (this.peer !== peer) return;
      this.reconnectAttempt = 0;
      this.fireOpen();
    } catch (err) {
      if (this.peer !== peer) return;
      console.warn('[webrtc-transport] sendPairOrReconnect failed:', err);
      this.scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private fireOpen(): void {
    if (this.firstOpenResolve && !this.firstOpenSettled) {
      this.firstOpenSettled = true;
      const r = this.firstOpenResolve;
      this.firstOpenResolve = undefined;
      this.firstOpenReject = undefined;
      r();
    }
    this.openHandler?.();
  }

  private scheduleReconnect(err?: Error): void {
    if (this.closed) return;
    if (err) console.warn('[webrtc-transport] reconnect after error:', err.message);

    // Tear down the previous peer/signaling before retrying. References are
    // cleared before disconnect() runs, so the torn-down peer's own
    // onDisconnect (fired on a local disconnect) is ignored by its guard
    // instead of re-entering here and starting a second chain.
    this.teardownCurrent();

    // Single-flight: one pending reconnect at a time.
    if (this.reconnectTimer !== undefined) return;

    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30_000);
    console.log(`[webrtc-transport] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      void this.openPeerConnection();
    }, delay);
  }

  private handleFatal(err: Error): void {
    if (this.firstOpenReject && !this.firstOpenSettled) {
      this.firstOpenSettled = true;
      this.firstOpenReject(err);
      this.firstOpenResolve = undefined;
      this.firstOpenReject = undefined;
    }
    this.closed = true;
    this.closeHandler?.();
  }
}

// Re-export for callers that may want to forget a paired desktop manually.
export { removePairedDesktop, getPairedDesktop };
