# workers/ - Worker Thread Entry Points

Entry points for off-main-thread Abject execution. The Node backend runs a
pool of `worker_threads` (the `WorkerPool` in `src/runtime/`) plus two
dedicated workers: one for the P2P stack and, on the desktop, one for the
display server. Each pool entry registers the constructors it can spawn and
runs a `WorkerBus` that routes messages to and from the main thread, and
directly to other pool workers over `MessagePort`s.

Each edition has its own entries, so the headless bundles carry no display
code: the desktop (`server/index.ts`) uses the `-node` entries, the headless
edition (`server/headless.ts`) the `-headless` ones.

## Architecture

```
                         main thread (server/boot.ts)
        MessageBus, Registry, Factory, PeerRouter, Supervisor, sockets
          |                         |                          |
   WorkerPool (N)          DedicatedWorkerBridge      DedicatedWorkerBridge
          |                         |                          |
  abject-worker-node.ts     p2p-worker-node.ts         ui-worker-node.ts
  abject-worker-headless.ts p2p-worker-headless.ts     (desktop only)
          |                         |                          |
  worker-runtime.ts         p2p-worker-runtime.ts      BackendUI
  + core-constructors.ts    Identity, PeerRegistry,    (UI WebSocket and
  (+ ui-constructors.ts     RemoteRegistry,             paired browsers
   on the desktop)          SignalingRelay,             arrive as
                            PeerDiscovery               MessagePorts)
                            (+ RemoteUIAccess on
                             the desktop)
```

## Files

### core-constructors.ts, ui-constructors.ts

The constructor tables. `coreConstructors()` is what every pool worker can
spawn (capabilities, agents, chat, goals, stores, browsers, ScriptableAbjects,
WasmAbjects, Organisms, and the rest that need no display);
`addUiConstructors(map)` adds the windows, widgets and display capabilities,
for the desktop only. **Every worker-eligible constructor must be registered
in one of these as well as on the main thread (`server/boot.ts`, or
`server/ui-layer.ts` for display code)**; a name the Factory sends to a worker
that lacks it fails to spawn there (`No constructor for '<name>' in worker`).
WASM and script packages need no entry: the generic `WasmAbject` and
`ScriptableAbject` constructors cover them.

### worker-runtime.ts

`runAbjectWorker(constructors)`: the pool worker itself, shared by both
editions' entries. Spawns and kills objects in this thread, delivers bus
messages, keeps the direct worker-to-worker routes, signals child processes at
shutdown, releases an object when it unregisters (so a stopped object can be
collected), and reports heap use every 30 seconds to HeapMonitor.

### abject-worker-node.ts, abject-worker-headless.ts

The pool worker entries: core plus UI constructors on the desktop, core only
headless.

### p2p-worker-runtime.ts, p2p-worker-node.ts, p2p-worker-headless.ts

The dedicated P2P worker. It polyfills WebRTC (node-datachannel) in its own
thread, bootstraps Identity, PeerRegistry, RemoteRegistry, SignalingRelay and
PeerDiscovery with ids the main thread pre-assigned and registered, and talks
to `server/boot.ts` through custom messages. The desktop entry calls
`setRemoteUiBuilder()` to add RemoteUIAccess, which pairs a remote browser
(client.abject.world) and hands its UI traffic to the main thread as a
transferred `MessagePort` (`remote-ui-attach`); the headless entry has none.
At shutdown it closes the peer connections and shuts node-datachannel down on
its own thread, reporting whether that worked (`nativeCleanup`).

### ui-worker-node.ts

The dedicated UI worker (desktop, dedicated workers on): hosts `BackendUI`
on a `WorkerBus`. Each UI WebSocket and each paired remote browser arrives as
a transferred `MessagePort` (`ws-relay` or `webrtc-relay`), wrapped as a
`MessagePortUITransport`.

## Message protocols

**Main and pool worker** (`worker-runtime.ts`):

| Direction | Type | Purpose |
|-----------|------|---------|
| Main to worker | `spawn` | `{ objectId, constructorName, constructorArgs, registryId, parentId, typeId }` |
| Main to worker | `kill` | stop an object |
| Main to worker | `bus:deliver` | a message for an object in this worker |
| Main to worker | `peer:port`, `peer:place`, `peer:remove`, `peer:dead` | direct worker-to-worker routes |
| Main to worker | `live:add`, `live:remove` | liveness broadcast: objects that came up or went away on the bus |
| Main to worker | `proxy:route`, `proxy:unroute` | a negotiated connection's proxy route, applied by the worker's bus on every send (`src/runtime/proxy-routes.ts`); replayed into a replacement worker |
| Main to worker | `children:signal` | signal this worker's child processes (shutdown) |
| Worker to main | `ready`, `spawned`, `stopped`, `error` | lifecycle |
| Worker to main | `worker:heap`, `children:signalled` | heap samples, shutdown acknowledgement |

**Main and P2P worker** (`p2p-worker-runtime.ts`): main sends `init-config`
(the pre-assigned ids), `send-to-peer`, `shutdown` and `bus:deliver`; the
worker sends `ready`, `p2p-ready`, `peer-id`, `remote-message`,
`peer-status`, `remote-ui-attach` (desktop) and `shutdown-complete`.

**Main and UI worker** (`ui-worker-node.ts`): main sends `init-config`
(`backendUIId`, `registryId`), `frontend-client-meta`, `port-transfer`,
`shutdown` and `bus:deliver`; the worker sends `ready` and
`shutdown-complete`.

## Adding a constructor

1. Register it on the main thread (`server/boot.ts`, or `server/ui-layer.ts`
   for display code) and mark it worker-eligible there.
2. Add it to `coreConstructors()` here, or to `addUiConstructors()` when it
   draws.
3. Per-workspace objects also go into `INFRA_OBJECTS` or `UI_OBJECTS` in
   `src/objects/workspace-profiles.ts`.

## Notes

- Workers are created by `server/node-worker-adapter.ts`: through tsx from
  TypeScript in a source run, as compiled `.js` from `dist-server/` otherwise
  (`pnpm bind` builds every entry here). Each gets a
  heap ceiling (`ABJECTS_WORKER_MAX_OLD_SPACE_MB`, or sized from memory).
- Placement across pool workers is deterministic
  (`workerIndexForId(objectId, workerCount)` in `src/runtime/worker-pool.ts`).
- Workers inherit the main thread's environment when created, so
  `ABJECTS_DATA_DIR` set by a launcher reaches the worker-side Storage.
- WasmAbjects read module bytes from the content-addressed store on disk
  (`$ABJECTS_DATA_DIR/wasm/`); module bytes never cross thread boundaries.
- `ui-constructors.ts` and `ui-worker-node.ts` are on the headless bundle
  check's forbidden list (`scripts/headless-bundle-check.mjs`).

## Related

- [server/README.md](../server/README.md): the boot sequence that starts these workers
- [src/runtime/README.md](../src/runtime/README.md): WorkerPool, WorkerBus, worker bridges
