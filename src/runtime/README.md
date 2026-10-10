# src/runtime/ - Runtime Infrastructure

The machinery objects run on: the `Runtime` that bootstraps Registry and
Factory, the main-thread `MessageBus` and its interceptors, per-object
`Mailbox`es, the worker-thread pool and its bridges, the `Supervisor`, and
the tracker for child processes that must die with the app. Nothing here
decides what objects do; it only moves their messages and keeps them alive.

`server/boot.ts` (shared by the desktop and headless editions) creates the
Runtime, sizes the worker pool and installs the interceptors.

## Architecture

```
 Main thread
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Runtime ── owns ──► MessageBus ◄── Registry, Factory, main-only      │
 │                       │            objects (PeerRouter, Supervisor)  │
 │  send(msg):           ▼                                              │
 │   1. interceptors in order: LoggingInterceptor (DEBUG), PeerRouter;  │
 │      then the proxy routes (proxy-routes.ts)                         │
 │   2. recipient in a worker? ──► its WorkerBridge ──► postMessage     │
 │   3. local mailbox?         ──► Mailbox.send()                       │
 │   4. never-seen id          ──► park up to 400 ms, then undeliverable│
 └───────────┬──────────────────────────────────────┬───────────────────┘
             │ WorkerPool: N WorkerBridges          │ DedicatedWorkerBridge
             ▼                                      ▼
   ┌──────────────┐ MessagePort ┌──────────────┐   P2P worker (always),
   │ worker 0     │◄───────────►│ worker 1 …   │   UI worker (desktop)
   │  WorkerBus   │  full mesh  │  WorkerBus   │
   │  objects     │             │  objects     │
   └──────────────┘             └──────────────┘
```

Every object gets a `Mailbox` from whichever bus it registers on and runs its
own processing loop (see `Abject` in [../core/README.md](../core/README.md)).
Buses never await handlers: `send()` enqueues and returns.

**Placement.** The Factory spawns a constructor in a pool worker when it is
marked worker-eligible (the list in `server/boot.ts`) and workers are on.
`workerIndexForId()` shards by the object's UUID, so placement is
deterministic. The pool registers the route on the main bus before the spawn,
then tells every other worker where the object lives so they can reach it over
their direct `MessagePort`s. Objects a worker object constructs itself (every
window and widget a worker-hosted WidgetManager creates) announce themselves
with `bus:registered` and get the same routing.

**Liveness.** The main bus pushes every registration and unregistration to
all pool workers (`live:add` / `live:remove`), so `isRegistered()` inside a
worker gives the same answer as on main.

**Undeliverable messages.** When a recipient does not exist, a request gets a
`RECIPIENT_NOT_FOUND` error reply at once (so `request()` fails fast instead of
timing out), an event's sender gets a `recipientGone` event, and the
undeliverable handler (PeerRouter, for late discovery of remote objects) runs.
Ids that were never seen are parked for 400 ms first, because a worker's
registration can arrive after a reply that names the new object. Ids
unregistered within the last 10 s skip the wait.

## Message flow

```
Same thread:   A.send ─► bus.send ─► (main only: interceptors) ─► Mailbox(B) ─► B handler
Main → worker: MessageBus ─► WorkerBridge.deliverMessage ─► bus:deliver ─► WorkerBus ─► Mailbox
Worker → peer: WorkerBus.send ─► peer MessagePort ─► peer WorkerBus.deliverFromPeer ─► Mailbox
Worker → main: WorkerBus.send ─► bus:send ─► WorkerBridge ─► MessageBus.send (interceptors run here)
```

`WorkerBus.send()` tries, in order: a local mailbox, a known peer worker over
its direct port, then the main thread.

## Files

### runtime.ts

`Runtime` and the `getRuntime()` / `resetRuntime()` singleton.
- `RuntimeConfig`: `debug` (adds a `LoggingInterceptor`), `workerEnabled`,
  `workerCount` (default 2 when unset), `workerFactory`.
- State machine `created` → `starting` → `running` → `stopping` → `stopped`.
- `start()`: wires Factory to the bus and Registry, inits Registry and Factory
  and registers both, spawns any `registerCoreObject()` objects, then starts
  the `WorkerPool` and hands it to the bus and the Factory.
- `spawn(obj, parentId?)` goes through `Factory.spawnInstance()`.
- Shutdown: `signalChildProcesses(signal)` first (this thread and every pool
  worker), `shutdownWorkerPool()` (can run alongside other teardown), then
  `stop()` stops spawned objects, Registry, Factory and the bus.
- Accessors: `messageBus`, `objectRegistry`, `objectFactory`, `workerPool`,
  `config`, `currentState`.

