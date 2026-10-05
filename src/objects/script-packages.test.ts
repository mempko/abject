/**
 * Script packages: abjects loaded from installed packages as JavaScript
 * handler maps (src/sandbox/extensions.ts), their read-only ownership, their
 * data persistence through AbjectStore, and the Packages service that
 * configures them and serves their settings.
 *
 * In-process: a real Runtime (bus, Registry, Factory) with no worker pool, so
 * script abjects are spawned inline. Package directories and packages.json
 * live in a temp directory named by ABJECTS_DATA_DIR / ABJECTS_PACKAGE_DIRS,
 * restored after each test (the suite shares one process).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Runtime } from '../runtime/runtime.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, TypeId } from '../core/types.js';
import { Storage } from './capabilities/storage.js';
import { AbjectStore } from './abject-store.js';
import { Packages, type PackageView } from './packages.js';
import { packageOwner, isPackageOwner } from '../core/packages.js';
import {
  readPackage, resolvePackages, discoverPackages, packageRoots, ingestAllExtensions, parseSettingSpecs,
} from '../sandbox/extensions.js';
import { readPackageConfig, writePackageConfig } from '../sandbox/package-config.js';
import { Registry } from './registry.js';

// ── Fixtures ────────────────────────────────────────────────────────

function manifestFor(name: string, methods: string[] = ['add', 'get']): AbjectManifest {
  return {
    name,
    description: `${name} test package`,
    version: '1.0.0',
    interface: {
      id: `abjects:test:${name.toLowerCase()}` as InterfaceId,
      name,
      description: `${name} interface`,
      methods: methods.map(m => ({ name: m, description: m, parameters: [] })),
    },
    requiredCapabilities: [],
    providedCapabilities: [],
    tags: ['test'],
  } as unknown as AbjectManifest;
}

/** A counter that saves its data and reads its package settings. */
const COUNTER_SOURCE = `({
  async add(msg) {
    this.data.count = (this.data.count || 0) + ((msg.payload && msg.payload.by) || 1);
    await this.saveData();
    return this.data.count;
  },
  get() { return this.data.count || 0; },
  async settings() { return this.call(this.dep('Packages'), 'getSettings', {}); }
})`;

function writePackage(dir: string, meta: Record<string, unknown>, files: Record<string, string> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abject.json'), JSON.stringify(meta, null, 2));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

function scriptMeta(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, version: '1.0.0', runtime: 'script', scope: 'workspace', source: 'main.js', manifest: manifestFor(name), ...extra };
}

/** Sends requests on a test's behalf. */
class Probe extends Abject {
  constructor() {
    super({ manifest: manifestFor('Probe', []) });
  }
  ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload), 10_000);
  }
}

interface Env {
  root: string;
  dataDir: string;
  pkgDir: string;
  restore(): void;
}

