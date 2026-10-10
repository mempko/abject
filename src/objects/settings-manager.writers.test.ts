/**
 * Global-settings write policy.
 *
 *   - Only the Settings UI (GlobalSettings) and the commune CLI (CliServer)
 *     may change global settings by name.
 *   - Abjects and agents running inside a workspace this peer hosts in LOCAL
 *     mode may also change global settings.
 *   - Abjects in shared or public workspaces are denied, as are abjects in
 *     joined local mirrors of remote workspaces (their accessMode reads
 *     'local' but the workspace is not hosted here).
 *   - Callers whose identity cannot be resolved are denied (fail closed).
 *
 * Run: npx tsx --test src/objects/settings-manager.writers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageBus } from '../runtime/message-bus.js';
import { Abject } from '../core/abject.js';
import { Registry } from './registry.js';
import { SettingsManager } from './settings-manager.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectMessage, AbjectManifest, InterfaceId } from '../core/types.js';

function mkManifest(name: string, description: string): AbjectManifest {
  return {
    name,
    description,
    version: '1.0.0',
    interface: {
      id: `abjects:${name.toLowerCase()}` as InterfaceId,
      name,
      description,
      methods: [
        { name: 'ping', description: 'Ping', parameters: [], returns: { kind: 'primitive', primitive: 'string' } },
      ],
    },
    tags: ['test'],
  } as unknown as AbjectManifest;
}

class Stub extends Abject {
  constructor(name: string, description: string) {
    super({ manifest: mkManifest(name, description) });
  }
  async call<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
  /** Public registration shim: `on` is protected. */
  hook(method: string, fn: (msg: AbjectMessage) => unknown): void {
    this.on(method, fn);
  }
}

/** WorkspaceManager stand-in: answers findWorkspaceForObject from a scripted map. */
class WorkspaceManagerStub extends Stub {
  answers = new Map<AbjectId, { accessMode: string; joined?: boolean } | null>();
  constructor() {
    super('WorkspaceManager', 'Answers findWorkspaceForObject from a scripted map');
    this.on('findWorkspaceForObject', (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.answers.get(objectId) ?? null;
    });
  }
}

/** Storage stand-in: in-memory set/get/delete for SettingsManager persistence. */
class StorageStub extends Stub {
  data = new Map<string, unknown>();
  constructor() {
    super('Storage', 'In-memory key/value storage');
    this.on('set', (msg: AbjectMessage) => {
      const { key, value } = msg.payload as { key: string; value: unknown };
      this.data.set(key, value);
      return { ok: true };
    });
    this.on('get', (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      return this.data.has(key) ? this.data.get(key) : null;
    });
    this.on('delete', (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      this.data.delete(key);
      return { ok: true };
    });
  }
}

interface Harness {
  bus: MessageBus;
  reg: Registry;
  settings: SettingsManager;
  storage: StorageStub;
  wm: WorkspaceManagerStub;
  ui: Stub;
}

async function harness(): Promise<Harness> {
  const bus = new MessageBus();
  const reg = new Registry();
  await reg.init(bus);

  const wm = new WorkspaceManagerStub();
  await wm.init(bus);
  reg.registerObject(wm.id, wm.manifest, undefined, undefined, undefined, 'WorkspaceManager');

  const storage = new StorageStub();
  await storage.init(bus);
  reg.registerObject(storage.id, storage.manifest, undefined, undefined, undefined, 'Storage');

  const llm = new Stub('LLM', 'Language model service stand-in');
  await llm.init(bus);
  llm.hook('*', () => []);
  reg.registerObject(llm.id, llm.manifest, undefined, undefined, undefined, 'LLM');

  const ui = new Stub('UIServer', 'UI server stand-in');
  await ui.init(bus);
  ui.hook('*', () => ({}));
  reg.registerObject(ui.id, ui.manifest, undefined, undefined, undefined, 'UIServer');

  // Login and sessions belong to AuthGate; SettingsManager hands auth changes to it.
  const authGate = new Stub('AuthGate', 'Login and session stand-in');
  await authGate.init(bus);
  authGate.hook('*', () => ({}));
  reg.registerObject(authGate.id, authGate.manifest, undefined, undefined, undefined, 'AuthGate');

  // discoverDep caches its answer (including a miss), so every dependency
  // must be registered before SettingsManager.init runs requireDep.
  const settings = new SettingsManager();
  reg.registerObject(settings.id, settings.manifest, undefined, undefined, undefined, 'SettingsManager');
  // Factory.spawnInstance pre-seeds the registry hint before init so that
  // discoverDep can resolve the Registry and find dependencies; mirror that
  // wiring here (bare MessageBus + Registry has no Factory parent).
  settings.setRegistryHint(reg.id);
  await settings.init(bus);

  return { bus, reg, settings, storage, wm, ui };
}

