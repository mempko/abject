/**
 * WebSocket implementation of ClientTransport — the existing local-dev
 * connection path. Owns reconnect / backoff logic that previously lived
 * inside FrontendClient.
 */

import type { ClientTransport } from './transport.js';

export class WebSocketClientTransport implements ClientTransport {
  readonly kind = 'websocket' as const;
  private url: string;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private msgHandler?: (data: string | Uint8Array) => void;
  private openHandler?: () => void;
  private closeHandler?: () => void;
  private firstOpenResolve?: () => void;

  // Stay at 200ms for many attempts to catch tsx --watch restarts quickly,
  // then back off to 1s. ECONNREFUSED returns instantly on localhost.
  private static readonly RECONNECT_DELAYS = [100, 100, 200, 200, 200, 200, 200, 200, 200, 200, 500, 1000];

  /** Pending auto-reconnect timer, so a visibility change can preempt it. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(url: string) {
    this.url = url;
    // Background tabs get their timers throttled (Chrome wakes them as
    // rarely as once a minute), so a 1s reconnect delay can silently become
    // 30-60s while the tab is hidden. Reconnect IMMEDIATELY when the tab
    // becomes visible/focused or the network returns, instead of waiting
    // out a throttled timer.
    const kick = () => this.kickReconnect();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') kick();
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', kick);
      window.addEventListener('online', kick);
    }
  }

  /** If a reconnect is pending on a timer, run it now. */
  private kickReconnect(): void {
    if (this.closed || this.ws || this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    console.log(`[Frontend] Reconnecting now (tab visible/network back, attempt ${this.reconnectAttempt})...`);
    this.openWebSocket();
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.firstOpenResolve = resolve;
      this.openWebSocket();
    });
  }

  send(data: string | Uint8Array): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(data);
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
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      clog('onopen fired');
      console.log('[Frontend] Connected to backend');
      this.reconnectAttempt = 0;
      this.fireOpen();
    };

    this.ws.onmessage = (evt) => {
      try {
        const data = evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data) : evt.data as string;
        this.msgHandler?.(data);
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
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
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
