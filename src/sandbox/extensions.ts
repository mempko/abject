/**
 * Installed WASM extension packages.
 *
 * An extension is a directory under $ABJECTS_DATA_DIR/extensions/<name>/
 * containing `abject.json` (install metadata with the embedded manifest,
 * written by `pnpm forge`) and the compiled module. At boot the server
 * ingests every package: module bytes go into the content-addressed store
 * and the type is registered with the Factory, so
 *
 * - a package with `replaces` overrides the built-in constructor of that
 *   name (every spawn of the name resolves to the WASM implementation), and
 * - packages without `replaces` become spawnable types: 'system' scope is
 *   spawned once at boot by server/index.ts, 'workspace' scope is spawned
 *   per workspace by the WorkspaceManager.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AbjectManifest } from '../core/types.js';
import { require } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { WASM_ABI_VERSION, looksLikeManifest } from './wasm-abi.js';
import { storeWasmModule } from './wasm-module-store.js';
import type { Factory } from '../objects/factory.js';

const log = new Log('WASM-EXT');

export interface ExtensionPackage {
  dir: string;
  name: string;
  version: string;
  abi: number;
  scope: 'system' | 'workspace';
  replaces?: string;
  manifest: AbjectManifest;
  wasmPath: string;
}

/** Installed extensions live next to the module store. */
export function extensionsDir(): string {
  const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
  return path.resolve(dataDir, 'extensions');
}

/**
 * Read and validate every installed extension package. Malformed packages
 * are skipped with a logged reason — one broken install must not take down
 * the boot.
 */
export async function scanExtensions(dir: string = extensionsDir()): Promise<ExtensionPackage[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // no extensions installed
  }

  const packages: ExtensionPackage[] = [];
  for (const entry of entries.sort()) {
    const pkgDir = path.join(dir, entry);
    try {
      const pkg = await readPackage(pkgDir);
      packages.push(pkg);
    } catch (err) {
      log.warn(`skipping extension '${entry}': ${err instanceof Error ? err.message : err}`);
    }
  }
  return packages;
}

/** Read and validate a single package directory. Throws on any problem. */
export async function readPackage(pkgDir: string): Promise<ExtensionPackage> {
  const metaPath = path.join(pkgDir, 'abject.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as {
    name?: string;
    version?: string;
    abi?: number;
    wasm?: string;
    scope?: string;
    replaces?: string;
    manifest?: unknown;
  };

  require(typeof meta.name === 'string' && meta.name.length > 0, 'abject.json: name is required');
  require(typeof meta.version === 'string' && meta.version.length > 0, 'abject.json: version is required');
  require(
    meta.abi === WASM_ABI_VERSION,
    `abject.json: abi ${meta.abi} is not supported (host speaks v${WASM_ABI_VERSION})`,
  );
  require(
    meta.scope === 'system' || meta.scope === 'workspace',
    "abject.json: scope must be 'system' or 'workspace'",
  );
  require(looksLikeManifest(meta.manifest), 'abject.json: manifest missing or malformed (run pnpm forge)');

  const manifest = meta.manifest as AbjectManifest;
  const typeName = meta.replaces ?? meta.name!;
  require(
    manifest.name === typeName,
    `manifest name '${manifest.name}' must equal ${meta.replaces ? `replaces '${meta.replaces}'` : `package name '${meta.name}'`} so discovery finds it`,
  );

  const wasmPath = path.join(pkgDir, meta.wasm ?? 'main.wasm');
  await fs.access(wasmPath);

  return {
    dir: pkgDir,
    name: meta.name!,
    version: meta.version!,
    abi: meta.abi!,
    scope: meta.scope as 'system' | 'workspace',
    replaces: meta.replaces,
    manifest,
    wasmPath,
  };
}

export interface IngestedExtension {
  /** The type name spawns use (replaces target or the package name). */
  typeName: string;
  scope: 'system' | 'workspace';
  replaces?: string;
  version: string;
}

/**
 * Ingest installed extensions: store module bytes content-addressed and
 * register each as a WASM type with the Factory. Call during bootstrap,
 * after constructors are registered and before anything spawns.
 */
export async function ingestExtensions(
  factory: Factory,
  dir: string = extensionsDir(),
): Promise<IngestedExtension[]> {
  const packages = await scanExtensions(dir);
  const ingested: IngestedExtension[] = [];

  for (const pkg of packages) {
    try {
      const bytes = new Uint8Array(await fs.readFile(pkg.wasmPath));
      const source = await storeWasmModule(bytes);
      const typeName = pkg.replaces ?? pkg.name;

      factory.registerWasmType(typeName, {
        manifest: pkg.manifest,
        source,
        scope: pkg.scope,
      });

      ingested.push({ typeName, scope: pkg.scope, replaces: pkg.replaces, version: pkg.version });
      log.info(
        `installed '${pkg.name}' v${pkg.version} as ${pkg.scope} type '${typeName}'` +
        (pkg.replaces ? ` (replaces built-in ${pkg.replaces})` : ''),
      );
    } catch (err) {
      log.warn(`failed to ingest extension '${pkg.name}': ${err instanceof Error ? err.message : err}`);
    }
  }

  return ingested;
}
