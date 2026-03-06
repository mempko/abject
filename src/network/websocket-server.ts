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

  constructor(config: WsServerConfig) {
    this.wss = new WsServer({
      port: config.port,
      host: config.host,
      perMessageDeflate: config.perMessageDeflate ?? false,
    });

    this.wss.on('connection', (ws) => {
      this.connections.add(ws);
      ws.on('close', () => {
        this.connections.delete(ws);
      });
    });
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
   * Close the server.
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const ws of this.connections) {
        ws.close(1000, 'Server shutting down');
      }
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
