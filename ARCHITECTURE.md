# Abjects Architecture

## 1. System Overview

Abjects is an LLM-mediated distributed object system. Objects (Abjects)
communicate only through asynchronous message passing, describe themselves
with manifests, and answer questions about themselves in natural language.
When two objects with different interfaces need to talk, an LLM writes a proxy
object that translates between them. Agents, goals, the settings, the peer
network and the desktop's windows are all Abjects.

Everything runs in one Node.js backend. Its main thread holds the message bus,
the Registry, the Factory and the sockets; nearly every other object runs on a
pool of `worker_threads`, with dedicated threads for the peer layer and (on a
desktop) the display server. A person reaches it through:

- the **thin browser client** (`client/`), which draws what the backend's
  display server tells it to and sends input back;
- the **desktop app** (`electron/`), which embeds the backend in Electron's
  main process and opens the same client in a window;
- the **`abject` command** (`cli/`), a terminal client for chat, questions and
  settings;
- **paired remote browsers and phones**, over encrypted WebRTC.

The backend comes in two editions that share one bootstrap:

| Edition | Entry | What it adds |
|---------|-------|--------------|
| Desktop | `server/index.ts` (`pnpm awaken`, the Electron app) | `server/boot.ts` plus the display layer `server/ui-layer.ts`: BackendUI (registered as `UIServer`), the UI worker, WindowManager, WidgetManager, the windows, the browser UI socket on `WS_PORT`, paired remote browsers |
| Headless | `server/headless.ts` (`pnpm awaken:headless`, `abject serve`, the `abject` binary) | `server/boot.ts` alone: no display server, no windows. `WS_PORT` serves only `GET /healthz` and `GET /version` |

`pnpm bind` (`build-server.mjs`) builds both and runs
`scripts/headless-bundle-check.mjs`, which fails the build if display code
(BackendUI, WidgetManager, a window, the UI constructors) reaches a headless
bundle.

## 2. Foundational Concepts

### 2.1 Everything is an Abject

Registry, Factory, the LLM, the capability objects, the agents, the settings,
the display server and every window are Abjects. Each one has:

- **id**: an `AbjectId` (UUID v4), assigned at construction and different on
  every run.
- **typeId**: a durable `TypeId`, stable across restarts.
  `{peerId}/system/{Name}` for system objects, `{peerId}/{workspaceId}/{Name}`
  for per-workspace objects, `{peerId}/{workspaceId}/user/{Name}` for objects
  people create. The Registry indexes it (`resolveType`) and AbjectStore keys
  snapshots by it, so a restored object gets a new id and keeps its typeId.
- **manifest**: name, description, version, one `interface`
  (`InterfaceDeclaration`: id, methods with typed parameters and returns,
  events), tags, and an optional icon.
- **status**: `initializing`, `ready`, `busy`, `error` or `stopped`.

The base class (`src/core/abject.ts`) gives every Abject the same built-in
handlers: `describe` (manifest plus a readable description, see
`src/core/introspect.ts`), `ask` (answers a question about itself through the
LLM, from its manifest and its own guidance; script objects include their
source), `ping`, `addDependent` / `removeDependent` (the Smalltalk dependency
protocol behind `changed()`), `getRegistry`, `getResultContract` and
`progress`.

Conventions every Abject follows:

- handlers are registered in the constructor with `this.on('method', handler)`;
  returning a value from a request handler sends the reply, and returning
  `DEFERRED_REPLY` lets the handler reply later with `sendDeferredReply`;
- dependencies are found by name through the Registry (`discoverDep`,
  `requireDep`), never imported;
- objects only send messages to each other (`this.send()` for events,
  `this.request<T>()` for request/reply, 30 s default timeout that any
  `progress` event resets); no object calls another's methods directly;
- each system object exports a well-known id constant (`REGISTRY_ID`,
  `FACTORY_ID`, `LLM_OBJECT_ID`, `DIALOG_BROKER_ID`, ...).

### 2.2 Messages

Four message types: **request**, **reply**, **event**, **error**.

```
AbjectMessage {
  header:   { messageId, correlationId?, sequenceNumber, timestamp, type }
  routing:  { from, to, method?, authenticatedPeerId? }
  payload:  unknown
  protocol: { version, negotiationId? }
}
```

- Replies and errors carry the request's id as `correlationId`.
- Sequence numbers are per sender, tracked in module-level state in
  `src/core/message.ts` (`resetSequence()` clears one).
- Builders: `request()`, `reply()`, `event()`, `error()`,
  `errorFromException()`. Guards: `isRequest()`, `isReply()`, `isEvent()`,
  `isError()`, `isReplyTo()`. `serialize()` / `deserialize()` are JSON;
  `validateMessageShape()` checks an untrusted one.
- Remote links (backend to client, peer to peer) use the binary wire codec in
  `src/network/wire-codec.ts` instead of JSON.
- `authenticatedPeerId` is set by the receiving side from the transport that
  delivered the message; a value from the wire is never trusted.

### 2.3 Design by Contract

Contracts are always on: correctness over performance.

