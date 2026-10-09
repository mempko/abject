# server/ - Node.js Backend

Server-side runtime for Abjects. All object logic runs on Node.js and the browser is a thin rendering client.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   NODE.JS BACKEND                       │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │   Factory    │  │  Registry   │  │  LLMObject    │  │
│  ├─────────────┤  ├─────────────┤  ├───────────────┤  │
│  │ HttpClient  │  │   Storage   │  │   Timer       │  │
│  ├─────────────┤  ├─────────────┤  ├───────────────┤  │
│  │ WebBrowser  │  │  WebParser  │  │ AgentAbject   │  │
│  ├─────────────┤  ├─────────────┤  ├───────────────┤  │
│  │ Identity    │  │PeerRegistry │  │RemoteRegistry │  │
│  └──────┬──────┘  └──────┬──────┘  └───────┬───────┘  │
│         └────────────────┼──────────────────┘          │
│                    MessageBus                           │
│                          │                              │
│  ┌───────────────────────┴───────────────────────┐     │
│  │              BackendUI                         │     │
│  │  (X11-style display server, surfaces, input)   │     │
│  └───────────────────────┬───────────────────────┘     │
│                          │                              │
│  ┌───────────────────────┴───────────────────────┐     │
│  │         NodeWebSocketServer (:7719)            │     │
│  └───────────────────────┬───────────────────────┘     │
└──────────────────────────┼──────────────────────────────┘
                           │ WebSocket
┌──────────────────────────┼──────────────────────────────┐
│  BROWSER CLIENT          │          (client/)           │
│  ┌───────────────────────┴───────────────────────┐     │
│  │         FrontendClient + Compositor            │     │
│  │  (canvas rendering, input capture, hit-test)   │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

## Editions

The same bootstrap runs in two editions:

- **Desktop** (`index.ts`, what `pnpm awaken` and the Electron app run):
  `boot.ts` plus the display layer in `ui-layer.ts`, as drawn above.