### message-bus.ts

- **`MessageBusLike`**: what `Abject.init()` needs (`register`, `unregister`,
  `send`, `isRegistered`); implemented by `MessageBus` and `WorkerBus`.
- **`MessageBus`**: main-thread router. `register(objectId)` returns a new
  `Mailbox`; `send()` runs interceptors, applies the proxy routes, then
  routes as above; `relayFromPoolWorker()` does the same for a message a pool
  worker sent on, without the routes (its own bus applied them);
  `setProxyRoute()` / `removeProxyRoute()` / `announceProxyRoutesTo()` keep
  the route table and copy it to every pool worker;
  `registerWorkerObject()` / `registerDedicatedBridge()` mark ids that live in
  a worker; `setWorkerPool()`, `announceLivenessTo()`;
  `setUndeliverableHandler()`; `subscribe(objectId, handler)` (receives
  undeliverable messages when `objectId` is `'*'` or `'undeliverable'`);
  `stop()` clears all of it.
- **`MessageInterceptor`**: `intercept(msg)` returns `'pass'`, `'drop'`, or a
  replacement message. Synchronous.
- **`LoggingInterceptor`**: logs each message, with an optional filter.

### proxy-routes.ts

`ProxyRouteTable`: the routes of negotiated connections (`ProxyRoute`:
agreement, source, target, proxy, HealthMonitor). `apply(msg)` re-addresses a
request or event between the source and the target (either direction) to the
proxy, and turns the proxy's reply or error to the source into a
`recordSuccess` / `recordError` event for HealthMonitor. Replies and errors
otherwise pass untouched, so each still reaches its requester. The main bus
owns the table (the Negotiator, on the main thread, sets it) and copies every
change to the pool workers (`proxy:route`, `proxy:unroute`); each `WorkerBus`
applies the same table on send, so a connection holds for traffic that stays
inside a worker or goes straight to a peer worker.

### mailbox.ts

- **`Mailbox`**: bounded FIFO (default 1000). `send()` hands the message to a
  waiting `receive()` or queues it; when the mailbox is full or closed the
  message is dropped and counted (`droppedFull`, `droppedClosed`) with a
  throttled warning. `receive()`, `tryReceive()`, `receiveTimeout(ms)`,
  `peek()`, `drain()`, `clear()`, `close()`. Invariant: never both queued
  messages and waiters.
- **`PriorityMailbox`**: several mailboxes drained highest priority first.

### supervisor.ts

`Supervisor` (an Abject, `SUPERVISOR_ID`): Erlang-style supervision by child
spec.
- `ChildSpec`: `id`, `constructorName`, `restart` (`permanent`, `transient`,
  `temporary`), `parentId`.
- Handlers: `addChild`, `removeChild`, `getChildren`, `childFailed`. All but
  `getChildren` are taken from built-in objects only (`isBuiltInCaller`, see
  `src/core/built-in.ts`): an object that runs code cannot restart or drop a
  supervised one.
- On `childFailed` it drops `temporary` children and restarts the others by
  strategy (`one_for_one` default, `one_for_all`, `rest_for_one`), asking the
  Factory to `respawn` with the same id so references stay valid, then sends
  `markObjectReady` to the HealthMonitor. More than `maxRestarts` (3) within
  `maxTime` (5 s) removes the child from supervision.
- `childFailed` comes from HealthMonitor (missed pings, `LIVENESS_FAILURE`)
  and WorkerRecovery (`WORKER_DEAD`). `server/boot.ts` registers system
  objects through `supervisedSpawn()`.

### worker-pool.ts

`WorkerPool` and `workerIndexForId()`.
- `start()` creates all `workerCount` workers, waits for `ready`, then links
  every pair with a `MessageChannel` (full mesh).
- `spawnInWorker(objectId, constructorName, { constructorArgs, registryId,
  parentId, typeId })` routes, spawns, and announces placement to peers;
  `killInWorker()` reverses it. The `typeId` reaches the object before init,
  so worker-hosted objects carry their durable identity like main-thread ones.
- Worker death: cuts every route to the lost objects (main bus and peers),
  tells peers the worker is dead, builds a replacement in the same slot, and
  calls `onWorkerLost(lostIds, index)` (wired to WorkerRecovery in
  `server/boot.ts`).
- `heapSamples()`: each worker's latest heap report (read by HeapMonitor).
- `signalChildren(signal)`; `shutdown()` stops every hosted object at once,
  each given at most 2.5 s, then terminates the workers.

### worker-bridge.ts

