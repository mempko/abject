# src/ - Source Root

Main source directory for the Abjects system. All TypeScript modules organized by architectural layer.

## Directory Structure

| Directory | Purpose |
|-----------|---------|
| `core/` | Foundation: types, contracts, message protocol, base Abject class, capabilities |
| `runtime/` | System orchestrator, MessageBus, Mailbox, Supervisor |
| `objects/` | System objects: Registry, Factory, LLMObject, ObjectCreator, ProxyGenerator, UIServer |
| `objects/capabilities/` | Capability objects: HttpClient, Storage, Timer, Clipboard, Console, FileSystem |
| `protocol/` | Connection negotiation, agreements, health monitoring |
| `llm/` | LLM provider interface and implementations (Anthropic, OpenAI, Ollama) |
| `network/` | Transport abstraction, WebSocket, MockTransport |
| `sandbox/` | WASM loader, capability-enforced imports, WorkerRuntime |
| `ui/` | Application shell, Canvas compositor |

## Entry Point

`index.ts` is the browser entry point. It:
1. Exports the full public API (re-exports from all modules)
2. Contains `main()` which bootstraps the entire system
3. Exposes `window.abjects` for debugging

## Bootstrap Order

1. `App` creates Canvas, Compositor, UIServer, Runtime
2. `Runtime.start()` creates MessageBus, initializes Registry and Factory on the bus
3. `main()` spawns LLMObject, then all 6 capability objects
4. `main()` spawns ProxyGenerator (with LLM ref), Negotiator (with dependencies), HealthMonitor, ObjectCreator
5. System logs object count and exposes debug globals

## Import Convention

All imports use `.js` extension per ESModule bundler resolution:
```typescript
import { Abject } from './core/abject.js';
```
