# src/objects/ - System Objects

System-level objects providing core services. Each is an Abject with a well-defined manifest and message interface.

## Object Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        FOUNDATION                               │
│  Registry ←──── Factory ────→ LLMObject ────→ UIServer          │
│     ↑              ↑                              ↑             │
│     │              │                              │             │
│  ┌──┴──────────────┴──────────────────────────────┴──────────┐  │
│  │                     MessageBus                            │  │
│  └──┬──────────┬──────────┬──────────┬──────────┬────────────┘  │
│     │          │          │          │          │               │
│  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐  ┌──┴──────────┐   │
│  │Code  │  │Agent │  │ UI   │  │Work- │  │  P2P /       │   │
│  │Gen   │  │System│  │Shell │  │space │  │  Identity     │   │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Foundation

Core services that everything else depends on.

| File | Class | Well-known ID | Description |
|------|-------|---------------|-------------|
| `registry.ts` | `Registry` | `REGISTRY_ID` | Multi-indexed directory for object discovery (by ID, interface, capability, name, tags) |
| `factory.ts` | `Factory` | `FACTORY_ID` | Object lifecycle: spawn from manifest/code, kill, register constructors |
| `llm-object.ts` | `LLMObject` | `LLM_OBJECT_ID` | Provider-agnostic LLM service (Anthropic, OpenAI, Ollama). Methods: `complete`, `generateCode`, `analyze` |
| `ui-server.ts` | `UIServer` | `UI_SERVER_ID` | X11-style display server: surfaces, draw commands, input routing, focus management |

## Code Generation & Protocol

Objects that create and adapt other objects using the LLM.

| File | Class | Well-known ID | Description |
|------|-------|---------------|-------------|
| `object-creator.ts` | `ObjectCreator` | `OBJECT_CREATOR_ID` | Natural language → Abject. Multi-phase LLM pipeline with dependency discovery |
| `proxy-generator.ts` | `ProxyGenerator` | `PROXY_GENERATOR_ID` | LLM-generated protocol translation proxies (JavaScript handler maps) |
| `scriptable-abject.ts` | `ScriptableAbject` | `SCRIPTABLE_ABJECT_ID` | Runtime-editable Abject with JavaScript handler source. Emits `sourceUpdated` event |
| `composite-abject.ts` | `CompositeAbject` | `COMPOSITE_ABJECT_ID` | Symbogenesis: encapsulates multiple child Abjects behind a single ID with routing table |

## Agent System

Autonomous agent runtime and conversational interfaces.

| File | Class | Description |
|------|-------|-------------|
| `agent-abject.ts` | `AgentAbject` | Concrete agent runtime: observe→think→act state machine, LLM conversations, JSON action parsing, job orchestration |
| `chat.ts` | `Chat` | Conversational LLM agent UI. Registers with AgentAbject for task submission |
| `web-agent.ts` | `WebAgent` | Autonomous browser agent (think-act-observe loop). Integrates with WebBrowser capability |

## UI Shell

Window management, widget infrastructure, and persistent chrome.

| File | Class | Description |
|------|-------|-------------|
| `widget-manager.ts` | `WidgetManager` | Factory for spawning WindowAbject and widget instances (createLabel, createButton, etc.) |
| `window-manager.ts` | `WindowManager` | Centralized window behavior policy: z-order, drag, resize. Delegates display ops to UIServer |
| `taskbar.ts` | `Taskbar` | Per-workspace bottom bar with launch buttons and minimized window restore |
| `global-toolbar.ts` | `GlobalToolbar` | System-level panel below WorkspaceSwitcher with quick-access buttons |
| `theme.ts` | `ThemeAbject` | Stores active UI theme, broadcasts changes. Persisted via Storage |

## Browsing & Editing

Discovery, inspection, and editing tools.

| File | Class | Description |
|------|-------|-------------|
| `registry-browser.ts` | `RegistryBrowser` | Browse registered objects, interfaces, and methods (3-level navigation) |
| `object-manager.ts` | `ObjectManager` | Process manager table: running objects with state, worker placement, stop/restart |
| `abject-editor.ts` | `AbjectEditor` | Source editor for ScriptableAbjects with save/cancel and AI-assisted editing |
| `abject-store.ts` | `AbjectStore` | Persists user-created scriptable abject snapshots to Storage, restores on startup |
| `job-manager.ts` | `JobManager` | Universal headless job execution (sequential FIFO queues, broadcasts events) |
| `job-browser.ts` | `JobBrowser` | UI for viewing job execution status in real-time |
| `web-browser-viewer.ts` | `WebBrowserViewer` | Visual browser monitor showing tabs and live screenshots (polls every 3s) |

## Workspace Management

Multi-workspace isolation and sharing.

| File | Class | Description |
|------|-------|-------------|
| `workspace-manager.ts` | `WorkspaceManager` | Orchestrates workspace lifecycle: create, delete, switch, spawn per-workspace objects |
| `workspace-registry.ts` | `WorkspaceRegistry` | Per-workspace Registry that chains to global registry on discovery miss |
| `workspace-switcher.ts` | `WorkspaceSwitcher` | Global chromeless window for switching workspaces (outside all workspaces to avoid deadlock) |
| `workspace-browser.ts` | `WorkspaceBrowser` | Browse discovered remote workspaces from connected peers |
| `workspace-share-registry.ts` | `WorkspaceShareRegistry` | Manages workspace sharing metadata and peer discovery (transitive multi-hop) |
| `settings.ts` | `Settings` | Per-workspace configuration UI (General and Access tabs) |
| `global-settings.ts` | `GlobalSettings` | Global LLM API key configuration. Auto-shows on first boot if no keys present |

## P2P / Identity

Cryptographic identity and peer-to-peer networking.

| File | Class | Description |
|------|-------|-------------|
| `identity.ts` | `IdentityObject` | ECDSA P-256 signing + ECDH P-256 key exchange. Keys persisted via Storage |
| `peer-registry.ts` | `PeerRegistry` | Contact management, WebRTC connection orchestration via signaling |
| `peer-network.ts` | `PeerNetwork` | Modal window for managing identity, signaling servers, and contacts |
| `remote-registry.ts` | `RemoteRegistry` | Distributed object discovery across connected peers with 5-min TTL cache |

## Common Pattern

Every object follows the same structure:
1. Constructor defines manifest with full `InterfaceDeclaration`
2. `setupHandlers()` registers `this.on('method', handler)` for each method
3. Dependencies injected via `set*()` methods or discovered via Registry
4. Well-known ID exported as `const FOO_ID = 'abjects:foo' as AbjectId`

## Subdirectories

- `capabilities/` — 8 built-in capability objects (HTTP, storage, timer, clipboard, console, filesystem, web-browser, web-parser)
- `widgets/` — Canvas widget toolkit (20 files: windows, layouts, input/display widgets)
