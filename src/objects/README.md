# src/objects/ - System, Workspace and Agent Objects

Most of the system's Abjects live here: the global system objects (Registry,
Factory, LLM, settings, permissions, the dialog broker), the objects every
workspace gets (its registry, store, goal and job machinery, agents, chat), the
desktop's windows, and the peer, package and web-gateway layers. Each file holds
one Abject class with its manifest, handlers and well-known id, or a small
helper module those classes share. Capability objects (Storage, HttpClient,
ShellExecutor and the rest) are in [capabilities/](capabilities/README.md); the
widget toolkit is in [widgets/](widgets/README.md).

## Architecture

### Editions, threads and scope

One bootstrap serves two editions. `server/boot.ts` registers and spawns the
core objects that run on any instance; `server/ui-layer.ts` adds the display:
the display server (`BackendUI` in `server/backend-ui.ts`, registered as
`UIServer`), WindowManager, WidgetManager, GlobalSettings and every window. The
desktop edition (`server/index.ts`) uses both. The headless edition
(`server/headless.ts`) never imports `ui-layer.ts`, so its registry has no
WidgetManager, UIServer or windows; a person reaches it through the terminal
gateway (`CliServer`, `server/cli-server.ts`). Every non-UI object here must
work when the display objects are absent.

Where an object runs:

- **Pool worker**: every constructor marked worker-eligible (the `workerEligible`
  lists in `server/boot.ts` and `server/ui-layer.ts`), and every ScriptableAbject,
  WasmAbject and Organism. The pool defaults to one worker per core less one,
  at most 8 (`ABJECTS_WORKER_COUNT`; `0` puts everything on the main thread).
- **Main thread**: Registry and Factory (created by `Runtime`), objects that
  hold this process's sockets or state (AuthGate, CliServer, WebGateway,
  HeapMonitor, InstanceInfo), objects that must outlive a worker (Supervisor,
  WorkerRecovery), PeerRouter (a synchronous bus interceptor), and any
  constructor left out of `workerEligible`.
- **Dedicated P2P worker**: Identity, PeerRegistry, RemoteRegistry,
  SignalingRelay, PeerDiscovery and, on a desktop, RemoteUIAccess. With
  `ABJECTS_DEDICATED_WORKERS=0` they run on the main thread.
- **Dedicated UI worker**: the display server (desktop only).

Scope:

- **Global**: one per instance, spawned at boot, most of them under the
  Supervisor and with typeId `{peerId}/system/{Name}`.
- **Workspace**: one per workspace, spawned by WorkspaceManager from the
  workspace's profile, typeId `{peerId}/{workspaceId}/{Name}`.
- **On demand**: spawned by another object when needed (a Chat per
  conversation, its ChatWindow, an MCPBridge per enabled MCP server, user
  objects).

### Spawning an object

Every object comes from a `spawn` request to the Factory (`factory.ts`) carrying
a manifest. The Factory picks the body:

- a wasm source ref (`wasm:sha256:...`) spawns a WasmAbject;
- a registered constructor for the manifest name spawns that class (an
  installed package that `replaces` a built-in takes over its name);
- `source` tagged `organism` spawns an Organism, and any other `source` spawns a
  ScriptableAbject.

When the pool is on and the constructor is worker-eligible, the Factory mints
the id on the main thread and the WorkerPool constructs the object in a worker
from that worker's own constructor table (`workers/core-constructors.ts`, plus
`workers/ui-constructors.ts` on a desktop). Otherwise the object is built in
process. Either way the Factory registers it, with its typeId, in the registry
named by `registryHint` (a workspace's WorkspaceRegistry) or in the global
Registry. A constructor's key is the name used to spawn it, and the object
registers under its own manifest name: `LLMObject` registers as `LLM`.

Objects find each other through their registry: `discoverDep(name)` and
`requireDep(name)` on Abject. A WorkspaceRegistry answers from its own objects
and falls back to the global Registry on a miss, so a workspace object reaches
its workspace's services and the global ones by the same call.

### Building a workspace

WorkspaceManager (global) owns the workspace list. The bootstrap sends it
`boot` once it is spawned, and `createWorkspace` makes new ones. For each
workspace it:

1. spawns a WorkspaceRegistry, registered in itself as `Registry`, with the
   global Registry registered in it as `SystemRegistry` and set as its fallback;
2. spawns the workspace's Storage and FileSystem (capabilities, spawned
   explicitly);
3. spawns the profile's objects in dependency order, then the workspace-scope
   packages that join the profile, each with `registryHint` set to the new
   registry;
