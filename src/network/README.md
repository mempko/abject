# src/network/ - Transports, Sockets and Peer Routing

Everything that carries bytes between processes: the WebSocket server the
backend's sockets are built on, the browser-origin policy that guards them,
the binary wire codec used by the UI protocol and between peers, and the
peer-to-peer stack
(signaling client, encrypted WebRTC `PeerTransport`, and `PeerRouter`, which
makes a remote object addressable by its AbjectId exactly like a local one).
`MCPTransport`, the stdio link to MCP server processes, lives here too.

Authentication is not done here. The sockets hand each connection to the
server, where AuthGate (`server/auth-gate.ts`) and `server/auth.ts` decide
whether it may talk; peers authenticate themselves through the
`PeerTransport` key handshake.

## Architecture

```
 Backend process                                     Remote ends
 ───────────────                                     ───────────
 UI socket (desktop only, server/ui-layer.ts)
   NodeWebSocketServer on 127.0.0.1:WS_PORT  ◀──────  browser client
   allowOrigin = allowOrigins(clientOriginsFromEnv)   (wire-codec frames)
   also answers GET /healthz and /version

 Health only (headless, server/boot.ts)
   plain http.Server on 127.0.0.1:WS_PORT    ◀──────  probes (/healthz, /version)

 CLI gateway (server/cli-server.ts)
   NodeWebSocketServer on CLI_BIND:CLI_PORT  ◀──────  `abject` command
   (loopback and WS_PORT+4 by default)                (JSON text frames)
   allowOrigin = refuseAllOrigins

 MessageBus ─▶ PeerRouter (main thread, interceptor)
                 │ send-to-peer / remote-message
                 ▼
               P2P worker: PeerRegistry ─▶ PeerTransport ◀══ WebRTC ══▶ other peers,
                           SignalingClient ◀──────────────▶ signaling   paired browsers
                                                            server
```

The P2P objects (Identity, PeerRegistry, SignalingRelay, PeerDiscovery,
RemoteRegistry) run in a dedicated worker (`workers/p2p-worker-runtime.ts`)
with the `node-datachannel` WebRTC polyfill. `PeerRouter` stays on the main
thread because it is a synchronous bus interceptor; it reaches transports
through the worker bridge (`setP2PBridge`). With
`ABJECTS_DEDICATED_WORKERS=0` the P2P objects run on the main thread and the
router holds the `PeerRegistry` directly (`setPeerRegistry`).

### P2P connection flow

```
  Peer A                      Signaling server               Peer B
    │ register(peerId, keys, name) │                             │
    ├─────────────────────────────▶│◀────────────────────────────┤ register
    │ find(peerB)                  │                             │
    ├─────────────────────────────▶│                             │
    │◀──────── found(keys, name) ──┤                             │
    │ get-ice                      │                             │
    ├─────────────────────────────▶│                             │
    │◀── ice-servers (STUN, TURN) ─┤                             │
    │ sdp-offer                    │                             │
    ├─────────────────────────────▶├────────────────────────────▶│
    │                              │                  sdp-answer │
    │◀─────────────────────────────┤◀────────────────────────────┤
    │◀──────────── ice-candidate (relayed both ways) ───────────▶│
    │                                                            │
    │═══════════ ordered DataChannel 'abjects' opens ════════════│
    │                                                            │
    │◀──── handshake {peerId, publicSigningKey, ───────────────▶│
    │                 publicExchangeKey} (JSON)                  │
    │  each side: peerId == SHA-256(signing key)?                │
    │             ECDH -> AES-256-GCM session key                │
    │                                                            │
    │◀════ encrypted binary frames (wire codec, deflate) ═══════▶│
```

### Routing through the bus

