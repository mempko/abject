# CLAUDE.md - Working with the Abjects Codebase

## Project Overview

Abjects is an LLM-mediated distributed object system where objects communicate via message passing, negotiate protocols using an LLM, and self-heal when communication breaks down. Everything in the system is an object (Abject) - including the Registry, Factory, LLM service, and UI server.

**Tech Stack**: TypeScript, Vite, WASM (sandboxed objects), Canvas (X11-style UI)

## Build & Run Commands

```bash
pnpm conjure                      # Gather dependencies
pnpm awaken                       # Awaken the backend (ws://localhost:7719)
pnpm scry                         # Scry into the abyss (http://localhost:5174)
pnpm whisper                      # Start P2P signaling server (:7720)
pnpm incarnate:server             # Package the headless server + systemd unit (deploy/README.md)
```

## Project Structure

```
src/
  index.ts              # Public API re-export barrel
  core/                 # Types, contracts, message builders, base Abject class, capabilities
  runtime/              # Runtime orchestrator, MessageBus, Mailbox, Supervisor
  objects/              # System objects: Registry, Factory, LLMObject, ObjectCreator, ProxyGenerator, UIServer
  objects/capabilities/ # Capability objects: HttpClient, Storage, Timer, Clipboard, Console, FileSystem
  protocol/             # Negotiator, Agreement management, HealthMonitor
  llm/                  # LLM provider interface and implementations (Anthropic, OpenAI, Ollama)
  network/              # Transport abstraction, WebSocket, MockTransport
  sandbox/              # Packages (WASM + script): discovery, packages.json, ingest; WASM ABI, instance, module store
  ui/                   # App shell, Canvas Compositor
workers/
  abject-worker-node.ts # worker_threads entry point for the shared Abject pool
native/                 # Bundled WASM system packages (committed main.wasm, e.g. C++ KnowledgeBase)
sdk/cpp/                # C++ SDK for writing WASM abjects
sdk/script/             # TypeScript types for script packages
examples/               # User-loadable abject packages, WASM and script (pnpm forge)
docs/                   # PACKAGES.md, WASM_ABI.md and other specs
```

## Key Conventions

### Design by Contract

**Always use `require`/`ensure`/`invariant` from `src/core/contracts.ts`.** Contracts are never disabled - correctness over performance.

- `require(condition, message)` - Preconditions at function entry
- `ensure(condition, message)` - Postconditions before return
- `invariant(condition, message)` - Class state consistency in `checkInvariants()`
- Helpers: `requireDefined`, `requireNonEmpty`, `requireNonEmptyArray`, `requirePositive`, `requireNonNegative`

Call `checkInvariants()` after state mutations. Override it calling `super.checkInvariants()` first.

### The Abject Pattern

Every system service follows this pattern:

1. **Extend Abject** with a manifest in the constructor:
   ```typescript
   constructor() {
     super({
       manifest: {
         name: 'MyObject',
         description: 'What it does',
         version: '1.0.0',
         interfaces: [{ id: 'abjects:my-object' as InterfaceId, name: '...', description: '...', methods: [...] }],
         requiredCapabilities: [],
         providedCapabilities: [...],
         tags: ['system'],
       },
     });
     this.setupHandlers();
   }
   ```
2. **Register handlers** in `setupHandlers()` using `this.on('methodName', handler)`
3. **Use `this.send()`** for fire-and-forget, **`this.request<T>()`** for request/reply (30s default timeout)
4. **Override `onInit()`** for async initialization, **`onStop()`** for cleanup
5. **Export a well-known ID constant**: `export const MY_OBJECT_ID = 'abjects:my-object' as AbjectId`

### Message Handlers

- Handlers receive `AbjectMessage`, extract payload via type assertion: `const { key } = msg.payload as { key: string }`
- Returning a value from a request handler auto-creates a reply message
- Method `'*'` is a wildcard/catch-all handler
- Unhandled requests get a `METHOD_NOT_FOUND` error reply

### Naming Conventions

- **Interface IDs**: `'abjects:module-name'` (e.g., `'abjects:registry'`, `'abjects:http'`)
- **Well-known IDs**: `UPPER_SNAKE_CASE` with `_ID` suffix (e.g., `REGISTRY_ID`, `FACTORY_ID`)
- **Capability IDs**: `'abjects:category:action'` (e.g., `'abjects:storage:read'`)
- **Tags**: lowercase strings in arrays (e.g., `['system', 'core']`, `['capability', 'http']`)

### TypeScript

- **Target**: ES2022, **Module**: ESNext, **Strict**: true
- Imports use `.js` extension: `import { Abject } from './abject.js'`
- `noEmit: true` (Vite handles bundling)
- Libs: ES2022, DOM, DOM.Iterable, WebWorker

