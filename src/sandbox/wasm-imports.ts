/**
 * Capability-based WASM imports.
 */

import { AbjectId, AbjectMessage } from '../core/types.js';
import { CapabilitySet, Capabilities } from '../core/capability.js';
import { require } from '../core/contracts.js';

/**
 * Context for WASM imports - provides access to system capabilities.
 *
 * `isTargetAllowed` gates outbound messages at the routing.to level:
 * a WASM object with SEND_MESSAGE can still only address peers the
 * runtime vouches for (e.g. within the same workspace). If omitted,
 * no target-level filtering is applied.
 */
export interface WasmImportContext {
  objectId: AbjectId;
  capabilities: CapabilitySet;
  memory: () => WebAssembly.Memory;
  onSend: (message: AbjectMessage) => void;
  onLog: (level: number, message: string) => void;
  isTargetAllowed?: (target: AbjectId) => boolean;
}

/**
 * Minimal structural check for an AbjectMessage decoded from WASM memory.
 * We only verify the routing fields we rely on here; the full shape is
 * enforced by the main-thread bus and downstream handlers.
 */
function looksLikeAbjectMessage(value: unknown): value is AbjectMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as { header?: unknown; routing?: unknown; payload?: unknown };
  if (!msg.header || typeof msg.header !== 'object') return false;
  if (!msg.routing || typeof msg.routing !== 'object') return false;
  const routing = msg.routing as { from?: unknown; to?: unknown };
  if (typeof routing.to !== 'string' || routing.to.length === 0) return false;
  // `from` is overwritten by the host; presence not required.
  return true;
}

/**
 * Read a string from WASM memory.
 */
function readString(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number
): string {
  const bytes = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

/**
 * Create WASM imports for an object.
 */
export function createWasmImports(
  context: WasmImportContext
): WebAssembly.Imports {
  const { objectId, capabilities, memory, onSend, onLog, isTargetAllowed } = context;

  return {
    abjects: {
      /**
       * Send a message to another object.
       * Requires SEND_MESSAGE capability.
       */
      send: (msgPtr: number, msgLen: number): void => {
        require(
          capabilities.has(Capabilities.SEND_MESSAGE),
          'SEND_MESSAGE capability required'
        );

        const msgJson = readString(memory(), msgPtr, msgLen);
        let parsed: unknown;
        try {
          parsed = JSON.parse(msgJson);
        } catch {
          onLog(3, `WASM send: invalid JSON (len=${msgLen})`);
          return;
        }
        if (!looksLikeAbjectMessage(parsed)) {
          onLog(3, 'WASM send: malformed AbjectMessage');
          return;
        }

        const message = parsed;
        // Ensure sender is this object
        message.routing.from = objectId;

        if (isTargetAllowed && !isTargetAllowed(message.routing.to)) {
          onLog(2, `WASM send blocked: target ${message.routing.to} not allowed for ${objectId}`);
          return;
        }

        onSend(message);
      },

      /**
       * Log a message.
       * Requires LOG capability.
       */
      log: (level: number, msgPtr: number, msgLen: number): void => {
        require(capabilities.has(Capabilities.LOG), 'LOG capability required');

        const message = readString(memory(), msgPtr, msgLen);
        onLog(level, message);
      },

      /**
       * Get current time in milliseconds.
       * Requires TIME capability.
       */
      get_time: (): number => {
        require(capabilities.has(Capabilities.TIME), 'TIME capability required');
        return Date.now();
      },
    },

    env: {
      /**
       * AssemblyScript abort handler.
       */
      abort: (
        msgPtr: number,
        filePtr: number,
        line: number,
        col: number
      ): void => {
        let msg = 'abort';

        if (msgPtr) {
          try {
            // AssemblyScript strings are length-prefixed UTF-16
            const mem = memory();
            const len = new DataView(mem.buffer).getUint32(msgPtr - 4, true);
            const bytes = new Uint8Array(mem.buffer, msgPtr, len * 2);
            msg = new TextDecoder('utf-16le').decode(bytes);
          } catch {
            // Ignore decoding errors
          }
        }

        let file = '';
        if (filePtr) {
          try {
            const mem = memory();
            const len = new DataView(mem.buffer).getUint32(filePtr - 4, true);
            const bytes = new Uint8Array(mem.buffer, filePtr, len * 2);
            file = new TextDecoder('utf-16le').decode(bytes);
          } catch {
            // Ignore decoding errors
          }
        }

        const error = `WASM abort: ${msg} at ${file}:${line}:${col}`;
        onLog(3, error); // Error level
        throw new Error(error);
      },

      /**
       * Memory allocation seed (for some WASM runtimes).
       */
      seed: (): number => {
        return Math.random() * Date.now();
      },
    },

    // Console imports (for debugging)
    console: {
      log: (ptr: number, len: number): void => {
        const msg = readString(memory(), ptr, len);
        onLog(1, msg);
      },
      warn: (ptr: number, len: number): void => {
        const msg = readString(memory(), ptr, len);
        onLog(2, msg);
      },
      error: (ptr: number, len: number): void => {
        const msg = readString(memory(), ptr, len);
        onLog(3, msg);
      },
    },
  };
}

/**
 * Create a minimal import context for testing.
 */
export function createTestContext(
  objectId: AbjectId,
  options: {
    memory?: WebAssembly.Memory;
    onSend?: (msg: AbjectMessage) => void;
    onLog?: (level: number, msg: string) => void;
  } = {}
): WasmImportContext {
  const mem =
    options.memory ??
    new WebAssembly.Memory({ initial: 1, maximum: 10 });

  return {
    objectId,
    capabilities: new CapabilitySet([
      { capability: Capabilities.SEND_MESSAGE, objectId },
      { capability: Capabilities.LOG, objectId },
      { capability: Capabilities.TIME, objectId },
    ]),
    memory: () => mem,
    onSend: options.onSend ?? (() => {}),
    onLog: options.onLog ?? ((level, msg) => console.log(`[${level}]`, msg)),
  };
}

// Log levels
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;
