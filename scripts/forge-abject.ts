/**
 * forge-abject - build, validate, and install an abject package (WASM or script).
 *
 * Usage:
 *   pnpm forge <package-dir> [--dest <extensions-dir>] [--no-build] [--build-only]
 *
 * --build-only builds and validates the package in place instead of
 * installing it. Used for packages loaded straight from their directory: the
 * bundled system packages under native/ (which the desktop app ships as
 * resources), and directories listed in ABJECTS_PACKAGE_DIRS or added in the
 * Packages settings tab.
 *
 * A WASM package dir contains an `abject.json`:
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
 *
 * A script package runs as a ScriptableAbject (a JavaScript handler map in the
 * sandbox), and may be written in TypeScript:
 *   {
 *     "name": "Tally",
 *     "version": "1.0.0",
 *     "runtime": "script",
 *     "scope": "workspace",         // script packages are always workspace-scoped
 *     "entry": "tally.ts",          // .ts is compiled with esbuild; .js is used as is
 *     "manifest": "manifest.json",  // or the manifest inline
 *     "settings": [ { "key": "label", "type": "string", "default": "Visits" } ]
 *   }
 *
 * Steps: run the build command (if any), compile a TypeScript entry, check the
 * result compiles to a handler map in the sandbox, validate the manifest and
 * settings, then install `main.js` + metadata (with the embedded manifest), or
 * with --build-only write `main.js` next to the entry and point `source` at it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { extractWasmManifest } from '../src/sandbox/wasm-instance.js';
import { WASM_ABI_VERSION, looksLikeManifest } from '../src/sandbox/wasm-abi.js';
import {
  extensionsDir, checkScriptSource, loadPackageManifest, parseSettingSpecs,
} from '../src/sandbox/extensions.js';
import type { AbjectManifest } from '../src/core/types.js';

interface ForgeMeta {
  name?: string;
  version?: string;
  runtime?: string;
  abi?: number;
  wasm?: string;
  entry?: string;
  source?: string;
  manifest?: unknown;
  settings?: unknown;
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
  const buildOnly = args.includes('--build-only');
  const destFlag = args.indexOf('--dest');
  const dest = destFlag >= 0 ? args[destFlag + 1] : extensionsDir();
  const pkgDirArg = args.find((a, i) => !a.startsWith('--') && (destFlag < 0 || i !== destFlag + 1));
  if (!pkgDirArg) fail('usage: pnpm forge <package-dir> [--dest <extensions-dir>] [--no-build] [--build-only]');

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

  const runtime = meta.runtime ?? 'wasm';
  if (runtime === 'script') {
    await forgeScript(pkgDir, metaPath, meta, scope, buildOnly, dest);
    return;
  }
  if (runtime !== 'wasm') fail(`abject.json: "runtime" must be "wasm" or "script", not "${runtime}"`);
  try {
    parseSettingSpecs(meta.settings);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
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

  const kb = (bytes.byteLength / 1024).toFixed(0);

  // 3a. Build-only: embed the manifest into the package's own abject.json
  // (bundled native packages are ingested straight from their directory).
  if (buildOnly) {
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          name: meta.name,
          version: meta.version,
          abi,
          wasm: wasmRel,
          scope,
          ...(meta.replaces ? { replaces: meta.replaces } : {}),
          ...(meta.build ? { build: meta.build } : {}),
          ...(meta.settings !== undefined ? { settings: meta.settings } : {}),
          manifest,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`forge: built '${meta.name}' v${meta.version} in place → ${wasmPath}`);
    console.log(`forge:   type '${typeName}' (${scope}${meta.replaces ? `, replaces built-in ${meta.replaces}` : ''}), module ${kb} KiB, ${manifest.interface.methods.length} methods`);
    return;
  }

  // 3b. Install: module + metadata with embedded manifest
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
        ...(meta.settings !== undefined ? { settings: meta.settings } : {}),
        manifest,
      },
      null,
      2,
    ),
  );

  console.log(`forge: installed '${meta.name}' v${meta.version} → ${installDir}`);
  console.log(`forge:   type '${typeName}' (${scope}${meta.replaces ? `, replaces built-in ${meta.replaces}` : ''}), module ${kb} KiB, ${manifest.interface.methods.length} methods`);
  console.log('forge: restart the backend (pnpm awaken) to load it');
}

const isTypeScript = (file: string): boolean => /\.(c|m)?ts$/i.test(file);

/**
 * Compile a TypeScript entry to the bare handler-map expression the sandbox
 * evaluates. Types (including `satisfies` and type-only imports) are erased;
 * anything that would still need a module system is refused.
 */
