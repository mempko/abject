# Abjects Architecture

## 1. System Overview

Abjects is an LLM-mediated distributed object system. Objects communicate exclusively through asynchronous message passing, describe themselves via manifests, and negotiate communication protocols using an LLM. When objects with incompatible interfaces need to communicate, the LLM generates a proxy object that translates messages between them. When communication degrades, the system detects errors and regenerates the proxy automatically.

The core thesis: **an LLM can serve as a runtime mediator** - generating protocol adapters on the fly, creating objects from natural language, and healing broken connections.

## 2. Foundational Concepts

### 2.1 Everything is an Object (Abject)

All system services are Abjects: Registry, Factory, LLM service, UIServer, HealthMonitor, Negotiator, and all capability objects. Each Abject has:

- **id** - UUID (v4), assigned at construction
- **manifest** - Self-description: name, description, version, interfaces, required/provided capabilities, tags
- **capabilities** - `CapabilitySet` of granted permissions
- **state machine** - `initializing` → `ready` → `busy` → `error` → `stopped`

The manifest's `interfaces` array contains machine-readable `InterfaceDeclaration` objects with typed method signatures, parameter types, return types, and event declarations. This is what the LLM reads to generate proxy objects.

### 2.2 Message-Driven Communication

Four message types: **request**, **reply**, **event**, **error**.

```
AbjectMessage {
  header:   { messageId, correlationId?, sequenceNumber, timestamp, type }
  routing:  { from, to, interface, method? }
  payload:  unknown
  protocol: { version: '1.0.0', negotiationId? }
}
```

- **Request/reply correlation** via `correlationId` linking reply to original request
- **Per-sender sequence numbers** for ordering (tracked in module-level state in `message.ts`)
- **Message builders**: `request()`, `reply()`, `event()`, `error()`, `errorFromException()`
- **Type guards**: `isRequest()`, `isReply()`, `isEvent()`, `isError()`, `isReplyTo()`
- **Serialization**: JSON via `serialize()`/`deserialize()`

### 2.3 Design by Contract

Contracts are **always enabled** - correctness over performance. Three assertion types:

- **`require(condition, message)`** - Preconditions: validates inputs at function entry
- **`ensure(condition, message)`** - Postconditions: validates results before return
- **`invariant(condition, message)`** - Class state: checked after construction and state mutations

All throw `ContractViolation` with type discrimination (`'require'` | `'ensure'` | `'invariant'`).

Helpers: `requireDefined()`, `requireNonEmpty()`, `requireNonEmptyArray()`, `requirePositive()`, `requireNonNegative()`.

### 2.4 Capability-Based Security

Capabilities are permissions granted to objects. Each has an ID string in the format `abjects:category:action`.

| Category | Capabilities |
|----------|-------------|
| **Core** (granted to all) | `SEND_MESSAGE`, `LOG`, `TIME` |
| **System** | `REGISTRY_READ`, `REGISTRY_WRITE`, `FACTORY_SPAWN`, `LLM_QUERY` |
| **UI** | `UI_SURFACE`, `UI_INPUT` |
| **External** | `HTTP_REQUEST`, `STORAGE_READ/WRITE`, `TIMER`, `CLIPBOARD_READ/WRITE`, `FILESYSTEM_READ/WRITE`, `CONSOLE` |

`CapabilitySet` manages grants per object with `has()`, `satisfies()`, `missing()`. WASM imports enforce capabilities at the sandbox boundary.

## 3. Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Main Thread                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Message  │ │ Network  │ │   LLM    │ │ UI Compositor │  │
│  │   Bus    │ │  Layer   │ │ Gateway  │ │   (Canvas)    │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬───────┘  │
└───────┼────────────┼────────────┼───────────────┼──────────┘
        │      postMessage API    │               │
┌───────┼────────────┼────────────┼───────────────┼──────────┐
│       ▼            ▼            ▼               ▼          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Object Runtime Worker                   │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │   │
│  │  │ Registry │ │ Factory  │ │ LLM Obj  │ │ UI Obj │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘  │   │
│  │  ┌──────────────────────────────────────────────┐   │   │
│  │  │      User Objects (WASM Modules)             │   │   │
│  │  │  Each object = sandboxed WASM instance       │   │   │
│  │  │  Imports: send(), log() (capability-based)   │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                      Web Worker                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Core Layer (`src/core/`)

The foundation that everything else depends on.

