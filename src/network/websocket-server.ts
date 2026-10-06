/**
 * Node.js WebSocket server wrapper using the 'ws' package.
 */

import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer as WsServer, WebSocket } from 'ws';
import type { OriginPolicy } from './origin-policy.js';

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
  /**
   * Plain HTTP requests (not WebSocket upgrades): return true when handled.
   * The server uses it for its local health endpoint.
   */
  onHttpRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  /**
   * Which web pages may connect (see origin-policy.ts). A handshake that
   * carries an Origin the policy refuses is answered 403 before it reaches
   * the WebSocket layer. Handshakes without an Origin come from clients that
   * are not browsers and are always let through. Unset: every page may
   * connect, as before this option existed.
   */
  allowOrigin?: OriginPolicy;
}

/** A ws socket carrying our liveness flag (set on pong, checked on ping). */
type LivenessWs = WebSocket & { isAlive?: boolean };

/** Answer a refused handshake and close the socket once the answer is out. */
function refuseUpgrade(socket: Duplex): void {
  const body = 'Forbidden: pages of this origin may not open this WebSocket.\n';
  socket.once('finish', () => socket.destroy());
  socket.end(
    'HTTP/1.1 403 Forbidden\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body,
  );
}

/**
 * Thin wrapper around the `ws` WebSocketServer for use in Node.js.
 */
export class NodeWebSocketServer {
  private wss: WsServer;
  private httpServer: http.Server;
  private connections: Set<WebSocket> = new Set();
  private _ready: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(config: WsServerConfig) {
    // Back the WebSocket server with a real http.Server so plain HTTP
    // requests (curl, health checks, a stray browser) get a helpful answer
    // instead of ws's built-in "Upgrade Required" (426). WebSocket upgrade
    // requests are handed to ws once their Origin has passed allowOrigin.
    this.httpServer = http.createServer((req, res) => {
      if (config.onHttpRequest?.(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(
        `This is an Abject WebSocket endpoint (ws://${req.headers.host ?? 'localhost'}).\n` +
        'Plain HTTP is not served here — connect with a WebSocket client.\n'
      );
    });
    this.httpServer.listen(config.port, config.host ?? '0.0.0.0');
    // The upgrade is taken here rather than by ws itself so the Origin can be
    // checked before the handshake completes.
    this.wss = new WsServer({
      noServer: true,
      perMessageDeflate: config.perMessageDeflate ?? false,
    });
    this.httpServer.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin;
      if (origin !== undefined && config.allowOrigin && !config.allowOrigin(origin)) {
        // The client may already be gone; an error on a socket nobody is
        // listening to would otherwise be an uncaught exception.
        socket.on('error', () => socket.destroy());
        console.warn(`[WS-SERVER] refused a WebSocket on port ${this.port ?? config.port} from origin ${origin.slice(0, 200)}`);
        refuseUpgrade(socket);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    // Handed the server, ws used to re-emit its errors as its own 'error'
    // event (logged below). Without a server it does not, so log them here.
    this.httpServer.on('error', (err) => {
      console.error(`[WS-SERVER] error:`, err);
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

    // ws does not listen itself (noServer) — wait on the underlying
    // http.Server.
    this._ready = new Promise<void>((resolve, reject) => {
      this.httpServer.once('listening', () => {
        const addr = this.httpServer.address();
        const addrStr = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : String(addr);
        console.log(`[WS-SERVER] listening on ${addrStr} (T+${Math.round(performance.now())}ms)`);
        resolve();
      });
      this.httpServer.once('error', reject);
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

  /** The port actually bound (the one the OS chose when given port 0), once listening. */
  get port(): number | undefined {
    const addr = this.httpServer.address();
    return typeof addr === 'object' && addr ? addr.port : undefined;
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

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // ws leaves a server it was given open: close the listener too, or the
    // port stays bound (and the process alive) after close() returns.
    this.httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  /**
   * Get connected client count.
   */
  get clientCount(): number {
    return this.connections.size;
  }
}
