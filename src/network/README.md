# src/network/ - Network Transport Layer

Transport abstractions for cross-machine communication. Objects on different machines communicate through the MessageBus → Transport bridge. Includes full P2P infrastructure with WebRTC, signaling, and encrypted channels.

## P2P Connection Flow

```
  Peer A                     Signaling Server              Peer B
    │                              │                          │
    │  1. register(peerId, keys)   │                          │
    ├─────────────────────────────→│                          │
    │                              │  2. register(peerId, keys)
    │                              │←─────────────────────────┤
    │                              │                          │
    │  3. find(peerB)              │                          │
    ├─────────────────────────────→│                          │
    │     found(addr, keys)        │                          │
    │←─────────────────────────────┤                          │
    │                              │                          │
    │  4. sdp-offer ──────────────→│──────────────────────── →│
    │     sdp-answer ←────────────│←──────────────────────── │
    │     ice-candidate ←────────→│←────────────────────────→│
    │                              │                          │
    │  ═══════════ WebRTC DataChannel established ══════════  │
    │                              │                          │
    │  5. Identity handshake (ECDH key agreement)             │
    │←───────────────────────────────────────────────────────→│
    │                              │                          │
    │  6. AES-256-GCM encrypted messages                      │
    │←═══════════════════════════════════════════════════════→│
```

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

### websocket-server.ts

Node.js WebSocket server wrapper using the `ws` package.

- **`NodeWebSocketServer`**: wraps `ws.WebSocketServer` for server-side use
- **Methods**: `onConnection()` callback, `broadcast()` to all clients, `close()` for shutdown
- Used by `server/ui-layer.ts` (desktop edition) to serve the frontend client connection

### signaling.ts

WebSocket client for peer discovery and WebRTC signaling relay.

- **`SignalingClient`**: connects to signaling server (`server/signaling-server.ts`)
- **Methods**: `register(peerId, keys)`, `find(peerId)`, `sendOffer()`, `sendAnswer()`, `sendIceCandidate()`
- **Events**: `onFound`, `onOffer`, `onAnswer`, `onIceCandidate`
- Handles reconnection and keep-alive pings

### peer-transport.ts

WebRTC DataChannel transport with identity handshake and end-to-end encryption.

- **`PeerTransport`**: extends `Transport` for P2P communication
- **Connection setup**: creates `RTCPeerConnection`, negotiates SDP via signaling, opens DataChannel
- **Identity handshake**: ECDH key agreement using `IdentityObject` keys after DataChannel opens
- **Encryption**: AES-256-GCM for all messages after handshake completes
- **Serialization**: messages encrypted as `ArrayBuffer`, decrypted on receive

### peer-router.ts

Message interceptor for transparent cross-peer routing.

- **`PeerRouter`**: implements `MessageInterceptor` on the MessageBus
- Intercepts messages destined for remote objects, routes through `PeerTransport`
- Receives messages from remote peers, injects into local MessageBus
- Permission-aware route propagation for multi-hop delivery
- Replaces the earlier `NetworkBridge` approach
- **Route trust.** Peers may call only the route protocol
  (`handleRouteAnnouncement`, `handleRouteDigest`); `registerRoute`,
  `removeRoute`, `clearRoutesForPeer`, `getRoutes` and the rest are for local
  objects. Announcements must carry honest hop counts (0 only for the
  announcer's own workspace) and may not claim an object already reached
  through another peer's live route. A sender's reply route is recorded only
  once its message is admitted or relayed. A peer can still be first to claim
  an object nobody has announced yet, and a relay sees the traffic it carries;
  mesh admission (`PeerRegistry`) limits both to admitted peers.

## Integration with MessageBus

```
Object A (local)                   Object B (remote peer)
     │                                   │
     │  this.send(msg to B)              │
     ↓                                   │
  MessageBus                             │
     │                                   │
     ↓                                   │
  PeerRouter (interceptor)               │
     │  "B is on peer X"                 │
     ↓                                   │
  PeerTransport (WebRTC)                 │
     │  encrypt + send                   │
     ↓                                   ↓
  ═══════════ DataChannel ═══════════  PeerRouter
                                         │
                                      MessageBus
                                         │
                                      Object B
```
