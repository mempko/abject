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
  /**
   * Lifecycle reports for a caller that keeps its own record of desktops
   * (the p2p client's instance list). Passing this switches the transport to
   * confirmed mode: the channel opens for app data only once the desktop
   * answers the `pair` or `reconnect` message, nothing is written to the
   * paired-desktop list here, and a refused pairing ends the transport
   * instead of retrying.
   */
  events?: WebRTCTransportEvents;
}

export interface WebRTCTransportEvents {
  /** The desktop accepted the pairing (its first message arrived). */
  onPaired?(desktop: PairedDesktop): void;
  /** The desktop accepted a reconnect. */
  onAccepted?(): void;
  /**
   * The pairing will not complete: the desktop hung up on the token, or the
   * link expired before the desktop could be reached. The transport is closed.
   */
  onPairingFailed?(reason: 'refused' | 'expired'): void;
  /**
   * An attempt failed and the next one is scheduled. `refused`: the encrypted
   * channel opened but the desktop hung up instead of accepting.
   */
  onRetry?(info: { attempt: number; delayMs: number; refused: boolean }): void;
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
  /**
   * Confirmed mode: the peer whose `pair`/`reconnect` message is sent but not
   * yet answered. The desktop answers an accepted client with its first
   * message (`authNotRequired`) and hangs up on a refused one.
   */
  private awaitingAccept?: PeerTransport;

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
    // A channel still waiting for the desktop's answer carries nothing else:
    // any frame sent then would land in the desktop's pre-auth parser.
    return !this.closed && !!this.peer && this.peer.isEncrypted && this.awaitingAccept !== this.peer;
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
      if (this.awaitingAccept === peer) this.acceptAnswered(peer);
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
        // Hanging up before answering is how the desktop refuses a client.
        const refused = this.awaitingAccept === peer;
        this.awaitingAccept = undefined;
        if (refused && this.opts.pairing) {
          this.failPairing('refused');
          return;
        }
        this.scheduleReconnect(undefined, refused);
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
    if (this.opts.events) {
      await this.sendAndAwaitAnswer(peer);
      return;
    }
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

  /**
   * Confirmed mode: send `pair` or `reconnect` and wait. The channel opens
   * (and a pairing is reported) only when the desktop answers; see
   * acceptAnswered and the peer's onDisconnect.
   */
  private async sendAndAwaitAnswer(peer: PeerTransport): Promise<void> {
    // Marked before sending, so an answer that arrives at once finds it.
    this.awaitingAccept = peer;
    try {
      const msg = this.opts.pairing
        ? { type: 'pair', token: this.opts.pairing.payload.token, clientName: this.opts.pairing.clientName }
        : { type: 'reconnect' };
      await peer.sendRaw(JSON.stringify(msg));
    } catch (err) {
      if (this.peer !== peer) return;
      this.awaitingAccept = undefined;
      console.warn('[webrtc-transport] sendPairOrReconnect failed:', err);
      this.scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** The desktop answered: it accepted this client. Open the channel for app data. */
  private acceptAnswered(peer: PeerTransport): void {
    this.awaitingAccept = undefined;
    const events = this.opts.events;
    if (this.opts.pairing) {
      const p = this.opts.pairing.payload;
      const now = Date.now();
      const desktop: PairedDesktop = {
        peerId: p.peerId,
        signKey: p.signKey,
        exKey: p.exKey,
        signalingUrl: p.signalingUrl,
        name: p.name,
        pairedAt: now,
        lastConnected: now,
      };
      // The token is single-use: every later attempt is a reconnect.
      this.opts = { reconnect: { desktop }, events };
      events?.onPaired?.(desktop);
    } else {
      events?.onAccepted?.();
    }
    if (this.peer !== peer) return;
    this.reconnectAttempt = 0;
    this.fireOpen();
  }

  /** Confirmed mode: the pairing cannot complete. Stop for good and say why. */
  private failPairing(reason: 'refused' | 'expired'): void {
    const events = this.opts.events;
    console.warn(`[webrtc-transport] pairing ${reason}`);
    this.close();
    if (this.firstOpenReject && !this.firstOpenSettled) {
      this.firstOpenSettled = true;
      this.firstOpenReject(new Error(`pairing ${reason}`));
      this.firstOpenResolve = undefined;
      this.firstOpenReject = undefined;
    }
    this.closeHandler?.();
    events?.onPairingFailed?.(reason);
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

  private scheduleReconnect(err?: Error, refused = false): void {
    if (this.closed) return;
    if (err) console.warn('[webrtc-transport] reconnect after error:', err.message);

    // Confirmed mode: a pairing link is only good until it expires.
    if (this.opts.events && this.opts.pairing && this.opts.pairing.payload.expires < Date.now()) {
      this.failPairing('expired');
      return;
    }

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
    this.opts.events?.onRetry?.({ attempt: this.reconnectAttempt, delayMs: delay, refused });
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
