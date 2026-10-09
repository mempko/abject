# workers/ - Worker Thread Entry Points

Entry points for off-main-thread Abject execution. The Node backend runs a
pool of `worker_threads` (the `WorkerPool` in `src/runtime/`) plus dedicated
workers for the P2P and UI subsystems. Each entry point registers the
constructors it can spawn and runs a `WorkerBus` that routes messages to and
from the main thread (and directly to peer workers over `MessagePort`s).

Each edition has its own entries, so the headless bundles carry no display
code: the desktop (`server/index.ts`) uses the `-node` entries, the headless
edition (`server/headless.ts`) the `-headless` ones.

## Files

### core-constructors.ts, ui-constructors.ts

The constructor tables. `coreConstructors()` is what every pool worker can
spawn (capabilities, agents, browsers, ScriptableAbjects, WasmAbjects,
Organisms); `addUiConstructors()` adds the window and widget Abjects, for the
desktop only. **Every per-workspace Abject constructor must be registered in
one of these as well as on the main thread (`server/boot.ts`, or
`server/ui-layer.ts` for UI)**; missing the worker registration causes silent
spawn failures. WASM abjects need no per-module entry: the single generic
`WasmAbject` constructor covers all of them.

### worker-runtime.ts

`runAbjectWorker(constructors)`: the pool worker itself (WorkerBus, spawn,
kill, peer routing), shared by both editions' entries.

### abject-worker-node.ts, abject-worker-headless.ts

The pool worker entries: core plus UI constructors on the desktop, core only
headless.

### abject-worker.ts

Web Worker variant of the same logic (uses the `self` API instead of
`parentPort`). Kept for browser-context execution.

### p2p-worker-runtime.ts, p2p-worker-node.ts, p2p-worker-headless.ts

Dedicated worker for the P2P stack (Identity, PeerRegistry, RemoteRegistry,
SignalingRelay, PeerDiscovery). Bridged to the main bus via
`DedicatedWorkerBridge`; emits custom events (`peer-id`, `remote-message`,
`peer-status`) consumed by `server/boot.ts`. The desktop entry adds
RemoteUIAccess (paired browsers and phones drawing the desktop); the headless
entry has none.

### ui-worker-node.ts

Dedicated worker hosting the UI server side (BackendUI surface management)
when dedicated-worker mode is enabled.

## Message Protocol (Main ↔ Pool Worker)

| Direction | Type | Purpose |
|-----------|------|---------|
| Main → Worker | `spawn` | `{ objectId, constructorName, constructorArgs, registryId, parentId }` |
| Main → Worker | `kill` | Stop an object |
| Main → Worker | `bus:deliver` | Route a message to a worker-local object |
| Both | `peer:port` / `peer:place` / `peer:remove` | Direct worker-to-worker routing setup |
| Worker → Main | `spawned` / `stopped` / `error` | Lifecycle acknowledgements |

## Notes

- Workers are spawned by `server/node-worker-adapter.ts`: `tsx`-loaded from
  TypeScript in dev, plain compiled JS when `ELECTRON_PACKAGED=1` or in the
  packaged headless edition.
- Object placement across pool workers is deterministic
  (`workerIndexForId(objectId, workerCount)`).
- WasmAbjects resolve their module bytes from the content-addressed store on
  disk (`$ABJECTS_DATA_DIR/wasm/`); module bytes never cross thread
  boundaries.