- **`types.ts`** - All type definitions: identity types (`AbjectId`, `MessageId`, etc.), `AbjectMessage`, `InterfaceDeclaration`, `MethodDeclaration`, `TypeDeclaration`, `CapabilityGrant`, `AbjectManifest`, `ProtocolAgreement`, `AbjectStatus`, `WasmObjectExports`
- **`contracts.ts`** - Design-by-contract assertions: `require()`, `ensure()`, `invariant()`, helpers
- **`message.ts`** - Message factory functions, type guards, serialization, per-sender sequence number tracking
- **`abject.ts`** - Abstract `Abject` base class with handler registration (`on()`), message sending (`send()`, `request<T>()`), pending reply tracking with timeout (30s default), state machine, invariant checking. Also `SimpleAbject` for inline handler objects.
- **`capability.ts`** - `Capabilities` constant object, `CapabilitySet` class, `getDefaultCapabilities()` (SEND_MESSAGE, LOG, TIME for all objects)

### 3.2 Runtime Layer (`src/runtime/`)

Execution infrastructure that objects run on top of.

- **`runtime.ts`** - Main orchestrator. State machine: `created` → `starting` → `running` → `stopping` → `stopped`. Bootstrap creates MessageBus, Registry, Factory, wires them together. `spawn()` delegates to Factory. Singleton via `getRuntime()`, `resetRuntime()` for testing. Invariant: running runtime must have >= 2 core objects.
- **`message-bus.ts`** - Central message router. `register()` creates a Mailbox per object. `send()` runs interceptor pipeline then delivers to mailbox and invokes handler. **Interceptors**: `LoggingInterceptor` (debug logging), `ProxyInterceptor` (reroutes A→B traffic through proxy). Undeliverable messages notified to subscribers (for network bridging). Invariant: mailbox count == handler count.
- **`mailbox.ts`** - Bounded async queue (default 1000). Blocking `receive()`, non-blocking `tryReceive()`, `receiveTimeout()`, `peek()`, `drain()`, `clear()`, `close()`. Key invariant: cannot have both queued messages and waiters simultaneously. Also `PriorityMailbox` with multiple queues sorted by priority level.
- **`supervisor.ts`** - Erlang-style supervision tree. Strategies: `one_for_one` (restart failed child), `one_for_all` (restart all), `rest_for_one` (restart from failed onward). Restart tracking within time window (default 3 restarts in 5s). Escalation when max exceeded. Is itself an Abject (listens for `childFailed` messages).

### 3.3 Object Layer (`src/objects/`)

System-level objects providing core services.

- **`registry.ts`** - Central object directory. Multi-indexed by ID, interface, capability, name. `DiscoveryQuery` supports filtering by name, interface, capability, tags. Subscribers notified on register/unregister. Well-known ID: `REGISTRY_ID`.
- **`factory.ts`** - Object lifecycle. `spawnInstance()` for pre-constructed objects, `spawn()` from manifest + code. Auto-registers with Registry. `kill()` stops and deregisters. Tracks all spawned objects. Well-known ID: `FACTORY_ID`.
- **`llm-object.ts`** - LLM service wrapper. Provider-agnostic (Anthropic, OpenAI, Ollama). Methods: `complete`, `generateCode`, `analyze`, `listProviders`, `setProvider`. Code extraction strips markdown fences. Well-known ID: `LLM_OBJECT_ID`.
- **`proxy-generator.ts`** - LLM-generated proxy objects. `generateProxy()` takes two manifests, produces TypeScript proxy code + manifest + `ProtocolAgreement`. `regenerateProxy()` includes error context from previous failures. Caches for regeneration. Well-known ID: `PROXY_GENERATOR_ID`.
- **`object-creator.ts`** - Natural language object creation. Discovers relevant objects via LLM-assisted filtering. Builds prompts including available object interfaces. Parses LLM response for JSON manifest + TypeScript code blocks. Methods: `create`, `modify`, `suggest`, `listAvailable`, `getObjectGraph`. Well-known ID: `OBJECT_CREATOR_ID`.
- **`ui-server.ts`** - X11-style display server. Surface ownership tracking (objects own their surfaces). Input routing: mouse to surface under pointer, keyboard to focused surface. Focus management with focus/blur events. Well-known ID: `UI_SERVER_ID`.

### 3.4 Capabilities Layer (`src/objects/capabilities/`)

Built-in objects wrapping browser APIs or virtual services, exposed through standard Abject message interfaces.