```
 Local peer                                  Remote peer X
 ──────────                                  ─────────────
 Object A                                    Object B
   │ send / request to B's AbjectId            ▲
   ▼                                           │
 MessageBus                                  MessageBus
   │                                           ▲
   ▼                                           │ inject
 PeerRouter.intercept()                      PeerRouter.handleIncomingMessage()
   B registered here? -> pass (local)          rate limit, sender check,
   route to B via X?  -> forward, drop         permission check
   │                                           ▲
   ▼                                           │
 PeerTransport ══ encrypted DataChannel ══▶ PeerTransport
```

## Files

### transport.ts

`Transport`, the abstract base: state machine
(`disconnected` / `connecting` / `connected` / `error`), `TransportConfig`
(`reconnect`, `reconnectDelay`, `maxReconnectAttempts`, `heartbeatInterval`)
and `TransportEvents` (`onConnect`, `onDisconnect`, `onMessage`, `onError`,
`onStateChange`). Events can carry `AuthenticatedSessionMetadata`
(`authenticatedPeerId`, `sessionEpoch`). The base `handleMessage()` parses
JSON text. `PeerTransport` is its one subclass.

### websocket-server.ts

`NodeWebSocketServer`, the server behind the UI socket and the CLI gateway.
It wraps the `ws` package around a real `http.Server`, so:

- plain HTTP requests go to `onHttpRequest` (the health endpoint) or get a
  short text answer instead of ws's 426;
- WebSocket upgrades are checked against `allowOrigin` before the handshake;
  a refused page gets `403 Forbidden`, and a handshake with no `Origin`
  (a non-browser client) is always let through;
- every `heartbeatMs` (default 30s, 0 disables) each socket is pinged and one
  that missed the previous pong is terminated, which is the only thing that
  reaps half-open sockets;
- `close()` terminates every connection and closes the listener so the port
  is free when it returns.

Also `onConnection()`, `broadcast()`, `ready()`, `port`, `clientCount`.

### origin-policy.ts

Which web pages may open a local socket. An `OriginPolicy` is
`(origin) => boolean`.

- `allowOrigins(list)`: exact allowlist over canonical origins
  (`canonicalOrigin()`: lowercase, default port dropped, http(s) only).
- `refuseAllOrigins`: for gateways no browser uses (the CLI gateway).
- `clientOriginsFromEnv(env)`: the UI socket's list:
  `ABJECTS_CLIENT_ORIGIN` (the desktop app's client server, set by
  `electron/main.ts`), the Vite dev client on 127.0.0.1 and localhost at
  `VITE_CLIENT_PORT` (default 5174, omitted when `ELECTRON_PACKAGED=1`), and
  `ABJECTS_ALLOWED_ORIGINS` (comma or space separated; invalid entries are
  returned in `ignored`).

Matching the Host header is deliberately not enough: a DNS-rebinding page is
same-origin by that test.

### wire-codec.ts

The binary encoding for the UI protocol between
`server/backend-ui.ts` and `client/frontend-client.ts` (WebSocket and WebRTC),
and AbjectMessages between peers. `WireEncoder.encodeFrame(value,
allowDeflate)` / `WireDecoder.decodeFrame(frame)` encode the JSON data model
plus raw `Uint8Array` bytes, with zigzag varints, f64 floats and a
per-connection string-intern table (strings up to 128 characters, table
capped at 8192 entries). The first byte is the envelope: `0x01` plain, `0x02`
deflated (when `allowDeflate`, tried from 256 bytes and kept only when
smaller). `isWireFrame()` tells a binary frame from a pre-auth JSON string,
which starts with `{` or `[`.

### signaling.ts

