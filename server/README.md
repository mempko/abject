# server/ - Node.js Backend

The backend process. Every Abject runs here (on the main thread or in worker
threads); the browser client is a thin renderer and the `abject` command a
thin terminal client. One bootstrap, `boot.ts`, serves both editions: the
desktop edition adds a display layer (`ui-layer.ts`) and the headless edition
runs without one. This directory also holds the sockets' auth, the terminal
gateway, the instance file that lets a launcher find a running backend, the
Node implementations of storage and worker threads, and the standalone P2P
signaling server.

## Architecture

```
  server/index.ts (desktop)                  server/headless.ts (headless)
  runServer({ edition: 'desktop',            runServer({ edition: 'headless',
    ui: createDesktopUi(), ... })              ... })        no UiLayer
                 \                                /
                  +-------- boot.ts bootServer --+
                                |
   Runtime: MessageBus, Registry, Factory, worker pool (workers/)
   capabilities, LLM, agents, settings, permissions, peer layer (P2P worker),
   DialogBroker, CliServer, WebGateway, workspaces
                                |
   desktop only (ui-layer.ts): BackendUI in the UI worker, the UI WebSocket,
   WindowManager, WidgetManager and the windows, Screenshot, AudioOutput,
   Speech, RemoteUIAccess, and inside Electron BrowserWindowHost, AppUpdater

         Browser client (client/)      `abject` (cli/)      HTTP clients
                 |  WS_PORT                 |  CLI_PORT          |  HTTP_PORT
                 v                          v                    v
          UI WebSocket (desktop)        CliServer            WebGateway
          + /healthz, /version
          (headless: /healthz and /version only)
```

| Socket | Port | Interface | Desktop | Headless |
|--------|------|-----------|---------|----------|
| UI / health | `WS_PORT`, default 7719 | 127.0.0.1 | UI WebSocket for the browser client; also answers `GET /healthz` and `/version` | `GET /healthz` and `/version` only |
| CLI gateway | `CLI_PORT`, default `WS_PORT`+4 (7723) | `CLI_BIND`, else 127.0.0.1 | CliServer | CliServer |
| HTTP gateway | `HTTP_PORT`, default `WS_PORT`+5 (7724) | `HTTP_BIND`, else 127.0.0.1 | WebGateway, off until enabled | same |

`/healthz` answers 503 `{ status: 'starting', ... }` until boot has finished,
then 200 `{ status: 'ok', version, ready, startedAt, uptimeSec, node,
platform, arch, workerCount, edition, display }`; `/version` answers
`{ version }`. Abjects read the same through `InstanceInfo` (`getInfo`).

### Boot sequence (`bootServer` in boot.ts)

1. Refuse to start when another live backend holds the data directory
   (`assertNoOtherBackend`, through `instance.json`).
2. Size the worker pool (`ABJECTS_WORKER_COUNT`, default cores minus one, at
   most 8) and the per-worker heap (`planWorkerHeaps`), and create the
   `Runtime` with a `NodeWorkerAdapter` factory for the edition's pool worker.
3. Without dedicated workers (`ABJECTS_DEDICATED_WORKERS=0`), polyfill WebRTC
   on the main thread. `ui.beforeRuntimeStart`, then `runtime.start()`
   (Registry and Factory).
4. Open a temporary `bootstrap` mailbox for request/reply, mint this boot's
   owner token, and build the shared `AuthConfig` (the environment's login plus
   the owner token) and `SessionStore`. `ui.afterRuntimeStart` starts the UI
   worker and registers BackendUI as `UIServer`.
5. Health: `ui.openSocket` (the UI WebSocket answers it) or, headless, a plain
   HTTP server on 127.0.0.1:`WS_PORT`.
6. Register constructors (`ui.registerConstructors` adds the display ones) and
   mark the worker-eligible ones.
7. Ingest packages (`ingestAllExtensions`): bundled `native/`, then
   `$ABJECTS_DATA_DIR/extensions/`, then `ABJECTS_PACKAGE_DIRS` and
   `packages.json`. Boot stops when the native KnowledgeBase is missing.
