/**
 * forge-abject - compile, validate, and install a WASM abject package.
 *
 * Usage:
 *   pnpm forge <package-dir> [--dest <extensions-dir>] [--no-build]
 *
 * The package dir contains an `abject.json`:
 *   {
 *     "name": "EchoCpp",            // package + type name
 *     "version": "1.0.0",
 *     "abi": 1,
 *     "scope": "workspace",         // or "system"
 *     "replaces": "KnowledgeBase",  // optional: override a built-in type
 *     "wasm": "main.wasm",          // module path, relative to the dir
 *     "build": "bash ../../sdk/cpp/build.sh echo.cpp -o main.wasm"  // optional
 *   }
 *
 * Steps: run the build command (if any), validate the module's exports and
 * ABI version, extract its self-declared manifest, verify the manifest name
 * matches the type name (replaces target or package name), then install the
 * module + metadata (with the embedded manifest) into the extensions
 * directory. The server ingests installed packages at boot.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { extractWasmManifest } from '../src/sandbox/wasm-instance.js';
import { WASM_ABI_VERSION } from '../src/sandbox/wasm-abi.js';
import { extensionsDir } from '../src/sandbox/extensions.js';

interface ForgeMeta {
  name?: string;
  version?: string;
  abi?: number;
  wasm?: string;
  scope?: string;
  replaces?: string;
  build?: string;
}

function fail(message: string): never {
  console.error(`forge: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noBuild = args.includes('--no-build');
  const destFlag = args.indexOf('--dest');
  const dest = destFlag >= 0 ? args[destFlag + 1] : extensionsDir();
  const pkgDirArg = args.find((a, i) => !a.startsWith('--') && (destFlag < 0 || i !== destFlag + 1));
  if (!pkgDirArg) fail('usage: pnpm forge <package-dir> [--dest <extensions-dir>] [--no-build]');

  const pkgDir = path.resolve(pkgDirArg);
  const metaPath = path.join(pkgDir, 'abject.json');
  let meta: ForgeMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as ForgeMeta;
  } catch (err) {
    fail(`cannot read ${metaPath}: ${err instanceof Error ? err.message : err}`);
  }

  if (!meta.name) fail('abject.json: "name" is required');
  if (!meta.version) fail('abject.json: "version" is required');
  const abi = meta.abi ?? WASM_ABI_VERSION;
  if (abi !== WASM_ABI_VERSION) fail(`abject.json: abi ${abi} unsupported (host speaks v${WASM_ABI_VERSION})`);
  const scope = meta.scope ?? 'workspace';
  if (scope !== 'system' && scope !== 'workspace') fail('abject.json: "scope" must be "system" or "workspace"');

  // 1. Build
  if (meta.build && !noBuild) {
    console.log(`forge: building ${meta.name} — ${meta.build}`);
    try {
      execSync(meta.build, { cwd: pkgDir, stdio: 'inherit' });
    } catch {
      fail('build command failed');
    }
  }

  // 2. Validate the module and extract its manifest
  const wasmRel = meta.wasm ?? 'main.wasm';
  const wasmPath = path.join(pkgDir, wasmRel);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(wasmPath));
  } catch {
    fail(`module not found: ${wasmPath} (missing build step?)`);
  }

  let manifest;
  try {
    manifest = await extractWasmManifest(bytes);
  } catch (err) {
    fail(`module failed ABI validation: ${err instanceof Error ? err.message : err}`);
  }

  const typeName = meta.replaces ?? meta.name;
  if (manifest.name !== typeName) {
    fail(
      `module manifest declares name '${manifest.name}' but the ${meta.replaces ? `replaces target` : `package name`} is '${typeName}'. ` +
      `They must match so Registry discovery finds the object.`,
    );
  }

  // 3. Install: module + metadata with embedded manifest
  const installDir = path.join(dest, meta.name!);
  await fs.mkdir(installDir, { recursive: true });
  await fs.copyFile(wasmPath, path.join(installDir, 'main.wasm'));
  await fs.writeFile(
    path.join(installDir, 'abject.json'),
    JSON.stringify(
      {
        name: meta.name,
        version: meta.version,
        abi,
        wasm: 'main.wasm',
        scope,
        ...(meta.replaces ? { replaces: meta.replaces } : {}),
        manifest,
      },
      null,
      2,
    ),
  );

  const kb = (bytes.byteLength / 1024).toFixed(0);
  console.log(`forge: installed '${meta.name}' v${meta.version} → ${installDir}`);
  console.log(`forge:   type '${typeName}' (${scope}${meta.replaces ? `, replaces built-in ${meta.replaces}` : ''}), module ${kb} KiB, ${manifest.interface.methods.length} methods`);
  console.log('forge: restart the backend (pnpm awaken) to load it');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