4. asks AbjectStore to `restoreAll`, which brings back the workspace's user
   objects.

A profile (`workspace-profiles.ts`, [docs/WORKSPACE_PROFILES.md](../../docs/WORKSPACE_PROFILES.md))
names a workspace's objects. `default` is `INFRA_OBJECTS` plus `UI_OBJECTS`;
`service` is AbjectStore, SharedState, Console, CollectionStore and WebExposure;
more can be defined in `$ABJECTS_DATA_DIR/profiles.json`. INFRA objects run
whenever the workspace is up, shown or not. UI objects wait until the workspace
is first shown, and are skipped when InstanceInfo reports no display.
`WORKSPACE_OBJECT_REQUIRES` lists what each object needs at init; a profile
missing a requirement is refused.

An object learns its workspace by asking the registry it was spawned into:
`getWorkspaceId` on WorkspaceRegistry (AbjectStore, ChatManager, Chat and
WebExposure do this), so the answer depends on nothing that draws.
WorkspaceManager's `getWorkspaceForObject` answers the same question for any
object id.

### How agents get work

An agent is an Abject that registers with its workspace's AgentAbject
(`registerAgent`) and answers `agentObserve` and `agentAct`. AgentAbject runs
the observe-think-act loop, the LLM conversation and a task queue per agent.
Chat, ScrumMaster, ObjectCreator, ObjectAgent, WebAgent, SkillAgent,
ExternalCreator, AgentCreator and TaskReviewer all register this way.

A request becomes work like this:

1. Chat turns what the person asks into a goal (`GoalManager.createGoal`).
2. ScrumMaster hears `goalCreated` and runs a scrum as a task of its own:
   `review_scrum` loads the goal, `poll_team` sends `ask` to the registered
   agents (from `AgentAbject.listAgents`) to learn who can do what, `add_task`
   stages tasks assigned to agents, and `dispatch_scrum` commits the round. A
   one-step goal can go straight to one agent with `quick_dispatch`.
3. Committing adds each task to GoalManager, which keeps it as a tuple in
   TupleSpace (namespaced per top-level goal, synced to peers through
   SharedState). ScrumMaster pushes each task whose dependencies are done to
   its agent with `AgentAbject.enqueueTask`; dependents are enqueued as their
   upstream tasks finish.
4. AgentAbject reports each result to GoalManager (`completeTask` /
   `failTask`). When every task in the round is terminal, GoalManager emits
   `goalReadyForCompletion` and ScrumMaster runs the next scrum: `complete_goal`,
   more tasks, or `fail_goal`.
5. TaskReviewer reviews the finished goal afterwards and writes what was
   learned to the KnowledgeBase. GoalObserver fails a goal that has made no
   progress for 30 minutes.

The ask protocol underlies all of it. Every Abject answers `describe` (its
manifest) and `ask` (a plain-language question, answered by the LLM from the
object's manifest and the guidance it adds), and the Registry's `ask` answers
"which object can do X" from its catalog. That is how agents, ScrumMaster and
ObjectCreator learn what an object or a teammate can do.

### How a question reaches the person

DialogBroker (`dialog-broker.ts`, global) owns every question to a person. An
asker sends `askPerson` with a kind (`confirm`, `prompt` or `options`). The
broker holds the call open with a deferred reply and a heartbeat, so the asker
waits as long as the person takes, and the first surface to answer decides:

- **Presenters** draw dialogs of the kinds they registered for on a desktop,
  one at a time: WidgetManager for `confirm` and `prompt` (it builds a
  ModalDialog), and GlobalSettings for `options` (the permission questions).
  The broker sends them `presentDialog` and `dismissDialog`.
- **Responders** are remote surfaces; CliServer is the one. They get
  `dialogOpened` and `dialogClosed`, can `listOpen`, and can `respond` to any
  open dialog.

The bootstrap registers both (`registerPresenter`, `registerResponder`) and
sends `seal` before WorkspaceManager spawns, so no user object can register
itself and answer its own question. Only the asker can `cancel` its dialog. On
a headless instance there are no presenters, and a question waits for a
terminal. Abjects ask through `this.confirm()` and `this.prompt()` on the
Abject base class, which fail closed: no broker, a refusal or a withdrawn
question returns `false` (confirm) or `null` (prompt).

### How permissions are decided

PermissionBroker (`permission-broker.ts`, global) decides what the host
capabilities may do. At start it claims the permissions authority on
ShellExecutor, HostFileSystem, HttpClient and StreamClient (first caller wins);
ShellExecutor, HostFileSystem and StreamClient send it `requestPermission`. It
decides in this order:

1. standing rules, protected paths and remembered deny decisions;
2. the external project's autonomy (`ask`, `read`, `edit` or `full`, held by
   ExternalProjectRegistry; an untrusted project counts as `ask`), capped by
   the calling workspace's access mode: `local` keeps it, `shared` caps it at
   `edit`, `public` at `ask`, and an object exposed to remote peers gets `ask`;