8. Supervisor, then the capabilities: HttpClient, LLMObject (configured with
   the API keys from the environment), Storage, Timer, Crypto, Clipboard,
   Console, WebParser, WebBrowser (after `ui.beforeWebBrowser`), ShellExecutor,
   HostFileSystem, WebSearch, WebFetch, StreamClient, DialogBroker.
   `ui.spawnDisplay` adds Screenshot, AudioOutput, Speech, WindowManager,
   WidgetManager and SceneLibrary.
9. PeerRouter (a bus interceptor), the capability interceptor, and the peer
   layer: the dedicated P2P worker (ids pre-assigned and registered here), or
   the same objects on the main thread.
10. PermissionBroker, AuthGate, SettingsManager, `ui.spawnSettingsWindow`
    (AppUpdater, GlobalSettings), Packages, InstanceInfo, the capability
    enforcement mode, HeapMonitor, SkillRegistry, WebGateway,
    MCPRegistryClient, ClawHubClient, SecretsVault, OAuthHelper,
    ProxyGenerator, Negotiator, HealthMonitor, CassetteRecorder, then
    `ui.spawnGlobalUi`.
11. System-scoped packages spawn once; an `autostart` one gets `startup`.
12. CliServer spawns, registers with DialogBroker as its responder, and
    DialogBroker seals its surfaces.
13. WorkspaceManager spawns and boots every workspace; then
    WorkspaceShareRegistry, WorkerRecovery (handed each lost pool worker),
    route announcements, `ui.spawnLateUi`, ObjectCatalog.
14. HealthMonitor starts watching the core objects (plus
    `ui.monitoredIds()`), the bootstrap mailbox closes, the backend reports
    ready, `instance.json` is written, the banner prints, and signal handlers
    are installed.

### The UiLayer interface

`boot.ts` declares `UiLayer`; `createDesktopUi()` in `ui-layer.ts` is its one
implementation. Each method is called once, at the point its name says, with a
`BootContext` (runtime, logs, registry id, auth config, session store, instance
source, `bootstrapRequest`, `supervisedSpawn`, `systemTypeId`).

| Member | Called | Desktop does |
|--------|--------|--------------|
| `workerEligible` | step 6 | UI constructor names allowed on the pool |
| `beforeRuntimeStart(runtime)` | step 3 | BackendUI on the main thread, when dedicated workers are off |
| `afterRuntimeStart(ctx)` | step 4 | starts `workers/ui-worker-node.ts`, registers BackendUI as `UIServer` |
| `openSocket(ctx, health)` | step 5 | the UI WebSocket on 127.0.0.1:`WS_PORT` (origin policy, auth handshake, health) |
| `registerConstructors(ctx)` | step 6 | windows, widgets, display capabilities; BrowserWindowHost inside Electron |
| `beforeWebBrowser(ctx)` | step 8 | BrowserWindowHost inside Electron; registers AppUpdater in a packaged app |
| `spawnDisplay(ctx, dialogBrokerId)` | step 8 | display capabilities, WindowManager, WidgetManager (presenter of `confirm` and `prompt` dialogs), SceneLibrary |
| `remoteUiAttach`, `portToUITransport` | after pairing | attach a paired remote browser (relayed from the P2P worker over a MessagePort) to BackendUI |
| `spawnSettingsWindow(ctx, dialogBrokerId)` | step 10 | RemoteUIAccess (non-worker fallback), AppUpdater, GlobalSettings (presenter of `options` dialogs) |
| `spawnGlobalUi(ctx)` | step 10 | the global windows: PeerNetwork, GlobalToolbar, ObjectBrowser, MethodInspector, ProcessExplorer, LLMMonitor, SkillBrowser, WebGatewayBrowser, CatalogBrowser, Sidebar, WorkspaceSwitcher |
| `spawnLateUi(ctx)` | step 13 | WorkspaceBrowser, WorkspaceCollaboratorInspector |
| `monitoredIds()` | step 14 | ids HealthMonitor watches |
| `release()` | shutdown | closes the UI socket, stops the UI worker |
| `banner()` | step 14 | the WebSocket line of the banner |

### Questions to the person