- `require(condition, message)`: preconditions at function entry
- `ensure(condition, message)`: postconditions before return
- `invariant(condition, message)`: class state, checked in `checkInvariants()`
  after construction and state changes (overrides call
  `super.checkInvariants()` first)

All throw `ContractViolation` with its kind (`'require'`, `'ensure'`,
`'invariant'`). Helpers: `requireDefined()`, `requireNonEmpty()`,
`requireNonEmptyArray()`, `requirePositive()`, `requireNonNegative()`. All in
`src/core/contracts.ts`.

### 2.4 Containment and Permissions

Authority comes from where an object runs and whom it can message, not from
anything it declares. Generated JavaScript runs in a script sandbox and WASM
modules see only three host imports (`emit`, `log`, `time_ms`), so neither
has a filesystem, a socket or a process of its own. Everything outside the
object system belongs to a capability object (section 4.4): to touch a file,
run a command or reach the network, an object sends that object a message,
and the capability object decides.

- **Built-in objects are the trusted ones** (`src/core/built-in.ts`): an
  instance of a class compiled into the server, which the registry shows as
  an entry with no `source`, no package owner and no remote peer. Privileged
  handlers (settings writes and secret reads, the login, the web gateway's
  controls, updates, trust changes) admit callers with
  `Abject.isBuiltInCaller(id, names)`. Code cannot pass for a built-in: the
  Factory builds a server class, a built-in typeId shape or a `respawn` only
  for a built-in requester (code may spawn more code into its own registry
  and stop only itself and what it owns); the registries take `rename`,
  curation, `setFallback`, remote entries and writes to another object's
  entry only from built-ins, and an object's own entry keeps its name,
  typeId, owner and source; AbjectStore snapshots and the Supervisor's
  `addChild` / `removeChild` / `childFailed` follow the same rule. The
  bootstrap (sender `bootstrap`) anchors it all: it spawns the first built-in
  objects.

- **PermissionBroker** (`src/objects/permission-broker.ts`) holds the
  permission authority for ShellExecutor, HostFileSystem, HttpClient and
  StreamClient. ShellExecutor, HostFileSystem and StreamClient ask it before
  each effect: allow, refuse, or ask the person. HttpClient applies the web
  settings it is given (enabled, allowed and denied domains, private hosts)
  without asking. PermissionBroker combines the project's autonomy
  (`ask`, `read`, `edit`, `full`) with a ceiling from the calling workspace's
  access mode (a public workspace is capped at `ask`). A request no rule
  decides follows the prompt mode, a setting: `ask` (default), `allow` or
  `deny`; a dangerous command is asked about even in `allow` mode. Questions
  go to DialogBroker (section 5.6) and wait as long as the person takes.

## 3. Threads and Processes

```
┌─ Node.js backend ───────────────────────────────────────────────────────────┐
│ Main thread                                                                 │
│   MessageBus  (interceptors: PeerRouter, LoggingInterceptor with DEBUG;     │
│                then the proxy routes, copied to every pool worker)          │
│   Registry · Factory · Supervisor · PeerRouter · AuthGate · InstanceInfo    │
│   CliServer (WS :7723) · WebGateway (HTTP :7724, off until enabled)         │
│   Negotiator · HeapMonitor · WorkerRecovery · desktop app only:             │
│   BrowserWindowHost, AppUpdater                                             │
│                                                                             │
│ Worker pool (worker_threads; ABJECTS_WORKER_COUNT, default cores - 1, ≤ 8)  │
│   LLM · capabilities · SettingsManager · PermissionBroker · DialogBroker    │
│   ProxyGenerator · HealthMonitor · WorkspaceManager                         │
│   per-workspace objects (registry, storage, agents, Chat) · KnowledgeBase   │
│   ScriptableAbjects · WasmAbjects · desktop only: WidgetManager, windows    │
│                                                                             │
│ P2P worker                           UI worker (desktop only)               │
│   Identity · PeerRegistry              BackendUI, registered as UIServer    │
│   RemoteRegistry · SignalingRelay                                           │
│   PeerDiscovery · RemoteUIAccess (desktop only)                             │
└────────┬──────────────────────┬─────────────────────┬───────────────────────┘
         │ WS :7719 (desktop)   │ WS :7723            │ WebRTC DataChannels
 ┌───────▼────────────┐  ┌──────▼──────────┐   ┌──────▼───────────────────────┐
 │ Thin browser client│  │ abject (TUI or  │   │ Peers; paired browsers and   │
 │ WebGL2 compositor  │  │ one-shot CLI)   │   │ phones (signaling: whisper)  │
 └────────────────────┘  └─────────────────┘   └──────────────────────────────┘
```

- **Placement.** The Factory sends a spawn to a pool worker when the
  constructor is marked worker-eligible (`markWorkerEligible`, lists in
  `server/boot.ts` and `server/ui-layer.ts`). Placement is deterministic
  (`workerIndexForId(objectId, workerCount)`). Each worker runs a `WorkerBus`;
  workers talk to each other directly over `MessagePort`s and to the main bus
  through a `WorkerBridge`. Objects deliberately kept on the main thread:
  PeerRouter (a synchronous bus interceptor), Supervisor, MediaStream,
  AuthGate, CliServer, WebGateway, HeapMonitor, InstanceInfo, WorkerRecovery.
