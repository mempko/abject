/**
 * UITransport — abstraction over the communication channel between
 * BackendUI and the browser FrontendClient.
 *
 * Payloads are binary wire-codec frames (Uint8Array) for the UI protocol,
 * plus plain JSON strings for the pre-attach auth exchange. Transports pass
 * both through unchanged; encoding/decoding happens at the endpoints.
 *
 * Two implementations:
 *   - WebSocketUITransport: wraps a `ws` WebSocket (main-thread / non-worker mode)
 *   - MessagePortUITransport: wraps a Node.js worker_threads MessagePort (worker mode)
 */

import type { WebSocket } from 'ws';
import type { MessagePort } from 'node:worker_threads';

/** A UI protocol payload: binary wire frame or pre-auth JSON string. */
export type UIWireData = string | Uint8Array;

/**
 * Normalize whatever a socket/port delivered into UIWireData.
 */
export function toUIWireData(data: unknown): UIWireData {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return String(data);
}

/**
 * Post UIWireData across a MessagePort, transferring the underlying buffer
 * when the view owns it outright (zero-copy). Views into shared/pooled
 * buffers are structured-cloned instead — transferring their backing buffer
 * would detach bytes someone else still owns.
 */
export function postUIWireData(
  port: { postMessage(value: unknown, transferList?: readonly unknown[]): void },
  data: UIWireData,
): void {
  if (typeof data !== 'string'
      && data.byteOffset === 0
      && data.byteLength === data.buffer.byteLength
      && !(data.buffer instanceof SharedArrayBuffer)) {
    port.postMessage(data, [data.buffer]);
  } else {
    port.postMessage(data);
  }
}

/**
 * Transport interface for BackendUI ↔ FrontendClient communication.
 */
export interface UITransport {
  /** Send a wire frame (or pre-auth JSON string) to the frontend. */
  send(data: UIWireData): void;

  /** Register a handler for incoming payloads. */
  onMessage(handler: (data: UIWireData) => void): void;

  /** Register a handler for transport close / disconnect. */
  onClose(handler: () => void): void;

  /** Close the transport. */
  close(code?: number, reason?: string): void;

  /** Whether the transport is connected and ready to send. */
  readonly ready: boolean;
}

/**
 * Wraps a `ws` WebSocket for direct main-thread use.
 */
export class WebSocketUITransport implements UITransport {
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  send(data: UIWireData): void {
    this.ws.send(data);
  }

  onMessage(handler: (data: UIWireData) => void): void {
    this.ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      handler(normalizeWsPayload(raw, isBinary));
    });
  }

  onClose(handler: () => void): void {
    this.ws.on('close', handler);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  get ready(): boolean {
    return this.ws.readyState === 1;
  }
}

/**
 * Normalize the `ws` message event payload: binary frames become a single
 * Uint8Array, text frames become a string.
 */
export function normalizeWsPayload(raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): UIWireData {
  let bytes: Uint8Array;
  if (Array.isArray(raw)) {
    const total = raw.reduce((n, b) => n + b.byteLength, 0);
    bytes = new Uint8Array(total);
    let off = 0;
    for (const b of raw) {
      bytes.set(b, off);
      off += b.byteLength;
    }
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else {
    bytes = raw;
  }
  if (isBinary) return bytes;
  return new TextDecoder().decode(bytes);
}

/**
 * Wraps a Node.js worker_threads MessagePort for relay from the UI worker.
 *
 * The main thread accepts the WebSocket, does auth, then creates a
 * MessageChannel and transfers one port to the UI worker. The main thread
 * relays `ws ↔ port` while the UI worker uses this transport inside BackendUI.
 * Binary frames cross the port as transferred ArrayBuffers (zero-copy).
 */
export class MessagePortUITransport implements UITransport {
  private port: MessagePort;
  private _closed = false;

  constructor(port: MessagePort) {
    this.port = port;
  }

  send(data: UIWireData): void {
    if (!this._closed) {
      postUIWireData(this.port, data);
    }
  }

  onMessage(handler: (data: UIWireData) => void): void {
    this.port.on('message', (data: unknown) => {
      handler(toUIWireData(data));
    });
  }

  onClose(handler: () => void): void {
    this.port.on('close', handler);
  }

  close(_code?: number, _reason?: string): void {
    this._closed = true;
    this.port.close();
  }

  get ready(): boolean {
    return !this._closed;
  }
}
