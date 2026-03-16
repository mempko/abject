/**
 * UITransport — abstraction over the communication channel between
 * BackendUI and the browser FrontendClient.
 *
 * Two implementations:
 *   - WebSocketUITransport: wraps a `ws` WebSocket (main-thread / non-worker mode)
 *   - MessagePortUITransport: wraps a Node.js worker_threads MessagePort (worker mode)
 */

import type { WebSocket } from 'ws';
import type { MessagePort } from 'node:worker_threads';

/**
 * Transport interface for BackendUI ↔ FrontendClient communication.
 */
export interface UITransport {
  /** Send a stringified JSON payload to the frontend. */
  send(data: string): void;

  /** Register a handler for incoming messages (stringified JSON). */
  onMessage(handler: (data: string) => void): void;

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

  send(data: string): void {
    this.ws.send(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.ws.on('message', (raw: Buffer | string) => {
      handler(typeof raw === 'string' ? raw : raw.toString());
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
 * Wraps a Node.js worker_threads MessagePort for relay from the UI worker.
 *
 * The main thread accepts the WebSocket, does auth, then creates a
 * MessageChannel and transfers one port to the UI worker. The main thread
 * relays `ws ↔ port` while the UI worker uses this transport inside BackendUI.
 */
export class MessagePortUITransport implements UITransport {
  private port: MessagePort;
  private _closed = false;

  constructor(port: MessagePort) {
    this.port = port;
  }

  send(data: string): void {
    if (!this._closed) {
      this.port.postMessage(data);
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.port.on('message', (data: unknown) => {
      handler(String(data));
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
