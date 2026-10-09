/**
 * Packages — the instance's installed abject packages, and the one place
 * their configuration changes.
 *
 * Packages are loaded at boot (src/sandbox/extensions.ts): bundled ones, ones
 * installed with `pnpm forge`, and ones found in extra directories. This
 * object shows every package it can find, says which ones are running, and
 * edits `packages.json` (src/sandbox/package-config.ts):
 *
 * - **Enable / disable** a package. Takes effect at the next start, because a
 *   package's type is registered before anything spawns.
 * - **Package directories.** Add or remove extra places to load packages
 *   from. Also takes effect at the next start.
 * - **Settings.** A package declares the settings it needs in its abject.json;
 *   values entered here apply at once. A package's own abjects read them with
 *   `getSettings` (secret values included, for them only) and can observe
 *   this object for `settingsChanged`.
 * - **System-scope package data.** A script package spawned once at system
 *   scope has no workspace AbjectStore; its abject saves and loads its data
 *   here (`savePackageData`, `getPackageData`), kept in the global Storage
 *   and answered only to that package's own system-scope abject.
 *
 * The Packages tab of the system settings is a view over this object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition } from '../core/contracts.js';
import { request } from '../core/message.js';
import { withKeyedLock } from '../core/keyed-lock.js';
import { isPackageOwner, packageNameOf } from '../core/packages.js';
import { Log } from '../core/timed-log.js';
import {
  type PackageOrigin, type PackageRuntime, type PackageScope, type PackageSettingSpec,
  type PackageStatus, type ResolvedPackage,
  discoverPackages, packageRoots, resolvePackages,
} from '../sandbox/extensions.js';
import {
  type PackageConfig, type PackageSettingValue,
  envPackageDirs, packageConfigPath, readPackageConfig, writePackageConfig,
} from '../sandbox/package-config.js';

const log = new Log('Packages');

const PACKAGES_INTERFACE: InterfaceId = 'abjects:packages' as InterfaceId;
export const PACKAGES_ID = 'abjects:packages' as AbjectId;

const CONFIG_LOCK = 'packages:config';

/** A masked secret: whether a value is stored, never the value. */
export interface MaskedSecret { set: boolean }

/** One package as the settings view shows it. */
export interface PackageView {
  name: string;
  version: string;
  runtime: PackageRuntime;
  scope: PackageScope;
  typeName: string;
  replaces?: string;
  description: string;
  icon?: string;
  dir: string;
  origin: PackageOrigin;
  /** What the configuration says should happen at the next start. */
  status: Exclude<PackageStatus, 'invalid'>;
  shadowedBy?: { dir: string; version: string };
  /** Whether this package is running in this instance now. */
  loaded: boolean;
  /** Whether the next start will differ from what is running. */
  restartRequired: boolean;
  settings: PackageSettingSpec[];
  /** Current values; secrets are masked. */
  values: Record<string, PackageSettingValue | MaskedSecret>;
  /** Required settings that have no value and no default. */
  missingRequired: string[];
}

/** A directory that could not be read as a package. */
export interface PackageProblem {
  dir: string;
  origin: PackageOrigin;
  error: string;
}

export interface PackageDirView {
  dir: string;
  origin: PackageOrigin;
  /** Only directories added in packages.json can be removed here. */
  editable: boolean;
  exists: boolean;
}

type LoadedType = { name: string; runtime: 'wasm' | 'script'; package?: { name: string; version: string } };

