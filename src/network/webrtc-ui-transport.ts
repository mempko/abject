/**
 * WebRTCUITransport — UITransport implementation backed by an encrypted
 * PeerTransport DataChannel. Used for browser ↔ server UI traffic over WebRTC
 * once a remote UI client has been paired.
 *
 * The PeerTransport handles WebRTC signaling, identity handshake, and
 * AES-256-GCM encryption. This wrapper exposes the simple `send(string)` /
 * `onMessage(string)` API expected by BackendUI by calling sendRaw/onRawMessage
 * on the underlying PeerTransport (bypassing AbjectMessage serialization).
 */

import type { PeerTransport } from './peer-transport.js';

/**
 * Minimal UITransport shape — duplicates the contract from `server/ui-transport.ts`
 * so this module remains importable from worker contexts that don't pull in
 * server-only imports (`ws`, `node:worker_threads`).
 */
export interface UITransportLike {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(code?: number, reason?: string): void;
  readonly ready: boolean;
}

export class WebRTCUITransport implements UITransportLike {
  private peer: PeerTransport;
  private msgHandler?: (data: string) => void;
  private closeHandler?: () => void;
  private _closed = false;

  constructor(peer: PeerTransport) {
    this.peer = peer;
    this.peer.onRawMessage((s) => this.msgHandler?.(s));
    this.peer.on({
      onDisconnect: () => {
        this._closed = true;
        this.closeHandler?.();
      },
    });
  }

  send(data: string): void {
    if (this._closed) return;
    void this.peer.sendRaw(data).catch(() => {
      this._closed = true;
      this.closeHandler?.();
    });
  }

  onMessage(handler: (data: string) => void): void {
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