- **Constructor tables.** A worker can only build what its table holds.
  `workers/core-constructors.ts` (both editions) and
  `workers/ui-constructors.ts` (desktop only) must match the main-thread
  registrations in `server/boot.ts` (core) and `server/ui-layer.ts` (UI).
  Pool entries: `workers/abject-worker-node.ts` (desktop, core plus UI) and
  `workers/abject-worker-headless.ts` (core only), both running
  `workers/worker-runtime.ts`. P2P worker: `workers/p2p-worker-runtime.ts`,
  with `p2p-worker-node.ts` (adds RemoteUIAccess) and `p2p-worker-headless.ts`.
  UI worker: `workers/ui-worker-node.ts`.
- **Dedicated workers.** `ABJECTS_DEDICATED_WORKERS=0` keeps the peer layer
  (and BackendUI) on the main thread. `ABJECTS_WORKER_COUNT=0` disables the
  pool.
- **Worker loss.** Each worker has a heap ceiling
  (`ABJECTS_WORKER_MAX_OLD_SPACE_MB`, default three quarters of memory less
  512 MB shared across the workers, between 512 MB and 8 GB). A dead worker's
  pending requests fail with `WORKER_DEAD`; WorkerRecovery has WorkspaceManager
  respawn what the worker hosted and restore user objects from snapshots.
- **Data directory.** One backend per data directory (`ABJECTS_DATA_DIR`).
  A source checkout uses `.abjects`; the desktop app and installed headless
  builds use the OS location from `server/data-dir.ts` (`~/.config/abject`,
  `~/Library/Application Support/abject`, `%APPDATA%\abject`). Once its
  sockets are bound, the backend writes `<dataDir>/instance.json`
  (`server/instance-file.ts`, mode 0600): pid, edition, version, ports and an
  owner token. The `abject` command finds the backend through it, and a second
  backend refuses to start against the same directory.

## 4. Layers

### 4.1 Core (`src/core/`)

- **`types.ts`**: identity types (`AbjectId`, `TypeId`, `MessageId`, ...),
  `AbjectMessage`, `InterfaceDeclaration`, `MethodDeclaration`,
  `TypeDeclaration`, `AbjectManifest`, `ProtocolAgreement`, `AbjectStatus`.
- **`contracts.ts`**: `require`, `ensure`, `invariant` and helpers.
- **`message.ts`**: message builders, guards, JSON serialization, sequence
  numbers.
- **`abject.ts`**: the `Abject` base class (handlers, `send`, `request`,
  pending replies, deferred replies, dependency discovery, the `ask` protocol,
  `changed()`, owned timers `setTimer` / `setRecurringTimer`, `confirm()` and
  `prompt()` through DialogBroker) and `SimpleAbject`.
- **`introspect.ts`**: `formatManifestAsDescription()`, the text `describe`
  returns.
- **`identity.ts`**: peer identity primitives. A PeerId is the hex SHA-256 of
  the public signing key; ECDSA for signatures, ECDH plus AES-256-GCM for
  channels.
- **`sandbox.ts`**: the `vm` sandbox that runs script code (no `require`,
  `fetch`, `process` or other host globals).
- **`knowledge.ts`**: the KnowledgeBase message vocabulary. The KnowledgeBase
  itself is the C++/WASM package in `native/knowledge-base`; there is no
  TypeScript one.

The rest of `src/core/` holds shared pure helpers (theme data, dock layout,
task graphs, decision questions, skill parsing, path scopes, and others).

### 4.2 Runtime (`src/runtime/`)

- **`runtime.ts`**: creates the MessageBus, Registry and Factory, starts the
  worker pool. States: `created`, `starting`, `running`, `stopping`,
  `stopped`. `getRuntime()` / `resetRuntime()`.
- **`message-bus.ts`**: the main-thread router. `register()` gives each
  object a Mailbox; `send()` runs the interceptor pipeline, then delivers
  locally, to a worker bridge, or to the undeliverable handler. A request to a
  recipient that no longer exists gets an error reply at once; an event gets
  the sender a `recipientGone` notice.
  Interceptors defined here: `LoggingInterceptor` (installed with `DEBUG`).
  After the interceptors, `send()` applies the proxy routes of negotiated
  connections.
- **`proxy-routes.ts`**: the route table the main bus owns and copies to every
  pool worker, so a connection's proxy sits between its two ends on every bus
  (section 5.3).
- **`mailbox.ts`**: bounded FIFO (default 1000). A message to a full or
  closed mailbox is dropped with a warning. Also `PriorityMailbox`.
- **`supervisor.ts`**: Erlang-style supervision. Strategies `one_for_one`
  (default), `one_for_all`, `rest_for_one`; child restart types `permanent`,
  `transient`, `temporary`; at most 3 restarts in 5 s before it gives up.
  Restarts go through the Factory's `respawn`, keeping the id.
- **`worker-pool.ts`, `worker-bridge.ts`, `worker-bus.ts`,
  `dedicated-worker-bridge.ts`**: the pool, the main-side bridge to one
  worker, the worker-side bus, and the bridge for the P2P and UI workers.
