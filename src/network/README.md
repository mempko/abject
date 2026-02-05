# src/network/ - Network Transport Layer

Transport abstractions for cross-machine communication. Objects on different machines communicate through the MessageBus → Transport bridge.

## Files

### transport.ts

Abstract transport interface and utilities.

- **`Transport`**: abstract base with state machine (`disconnected` → `connecting` → `connected` → `error`)
- **`TransportConfig`**: `reconnect`, `reconnectDelay`, `maxReconnectAttempts`, `heartbeatInterval`
- **`TransportEvents`**: `onConnect`, `onDisconnect`, `onMessage`, `onError`, `onStateChange`
- **`handleMessage()`**: deserializes JSON and dispatches to `onMessage` handler
- **`MockTransport`**: paired in-process transports for testing (`MockTransport.pair()`)
- **`TransportRegistry`**: manage multiple named transports

### websocket.ts

WebSocket transport implementation.

- **Reconnection**: exponential backoff (`delay * 2^attempt`)
- **Heartbeat**: application-level keep-alive
- **`WebSocketConnectionManager`**: multi-peer management with `connect()`, `disconnect()`, `get()`
- **`WebSocketServer`**: interface placeholder for future Node.js server

## Integration with MessageBus

The MessageBus notifies `'undeliverable'` subscribers when a message target is not locally registered. The network layer subscribes to these notifications and routes messages through the appropriate Transport to remote machines.
