/**
 * WebRTCUITransport — UITransport implementation backed by an encrypted
 * PeerTransport DataChannel. Used for browser ↔ server UI traffic over WebRTC
 * once a remote UI client has been paired.
 *
 * The PeerTransport handles WebRTC signaling, identity handshake, and
 * AES-256-GCM encryption. This wrapper exposes the `send` / `onMessage`
 * API expected by BackendUI by calling sendRaw/onRawMessage on the
 * underlying PeerTransport (bypassing AbjectMessage serialization).
 * Payloads are binary wire-codec frames plus pre-auth JSON strings.
 */

import type { PeerTransport } from './peer-transport.js';

/** A UI protocol payload: binary wire frame or pre-auth JSON string. */
export type UIWireDataLike = string | Uint8Array;

/**
 * Minimal UITransport shape — duplicates the contract from `server/ui-transport.ts`
 * so this module remains importable from worker contexts that don't pull in
 * server-only imports (`ws`, `node:worker_threads`).
 */
export interface UITransportLike {
  send(data: UIWireDataLike): void;
  onMessage(handler: (data: UIWireDataLike) => void): void;
  onClose(handler: () => void): void;
  close(code?: number, reason?: string): void;
  readonly ready: boolean;
}

export class WebRTCUITransport implements UITransportLike {
  private peer: PeerTransport;
  private msgHandler?: (data: UIWireDataLike) => void;
  private closeHandler?: () => void;
  private _closed = false;

  constructor(peer: PeerTransport) {
    this.peer = peer;
    this.peer.onRawMessage((bytes) => this.msgHandler?.(bytes));
    this.peer.on({
      onDisconnect: () => {
        this._closed = true;
        this.closeHandler?.();
      },
    });
  }

  send(data: UIWireDataLike): void {
    if (this._closed) return;
    void this.peer.sendRaw(data).catch(() => {
      this._closed = true;
      this.closeHandler?.();
    });
  }

  onMessage(handler: (data: UIWireDataLike) => void): void {
    this.msgHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(_code?: number, _reason?: string): void {
    this._closed = true;
    void this.peer.disconnect();
  }

  get ready(): boolean {
    return !this._closed && this.peer.isEncrypted;
  }
}