- **`child-processes.ts`**: child processes (MCP servers, shells) that must
  not outlive the backend; signalled at shutdown.

### 4.3 Objects (`src/objects/`)

Global system objects (one per instance):

- **Registry** / **Factory**: the object directory (`register`, `discover`,
  `lookup`, `list`, `search`, `subscribe`, `updateManifest`, `resolveType`)
  and lifecycle (`spawn`, `kill`, `respawn`, `clone`, `instantiate`,
  `registerConstructor`). Package types registered with the Factory
  (`registerPackageType`) win over built-in constructors of the same name.
- **LLM** (`llm-object.ts`, manifest name `LLM`, `LLM_OBJECT_ID`): every model
  call. Tiers (`smart`, `balanced`, `fast`, `code`), per-tier providers and
  fallbacks, streaming, a cost ledger, and abject-backed providers
  (`registerProvider`, see `docs/LLM_PROVIDERS.md`).
- **ObjectCreator**: makes and modifies objects from natural language
  (`create`, `modify`, `investigate`). It asks the objects it will depend on
  how to use them before it writes code.
- **ProxyGenerator**, **Negotiator** (in `src/protocol/`), **HealthMonitor**:
  protocol mediation (section 5.3).
- **SettingsManager**: owns the global settings (AI, login, permissions,
  filesystem, shell, web): persists, validates and
  applies them, emits `settingsChanged`. It takes changes from GlobalSettings
  (its window), CliServer, and abjects in a workspace this instance hosts in
  local mode.
- **PermissionBroker**, **DialogBroker**: host permissions and questions to
  the person (sections 2.4 and 5.6).
- **Packages**: lists packages and edits `packages.json`; serves package
  settings to a package's own objects.
- **InstanceInfo**: version, readiness, edition, and whether there is a
  display (`getInfo`). Agents ask it before offering a window or screenshot.
- **WorkspaceManager**, **WorkspaceShareRegistry**: workspaces and sharing.
- **SkillRegistry**, **MCPBridge**, **MCPRegistryClient**, **ClawHubClient**,
  **SecretsVault**, **OAuthHelper**: skills, MCP servers and their
  credentials.
- **ObjectCatalog**, **CassetteRecorder**, **HeapMonitor**, **WorkerRecovery**.

Per-workspace objects (spawned by WorkspaceManager from the workspace's
profile, `src/objects/workspace-profiles.ts`; `docs/WORKSPACE_PROFILES.md`):

- **Infrastructure** (`INFRA_OBJECTS`, spawned whenever the workspace is up):
  AbjectStore, SharedState, TupleSpace, FileTransfer, MediaStream, Theme,
  NotificationCenter, GoalManager, JobManager, TaskSession, AgentAbject,
  ScrumMaster, GoalObserver, WebAgent, SkillAgent, ObjectAgent,
  ExternalProjectRegistry, ExternalCreator, ObjectCreator, AgentCreator,
  Scheduler, KnowledgeBase, TaskReviewer, AgentEvaluation, ChatManager,
  Console, CollectionStore, TriggerManager, WebExposure. Before these,
  WorkspaceManager spawns the workspace's own **WorkspaceRegistry** (a
  Registry that falls back to the global one on a miss; `getWorkspaceId` says
  which workspace it belongs to), Storage and FileSystem.
- **UI** (`UI_OBJECTS`, spawned the first time the workspace is shown, and
  never where there is no display): Settings, AppExplorer, GoalBrowser,
  JobBrowser, KnowledgeBrowser, AgentBrowser, SchedulerBrowser,
  WebBrowserViewer, FileManager, FileViewer, ExternalProjectBrowser,
  ChatBrowser, AbjectEditor, PeersViewer, Taskbar, CommandPalette,
  WindowSwitcher, DataBrowser.

Other notable objects:

- **ScriptableAbject**: an object whose behavior is a JavaScript handler map,
  run in the `vm` sandbox with a `this` shim (`call`, `dep`, `find`,
  `changed`, `emit`, `observe`). Objects people create, generated proxies and
  script packages are ScriptableAbjects. AbjectStore persists their snapshots
  and keeps a ring of prior sources.
- **WasmAbject**: an object backed by a WebAssembly module (section 5.5).
- **AgentAbject**: the agent runtime. Agents (ScrumMaster, ObjectAgent,
  WebAgent, Chat, user objects) register with it and it runs their
  observe, think, act loop.
- **Chat** and **ChatWindow**: Chat is a conversation (transcript, routing to
  goals, the agent loop) and draws nothing; it announces every message as
  `messageAdded`. ChatWindow is its desktop view, spawned by Chat on `show`.
  ChatManager owns the roster and spawns Chat on demand. A terminal opens a
  conversation without a window.
- **NotificationCenter**: workspace infrastructure; keeps the notification
  history and announces each one (terminals show them). It draws a toast only
  where there is a desktop.
- **WidgetManager**, **WindowManager**, `widgets/`: the window system and the
  widget toolkit (windows, layouts, buttons, text, tables, charts, markdown).
  Desktop only.

