/**
 * The shipped KnowledgeBase for the agent-system tests: the native C++
 * package's module and manifest, hosted by WasmAbject the way the server
 * hosts it. It reaches Storage, SharedState, Identity and GoalManager by name
 * like any guest, so a fixture provides whichever of them a test needs; a
 * missing one degrades to no persistence or no sync, as in the running system.
 */

import { readFile } from 'node:fs/promises';
import { WasmAbject } from './wasm-abject.js';
import { storeWasmModule } from '../sandbox/wasm-module-store.js';
import { extractWasmManifest } from '../sandbox/wasm-instance.js';
import type { AbjectManifest } from '../core/types.js';

const MODULE = new URL('../../native/knowledge-base/main.wasm', import.meta.url);
let module: Promise<{ bytes: Uint8Array; manifest: AbjectManifest }> | undefined;

/**
 * A new native KnowledgeBase, not yet initialised: add it to the fixture's bus
 * like any abject. The module is stored in the current ABJECTS_DATA_DIR's
 * module store, which is where the host loads it from at init.
 */
export async function nativeKnowledgeBase(): Promise<WasmAbject> {
  module ??= (async () => {
    const bytes = new Uint8Array(await readFile(MODULE));
    return { bytes, manifest: await extractWasmManifest(bytes) };
  })();
  const { bytes, manifest } = await module;
  return new WasmAbject({ manifest, source: await storeWasmModule(bytes) });
}

/** Let a freshly added native KnowledgeBase finish loading from its Storage. */
export function nativeKnowledgeSettled(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 30));
}
