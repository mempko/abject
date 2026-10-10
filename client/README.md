# client/ - Browser Rendering Client

The thin client that shows a desktop. It owns a full-screen canvas and the
WebGL2 Compositor (`src/ui/compositor.ts`), draws what the backend's display
server sends, does hit testing locally, and sends input back. No Abject runs
here: every window, widget and decision lives on the server, and the client
can be closed, reloaded or replaced at any time because the server replays
the whole display state on connect.

The same code serves three ways: the dev server (`pnpm scry`), the Electron
desktop app (which serves the built `dist-client/` to its window over HTTP),
and the p2p build for phones and other browsers (client.abject.world) that
reaches a desktop over WebRTC.

## Architecture

```
  backend (desktop edition)                         browser
  ──────────────────────────                        ─────────────────────────────────
  UIServer = BackendUI (UI worker)                   index.ts: pick a transport
     │                                                  │
     │  ws://127.0.0.1:7719  (WebSocketClientTransport) │
     │  or WebRTC DataChannel via signaling            │
     │     (WebRTCClientTransport, paired desktops)     ▼
     └──────────────── binary wire frames ─────────▶ FrontendClient
                                                        ├─ Compositor (src/ui) on #app canvas
                                                        ├─ local hit test → input messages
                                                        ├─ measure / display / scene info replies
                                                        └─ audio, speech, media, video, clipboard
                                                           relays for the capability objects
  backdrop.ts paints #abyss-bg behind the transparent WebGL canvas
```

## Connection Lifecycle

```
  client                                       BackendUI
    │ 1. transport opens (onOpen: fresh WireEncoder/Decoder,
    │    clear all surfaces)                      │
    │ ◀──── authRequired | authNotRequired ───────┤   JSON (pre-auth)
    │ ───── auth { token } | { username, password }▶
    │ ◀──── authResult { success, token } ────────┤   token saved in localStorage
    │ 2. hello { bundle, userAgent, mobile }       │   binary from here on
    │    fontMetrics (ASCII widths per font)       │
    │    ready ──────────────────────────────────▶ │
    │ ◀──── full replay: createSurface, draw,      │
    │       sceneOps, setSceneTheme, setSlabMotion,│
    │       setSceneLibrary, transforms, ...       │
    │ 3. steady state                              │
    │ ◀──── draw, sceneOps, surface ops, imageBlob │
    │ ───── input, frameAck, needBlob, nodeDrag,   │
    │       cameraChange, surfaceCreated, ...      │
    │ 4. drop: the transport reconnects and the    │
    │    sequence starts again at 1                │
```

- **Wire format.** After auth every frame is binary (`src/network/wire-codec.ts`):
  a compact self-describing encoding with per-connection string interning,
  deflated on the WebSocket path when it helps. Before auth, JSON text. Both
  sides create a fresh encoder/decoder pair per connection.
- **Flow control.** The client acks processed frames cumulatively, at most once
  per animation frame (`frameAck`). The backend stops flushing to a client
  that falls behind and coalesces queued repaints, so a slow or hidden tab
  catches up to the latest state instead of a backlog.
- **Images.** Draw commands carry `abx:sha256:<hash>` refs; the bytes arrive
  once per connection as `imageBlob` and are cached as object URLs (300
  entries). A command for an evicted hash asks again with `needBlob`.
- **Text metrics.** The client measures ASCII glyph widths for the fonts in
  use and sends them as `fontMetrics` (after the web fonts load), so the
  server measures text without a round trip. The first `measureTextRequest`
  for a font it has not seen also ships that font's full metrics, so each
  new font costs one round trip.

## Files

- **`index.html`**: the page: login, connecting, pairing and QR overlays, the
  `#abyss-bg` backdrop canvas, the `#app` container, the hidden mobile
  keyboard proxy and file-upload inputs, and the phone's palette and Exposé
  buttons.
- **`index.ts`**: entry point. Builds the WebSocket URL (`VITE_WS_URL`, else
  `wss://<host>/ws` on https, else `ws://127.0.0.1:<VITE_WS_PORT>`), chooses a
  transport (a `?pair=` link pairs over WebRTC, a saved paired desktop
  reconnects over WebRTC, otherwise WebSocket; the p2p build connects to the
  selected instance or shows the picker), starts the backdrop, creates the
  FrontendClient, and exposes it as `window.frontendClient` for debugging.