### 4.4 Capability Objects (`src/objects/capabilities/`)

| Object | What it does |
|--------|--------------|
| HttpClient | HTTP requests with domain allow/deny; refuses private and loopback addresses (checked after DNS and on every redirect) unless listed under Private hosts |
| StreamClient | Long-lived WebSocket and Server-Sent Events connections |
| Storage | Key-value store; on the backend `NodeStorage` (`server/node-storage.ts`), SQLite via `node:sqlite`. One global, one per workspace |
| FileSystem | Per-workspace virtual filesystem, kept in the data directory at `ws-<workspaceId>/files`, beside the workspace's `storage.db` |
| HostFileSystem | Real files on the host, through PermissionBroker |
| ShellExecutor | Shell commands on the host, through PermissionBroker |
| WebSearch, WebFetch | Web search and readable page text (compose HttpClient and WebParser) |
| WebBrowser | Browser automation with Playwright. In the desktop app it drives Electron's own Chromium (BrowserWindowHost); elsewhere it launches Chromium |
| WebParser | HTML parsing with linkedom |
| Timer, Clipboard, Console, Crypto | Timers, clipboard, per-object log buffers, randomness and hashing for script objects |
| SharedState | Last-writer-wins CRDT state, synced with peers per workspace access mode |
| FileTransfer, MediaStream | Chunked file transfer and media tracks over peer connections |
| Screenshot, AudioOutput, Speech | Desktop only: captures, sound and speech through the connected client |

### 4.5 Protocol (`src/protocol/`)

- **`negotiator.ts`**: `connect`, `disconnect`, `renegotiate`. Learns both
  sides through `describe`; compatible when their interface ids match.
- **`health-monitor.ts`**: connection error rates and object liveness
  (section 5.4). `INCOMPREHENSION_ERRORS`: `PARSE_ERROR`, `UNKNOWN_METHOD`,
  `INVALID_PAYLOAD`, `SCHEMA_MISMATCH`, `TYPE_ERROR`, `SEMANTIC_ERROR`.

### 4.6 LLM (`src/llm/`)

- **`provider.ts`**: `LLMProvider` (`complete`, `stream`), `LLMMessage`,
  `BaseLLMProvider`, `ModelTier`.
- Built-in providers: Anthropic, OpenAI, Ollama, OpenRouter, DeepSeek, Grok,
  Gemini, Kimi, MiniMax, Meta, PeerLLM, the CLI-driven `claude`, `codex` and
  Antigravity providers (`claude-cli.ts`, `codex-cli.ts`,
  `antigravity-cli.ts`), and TypeSafe (a decision model). The list lives in
  `LLMObject.PROVIDER_DESCRIPTORS`.
- **`remote-provider.ts`**: the adapter for providers implemented by other
  abjects.
- **`tier-resolver.ts`**, **`pricing.ts`**, **`decision.ts`**,
  **`decision-emulator.ts`**: recommended models per tier from a provider's
  catalog, cost estimation, and typed decision questions answered by a
  decision model or emulated on a chat model.

### 4.7 Network (`src/network/`)

- **`transport.ts`**, **`websocket-server.ts`**: the transport abstraction
  (`PeerTransport` extends it) and the Node WebSocket server (with an origin
  check and an HTTP hook for `/healthz`).
