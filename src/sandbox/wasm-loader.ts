/**
 * WASM module loader - loads and instantiates WASM objects.
 */

import {
  AbjectId,
  AbjectManifest,
  WasmObjectExports,
  AbjectMessage,
} from '../core/types.js';
import { require, ensure } from '../core/contracts.js';
import { serialize, deserialize } from '../core/message.js';
import { createWasmImports, WasmImportContext } from './wasm-imports.js';

/**
 * A loaded WASM object instance.
 */
export class WasmObject {
  private readonly _exports: WasmObjectExports;
  readonly memory: WebAssembly.Memory;
  private _manifest?: AbjectManifest;

  constructor(
    readonly objectId: AbjectId,
    _instance: WebAssembly.Instance,
    exports: WasmObjectExports
  ) {
    this._exports = exports;
    this.memory = exports.memory;

    require(this.memory !== undefined, 'WASM module must export memory');
  }

  /**
   * Initialize the object with state.
   */
  init(initialState?: unknown): void {
    if (!this._exports.init) {
      return;
    }

    if (initialState === undefined) {
      this._exports.init(0, 0);
      return;
    }

    const stateJson = JSON.stringify(initialState);
    const { ptr, len } = this.writeString(stateJson);
    this._exports.init(ptr, len);
  }

  /**
   * Handle an incoming message.
   */
  handle(message: AbjectMessage): AbjectMessage | undefined {
    require(this._exports.handle !== undefined, 'Object must export handle');

    const msgJson = serialize(message);
    const { ptr, len } = this.writeString(msgJson);
    const resultPtr = this._exports.handle(ptr, len);

    if (resultPtr === 0) {
      return undefined;
    }

    // Read result - format is length (u32) followed by UTF-8 string
    const resultLen = new DataView(this.memory.buffer).getUint32(
      resultPtr,
      true
    );
    const resultBytes = new Uint8Array(
      this.memory.buffer,
      resultPtr + 4,
      resultLen
    );
    const resultJson = new TextDecoder().decode(resultBytes);

    return deserialize(resultJson);
  }

  /**
   * Get the object manifest.
   */
  get manifest(): AbjectManifest {
    if (this._manifest) {
      return this._manifest;
    }

    require(this._exports.manifest !== undefined, 'Object must export manifest');

    const manifestPtr = this._exports.manifest();
    if (manifestPtr === 0) {
      throw new Error('Object returned null manifest');
    }

    // Read manifest - format is length (u32) followed by UTF-8 JSON
    const manifestLen = new DataView(this.memory.buffer).getUint32(
      manifestPtr,
      true
    );
    const manifestBytes = new Uint8Array(
      this.memory.buffer,
      manifestPtr + 4,
      manifestLen
    );
    const manifestJson = new TextDecoder().decode(manifestBytes);

    this._manifest = JSON.parse(manifestJson) as AbjectManifest;
    return this._manifest;
  }

  /**
   * Write a string to WASM memory.
   */
  private writeString(str: string): { ptr: number; len: number } {
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;

    // Allocate memory
    let ptr: number;
    if (this._exports.alloc) {
      ptr = this._exports.alloc(len);
    } else {
      // Fallback: bump allocator
      ptr = this.allocateBump(len);
    }

    // Copy bytes
    new Uint8Array(this.memory.buffer, ptr, len).set(bytes);

    return { ptr, len };
  }

  /**
   * Simple bump allocator for modules without alloc.
   */
  private allocateBump(size: number): number {
    const currentSize = this.memory.buffer.byteLength;
    const neededSize = currentSize + size + 1024;
    const neededPages = Math.ceil(neededSize / 65536);
    const currentPages = currentSize / 65536;

    if (neededPages > currentPages) {
      this.memory.grow(neededPages - currentPages);
    }

    // Return pointer near end of memory
    return this.memory.buffer.byteLength - size - 512;
  }
}

/**
 * Load a WASM module from bytes.
 */
export async function loadWasmObject(
  objectId: AbjectId,
  wasmBytes: ArrayBuffer,
  context: WasmImportContext
): Promise<WasmObject> {
  require(objectId !== '', 'objectId is required');
  require(wasmBytes.byteLength > 0, 'wasmBytes is required');

  // Create imports
  const imports = createWasmImports(context);

  // Compile and instantiate
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, imports);

  // Extract exports
  const exports = instance.exports as unknown as WasmObjectExports;

  // Create WasmObject
  const obj = new WasmObject(objectId, instance, exports);

  ensure(obj.memory !== undefined, 'Object must have memory');

  return obj;
}

/**
 * Compile a WASM module for later instantiation.
 */
export async function compileWasmModule(
  wasmBytes: ArrayBuffer
): Promise<WebAssembly.Module> {
  require(wasmBytes.byteLength > 0, 'wasmBytes is required');
  return WebAssembly.compile(wasmBytes);
}

/**
 * Validate a WASM module has required exports.
 */
export function validateWasmModule(module: WebAssembly.Module): string[] {
  const exports = WebAssembly.Module.exports(module);
  const exportNames = exports.map((e) => e.name);
  const errors: string[] = [];

  // Required exports
  const required = ['memory', 'handle'];
  for (const name of required) {
    if (!exportNames.includes(name)) {
      errors.push(`Missing required export: ${name}`);
    }
  }

  // Check types
  const handleExport = exports.find((e) => e.name === 'handle');
  if (handleExport && handleExport.kind !== 'function') {
    errors.push('handle must be a function');
  }

  const memoryExport = exports.find((e) => e.name === 'memory');
  if (memoryExport && memoryExport.kind !== 'memory') {
    errors.push('memory must be a memory');
  }

  return errors;
}