- **`frontend-client.ts`**: `FrontendClient`. Owns the canvas, Compositor and
  transport. Applies backend messages (surfaces, draws, scene ops, theme,
  motion, presets, workspaces, Exposé, cursor, file picker), answers
  measure, display, scene-info and capture requests, and plays the relays for
  AudioOutput, Speech, MediaStream, VideoWidget and Clipboard writes. Input:
  local hit testing (`surfaceLocalAt`, `nodeAt`), mouse grab during drags,
  client-side window moves after `startWindowDrag`, node drags and camera
  orbits, keyboard to the focused surface, paste and file drops. Global keys:
  Ctrl/Cmd+K (command palette), Ctrl/Cmd+` (window switcher), F3 or Ctrl+Up
  (Exposé). Phone mode: touch gestures, pinch zoom, Exposé, and a hidden input
  as the keyboard proxy.
- **`transport.ts`**: the `ClientTransport` interface (`connect`, `send`,
  `onMessage`, `onOpen` on every (re)open, `onClose`, `close`, `ready`, `kind`).
- **`ws-transport.ts`**: `WebSocketClientTransport`, with backoff that
  reconnects at once when the tab becomes visible or the network returns.
- **`webrtc-transport.ts`**: `WebRTCClientTransport`. Signaling plus the
  encrypted `PeerTransport` from `src/network/`; fetches ICE servers (STUN and
  TURN) from the signaling server, sends one pairing or reconnect message,
  then carries the UI protocol as binary frames. The desktop side is
  RemoteUIAccess.
- **`identity-store.ts`**: this browser's ECDSA and ECDH keypair, private keys
  non-extractable in IndexedDB, public keys and peerId mirrored in
  localStorage.
- **`pairing.ts`**: parse and build the `?pair=<base64url JSON>` payload the
  desktop's QR encodes (peerId, keys, signaling URL, token, expiry).
- **`paired-desktops.ts`**: localStorage list of paired desktops
  (`remote-ui:paired`) for reconnecting without a new QR.
- **`qr-scanner.ts`**: in-page QR scanner, BarcodeDetector with a jsqr
  fallback.
- **`instances.ts`**: p2p build only. The instances this browser knows (paired
  desktops and WebSocket URLs), the selected one, and a login token per
  instance (`abjects_auth_token:<instanceId>`).
- **`instance-switcher.ts`**, **`instance-switcher.css`**: p2p build only. The
  DOM switcher: a pill and panel on desktop (Ctrl/Cmd+Shift+O), a sheet on the
  phone, and the picker. Switching writes the choice and reloads the page.
- **`backdrop.ts`**: the animated desktop backdrop drawn on `#abyss-bg` in the
  scene theme's colours; pauses while the tab is hidden.
- **`mobile-input-delta.ts`**: turns keyboard-proxy edits (IME composition,
  autocorrect) into Backspaces plus inserted text.
- **`mobile-input-delta.test.ts`**: tests for the above, run by `pnpm test`.
- **`diag.html`**: a standalone page for checking how a phone's keyboard can
  be summoned (open `/diag.html` on the dev server).
- **`favicon.svg`**, **`vite-env.d.ts`**: page icon and Vite types.

## Build and Run

```bash
pnpm scry          # dev server on :5174 (VITE_CLIENT_PORT), backend at ws://127.0.0.1:7719
pnpm divine        # dev server for the p2p build (VITE_DEFAULT_MODE=p2p) on :5180
pnpm etch          # production build into dist-client/
pnpm etch:p2p      # production p2p build
```

Configured by `vite.client.config.ts` (root `client/`, output
`dist-client/`, strict port, bound to 127.0.0.1).

| Variable | Default | Meaning |
|---|---|---|
| `VITE_WS_PORT` | `7719` | Backend WebSocket port when no URL is given |
| `VITE_WS_URL` | (none) | Full backend WebSocket URL; overrides the port |
| `VITE_DEFAULT_MODE` | (none) | `p2p` builds the multi-instance WebRTC client |
| `VITE_CLIENT_PORT` | `5174` | Dev server port |

## Adding a Message

1. Declare the message type in `server/ws-protocol.ts` and add it to
   `BackendToFrontendMsg` or `FrontendToBackendMsg`.
2. Handle it in `FrontendClient.handleBackendMessage` (or send it with
   `sendToBackend`), and on the server in `server/backend-ui.ts`.
3. If it changes display state, have BackendUI retain it so a reconnecting
   client gets it in the replay.

## Gotchas

- **The client holds no truth.** Anything shown must be in BackendUI's
  retained state or it disappears on reload. On every (re)open the client
  clears all surfaces and waits for the replay.
- **`VITE_*` values are baked in at build time.** A built client always dials
  the port or URL it was built with.
- **Encode only what is sent.** The wire codec's interning table is shared
  state between the two ends; a frame encoded and then dropped desyncs the
  decoder.
- **Fonts before `ready`.** The client loads its web fonts before measuring
  and sending `ready`; metrics taken from a fallback font would be cached by
  the server and wrong forever after.
- **Phones.** A coarse-pointer or touch device whose screen's short side is
  under 768 px runs the phone layout; IME input arrives through the keyboard proxy, so typed text
  is sent as deltas rather than per key.

## Related

- [../src/ui/README.md](../src/ui/README.md): the Compositor
- [../src/ui/gl/README.md](../src/ui/gl/README.md): the WebGL2 engine and scene
  vocabulary
- [../server/README.md](../server/README.md): BackendUI and the editions
- [../src/network/README.md](../src/network/README.md): wire codec, signaling,
  PeerTransport