async function compileTypeScript(code: string, file: string): Promise<string> {
  const { transform } = await import('esbuild');
  let out: string;
  try {
    ({ code: out } = await transform(code, {
      loader: 'ts', target: 'es2022', legalComments: 'none', sourcefile: file,
    }));
  } catch (err) {
    fail(`TypeScript compile failed: ${err instanceof Error ? err.message : err}`);
  }
  if (/^\s*(import|export)\b/m.test(out)) {
    fail(`${path.basename(file)}: a script package is one handler-map expression, so it cannot import or export at runtime (type-only imports are fine)`);
  }
  return out;
}

/** The handler-map expression as the sandbox evaluates it: no trailing semicolon. */
function asHandlerMapSource(code: string): string {
  return code.trim().replace(/;\s*$/, '');
}

async function forgeScript(
  pkgDir: string, metaPath: string, meta: ForgeMeta, scope: string, buildOnly: boolean, dest: string,
): Promise<void> {
  if (scope !== 'workspace') {
    fail('abject.json: script packages must be workspace-scoped (their data persists through the workspace\'s AbjectStore)');
  }
  const typeName = meta.replaces ?? meta.name!;

  // 2. Compile and check the source
  const entry = meta.entry ?? meta.source ?? 'main.js';
  const entryPath = path.join(pkgDir, entry);
  let code: string;
  try {
    code = await fs.readFile(entryPath, 'utf-8');
  } catch {
    fail(`entry not found: ${entryPath}`);
  }
  if (isTypeScript(entry)) code = await compileTypeScript(code, entryPath);
  const source = asHandlerMapSource(code);
  let handlers: string[];
  try {
    handlers = checkScriptSource(source, path.basename(entry));
  } catch (err) {
    fail(`${path.basename(entry)}: ${err instanceof Error ? err.message : err}`);
  }

  // 3. Manifest and settings
  let manifest: AbjectManifest;
  try {
    const loaded = await loadPackageManifest(pkgDir, meta.manifest);
    if (!looksLikeManifest(loaded)) {
      fail('abject.json: "manifest" must be a manifest (name, description, interface.methods) or the path to one; a { manifest, source } snapshot file works too');
    }
    manifest = loaded;
  } catch (err) {
    fail(`cannot read the manifest: ${err instanceof Error ? err.message : err}`);
  }
  if (manifest.name !== typeName) {
    fail(
      `manifest declares name '${manifest.name}' but the ${meta.replaces ? 'replaces target' : 'package name'} is '${typeName}'. ` +
      'They must match so Registry discovery finds the object.',
    );
  }
  let settings;
  try {
    settings = parseSettingSpecs(meta.settings);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const declared = manifest.interface.methods.map(m => m.name);
  const unhandled = declared.filter(n => !handlers.includes(n));
  if (unhandled.length > 0) {
    console.warn(`forge: warning: the manifest declares ${unhandled.join(', ')} but the source has no handler for ${unhandled.length === 1 ? 'it' : 'them'}`);
  }

  const kb = (Buffer.byteLength(source) / 1024).toFixed(1);
  const summary = `type '${typeName}' (script, ${scope}${meta.replaces ? `, replaces built-in ${meta.replaces}` : ''}), ` +
    `${kb} KiB, ${handlers.length} handlers, ${settings.length} settings`;

  // 4a. Build-only: main.js next to the entry, and abject.json points at it
  // (the manifest stays where the author keeps it).
  if (buildOnly) {
    const outPath = path.join(pkgDir, 'main.js');
    if (path.resolve(outPath) !== path.resolve(entryPath) || isTypeScript(entry)) {
      await fs.writeFile(outPath, source + '\n');
    }
    const raw = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    await fs.writeFile(metaPath, JSON.stringify({ ...raw, runtime: 'script', scope, source: 'main.js' }, null, 2) + '\n');
    console.log(`forge: built '${meta.name}' v${meta.version} in place → ${outPath}`);
    console.log(`forge:   ${summary}`);
    return;
  }

  // 4b. Install: main.js + metadata with the embedded manifest
  const installDir = path.join(dest, meta.name!);
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'main.js'), source + '\n');
  await fs.writeFile(
    path.join(installDir, 'abject.json'),
    JSON.stringify(
      {
        name: meta.name,
        version: meta.version,
        runtime: 'script',
        scope,
        source: 'main.js',
        ...(meta.replaces ? { replaces: meta.replaces } : {}),
        ...(settings.length > 0 ? { settings } : {}),
        manifest,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`forge: installed '${meta.name}' v${meta.version} → ${installDir}`);
  console.log(`forge:   ${summary}`);
  console.log('forge: restart the backend (pnpm awaken) to load it');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