### File Organization

- One class per file (except `types.ts` which has all type definitions)
- Interfaces declared in same file as implementing class
- Well-known IDs and factory functions exported from same file as class
- Public API re-exported from `src/index.ts`

## How to Add Things

### New Global Object

Global objects are singletons spawned once during bootstrap in `server/index.ts`.

1. Create file in appropriate directory
2. Extend `Abject` with full manifest (include complete `InterfaceDeclaration` with method params, returns, descriptions)
3. Add handlers for every method in the interface
4. Use contracts for all preconditions/postconditions
5. Override `checkInvariants()` calling `super.checkInvariants()` first
6. Export well-known ID constant
7. Add to `src/index.ts` exports
8. Register its constructor and spawn it in `server/index.ts` `main()`

### New Per-Workspace Object

Per-workspace objects are spawned automatically for every workspace by `WorkspaceManager`. They run in worker threads when workers are enabled (the default). **You must register the constructor in both the main thread AND the worker.**

1. Create file in `src/objects/`
2. Extend `Abject` with full manifest, handlers, contracts, well-known ID (same as global)
3. Register constructor in **`server/index.ts`**: `runtime.objectFactory.registerConstructor('Name', () => new MyAbject())`
4. Register constructor in **`workers/abject-worker-node.ts`**: import + `constructors.set('Name', () => new MyAbject())`
5. (Optional) Mark worker-eligible in `server/index.ts` `workerEligible` array if it should run in a worker thread
6. Add to spawn list in **`src/objects/workspace-manager.ts`**:
   - `INFRA_OBJECTS` — non-UI Abjects (always spawned, including for inactive workspaces)
   - `UI_OBJECTS` — Abjects with show/hide windows (only spawned for active workspaces)
7. Export from `src/index.ts`

**CRITICAL**: Forgetting the `workers/abject-worker-node.ts` registration causes silent spawn failures when workers are enabled. Always register in both places.

### New Capability Object

1. Create in `src/objects/capabilities/`
2. Define capability ID constants in `src/core/capability.ts`
3. Set `providedCapabilities` in manifest, tag with `['capability', '<name>']`
4. Follow existing patterns (see `http-client.ts` for domain allow/deny, `storage.ts` for IndexedDB)

### New WASM Abject (other languages)

Abjects can be written in any language that compiles to WebAssembly and run
as first-class objects. The host/guest contract is `docs/WASM_ABI.md`; the
C++ SDK is `sdk/cpp/` (see its README). Working example: `examples/echo-cpp`
(full ABI surface, user-loadable via forge). Bundled system packages live in
`native/` (committed with their built `main.wasm`, ingested at every boot,
shipped in the desktop app via extraResources); `native/knowledge-base`
replaces the built-in KnowledgeBase. Rebuild bundled packages with
`pnpm smelt` after changing their sources.

1. Write the object against `sdk/cpp/include/abject/abject.hpp` (`Object`
   subclass + `ABJECT_OBJECT(Class)` in one translation unit)
2. Add an `abject.json`: name, version, `abi: 1`, `scope` ('system' spawns
   once at boot, 'workspace' spawns per workspace), optional
   `replaces: '<BuiltinName>'` to take over a built-in type, and a `build`
   command (usually `bash ../../sdk/cpp/build.sh <src> -o main.wasm`;
   requires the WASI SDK, default `~/tools/wasi-sdk`, override with
   `WASI_SDK`)
3. `pnpm forge <dir>` compiles, validates the ABI, extracts the module's
   manifest, and installs into `.abjects/extensions/`; the server ingests
   extensions at boot
4. No constructor registration is needed anywhere — WASM objects spawn
   through the generic `WasmAbject` host (already registered on main +
   worker) and are referenced by content hash (`wasm:sha256:...`) riding the
   normal `source` field, so persistence/clone/respawn work unchanged

### New Script Package (TypeScript or JavaScript)

Abjects can also ship as script packages: a JavaScript handler map run as a
ScriptableAbject in the sandbox, optionally authored in TypeScript. This is
the way to add abjects to an instance by configuration rather than by
changing the server. Format, load order, `packages.json` and settings:
`docs/PACKAGES.md`. Working examples: `examples/tally-ts` (TypeScript, with
settings) and `examples/scene-showcase` (plain JS, no build).

1. Write the handler map in `<name>.ts` against `sdk/script/abject.d.ts`
   (`({ ... }) satisfies AbjectHandlers<State>`, type-only imports)