3. the prompt mode, a global setting (SettingsManager section `permissions`):
   `ask` (the default) puts the question to the person; `allow` allows it once
   without asking, without the host's credentials, and still asks about a
   dangerous or unreadable command; `deny` refuses without asking.

A question goes to DialogBroker as an `options` dialog and waits indefinitely:
the broker's heartbeat keeps the request alive, and the 30-minute timer fires
only if the broker itself is gone. Concurrent questions are all open at once (a
terminal can list and answer any of them; the desktop shows them one at a
time). Autonomy approvals are budgeted at 200 per caller; the next request
takes the asking path (and its prompt mode), which resets the count.
Rule changes (`addRule`, `updateRule`, `removeRule`) need the person's approval
through a dialog in every mode (refused outright in `deny`), and an update or
removal is refused if the rule changed while the question was open.
`takeTheWheel` puts every project back to `ask` and drops session grants and
allow rules; deny rules stay.

SettingsManager owns the global settings (sections `ai`, `auth`, `filesystem`,
`shell`, `web`, `permissions`). It loads them from global Storage,
applies them (LLM `configure`, AuthGate `updateAuth`, permissions and the prompt
mode through PermissionBroker), validates and persists every change, and
emits `settingsChanged`. It follows the LLM object's `providersChanged`, so a
provider an abject registers after boot can be routed to at once (and a saved
route to one that is away is kept). GlobalSettings is its window. Writes are taken from
GlobalSettings, CliServer, and abjects in a local workspace this peer hosts;
only GlobalSettings reads secrets back. AuthGate (`server/auth-gate.ts`) owns
the login and sessions every socket checks.

## Files

Runs: **global**, **workspace** (`INFRA_OBJECTS`), **workspace UI**
(`UI_OBJECTS`, desktop only) or **on demand**, then where: **worker** (pool
worker), **main** (main thread) or **P2P** (dedicated P2P worker). **desktop**
marks an object that exists only in the desktop edition (every workspace UI
object does too). **module** is a plain module with no Abject. Global windows
sit with the objects they show; every per-workspace window is under
Per-workspace UI.

### Global system objects

| File | Object | Runs | Role |
|------|--------|------|------|
| `registry.ts` | Registry | global, main | Directory of objects by id, name, interface, capability, tags and typeId; `ask`, `findCapable`, `search` for discovery; filters what remote callers see |
| `factory.ts` | Factory | global, main | Spawns, kills, clones and respawns objects; picks constructor, ScriptableAbject, Organism or WasmAbject; places worker-eligible types in the pool |
| `llm-object.ts` | LLM (class `LLMObject`) | global, worker | Provider-agnostic LLM service: `complete`, `stream`, tier routing, built-in and abject-backed providers, call ledger and spend, speech |
| `proxy-generator.ts` | ProxyGenerator | global, worker | LLM-generated protocol-translation proxies (JavaScript handler maps spawned as ScriptableAbjects) for the Negotiator |
| `object-catalog.ts` | ObjectCatalog | global, worker | Cached snapshot of every registry source (system, local and remote workspaces), refreshed on timers, for browsers and agents |
| `cassette-recorder.ts` | CassetteRecorder | global, worker | Records HttpClient exchanges per caller typeId as replayable evidence |
| `instance-info.ts` | InstanceInfo | global, main | Version, readiness, uptime, platform, edition and `display` for abjects; the same report backs `GET /healthz` |
| `heap-monitor.ts` | HeapMonitor | global, main | Watches every isolate's heap (pool workers report samples) and logs regime changes |
| `worker-recovery.ts` | WorkerRecovery | global, main | Told when a pool worker dies; has WorkspaceManager, SkillRegistry and the Supervisor rebuild what it hosted |
| `app-updater.ts` | AppUpdater | global, desktop (packaged app), main | Downloads and installs app updates; GlobalSettings' Updates tab drives it |

### Workspaces and per-workspace infrastructure

