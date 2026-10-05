/**
 * Installed abject packages.
 *
 * A package is a directory containing `abject.json` (package metadata with
 * the manifest) and the code it runs, in one of two runtimes:
 *
 * - `wasm` (the default): a compiled WebAssembly module, written in any
 *   language with an SDK (docs/WASM_ABI.md). Its bytes go into the
 *   content-addressed module store.
 * - `script`: a JavaScript handler map run as a ScriptableAbject in the
 *   sandbox, the same form as abjects made inside the app. It may be authored
 *   in TypeScript; `pnpm forge` compiles it (sdk/script/).
 *
 * Packages are found in these places, in this order. A later package claiming
 * the same type name wins when its version is the same or newer:
 *
 *   1. bundled native packages (`native/`, shipped with the app)
 *   2. installed extensions (`$ABJECTS_DATA_DIR/extensions/`, `pnpm forge`)
 *   3. directories named by `ABJECTS_PACKAGE_DIRS`
 *   4. directories added in `packages.json` (the Packages settings tab)
 *
 * Each place is either a package directory itself or a directory of package
 * directories. `packages.json` can also disable a package by name.
 *
 * At boot the server ingests every enabled package and registers its type
 * with the Factory, so
 *
 * - a package with `replaces` overrides the built-in constructor of that
 *   name (every spawn of the name resolves to the package), and
 * - packages without `replaces` become spawnable types: 'system' scope is
 *   spawned once at boot by server/index.ts, 'workspace' scope is spawned
 *   per workspace by the WorkspaceManager.
 *
 * Script packages are workspace-scoped only: their data persists through the
 * workspace's AbjectStore, and there is none at system scope.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbjectManifest } from '../core/types.js';
import { require } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { compileSandboxed } from '../core/sandbox.js';
import { packageOwner } from '../core/packages.js';
import { WASM_ABI_VERSION, looksLikeManifest } from './wasm-abi.js';
import { storeWasmModule } from './wasm-module-store.js';
import {
  type PackageConfig, type PackageSettingValue,
  readPackageConfig, envPackageDirs,
} from './package-config.js';
import type { Factory } from '../objects/factory.js';

const log = new Log('PACKAGES');

export type PackageRuntime = 'wasm' | 'script';
export type PackageScope = 'system' | 'workspace';
export type PackageOrigin = 'bundled' | 'installed' | 'environment' | 'configured';
export type PackageSettingType = 'string' | 'secret' | 'number' | 'boolean';

/**
 * One setting a package needs, declared in its abject.json `settings` array.
 * Values are entered in the Packages settings tab and read by the package's
 * own abjects with `Packages.getSettings` (secrets included, for them only).
 */
export interface PackageSettingSpec {
  key: string;
  label: string;
  type: PackageSettingType;
  description?: string;
  required?: boolean;
  default?: PackageSettingValue;
}

export interface ExtensionPackage {
  dir: string;
  name: string;
  version: string;
  runtime: PackageRuntime;
  scope: PackageScope;
  replaces?: string;
  manifest: AbjectManifest;
  settings: PackageSettingSpec[];
  /** wasm runtime: the ABI version the module speaks. */
  abi?: number;
  /** wasm runtime: the compiled module. */
  wasmPath?: string;
  /** script runtime: the JavaScript handler-map source. */
  sourcePath?: string;
}

/** Installed extensions live next to the module store. */
export function extensionsDir(): string {
  const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
  return path.resolve(dataDir, 'extensions');
}

/**
 * Locate the BUNDLED native packages directory (`native/` in the repo,
 * shipped as `resources/native` in the desktop app via extraResources).
 * These are system packages deployed with the app, ingested before user
 * extensions so a user-installed package of the same type name wins.
 *
 * Resolution order: explicit env override, Electron resources dir,
 * repo-relative from this source file, working directory. Returns undefined
 * when none exists (e.g. a stripped-down deployment).
 */
export function findBuiltinNativeDir(): string | undefined {
  const candidates: string[] = [];
  if (process.env.ABJECTS_NATIVE_DIR) candidates.push(process.env.ABJECTS_NATIVE_DIR);
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'native'));
  // Dev: src/sandbox/extensions.ts → ../../native = <repo>/native.
  // Packaged: this file is bundled into dist-server/server/index.js, where
  // the same hop misses — the resourcesPath candidate covers that case.
  candidates.push(fileURLToPath(new URL('../../native', import.meta.url)));
  candidates.push(path.resolve('native'));

  for (const dir of candidates) {
    try {
      if (fsSync.statSync(dir).isDirectory()) return dir;
    } catch { /* try next */ }
  }
  return undefined;
}

