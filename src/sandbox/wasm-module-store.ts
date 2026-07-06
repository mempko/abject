/**
 * Content-addressed store for WASM abject modules.
 *
 * Modules live at $ABJECTS_DATA_DIR/wasm/<sha256>.wasm and are referred to
 * everywhere by the wasm source ref string `wasm:sha256:<hex>`. The ref rides
 * the same `source` field ScriptableAbjects use for JS source, so Registry
 * registration, AbjectStore snapshots, clone/instantiate, and Supervisor
 * respawn carry it without changes.
 *
 * Both the main thread (Factory) and worker threads (WasmAbject.onInit)
 * resolve refs directly from disk, so spawning never copies module bytes
 * across thread boundaries.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { require, requireNonEmpty } from '../core/contracts.js';

export const WASM_SOURCE_PREFIX = 'wasm:sha256:';

/** True when a registration/spawn `source` string refers to a WASM module. */
export function isWasmSourceRef(source: string): boolean {
  return source.startsWith(WASM_SOURCE_PREFIX);
}

/** Extract the hex digest from a wasm source ref. Throws on malformed refs. */
export function hashFromWasmRef(ref: string): string {
  require(isWasmSourceRef(ref), `not a wasm source ref: ${ref}`);
  const hash = ref.slice(WASM_SOURCE_PREFIX.length);
  require(/^[0-9a-f]{64}$/.test(hash), `malformed wasm ref digest: ${ref}`);
  return hash;
}

/** Directory holding stored modules. */
export function wasmStoreDir(): string {
  const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
  return path.resolve(dataDir, 'wasm');
}

function modulePath(hash: string): string {
  return path.join(wasmStoreDir(), `${hash}.wasm`);
}

/**
 * Store module bytes content-addressed; returns the wasm source ref.
 * Idempotent — re-storing identical bytes is a no-op.
 */
export async function storeWasmModule(bytes: Uint8Array): Promise<string> {
  require(bytes.byteLength > 0, 'module bytes must not be empty');

  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = wasmStoreDir();
  await fs.mkdir(dir, { recursive: true });

  const file = modulePath(hash);
  try {
    await fs.access(file);
  } catch {
    // Write via a temp file + rename so concurrent writers never expose a
    // partially-written module under the content hash.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
  }

  return `${WASM_SOURCE_PREFIX}${hash}`;
}

/**
 * Load module bytes for a wasm source ref. Verifies the content hash so a
 * corrupted or tampered store entry can never be instantiated.
 */
export async function loadWasmModule(ref: string): Promise<Uint8Array> {
  requireNonEmpty(ref, 'ref');
  const hash = hashFromWasmRef(ref);

  const bytes = new Uint8Array(await fs.readFile(modulePath(hash)));
  const actual = createHash('sha256').update(bytes).digest('hex');
  require(actual === hash, `wasm module store corruption: ${ref} hashes to ${actual}`);

  return bytes;
}

/** Decode a base64 module payload (message-friendly spawn input). */
export function decodeBase64Module(codeBase64: string): Uint8Array {
  requireNonEmpty(codeBase64, 'codeBase64');
  return new Uint8Array(Buffer.from(codeBase64, 'base64'));
}