- **`origin-policy.ts`**: which web pages may open the UI socket (the
  desktop's own client, the dev client, `ABJECTS_ALLOWED_ORIGINS`); the CLI
  gateway refuses every page.
- **`signaling.ts`**: `SignalingClient` for the signaling server (register,
  find, relay SDP and ICE, `requestIceServers`). See `WHISPER.md`.
- **`peer-transport.ts`**: WebRTC DataChannel; exchanges keys, verifies the
  PeerId, derives an AES-256-GCM session key by ECDH.
- **`peer-router.ts`**: PeerRouter, an Abject and a bus interceptor. An
  AbjectId is the only address; PeerRouter routes messages for remote objects
  across peers and propagates routes by workspace access mode.
- **`webrtc-ui-transport.ts`**: a UI transport over an encrypted
  PeerTransport, for paired remote browsers.
- **`wire-codec.ts`**: the binary codec for all remote traffic.
- **`mcp-transport.ts`**: stdio JSON-RPC to MCP server processes.

### 4.8 Sandbox and Packages (`src/sandbox/`)

Packages add abjects to an instance without changing the server
(`docs/PACKAGES.md`):

- **`extensions.ts`**: discovery and boot-time ingest, from (in order)
  bundled `native/` (in the desktop app, `resources/native`), installed
  extensions (`$ABJECTS_DATA_DIR/extensions/`, via `pnpm forge`),
  `ABJECTS_PACKAGE_DIRS`, and directories added in `packages.json`. A later
  package with the same type name wins when its version is the same or newer;
  `packages.json` can disable any.
- **`package-config.ts`**: `packages.json`.
- **`wasm-abi.ts`**, **`wasm-instance.ts`**, **`wasm-module-store.ts`**: the
  WASM ABI (`docs/WASM_ABI.md`), one module instance with its three host
  imports and a minimal WASI shim (no filesystem, no sockets), and the
  content-addressed module store (`$ABJECTS_DATA_DIR/wasm/`, referenced as
  `wasm:sha256:<hex>` in the normal `source` field).

### 4.9 Display (`server/backend-ui.ts`, `src/ui/`, `client/`)

On a desktop, BackendUI (registered as `UIServer`, interface `abjects:ui`) is
the display server. It runs in the UI worker, owns every surface, and sends
draw commands, surface operations and 3D scene operations to each connected
client over the binary wire codec; input and text measurements come back.
Objects never touch the DOM: they paint their surfaces with 2D draw commands
by message. Several clients can be attached at once (the local window, a
browser, a paired phone).

The client (`client/frontend-client.ts`) renders with `src/ui/compositor.ts`:
each surface is an `OffscreenCanvas` uploaded as the texture of a slab in a
WebGL2 scene (`src/ui/gl/`), with lighting, focus effects and drag tilt. A
retained scene vocabulary (meshes, lights, groups, theme color tokens) lets an
object attach 3D content to its window. The compositor only renders and picks;
decisions stay in the backend.

### 4.10 Gateways and Auth (`server/`)

- **UI socket** (`WS_PORT`, default 7719, loopback): the browser client, on a
  desktop only. Answers `GET /healthz` and `GET /version` too.
- **CliServer** (`CLI_PORT`, default `WS_PORT + 4` = 7723; `CLI_BIND`,
  loopback by default): the `abject` command's gateway. JSON frames
  `{ id, op, ... }` for workspaces, chats, goals, questions, settings,
  packages, skills and updates; pushed events for chat messages and dialogs.
- **WebGateway** (`HTTP_PORT`, default `WS_PORT + 5`; `HTTP_BIND`, loopback by
  default; off until enabled): serves exposed abjects over HTTP
  (`docs/WEB_GATEWAY.md`).
- **AuthGate** (`server/auth-gate.ts`): the login every socket checks. The UI
  socket, CliServer and WebGateway share one `AuthConfig` and one
  `SessionStore` (`server/auth.ts`), so one session token works on all of
  them. A login comes from `ABJECTS_AUTH_USER` / `ABJECTS_AUTH_PASSWORD` or
  from the settings; only SettingsManager may change it (`updateAuth`), and a
  change signs every session out. A local client that presents the owner token
  from `instance.json` is let in without the login.

### 4.11 The `abject` Command (`cli/`)

`cli/abject.ts` routes the subcommands: the chat (`cli/chat-ui.ts`, a tabbed
TUI, or `--plain` for a line REPL), `setup`, `start`, `stop`, `restart`,
`serve`, `status`, `logs`, `questions`, `answer`, `mode`, `settings`,
`service install|uninstall|status`, `update`, `doctor`, `version`. It finds
the backend for a data directory through `instance.json` (`cli/locate.ts`),
or connects to `--url`.

What it does when nothing is running depends on which copy it is
(`ABJECT_EDITION`): the headless edition's binary starts its own backend in
the background (it keeps running after the TUI quits; `abject stop` stops it);
the desktop app's copy (shipped in `resources/cli`, put on the PATH from
Help → Install the abject Command) waits for the app; `pnpm abject` in a
checkout waits for `pnpm awaken`.

## 5. Flows

### 5.1 Bootstrap (`server/boot.ts`)

```
server/index.ts | server/headless.ts
  runServer({ edition, workerScript, p2pWorkerScript, ui? })   ui = createDesktopUi() on a desktop
  bootServer():
    assertNoOtherBackend(dataDir)               instance.json lock
    getRuntime({ workerCount, workerFactory })
    ui?.beforeRuntimeStart                      BackendUI on the main thread only without dedicated workers
    runtime.start()                             MessageBus, Registry, Factory, WorkerPool
    ui?.afterRuntimeStart                       UI worker; BackendUI registered as UIServer
    desktop: ui.openSocket (UI socket + health)    headless: health server on WS_PORT
    register constructors (+ ui.registerConstructors); mark worker-eligible
    ingestAllExtensions(factory)                packages; boot stops without KnowledgeBase
    spawn Supervisor; then supervised spawns:
      HttpClient, LLMObject (configure with env keys), Storage, Timer, Crypto,
      Clipboard, Console, WebParser, [BrowserWindowHost], WebBrowser,
      ShellExecutor, HostFileSystem, WebSearch, WebFetch, StreamClient, DialogBroker
    ui?.spawnDisplay                            Screenshot, AudioOutput, Speech, WindowManager,
                                                WidgetManager (presenter: confirm, prompt), SceneLibrary
    PeerRouter on the bus
    P2P worker: Identity, PeerRegistry, RemoteRegistry, SignalingRelay,
                PeerDiscovery (+ RemoteUIAccess on a desktop)
    PermissionBroker, AuthGate, SettingsManager
    ui?.spawnSettingsWindow                     [AppUpdater], GlobalSettings (presenter: options)
    Packages, InstanceInfo
    HeapMonitor, SkillRegistry, WebGateway, MCPRegistryClient, ClawHubClient,
    SecretsVault, OAuthHelper, ProxyGenerator, Negotiator, HealthMonitor, CassetteRecorder
    ui?.spawnGlobalUi                           toolbar, sidebar, browsers, inspectors, switcher
    system-scope packages (autostart ones get `startup`)
    CliServer → DialogBroker.registerResponder → DialogBroker.seal
    WorkspaceManager.boot                       every workspace's objects
    WorkspaceShareRegistry, WorkerRecovery
    ui?.spawnLateUi                             WorkspaceBrowser, WorkspaceCollaboratorInspector
    ObjectCatalog
    HealthMonitor: monitorObject + markObjectReady for system objects; startMonitoring
    writeInstance(<dataDir>/instance.json)
```

