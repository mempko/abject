# src/ - Source Root

The library half of Abjects: the object model, the runtime that moves
messages, and every system object, LLM provider, transport and display piece.
None of it starts anything by itself. The programs that do live outside `src/`:
the backend bootstrap in `server/`, the worker-thread entry points in
`workers/`, the browser client in `client/`, the terminal client in `cli/`
and the desktop shell in `electron/`.

## Architecture

```
            objects/  (system objects, agents, workspaces, UI objects)
           ╱    │      ╲            ╲
   protocol/   llm/   network/    sandbox/      ui/  (Compositor: runs in the
        ╲       │      ╱              │              browser client)
         runtime/  (MessageBus, Mailbox, workers, Supervisor)
              │
            core/  (Abject, messages, contracts, types, shared helpers)
```

The picture is a layering by role, not a strict import rule. `core` depends on
almost nothing (it borrows `Mailbox` from `runtime` and decision types from
`llm`), `runtime` constructs the Registry and Factory from `objects`, and
several lower directories import types from `objects`. What is strict is how
objects interact at run time: only by message passing through the bus, never
by calling each other's methods.

Code runs in three places:
- **Backend, main thread**: the `MessageBus`, Registry, Factory, PeerRouter,
  the Supervisor, and objects that hold this process's sockets.
- **Backend, worker threads**: most objects, placed by the Factory into a pool
  of `worker_threads`, plus dedicated P2P and (desktop) UI workers. See
  [runtime/README.md](runtime/README.md).
- **Browser client**: the thin renderer in `client/`, which draws with
  `src/ui/compositor.ts` and imports a few pure helpers from `src/core/`.

## Directories

| Directory | What it holds |
|-----------|---------------|
| [core/](core/README.md) | The `Abject` base class, message envelope and builders, Design by Contract, manifest types, introspection, peer identity crypto, and small shared libraries (command analysis, path scope, file edits, decision sites, KnowledgeBase vocabulary, skill parsing, theme data) |
| [runtime/](runtime/README.md) | `Runtime`, `MessageBus` and interceptors, `Mailbox`, the worker pool and bridges, `WorkerBus`, `Supervisor`, child-process tracking |
| [protocol/](protocol/README.md) | `Negotiator` (connections and LLM-generated proxies), `HealthMonitor` (liveness pings, error-rate renegotiation) |
| [objects/](objects/README.md) | The system objects: Registry, Factory, LLM, ObjectCreator, ProxyGenerator, WorkspaceManager, agents and goals, Chat, settings, ScriptableAbject, WasmAbject, the UI objects |
| [objects/capabilities/](objects/capabilities/README.md) | Capability objects: HTTP, Storage, Timer, Clipboard, Console, file systems, shell, web, audio, speech, shared state and more |
| [objects/widgets/](objects/widgets/README.md) | The widget toolkit: windows, layouts and widgets, each an Abject |
| [llm/](llm/README.md) | The `LLMProvider` interface and providers (API, CLI and abject-backed), tier resolution, pricing, the decision model |
| [network/](network/README.md) | Transports (WebSocket, WebRTC), signaling, `PeerRouter`, the binary wire codec, origin policy, MCP transport |
| [sandbox/](sandbox/README.md) | Packages (WASM and script): discovery, `packages.json`, ingest; the WASM ABI, instance and content-addressed module store |
| [ui/](ui/README.md) | The WebGL2 Compositor the browser client runs, plus icon and motion helpers that backend objects use to build draw commands |
| [ui/gl/](ui/gl/README.md) | The hand-rolled WebGL2 renderer under the Compositor |
| [evaluation/](evaluation/README.md) | The agent evaluation catalog served by `AgentEvaluation` |

## Entry points

- **Bootstrap**: `server/boot.ts`, shared by both editions. The desktop edition
  (`server/index.ts`) passes in the display layer from `server/ui-layer.ts`;
  the headless edition (`server/headless.ts`) passes none. Global objects are
  registered and spawned there.
- **Workers**: `workers/worker-runtime.ts` runs each pool worker; the
  constructor tables it can spawn from are `workers/core-constructors.ts` and,
  on the desktop, `workers/ui-constructors.ts`.
- **`src/index.ts`** is a pure re-export barrel: the public API, no side
  effects. The bootstrap imports modules directly, not through it.

## Conventions

- Imports use the `.js` extension even for `.ts` sources:
  `import { Abject } from './core/abject.js';`
- Preconditions, postconditions and invariants use `require` / `ensure` /
  `invariant` from `core/contracts.ts`; they are always on.
- Every object exports a well-known id constant (`REGISTRY_ID`,
  `NEGOTIATOR_ID`, ...) from the file that defines it, and is added to
  `src/index.ts` when it is public.
- One class per file; `core/types.ts` holds the shared type definitions.
- Nothing display-related may reach the headless bundle;
  `scripts/headless-bundle-check.mjs` fails the build if it does.

See the root `CLAUDE.md` for how to add global objects, per-workspace
objects, capabilities, packages and providers.