- **`http-client.ts`** - HTTP via Fetch API. Domain allow/deny lists. AbortController timeout (30s). Capability: `HTTP_REQUEST`.
- **`storage.ts`** - IndexedDB key-value store (`abjects-storage` database, `kv` store). In-memory fallback. Capabilities: `STORAGE_READ`, `STORAGE_WRITE`.
- **`timer.ts`** - `setTimeout`/`setInterval` wrapper. Owner-only cancellation. Fires `timerFired` events. Cleans up in `onStop()`. Capability: `TIMER`.
- **`clipboard.ts`** - Browser Clipboard API. Graceful permission handling. Capabilities: `CLIPBOARD_READ`, `CLIPBOARD_WRITE`.
- **`console.ts`** - Buffered logging (max 1000 entries). Multi-level: debug/info/warn/error. Filterable retrieval. Capability: `CONSOLE`.
- **`filesystem.ts`** - In-memory virtual FS. Tree structure with `FileEntry` nodes. Path normalization with `..` traversal. `Uint8Array` content. Capabilities: `FILESYSTEM_READ`, `FILESYSTEM_WRITE`.

### 3.5 Protocol Layer (`src/protocol/`)

Connection management, protocol agreements, and self-healing.

- **`negotiator.ts`** - Connection establishment. `connect(sourceId, targetId)`: fetches manifests from Registry, checks compatibility (shared interface IDs). If compatible → direct agreement, no proxy. If incompatible → `ProxyGenerator.generateProxy()` → installs `ProxyInterceptor` on MessageBus. `disconnect()` removes interceptor, kills proxy. `renegotiate()` hot-swaps proxy (kill old → generate new with error context → install new interceptor). Well-known ID: `NEGOTIATOR_ID`.
- **`agreement.ts`** - Agreement utilities and `AgreementStore`. Utility functions: `isExpired()`, `needsHealthCheck()`, `createAgreementId()`, `validateAgreement()`, `renewAgreement()`, `mergeBindings()`. Store: indexed by ID and participant. `getBetween()`, `getExpired()`, `getNeedingHealthCheck()`.
- **`health-monitor.ts`** - Connection health monitoring. Per-connection tracking: messageCount, errorCount, timestamped errors. Rolling window (default 60s) with error pruning. Trigger: `errorRate >= errorThreshold` (default 10%) when `messageCount >= minMessages` (default 10). Periodic checks (default 5s). Calls `Negotiator.renegotiate()` with recent error context. Well-known ID: `HEALTH_MONITOR_ID`. `INCOMPREHENSION_ERRORS`: `PARSE_ERROR`, `UNKNOWN_METHOD`, `INVALID_PAYLOAD`, `SCHEMA_MISMATCH`, `TYPE_ERROR`, `SEMANTIC_ERROR`.

### 3.6 LLM Layer (`src/llm/`)

Provider-agnostic LLM integration.

- **`provider.ts`** - `LLMProvider` interface: `name`, `isAvailable()`, `complete()`, `stream?()`. `LLMMessage`: `{ role, content }`. `BaseLLMProvider` abstract base with shared fetch and header building. `LLMProviderRegistry` for managing multiple providers.
- **`anthropic.ts`** - Claude API. Separates system message. Default model: `claude-3-5-sonnet-20241022`. SSE streaming. `x-api-key` authentication.
- **`openai.ts`** - Chat Completions API. Default model: `gpt-4-turbo-preview`. SSE streaming with `[DONE]` sentinel. Bearer token auth.
- **`ollama.ts`** - Local LLM at `http://localhost:11434`. Default model: `llama3.2`. Availability detection via `/api/tags` (2s timeout). NDJSON streaming. No API key.

### 3.7 Network Layer (`src/network/`)

Cross-machine communication abstraction.

- **`transport.ts`** - Abstract `Transport` with state machine: `disconnected` → `connecting` → `connected` → `error`. `TransportEvents` callbacks: onConnect, onDisconnect, onMessage, onError, onStateChange. `MockTransport.pair()` for in-process paired testing. `TransportRegistry` for managing named transports.
- **`websocket.ts`** - `WebSocketTransport` with reconnection (exponential backoff: `delay * 2^attempt`) and heartbeat. `WebSocketConnectionManager` for multi-peer management.

Integration: MessageBus notifies `'undeliverable'` subscribers when a message target isn't locally registered. The network layer subscribes to these and routes through the appropriate Transport.