function settingValueValid(spec: PackageSettingSpec, v: unknown): v is PackageSettingValue {
  if (spec.type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (spec.type === 'boolean') return typeof v === 'boolean';
  return typeof v === 'string';
}

/** Global Storage key holding a system-scope script package's data. */
const packageDataKey = (packageName: string) => `packages:data:${packageName}`;

export class Packages extends Abject {
  private factoryId?: AbjectId;
  private storageId?: AbjectId;
  /** The global registry: where this object, and system-scope packages, are registered. */
  private globalRegistryId?: AbjectId;

  constructor() {
    const text = { kind: 'primitive' as const, primitive: 'string' as const };
    const obj = { kind: 'object' as const, properties: {} };
    super({
      manifest: {
        name: 'Packages',
        description:
          'The installed abject packages: which are running, which are disabled, where packages are loaded from, ' +
          'and the settings each package needs. Enabling, disabling and package directories take effect at the next ' +
          'start; settings apply at once. A package\'s own abjects read their settings here with getSettings.',
        version: '1.0.0',
        interface: {
          id: PACKAGES_INTERFACE,
          name: 'Packages',
          description: 'Installed abject packages and their configuration',
          methods: [
            {
              name: 'list',
              description: 'Every package found in the package directories, with its status (enabled, disabled, shadowed by a newer copy), whether it is running now, whether a restart is pending, its declared settings and their current values (secrets masked). Returns { packages, problems } where problems are directories that could not be read as packages.',
              parameters: [],
              returns: obj,
            },
            {
              name: 'listDirs',
              description: 'The directories packages are loaded from, in precedence order: bundled, installed (pnpm forge), the ABJECTS_PACKAGE_DIRS environment variable, and directories added in packages.json. Only the last kind can be removed here.',
              parameters: [],
              returns: { kind: 'array', elementType: obj },
            },
            {
              name: 'setEnabled',
              description: 'Enable or disable a package by name. Takes effect at the next start. Returns { success, restartRequired, error? }.',
              parameters: [
                { name: 'name', type: text, description: 'Package name' },
                { name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether it should load' },
              ],
              returns: obj,
            },
            {
              name: 'addDir',
              description: 'Add a directory to load packages from: a package directory itself, or a directory of package directories. Must be an absolute path to an existing directory. Takes effect at the next start. Returns { success, error? }.',
              parameters: [{ name: 'dir', type: text, description: 'Absolute directory path' }],
              returns: obj,
            },
            {
              name: 'removeDir',
              description: 'Remove a directory added with addDir. Takes effect at the next start. Returns { success, error? }.',
              parameters: [{ name: 'dir', type: text, description: 'Directory path as listed by listDirs' }],
              returns: obj,
            },
            {
              name: 'setSettings',
              description: 'Set settings values for a package. Keys must be settings the package declares, with values of the declared type. For a secret, an empty string leaves the stored value unchanged; null clears any value. Applies at once and notifies observers with settingsChanged. Returns { success, error? }.',
              parameters: [
                { name: 'name', type: text, description: 'Package name' },
                { name: 'values', type: obj, description: 'Setting key to value' },
              ],
              returns: obj,
            },
            {
              name: 'getSettings',
              description: 'For an abject from an installed package: its package\'s settings, defaults filled in and secrets included. Answered only to abjects spawned from a running package. Returns { package, values }.',
              parameters: [],
              returns: obj,
            },
            {
              name: 'getPackageData',
              description: 'For a script package abject spawned at system scope: its saved data, or null. Answered only to that abject; workspace package abjects keep their data in their workspace\'s AbjectStore.',
              parameters: [],
              returns: obj,
            },
            {
              name: 'savePackageData',
              description: 'For a script package abject spawned at system scope: replace its saved data. Answered only to that abject. Returns { success }.',
              parameters: [
                { name: 'data', type: obj, description: 'The abject\'s data (JSON)' },
              ],
              returns: obj,
            },
          ],
          events: [
            { name: 'packagesChanged', description: 'Package configuration changed (enabled set or directories); payload { restartRequired }', payload: obj },
            { name: 'settingsChanged', description: 'A package\'s settings changed; payload { package }', payload: obj },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'packages'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.factoryId = await this.discoverDep('Factory') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('list', async () => this.list());
    this.on('listDirs', async () => this.listDirs());

    this.on('setEnabled', async (msg: AbjectMessage) => {
      const { name, enabled } = msg.payload as { name: string; enabled: boolean };
      return this.setEnabled(name, enabled);
    });

    this.on('addDir', async (msg: AbjectMessage) => {
      const { dir } = msg.payload as { dir: string };
      return this.addDir(dir);
    });

    this.on('removeDir', async (msg: AbjectMessage) => {
      const { dir } = msg.payload as { dir: string };
      return this.removeDir(dir);
    });

    this.on('setSettings', async (msg: AbjectMessage) => {
      const { name, values } = msg.payload as { name: string; values: Record<string, unknown> };
      return this.setSettings(name, values);
    });

    this.on('getSettings', async (msg: AbjectMessage) => this.getSettingsFor(msg.routing.from));

    this.on('getPackageData', async (msg: AbjectMessage) => {
      const name = await this.systemPackageOf(msg.routing.from);
      this.storageId ??= await this.discoverDep('Storage') ?? undefined;
      // Without Storage nothing can have been saved; saving still fails loudly.
      if (!this.storageId) return null;
      return await this.request<unknown>(request(this.id, this.storageId, 'get', { key: packageDataKey(name) })) ?? null;
    });

    this.on('savePackageData', async (msg: AbjectMessage) => {
      const name = await this.systemPackageOf(msg.routing.from);
      const { data } = msg.payload as { data?: unknown };
      precondition(!!data && typeof data === 'object' && !Array.isArray(data), 'data must be an object');
      const storageId = await this.storage();
      await this.request(request(this.id, storageId, 'set', { key: packageDataKey(name), value: data }));
      return { success: true };
    });
  }

  private async storage(): Promise<AbjectId> {
    this.storageId ??= await this.discoverDep('Storage') ?? undefined;
    precondition(!!this.storageId, 'Storage is not available');
    return this.storageId!;
  }

  /**
   * The package name of a script package abject registered at system scope,
   * found from where the Factory registered it, never from the message. Its
   * data is keyed by package, so a workspace package abject (one per
   * workspace, data in its workspace's AbjectStore) is refused.
   */
  private async systemPackageOf(callerId: AbjectId): Promise<string> {
    const reg = await this.callerRegistration(callerId);
    if (!this.globalRegistryId && this.factoryId) {
      const own = await this.request<{ registryId?: AbjectId }>(
        request(this.id, this.factoryId, 'getObjectInfo', { objectId: this.id })).catch(() => undefined);
      this.globalRegistryId = own?.registryId;
    }
    precondition(!!reg && isPackageOwner(reg.owner),
      'package data is kept only for abjects spawned from an installed script package');
    precondition(!!this.globalRegistryId && reg!.registryId === this.globalRegistryId,
      'package data here is for system-scope packages; a workspace package keeps its data in its workspace\'s AbjectStore');
    return packageNameOf(reg!.owner)!;
  }

  // ── Reading ────────────────────────────────────────────────────────

  /** The package types running in this instance, from the Factory. */
  private async loadedTypes(): Promise<LoadedType[]> {
    if (!this.factoryId) this.factoryId = await this.discoverDep('Factory') ?? undefined;
    if (!this.factoryId) return [];
    try {
      return await this.request<LoadedType[]>(request(this.id, this.factoryId, 'listPackageTypes', {}));
    } catch {
      return [];
    }
  }

  private async resolved(config: PackageConfig): Promise<ResolvedPackage[]> {
    return resolvePackages(await discoverPackages(packageRoots(config)), config);
  }

  async list(): Promise<{ packages: PackageView[]; problems: PackageProblem[]; configPath: string }> {
    const config = readPackageConfig();
    const resolved = await this.resolved(config);
    const loaded = await this.loadedTypes();
    const packages: PackageView[] = [];
    const problems: PackageProblem[] = [];

    for (const r of resolved) {
      if (!r.pkg) {
        problems.push({ dir: r.dir, origin: r.origin, error: r.error ?? 'unreadable package' });
        continue;
      }
      const pkg = r.pkg;
      const running = loaded.find(t => t.name === r.typeName);
      const isThis = !!running && (!running.package || running.package.name === pkg.name);
      const sameVersion = isThis && (!running!.package || running!.package.version === pkg.version);
      const isLoaded = isThis && sameVersion;
      const status = r.status as PackageView['status'];
      const restartRequired =
        (status === 'enabled' && !isLoaded) || (status !== 'enabled' && isThis);

      const stored = config.settings[pkg.name] ?? {};
      const values: PackageView['values'] = {};
      const missingRequired: string[] = [];
      for (const spec of pkg.settings) {
        const v = stored[spec.key];
        if (spec.type === 'secret') {
          values[spec.key] = { set: typeof v === 'string' && v !== '' };
        } else if (v !== undefined) {
          values[spec.key] = v;
        } else if (spec.default !== undefined) {
          values[spec.key] = spec.default;
        }
        const has = v !== undefined && v !== '' || spec.default !== undefined;
        if (spec.required && !has) missingRequired.push(spec.key);
      }

      packages.push({
        name: pkg.name,
        version: pkg.version,
        runtime: pkg.runtime,
        scope: pkg.scope,
        typeName: r.typeName!,
        ...(pkg.replaces ? { replaces: pkg.replaces } : {}),
        description: pkg.manifest.description,
        ...(pkg.manifest.icon ? { icon: pkg.manifest.icon } : {}),
        dir: r.dir,
        origin: r.origin,
        status,
        ...(r.shadowedBy ? { shadowedBy: r.shadowedBy } : {}),
        loaded: isLoaded,
        restartRequired,
        settings: pkg.settings,
        values,
        missingRequired,
      });
    }
    return { packages, problems, configPath: packageConfigPath() };
  }

  listDirs(): PackageDirView[] {
    const config = readPackageConfig();
    const configured = new Set(config.dirs);
    const exists = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
    return packageRoots(config).map(r => ({
      dir: r.dir,
      origin: r.origin,
      editable: r.origin === 'configured' && configured.has(r.dir),
      exists: exists(r.dir),
    }));
  }

  // ── Changing the configuration ─────────────────────────────────────

  private async updateConfig<T>(change: (cfg: PackageConfig) => T): Promise<T> {
    return withKeyedLock(CONFIG_LOCK, async () => {
      const cfg = readPackageConfig();
      const result = change(cfg);
      writePackageConfig(cfg);
      return result;
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<{ success: boolean; restartRequired?: boolean; error?: string }> {
    precondition(typeof name === 'string' && name !== '', 'name must not be empty');
    precondition(typeof enabled === 'boolean', 'enabled must be a boolean');
    const found = (await this.resolved(readPackageConfig())).filter(r => r.pkg?.name === name);
    if (!found.length) return { success: false, error: `No package named '${name}' was found in the package directories.` };
    if (!enabled && found.some(r => r.pkg?.required)) {
      return { success: false, error: `'${name}' is required: the system has no other implementation of what it provides, so it stays enabled.` };
    }

    await this.updateConfig(cfg => {
      const disabled = new Set(cfg.disabled);
      if (enabled) disabled.delete(name); else disabled.add(name);
      cfg.disabled = [...disabled];
    });
    log.info(`package '${name}' ${enabled ? 'enabled' : 'disabled'} (applies at next start)`);
    const restartRequired = await this.anyRestartRequired();
    this.changed('packagesChanged', { restartRequired });
    return { success: true, restartRequired };
  }

  async addDir(dir: string): Promise<{ success: boolean; error?: string }> {
    precondition(typeof dir === 'string', 'dir must be a string');
    const trimmed = dir.trim();
    if (!trimmed) return { success: false, error: 'Enter a directory path.' };
    if (!path.isAbsolute(trimmed)) return { success: false, error: 'Use an absolute path.' };
    const resolved = path.resolve(trimmed);
    try {
      if (!fs.statSync(resolved).isDirectory()) return { success: false, error: `${resolved} is not a directory.` };
    } catch {
      return { success: false, error: `${resolved} does not exist.` };
    }
    if (this.listDirs().some(d => d.dir === resolved)) {
      return { success: false, error: `${resolved} is already a package directory.` };
    }
    await this.updateConfig(cfg => { cfg.dirs = [...cfg.dirs, resolved]; });
    log.info(`package directory added: ${resolved} (applies at next start)`);
    this.changed('packagesChanged', { restartRequired: await this.anyRestartRequired() });
    return { success: true };
  }

  async removeDir(dir: string): Promise<{ success: boolean; error?: string }> {
    precondition(typeof dir === 'string' && dir !== '', 'dir must not be empty');
    const resolved = path.resolve(dir);
    if (envPackageDirs().includes(resolved)) {
      return { success: false, error: 'That directory comes from ABJECTS_PACKAGE_DIRS; change the environment to remove it.' };
    }
    const removed = await this.updateConfig(cfg => {
      const before = cfg.dirs.length;
      cfg.dirs = cfg.dirs.filter(d => d !== resolved);
      return cfg.dirs.length < before;
    });
    if (!removed) return { success: false, error: `${resolved} was not added here, so it cannot be removed here.` };
    log.info(`package directory removed: ${resolved} (applies at next start)`);
    this.changed('packagesChanged', { restartRequired: await this.anyRestartRequired() });
    return { success: true };
  }

  async setSettings(name: string, values: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    precondition(typeof name === 'string' && name !== '', 'name must not be empty');
    precondition(!!values && typeof values === 'object', 'values must be an object');
    const pkg = (await this.resolved(readPackageConfig())).find(r => r.pkg?.name === name)?.pkg;
    if (!pkg) return { success: false, error: `No package named '${name}' was found in the package directories.` };

    const specs = new Map(pkg.settings.map(s => [s.key, s]));
    for (const [key, v] of Object.entries(values)) {
      const spec = specs.get(key);
      if (!spec) return { success: false, error: `'${name}' declares no setting '${key}'.` };
      if (v === null) continue;
      if (spec.type === 'secret' && v === '') continue;
      if (!settingValueValid(spec, v)) return { success: false, error: `${spec.label} must be a ${spec.type === 'secret' ? 'string' : spec.type}.` };
    }

    await this.updateConfig(cfg => {
      const current = { ...(cfg.settings[name] ?? {}) };
      for (const [key, v] of Object.entries(values)) {
        const spec = specs.get(key)!;
        if (v === null) { delete current[key]; continue; }
        if (spec.type === 'secret' && v === '') continue;
        current[key] = v as PackageSettingValue;
      }
      cfg.settings[name] = current;
    });
    log.info(`settings saved for package '${name}' (${Object.keys(values).length} value(s))`);
    this.changed('settingsChanged', { package: name });
    return { success: true };
  }

  private async anyRestartRequired(): Promise<boolean> {
    try {
      return (await this.list()).packages.some(p => p.restartRequired);
    } catch {
      return true;
    }
  }

  // ── Serving settings to packages ───────────────────────────────────

  /**
   * The caller's registration, looked up in the registry the Factory says it
   * registered the caller in. Nothing in the message is trusted.
   */
  private async callerRegistration(callerId: AbjectId): Promise<{ owner?: string; typeId?: string; registryId: AbjectId } | null> {
    if (!this.factoryId) this.factoryId = await this.discoverDep('Factory') ?? undefined;
    if (!this.factoryId) return null;
    try {
      const info = await this.request<{ registryId?: AbjectId }>(
        request(this.id, this.factoryId, 'getObjectInfo', { objectId: callerId }));
      if (!info?.registryId) return null;
      const reg = await this.request<{ owner?: string; typeId?: string } | null>(
        request(this.id, info.registryId, 'lookup', { objectId: callerId }));
      return reg ? { ...reg, registryId: info.registryId } : null;
    } catch {
      return null;
    }
  }

  /**
   * The settings of the package the caller was spawned from.
   *
   * A script package's abjects carry the `package:<name>` owner, which only
   * the Factory gives out and only when it spawns from that package. A WASM
   * package's abjects have no owner, so they are recognised by the typeId
   * WorkspaceManager or the bootstrap stamped at spawn,
   * `{peer}/{workspace|system}/{TypeName}`, and only for WASM package types.
   */
  private async getSettingsFor(callerId: AbjectId): Promise<{ package: string; values: Record<string, PackageSettingValue> }> {
    const reg = await this.callerRegistration(callerId);
    const loaded = await this.loadedTypes();
    let packageName = packageNameOf(reg?.owner);
    if (!packageName && reg?.typeId) {
      const parts = String(reg.typeId).split('/');
      const typeName = parts.length === 3 && parts[1] !== 'user' ? parts[2] : undefined;
      packageName = loaded.find(t => t.name === typeName && t.runtime === 'wasm' && t.package)?.package?.name;
    }
    precondition(!!packageName, 'getSettings is answered only to abjects spawned from an installed package');
    precondition(loaded.some(t => t.package?.name === packageName), `package '${packageName}' is not running`);

    // The declaration comes from the package on disk: the enabled copy, or any
    // copy when it was disabled after it started (it runs until the restart).
    const config = readPackageConfig();
    const resolved = (await this.resolved(config)).filter(r => r.pkg?.name === packageName);
    const pkg = (resolved.find(r => r.status === 'enabled') ?? resolved[0])?.pkg;
    precondition(!!pkg, `package '${packageName}' is not available`);

    const stored = config.settings[packageName!] ?? {};
    const values: Record<string, PackageSettingValue> = {};
    for (const spec of pkg!.settings) {
      const v = stored[spec.key];
      if (v !== undefined && settingValueValid(spec, v)) values[spec.key] = v;
      else if (spec.default !== undefined) values[spec.key] = spec.default;
    }
    return { package: packageName!, values };
  }
}
