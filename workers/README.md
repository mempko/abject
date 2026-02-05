# workers/ - Web Worker Runtime

Contains the Web Worker that provides an isolated execution environment for WASM-based user objects. Communicates with the main thread via `postMessage`.

## Files

### object-runtime.worker.ts

The Web Worker entry point. Manages WASM object lifecycles in isolation from the main thread.

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
