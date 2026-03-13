/**
 * Transport abstraction for network communication.
 */

import { AbjectMessage } from '../core/types.js';
import { require } from '../core/contracts.js';
import { serialize, deserialize } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Transport');

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TransportConfig {
  reconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
}

export interface TransportEvents {
  onConnect?: () => void;
  onDisconnect?: (reason?: string) => void;
  onMessage?: (message: AbjectMessage) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: ConnectionState) => void;
}

/**
 * Abstract transport interface.
 */
export abstract class Transport {
  protected state: ConnectionState = 'disconnected';
  protected events: TransportEvents = {};
  protected config: Required<TransportConfig>;

  constructor(config: TransportConfig = {}) {
    this.config = {
      reconnect: config.reconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? 1000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
    };
  }

  /**
   * Get current connection state.
   */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Set event handlers.
   */
  on(events: TransportEvents): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * Connect to remote endpoint.
   */
  abstract connect(endpoint: string): Promise<void>;

  /**
   * Disconnect from remote endpoint.
   */
  abstract disconnect(): Promise<void>;

  /**
   * Send a message.
   */
  abstract send(message: AbjectMessage): Promise<void>;

  /**
   * Set connection state and notify.
   */
  protected setState(state: ConnectionState): void {
    const oldState = this.state;
    this.state = state;

    if (oldState !== state) {
      this.events.onStateChange?.(state);
    }
  }

  /**
   * Handle incoming message data.
   */
  protected handleMessage(data: string): void {
    try {
      const message = deserialize(data);
      this.events.onMessage?.(message);
    } catch (err) {
      log.error('Failed to parse message:', err);
      this.events.onError?.(
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  /**
   * Handle connection established.
   */
  protected handleConnect(): void {
    this.setState('connected');
    this.events.onConnect?.();
  }

  /**
   * Handle disconnection.
   */
  protected handleDisconnect(reason?: string): void {
    this.setState('disconnected');
    this.events.onDisconnect?.(reason);
  }

  /**
   * Handle error.
   */
  protected handleError(error: Error): void {
    this.setState('error');
    this.events.onError?.(error);
  }
}

/**
 * Transport registry for managing multiple connections.
 */
export class TransportRegistry {
  private transports: Map<string, Transport> = new Map();

  /**
   * Register a transport.
   */
  register(id: string, transport: Transport): void {
    require(id !== '', 'id must not be empty');
    this.transports.set(id, transport);
  }

  /**
   * Unregister a transport.
   */
  unregister(id: string): void {
    const transport = this.transports.get(id);
    if (transport) {
      transport.disconnect().catch(console.error);
      this.transports.delete(id);
    }
  }

  /**
   * Get a transport by ID.
   */
  get(id: string): Transport | undefined {
    return this.transports.get(id);
  }

  /**
   * Get all transports.
   */
  getAll(): Transport[] {
    return Array.from(this.transports.values());
  }

  /**
   * Get all connected transports.
   */
  getConnected(): Transport[] {
    return Array.from(this.transports.values()).filter((t) => t.isConnected);
  }

  /**
   * Disconnect all transports.
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.transports.values()).map((t) =>
      t.disconnect()
    );
    await Promise.all(promises);
  }
}

/**
 * Mock transport for testing.
 */
export class MockTransport extends Transport {
  private peer?: MockTransport;
  private connected = false;

  async connect(_endpoint: string): Promise<void> {
    this.setState('connecting');
    // Simulate connection delay
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.connected = true;
    this.handleConnect();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handleDisconnect();
  }

  async send(message: AbjectMessage): Promise<void> {
    require(this.connected, 'Not connected');

    // Send to peer if connected
    if (this.peer?.connected) {
      const data = serialize(message);
      // Simulate network delay
      setTimeout(() => {
        this.peer!.handleMessage(data);
      }, 1);
    }
  }

  /**
   * Connect two mock transports together.
   */
  static pair(): [MockTransport, MockTransport] {
    const a = new MockTransport();
    const b = new MockTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }
}
