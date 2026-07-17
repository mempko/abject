/**
 * Node.js WebSocket server wrapper using the 'ws' package.
 */

import { WebSocketServer as WsServer, WebSocket } from 'ws';

export interface WsServerConfig {
  port: number;
  host?: string;
  perMessageDeflate?: boolean | object;
  /**
   * Heartbeat interval (ms). Every interval each connection is pinged; any
   * that failed to pong since the previous ping is force-terminated. This is
   * the ONLY thing that reaps half-open sockets (laptop sleep, network change,
   * a browser killed without a clean close) — without it their 'close' event
   * never fires and their per-client server state (send queues, wire codecs,
   * retained blob refs) leaks forever. Default 30s. Set 0 to disable.
   */
  heartbeatMs?: number;
}

/** A ws socket carrying our liveness flag (set on pong, checked on ping). */
type LivenessWs = WebSocket & { isAlive?: boolean };

/**
 * Thin wrapper around the `ws` WebSocketServer for use in Node.js.
 */
export class NodeWebSocketServer {
  private wss: WsServer;
  private connections: Set<WebSocket> = new Set();
  private _ready: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(config: WsServerConfig) {
    this.wss = new WsServer({
      port: config.port,
      host: config.host ?? '0.0.0.0',
      perMessageDeflate: config.perMessageDeflate ?? false,
    });

    const heartbeatMs = config.heartbeatMs ?? 30_000;
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        for (const ws of this.connections) {
          const live = ws as LivenessWs;
          if (live.isAlive === false) {
            // Missed the previous round's pong — the peer is gone. terminate()
            // fires 'close' synchronously, pruning it here and in BackendUI.
            live.terminate();
            continue;
          }
          live.isAlive = false;
          try { live.ping(); } catch { /* already closing */ }
        }
      }, heartbeatMs);
      // Don't keep the process alive just for the heartbeat.
      this.heartbeat.unref?.();
    }

    this._ready = new Promise<void>((resolve, reject) => {
      this.wss.once('listening', () => {
        const addr = this.wss.address();
        const addrStr = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : String(addr);
        console.log(`[WS-SERVER] listening on ${addrStr} (T+${Math.round(performance.now())}ms)`);
        resolve();
      });
      this.wss.once('error', reject);
    });

    this.wss.on('error', (err) => {
      console.error(`[WS-SERVER] error:`, err);
    });

    this.wss.on('connection', (ws) => {
      const live = ws as LivenessWs;
      live.isAlive = true;
      this.connections.add(ws);
      ws.on('pong', () => { live.isAlive = true; });
      ws.on('close', () => {
        this.connections.delete(ws);
      });
    });
  }

  /**
   * Wait for the server to be listening on its port.
   */
  ready(): Promise<void> {
    return this._ready;
  }

  /**
   * Register a handler for new connections.
   */
  onConnection(handler: (ws: WebSocket) => void): void {
    this.wss.on('connection', handler);
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(data: string): void {
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Close the server and release the port immediately.
   * Force-terminates all connections so the port is freed without TIME_WAIT.
   */
  async close(): Promise<void> {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    // Terminate all connections immediately (don't wait for graceful close)
    for (const ws of this.connections) {
      ws.terminate();
    }
    this.connections.clear();

    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Get connected client count.
   */
  get clientCount(): number {
    return this.connections.size;
  }
}
