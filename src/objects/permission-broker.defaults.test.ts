/**
 * PermissionBroker follow-ups to the grant integration:
 *  - design §8 default grants for apps and packages: an app row minted by the
 *    person through grantMode, and a grant derived for a holder that is not
 *    built-in, default to Manual with ceiling Manual and mayDerive 0;
 *  - a task whose grant was revoked (Deny and stop) stays denied even when a
 *    request from that holder and task does not present the grant id.
 * Every test reads the result back from the broker (listGrants, listDecisions,
 * the asked list) rather than trusting a success flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { PermissionBroker } from './permission-broker.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Broker defaults fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}

const WS = 'ws1';
const target = (name: string) => path.join(os.tmpdir(), 'abject-broker-defaults', name);

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(object: T, source?: string): Promise<T> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus);
    // A registration with a source is not built-in (src/core/built-in.ts): that is an app.
    registry.registerObject(object.id, object.manifest, undefined, undefined, source);
    objects.push(object); return object;
  };
  const workspaces = await add(new Endpoint('WorkspaceManager'));
  const chatManager = await add(new Endpoint('ChatManager'));
  const chat = await add(new Endpoint('Chat'));
  const agent = await add(new Endpoint('Agent'));
  const stranger = await add(new Endpoint('Stranger'));
  const app = await add(new Endpoint('NotesApp'), 'script:notes-app');
  const settings = await add(new Endpoint('GlobalSettings'));
  const dialog = await add(new Endpoint('DialogBroker'));
  const asked: Array<Record<string, unknown>> = [];
  // If anything is asked, the person accepts: a deny must come from the broker, not the person.
  dialog.on('askPerson', (m) => { asked.push(m.payload as Record<string, unknown>); return { answered: true, confirmed: true }; });
  const workspace = { workspaceId: WS, name: 'fixture', accessMode: 'local',
    childIds: [chatManager.id, chat.id, agent.id, stranger.id, app.id], exposedObjectIds: [], registryId: registry.id };
  workspaces.on('listWorkspacesDetailed', () => [workspace]);
  const broker = await add(new PermissionBroker());
  return {
    chatManager, chat, agent, stranger, app, settings, broker, asked,
    async grant(id: string): Promise<any> {
      const g = (await settings.call(broker.id, 'listGrants') as any[]).find(x => x.id === id);
      assert.ok(g, `grant ${id} is listed`);
      return g;
    },
    async list(): Promise<any[]> { return await settings.call(broker.id, 'listGrants') as any[]; },
    async decisions(): Promise<any[]> { return await settings.call(broker.id, 'listDecisions', { limit: 50 }); },
    async stop() { for (const o of objects.reverse()) await o.stop(); },
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function chatGrant(f: F, chatMode: unknown) {
  // Raise the workspace root to Auto first: the default root is Manual, and a
  // chat's effective mode is the meet of its chain, so without this every
  // parent would be effectively Manual and the defaults would be untested.
  const root = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: 'ChatManager', mode: 'auto', ceiling: 'auto' });
  assert.equal(root.success, true, `grantMode root: ${root.error ?? ''}`);
  const claimed = await f.chatManager.call(f.broker.id, 'claimRootGrant');
  assert.equal(claimed.success, true, `claimRootGrant: ${claimed.error ?? ''}`);
  const chatR = await f.chatManager.call(f.broker.id, 'deriveGrant',
    { parentId: claimed.grantId, holder: f.chat.id, holderLabel: 'chat', mode: chatMode, conversationId: 'c1' });
  assert.equal(chatR.success, true, `derive chat grant: ${chatR.error ?? ''}`);
  return chatR.grant.id as string;
}

async function recordFor(f: F, file: string) {
  const rec = (await f.decisions()).find(d => d.resource === target(file));
  assert.ok(rec, `a decision was recorded for ${file}`);
  return rec;
}

const axes = (m: { reach: string; beyond: string }) => ({ reach: m.reach, beyond: m.beyond });

// ─── §8 default grants for apps and packages ───────────────────────────────

test('grantMode: an app row the person adds defaults to Manual, ceiling Manual, mayDerive 0', async () => {
  const f = await fixture();
  try {
    const r = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: 'NotesApp' });
    assert.equal(r.success, true, r.error);
    const row = (await f.list()).find(g => !g.parent && g.holderLabel === 'NotesApp');
    assert.ok(row, 'the app row is listed');
    assert.deepEqual(axes(row.mode), { reach: 'read', beyond: 'ask' }, 'mode is Manual');
    assert.deepEqual(axes(row.ceiling), { reach: 'read', beyond: 'ask' }, 'ceiling is Manual');
    assert.equal(row.mayDerive, 0, 'an app may not pass its grant on');

    // Above the app ceiling is refused unless the person raises the ceiling too.
    const tooHigh = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: 'NotesApp', mode: 'auto' });
    assert.equal(tooHigh.success, false);
    assert.match(String(tooHigh.error), /exceeds the ceiling/);

    // A later change that names only the mode keeps the row's other fields.
    const plan = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: 'NotesApp', mode: 'plan' });
    assert.equal(plan.success, true, plan.error);
    const after = await f.grant(row.id);
    assert.equal(after.mode.readOnly, true, 'now Plan');
    assert.deepEqual(axes(after.ceiling), { reach: 'read', beyond: 'ask' }, 'ceiling kept');
    assert.equal(after.mayDerive, 0, 'mayDerive kept');

    // ChatManager's row still needs an explicit mode and ceiling, as before.
    const cm = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, holderLabel: 'ChatManager' });
    assert.equal(cm.success, false);
    assert.match(String(cm.error), /bad mode or ceiling/);
  } finally { await f.stop(); }
});

test('deriveGrant: an app holder gets Manual, ceiling Manual, mayDerive 0 under a wider parent', async () => {
  const f = await fixture();
  try {
    const chatId = await chatGrant(f, 'acceptEdits');
    const r = await f.chat.call(f.broker.id, 'deriveGrant', { parentId: chatId, holder: f.app.id, holderLabel: 'NotesApp' });
    assert.equal(r.success, true, r.error);
    const g = await f.grant(r.grant.id);
    assert.equal(g.holder, f.app.id);
    assert.deepEqual(axes(g.mode), { reach: 'read', beyond: 'ask' }, 'Manual, not the parent\'s Accept edits');
    assert.deepEqual(axes(g.ceiling), { reach: 'read', beyond: 'ask' }, 'ceiling Manual');
    assert.equal(g.mayDerive, 0);

    // The defaults hold where they land: the app cannot pass it on or raise it.
    const passOn = await f.app.call(f.broker.id, 'deriveGrant', { parentId: g.id, holder: f.stranger.id });
    assert.equal(passOn.success, false);
    assert.match(String(passOn.error), /may not pass its grant on/);
    const raise = await f.app.call(f.broker.id, 'setMode', { grantId: g.id, mode: 'acceptEdits' });
    assert.equal(raise.success, false, 'cannot raise above the Manual ceiling');
    assert.deepEqual(axes((await f.grant(g.id)).mode), { reach: 'read', beyond: 'ask' }, 'mode unchanged');

    // A built-in holder derived the same way keeps the parent's mode, as before.
    const b = await f.chat.call(f.broker.id, 'deriveGrant', { parentId: chatId, holder: f.agent.id, holderLabel: 'task', taskId: 't1' });
    assert.equal(b.success, true, b.error);
    const bg = await f.grant(b.grant.id);
    assert.deepEqual(axes(bg.mode), { reach: 'edit', beyond: 'ask' }, 'built-in holder inherits Accept edits');
    assert.ok(bg.mayDerive > 0, 'built-in holder may still derive');
  } finally { await f.stop(); }
});

test('deriveGrant: an app under a Plan parent stays read-only (never above the parent)', async () => {
  const f = await fixture();
  try {
    const chatId = await chatGrant(f, 'plan');
    const r = await f.chat.call(f.broker.id, 'deriveGrant', { parentId: chatId, holder: f.app.id, holderLabel: 'NotesApp' });
    assert.equal(r.success, true, r.error);
    const g = await f.grant(r.grant.id);
    assert.equal(g.effective.readOnly, true);
    assert.equal(g.mayDerive, 0);
  } finally { await f.stop(); }
});

// ─── A revoked task grant stays denied without its id ──────────────────────

test('after Deny and stop, the same holder and task is denied without presenting the grant id', async () => {
  const f = await fixture();
  try {
    const chatId = await chatGrant(f, 'manual');
    const t = await f.chat.call(f.broker.id, 'deriveGrant', { parentId: chatId, holder: f.agent.id, holderLabel: 'task', taskId: 't1' });
    assert.equal(t.success, true, t.error);
    const taskGrant = t.grant.id as string;
    const rv = await f.chat.call(f.broker.id, 'revokeGrant', { grantId: taskGrant });
    assert.equal(rv.success, true, rv.error);
    assert.equal((await f.grant(taskGrant)).live, false);

    const r = await f.agent.call(f.broker.id, 'requestPermission',
      { type: 'directory', operation: 'read', resource: target('no-id.txt'), taskId: 't1' });
    assert.equal(r.decision, 'deny');
    assert.equal(f.asked.length, 0, 'the person is not asked again');
    const rec = await recordFor(f, 'no-id.txt');
    assert.equal(rec.asked, false);
    assert.match(rec.reason, /grant revoked or expired/);

    // Another task of the same holder is not caught by that task's revocation.
    await f.agent.call(f.broker.id, 'requestPermission',
      { type: 'directory', operation: 'read', resource: target('other-task.txt'), taskId: 't2' });
    const other = await recordFor(f, 'other-task.txt');
    assert.doesNotMatch(String(other.reason), /grant revoked or expired/);
  } finally { await f.stop(); }
});