2. Add an `abject.json`: name, version, `runtime: 'script'`,
   `scope: 'workspace'` (one per workspace) or `'system'` (one per instance,
   data kept by `Packages`), `entry`, `manifest` (inline or a path), optional
   `replaces`, `settings` and `profiles` (the workspace profiles it joins:
   `docs/WORKSPACE_PROFILES.md`). To serve web pages, expose it in `http` mode
   (`docs/WEB_GATEWAY.md`)
3. `pnpm forge <dir>` compiles, checks the handler map in the sandbox, and
   installs into `.abjects/extensions/`; or point `ABJECTS_PACKAGE_DIRS` /
   Settings → Packages at the directory (`--build-only` first for a `.ts`
   entry)
4. No constructor registration is needed: the Factory spawns package types as
   ScriptableAbjects (on the worker pool), owned by `package:<name>`, which
   keeps them read-only and their data under `package/<Type>` in AbjectStore

The `Packages` system abject (`src/objects/packages.ts`, worker-eligible)
lists packages, edits `packages.json`, and serves `getSettings` to a package's
own abjects; the Packages tab of GlobalSettings is its UI.

### New Global Setting

Global settings (AI keys and tiers, auth, filesystem, shell, web, capability
enforcement) are owned by `SettingsManager` (`src/objects/settings-manager.ts`):
it persists them, validates writes, applies them to LLM, UIServer and the
capability objects, and emits `settingsChanged`. `GlobalSettings` is only its
window, and `CliServer` exposes the same `getSettingsSchema` / `getSettings` /
`setSettings` to `commune`. Add a field to the section's type, `schema()`
and the section's setter in SettingsManager; then show it in the window. Only
GlobalSettings and CliServer may write, and only GlobalSettings may read secrets.

### New LLM Provider

Prefer an abject-backed provider, which needs no core change: any abject (usually a script package
tagged `autostart`) sends `registerProvider` to `LLM` on startup and answers `providerComplete` (and
optionally `providerStream` / `providerModels`). It then appears in Settings → AI, tier routing, fallbacks
and the ledger like a built-in. Protocol: `docs/LLM_PROVIDERS.md`; adapter: `src/llm/remote-provider.ts`;
example: `examples/openai-compatible-provider`. `HttpClient` refuses private and loopback addresses
(checked after DNS resolution and on every redirect) unless the owner lists them under Private hosts in
Settings → Permissions, so a provider for a local model server needs an entry such as `localhost:11434`.

A built-in provider (compiled into the server):

1. Create in `src/llm/`
2. Implement `LLMProvider` interface (or extend `BaseLLMProvider`)
3. Include both `complete()` and `stream()` methods
4. Add configuration to `LLMObject.configure()` and an entry to `LLMObject.PROVIDER_DESCRIPTORS`
   (which also reserves its name against abject-backed providers)
5. Export from `src/index.ts`

## Common Pitfalls

- **Object initialization**: All objects must be `init(bus)` before use; `factory.spawnInstance()` handles this
- **Mailbox bounds**: Default max queue size is 1000; sending to a full mailbox throws `ContractViolation`
- **API keys**: Set via `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` environment variables
- **Compositor**: Needs a real `HTMLCanvasElement`
- **Sequence numbers**: Per-sender, tracked in module-level state in `message.ts`; use `resetSequence()` in tests
- **Import extensions**: Always use `.js` in imports even though source files are `.ts`
- **Bootstrap**: Global system objects must be registered and spawned in `server/index.ts`.
- **Worker constructors**: Per-workspace Abjects must have their constructors registered in BOTH `server/index.ts` AND `workers/abject-worker-node.ts`. Missing the worker registration causes silent spawn failures.

## Bootstrap Order

Bootstrap happens in `server/index.ts`:

1. `App` creates Canvas, Compositor, UIServer, Runtime
2. `Runtime.start()` creates MessageBus, initializes Registry and Factory on the bus
3. `main()` spawns: LLMObject, HttpClient, Storage, Timer, Clipboard, Console, FileSystem
4. `main()` spawns: ProxyGenerator, Negotiator, HealthMonitor, ObjectCreator
5. `main()` spawns: Workspaces, P2P, and remaining system objects

When adding a new global system object, register its constructor and spawn it in `server/index.ts`.
Per-workspace objects are spawned by `WorkspaceManager` — add them to `INFRA_OBJECTS` or `UI_OBJECTS` in `workspace-manager.ts`, and register their constructors in both `server/index.ts` and `workers/abject-worker-node.ts`.

## Dependencies

- **uuid**: Message ID generation (v4)
- **ajv**: JSON schema validation
- **assemblyscript**: WASM compilation toolchain (devDependency)
- **vite**: Build tool and dev server
- **typescript**: Language compiler