// ── Reading one package ──────────────────────────────────────────────

/** abject.json as written by hand or by `pnpm forge`. */
interface PackageMeta {
  name?: string;
  version?: string;
  runtime?: string;
  abi?: number;
  wasm?: string;
  source?: string;
  entry?: string;
  scope?: string;
  replaces?: string;
  manifest?: unknown;
  settings?: unknown;
}

const SETTING_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SETTING_TYPES: readonly PackageSettingType[] = ['string', 'secret', 'number', 'boolean'];

/** Validate a package's declared settings. Throws on the first problem. */
export function parseSettingSpecs(raw: unknown): PackageSettingSpec[] {
  if (raw === undefined) return [];
  require(Array.isArray(raw), 'abject.json: settings must be an array');
  const seen = new Set<string>();
  return (raw as unknown[]).map((entry, i) => {
    require(!!entry && typeof entry === 'object', `abject.json: settings[${i}] must be an object`);
    const s = entry as Record<string, unknown>;
    require(typeof s.key === 'string' && SETTING_KEY.test(s.key), `abject.json: settings[${i}].key must be an identifier`);
    const key = s.key as string;
    require(!seen.has(key), `abject.json: setting '${key}' is declared twice`);
    seen.add(key);
    const type = (s.type ?? 'string') as PackageSettingType;
    require(SETTING_TYPES.includes(type), `abject.json: setting '${key}' has unknown type '${String(s.type)}'`);
    if (s.default !== undefined) {
      const ok = type === 'number' ? typeof s.default === 'number' && Number.isFinite(s.default)
        : type === 'boolean' ? typeof s.default === 'boolean'
        : typeof s.default === 'string';
      require(ok, `abject.json: setting '${key}' has a default that is not a ${type}`);
    }
    return {
      key,
      label: typeof s.label === 'string' && s.label.trim() !== '' ? s.label : key,
      type,
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      ...(s.required === true ? { required: true } : {}),
      ...(s.default !== undefined ? { default: s.default as PackageSettingValue } : {}),
    };
  });
}

/**
 * A manifest given inline, or as a path (relative to the package) to a JSON
 * file holding either the manifest or an AbjectStore snapshot
 * (`{ manifest, source }`, the form abjects are saved in).
 */
export async function loadPackageManifest(pkgDir: string, raw: unknown): Promise<unknown> {
  if (typeof raw !== 'string') return raw;
  const file = path.resolve(pkgDir, raw);
  const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object' && parsed.manifest && typeof parsed.manifest === 'object'
      && typeof parsed.source === 'string') {
    return parsed.manifest;
  }
  return parsed;
}

const isJsFile = (p: unknown): p is string => typeof p === 'string' && /\.(c|m)?js$/i.test(p);

