/**
 * WebSocket implementation of ClientTransport — the existing local-dev
 * connection path. Owns reconnect / backoff logic that previously lived
 * inside FrontendClient.
 */

import type { ClientTransport } from './transport.js';

export class WebSocketClientTransport implements ClientTransport {
  private url: string;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private msgHandler?: (data: string) => void;
  private openHandler?: () => void;
  private closeHandler?: () => void;
  private firstOpenResolve?: () => void;

  // Stay at 200ms for many attempts to catch tsx --watch restarts quickly,
  // then back off to 1s. ECONNREFUSED returns instantly on localhost.
  private static readonly RECONNECT_DELAYS = [100, 100, 200, 200, 200, 200, 200, 200, 200, 200, 500, 1000];

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.firstOpenResolve = resolve;
      this.openWebSocket();
    });
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(data);
    }
  }

  onMessage(handler: (data: string) => void): void {
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
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  get ready(): boolean {
    return !this.closed && !!this.ws && this.ws.readyState === 1;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private openWebSocket(): void {
    const t0 = performance.now();
    const clog = (msg: string) => console.log(`[WS-CLIENT T+${Math.round(performance.now() - t0)}ms] ${msg}`);

    clog(`new WebSocket(${this.url})`);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      clog('onopen fired');
      console.log('[Frontend] Connected to backend');
      this.reconnectAttempt = 0;
      this.fireOpen();
    };

    this.ws.onmessage = (evt) => {
      try {
        this.msgHandler?.(evt.data as string);
      } catch (err) {
        console.error('[Frontend] Failed to handle backend message:', err);
      }
    };

    this.ws.onclose = (ev) => {
      clog(`onclose fired (code=${ev.code})`);
      console.log(`[Frontend] Disconnected from backend (code=${ev.code})`);
      this.ws = null;

      if (this.closed) {
        this.closeHandler?.();
        return;
      }

      // Auto-reconnect with backoff.
      const delays = WebSocketClientTransport.RECONNECT_DELAYS;
      const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
      this.reconnectAttempt++;
      setTimeout(() => {
        if (this.closed) return;
        console.log(`[Frontend] Reconnecting (attempt ${this.reconnectAttempt}, delay ${delay}ms)...`);
        this.openWebSocket();
      }, delay);
    };

    this.ws.onerror = (err) => {
      clog('onerror fired');
      console.error('[Frontend] WebSocket error:', err);
    };
  }

  private fireOpen(): void {
    if (this.firstOpenResolve) {
      const r = this.firstOpenResolve;
      this.firstOpenResolve = undefined;
      r();
    }
    this.openHandler?.();
  }
}
