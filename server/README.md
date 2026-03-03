# server/ - Node.js Backend

Server-side runtime for Abjects. Replaces the browser-only mode (`pnpm dev`) with a client/server split where all object logic runs on Node.js and the browser is a thin rendering client.

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

## Dual-Bootstrap Pattern

The codebase has two bootstrap entry points that **must stay in sync**:

| | Browser-only (`src/index.ts`) | Server mode (`server/index.ts`) |
|---|---|---|
| **Run with** | `pnpm dev` | `pnpm serve` + `pnpm client` |
| **UI rendering** | Canvas + Compositor (in-process) | BackendUI → WebSocket → client Compositor |
| **Storage** | IndexedDB | JSON file on disk (`NodeStorage`) |
| **Workers** | Web Workers | Node.js worker_threads |
| **WebRTC** | Browser-native | Polyfilled via `node-datachannel` |

When adding a new system object, register its constructor and spawn it in **both** files.

## Files

### index.ts

Main entry point. Mirrors `src/index.ts` but runs on Node.js.

- Polyfills WebRTC APIs (`RTCPeerConnection`, `RTCDataChannel`, etc.) via `node-datachannel`
- Creates `Runtime` with optional worker thread pool (auto-detects CPU cores)
- Registers 40+ object constructors with Factory
- Spawns system objects in dependency order via request-reply to Factory
- Installs `PeerRouter` as message interceptor for P2P routing
- Starts `NodeWebSocketServer` on port 7719
- Graceful shutdown via signal handlers (`SIGINT`, `SIGTERM`)

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `7719` | WebSocket port for frontend connection |
| `DATA_DIR` | `.abjects` | Storage directory for persisted state |
| `ANTHROPIC_API_KEY` | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ABJECTS_WORKER_COUNT` | CPU cores | Worker thread pool size |

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
# Start backend (all objects run here)
pnpm serve

# In another terminal, start browser client (thin renderer)
pnpm client
```