`DialogBroker` owns every question to the person (`confirm`, `prompt`, and
the `options` dialogs PermissionBroker raises). On a desktop, WidgetManager
draws `confirm` and `prompt` and GlobalSettings draws `options`. CliServer is
its responder: it broadcasts `dialog` and `dialogClosed` events to every
terminal, and answers `listDialogs` and `respondDialog`. The first answer from
any surface wins. Registration happens before any workspace boots, and then
DialogBroker seals, so no user abject can register itself as a surface. On
the headless edition terminals are the only surface and an asker waits until
someone answers, unless PermissionBroker's mode (`permissions.mode`: `ask`,
`allow`, `deny`) decides requests no rule covers.

### Auth

The UI socket, CliServer and WebGateway share one `AuthConfig` and one
`SessionStore`, so a login token works on all three. A login is required when
`ABJECTS_AUTH_USER` and `ABJECTS_AUTH_PASSWORD` are both set, or once one is
saved in the settings: SettingsManager validates it and sends it to
`AuthGate`, which updates the shared config in place, clears every session and
asks BackendUI (`signOutClients`) to drop connected browsers. The handshake
(`authenticateConnection` in `auth.ts`): the server sends `authRequired` (or
`authNotRequired`), the client sends `{ type: 'auth' }` with an `ownerToken`,
a session `token`, or `username` and `password`, and gets `authResult`
(with a new session token after a login). The owner token is minted at each
boot and written to `instance.json`; anyone who can read the data directory
gets in with it.

### Shutdown

`releaseEverything()` (exported as `backendShutdown` for Electron) releases
without exiting: it first arms an exit watchdog in a separate process (SIGKILL
after 10 s; the packaged binary evaluates it through `__abject-eval`, see
`scripts/sea-bootstrap.cjs`), removes `instance.json`, signals child processes
(SIGTERM, then SIGKILL after 2 s), closes the health, CLI and HTTP sockets,
stops the P2P worker, the UI layer and the worker pool together, stops the
runtime, and shuts node-datachannel down on the main thread only when the P2P
worker could not. The signal handlers (SIGINT, SIGTERM, and SIGHUP off
Windows) call it and exit; a second signal exits at once. CliServer's
`shutdown` op (`abject stop`) emits SIGTERM. In Electron, `electron/main.ts`
replaces those handlers so every exit goes through the app's own quit.

## Files

### boot.ts, index.ts, headless.ts, ui-layer.ts

- **boot.ts**: the shared bootstrap. `bootServer(options)` (above),
  `runServer(options)` (boot, and on failure explain and exit; an
  `EADDRINUSE` names the process holding the port, through `ss`),
  `backendShutdown`, and the `BootContext`, `UiLayer`, `BootOptions` and
  `HealthResponder` types. Imports nothing that draws.
- **index.ts**: the desktop entry (`pnpm awaken`; the Electron app imports its
  compiled form). Calls `runServer` with the `-node` workers and
  `createDesktopUi()`, and re-exports `backendShutdown`.
- **headless.ts**: the headless entry (`pnpm awaken:headless`, `abject serve`,
  and the background backend `abject` starts). The `-headless` workers and no
  UI layer.
- **ui-layer.ts**: `createDesktopUi()`, the desktop's `UiLayer`. Relays each
  authenticated UI WebSocket (and each paired remote browser) to BackendUI
  over a MessageChannel into the UI worker, or hands it straight to a
  main-thread BackendUI when dedicated workers are off.

### cli-server.ts

`CliServer`, the terminal gateway (main thread only: it owns a socket). Speaks
JSON text frames: `{ id, op, ...params }` in, `{ id, ok, result | error }`
out, and pushed `{ event, workspaceId, conversationId?, data }`. Every chat op
names its workspace, so one connection drives any number of workspaces. It
refuses every browser origin (`refuseAllOrigins`), and warns when it is bound
beyond loopback with no login. A fixed set of ops, not a general call, since
the socket may have no login:

| Ops | Reach |
|-----|-------|
| `listWorkspaces`, `switchWorkspace`, `createWorkspace`, `listProfiles`, `renameWorkspace`, `deleteWorkspace` | WorkspaceManager |
| `listChats`, `newChat`, `openChat`, `closeChat`, `renameChat`, `deleteChat`, `history`, `send` | the workspace's ChatManager and Chat (opening subscribes the connection; no window opens) |
| `stopGoal`, `pauseGoal`, `resumeGoal`, `goalStatus` | the conversation's Chat, the workspace's GoalManager |
| `listDialogs`, `respondDialog` | DialogBroker |
| `instanceInfo`, `shutdown`, `isConfigured` | InstanceInfo, the backend's shutdown, SettingsManager |
| `listProjects`, `setProjectTrusted`, `setProjectAutonomy` | the workspace's ExternalProjectRegistry |
| `getSettingsSchema`, `getSettings`, `setSettings`, `listPresets`, `applyPreset`, `savePreset`, `deletePreset`, `listModels` | SettingsManager |
| `getWorkspaceSettings`, `setWorkspaceSettings` (sections `general`, `access`, `web`, `appearance`) | WorkspaceManager, the workspace's WebExposure and Theme |
| `listPackages`, `setPackageEnabled`, `setPackageSettings` | Packages |
| `listSkills`, `setSkillEnabled` | SkillRegistry |
| `getUpdateStatus`, `updateAction` (`status`, `check`, `download`, `restart`, `autoDownload`) | AppUpdater (packaged desktop app only) |

Pushed events: `message` and `titleChanged` (to connections watching that
conversation), `goalProgress` (to connections watching a chat in that
workspace), and to every connection `conversationCreated`,
`conversationDeleted`, `conversationRenamed`, `conversationOpened`, `dialog`,
`dialogClosed`, `settingsChanged` and `toast`. Chat subscriptions are shared
and reference-counted across connections.

### auth.ts, auth-gate.ts

- **auth.ts**: `AuthConfig`, `loadAuthConfig()` (from the environment),
  `SessionStore` (in-memory tokens, seven-day lifetime, hourly cleanup), and
  `authenticateConnection()`, the handshake every socket runs. Comparisons are
  timing-safe.
- **auth-gate.ts**: `AuthGate`, where a saved login takes effect (main thread
  only). `getAuthState`, and `updateAuth`, which takes changes from
  SettingsManager only.

### instance-file.ts, data-dir.ts, version.ts

Plain functions, used by launchers before any object exists.

- **instance-file.ts**: `<dataDir>/instance.json`: `{ pid, edition, version,
  wsPort, cliPort, ownerToken, dataDir, startedAt, detached? }`, written
  atomically with mode 0600 once boot finishes and removed at shutdown (only
  by the backend that wrote it). The HTTP gateway's port is not in it: the
  gateway can be off, move, or fall back to a port the system picks, so ask
  `WebGateway.getStatus` for the address it is on. `readInstance`, `writeInstance`,
  `removeInstance`, `processAlive`, `probeHealth`, `liveInstance` (a record
  whose pid is alive and whose health check answers) and
  `assertNoOtherBackend`.
- **data-dir.ts**: `defaultDataDir()`, the OS per-user directory an installed
  Abject uses (`~/.config/abject` or `$XDG_CONFIG_HOME/abject` on Linux,
  `~/Library/Application Support/abject` on macOS, `%APPDATA%\abject` on
  Windows), and `resolveDataDir()`. The desktop app and the `abject` command
  use it; a source run keeps `.abjects`.
- **version.ts**: `abjectVersion()`: `__ABJECT_VERSION__`, baked in by
  `build-server.mjs`, or `package.json` in a source run.

### backend-ui.ts, ui-transport.ts, ws-protocol.ts

Desktop only; the headless bundle check forbids all three.

- **backend-ui.ts**: `BackendUI`, the display server. Implements the
  `abjects:ui` interface (registered as `UIServer`) and forwards surfaces,
  draw commands, 3D scene operations, audio, speech and media to every
  connected client, and routes their input back to surface owners. It
  retains enough state (surfaces, draw logs, scene nodes, theme, motion,
  scene library) to replay the whole display to a client that connects or
  reconnects. Frames are binary (`src/network/wire-codec.ts`), images go out
  once per client as content-addressed blobs (`abx:sha256:`), and each client
  has its own send queue with flow control (`frameAck`), coalescing, and a
  hard cap that drops a stalled client.
- **ui-transport.ts**: the `UITransport` abstraction over a client
  connection: `WebSocketUITransport` (main thread) and
  `MessagePortUITransport` (in the UI worker), plus helpers that pass binary
  frames across ports without copying.
