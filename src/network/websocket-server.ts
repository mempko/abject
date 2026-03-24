/**
 * Node.js WebSocket server wrapper using the 'ws' package.
 */

import { WebSocketServer as WsServer, WebSocket } from 'ws';

export interface WsServerConfig {
  port: number;
  host?: string;
  perMessageDeflate?: boolean | object;
}

/**
 * Thin wrapper around the `ws` WebSocketServer for use in Node.js.
 */
export class NodeWebSocketServer {
  private wss: WsServer;
  private connections: Set<WebSocket> = new Set();
  private _ready: Promise<void>;

  constructor(config: WsServerConfig) {
    this.wss = new WsServer({
      port: config.port,
      host: config.host ?? '0.0.0.0',
      perMessageDeflate: config.perMessageDeflate ?? false,
    });

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
      this.connections.add(ws);
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
