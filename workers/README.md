# workers/ - Worker Thread Entry Points

Entry points for off-main-thread Abject execution. The Node backend runs a
pool of `worker_threads` (the `WorkerPool` in `src/runtime/`) plus dedicated
workers for the P2P and UI subsystems. Each entry point registers the
constructors it can spawn and runs a `WorkerBus` that routes messages to and
from the main thread (and directly to peer workers over `MessagePort`s).

## Files

### abject-worker-node.ts

The Node.js `worker_threads` entry point for the shared worker pool. Hosts
worker-eligible Abjects (capabilities, agents, browsers, ScriptableAbjects,
WasmAbjects, Organisms). **Every per-workspace Abject constructor must be
registered here as well as in `server/index.ts`**; missing the worker
registration causes silent spawn failures. WASM abjects need no per-module
entry: the single generic `WasmAbject` constructor covers all of them.

### abject-worker.ts

Web Worker variant of the same logic (uses the `self` API instead of
`parentPort`). Kept for browser-context execution.

### p2p-worker-node.ts

Dedicated worker for the P2P stack (Identity, PeerRegistry, RemoteRegistry,
SignalingRelay, PeerDiscovery, RemoteUIAccess). Bridged to the main bus via
`DedicatedWorkerBridge`; emits custom events (`peer-id`, `remote-message`,
`peer-status`) consumed by `server/index.ts`.

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
  TypeScript in dev, plain compiled JS when `ELECTRON_PACKAGED=1`.
- Object placement across pool workers is deterministic
  (`workerIndexForId(objectId, workerCount)`).
- WasmAbjects resolve their module bytes from the content-addressed store on
  disk (`$ABJECTS_DATA_DIR/wasm/`); module bytes never cross thread
  boundaries.
