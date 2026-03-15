# workers/ - Web Worker Runtime

Contains Web Workers and worker_threads entry points for isolated object execution. WASM-based objects use `object-runtime.worker.ts`; native Abject parallelism uses `abject-worker.ts` / `abject-worker-node.ts`.

## Files

### object-runtime.worker.ts

The Web Worker entry point for WASM objects. Manages WASM object lifecycles in isolation from the main thread.

### abject-worker.ts

Web Worker entry point for Abject parallelism. Runs a `WorkerBus` and hosts a subset of Abject instances (LLM, capabilities, editors, agents, etc.). Communicates with the main thread via structured clone messages.

### abject-worker-node.ts

Node.js `worker_threads` variant of `abject-worker.ts`. Same logic but uses `parentPort` instead of the Web Worker `self` API.

## Message Protocol (Main Thread ↔ Worker)

| Direction | Type | Payload | Response |
|-----------|------|---------|----------|
| Main → Worker | `init` | - | `ready` |
| Main → Worker | `spawn` | `{ objectId, wasmCode, initialState }` | `status { objectId, 'ready' }` |
| Both | `message` | `{ objectId, message }` | - |
| Main → Worker | `kill` | `{ objectId }` | `status { objectId, 'stopped' }` |
| Worker → Main | `error` | `{ objectId, error }` | - |
| Worker → Main | `log` | `{ objectId, level, message }` | - |

## Implementation Details

- Contains its own `require()` assertion (cannot import from `contracts.ts` in worker context)
- Creates WASM imports with `abjects.send`, `abjects.log`, `abjects.get_time`, `env.abort`
- Memory management: uses `alloc` export if available, falls back to bump allocation
- WASM messages serialized as length-prefixed UTF-8 strings
- Auto-initializes on load

## Architecture

```
Main Thread: WorkerRuntime (src/sandbox/worker-runtime.ts)
    <── postMessage ──>
Worker Thread: object-runtime.worker.ts
    └── WebAssembly.Instance (per object)
```