`SignalingClient`, the WebSocket client of the signaling server
(`server/signaling-server.ts`, `pnpm whisper`, port 7720). Methods:
`connect(endpoint, timeoutMs)`, `register(peerId, signingKey, exchangeKey,
name)`, `unregister`, `findPeer`, `listPeers`, `requestIceServers()` (STUN
plus TURN credentials minted by the server; resolves `[]` on timeout),
`sendSdpOffer`, `sendSdpAnswer`, `sendIceCandidate`, and `setPersistent(true)`
to retry forever (backoff capped at 60s) instead of 5 attempts. Events:
`onPeerFound`, `onPeerNotFound`, `onPeerList`, `onSdpOffer`, `onSdpAnswer`,
`onIceCandidate`, `onIceServers`, `onConnect`, `onDisconnect`, `onError`.
Pings every 2 minutes. The `SignalingRelay` interface (the three `send*`
methods) is also implemented by `SignalingRelayObject`
(`src/objects/signaling-relay.ts`), which relays through connected peers.

### peer-transport.ts

`PeerTransport`, a `Transport` over one ordered RTCDataChannel, used by
`PeerRegistry`, `RemoteUIAccess` and the browser client
(`client/webrtc-transport.ts`).

- **Setup.** `connect()` (caller) creates the channel and offer;
  `handleSdpOffer`, `handleSdpAnswer`, `handleIceCandidate` complete it
  (candidates arriving early are queued). `resetForGlare()` tears down for
  a fresh negotiation without firing a disconnect. 20s connection timeout;
  default ICE server is Google STUN.
- **Handshake.** Each side sends its peerId and public keys as JSON. The
  receiver checks the peerId derives from the signing key and is the peer it
  expected, derives the AES-256-GCM session key by ECDH, resets the wire codec
  pair, assigns a new session epoch, and only then reports connected.
- **Frames.** After the handshake every payload is binary: type byte, 12-byte
  IV, ciphertext; plaintext of 256 bytes or more is deflated first when that
  shrinks it; frames over 200 KB are split into chunk frames (`0x05`) and
  reassembled within 30s.
  `send()` carries AbjectMessages (wire-codec encoded); `sendRaw()` /
  `onRawMessage()` carry UI-protocol bytes for `WebRTCUITransport`.
- **Ordering.** Sends and receives each run through a promise chain, because
  encryption and decryption are async and the wire codec is stateful.
- **Liveness.** Pings every `heartbeatInterval` (default 10s); after three
  intervals with no authenticated traffic the session is dropped. Traffic
  from a channel that is not the current authenticated session is ignored.
- `rtcPeerConnection` and `onRemoteTrack()` expose the connection for media.

### webrtc-ui-transport.ts

`WebRTCUITransport` adapts a paired browser's `PeerTransport` to the
`send` / `onMessage` / `onClose` / `close` / `ready` shape BackendUI expects
(`UITransportLike`, duplicated here so worker code need not import
`server/ui-transport.ts`). Remote UI clients attach only in the desktop
edition, which has a display layer.

### peer-router.ts

`PeerRouter` (`PEER_ROUTER_ID`), an Abject and a `MessageInterceptor` on the
bus. Senders never know whether a target is local.

- **Outbound (`intercept`).** A reply to a request that came from a peer goes
  back to that peer. A locally registered recipient is always delivered
  locally. Otherwise the route table decides: forward to the next hop and drop
  locally, or, when that peer is offline, fail a request at once with
  `PEER_OFFLINE`. Requests with no route are never sent on a guess (the bus
  answers `RECIPIENT_NOT_FOUND`); events may be forwarded speculatively.
  Requests on the wire time out after 25s, inside the caller's 30s.
- **Inbound (`handleIncomingMessage`).** Stamps
  `routing.authenticatedPeerId`, drops a sender id that is known to live
  behind a different peer, applies a per-peer token bucket (100 burst,
  50/s, `RATE_LIMITED`), resolves typeIds and well-known aliases, checks
  workspace permission (access mode, whitelist, exposed objects; cached 30s
  and refreshed on a miss), then injects into the bus, relays, or answers
  `ACCESS_DENIED` / `RECIPIENT_NOT_FOUND`.
- **Routes.** One route per workspace (`workspaceRoutes`, keyed
  `ownerPeerId/workspaceId`) plus per-object routes for a few system objects.
  Routes expire after 3 minutes; announcements go out as diffs against what
  each peer was last told, a full table to a new connection or a peer with a
  new boot id, with gossip to 2 to 4 peers for at most 3 hops and
  anti-entropy digests every 30s plus jitter.
