/**
 * Design §8: a row the person adds for an app or package in the grant editor
 * (PermissionBroker.grantMode with a holderLabel other than ChatManager) must
 * govern that app's own requests. The row is minted held by
 * `unclaimed:<label>:<ws>`; the broker binds it to the live app the first time
 * the app asks, matching only what the app cannot choose: the `package:<name>`
 * owner the Factory reserves for a package's abjects, or its type id.
 * Every test reads the outcome back from the broker (listGrants,
 * listDecisions, getMyGrant), not from a success flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { packageOwner } from '../core/packages.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { PermissionBroker } from './permission-broker.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'App claim fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}

const WS = 'ws1';
const PKG = 'notes-pkg';
const target = (name: string) => path.join(os.tmpdir(), 'abject-broker-app-claim', name);

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const workspace = { workspaceId: WS, name: 'fixture', accessMode: 'local',
    childIds: [] as AbjectId[], exposedObjectIds: [], registryId: registry.id };
  const add = async <T extends Abject>(object: T, opts: { owner?: string; source?: string; inWorkspace?: boolean } = {}): Promise<T> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus);
    // A source or a package owner makes the registration not built-in (src/core/built-in.ts).
    registry.registerObject(object.id, object.manifest, undefined, opts.owner as AbjectId | undefined, opts.source);
    if (opts.inWorkspace !== false) workspace.childIds.push(object.id);
    objects.push(object); return object;
  };
  const workspaces = await add(new Endpoint('WorkspaceManager'), { inWorkspace: false });
  const settings = await add(new Endpoint('GlobalSettings'), { inWorkspace: false });
  const dialog = await add(new Endpoint('DialogBroker'), { inWorkspace: false });
  const asked: Array<Record<string, unknown>> = [];
  // Whatever is asked, the person accepts: a deny has to come from the grant.
  dialog.on('askPerson', (m) => { asked.push(m.payload as Record<string, unknown>); return { answered: true, confirmed: true }; });
  workspaces.on('listWorkspacesDetailed', () => [workspace]);
  // The package's app, spawned by the Factory with the reserved owner.
  const app = await add(new Endpoint('NotesApp'), { owner: packageOwner(PKG), source: 'script:notes' });
  // A script that takes the package's name but is not from the package.
  const impostor = await add(new Endpoint(PKG), { source: 'script:impostor' });
  const broker = await add(new PermissionBroker(), { inWorkspace: false });
  return {
    registry, settings, broker, app, impostor, asked, add,
    async row(label: string): Promise<any> {
      const g = (await settings.call(broker.id, 'listGrants') as any[]).find(x => !x.parent && x.holderLabel === label && x.workspaceId === WS);
      assert.ok(g, `the ${label} row is listed`);
      return g;
    },
    async record(file: string): Promise<any> {
      const rec = (await settings.call(broker.id, 'listDecisions', { limit: 50 }) as any[]).find(d => d.resource === target(file));
      assert.ok(rec, `a decision was recorded for ${file}`);
      return rec;
    },
    async stop() { for (const o of objects.reverse()) await o.stop(); },
  };
}

test('a package row the person adds binds to the live package app and governs its requests', async () => {
  const f = await fixture();
  try {
    // The person adds the row in Settings → Grants, at Plan.
    const made = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: packageOwner(PKG), mode: 'plan' });
    assert.equal(made.success, true, made.error);
    const before = await f.row(packageOwner(PKG));
    assert.match(String(before.holder), /^unclaimed:/, 'nobody holds it yet');

    // The app writes, without naming any grant.
    const r = await f.app.call(f.broker.id, 'requestPermission',
      { type: 'directory', operation: 'write', resource: target('app-write.txt') });
    assert.equal(r.decision, 'deny');
    const rec = await f.record('app-write.txt');
    assert.equal(rec.grantId, before.id, 'the decision ran under the person\'s row');
    assert.equal(rec.asked, false, 'Plan refuses without asking');
    assert.match(String(rec.reason), /plan mode/);
    assert.equal(f.asked.length, 0, 'the person was not asked');

    const after = await f.row(packageOwner(PKG));
    assert.equal(after.id, before.id, 'the same row, not a new one');
    assert.equal(after.holder, f.app.id, 'the row is now held by the live app');
    const mine = await f.app.call(f.broker.id, 'getMyGrant');
    assert.equal(mine?.id, before.id, 'getMyGrant reports the row to the app');

    // The person changes the row; the app's next request follows it.
    const manual = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: packageOwner(PKG), mode: 'manual' });
    assert.equal(manual.success, true, manual.error);
    await f.app.call(f.broker.id, 'requestPermission',
      { type: 'directory', operation: 'write', resource: target('app-write-2.txt') });
    const rec2 = await f.record('app-write-2.txt');
    assert.equal(rec2.grantId, before.id);
    assert.doesNotMatch(String(rec2.reason ?? ''), /plan mode/, 'no longer Plan');
  } finally { await f.stop(); }
});

test('an object that only takes the package name does not claim the row', async () => {
  const f = await fixture();
  try {
    for (const label of [PKG, packageOwner(PKG)]) {
      const made = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: label, mode: 'plan' });
      assert.equal(made.success, true, made.error);
    }
    await f.impostor.call(f.broker.id, 'requestPermission',
      { type: 'directory', operation: 'write', resource: target('impostor.txt') });
    const rec = await f.record('impostor.txt');
    assert.equal(rec.grantId, undefined, 'the impostor runs under no grant');
    assert.match(String((await f.row(PKG)).holder), /^unclaimed:/);
    assert.match(String((await f.row(packageOwner(PKG))).holder), /^unclaimed:/);
    assert.equal(await f.impostor.call(f.broker.id, 'getMyGrant'), null);
  } finally { await f.stop(); }
});

test('a row held by a live app stays with it; after a respawn the new instance claims it', async () => {
  const f = await fixture();
  try {
    const made = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: PKG, mode: 'plan' });
    assert.equal(made.success, true, made.error);
    assert.equal((await f.app.call(f.broker.id, 'getMyGrant'))?.id, made.grant.id);

    // A second instance of the package while the first is alive: no theft.
    const twin = await f.add(new Endpoint('NotesApp'), { owner: packageOwner(PKG), source: 'script:notes' });
    await twin.call(f.broker.id, 'requestPermission', { type: 'directory', operation: 'write', resource: target('twin.txt') });
    assert.equal((await f.record('twin.txt')).grantId, undefined, 'the twin gets no grant');
    assert.equal((await f.row(PKG)).holder, f.app.id, 'the row stays with the first instance');

    // The first instance is gone (respawn): the next instance takes the row over.
    f.registry.unregisterObject(f.app.id);
    await twin.call(f.broker.id, 'requestPermission', { type: 'directory', operation: 'write', resource: target('respawned.txt') });
    const rec = await f.record('respawned.txt');
    assert.equal(rec.grantId, made.grant.id);
    assert.match(String(rec.reason), /plan mode/);
    assert.equal((await f.row(PKG)).holder, twin.id);
  } finally { await f.stop(); }
});
