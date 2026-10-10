/**
 * Transport abstraction for network communication.
 */

import { AbjectMessage } from '../core/types.js';
import { deserialize } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Transport');

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TransportConfig {
  reconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
}

export interface AuthenticatedSessionMetadata {
  /** Identity verified at the transport connection boundary. */
  authenticatedPeerId: string;
  /** Receiver-local, monotonically increasing authenticated-session epoch. */
  sessionEpoch: number;
}

export interface TransportEvents {
  onConnect?: (session?: AuthenticatedSessionMetadata) => void;
  onDisconnect?: (reason?: string, session?: AuthenticatedSessionMetadata) => void;
  onMessage?: (message: AbjectMessage, session?: AuthenticatedSessionMetadata) => void;
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
  protected handleConnect(session?: AuthenticatedSessionMetadata): void {
    this.setState('connected');
    this.events.onConnect?.(session);
  }

  /**
   * Handle disconnection.
   */
  protected handleDisconnect(reason?: string, session?: AuthenticatedSessionMetadata): void {
    this.setState('disconnected');
    this.events.onDisconnect?.(reason, session);
  }

  /**
   * Handle error.
   */
  protected handleError(error: Error): void {
    this.setState('error');
    this.events.onError?.(error);
  }
}
