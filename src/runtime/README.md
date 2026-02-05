# src/runtime/ - Runtime Infrastructure

Manages system lifecycle, message routing, and failure handling. This is the execution infrastructure that objects run on top of.

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
- **Undeliverable**: messages to unknown recipients notified to `'undeliverable'` subscribers (for network bridging)
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

## Message Flow

```
Object A → this.send(msg) → Abject.send() → MessageBus.send() →
  interceptor pipeline → Mailbox.send() → handler(msg) →
  if request and handler returns value → auto-reply
```