`WorkerBridge`: the main-thread end of one worker, over the `WorkerLike`
interface (`postMessage`, `terminate`, `onmessage`, `onerror`, `onexit`).
Defines the wire protocol (`WorkerInboundMessage`: `init`, `spawn`, `kill`,
`bus:deliver`, `peer:*`, `live:*`, `children:signal`;
`WorkerOutboundMessage`: `ready`, `spawned`, `stopped`, `bus:send`,
`bus:registered`, `bus:unregistered`, `worker:heap`, `error`, ...) and
`WorkerHeapSample`. Tracks requests forwarded into the worker so that, if the
worker dies, each caller gets a `WORKER_DEAD` error reply; requests to an
already dead worker fail the same way. Hooks: `onLocalRegistered`,
`onLocalUnregistered`, `onDead`, `onHeapSample`.

### dedicated-worker-bridge.ts

`DedicatedWorkerBridge` extends `WorkerBridge` for the single-purpose workers
(the P2P worker, and on the desktop the UI worker): `sendConfig()`,
`transferPort()`, `sendCustom()` / `onCustom()` for non-Abject messages, and
`shutdownWorker()`, which asks the worker to stop its objects (and their
peer connections) before terminating the thread. Their objects are routed
with `MessageBus.registerDedicatedBridge()`.

### worker-bus.ts

`WorkerBus`: the `MessageBusLike` inside a worker thread. Local mailboxes,
peer ports (`addPeerPort`, `addPeerObject`), the global liveness view
(`addGlobalObject`), and `failPeer()`, which answers every request still out
to a dead peer with `WORKER_DEAD`. `register()` posts `bus:registered` to main;
`onUnregistered` lets the worker entry release its references. The worker side
that drives it is `workers/worker-runtime.ts`.

### child-processes.ts

Child processes this thread started that must not outlive the app (MCP
servers, CLI providers, PTY sessions, running processes). Spawners call
`trackChild(pid, label, { group })`; a `group` child leads its own process
group and the whole group is signalled. `untrackChild()`, `untrackIfGone()`,
`trackedChildren()`, `signalChild()`, `signalAllChildren(signal)` (the first
shutdown step; later arrivals are signalled as soon as they are tracked),
`resetChildTracking()`. State is per thread; the pool asks each worker with
`children:signal`.

## Configuration

Set in `server/boot.ts`:
- `ABJECTS_WORKER_COUNT=N` sets the pool size (`0` runs everything on the
  main thread). The default is the CPU count minus one, between 1 and 8.
- `ABJECTS_DEDICATED_WORKERS=0` keeps the P2P (and UI) objects on the main
  thread.
- `DEBUG` turns on the `LoggingInterceptor`.

## Adding things

**Running an object in a worker.** Register its constructor with the Factory
in `server/boot.ts` and in the worker constructor table
(`workers/core-constructors.ts`, or `workers/ui-constructors.ts` for display
objects), then add the name to the `workerEligible` list in `server/boot.ts`.
A constructor missing from the worker table makes the spawn fail.

**A new interceptor.** Implement `MessageInterceptor` (synchronous, never
throws, returns quickly; it runs on every main-bus message) and install it
with `bus.addInterceptor()` in `server/boot.ts`. Order matters: PeerRouter
re-addresses remote traffic before any later interceptor sees it. If it needs
replies from objects, register a mailbox of its own on the bus for them. It
sees only main-bus traffic: messages inside one worker, or between workers
over their direct ports, never reach it.

## Gotchas

- **Interceptors only see main-bus traffic.** Messages between two objects in
  the same worker, or between pool workers over their direct ports, never
  reach the main `MessageBus`, so interceptors do not see them. An object
  hosted in a worker also has a `WorkerBus`, which has no `addInterceptor()`.
- **A full mailbox drops.** `Mailbox.send()` does not throw; it logs and
  counts. A flood shows up as `drop: full mailbox` warnings and requests that
  time out.
- **`subscribe()` is not a firehose.** Subscriptions only receive
  undeliverable messages.
- **Register worker constructors in both places**, or worker spawns fail.
- **Supervisor and PeerRouter stay on the main thread.** The Supervisor must
  not depend on the workers it restarts; PeerRouter is a synchronous
  interceptor.
- **`resetRuntime()`** before building a new Runtime in the same process
  (the bootstrap does this); `getRuntime()` otherwise returns the old one.

## Related

- [../core/README.md](../core/README.md): `Abject`, messages, contracts
- [../protocol/README.md](../protocol/README.md): Negotiator and HealthMonitor
- [../network/README.md](../network/README.md): PeerRouter and transports
- [../../workers/README.md](../../workers/README.md): worker entry points and constructor tables
- [../../server/README.md](../../server/README.md): bootstrap
