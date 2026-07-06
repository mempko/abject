/**
 * Low-level wrapper around one instantiated WASM abject module.
 *
 * Owns the WebAssembly.Instance, the capability-gated host imports, and a
 * minimal WASI shim (no filesystem, no sockets) so C/C++ standard libraries
 * link and run. WasmAbject drives this class; nothing else should.
 *
 * Threading model: JS is single-threaded and no import re-enters the guest,
 * so guest calls never interleave. Envelopes emitted mid-call via
 * `abjects.emit` are queued and drained together with the call's returned
 * envelope array, preserving order (emitted first, then returned).
 */

import { AbjectManifest } from '../core/types.js';
import { require } from '../core/contracts.js';
import { CapabilitySet, Capabilities, getDefaultCapabilities } from '../core/capability.js';
import {
  WASM_ABI_VERSION,
  WasmAbjectExports,
  InboundEnvelope,
  OutboundEnvelope,
  WasmInitInfo,
  readGuestBuffer,
  readGuestString,
  encodeUtf8,
  validateWasmModule,
  looksLikeManifest,
} from './wasm-abi.js';

export interface WasmHostContext {
  objectId: string;
  capabilities: CapabilitySet;
  onLog: (level: number, message: string) => void;
}

const OUTBOUND_KINDS = new Set([
  'reply', 'error', 'request', 'event', 'changed', 'persist', 'log',
]);

// WASI preview1 errno values used by the shim.
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

export class WasmInstance {
  private readonly exports: WasmAbjectExports;
  private readonly ctx: WasmHostContext;
  private emitted: OutboundEnvelope[] = [];
  private _manifest?: AbjectManifest;
  private initCalled = false;

  private constructor(exports: WasmAbjectExports, ctx: WasmHostContext) {
    this.exports = exports;
    this.ctx = ctx;
  }

  /**
   * Compile, validate, and instantiate a module. Verifies required exports
   * and the ABI version before returning.
   */
  static async create(bytes: Uint8Array, ctx: WasmHostContext): Promise<WasmInstance> {
    require(bytes.byteLength > 0, 'module bytes must not be empty');

    const module = await WebAssembly.compile(bytes as BufferSource);
    const problems = validateWasmModule(module);
    require(problems.length === 0, `module does not conform to the abject ABI: ${problems.join('; ')}`);

    // The memory accessor must work before instantiation completes because
    // imports close over it; resolve lazily through the instance box.
    const box: { instance?: WebAssembly.Instance } = {};
    const memory = (): WebAssembly.Memory => {
      require(box.instance !== undefined, 'guest called an import before instantiation completed');
      return (box.instance!.exports as unknown as WasmAbjectExports).memory;
    };

    const self = new WasmInstance(undefined as unknown as WasmAbjectExports, ctx);
    const imports = self.buildImports(memory);
    box.instance = await WebAssembly.instantiate(module, imports);

    const exports = box.instance.exports as unknown as WasmAbjectExports;
    (self as unknown as { exports: WasmAbjectExports }).exports = exports;

    // WASI reactor initialization (sets up libc) before any ABI call.
    exports._initialize?.();

    const abi = exports.abject_abi_version();
    require(
      abi === WASM_ABI_VERSION,
      `module ABI version ${abi} is not supported (host speaks v${WASM_ABI_VERSION})`,
    );

    return self;
  }

  /** The module's self-declared manifest. */
  manifest(): AbjectManifest {
    if (this._manifest) return this._manifest;

    const ptr = this.exports.abject_manifest();
    require(ptr !== 0, 'module returned a null manifest');
    const parsed: unknown = JSON.parse(readGuestBuffer(this.exports.memory, ptr));
    require(looksLikeManifest(parsed), 'module manifest is not a structured AbjectManifest');

    this._manifest = parsed as AbjectManifest;
    return this._manifest;
  }

  /** One-time initialization. Returns the guest's startup envelopes. */
  init(info: WasmInitInfo): OutboundEnvelope[] {
    require(!this.initCalled, 'init may only be called once');
    this.initCalled = true;

    const { ptr, len } = this.writeToGuest(JSON.stringify(info));
    const resultPtr = this.exports.abject_init(ptr, len);
    return this.drainOutput(resultPtr);
  }

