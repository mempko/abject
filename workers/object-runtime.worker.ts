/**
 * Web Worker for object runtime - runs objects in isolated context.
 */

// Type alias for object IDs (same as in types.ts)
type AbjectId = string;

// Simple require assertion (contracts.ts is not available in worker)
function require(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[REQUIRE] ${message}`);
  }
}

// Message types between main thread and worker
export type WorkerMessageType =
  | 'init'
  | 'spawn'
  | 'message'
  | 'kill'
  | 'status'
  | 'ready'
  | 'error'
  | 'log';

export interface WorkerMessage {
  type: WorkerMessageType;
  payload: unknown;
}

export interface SpawnPayload {
  objectId: AbjectId;
  wasmCode: ArrayBuffer;
  initialState?: unknown;
}

export interface MessagePayload {
  objectId: AbjectId;
  message: string; // Serialized AbjectMessage
}

// Worker state
let initialized = false;
const objects = new Map<AbjectId, WasmObjectInstance>();

interface WasmObjectInstance {
  objectId: AbjectId;
  instance: WebAssembly.Instance;
  memory: WebAssembly.Memory;
}

/**
 * Initialize the worker runtime.
 */
function init(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  postMessage({ type: 'ready', payload: null });
  console.log('[WORKER] Object runtime initialized');
}

/**
 * Spawn a new WASM object in the worker.
 */
async function spawnObject(payload: SpawnPayload): Promise<void> {
  require(payload.objectId !== '', 'objectId is required');
  require(payload.wasmCode !== undefined, 'wasmCode is required');

  try {
    // Create imports for the WASM module
    const imports = createWasmImports(payload.objectId);

    // Compile and instantiate the WASM module
    const module = await WebAssembly.compile(payload.wasmCode);
    const instance = await WebAssembly.instantiate(module, imports);

    // Get the memory
    const memory = instance.exports.memory as WebAssembly.Memory;
    require(memory !== undefined, 'WASM module must export memory');

    // Store the instance
    objects.set(payload.objectId, {
      objectId: payload.objectId,
      instance,
      memory,
    });

    // Call init if available
    const initFn = instance.exports.init as
      | ((statePtr: number, stateLen: number) => void)
      | undefined;

    if (initFn && payload.initialState) {
      const stateJson = JSON.stringify(payload.initialState);
      const stateBytes = new TextEncoder().encode(stateJson);
      const ptr = allocateMemory(instance, stateBytes.length);
      new Uint8Array(memory.buffer, ptr, stateBytes.length).set(stateBytes);
      initFn(ptr, stateBytes.length);
    }

    postMessage({
      type: 'status',
      payload: { objectId: payload.objectId, status: 'ready' },
    });
  } catch (error) {
    postMessage({
      type: 'error',
      payload: {
        objectId: payload.objectId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Deliver a message to an object.
 */
function deliverMessage(payload: MessagePayload): void {
  const obj = objects.get(payload.objectId);
  if (!obj) {
    postMessage({
      type: 'error',
      payload: { objectId: payload.objectId, error: 'Object not found' },
    });
    return;
  }

  try {
    const handleFn = obj.instance.exports.handle as
      | ((msgPtr: number, msgLen: number) => number)
      | undefined;

    if (!handleFn) {
      throw new Error('Object does not export handle function');
    }

    // Encode message to memory
    const msgBytes = new TextEncoder().encode(payload.message);
    const ptr = allocateMemory(obj.instance, msgBytes.length);
    new Uint8Array(obj.memory.buffer, ptr, msgBytes.length).set(msgBytes);

    // Call handle
    const resultPtr = handleFn(ptr, msgBytes.length);

    // Read result if any
    if (resultPtr > 0) {
      // Result is a length-prefixed string
      const resultLen = new DataView(obj.memory.buffer).getUint32(resultPtr, true);
      const resultBytes = new Uint8Array(
        obj.memory.buffer,
        resultPtr + 4,
        resultLen
      );
      const resultJson = new TextDecoder().decode(resultBytes);

      postMessage({
        type: 'message',
        payload: { objectId: payload.objectId, message: resultJson },
      });
    }
  } catch (error) {
    postMessage({
      type: 'error',
      payload: {
        objectId: payload.objectId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Kill an object.
 */
function killObject(objectId: AbjectId): void {
  objects.delete(objectId);
  postMessage({ type: 'status', payload: { objectId, status: 'stopped' } });
}

/**
 * Create WASM imports for an object.
 */
function createWasmImports(
  objectId: AbjectId
): WebAssembly.Imports {
  return {
    abjects: {
      send: (msgPtr: number, msgLen: number) => {
        const obj = objects.get(objectId);
        if (!obj) return;

        const msgBytes = new Uint8Array(obj.memory.buffer, msgPtr, msgLen);
        const msgJson = new TextDecoder().decode(msgBytes);

        // Send message to main thread for routing
        postMessage({ type: 'message', payload: { objectId, message: msgJson } });
      },

      log: (level: number, msgPtr: number, msgLen: number) => {
        const obj = objects.get(objectId);
        if (!obj) return;

        const msgBytes = new Uint8Array(obj.memory.buffer, msgPtr, msgLen);
        const msg = new TextDecoder().decode(msgBytes);

        postMessage({
          type: 'log',
          payload: { objectId, level, message: msg },
        });
      },

      get_time: () => Date.now(),
    },
    env: {
      abort: (msgPtr: number, _filePtr: number, line: number, col: number) => {
        const obj = objects.get(objectId);
        let msg = 'abort';
        if (obj && msgPtr) {
          // Try to read the abort message
          try {
            const len = new DataView(obj.memory.buffer).getUint32(msgPtr - 4, true);
            const bytes = new Uint8Array(obj.memory.buffer, msgPtr, len);
            msg = new TextDecoder('utf-16').decode(bytes);
          } catch {
            // Ignore
          }
        }
        throw new Error(`WASM abort at ${line}:${col}: ${msg}`);
      },
    },
  };
}

/**
 * Allocate memory in a WASM instance.
 */
function allocateMemory(
  instance: WebAssembly.Instance,
  size: number
): number {
  const allocFn = instance.exports.alloc as
    | ((size: number) => number)
    | undefined;

  if (allocFn) {
    return allocFn(size);
  }

  // Fallback: use memory end as allocation pointer
  const memory = instance.exports.memory as WebAssembly.Memory;
  const currentPages = memory.buffer.byteLength / 65536;
  const neededPages = Math.ceil((size + 1024) / 65536);

  if (neededPages > currentPages) {
    memory.grow(neededPages - currentPages);
  }

  // Simple bump allocator at end of memory
  return memory.buffer.byteLength - size - 1024;
}

// Handle messages from main thread
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'init':
      init();
      break;
    case 'spawn':
      await spawnObject(payload as SpawnPayload);
      break;
    case 'message':
      deliverMessage(payload as MessagePayload);
      break;
    case 'kill':
      killObject((payload as { objectId: AbjectId }).objectId);
      break;
    default:
      console.warn(`[WORKER] Unknown message type: ${type}`);
  }
};

// Auto-initialize
init();