/** Read and validate a single package directory. Throws on any problem. */
export async function readPackage(pkgDir: string): Promise<ExtensionPackage> {
  const metaPath = path.join(pkgDir, 'abject.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as PackageMeta;

  require(typeof meta.name === 'string' && meta.name.length > 0, 'abject.json: name is required');
  require(typeof meta.version === 'string' && meta.version.length > 0, 'abject.json: version is required');
  const runtime = (meta.runtime ?? 'wasm') as PackageRuntime;
  require(runtime === 'wasm' || runtime === 'script', `abject.json: runtime must be 'wasm' or 'script', not '${meta.runtime}'`);
  require(
    meta.scope === 'system' || meta.scope === 'workspace',
    "abject.json: scope must be 'system' or 'workspace'",
  );

  const manifest = await loadPackageManifest(pkgDir, meta.manifest);
  require(looksLikeManifest(manifest), 'abject.json: manifest missing or malformed (run pnpm forge)');
  const typeName = meta.replaces ?? meta.name!;
  require(
    (manifest as AbjectManifest).name === typeName,
    `manifest name '${(manifest as AbjectManifest).name}' must equal ${meta.replaces ? `replaces '${meta.replaces}'` : `package name '${meta.name}'`} so discovery finds it`,
  );
  const settings = parseSettingSpecs(meta.settings);

  const base = {
    dir: pkgDir,
    name: meta.name!,
    version: meta.version!,
    runtime,
    scope: meta.scope as PackageScope,
    replaces: meta.replaces,
    manifest: manifest as AbjectManifest,
    settings,
  };

  if (runtime === 'wasm') {
    require(
      meta.abi === WASM_ABI_VERSION,
      `abject.json: abi ${meta.abi} is not supported (host speaks v${WASM_ABI_VERSION})`,
    );
    const wasmPath = path.join(pkgDir, meta.wasm ?? 'main.wasm');
    await fs.access(wasmPath);
    return { ...base, abi: meta.abi, wasmPath };
  }

  require(
    meta.scope === 'workspace',
    "abject.json: script packages must be workspace-scoped (their data persists through the workspace's AbjectStore)",
  );
  const rel = meta.source ?? (isJsFile(meta.entry) ? meta.entry : undefined);
  require(
    typeof rel === 'string' && rel.length > 0,
    'abject.json: script package has no built source; run pnpm forge (TypeScript entries are compiled at build time)',
  );
  const sourcePath = path.join(pkgDir, rel!);
  await fs.access(sourcePath);
  return { ...base, sourcePath };
}

/**
 * Check that script source compiles to a handler map, the same check a
 * ScriptableAbject makes before it installs source. Returns the handler names.
 */
export function checkScriptSource(source: string, filename = 'package.js'): string[] {
  let handlers: Record<string, unknown>;
  try {
    handlers = compileSandboxed(source, {}, { filename });
  } catch (err) {
    throw new Error(`source does not compile to a handler map: ${err instanceof Error ? err.message : err}`);
  }
  return Object.keys(handlers).filter(k => typeof handlers[k] === 'function');
}

// ── Finding and choosing packages ────────────────────────────────────

export interface PackageRoot {
  dir: string;
  origin: PackageOrigin;
}

/** Every place packages are loaded from, in precedence order (later wins). */
export function packageRoots(config: PackageConfig = readPackageConfig()): PackageRoot[] {
  const roots: PackageRoot[] = [];
  const builtin = findBuiltinNativeDir();
  if (builtin) roots.push({ dir: builtin, origin: 'bundled' });
  roots.push({ dir: extensionsDir(), origin: 'installed' });
  for (const dir of envPackageDirs()) roots.push({ dir, origin: 'environment' });
  for (const dir of config.dirs) roots.push({ dir, origin: 'configured' });
  const seen = new Set<string>();
  return roots.filter(r => {
    const key = path.resolve(r.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface DiscoveredPackage {
  dir: string;
  origin: PackageOrigin;
  /** Undefined when the package could not be read; see `error`. */
  pkg?: ExtensionPackage;
  error?: string;
}

const hasMeta = (dir: string): boolean => {
  try { return fsSync.statSync(path.join(dir, 'abject.json')).isFile(); } catch { return false; }
};

/**
 * Read every package under the given roots. A root holding an abject.json is
 * one package; otherwise each subdirectory holding one is. Unreadable
 * packages are returned with their error rather than thrown, so one broken
 * install cannot take down the boot or hide the others from the settings tab.
 */
export async function discoverPackages(roots: PackageRoot[]): Promise<DiscoveredPackage[]> {
  const found: DiscoveredPackage[] = [];
  const readOne = async (dir: string, origin: PackageOrigin): Promise<void> => {
    try {
      found.push({ dir, origin, pkg: await readPackage(dir) });
    } catch (err) {
      found.push({ dir, origin, error: err instanceof Error ? err.message : String(err) });
    }
  };
  for (const root of roots) {
    if (hasMeta(root.dir)) {
      await readOne(root.dir, root.origin);
      continue;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(root.dir);
    } catch {
      continue; // missing directory: nothing installed there
    }
    for (const entry of entries.sort()) {
      const dir = path.join(root.dir, entry);
      if (hasMeta(dir)) await readOne(dir, root.origin);
    }
  }
  return found;
}

/** Read every package in one directory of packages (the installed extensions by default). */
export async function scanExtensions(dir: string = extensionsDir()): Promise<ExtensionPackage[]> {
  const found = await discoverPackages([{ dir, origin: 'installed' }]);
  for (const f of found) {
    if (f.error) log.warn(`skipping package in ${f.dir}: ${f.error}`);
  }
  return found.flatMap(f => (f.pkg ? [f.pkg] : []));
}

export type PackageStatus = 'enabled' | 'disabled' | 'shadowed' | 'invalid';

export interface ResolvedPackage extends DiscoveredPackage {
  status: PackageStatus;
  /** The type name spawns use (replaces target or the package name). */
  typeName?: string;
  /** For a shadowed package: the package that won its type name. */
  shadowedBy?: { dir: string; version: string };
}

/** Numeric dotted-version compare: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Decide which discovered package loads for each type name. Later roots win
 * a type name when their version is the same or newer; an older copy found
 * later is shadowed instead of silently downgrading the type (a stale
 * KnowledgeBaseCpp once shadowed the bundled module's whole new method
 * surface this way). Disabled packages never claim their type name.
 */
export function resolvePackages(discovered: DiscoveredPackage[], config: PackageConfig): ResolvedPackage[] {
  const disabled = new Set(config.disabled);
  const winners = new Map<string, ResolvedPackage>();
  const out: ResolvedPackage[] = [];
  for (const d of discovered) {
    if (!d.pkg) {
      out.push({ ...d, status: 'invalid' });
      continue;
    }
    const typeName = d.pkg.replaces ?? d.pkg.name;
    if (disabled.has(d.pkg.name)) {
      out.push({ ...d, typeName, status: 'disabled' });
      continue;
    }
    const r: ResolvedPackage = { ...d, typeName, status: 'enabled' };
    const prev = winners.get(typeName);
    if (prev) {
      if (compareVersions(d.pkg.version, prev.pkg!.version) < 0) {
        r.status = 'shadowed';
        r.shadowedBy = { dir: prev.dir, version: prev.pkg!.version };
        out.push(r);
        continue;
      }
      prev.status = 'shadowed';
      prev.shadowedBy = { dir: d.dir, version: d.pkg.version };
    }
    winners.set(typeName, r);
    out.push(r);
  }
  return out;
}

// ── Ingesting at boot ────────────────────────────────────────────────

export interface IngestedExtension {
  /** The type name spawns use (replaces target or the package name). */
  typeName: string;
  packageName: string;
  runtime: PackageRuntime;
  scope: PackageScope;
  replaces?: string;
  version: string;
}

/** The manifest a package type registers with: the package's, tagged 'package'. */
function packageManifest(pkg: ExtensionPackage): AbjectManifest {
  const tags = pkg.manifest.tags ?? [];
  return tags.includes('package') ? pkg.manifest : { ...pkg.manifest, tags: [...tags, 'package'] };
}

/** Register one package's type with the Factory. Throws if it cannot load. */
async function registerPackage(factory: Factory, pkg: ExtensionPackage): Promise<void> {
  const typeName = pkg.replaces ?? pkg.name;
  if (pkg.runtime === 'wasm') {
    const bytes = new Uint8Array(await fs.readFile(pkg.wasmPath!));
    const source = await storeWasmModule(bytes);
    factory.registerPackageType(typeName, {
      runtime: 'wasm', manifest: packageManifest(pkg), source, scope: pkg.scope,
      package: { name: pkg.name, version: pkg.version },
    });
    return;
  }
  const source = await fs.readFile(pkg.sourcePath!, 'utf-8');
  checkScriptSource(source, path.basename(pkg.sourcePath!));
  factory.registerPackageType(typeName, {
    runtime: 'script', manifest: packageManifest(pkg), source, scope: pkg.scope,
    owner: packageOwner(pkg.name),
    package: { name: pkg.name, version: pkg.version },
  });
}

/**
 * Ingest every enabled package and register its type with the Factory. Call
 * during bootstrap, after constructors are registered and before anything
 * spawns, so a package with `replaces` wins the first spawn of its name.
 */
export async function ingestAllExtensions(
  factory: Factory,
  config: PackageConfig = readPackageConfig(),
): Promise<IngestedExtension[]> {
  const resolved = resolvePackages(await discoverPackages(packageRoots(config)), config);
  const ingested: IngestedExtension[] = [];

  for (const r of resolved) {
    if (r.status === 'invalid') {
      log.warn(`skipping package in ${r.dir}: ${r.error}`);
      continue;
    }
    const pkg = r.pkg!;
    if (r.status === 'disabled') {
      log.info(`package '${pkg.name}' v${pkg.version} is disabled (packages.json)`);
      continue;
    }
    if (r.status === 'shadowed') {
      log.warn(
        `skipping '${pkg.name}' v${pkg.version} in ${r.dir}: type '${r.typeName}' is provided by ` +
        `v${r.shadowedBy!.version} in ${r.shadowedBy!.dir}. Remove the stale package to silence this warning.`,
      );
      continue;
    }
    try {
      await registerPackage(factory, pkg);
      ingested.push({
        typeName: r.typeName!, packageName: pkg.name, runtime: pkg.runtime,
        scope: pkg.scope, replaces: pkg.replaces, version: pkg.version,
      });
      log.info(
        `installed '${pkg.name}' v${pkg.version} as ${pkg.scope} ${pkg.runtime} type '${r.typeName}'` +
        (pkg.replaces ? ` (replaces built-in ${pkg.replaces})` : ''),
      );
    } catch (err) {
      log.warn(`failed to ingest package '${pkg.name}': ${err instanceof Error ? err.message : err}`);
    }
  }

  return ingested;
}
