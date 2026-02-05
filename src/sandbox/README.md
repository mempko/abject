# src/sandbox/ - WASM Sandboxing

Secure sandboxed execution for user-created objects. WASM modules run in a Web Worker with capability-enforced imports.

## Files

### wasm-loader.ts

WASM module loading and instantiation.

- **`WasmObject`**: wrapper around `WebAssembly.Instance`
  - `init(state)`, `handle(message)`, `manifest()` - standard WASM object interface
  - String read/write helpers for WASM linear memory
  - Bump allocator fallback when module has no `alloc` export
- **`loadWasmObject(bytes, context)`**: compile and instantiate with import context
- **`compileWasmModule(bytes)`**: pre-compile for later instantiation
- **`validateWasmModule(module)`**: verify required exports (`memory`, `handle`)

### wasm-imports.ts

Capability-enforced import table for WASM modules.

- **`WasmImportContext`**: `objectId`, `capabilities`, `memory` accessor, `send`/`log` callbacks
- **`abjects` namespace**:
  - `send(msgPtr, msgLen)` - requires `SEND_MESSAGE` capability
  - `log(level, msgPtr, msgLen)` - requires `LOG` capability
  - `get_time()` - requires `TIME` capability
- **`env` namespace**: `abort` handler (AssemblyScript compatible), `seed` for random
- **`console` namespace**: `log`, `warn`, `error` for debugging
- **`createTestContext()`**: minimal context for testing

### worker-runtime.ts

Main thread interface to the Web Worker.

- **`WorkerRuntime`**: manages `postMessage` bridge to `object-runtime.worker.ts`
  - `spawn(objectId, wasmBytes)` → sends to worker → resolves when object reports `ready`
  - `sendMessage(objectId, message)` → serializes and posts to worker
  - Routes messages from worker back through MessageBus
- **Singleton**: `getWorkerRuntime()`, `resetWorkerRuntime()` for testing

## Security Model

User objects can only:
- **Send messages** (if they have `SEND_MESSAGE` capability)
- **Log messages** (if they have `LOG` capability)
- **Read current time** (if they have `TIME` capability)

All other system access must go through capability objects via message passing. The WASM sandbox prevents direct access to DOM, network, storage, or any other browser API.