  /** Deliver one inbound envelope; returns the guest's outbound envelopes. */
  handle(envelope: InboundEnvelope): OutboundEnvelope[] {
    require(this.initCalled, 'handle called before init');

    const { ptr, len } = this.writeToGuest(JSON.stringify(envelope));
    const resultPtr = this.exports.abject_handle(ptr, len);
    return this.drainOutput(resultPtr);
  }

  /** Durable data snapshot, or undefined when the module doesn't export one. */
  snapshot(): Record<string, unknown> | undefined {
    if (!this.exports.abject_snapshot) return undefined;
    const ptr = this.exports.abject_snapshot();
    if (ptr === 0) return undefined;

    const parsed: unknown = JSON.parse(readGuestBuffer(this.exports.memory, ptr));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Allocate in the guest and copy UTF-8 bytes. Views are taken AFTER the
   *  alloc call because growth detaches previous ArrayBuffers. */
  private writeToGuest(text: string): { ptr: number; len: number } {
    const bytes = encodeUtf8(text);
    const ptr = this.exports.abject_alloc(bytes.length);
    require(ptr > 0, `guest allocation of ${bytes.length} bytes failed`);
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  /** Combine emitted + returned envelopes for one guest call. */
  private drainOutput(resultPtr: number): OutboundEnvelope[] {
    const out = this.emitted;
    this.emitted = [];

    if (resultPtr !== 0) {
      const parsed: unknown = JSON.parse(readGuestBuffer(this.exports.memory, resultPtr));
      require(Array.isArray(parsed), 'guest result must be a JSON array of envelopes');
      for (const env of parsed) {
        if (this.isOutboundEnvelope(env)) {
          out.push(env);
        } else {
          this.ctx.onLog(2, `dropping malformed outbound envelope: ${JSON.stringify(env).slice(0, 200)}`);
        }
      }
    }

    return out;
  }

  private isOutboundEnvelope(value: unknown): value is OutboundEnvelope {
    return (
      !!value &&
      typeof value === 'object' &&
      OUTBOUND_KINDS.has((value as { kind?: string }).kind ?? '')
    );
  }

  private buildImports(memory: () => WebAssembly.Memory): WebAssembly.Imports {
    const { capabilities, onLog } = this.ctx;

    return {
      abjects: {
        emit: (ptr: number, len: number): void => {
          require(
            capabilities.has(Capabilities.SEND_MESSAGE),
            'SEND_MESSAGE capability required',
          );
          let parsed: unknown;
          try {
            parsed = JSON.parse(readGuestString(memory(), ptr, len));
          } catch {
            onLog(3, `emit: invalid JSON (len=${len})`);
            return;
          }
          if (!this.isOutboundEnvelope(parsed)) {
            onLog(3, 'emit: malformed envelope');
            return;
          }
          this.emitted.push(parsed);
        },

        log: (level: number, ptr: number, len: number): void => {
          require(capabilities.has(Capabilities.LOG), 'LOG capability required');
          onLog(level, readGuestString(memory(), ptr, len));
        },

        time_ms: (): number => {
          require(capabilities.has(Capabilities.TIME), 'TIME capability required');
          return Date.now();
        },
      },

      wasi_snapshot_preview1: this.buildWasiShim(memory),

      env: {
        /** AssemblyScript-style abort (length-prefixed UTF-16 strings). */
        abort: (msgPtr: number, filePtr: number, line: number, col: number): void => {
          const readAsString = (ptr: number): string => {
            if (!ptr) return '';
            try {
              const mem = memory();
              const len = new DataView(mem.buffer).getUint32(ptr - 4, true);
              return new TextDecoder('utf-16le').decode(
                new Uint8Array(mem.buffer, ptr, len * 2),
              );
            } catch {
              return '';
            }
          };
          const detail = `WASM abort: ${readAsString(msgPtr) || 'abort'} at ${readAsString(filePtr)}:${line}:${col}`;
          onLog(3, detail);
          throw new Error(detail);
        },
        seed: (): number => Math.random() * Date.now(),
      },
    };
  }

  /**
   * Minimal WASI preview1 shim: enough for wasi-libc to initialize and for
   * stdout/stderr to reach the log. Deliberately no filesystem, sockets,
   * args, or environment — all real capabilities flow through envelopes.
   */
  private buildWasiShim(memory: () => WebAssembly.Memory): Record<string, WebAssembly.ImportValue> {
    const { onLog } = this.ctx;

    return {
      fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
        const mem = memory();
        const view = new DataView(mem.buffer);
        let written = 0;
        const chunks: string[] = [];
        for (let i = 0; i < iovsLen; i++) {
          const bufPtr = view.getUint32(iovsPtr + i * 8, true);
          const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
          if (bufLen > 0) {
            chunks.push(readGuestString(mem, bufPtr, bufLen));
            written += bufLen;
          }
        }
        view.setUint32(nwrittenPtr, written, true);
        const text = chunks.join('').replace(/\n+$/, '');
        if (text.length > 0) onLog(fd === 2 ? 3 : 1, text);
        return ERRNO_SUCCESS;
      },

      fd_close: (): number => ERRNO_BADF,
      fd_seek: (_fd: number, _offset: bigint, _whence: number, newOffsetPtr: number): number => {
        new DataView(memory().buffer).setBigUint64(newOffsetPtr, 0n, true);
        return ERRNO_BADF;
      },
      fd_fdstat_get: (fd: number, statPtr: number): number => {
        if (fd > 2) return ERRNO_BADF;
        // filetype = character_device, zero flags/rights.
        const view = new DataView(memory().buffer);
        view.setUint8(statPtr, 2);
        view.setUint8(statPtr + 1, 0);
        view.setUint16(statPtr + 2, 0, true);
        view.setBigUint64(statPtr + 8, 0n, true);
        view.setBigUint64(statPtr + 16, 0n, true);
        return ERRNO_SUCCESS;
      },

      environ_sizes_get: (countPtr: number, sizePtr: number): number => {
        const view = new DataView(memory().buffer);
        view.setUint32(countPtr, 0, true);
        view.setUint32(sizePtr, 0, true);
        return ERRNO_SUCCESS;
      },
      environ_get: (): number => ERRNO_SUCCESS,
      args_sizes_get: (countPtr: number, sizePtr: number): number => {
        const view = new DataView(memory().buffer);
        view.setUint32(countPtr, 0, true);
        view.setUint32(sizePtr, 0, true);
        return ERRNO_SUCCESS;
      },
      args_get: (): number => ERRNO_SUCCESS,

      clock_time_get: (_clockId: number, _precision: bigint, timePtr: number): number => {
        new DataView(memory().buffer).setBigUint64(
          timePtr,
          BigInt(Date.now()) * 1_000_000n,
          true,
        );
        return ERRNO_SUCCESS;
      },

      random_get: (bufPtr: number, bufLen: number): number => {
        const mem = memory();
        let offset = 0;
        while (offset < bufLen) {
          const chunk = Math.min(bufLen - offset, 65536);
          crypto.getRandomValues(new Uint8Array(mem.buffer, bufPtr + offset, chunk));
          offset += chunk;
        }
        return ERRNO_SUCCESS;
      },

      proc_exit: (code: number): void => {
        throw new Error(`WASM guest called proc_exit(${code})`);
      },
      sched_yield: (): number => ERRNO_SUCCESS,
      poll_oneoff: (): number => ERRNO_NOSYS,
    };
  }
}

/**
 * Extract the self-declared manifest from module bytes without spawning an
 * object. Used by `pnpm forge` at package time and by install-time
 * validation. Instantiates the module once with a throwaway context.
 */
export async function extractWasmManifest(bytes: Uint8Array): Promise<AbjectManifest> {
  const objectId = 'wasm:manifest-extraction';
  const instance = await WasmInstance.create(bytes, {
    objectId,
    capabilities: new CapabilitySet(getDefaultCapabilities(objectId)),
    onLog: () => { /* discard */ },
  });
  return instance.manifest();
}