The bootstrap talks to the Factory and other objects by message, through a
temporary `bootstrap` mailbox on the bus. DialogBroker's presenters and
responders are registered and sealed before any workspace exists, so no user
object can ever register as one.

### 5.2 Message Flow

```
Object A: this.request(request(A, B, 'method', payload))
  → bus (A's own MessageBus, or its WorkerBus that forwards to main or a peer worker)
  → interceptors (each returns 'pass', 'drop' or a rewritten message)
  → B local: B's mailbox    B in a worker: that worker's bridge    B remote: PeerRouter
  → B's loop takes it from the mailbox → handler → return value becomes the reply
  → reply travels back the same way → A's loop resolves the pending request
```

Each object takes messages from its mailbox in order and starts each handler
without awaiting it, so a handler waiting on a reply never blocks the next
message; code that must not interleave takes a lock of its own
(`src/core/keyed-lock.ts`). Replies and errors never reach a handler: they
settle the pending request they answer. A request with no handler (and no
`'*'` catch-all) gets a `METHOD_NOT_FOUND` error. A handler that finishes
later returns `DEFERRED_REPLY` and answers with `sendDeferredReply`.

### 5.3 Proxy Generation

```
Negotiator.connect(sourceId, targetId)
  describe → source, describe → target
  same interface id → direct agreement, no proxy
  otherwise →
    ProxyGenerator.generateProxy({ sourceId, targetId, sourceDescription, targetDescription })
      LLM writes a JavaScript handler map + manifest + ProtocolAgreement
    spawn the proxy as a ScriptableAbject (Factory)
    MessageBus.setProxyRoute({ agreementId, sourceId, targetId, proxyId, healthMonitorId })
      copied to every pool worker (proxy:route)
    HealthMonitor.trackConnection(agreementId)
  addDependent → both sides (to hear sourceUpdated)
  connectionEstablished → both sides      (connectionFailed on failure)
```

The Negotiator runs on the main thread so it can set routes on the main bus.
Every bus (main and each pool worker) applies the same route table on send:
a request or event between the two ends, in either direction, goes to the
proxy instead; replies and errors pass so each reaches its requester. Neither
end knows it is proxied.

### 5.4 Self-Healing

```
HealthMonitor (every 5 s):
  connections: errorRate over a 60 s window, once ≥ 10 messages
    errorRate ≥ 10% → Negotiator.renegotiate(agreementId, last 5 errors)
      → ProxyGenerator.regenerateProxy(agreementId, errorContext)
      → kill old proxy, spawn new one, point the route at it; counters reset
  objects: ping every monitored object; after 36 consecutive misses
    → Supervisor 'childFailed' → restart through Factory.respawn

Negotiator, on 'sourceUpdated' from either end (it is a dependent of both):
  re-describe it; renegotiate each proxied connection it is part of,
  reconnect each direct one (a proxy appears if the interfaces now differ)
```

Connection error rates come from the routes themselves: on whichever bus
carries it, the proxy's reply to the source is reported to HealthMonitor as
`recordSuccess`, an error as `recordError`.

### 5.5 Packages: WASM and Script

```
Boot: ingestAllExtensions(factory)
  native/ → extensions/ → ABJECTS_PACKAGE_DIRS → packages.json directories
  wasm: module bytes → content-addressed store (wasm:sha256:<hex>)
  factory.registerPackageType(name, { runtime: 'wasm' | 'script', manifest, source, scope, ... })
  scope 'system': spawned once at boot    scope 'workspace': spawned per workspace
  `replaces: '<Builtin>'`: every spawn of that name resolves to the package

Spawn (Factory):
  wasm source ref → spawnWasmInWorker → new WasmAbject({ manifest, source, ... })
    the worker reads module bytes from the store on disk (bytes never cross threads)
  script package → ScriptableAbject on the pool, owned by `package:<name>` (read-only)

Inside a WasmAbject:
  WasmInstance.create(bytes) → validate exports and ABI version →
    imports: abjects.emit / log / time_ms, WASI shim
  abject_init({ objectId, typeId, data })
  inbound message → abject_handle({ kind: 'message' }) → reply now or later
  guest request { kind: 'request', to: '@Name' | id } → host this.request() →
    result envelope back into abject_handle
  changed / persist / log envelopes → dependents, Registry data, host log
```

### 5.6 Questions to the Person (DialogBroker)

