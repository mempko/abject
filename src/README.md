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

`index.ts` is the public API re-export barrel. It re-exports all types, objects, and utilities from the various modules. The system bootstrap lives in `server/index.ts`.

## Import Convention

All imports use `.js` extension per ESModule bundler resolution:
```typescript
import { Abject } from './core/abject.js';
```