- **ws-protocol.ts**: the message types between BackendUI and the browser
  client. `BackendToFrontendMsg` (surfaces, draw batches, scene ops, focus,
  cursor, clipboard, file pickers, captures, audio, speech, media and video,
  and the auth messages) and `FrontendToBackendMsg` (input, replies to
  measurement and capture requests, `ready`, `hello`, `frameAck`, font
  metrics, file uploads, auth). The file is the reference; the client side is
  in `client/`.

### node-storage.ts

`NodeStorage`, the `Storage` capability on SQLite (`node:sqlite`): one
`kv(key, value, updatedAt)` table in WAL mode, O(1) per-key writes through
prepared statements. The global store is `<dataDir>/storage.db`, each
workspace's `<dataDir>/ws-<id>/storage.db`. A legacy `storage.json` beside it
is imported once and renamed to `.bak`. If SQLite cannot open, it degrades to
memory (no persistence) and logs an error.

### node-worker-adapter.ts

`NodeWorkerAdapter`, a `worker_threads` Worker behind the `WorkerLike`
interface the worker bridges use. Compiled runs (`ELECTRON_PACKAGED`, or
whenever this module is itself `.js`) load the `.js` worker; a source run
registers tsx inside the worker first (worker threads do not inherit tsx's
loader) and drops tsx's `watch:` messages. `planWorkerHeaps()` and
`workerHeapMb()` size each worker's heap ceiling: `ABJECTS_WORKER_MAX_OLD_SPACE_MB`,
or three quarters of memory less 512 MB shared across all planned workers,
between 512 MB and 8 GB.

### signaling-server.ts

