# CLAUDE.md - Working with the Abjects Codebase

## Project Overview

Abjects is an LLM-mediated distributed object system where objects communicate via message passing, negotiate protocols using an LLM, and self-heal when communication breaks down. Everything in the system is an object (Abject) - including the Registry, Factory, LLM service, and UI server.

**Tech Stack**: TypeScript, Vite, WASM (sandboxed objects), Canvas (X11-style UI), Playwright (E2E tests)

## Build & Test Commands

```bash
pnpm install                      # Install dependencies
pnpm dev                          # Vite dev server (http://localhost:5173)
pnpm build                        # tsc && vite build
pnpm preview                      # Preview production build
pnpm exec playwright install      # First time only - install browsers
pnpm test                         # Run Playwright E2E tests
```

Note: `pnpm test` auto-starts the Vite dev server via Playwright's `webServer` config.

## Project Structure

```
src/
  index.ts              # Entry point, public API exports, main() bootstrap
  core/                 # Types, contracts, message builders, base Abject class, capabilities
  runtime/              # Runtime orchestrator, MessageBus, Mailbox, Supervisor
  objects/              # System objects: Registry, Factory, LLMObject, ObjectCreator, ProxyGenerator, UIServer
  objects/capabilities/ # Capability objects: HttpClient, Storage, Timer, Clipboard, Console, FileSystem
  protocol/             # Negotiator, Agreement management, HealthMonitor
  llm/                  # LLM provider interface and implementations (Anthropic, OpenAI, Ollama)
  network/              # Transport abstraction, WebSocket, MockTransport
  sandbox/              # WASM loader, capability-enforced imports, WorkerRuntime
  ui/                   # App shell, Canvas Compositor
workers/
  object-runtime.worker.ts  # Web Worker for WASM object execution
tests/                       # Playwright E2E specs
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

### New Object

1. Create file in appropriate directory
2. Extend `Abject` with full manifest (include complete `InterfaceDeclaration` with method params, returns, descriptions)
3. Add handlers for every method in the interface
4. Use contracts for all preconditions/postconditions
5. Override `checkInvariants()` calling `super.checkInvariants()` first
6. Export well-known ID constant
7. Add to `src/index.ts` exports
8. Spawn in **both** `src/index.ts` `main()` **and** `server/index.ts` `main()` if it's a system object — these two bootstrap files must stay in sync

### New Capability Object

1. Create in `src/objects/capabilities/`
2. Define capability ID constants in `src/core/capability.ts`
3. Set `providedCapabilities` in manifest, tag with `['capability', '<name>']`
4. Follow existing patterns (see `http-client.ts` for domain allow/deny, `storage.ts` for IndexedDB)

### New LLM Provider

1. Create in `src/llm/`
2. Implement `LLMProvider` interface (or extend `BaseLLMProvider`)
3. Include both `complete()` and `stream()` methods
4. Add configuration to `LLMObject.configure()`
5. Export from `src/index.ts`

### New Tests

- Tests are Playwright E2E specs in `tests/`, not unit tests
- Tests run in browser context via `page.evaluate()`
- Use `page.waitForFunction()` to wait for `window.abjects` (system bootstrap)
- Tests needing LLM API keys or external services should use `test.skip()`

## Common Pitfalls

- **Worker context**: `object-runtime.worker.ts` has its own `require()` - can't import from `contracts.ts`
- **Object initialization**: All objects must be `init(bus)` before use; `factory.spawnInstance()` handles this
- **Mailbox bounds**: Default max queue size is 1000; sending to a full mailbox throws `ContractViolation`
- **API keys**: Set via `window.ANTHROPIC_API_KEY` / `window.OPENAI_API_KEY` globals before bootstrap
- **Compositor**: Needs a real `HTMLCanvasElement`; tests using compositor need browser context
- **Sequence numbers**: Per-sender, tracked in module-level state in `message.ts`; use `resetSequence()` in tests
- **Import extensions**: Always use `.js` in imports even though source files are `.ts`
- **Dual bootstrap**: System objects must be registered and spawned in both `src/index.ts` and `server/index.ts`. Missing one causes the object to not appear in server/client mode.

## Bootstrap Order

1. `App` creates Canvas, Compositor, UIServer, Runtime
2. `Runtime.start()` creates MessageBus, initializes Registry and Factory on the bus
3. `main()` spawns: LLMObject, HttpClient, Storage, Timer, Clipboard, Console, FileSystem
4. `main()` spawns: ProxyGenerator (with LLM ref), Negotiator (with dependencies), HealthMonitor, ObjectCreator
5. System exposes `window.abjects` for debugging

**Important:** There are two bootstrap paths that must stay in sync:
- `src/index.ts` — standalone browser mode (`pnpm dev`)
- `server/index.ts` — server/client mode (`pnpm serve` + `pnpm client`)

When adding a new system object, register its constructor and spawn it in **both** files.

## Dependencies

- **uuid**: Message ID generation (v4)
- **ajv**: JSON schema validation
- **assemblyscript**: WASM compilation toolchain (devDependency)
- **@playwright/test**: E2E testing framework
- **vite**: Build tool and dev server
- **typescript**: Language compiler
