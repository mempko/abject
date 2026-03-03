# src/runtime/ - Runtime Infrastructure

Manages system lifecycle, message routing, and failure handling. This is the execution infrastructure that objects run on top of.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Main Thread                         │
│                                                         │
│  Object A ──→ MessageBus ──→ Mailbox ──→ Object B      │
│                   │                                     │
│                   │ interceptors                        │
│                   ├── PeerRouter (P2P routing)          │
│                   ├── HealthInterceptor (error watch)   │
│                   └── ProxyInterceptor (protocol xlat)  │
│                                                         │
│  Runtime (orchestrator)                                 │
│  Supervisor (failure recovery)                          │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │              WorkerPool                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │ │
│  │  │ Worker 1 │  │ Worker 2 │  │ Worker N │        │ │
│  │  │WorkerBus │  │WorkerBus │  │WorkerBus │        │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘        │ │
│  │       └──────────────┼──────────────┘              │ │
│  │                WorkerBridge                        │ │
│  │           (main ↔ worker forwarding)               │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Files

### runtime.ts

Main orchestrator managing the bootstrap sequence.

- **State machine**: `created` → `starting` → `running` → `stopping` → `stopped`
- **Bootstrap**: creates MessageBus, wires Factory with bus and Registry, initializes Registry (registers itself), initializes Factory (registers itself)
- **`spawn(obj)`**: delegates to `Factory.spawnInstance()` (requires `running` state)
- **Singleton**: `getRuntime()`, `resetRuntime()` for testing
- **Invariant**: running runtime must have >= 2 core objects (Registry + Factory)
- **Accessors**: `messageBus`, `objectRegistry`, `objectFactory`

### message-bus.ts

Central message router. All inter-object communication goes through the bus.

- **`register(objectId, handler)`**: creates Mailbox, stores handler
- **`send(message)`**: runs interceptor pipeline → delivers to Mailbox → invokes handler
- **Interceptor pipeline**: each returns `'pass'`, `'drop'`, or a transformed message
  - `LoggingInterceptor` - debug logging with optional filter
  - `ProxyInterceptor` - reroutes messages between source/target through proxy
  - `HealthInterceptor` - passively watches for error messages (used by HealthMonitor)
- **Undeliverable handler**: `setUndeliverableHandler()` for network-layer late-discovery catchall
- **Invariant**: mailbox count == handler count

### mailbox.ts

Bounded async message queue per object.

- **`Mailbox`**: bounded (default 1000 messages)
  - `send()` - enqueue (or hand directly to waiter)
  - `receive()` - blocking (returns Promise)
  - `tryReceive()` - non-blocking
  - `receiveTimeout(ms)` - with deadline
  - `peek()`, `drain()`, `clear()`, `close()`
  - **Invariant**: cannot have both queued messages and waiters simultaneously

- **`PriorityMailbox`**: multiple `Mailbox` instances sorted by priority level

### supervisor.ts

Erlang-style supervision tree. Is itself an `Abject`.

- **Strategies**: `one_for_one` (restart failed child), `one_for_all` (restart all), `rest_for_one` (restart from failed onward)
- **Restart tracking**: counts restarts within time window (default 3 restarts in 5s)
- **Escalation**: removes child from supervision when max restarts exceeded
- **Handler**: listens for `childFailed` messages

### worker-pool.ts

Manages a pool of reusable Web Workers (or Node.js worker_threads) for object execution.

- Creates workers on demand up to a configurable pool size
- Assigns objects to workers for isolated execution
- Tracks which objects are running on which workers
- Handles worker termination and cleanup

### worker-bridge.ts

Bridge connecting main-thread MessageBus to worker-thread MessageBus instances.

- Forwards messages between the main bus and worker buses via `postMessage`
- Serializes/deserializes `AbjectMessage` across the worker boundary
- Handles worker lifecycle events (ready, error, termination)

### worker-bus.ts

MessageBus implementation for Web Worker context.

- Provides an isolated message bus inside each worker thread
- Objects running in a worker register on the local WorkerBus
- Cross-worker messages forwarded through `WorkerBridge` to the main bus

## Message Flow

```
Object A → this.send(msg) → Abject.send() → MessageBus.send() →
  interceptor pipeline → Mailbox.send() → handler(msg) →
  if request and handler returns value → auto-reply
```

**Cross-worker message flow:**

```
Object A (main) → MessageBus → WorkerBridge → postMessage →
  Worker N → WorkerBus → Object B (worker)
```