```
Abject.confirm() / Abject.prompt() / PermissionBroker
  → DialogBroker.askPerson({ kind: 'confirm' | 'prompt' | 'options', title, message, ... })
      holds the dialog; heartbeats the asker so its request stays alive
      presenter for the kind draws it (desktop):
        WidgetManager: confirm, prompt      GlobalSettings: options (permissions)
      responders are told (dialogOpened): CliServer → every connected terminal
  ← first answer wins (respond from a presenter or a responder)
      dialogClosed → everyone else drops it
```

`listOpen` lists the open dialogs (`abject questions`, `/questions`). With no
presenter at all (the headless edition) the question still opens and waits
for a terminal. With no DialogBroker, `confirm()` answers no and `prompt()`
answers null: a question nobody could be asked fails closed.

### 5.7 A Goal

```
person → Chat (desktop window or terminal) → route the message:
  converse | remember | clarify | goal
goal → GoalManager.createGoal → ScrumMaster (first scrum):
  review_scrum → poll_team (ask agents; each answers with an approach or PASS)
  → add_task ... → dispatch_scrum: tasks into TupleSpace; each ready one is
    enqueued on its assigned agent (AgentAbject.enqueueTask), dependents as
    their blockers complete
  (a one-step goal can skip planning: quick_dispatch sends it straight to one agent)
each agent runs its queue one task at a time (observe, think, act) → results on the goal
every task terminal → goalReadyForCompletion → next scrum:
  complete_goal | plan more | fail_goal
GoalObserver: warns after 20 minutes without progress, fails the goal after 30
TaskReviewer: reviews finished work, records lessons and patterns in the KnowledgeBase
Chat ← goal result → messageAdded → window and terminals
```

Goals and TupleSpace tuples live in SharedState, so they sync with peers that
share the workspace.

## 6. Key Design Decisions

### 6.1 Why Everything is an Object

One interface for discovery, monitoring and lifecycle. System services can be
replaced (a package with `replaces`), extended or composed like any other
object. The LLM reads a system object's manifest the same way it reads a user
object's.

### 6.2 Why Design by Contract is Always On

In a message-passing system where objects may be written by an LLM, early
failure is what keeps a bad state from spreading. Contracts document the
expected behavior at every boundary and fail at the violation.

### 6.3 Why LLM-Generated Proxies

Objects with different interfaces can still talk. The proxy is a real object:
it has a manifest, receives messages and follows the same protocol. When it
fails, the LLM regenerates it with the errors from the previous attempt.

### 6.4 Why a Display Server and a Thin Client

Objects own surfaces and paint them by message, X11-style; they never touch a
DOM. The backend holds the state, so a client can disconnect, reconnect, or be
a phone across the world and get the same desktop. Rendering each surface as a
textured slab in one WebGL2 scene keeps the browser's text rasterizer for 2D
content and gives one place for depth, motion and 3D content. The same split
is what makes a headless edition possible: take the display layer away and
nothing else changes.

### 6.5 Why Worker Threads, a Script Sandbox and WASM

The main thread stays small (the bus, the registries, the sockets) so routing
never waits behind an agent or a model call; work spreads across worker
threads with their own heaps, and a worker that dies is rebuilt rather than
taking the instance down. Generated code runs as handler maps in a `vm`
context with no host globals: everything it does is a message to a
capability object. Code in other languages runs as WASM, with three host
imports (send a message, log, read the clock) and no filesystem or sockets.

## 7. Extension Points

The step-by-step versions live in `CLAUDE.md` and `docs/`.

- **A global object**: extend `Abject` (full manifest, handlers for every
  method, contracts, a well-known id), export it from `src/index.ts`, register
  its constructor in `server/boot.ts` (a window: `server/ui-layer.ts`) and
  spawn it there at the point its dependencies exist. If it may run on the
  pool, mark it worker-eligible and add it to `workers/core-constructors.ts`
  (a window: `workers/ui-constructors.ts`).
- **A per-workspace object**: register it on the main thread
  (`server/boot.ts` or `server/ui-layer.ts`) and in the matching worker table
  (`workers/core-constructors.ts` or `workers/ui-constructors.ts`), then add
  it to `INFRA_OBJECTS` or `UI_OBJECTS` in `src/objects/workspace-profiles.ts`.
  A missing worker registration fails the spawn on the pool.
- **A capability object**: in `src/objects/capabilities/`, tagged
  `['capability', '<name>']`. Host effects go through PermissionBroker.
- **A package** (WASM or script): `docs/PACKAGES.md`, `docs/WASM_ABI.md`,
  `pnpm forge <dir>`. No constructor registration.
- **An LLM provider**: preferably an abject that sends `registerProvider` to
  the LLM (`docs/LLM_PROVIDERS.md`, `examples/openai-compatible-provider`);
  a built-in one goes in `src/llm/`, in `LLMObject.configure()` and
  `LLMObject.PROVIDER_DESCRIPTORS`.
- **A global setting**: a field in SettingsManager's section type, its
  `schema()` and setter; then show it in GlobalSettings.
- **A transport**: extend `Transport` in `src/network/transport.ts`
  (`connect()`, `disconnect()`, `send()`), following its state machine
  (`disconnected`, `connecting`, `connected`, `error`).