### 3.8 Sandbox Layer (`src/sandbox/`)

Secure WASM execution for user-created objects.

- **`wasm-loader.ts`** - `WasmObject` wrapper around `WebAssembly.Instance`. String read/write helpers for WASM memory. Bump allocator fallback when module lacks `alloc` export. `loadWasmObject()`, `compileWasmModule()`, `validateWasmModule()` (checks for required `memory` and `handle` exports).
- **`wasm-imports.ts`** - Capability-enforced import table. `WasmImportContext`: objectId, capabilities, memory accessor, send/log callbacks. Namespaces: `abjects` (send, log, get_time with capability checks), `env` (abort handler for AssemblyScript, seed), `console` (log/warn/error).
- **`worker-runtime.ts`** - Main thread ↔ Worker bridge via `WorkerRuntime`. `spawn()` sends WASM bytes to worker, resolves on 'ready'. `sendMessage()` posts serialized `AbjectMessage`. Routes worker messages back through MessageBus. Singleton.

### 3.9 UI Layer (`src/ui/`)

Browser application shell and canvas rendering.

- **`app.ts`** - Application shell. Creates canvas element, Compositor, UIServer, Runtime. `App.start()` starts Runtime and sets up input listeners. `createApp()` factory for one-line bootstrap.
- **`compositor.ts`** - Canvas-based surface compositor. Each surface is an `OffscreenCanvas` with its own 2D context. `requestAnimationFrame` render loop (only renders when `needsRender` flag set). Z-order sorted rendering (bottom-to-top). DPI-aware (`devicePixelRatio` scaling). Draw commands: `rect` (optional rounded corners), `text`, `line`, `image`, `path`, `clear`. Hit testing: `surfaceAt(x, y)` iterates reverse z-order.

## 4. Data Flow Diagrams

### 4.1 Bootstrap Sequence

```
App.createApp({ container }) →
  creates HTMLCanvasElement, Compositor, UIServer, Runtime →
  Runtime.start() →
    MessageBus created →
    Factory.setBus(bus), Factory.setRegistry(registry) →
    Registry.init(bus) → registers itself →
    Factory.init(bus) → registers itself →
    ensure(registry.objectCount >= 2) →

main() →
  LLMObject.configure({ apiKeys }) → runtime.spawn(llm) →
  runtime.spawn(httpClient, storage, timer, clipboard, console, filesystem) →
  ProxyGenerator.setLLM(llm) → runtime.spawn(proxyGenerator) →
  Negotiator.setDependencies(registry, factory, proxyGenerator, bus) → runtime.spawn(negotiator) →
  HealthMonitor.setNegotiator(negotiator) → startMonitoring() → runtime.spawn(healthMonitor) →
  ObjectCreator.setDependencies(llm, registry, factory) → runtime.spawn(objectCreator) →
  // System ready - all objects spawned and health monitoring started
```

### 4.2 Message Flow

```
Object A:
  this.send(msg) →
    Abject.send() →
      require(bus !== undefined)
      bus.send(msg) →
        require(messageId !== '', recipient !== '')
        interceptor pipeline (each returns 'pass', 'drop', or transformed msg) →
        if recipient not local → notifyUndeliverable (for network layer)
        else → mailbox.send(msg) → messageCount++ →
          handler = handlers.get(recipient) →
          msg = mailbox.tryReceive() →
          await handler(msg) →
            Abject.handleMessage() →
              if reply/error → resolve pending request promise
              else → find method handler → execute → if request, auto-reply
```

### 4.3 Proxy Generation Flow

```
Negotiator.connect(sourceId, targetId) →
  registry.lookupObject(sourceId) → sourceManifest
  registry.lookupObject(targetId) → targetManifest
  checkCompatibility(source, target) →
    if shared interface IDs → createDirectAgreement (no proxy)
    else →
      proxyGenerator.generateProxy(sourceId, targetId, sourceManifest, targetManifest) →
        LLM receives both manifests →
        LLM generates TypeScript proxy code + manifest →
        returns GeneratedProxy { code, manifest, agreement }
      spawnProxy(generated) → proxyId
      interceptor = new ProxyInterceptor(sourceId, targetId, proxyId)
      bus.addInterceptor(interceptor)
      connections.set(agreementId, { agreement, proxyId, interceptor })
  notifyConnectionEstablished(agreement) →
    event → sourceId: 'connectionEstablished'
    event → targetId: 'connectionEstablished'
```