/** Register a caller under a durable name + typeId, like Factory does. */
function registerCaller(h: Harness, caller: Stub, name: string, typeId: string): void {
  h.reg.registerObject(caller.id, caller.manifest, undefined, undefined, undefined, name, typeId);
}

async function tryWrite(h: Harness, caller: Stub): Promise<{ ok: boolean; error?: string }> {
  try {
    await caller.call(h.settings.id, 'setSettings', {
      section: 'permissions',
      values: { mode: 'deny' },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

const PEER = 'peer-alpha';

test('GlobalSettings (Settings UI) may change global settings', async () => {
  const h = await harness();
  const caller = new Stub('Any', 'carries the GlobalSettings identity in this scenario');
  await caller.init(h.bus);
  registerCaller(h, caller, 'GlobalSettings', `${PEER}/ws-main/GlobalSettings`);
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, true, r.error);
});

test('CliServer (commune CLI) may change global settings', async () => {
  const h = await harness();
  const caller = new Stub('Any', 'carries the CliServer identity in this scenario');
  await caller.init(h.bus);
  registerCaller(h, caller, 'CliServer', `${PEER}/ws-main/CliServer`);
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, true, r.error);
});

test('an abject inside a local workspace may change global settings', async () => {
  const h = await harness();
  const caller = new Stub('Helper', 'a user abject inside the local workspace');
  await caller.init(h.bus);
  registerCaller(h, caller, 'Helper', `${PEER}/ws-main/user/Helper`);
  h.wm.answers.set(caller.id, { accessMode: 'local' });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, true, r.error);
});

test('an agent inside a local workspace may change global settings', async () => {
  const h = await harness();
  const caller = new Stub('AgentX', 'an agent inside the local workspace');
  await caller.init(h.bus);
  registerCaller(h, caller, 'AgentX', `${PEER}/ws-main/user/AgentX`);
  h.wm.answers.set(caller.id, { accessMode: 'local' });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, true, r.error);
});

test('an abject inside a shared workspace may NOT change global settings', async () => {
  const h = await harness();
  const caller = new Stub('SharedHelper', 'a user abject inside a shared workspace');
  await caller.init(h.bus);
  registerCaller(h, caller, 'SharedHelper', `${PEER}/ws-shared/user/SharedHelper`);
  h.wm.answers.set(caller.id, { accessMode: 'shared' });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /SettingsManager takes this request/);
});

test('an abject inside a public workspace may NOT change global settings', async () => {
  const h = await harness();
  const caller = new Stub('PubHelper', 'a user abject inside a public workspace');
  await caller.init(h.bus);
  registerCaller(h, caller, 'PubHelper', `${PEER}/ws-public/user/PubHelper`);
  h.wm.answers.set(caller.id, { accessMode: 'public' });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /SettingsManager takes this request/);
});

test('a joined local MIRROR of a remote workspace is denied even though its accessMode reads local', async () => {
  const h = await harness();
  const caller = new Stub('MirrorHelper', 'a user abject inside a joined remote workspace mirror');
  await caller.init(h.bus);
  registerCaller(h, caller, 'MirrorHelper', `${PEER}/ws-joined/user/MirrorHelper`);
  h.wm.answers.set(caller.id, { accessMode: 'local', joined: true });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /SettingsManager takes this request/);
});

test('an unresolvable caller (no registry identity, no workspace answer) is denied', async () => {
  const h = await harness();
  const caller = new Stub('Ghost', 'never registered anywhere');
  await caller.init(h.bus);
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /SettingsManager takes this request/);
});

test('an allowed write persists through Storage', async () => {
  const h = await harness();
  const caller = new Stub('AgentY', 'an agent inside the local workspace');
  await caller.init(h.bus);
  registerCaller(h, caller, 'AgentY', `${PEER}/ws-main/user/AgentY`);
  h.wm.answers.set(caller.id, { accessMode: 'local' });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, true, r.error);
  const wrote = [...h.storage.data.values()].some((v) => v === 'deny');
  assert.equal(wrote, true, 'expected the prompt mode to reach Storage');
});

test('a denied write leaves Storage untouched', async () => {
  const h = await harness();
  const caller = new Stub('SharedAgent', 'an agent inside a shared workspace');
  await caller.init(h.bus);
  registerCaller(h, caller, 'SharedAgent', `${PEER}/ws-shared/user/SharedAgent`);
  h.wm.answers.set(caller.id, { accessMode: 'shared' });
  const r = await tryWrite(h, caller);
  assert.equal(r.ok, false);
  assert.equal(h.storage.data.size, 0, 'denied write must not persist anything');
});