| File | Object | Runs | Role |
|------|--------|------|------|
| `workspace-manager.ts` | WorkspaceManager | global, worker | Workspace lifecycle (create with a profile, delete, switch, access mode, exposure, invite links, joined mirrors); spawns each workspace's objects |
| `workspace-profiles.ts` | (module) | module | `INFRA_OBJECTS`, `UI_OBJECTS`, `WORKSPACE_OBJECT_REQUIRES`, the `default` and `service` profiles, `profiles.json` loading |
| `workspace-registry.ts` | WorkspaceRegistry | workspace (spawned first), worker | The workspace's Registry: chains to the global one on a miss, `listLocal` for what the workspace owns, `getWorkspaceId`, remote entries and sharing policy |
| `abject-store.ts` | AbjectStore | workspace, worker | Persists user objects' source and data, restores them at boot, keeps 10 prior source versions, holds script packages' data |
| `theme.ts` | Theme (class `ThemeAbject`) | workspace, worker | The workspace's UI theme and presets; broadcasts `themeChanged` |
| `notification-center.ts` | NotificationCenter | workspace, worker | `notify` events with history; announces each one (terminals show them) and draws toasts where there is a desktop |
| `job-manager.ts` | JobManager | workspace, worker | Runs submitted code jobs in FIFO queues and broadcasts their progress |
| `scheduler.ts` | Scheduler | workspace, worker | Time-based entries (`at T do X`) that submit jobs to JobManager; persisted |
| `trigger-manager.ts` | TriggerManager | workspace, worker | Declarative event rules (`when E on A, send Y to B`), addressed by registered name; persisted |
| `collection-store.ts` | CollectionStore | workspace, worker | SQLite-backed collections (`<dataDir>/ws-<id>/collections.db`) with change events and read-only SQL |

The KnowledgeBase in `INFRA_OBJECTS` is the C++/WASM package in `native/knowledge-base`; there is no TypeScript KnowledgeBase here. Storage, FileSystem, Console, SharedState, FileTransfer and MediaStream are capabilities.

### Agents and goal machinery

