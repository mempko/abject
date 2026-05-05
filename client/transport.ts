/**
 * ClientTransport — abstraction over the connection between the browser
 * FrontendClient and the backend's BackendUI. Two implementations:
 *
 *   - WebSocketClientTransport: legacy local-dev path (ws://… or wss://…)
 *   - WebRTCClientTransport: encrypted DataChannel via signaling + PeerTransport
 *
 * The transport handles its own reconnect logic. `onOpen` fires every time
 * the channel becomes ready to carry app data (initial connect AND each
 * reconnect), so FrontendClient can re-emit fontMetrics, clear stale
 * surfaces, etc.
 */

export interface ClientTransport {
  /** Establish the connection. Resolves when first `onOpen` has fired. */
  connect(): Promise<void>;

  /** Send a JSON string to the backend. */
  send(data: string): void;

  /** Register the incoming-message handler. Replaces any prior handler. */
  onMessage(handler: (data: string) => void): void;

  /** Fires every time the channel is (re)opened and ready for app data. */
  onOpen(handler: () => void): void;

  /** Fires when the channel is closed and reconnect cannot recover (or is disabled). */
  onClose(handler: () => void): void;

  /** Permanently close the transport. No further reconnect attempts. */
  close(): void;

  /** True if the channel is currently open and ready for `send`. */
  readonly ready: boolean;
}