The standalone signaling server for P2P discovery (`pnpm whisper`, port
`SIGNALING_PORT`, default 7720). Peers register with their public keys; it
answers `find` and `list-peers`, relays SDP offers and answers and ICE
candidates, answers `get-ice` with STUN servers (`STUN_URLS`) and, when
`TURN_SECRET` is set, time-limited coturn credentials for `TURN_URLS`
(lifetime `TURN_TTL`, default 12 hours). Peers silent for five minutes are
dropped. No message content passes through it. Federation with sibling
servers exists as `enableFederation()`, which the standalone entry does not
call.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `7719` | UI WebSocket (desktop) and health endpoint; the other ports derive from it |
| `CLI_PORT` / `CLI_BIND` | `WS_PORT`+4 / `127.0.0.1` | CLI gateway port and interface |
| `HTTP_PORT` / `HTTP_BIND` | `WS_PORT`+5 / `127.0.0.1` | HTTP gateway port and interface |
| `ABJECTS_DATA_DIR` | `.abjects` | Data directory. The desktop app and an installed `abject` set it to the OS per-user directory (`data-dir.ts`) when unset |
| `ABJECTS_AUTH_USER` / `ABJECTS_AUTH_PASSWORD` | unset | A login for every socket (both or neither); one saved in the settings replaces it |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` | unset | Provider keys handed to LLMObject at boot |
| `ABJECTS_WORKER_COUNT` | cores - 1, at most 8 | Pool size; `0` turns the pool off, so pool objects run on the main thread |
| `ABJECTS_WORKER_MAX_OLD_SPACE_MB` | sized from memory | Heap ceiling per worker thread |
| `ABJECTS_DEDICATED_WORKERS` | on | `0` runs the P2P layer (and on a desktop, BackendUI) on the main thread |
| `ABJECTS_ALLOWED_ORIGINS` | unset | More web origins allowed to open the UI socket (comma or space separated), beside `ABJECTS_CLIENT_ORIGIN` (set by Electron) and the dev client on `VITE_CLIENT_PORT` (default 5174, not in a packaged app). See `src/network/origin-policy.ts` |
| `ABJECTS_NATIVE_DIR` | found | The bundled packages directory (the `abject` command sets it for an install) |
| `ABJECTS_PACKAGE_DIRS` | unset | More package directories (path-delimiter separated); see `docs/PACKAGES.md` |
| `ABJECTS_SIGNALING_URLS` | unset | Use only these signaling servers (comma-separated), pinned |
| `ABJECTS_PEER_ADMISSION` | `open` | `allowlist` pins allowlist mode: only allowed peers connect |
| `ABJECTS_ALLOWED_PEERS` | unset | Peer ids always allowed (comma-separated) |
| `DEBUG` | unset | Runtime debug logging |

## Usage

```bash
pnpm awaken              # desktop edition from source (tsx --watch server/index.ts)
pnpm scry                # the browser client (Vite, http://localhost:5174)
pnpm awaken:headless     # headless edition from source
pnpm abject              # the terminal client against either
pnpm whisper             # signaling server on :7720
pnpm awaken2 / scry2     # a second instance: .abjects2, WS_PORT 7721, client 5175
pnpm bind                # compile to dist-server/ (build-server.mjs)
```

## Adding a system object

1. Register its constructor in `bootServer()` in `boot.ts`. A window, widget or
   anything that draws registers in `ui-layer.ts` (`registerConstructors`)
   instead, so the headless bundle stays clean.
2. If it may run on the worker pool, add its name to `workerEligible` (in
   `boot.ts`, or the UI layer's list) and its constructor to
   `workers/core-constructors.ts` (or `workers/ui-constructors.ts`). Anything
   holding this process's sockets or state stays main-thread only.
3. Spawn it with `supervisedSpawn(name, 'permanent', systemTypeId(name))` at
   the point where what it depends on exists, and add its id to HealthMonitor's
   list if it should be watched.

A per-workspace object is registered the same way (steps 1 and 2) and listed in
`INFRA_OBJECTS` or `UI_OBJECTS` in `src/objects/workspace-profiles.ts`;
WorkspaceManager spawns it. A new terminal op goes into
`CliServer.handleOp()` (and `cli/client.ts`).

## Gotchas

- **One backend per data directory.** A second one stops at step 1 with a
  message naming the first. Two instances side by side need their own
  `ABJECTS_DATA_DIR` and `WS_PORT` (the `awaken2`/`awaken3` scripts); the CLI
  and HTTP ports follow `WS_PORT`.
- **Display code stays out of `boot.ts`.** `pnpm bind` fails when a window, a
  widget or the display server reaches a headless bundle, and prints the
  import chain (`scripts/headless-bundle-check.mjs`).
- **Main-thread objects.** PeerRouter (a synchronous interceptor), Supervisor,
  MediaStream, AuthGate, CliServer, WebGateway, HeapMonitor, InstanceInfo,
  BrowserWindowHost and AppUpdater are deliberately not worker-eligible.
- **Dialog surfaces seal at step 12.** A new surface registers with
  DialogBroker before `seal`; afterwards registration is refused.
- **The KnowledgeBase is a bundled WASM package.** Boot stops without
  `native/knowledge-base`; in a checkout, `pnpm smelt` rebuilds it.
- **Sessions live in memory.** A restart signs out browsers and terminals that
  used a login, and the owner token changes at every boot.
- **The UI socket checks origins.** A page served from anywhere other than the
  desktop app, the dev client or `ABJECTS_ALLOWED_ORIGINS` is refused, and the
  dev client's origin is not allowed in a packaged app.
- **UI worker death.** If the UI worker runs out of heap, window and widget
  requests fail fast with `WORKER_DEAD` until restart. Raise
  `ABJECTS_WORKER_MAX_OLD_SPACE_MB`, and look for a client send-queue backlog in
  the log.
- **NodeStorage names.** Storage is constructed with a `storage.json` path,
  but the file it opens is `storage.db` in the same directory.

## Related

- [workers/README.md](../workers/README.md): pool, UI and P2P worker entries
- [cli/README.md](../cli/README.md): the `abject` command, CliServer's client
- [electron/README.md](../electron/README.md): the desktop app around `index.ts`
- [deploy/README.md](../deploy/README.md): the headless edition as a service
- [src/runtime/README.md](../src/runtime/README.md): Runtime, MessageBus, worker bridges
- [src/network/README.md](../src/network/README.md): WebSocket server, origin policy, wire codec
- [client/README.md](../client/README.md): the browser client
- [docs/WEB_GATEWAY.md](../docs/WEB_GATEWAY.md), [docs/PACKAGES.md](../docs/PACKAGES.md)
