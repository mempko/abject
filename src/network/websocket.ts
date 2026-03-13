/**
 * WebSocket transport implementation.
 */

import { AbjectMessage } from '../core/types.js';
import { require } from '../core/contracts.js';
import { serialize } from '../core/message.js';
import { Transport, TransportConfig } from './transport.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WebSocket');

export interface WebSocketConfig extends TransportConfig {
  protocols?: string[];
}

/**
 * WebSocket transport for cross-machine communication.
 */
export class WebSocketTransport extends Transport {
  private socket?: WebSocket;
  private endpoint?: string;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private protocols?: string[];

  constructor(config: WebSocketConfig = {}) {
    super(config);
    this.protocols = config.protocols;
  }

  async connect(endpoint: string): Promise<void> {
    require(endpoint !== '', 'endpoint is required');

    this.endpoint = endpoint;
    this.setState('connecting');

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(endpoint, this.protocols);

        this.socket.onopen = () => {
          this.reconnectAttempts = 0;
          this.handleConnect();
          this.startHeartbeat();
          resolve();
        };

        this.socket.onclose = (event) => {
          this.stopHeartbeat();
          this.handleDisconnect(event.reason || 'Connection closed');

          if (this.config.reconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        };

        this.socket.onerror = (event) => {
          const error = new Error('WebSocket error');
          this.handleError(error);
          reject(error);
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleError(error);
        reject(error);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.config.reconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = undefined;
    }

    this.handleDisconnect('Client disconnect');
  }

  async send(message: AbjectMessage): Promise<void> {
    require(this.isConnected, 'Not connected');
    require(this.socket !== undefined, 'Socket not initialized');

    const data = serialize(message);
    this.socket!.send(data);
  }

  /**
   * Start heartbeat to keep connection alive.
   */
  private startHeartbeat(): void {
    if (this.config.heartbeatInterval <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        // Send ping frame - WebSocket API handles this at protocol level
        // For application-level heartbeat, we could send a special message
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    log.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.endpoint) {
        this.connect(this.endpoint).catch(console.error);
      }
    }, delay);
  }

  /**
   * Clear reconnect timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Get the WebSocket ready state.
   */
  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  /**
   * Get the endpoint URL.
   */
  get url(): string | undefined {
    return this.endpoint;
  }
}

/**
 * Create a WebSocket server adapter for Node.js environments.
 * This is a placeholder - actual implementation would use 'ws' package.
 */
export interface WebSocketServer {
  onConnection(handler: (transport: WebSocketTransport) => void): void;
  close(): Promise<void>;
}

/**
 * WebSocket connection manager for multiple peers.
 */
export class WebSocketConnectionManager {
  private connections: Map<string, WebSocketTransport> = new Map();

  /**
   * Connect to a peer.
   */
  async connect(peerId: string, endpoint: string): Promise<WebSocketTransport> {
    if (this.connections.has(peerId)) {
      return this.connections.get(peerId)!;
    }

    const transport = new WebSocketTransport();
    await transport.connect(endpoint);

    this.connections.set(peerId, transport);
    return transport;
  }

  /**
   * Disconnect from a peer.
   */
  async disconnect(peerId: string): Promise<void> {
    const transport = this.connections.get(peerId);
    if (transport) {
      await transport.disconnect();
      this.connections.delete(peerId);
    }
  }

  /**
   * Get connection to a peer.
   */
  get(peerId: string): WebSocketTransport | undefined {
    return this.connections.get(peerId);
  }

  /**
   * Get all connections.
   */
  getAll(): Map<string, WebSocketTransport> {
    return new Map(this.connections);
  }

  /**
   * Disconnect all peers.
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.values()).map((t) =>
      t.disconnect()
    );
    await Promise.all(promises);
    this.connections.clear();
  }

  /**
   * Get connected peer count.
   */
  get peerCount(): number {
    return this.connections.size;
  }
}