- **Headless** (`headless.ts`, `pnpm awaken:headless`, and the `abject`
  command's backend): `boot.ts` alone. No BackendUI, UIServer, WidgetManager
  or windows; WS_PORT answers only the health endpoint, and people reach it
  through the CLI gateway (`cli-server.ts`) with the `abject` command. Its
  bundles are checked for display code at build time
  (`scripts/headless-bundle-check.mjs`).

Questions to the person (`confirm`, `prompt`, permission prompts) go to
`DialogBroker`, which shows them on whatever surfaces exist: windows on the
desktop (WidgetManager, GlobalSettings) and every connected terminal
(CliServer). On the headless edition the terminals are the only surface, and
an asker waits until someone answers. Each running backend writes
`instance.json` into its data directory (pid, edition, ports, an owner token
for local terminals); `instance-file.ts` owns that file, and `data-dir.ts` the
per-OS default data directory both editions and the `abject` command share.

## Files

### boot.ts, index.ts, headless.ts, ui-layer.ts

`boot.ts` bootstraps the entire Abjects system on Node.js; `index.ts` and
`headless.ts` call it with each edition's worker entries, the desktop's with
the `UiLayer` from `ui-layer.ts`.

- Polyfills WebRTC APIs (`RTCPeerConnection`, `RTCDataChannel`, etc.) via `node-datachannel`
- Creates `Runtime` with optional worker thread pool (auto-detects CPU cores)
- Registers 40+ object constructors with Factory
- Ingests WASM packages before anything spawns: bundled native system
  packages (`native/`, shipped in the desktop app as `resources/native`)
  first, then user extensions (`$ABJECTS_DATA_DIR/extensions/`), so a
  package with `replaces` overrides its built-in type
- Spawns system objects in dependency order via request-reply to Factory
- Installs `PeerRouter` as message interceptor for P2P routing
- Desktop: starts `NodeWebSocketServer` on port 7719 (ui-layer.ts); headless: a plain health endpoint there
- Graceful shutdown via signal handlers (`SIGINT`, `SIGTERM`, and `SIGHUP` off Windows), or the CLI gateway's `shutdown` (`abject stop`)

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `7719` | WebSocket port for frontend connection |
| `ABJECTS_DATA_DIR` | `.abjects` (installs: the OS per-user directory) | Storage directory for persisted state |
| `CLI_PORT` / `CLI_BIND` | `WS_PORT+4` / `127.0.0.1` | CLI gateway port and address (`abject`) |
| `ANTHROPIC_API_KEY` | - | Anthropic Claude API key |
| `OPENAI_API_KEY` | - | OpenAI API key |
| `ABJECTS_WORKER_COUNT` | CPU cores | Worker thread pool size |
| `ABJECTS_WORKER_MAX_OLD_SPACE_MB` | sized from memory | Heap ceiling per worker thread (default: three quarters of memory less 512 MB, shared across pool and dedicated workers, 512 MB to 8 GB) |
| `HTTP_PORT` / `HTTP_BIND` | `WS_PORT+5` / `127.0.0.1` | HTTP gateway port and address |
| `ABJECTS_ALLOWED_ORIGINS` | - | Web pages allowed to open the UI WebSocket besides the desktop app (`ABJECTS_CLIENT_ORIGIN`, set by Electron) and the dev client (`VITE_CLIENT_PORT`, default 5174); comma-separated. See `src/network/origin-policy.ts` |

**Health and version.** The WebSocket port also answers plain HTTP: `GET
/healthz` (503 `starting` until boot finishes, then 200 `ok` with version,
uptime, Node, platform, worker count) and `GET /version`. Abjects read the
same from the `InstanceInfo` object. The compiled server (`pnpm bind`) has its
version built in.

**Running headless.** `pnpm incarnate:headless` packages the headless
edition as one directory: the `abject` binary (Node with the command line
built in, `scripts/sea-bootstrap.cjs`), the headless server and its workers,
the bundled packages and the native modules. `abject serve` runs it in the
foreground for a service manager; see `deploy/README.md`.
| `ABJECTS_SIGNALING_URLS` | - | Use only these signaling servers (comma-separated); pinned, not changeable at runtime |
| `ABJECTS_PEER_ADMISSION` | `open` | `allowlist` pins allowlist mode: only allowed peers may connect |
| `ABJECTS_ALLOWED_PEERS` | - | Peer IDs always allowed to connect (comma-separated) |

### backend-ui.ts

Node.js replacement for `UIServer`. Implements the `abjects:ui` interface but forwards all rendering over WebSocket instead of drawing to a local Canvas.

- Manages surfaces (create, destroy, move, resize, z-order, visibility)
- Forwards draw commands to browser client as `BackendToFrontendMsg`
- Routes input events from browser client to surface owner objects
- Replays full UI state on client connect/reconnect
- Handles async request-reply for text measurement and display info queries
- Tracks focus, mouse grab, and workspace assignments

### ws-protocol.ts

Shared TypeScript interfaces for backend-frontend WebSocket communication.

**Backend → Frontend (14 message types):**

| Message | Purpose |
|---------|---------|
| `createSurface` | New drawing surface |
| `destroySurface` | Remove surface |
| `draw` | Batch canvas draw commands |
| `moveSurface` | Reposition surface |
| `resizeSurface` | Resize surface |
| `setZIndex` | Change stacking order |
| `setFocused` | Keyboard focus change |
| `measureTextRequest` | Async text width query |
| `displayInfoRequest` | Async viewport size query |
| `setSurfaceVisible` | Show/hide surface |
| `setSurfaceWorkspace` | Assign surface to workspace |
| `setActiveWorkspace` | Switch visible workspace |
| `clipboardWrite` | Write to system clipboard |
| `setSelectedText` | Update selection buffer |

**Frontend → Backend (5 message types):**

| Message | Purpose |
|---------|---------|
| `input` | Mouse, keyboard, wheel, paste events |
| `measureTextReply` | Response to text measurement |
| `displayInfoReply` | Response to viewport query |
| `surfaceCreated` | Acknowledge surface creation |
| `ready` | Client connected, triggers state replay |

### node-storage.ts

File-based `Storage` implementation for Node.js. Extends the browser `Storage` class (IndexedDB) with disk persistence.

- Loads from `{DATA_DIR}/storage.json` on init
- Auto-creates data directory
- Syncs writes to disk after each operation
- Per-workspace storage: `{DATA_DIR}/ws-{workspaceId}/storage.json`

### signaling-server.ts

Standalone signaling server for P2P peer discovery and WebRTC connection relay.

- Registers peers by ID with public keys (signing + exchange)
- Answers peer discovery queries
- Relays SDP offers/answers and ICE candidates between peers
- Cleans up stale peers (5-minute timeout)

**Run standalone:**
```bash
SIGNALING_PORT=7720 npx tsx server/signaling-server.ts
```

### node-worker-adapter.ts

Wraps Node.js `worker_threads` to implement the `WorkerLike` interface used by the worker pool.

- Enables cross-platform worker API (browser Web Workers / Node.js worker_threads)
- Uses `tsx` loader for TypeScript resolution inside worker threads
- Converts callback-based Node Worker API to the event-based interface expected by `WorkerBridge`

## Usage

```bash
# Awaken the depths (all objects run here)
pnpm awaken

# In another terminal, scry into the abyss (thin renderer)
pnpm scry
```