| File | Object | Runs | Role |
|------|--------|------|------|
| `agent-abject.ts` | AgentAbject | workspace, worker | Agent runtime: registration, observe-think-act loop, per-agent task queues (`enqueueTask`, `startTask`), delegation, task status and cancellation |
| `scrum-master.ts` | ScrumMaster | workspace, worker | Plans each goal as a sprint of scrums: review, poll the team, stage, dispatch, complete or fail; `quick_dispatch` for one-step goals |
| `goal-manager.ts` | GoalManager | workspace, worker | The goal tree, tasks, results, budgets and scratchpad; emits `goalCreated` and `goalReadyForCompletion`; shares goals with peers through SharedState |
| `tuple-space.ts` | TupleSpace | workspace, worker | Task tuples over SharedState (last writer wins), one namespace per top-level goal; a stale claim becomes reclaimable after 5 minutes |
| `goal-observer.ts` | GoalObserver | workspace, worker | Watchdog: sweeps goals every minute, fails one with no progress for 30 minutes |
| `task-session.ts` | TaskSession | workspace, worker | Durable task sessions: checkpoint, resume, fork, reconcile, result delivery |
| `task-reviewer.ts` | TaskReviewer | workspace, worker | Reviews finished work into the KnowledgeBase, judges which knowledge helped, proposes skills, and writes the workspace's patterns |
| `agent-evaluation.ts` | AgentEvaluation | workspace, worker | Evaluation runs of an agent (driver) checked by an independent verifier, with durable reports |
| `agent-creator.ts` | AgentCreator | workspace, worker | Advisory agent for designing agents, schedules and watchers; answers through `ask` and declines tasks |
| `object-creator.ts` | ObjectCreator | workspace, worker | Creates and modifies Abjects through one ReAct loop whose primitive is `call(target, method, payload)` |
| `object-agent.ts` | ObjectAgent | workspace, worker | Does tasks by discovering objects (Registry `ask`) and sending them `ask`, `describe` and calls |
| `web-agent.ts` | WebAgent | workspace, worker | Browser agent over the WebBrowser capability: page observation, screenshots, real input |
| `skill-agent.ts` | SkillAgent | workspace, worker | Does tasks with the enabled skills, using ShellExecutor, HttpClient, HostFileSystem, WebSearch and WebFetch |
| `external-creator.ts` | ExternalCreator | workspace, worker | On-disk authoring agent for registered external projects (read, write, edit, bash, grep, find, ls; the project's own checks) |
| `external-project-registry.ts` | ExternalProjectRegistry | workspace, worker | Named host directories with their commands, trust and autonomy; adds roots to HostFileSystem's allowed paths |

### Chat

| File | Object | Runs | Role |
|------|--------|------|------|
| `chat.ts` | Chat | on demand (ChatManager), worker | One conversation as data: routes requests into goals, keeps the transcript, emits `messageAdded`; draws nothing, and `show` returns false with no display |
| `chat-window.ts` | ChatWindow | on demand (Chat `show`), desktop, worker | The desktop view of one Chat: bubbles, activity, composer; sends what the person does back to Chat |
| `chat-manager.ts` | ChatManager | workspace, worker | The conversation roster and Chat lifecycle: `newConversation({ show })`, `openConversation` (no window, as a terminal does), `showConversation` |

ChatBrowser, the roster window, is under Per-workspace UI.

### Settings, permissions and dialogs

| File | Object | Runs | Role |
|------|--------|------|------|
| `settings-manager.ts` | SettingsManager | global, worker | Owns the global settings: load, validate, persist, apply, `settingsChanged`; presets; admits writers |
| `permission-broker.ts` | PermissionBroker | global, worker | Decides capability permissions by rules, project autonomy, workspace access mode and prompt mode; asks through DialogBroker |
| `dialog-broker.ts` | DialogBroker | global, worker | Holds every open question to a person; presenters and responders answer; sealed at boot |
| `global-settings.ts` | GlobalSettings | global, desktop, worker | The Settings window over SettingsManager (plus Skills, Packages, Updates tabs); presenter for permission dialogs; opens itself on first boot |
| `modal-dialog.ts` | ModalDialog | on demand (WidgetManager), desktop, in WidgetManager's thread | Draws one confirm or prompt dialog for WidgetManager and reports the answer |

### Skills, MCP and credentials

| File | Object | Runs | Role |
|------|--------|------|------|
| `skill-registry.ts` | SkillRegistry | global, worker | SKILL.md skills in the data directory's `skills/`: scan, install, enable, config; spawns an MCPBridge per enabled MCP server |
| `mcp-bridge.ts` | MCPBridge | on demand (SkillRegistry), worker | Owns one MCP server's transport and exposes its tools as methods (`callTool`, `listTools`, `readResource`) |
| `mcp-registry-client.ts` | MCPRegistryClient | global, worker | Read-only client for the official MCP registry, cached 24 hours |
| `clawhub-client.ts` | ClawHubClient | global, worker | Client for clawhub.ai skills; downloads bundles for SkillRegistry |
| `secrets-vault.ts` | SecretsVault | global, worker | Encrypted credentials for skills and MCP servers; values leave only through `bindEnv` and owner-gated `reveal` |
| `oauth-helper.ts` | OAuthHelper | global, worker | OAuth 2.0 + PKCE flow with a localhost callback; tokens go to SecretsVault |
| `skill-browser.ts` | SkillBrowser | global, desktop, worker | Window for installed skills |
| `catalog-browser.ts` | CatalogBrowser | global, desktop, worker | Window to browse and install MCP servers and ClawHub skills through SkillRegistry |

### Peer network and sharing

| File | Object | Runs | Role |
|------|--------|------|------|
| `identity.ts` | Identity (class `IdentityObject`) | global, P2P | ECDSA P-256 signing and ECDH P-256 key agreement; keys persisted via Storage |
| `peer-registry.ts` | PeerRegistry | global, P2P | Contacts, WebRTC connections via signaling, fixed signaling and peer admission, blocking, introductions |
| `peer-discovery.ts` | PeerDiscovery (class `PeerDiscoveryObject`) | global, P2P | Gossip discovery: peer exchange, find-peer floods, speculative mesh links |
| `signaling-relay.ts` | SignalingRelay (class `SignalingRelayObject`) | global, P2P | Relays SDP and ICE between peers over data channels when the signaling server is down |
| `remote-registry.ts` | RemoteRegistry | global, P2P | Finds objects on connected peers, with a 5-minute cache |
| `remote-ui-access.ts` | RemoteUIAccess | global, desktop, P2P | Pairs remote browsers (QR token) and attaches them to the display over encrypted WebRTC |
| `workspace-share-registry.ts` | WorkspaceShareRegistry | global, worker | Shared-workspace catalogs, multi-hop workspace discovery, join and leave, members |
| `peer-network.ts` | PeerNetwork | global, desktop, worker | Window for identity, signaling servers and contacts |
| `workspace-browser.ts` | WorkspaceBrowser | global, desktop, worker | Window to browse peers' discovered workspaces |
| `workspace-collaborator-inspector.ts` | WorkspaceCollaboratorInspector | global, desktop, worker | Window over joined and shared workspaces: members, presence, measured latency, catalog, shared goals |

### Packages and scripting

| File | Object | Runs | Role |
|------|--------|------|------|
| `packages.ts` | Packages | global, worker | Lists installed packages, edits `packages.json` (enable, directories, settings), serves `getSettings` and system-scope package data |
| `scriptable-abject.ts` | ScriptableAbject | on demand, worker | Abject whose behavior is a JavaScript handler map run in a sandboxed vm; emits `sourceUpdated` |
| `wasm-abject.ts` | WasmAbject | on demand, worker | Host side of [docs/WASM_ABI.md](../../docs/WASM_ABI.md): forwards messages to a WebAssembly module referenced by `wasm:sha256:` |
| `organism.ts` | Organism | on demand, worker | Composite Abject with its own internal registry; organelles (ScriptableAbjects) behind one interface |

### Web gateway

| File | Object | Runs | Role |
|------|--------|------|------|
| `web-gateway.ts` | WebGateway | global, main | The one inbound HTTP listener: routes, generated interfaces, OpenAPI, method calls, `http`-mode handlers, API tokens. Switched on, moved and given tokens only by its window, PeerNetwork and abjects in a local workspace; a workspace's routes come only from its own WebExposure |
| `web-exposure.ts` | WebExposure | workspace, main | The workspace's web whitelist (per abject access level and methods), pushed to WebGateway |
| `web-gateway-browser.ts` | WebGatewayBrowser | global, desktop, main | Window to turn the gateway on or off, see routes, manage tokens |

### Desktop shell and global windows

| File | Object | Runs | Role |
|------|--------|------|------|
| `widget-manager.ts` | WidgetManager | global, desktop, worker | Spawns windows and widgets (their tree lives in its worker); window effects, widget types, Exposé; presenter for confirm and prompt |
| `window-manager.ts` | WindowManager | global, desktop, worker | Window policy: z-order, drag, resize; registers each workspace's Taskbar |
| `scene-library.ts` | SceneLibrary | global, desktop, worker | Named 3D material and look presets, pushed to UIServer |
| `sidebar.ts` | Sidebar | global, desktop, worker | The dock window and its three sections (System, Spaces, Abjects) |
| `global-toolbar.ts` | GlobalToolbar | global, desktop, worker | The dock's System section: Settings, PeerNetwork, and abjects tagged `launcher` |
| `workspace-switcher.ts` | WorkspaceSwitcher | global, desktop, worker | The dock's Spaces section; lives outside workspaces so a switch never hides it |
| `object-browser.ts` | ObjectBrowser | global, desktop, worker | Four-pane object explorer: scope, kinds, methods, detail with send-message |
| `method-inspector.ts` | MethodInspector | global, desktop, worker | Opens on a window's `?` button: the owner's methods, detail and a send form |
| `process-explorer.ts` | ProcessExplorer | global, desktop, worker | Table of running objects with state, worker placement, stop and restart |
| `llm-monitor.ts` | LLMMonitor | global, desktop, worker | View of the LLM call ledger: active, history, stats, map |

### Per-workspace UI

| File | Object | Runs | Role |
|------|--------|------|------|
| `settings.ts` | Settings | workspace UI, worker | Workspace settings: General, Access, Web and Appearance tabs |
| `taskbar.ts` | Taskbar | workspace UI, worker | The dock's Abjects section: launch rows and minimized windows |
| `command-palette.ts` | CommandPalette (class `CommandPaletteAbject`) | workspace UI, worker | Ctrl-K launcher over objects that have `show` |
| `window-switcher.ts` | WindowSwitcher (class `WindowSwitcherAbject`) | workspace UI, worker | Ctrl+backtick switcher over open windows |
| `app-explorer.ts` | AppExplorer | workspace UI, worker | Three-pane explorer of object kinds and instances, local or remote |
| `abject-editor.ts` | AbjectEditor | workspace UI, worker | Source editor for ScriptableAbjects, with History from AbjectStore |
| `chat-browser.ts` | ChatBrowser | workspace UI, worker | Conversation roster window over ChatManager |
| `goal-browser.ts` | GoalBrowser | workspace UI, worker | Goal, task and progress tree over GoalManager |
| `job-browser.ts` | JobBrowser | workspace UI, worker | Job status over JobManager |
| `agent-browser.ts` | AgentBrowser | workspace UI, worker | Agents, watchers (TriggerManager rules), sessions and a map |
| `knowledge-browser.ts` | KnowledgeBrowser | workspace UI, worker | Search and manage the KnowledgeBase, including the pattern map |
| `scheduler-browser.ts` | SchedulerBrowser | workspace UI, worker | Schedules over Scheduler, with the 24-hour dial |
| `external-project-browser.ts` | ExternalProjectBrowser | workspace UI, worker | External projects: add, trust, autonomy, checks |
| `data-browser.ts` | DataBrowser | workspace UI, worker | CollectionStore collections and read-only SQL |
| `file-manager.ts` | FileManager | workspace UI, worker | Browse, upload and remove files in the workspace FileSystem |
| `file-viewer.ts` | FileViewer | workspace UI, worker | Preview of images and text from the workspace FileSystem |
| `web-browser-viewer.ts` | WebBrowserViewer | workspace UI, worker | Live view of WebBrowser pages, with human takeover (`requestControl`) |
| `peers-viewer.ts` | PeersViewer | workspace UI, worker | Peers in the active shared workspace |

### Utilities

| File | Role |
|------|------|
| `exposure-selectors.ts` | The one "may a remote caller see this object?" predicate, by name and typeId; shared by Registry and WorkspaceShareRegistry |
| `host-local-objects.ts` | Names of the host's own objects that a shared workspace never shares (WorkspaceManager, WorkspaceShareRegistry, AppExplorer) |
| `goal-tree.ts` | UI-free row model for goal progress, shared by GoalBrowser, ChatWindow and WidgetManager |
| `source-diff.ts` | SEARCH/REPLACE block format with tolerant matching (ObjectCreator, JobManager) |
| `mcp-input-validation.ts` | Validates MCP tool arguments against each tool's JSON Schema before the call (MCPBridge) |
| `ui-kit.ts` | Pure style, text and scene helpers for system windows |
| `dock-style.ts` | Shared styling for the dock's section providers (GlobalToolbar, WorkspaceSwitcher, Taskbar) |
| `data-dir-layout.ts` | Where FileSystem and CollectionStore keep data in the data directory (`ws-<id>/files`, `ws-<id>/collections.db`), and the one-time move of what older builds left under `~/.abject` |

### Tests

`*.test.ts` files sit beside the code they test and run with `pnpm test`
(node:test through tsx). `agent-system.*.test.ts` cover the agent runtime and
also run alone with `pnpm test:agents`; `agent-system.native-knowledge.ts` is
their fixture, hosting the native KnowledgeBase package through WasmAbject. The
rest are named after what they cover, one object (`scrum-master.synthesis`,
`settings-manager.writers`, `web-gateway.http-mode`) or a cross-object behavior
(`registry-scoping.integration`, `workspace-share-registry.p1p3`).

## Adding a Per-Workspace Abject

1. **Write the class** in `src/objects/` (a capability goes in `capabilities/`):
   extend `Abject` with a full manifest (interface, methods, parameters,
   returns, descriptions), register a handler for every method in
   `setupHandlers()` with `this.on(...)`, use `require` / `ensure` /
   `invariant` from `src/core/contracts.ts`, override `checkInvariants()`
   calling `super.checkInvariants()` first, and export a well-known id
   (`export const MY_THING_ID = 'abjects:my-thing' as AbjectId`).
2. **Register the constructor on the main thread**:
   `runtime.objectFactory.registerConstructor('MyThing', () => new MyThing())`
   in `server/boot.ts`. An object with windows registers in `registerConstructors`
   in `server/ui-layer.ts` instead, so the headless edition never loads it.
3. **Register it in the worker table**: `map.set('MyThing', () => new MyThing())`
   in `workers/core-constructors.ts`, or `workers/ui-constructors.ts` for an
   object with windows.
4. **Mark it worker-eligible**: add the name to the `workerEligible` list in
   `server/boot.ts`, or the UI layer's `workerEligible` in `server/ui-layer.ts`.
   An object left out runs on the main thread; leave it out only when it holds
   this process's sockets or state.
5. **Add it to a spawn list** in `src/objects/workspace-profiles.ts`, after
   everything it needs at init: `INFRA_OBJECTS` for an object without windows
   (spawned whenever the workspace is up), `UI_OBJECTS` for one with windows
   (spawned when the workspace is first shown, and only where there is a
   display). If it `requireDep`s other per-workspace objects at init, list them
   in `WORKSPACE_OBJECT_REQUIRES`. This puts it in the `default` profile; the
   `service` profile and `profiles.json` profiles name their objects explicitly.
6. **Export it** from `src/index.ts`.

**Critical**: the main thread and the worker table must both have the
constructor. With the main-thread registration alone, the spawn fails in the
worker (workers are on by default); the Factory logs it, and WorkspaceManager
skips the object and carries on, so the workspace comes up without it.

A non-UI Abject must not import window or widget modules (WidgetManager,
WindowManager, ModalDialog, ChatWindow, GlobalSettings, Sidebar, Taskbar, any
`*-browser.ts` or `*-viewer.ts`, the widgets). `pnpm bind` runs
`scripts/headless-bundle-check.mjs`, which fails the build and prints the
import chain. Reach display objects by message and handle their absence, ask
InstanceInfo (`getInfo`, field `display`) whether there is a display, and ask
the person through `this.confirm()` / `this.prompt()`, which reach a window or
a terminal through DialogBroker.

## Adding a Global Abject

Steps 1 to 4 and 6 are the same. Instead of step 5, spawn it in `bootServer()`
in `server/boot.ts`, after the objects it depends on:
`await supervisedSpawn('MyThing', 'permanent', systemTypeId('MyThing'))`. A
global window spawns in `spawnGlobalUi` in `server/ui-layer.ts`.

## Gotchas

- **Ids are ephemeral.** An object gets a new AbjectId on every spawn and
  restore; its registered name and typeId survive. Key anything persistent or
  shared by name or typeId, as `exposure-selectors.ts`, WebExposure,
  TriggerManager and CassetteRecorder do.
- **Constructor key and registered name can differ.** The Factory spawns by the
  constructor key and registers the object under its manifest name (`LLMObject`
  is discovered as `LLM`).
- **Main thread by omission.** A constructor missing from `workerEligible` runs
  on the main thread, which is kept for the bus, transports and PeerRouter.
- **Timers.** Use `this.setTimer`, `this.setRecurringTimer` and
  `this.cancelTimer` for any timer that sends, requests or emits. A raw timer
  that fires after `stop()` throws a contract violation with no caller to catch
  it, inside a worker shared with other objects.
- **`onStop`.** The object is already stopped: `send()` works, `request()`
  rejects at once. Notify with events.
- **Dialog surfaces are sealed.** Only the bootstrap registers presenters and
  responders. A workspace object asks; it never answers.
- **Settings writers are checked.** SettingsManager takes writes from
  GlobalSettings, CliServer and abjects in a local workspace this peer hosts. A
  user object named like a system object carries a namespaced typeId and is
  refused.
- **Background workspaces run.** INFRA objects are up for every workspace,
  shown or not; only UI objects wait for the first switch.
- **Boot work outside `onInit`.** The bootstrap sends WorkspaceManager `boot`
  as a separate request after spawning it, because booting workspaces during
  `onInit` would deadlock the Factory (see `server/boot.ts`).

## Related

- [capabilities/README.md](capabilities/README.md): capability objects (Storage, HttpClient, ShellExecutor, SharedState, WebBrowser, ...)
- [widgets/README.md](widgets/README.md): the canvas widget toolkit
- [../core/README.md](../core/README.md): the Abject base class, contracts, messages, introspection
- [../runtime/README.md](../runtime/README.md): MessageBus, mailboxes, WorkerPool, Supervisor
- [../protocol/README.md](../protocol/README.md): Negotiator and HealthMonitor
- [../network/README.md](../network/README.md): PeerRouter and transports
- [../llm/README.md](../llm/README.md): LLM providers
- [../sandbox/README.md](../sandbox/README.md): packages and the WASM host
- [../ui/README.md](../ui/README.md): the browser client and 3D compositor
- [../../server/README.md](../../server/README.md): bootstrap and editions
- [../../workers/README.md](../../workers/README.md): worker entry points and constructor tables
- [../../native/knowledge-base/README.md](../../native/knowledge-base/README.md): the KnowledgeBase
- [../../docs/WORKSPACE_PROFILES.md](../../docs/WORKSPACE_PROFILES.md), [../../docs/PACKAGES.md](../../docs/PACKAGES.md), [../../docs/WASM_ABI.md](../../docs/WASM_ABI.md), [../../docs/WEB_GATEWAY.md](../../docs/WEB_GATEWAY.md), [../../docs/LLM_PROVIDERS.md](../../docs/LLM_PROVIDERS.md)