### 4.4 Self-Healing Flow

```
HealthMonitor (every 5s):
  checkAllHealth() →
    for each tracked connection:
      pruneOldErrors(health) → remove errors outside 60s window
      if messageCount < 10 → skip
      errorRate = (errorCount / messageCount) * 100
      if errorRate >= 10% →
        errorContext = last 5 errors formatted as strings
        triggerRenegotiation(agreementId, errorContext) →
          negotiator.renegotiate(agreementId, errorContext) →
            proxyGenerator.regenerateProxy(agreementId, errorContext) →
              LLM receives original manifests + error context
              LLM generates improved proxy code
            factory.kill(oldProxyId)
            spawnProxy(regenerated) → newProxyId
            bus.removeInterceptor(oldInterceptor)
            bus.addInterceptor(new ProxyInterceptor(..., newProxyId))
        reset counters (messageCount=0, errorCount=0, errors=[])
```

### 4.5 WASM Object Execution Flow

```
Main Thread:
  WorkerRuntime.spawn(objectId, wasmBytes) →
    postMessage({ type: 'spawn', objectId, wasmCode }) →

Worker Thread:
  onmessage → type 'spawn' →
    WebAssembly.compile(wasmCode) →
    createImports(objectId, capabilities) →
      abjects.send (requires SEND_MESSAGE)
      abjects.log (requires LOG)
      abjects.get_time (requires TIME)
      env.abort (AssemblyScript handler)
    WebAssembly.instantiate(module, imports) →
    instance.exports.init(statePtr, stateLen) →
    postMessage({ type: 'status', objectId, status: 'ready' })

Messages routed via postMessage bridge:
  Main → Worker: { type: 'message', objectId, message: serialized }
  Worker → Main: { type: 'message', objectId, message: serialized }
```

## 5. Key Design Decisions

### 5.1 Why Everything is an Object

Uniform interface for discovery, monitoring, and lifecycle management. System services can be replaced, extended, or composed like any other object. The Registry discovers capabilities the same way it discovers user objects. The LLM can read manifests of system objects the same way it reads user objects.

### 5.2 Why Design by Contract is Always On

From the source code: "correctness over performance." In a dynamic message-passing system where objects may be LLM-generated, early failure detection is critical. Contracts document expected behavior at every boundary and catch violations immediately rather than propagating corrupt state.

### 5.3 Why LLM-Generated Proxies

Objects with incompatible interfaces can still communicate. The proxy is a real object in the system - it has a manifest, receives messages, and follows the same protocol. When it fails, the LLM can regenerate it with error context from the previous attempt, progressively improving the translation.

### 5.4 Why Canvas-Based UI (X11 Model)

Each object gets an isolated `OffscreenCanvas` surface. The compositor manages z-ordering and rendering. No DOM manipulation by objects - all rendering through draw commands. This provides:
- Isolation between objects (each draws to its own canvas)
- Centralized compositing (one render loop)
- Familiar model (X11 surface/window semantics)

### 5.5 Why Web Workers and WASM

User objects run in a Web Worker (isolated from main thread). WASM provides CPU-level sandboxing. Capability-enforced imports prevent unauthorized system access - a user object can only send messages (if it has `SEND_MESSAGE`), log (if `LOG`), or read time (if `TIME`). All other system access goes through capability objects via message passing.

## 6. Extension Points

### Adding a New Object

1. Create file, extend `Abject`, define manifest with `InterfaceDeclaration`
2. Register handlers for all interface methods
3. Use contracts throughout
4. Export well-known ID constant
5. Add to `src/index.ts` exports and spawn in `main()`

### Adding a New Capability Object

1. Create in `src/objects/capabilities/`
2. Define capability IDs in `src/core/capability.ts`
3. Set `providedCapabilities` in manifest, tag with `['capability', '<name>']`
4. Follow existing patterns (domain security, fallbacks)

### Adding a New LLM Provider

1. Create in `src/llm/`, implement `LLMProvider` or extend `BaseLLMProvider`
2. Include `complete()` and optionally `stream()`
3. Add configuration to `LLMObject.configure()`

### Adding a New Transport

1. Create in `src/network/`, extend `Transport` abstract class
2. Implement `connect()`, `disconnect()`, `sendMessage()`
3. Follow the state machine: `disconnected` → `connecting` → `connected` → `error`
4. Register with `TransportRegistry`