/** A temp ABJECTS_DATA_DIR and package directory, with no bundled packages. */
function tempEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abject-pkgs-'));
  const dataDir = path.join(root, 'data');
  const pkgDir = path.join(root, 'packages');
  const nativeDir = path.join(root, 'native-empty');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });
  const saved = {
    ABJECTS_DATA_DIR: process.env.ABJECTS_DATA_DIR,
    ABJECTS_PACKAGE_DIRS: process.env.ABJECTS_PACKAGE_DIRS,
    ABJECTS_NATIVE_DIR: process.env.ABJECTS_NATIVE_DIR,
  };
  process.env.ABJECTS_DATA_DIR = dataDir;
  process.env.ABJECTS_PACKAGE_DIRS = pkgDir;
  process.env.ABJECTS_NATIVE_DIR = nativeDir;
  return {
    root, dataDir, pkgDir,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function startRuntime(): Promise<{ rt: Runtime; probe: Probe }> {
  const rt = new Runtime();
  await rt.start();
  const probe = new Probe();
  await rt.objectFactory.spawnInstance(probe);
  return { rt, probe };
}

/** Spawn a package type the way WorkspaceManager does: by name, with a stamped typeId. */
async function spawnByName(rt: Runtime, name: string, extra: Record<string, unknown> = {}): Promise<AbjectId> {
  const result = await rt.objectFactory.spawn({
    manifest: { name, description: '', version: '1.0.0', requiredCapabilities: [], tags: ['system'] } as unknown as AbjectManifest,
    typeId: `peer/ws/${name}` as TypeId,
    ...extra,
  });
  return result.objectId;
}

// ── Reading and choosing packages ───────────────────────────────────

test('readPackage reads a script package: inline manifest, plain JS entry, snapshot-file manifest', async () => {
  const env = tempEnv();
  try {
    const inline = await readPackage(writePackage(path.join(env.pkgDir, 'Counter'), scriptMeta('Counter'), { 'main.js': COUNTER_SOURCE }));
    assert.equal(inline.runtime, 'script');
    assert.equal(inline.scope, 'workspace');
    assert.ok(inline.sourcePath?.endsWith('main.js'));

    // A .js entry needs no build, and the manifest may be an AbjectStore snapshot file.
    const snapshotDir = writePackage(path.join(env.pkgDir, 'Snap'),
      { name: 'Snap', version: '1.0.0', runtime: 'script', scope: 'workspace', entry: 'Snap.js', manifest: 'Snap.json' },
      { 'Snap.js': COUNTER_SOURCE, 'Snap.json': JSON.stringify({ manifest: manifestFor('Snap'), source: COUNTER_SOURCE }) });
    const snap = await readPackage(snapshotDir);
    assert.equal(snap.manifest.name, 'Snap');
    assert.ok(snap.sourcePath?.endsWith('Snap.js'));
  } finally {
    env.restore();
  }
});

test('readPackage refuses script packages it could not run correctly', async () => {
  const env = tempEnv();
  try {
    // System scope is allowed for script packages (one per instance, data kept by Packages).
    const sys = await readPackage(writePackage(path.join(env.pkgDir, 'Sys'), scriptMeta('Sys', { scope: 'system' }), { 'main.js': COUNTER_SOURCE }));
    assert.equal(sys.scope, 'system');
    await assert.rejects(
      readPackage(writePackage(path.join(env.pkgDir, 'Unbuilt'),
        { name: 'Unbuilt', version: '1.0.0', runtime: 'script', scope: 'workspace', entry: 'x.ts', manifest: manifestFor('Unbuilt') },
        { 'x.ts': COUNTER_SOURCE })),
      /no built source/,
    );
    await assert.rejects(
      readPackage(writePackage(path.join(env.pkgDir, 'Mismatch'), scriptMeta('Mismatch', { manifest: manifestFor('Other') }), { 'main.js': COUNTER_SOURCE })),
      /must equal/,
    );
    assert.throws(() => parseSettingSpecs([{ key: 'n', type: 'number', default: 'one' }]), /not a number/);
    assert.throws(() => parseSettingSpecs([{ key: 'a' }, { key: 'a' }]), /declared twice/);
    assert.throws(() => parseSettingSpecs([{ key: 'x', type: 'colour' }]), /unknown type/);
  } finally {
    env.restore();
  }
});

test('resolvePackages: later same-or-newer copies win, older ones are shadowed, disabled ones never claim a type', async () => {
  const env = tempEnv();
  try {
    const first = path.join(env.root, 'first');
    const second = path.join(env.root, 'second');
    writePackage(path.join(first, 'A'), scriptMeta('A', { version: '2.0.0' }), { 'main.js': COUNTER_SOURCE });
    writePackage(path.join(second, 'A'), scriptMeta('A', { version: '1.0.0' }), { 'main.js': COUNTER_SOURCE });
    writePackage(path.join(first, 'B'), scriptMeta('B'), { 'main.js': COUNTER_SOURCE });
    writePackage(path.join(second, 'B'), scriptMeta('B', { version: '1.1.0' }), { 'main.js': COUNTER_SOURCE });
    writePackage(path.join(second, 'C'), scriptMeta('C'), { 'main.js': COUNTER_SOURCE });
    fs.mkdirSync(path.join(second, 'Broken'));
    fs.writeFileSync(path.join(second, 'Broken', 'abject.json'), '{ not json');

    const found = await discoverPackages([{ dir: first, origin: 'configured' }, { dir: second, origin: 'configured' }]);
    const resolved = resolvePackages(found, { dirs: [], disabled: ['C'], settings: {} });
    const status = (name: string, dir: string) =>
      resolved.find(r => r.pkg?.name === name && r.dir.startsWith(dir))?.status;

    assert.equal(status('A', first), 'enabled');
    assert.equal(status('A', second), 'shadowed', 'an older copy found later must not downgrade the type');
    assert.equal(status('B', first), 'shadowed');
    assert.equal(status('B', second), 'enabled', 'a newer copy found later wins');
    assert.equal(status('C', second), 'disabled');
    assert.equal(resolved.filter(r => r.status === 'invalid').length, 1, 'the broken package is reported, not thrown');
  } finally {
    env.restore();
  }
});

// ── Spawning, ownership, persistence ────────────────────────────────

test('a script package type spawns as a read-only ScriptableAbject owned by its package, even over a built-in', async () => {
  const env = tempEnv();
  const { rt, probe } = await startRuntime();
  try {
    const factory = rt.objectFactory;
    await factory.spawnInstance(new Storage());
    await factory.spawnInstance(new AbjectStore());
    // A built-in of the same name: the package must win (that is what `replaces` means).
    class Builtin extends Abject {
      constructor() { super({ manifest: manifestFor('Counter', ['add']) }); this.on('add', () => 'builtin'); }
    }
    factory.registerConstructor('Counter', () => new Builtin());
    factory.registerPackageType('Counter', {
      runtime: 'script', scope: 'workspace', manifest: manifestFor('Counter'), source: COUNTER_SOURCE,
      owner: packageOwner('counter-pkg'), package: { name: 'counter-pkg', version: '1.0.0' },
    });

    const id = await spawnByName(rt, 'Counter');
    assert.equal(await probe.ask<number>(id, 'add', { by: 2 }), 2, 'the package source handled the call, not the built-in');
    const reg = await probe.ask<{ owner?: string; typeId?: string }>(rt.objectRegistry.id, 'lookup', { objectId: id });
    assert.equal(reg.owner, 'package:counter-pkg');
    assert.equal(reg.typeId, 'peer/ws/Counter');

    const edit = await probe.ask<{ success: boolean; error?: string }>(id, 'updateSource', { source: '({ add() { return -1; } })' });
    assert.equal(edit.success, false);
    assert.match(edit.error ?? '', /installed package 'counter-pkg'/);
    assert.equal(await probe.ask<number>(id, 'get'), 2, 'a refused edit leaves the live code alone');

    const manifestEdit = await probe.ask<{ success: boolean }>(id, 'updateManifest', { manifest: manifestFor('Counter') });
    assert.equal(manifestEdit.success, false);

    // Only an installed package may give out its owner.
    await assert.rejects(
      factory.spawn({ manifest: manifestFor('Impostor'), source: COUNTER_SOURCE, owner: packageOwner('counter-pkg') }),
      /reserved for abjects from installed packages/,
    );

    // A clone is an ordinary, editable object.
    const clone = await factory.clone(id);
    const cloneReg = await probe.ask<{ owner?: string; manifest: AbjectManifest }>(rt.objectRegistry.id, 'lookup', { objectId: clone.objectId });
    assert.ok(!isPackageOwner(cloneReg.owner), 'a clone does not inherit the package owner');
    assert.ok(!(cloneReg.manifest.tags ?? []).includes('package'));
    // Edits to it follow the ordinary owner rules (the probe is neither its
    // owner nor an authoring object), not the package lock.
    const cloneEdit = await probe.ask<{ success: boolean; error?: string }>(clone.objectId, 'updateSource', { source: '({ add() { return 41; }, get() { return 41; } })' });
    assert.doesNotMatch(cloneEdit.error ?? '', /installed package/);
    assert.equal(await probe.ask<number>(clone.objectId, 'add', { by: 1 }), 3, 'the clone runs the package code with a copy of its data');
  } finally {
    await rt.stop();
    env.restore();
  }
});

test('package data persists under package/<Type>, comes back through getPackageData, and is never restored as a user object', async () => {
  const env = tempEnv();
  const { rt, probe } = await startRuntime();
  try {
    const factory = rt.objectFactory;
    await factory.spawnInstance(new Storage());
    const store = new AbjectStore();
    await factory.spawnInstance(store);
    factory.registerPackageType('Counter', {
      runtime: 'script', scope: 'workspace', manifest: manifestFor('Counter'), source: COUNTER_SOURCE,
      owner: packageOwner('counter-pkg'),
    });

    const id = await spawnByName(rt, 'Counter');
    await probe.ask(id, 'add', { by: 3 });
    // saveData is coalesced and asynchronous; persistSnapshot waits for a durable save.
    await probe.ask(id, 'persistSnapshot', {});

    assert.deepEqual(await probe.ask(store.id, 'getPackageData', { name: 'Counter' }), { count: 3 });
    const listed = await probe.ask<Array<{ owner: string }>>(store.id, 'list', {});
    assert.equal(listed.filter(s => isPackageOwner(s.owner)).length, 0, 'list shows user objects only');

    const before = rt.objectRegistry.objectCount;
    const restored = await probe.ask<{ restored: number }>(store.id, 'restoreAll', {});
    assert.equal(restored.restored, 0, 'the package abject is not restored a second time');
    assert.equal(rt.objectRegistry.objectCount, before);
    assert.deepEqual(await probe.ask(store.id, 'getPackageData', { name: 'Counter' }), { count: 3 },
      'restoreAll keeps the package record');

    // The next spawn of the package gets its data back.
    const again = await spawnByName(rt, 'Counter', {
      data: await probe.ask(store.id, 'getPackageData', { name: 'Counter' }),
      typeId: 'peer/ws2/Counter',
    });
    assert.equal(await probe.ask<number>(again, 'get'), 3);
  } finally {
    await rt.stop();
    env.restore();
  }
});

test('a system-scope script package keeps its data with Packages, which answers only that abject', async () => {
  const env = tempEnv();
  const { rt, probe } = await startRuntime();
  try {
    const factory = rt.objectFactory;
    await factory.spawnInstance(new Storage());
    const packages = new Packages();
    await factory.spawnInstance(packages);
    factory.registerPackageType('Beacon', {
      runtime: 'script', scope: 'system', manifest: manifestFor('Beacon'), source: COUNTER_SOURCE,
      owner: packageOwner('beacon-pkg'), package: { name: 'beacon-pkg', version: '1.0.0' },
    });

    // Spawned the way the bootstrap does: by name, into the global registry,
    // which has no AbjectStore.
    const id = await spawnByName(rt, 'Beacon', { typeId: 'peer/system/Beacon' });
    assert.equal(await probe.ask<number>(id, 'add', { by: 4 }), 4);
    const persisted = await probe.ask<{ success: boolean; data: unknown }>(id, 'persistSnapshot', {});
    assert.deepEqual(persisted.data, { count: 4 }, 'the durable copy is the one Packages holds');

    // Spawned again (a restart): it loads its own data before handling anything.
    const again = await spawnByName(rt, 'Beacon', { typeId: 'peer/system/Beacon-restarted' });
    assert.equal(await probe.ask<number>(again, 'get'), 4);

    // Nobody else reads or writes it: not an ordinary object...
    await assert.rejects(probe.ask(packages.id, 'getPackageData', {}), /installed script package/);
    await assert.rejects(probe.ask(packages.id, 'savePackageData', { data: { count: 99 } }), /installed script package/);
    // ...and not the same package's abject in a workspace, which keeps its data
    // in that workspace's AbjectStore.
    const workspaceRegistry = new Registry();
    await factory.spawnInstance(workspaceRegistry);
    const inWorkspace = await spawnByName(rt, 'Beacon', { typeId: 'peer/ws/Beacon', registryHint: workspaceRegistry.id });
    await assert.rejects(probe.ask(inWorkspace, 'add', { by: 1 }), /AbjectStore unavailable/,
      'a workspace copy without its store is not let into the system copy\'s data');
    assert.equal(await probe.ask<number>(again, 'get'), 4);
  } finally {
    await rt.stop();
    env.restore();
  }
});

// ── The Packages service ─────────────────────────────────────────────

test('Packages lists, configures, and serves settings only to the package\'s own abjects', async () => {
  const env = tempEnv();
  const { rt, probe } = await startRuntime();
  try {
    writePackage(path.join(env.pkgDir, 'Counter'), scriptMeta('Counter', {
      settings: [
        { key: 'unit', label: 'Unit', type: 'string', default: 'visits' },
        { key: 'token', label: 'Token', type: 'secret', required: true },
        { key: 'step', label: 'Step', type: 'number', default: 1 },
      ],
    }), { 'main.js': COUNTER_SOURCE });

    const ingested = await ingestAllExtensions(rt.objectFactory);
    assert.deepEqual(ingested.map(e => `${e.typeName}:${e.runtime}`), ['Counter:script']);

    const packages = new Packages();
    await rt.objectFactory.spawnInstance(packages);
    const view = async () => (await probe.ask<{ packages: PackageView[] }>(packages.id, 'list', {})).packages
      .find(p => p.name === 'Counter')!;

    let counter = await view();
    assert.equal(counter.status, 'enabled');
    assert.equal(counter.loaded, true);
    assert.equal(counter.restartRequired, false);
    assert.deepEqual(counter.missingRequired, ['token']);

    // Settings: validated against the declaration, secrets masked in the view.
    const bad = await probe.ask<{ success: boolean; error?: string }>(packages.id, 'setSettings', { name: 'Counter', values: { step: 'two' } });
    assert.equal(bad.success, false);
    const unknown = await probe.ask<{ success: boolean }>(packages.id, 'setSettings', { name: 'Counter', values: { colour: 'red' } });
    assert.equal(unknown.success, false);
    const ok = await probe.ask<{ success: boolean }>(packages.id, 'setSettings', { name: 'Counter', values: { unit: 'hits', token: 's3cret' } });
    assert.equal(ok.success, true);
    counter = await view();
    assert.equal(counter.values.unit, 'hits');
    assert.deepEqual(counter.values.token, { set: true }, 'the view never carries a secret');
    assert.deepEqual(counter.missingRequired, []);
    // An empty secret keeps the stored one.
    await probe.ask(packages.id, 'setSettings', { name: 'Counter', values: { token: '' } });
    assert.equal(readPackageConfig().settings.Counter.token, 's3cret');

    // The package's own abject gets its settings, secret and defaults included.
    const id = await spawnByName(rt, 'Counter');
    const served = await probe.ask<{ package: string; values: Record<string, unknown> }>(id, 'settings', {});
    assert.deepEqual(served, { package: 'Counter', values: { unit: 'hits', token: 's3cret', step: 1 } });

    // Nobody else does: not an ordinary object, and not a user object that
    // copies the package's name, source and typeId shape.
    await assert.rejects(probe.ask(packages.id, 'getSettings', {}), /only to abjects spawned from an installed package/);
    const impostor = await rt.objectFactory.spawn({
      manifest: manifestFor('Counter'), source: COUNTER_SOURCE, typeId: 'peer/elsewhere/Counter' as TypeId,
    });
    await assert.rejects(probe.ask(impostor.objectId, 'settings', {}), /only to abjects spawned from an installed package/);

    // Enable/disable is written to packages.json and applies at the next start.
    const off = await probe.ask<{ success: boolean; restartRequired: boolean }>(packages.id, 'setEnabled', { name: 'Counter', enabled: false });
    assert.deepEqual(off, { success: true, restartRequired: true });
    assert.deepEqual(readPackageConfig().disabled, ['Counter']);
    counter = await view();
    assert.equal(counter.status, 'disabled');
    assert.equal(counter.loaded, true, 'still running until the next start');
    assert.equal(counter.restartRequired, true);
    const missing = await probe.ask<{ success: boolean }>(packages.id, 'setEnabled', { name: 'Nope', enabled: false });
    assert.equal(missing.success, false);

    // Directories: absolute and existing only; environment ones cannot be removed here.
    const extra = path.join(env.root, 'extra');
    fs.mkdirSync(extra);
    assert.equal((await probe.ask<{ success: boolean }>(packages.id, 'addDir', { dir: 'relative/path' })).success, false);
    assert.equal((await probe.ask<{ success: boolean }>(packages.id, 'addDir', { dir: path.join(env.root, 'absent') })).success, false);
    assert.equal((await probe.ask<{ success: boolean }>(packages.id, 'addDir', { dir: extra })).success, true);
    assert.deepEqual(readPackageConfig().dirs, [extra]);
    const dirs = await probe.ask<Array<{ dir: string; origin: string; editable: boolean }>>(packages.id, 'listDirs', {});
    assert.ok(dirs.some(d => d.dir === extra && d.origin === 'configured' && d.editable));
    assert.ok(dirs.some(d => d.dir === env.pkgDir && d.origin === 'environment' && !d.editable));
    assert.equal((await probe.ask<{ success: boolean }>(packages.id, 'removeDir', { dir: env.pkgDir })).success, false);
    assert.equal((await probe.ask<{ success: boolean }>(packages.id, 'removeDir', { dir: extra })).success, true);
    assert.deepEqual(readPackageConfig().dirs, []);
  } finally {
    await rt.stop();
    env.restore();
  }
});

test('disabled packages are not ingested; packages.json survives malformed content', async () => {
  const env = tempEnv();
  const { rt } = await startRuntime();
  try {
    writePackage(path.join(env.pkgDir, 'Counter'), scriptMeta('Counter'), { 'main.js': COUNTER_SOURCE });
    writePackage(path.join(env.pkgDir, 'Broken'), scriptMeta('Broken'), { 'main.js': '({ add( })' });
    writePackageConfig({ dirs: [], disabled: ['Counter'], settings: {} });
    const ingested = await ingestAllExtensions(rt.objectFactory);
    assert.deepEqual(ingested, [], 'disabled Counter and uncompilable Broken are both skipped');

    fs.writeFileSync(path.join(env.dataDir, 'packages.json'), '{ nope');
    assert.deepEqual(readPackageConfig(), { dirs: [], disabled: [], settings: {} });
    assert.ok(packageRoots().some(r => r.dir === env.pkgDir && r.origin === 'environment'));
  } finally {
    await rt.stop();
    env.restore();
  }
});