- **Route trust.** Peers may call only `handleRouteAnnouncement` and
  `handleRouteDigest` on the router; `registerRoute`, `removeRoute`,
  `clearRoutesForPeer`, `getRoutes` and the rest are for local objects.
  Announced hop counts must be honest (0 only for the announcer's own
  workspace, at most 32), and an announcement may not claim an object
  already reached through another peer's live route. A sender's reply route
  is recorded only once its message is admitted or relayed. Mesh admission
  (`PeerRegistry`) limits all of this to admitted peers.
- **System object bypass.** `allowSystemObjectDirect()` admits only the
  well-known signaling objects (the workspace share registry), each with an
  exact set of remotely callable methods.

There is no NetworkBridge: PeerRouter replaced it.

### mcp-transport.ts

`MCPTransport`, newline-delimited JSON-RPC 2.0 over a child process's stdio,
used by `src/objects/mcp-bridge.ts`. `start(command, args, env)` spawns
through a shell in its own process group and registers it with
`src/runtime/child-processes.ts`, so shutdown can signal the whole tree;
`sendRequest` (30s default timeout), `sendNotification`, `stop()` (process
group signal on POSIX, `taskkill /T` on Windows). `stderrTail` keeps roughly the
last 8192 characters of stderr, minus npm noise, and is appended to errors
when the server fails or exits.

### Tests

Run with `pnpm test`.

- **`origin-policy.test.ts`**, **`websocket-server.origin.test.ts`**: origin
  canonicalization and env parsing; a refused page gets 403, non-browser
  clients still connect, HTTP still reaches `onHttpRequest`, `close()` frees
  the port.
- **`peer-transport.session.test.ts`**: session epochs, lease renewal and
  expiry, stale-epoch traffic, stale SDP answers.
- **`peer-router.route-trust.test.ts`**, **`peer-router.p2p2.test.ts`**,
  **`peer-router.native-routing.test.ts`**, **`peer-router.diff-version.test.ts`**,
  **`peer-router.reconnect-full.test.ts`**: the route protocol surface,
  announcement rules, system-object bypass, native remote routing, diffs and
  full re-announcement.
- **`child-process-shutdown.test.ts`**: MCP server process trees and worker
  pool shutdown leave no children behind (POSIX for the process-tree cases).

## Gotchas

- **The wire codec is stateful per connection.** Encode a frame only if it
  will be sent (encoding grows the intern table), and deliver frames in
  encode order over a reliable, ordered channel. Coalesce or drop messages
  before encoding. Both ends must start a session with fresh codecs, which is
  why `PeerTransport` resets its pair in the handshake.
- **An origin check is not authentication.** It only stops web pages. Local
  processes send no `Origin`; keeping them out is the login's job (AuthGate).
- **Half-open sockets leak without the heartbeat.** Keep `heartbeatMs` on for
  any long-lived server; per-client state is released only on `close`.
- **Node needs the WebRTC polyfill.** `PeerTransport` uses the global
  `RTCPeerConnection`; the P2P worker (or `server/boot.ts` when dedicated
  workers are off) installs `node-datachannel/polyfill` first. SDP rollback is
  not supported by that polyfill, hence `resetForGlare()`.
- **Do not route requests speculatively.** A guessed peer that lacks the
  object never answers, so the caller waits out its full timeout.

## Related

- [`../runtime/README.md`](../runtime/README.md): MessageBus interceptors, worker bridges
- [`../objects/README.md`](../objects/README.md): PeerRegistry, SignalingRelay, RemoteUIAccess, MCPBridge
- [`../../server/README.md`](../../server/README.md): editions, sockets, AuthGate, signaling server
- [`../../client/README.md`](../../client/README.md): the browser side of the UI protocol
