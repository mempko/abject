/**
 * PermissionBroker's grant integration against a real broker on a bus: the
 * grant handlers (claimRootGrant, grantMode, deriveGrant, setMode, revokeGrant,
 * listGrants, describeGrant), decide() under a grant (plan mode, the beyond
 * axis, unheld and revoked grants, the person's prompt), and the receipt and
 * decision record each decision leaves. Every test reads the result back from
 * the broker (listGrants, describeGrant, listDecisions, the reply's receipt)
 * rather than trusting a success flag.
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
    super({ manifest: { name, version: '1', description: 'Broker grants fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}

interface View {
  id: string; parent?: string; holder: string; holderLabel?: string; taskId?: string; conversationId?: string;
  mode: { reach: string; beyond: string; readOnly?: boolean }; ceiling: { reach: string; beyond: string };
  effective: { reach: string; beyond: string; readOnly?: boolean }; live: boolean; types?: string[];
}

const WS = 'ws1';
const target = (name: string) => path.join(os.tmpdir(), 'abject-broker-grants', name);

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(object: T): Promise<T> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
  };
  const workspaces = await add(new Endpoint('WorkspaceManager'));
  const chatManager = await add(new Endpoint('ChatManager'));
  const chat = await add(new Endpoint('Chat'));
  const agent = await add(new Endpoint('Agent'));
  const stranger = await add(new Endpoint('Stranger'));
  const settings = await add(new Endpoint('GlobalSettings'));
  const dialog = await add(new Endpoint('DialogBroker'));
  const asked: Array<Record<string, unknown>> = [];
  let reply: { answered: boolean; confirmed: boolean; option?: string } = { answered: true, confirmed: false };
  dialog.on('askPerson', (m) => { asked.push(m.payload as Record<string, unknown>); return reply; });
  const workspace = { workspaceId: WS, name: 'fixture', accessMode: 'local',
    childIds: [chatManager.id, chat.id, agent.id, stranger.id], exposedObjectIds: [], registryId: registry.id };
  workspaces.on('listWorkspacesDetailed', () => [workspace]);
  const broker = await add(new PermissionBroker());
  return {
    chatManager, chat, agent, stranger, settings, broker, asked,
    answer(r: typeof reply) { reply = r; },
    async list(): Promise<View[]> { return await settings.call(broker.id, 'listGrants') as View[]; },
    async grant(id: string): Promise<View> {
      const g = (await settings.call(broker.id, 'listGrants') as View[]).find(x => x.id === id);
      assert.ok(g, `grant ${id} is listed`);
      return g;
    },
    async decisions(): Promise<any[]> { return await settings.call(broker.id, 'listDecisions', { limit: 50 }); },
    async stop() { for (const o of objects.reverse()) await o.stop(); },
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** Root (ChatManager) -> chat grant (Chat) -> task grant (Agent), each read back from listGrants. */
async function chain(f: F, chatMode: unknown = 'manual', taskMode: unknown = chatMode) {
  const claimed = await f.chatManager.call(f.broker.id, 'claimRootGrant');
  assert.equal(claimed.success, true, `claimRootGrant: ${claimed.error ?? ''}`);
  const rootId = claimed.grantId as string;
  const chatR = await f.chatManager.call(f.broker.id, 'deriveGrant',
    { parentId: rootId, holder: f.chat.id, holderLabel: 'chat', mode: chatMode, conversationId: 'c1' });
  assert.equal(chatR.success, true, `derive chat grant: ${chatR.error ?? ''}`);
  const chatId = chatR.grant.id as string;
  const taskR = await f.chat.call(f.broker.id, 'deriveGrant',
    { parentId: chatId, holder: f.agent.id, holderLabel: 'task', mode: taskMode, taskId: 't1' });
  assert.equal(taskR.success, true, `derive task grant: ${taskR.error ?? ''}`);
  const taskId = taskR.grant.id as string;
  return { rootId, chatId, taskId };
}

/** The agent asks for a directory operation under its task grant; the reply carries the receipt. */
function ask(f: F, from: Endpoint, operation: 'read' | 'write', file: string, extra: Record<string, unknown> = {}) {
  return from.call(f.broker.id, 'requestPermission', { type: 'directory', operation, resource: target(file), taskId: 't1', ...extra });
}

/** The newest record for a resource, read back from the broker's audit trail. */
async function recordFor(f: F, file: string) {
  const rec = (await f.decisions()).find(d => d.resource === target(file));
  assert.ok(rec, `a decision was recorded for ${file}`);
  return rec;
}

// ─── Grant handlers ───────────────────────────────────────────────────────

test('grantMode ceiling narrowing with live child grant persists to permission-broker:rules and survives reload', async () => {
  const store = new Map<string, unknown>();
  const boot = async () => {
    const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
    await registry.init(bus);
    const add = async <T extends Abject>(object: T, runOnInit = false): Promise<T> => {
      if (!runOnInit) (object as any).onInit = async () => {};
      object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
    };
    const storage = await add(new Endpoint('Storage'));
    storage.on('get', (m) => {
      const { key } = m.payload as { key: string };
      return store.has(key) ? structuredClone(store.get(key)) : null;
    });
    storage.on('set', (m) => {
      const { key, value } = m.payload as { key: string; value: unknown };
      store.set(key, structuredClone(value));
      return true;
    });
    const workspaces = await add(new Endpoint('WorkspaceManager'));
    const chatManager = await add(new Endpoint('ChatManager'));
    const chat = await add(new Endpoint('Chat'));
    const settings = await add(new Endpoint('GlobalSettings'));
    const dialog = await add(new Endpoint('DialogBroker'));
    dialog.on('askPerson', () => ({ answered: true, confirmed: false }));
    workspaces.on('listWorkspacesDetailed', () => [{
      workspaceId: WS, name: 'fixture', accessMode: 'local',
      childIds: [chatManager.id, chat.id], exposedObjectIds: [], registryId: registry.id,
    }]);
    const broker = await add(new PermissionBroker(), true);
    return {
      chatManager, chat, settings, broker,
      async stop() { for (const o of objects.reverse()) await o.stop(); },
    };
  };

  let rootId = '';
  let chatId = '';
  const first = await boot();
  try {
    const claimed = await first.chatManager.call(first.broker.id, 'claimRootGrant');
    assert.equal(claimed.success, true, `claimRootGrant: ${claimed.error ?? ''}`);
    rootId = claimed.grantId as string;

    const chatR = await first.chatManager.call(first.broker.id, 'deriveGrant', {
      parentId: rootId, holder: first.chat.id, holderLabel: 'chat',
      mode: 'manual', ceiling: { reach: 'full', beyond: 'ask' }, conversationId: 'c-persist',
    });
    assert.equal(chatR.success, true, `deriveGrant: ${chatR.error ?? ''}`);
    chatId = chatR.grant.id as string;

    const updated = await first.settings.call(first.broker.id, 'grantMode', {
      holder: first.chatManager.id, holderLabel: 'ChatManager', workspaceId: WS,
      mode: { reach: 'read', beyond: 'ask' }, ceiling: { reach: 'edit', beyond: 'ask' },
    });
    assert.equal(updated.success, true, `grantMode ceiling edit: ${updated.error ?? ''}`);

    const saved = store.get('permission-broker:rules') as { rules?: unknown[]; grants?: Array<{ id: string; ceiling: { reach: string; beyond: string } }> } | undefined;
    assert.ok(saved && Array.isArray(saved.grants), 'permission-broker:rules persisted immediately');
    assert.equal(store.has('permission-grants:v1'), false, 'no stale permission-grants:v1 key written');
    const savedRoot = saved.grants.find(g => g.id === rootId);
    const savedChat = saved.grants.find(g => g.id === chatId);
    assert.deepEqual(savedRoot?.ceiling, { reach: 'edit', beyond: 'ask' }, 'persisted root ceiling updated immediately');
    assert.deepEqual(savedChat?.ceiling, { reach: 'edit', beyond: 'ask' }, 'persisted child ceiling clamped immediately');
  } finally {
    await first.stop();
  }

  const second = await boot();
  try {
    const reloaded = await second.settings.call(second.broker.id, 'listGrants') as View[];
    const reloadedRoot = reloaded.find(g => g.id === rootId);
    const reloadedChat = reloaded.find(g => g.id === chatId);
    assert.ok(reloadedRoot, 'root grant reloaded across restart');
    assert.ok(reloadedChat, 'child chat grant reloaded across restart');
    assert.deepEqual(reloadedRoot.ceiling, { reach: 'edit', beyond: 'ask' }, 'reloaded root ceiling matches persisted value');
    assert.deepEqual(reloadedChat.ceiling, { reach: 'edit', beyond: 'ask' }, 'reloaded child ceiling remains clamped');
  } finally {
    await second.stop();
  }
});

test('claimRootGrant admits only ChatManager and mints one default root per workspace', async () => {
  const f = await fixture();
  try {
    const refused = await f.stranger.call(f.broker.id, 'claimRootGrant');
    assert.equal(refused.success, false);
    assert.equal((await f.list()).length, 0, 'a refused claim mints nothing');

    const first = await f.chatManager.call(f.broker.id, 'claimRootGrant');
    const again = await f.chatManager.call(f.broker.id, 'claimRootGrant');
    assert.equal(again.grantId, first.grantId, 'a second claim rebinds the same root');
    const roots = (await f.list()).filter(g => !g.parent);
    assert.equal(roots.length, 1);
    const root = roots[0];
    assert.equal(root.id, first.grantId);
    assert.equal(root.holder, f.chatManager.id);
    assert.equal(root.holderLabel, 'ChatManager');
    assert.deepEqual({ reach: root.mode.reach, beyond: root.mode.beyond }, { reach: 'full', beyond: 'ask' }, 'default is Auto');
    assert.deepEqual(root.ceiling, { reach: 'full', beyond: 'ask' });
  } finally { await f.stop(); }
});

test('grantMode is a settings-only write and refuses a mode above its ceiling', async () => {
  const f = await fixture();
  try {
    const notSettings = await f.stranger.call(f.broker.id, 'grantMode', { workspaceId: WS, mode: 'auto', ceiling: 'auto' });
    assert.equal(notSettings.success, false);
    assert.equal((await f.list()).length, 0, 'a refused grantMode stores nothing');

    const over = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, mode: 'fullAccess', ceiling: 'manual' });
    assert.equal(over.success, false);
    assert.equal((await f.list()).length, 0);

    const ok = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, mode: 'acceptEdits', ceiling: 'auto' });
    assert.equal(ok.success, true, ok.error);
    const stored = await f.grant(ok.grant.id);
    assert.equal(stored.mode.reach, 'edit');
    assert.equal(stored.ceiling.reach, 'full');
  } finally { await f.stop(); }
});

test('deriveGrant is holder-bound and never wider than its parent', async () => {
  const f = await fixture();
  try {
    const { rootId, chatId, taskId } = await chain(f);
    const chatG = await f.grant(chatId), taskG = await f.grant(taskId);
    assert.equal(chatG.parent, rootId);
    assert.equal(chatG.holder, f.chat.id);
    assert.equal(chatG.conversationId, 'c1');
    assert.equal(taskG.parent, chatId);
    assert.equal(taskG.holder, f.agent.id);
    assert.equal(taskG.taskId, 't1');

    const before = (await f.list()).length;
    const notHolder = await f.stranger.call(f.broker.id, 'deriveGrant', { parentId: chatId, holder: f.stranger.id, mode: 'manual' });
    assert.equal(notHolder.success, false, 'only the parent\'s holder may derive');
    const wider = await f.chat.call(f.broker.id, 'deriveGrant', { parentId: chatId, holder: f.agent.id, mode: 'fullAccess', taskId: 't2' });
    assert.equal(wider.success, false, 'a child may not exceed its parent');
    assert.equal((await f.list()).length, before, 'refused derivations store nothing');
  } finally { await f.stop(); }
});

test('setMode: lowerOnly cannot raise; lowering a parent lowers the child\'s effective mode', async () => {
  const f = await fixture();
  try {
    // The meet includes the root's own mode: under the default Manual root an
    // Accept edits chat is capped at read, so widen the workspace root first.
    const root = await f.settings.call(f.broker.id, 'grantMode',
      { workspaceId: WS, holderLabel: 'ChatManager', mode: 'acceptEdits', ceiling: 'auto' });
    assert.equal(root.success, true, root.error);
    const { chatId, taskId } = await chain(f, 'acceptEdits', 'acceptEdits');
    assert.equal((await f.grant(taskId)).effective.reach, 'edit');

    const raise = await f.chat.call(f.broker.id, 'setMode', { grantId: chatId, mode: 'auto', lowerOnly: true });
    assert.equal(raise.success, false);
    assert.equal((await f.grant(chatId)).mode.reach, 'edit', 'a refused raise leaves the mode');

    const lower = await f.chat.call(f.broker.id, 'setMode', { grantId: chatId, mode: 'plan', lowerOnly: true });
    assert.equal(lower.success, true, lower.error);
    const chatG = await f.grant(chatId), taskG = await f.grant(taskId);
    assert.equal(chatG.mode.readOnly, true);
    assert.equal(taskG.mode.reach, 'edit', 'the task grant\'s own mode is untouched');
    assert.equal(taskG.effective.reach, 'read', 'its effective mode is the live meet of the chain');
    assert.equal(taskG.effective.readOnly, true);
  } finally { await f.stop(); }
});

test('describeGrant is limited to the chain; revokeGrant takes the whole subtree', async () => {
  const f = await fixture();
  try {
    const { chatId, taskId } = await chain(f);
    const own = await f.agent.call(f.broker.id, 'describeGrant', { grantId: taskId });
    assert.ok(own, 'the holder can describe its grant');
    assert.equal(await f.stranger.call(f.broker.id, 'describeGrant', { grantId: taskId }) ?? null, null);
    const seen = await f.stranger.call(f.broker.id, 'listGrants') as View[];
    assert.ok(!seen.some(g => g.id === chatId || g.id === taskId), 'a stranger lists none of the chain');

    const r = await f.chat.call(f.broker.id, 'revokeGrant', { grantId: chatId });
    assert.equal(r.success, true, r.error);
    assert.ok(Number(r.revoked) >= 2, `chat and task revoked (got ${r.revoked})`);
    for (const id of [chatId, taskId]) assert.equal((await f.grant(id)).live, false, `${id} is no longer live`);
    // Proven where it lands: presenting the revoked task grant is refused without asking.
    const after = await ask(f, f.agent, 'read', 'after-revoke.txt', { grantId: taskId });
    assert.equal(after.decision, 'deny');
    const rec = await recordFor(f, 'after-revoke.txt');
    assert.equal(rec.asked, false);
    assert.match(rec.reason, /grant revoked or expired/);
    // Naming only the task, the agent no longer runs under the revoked grant:
    // the implicit lookup skips it and the request falls back to grant-less policy.
    await ask(f, f.agent, 'read', 'after-revoke-implicit.txt');
    const implicit = await recordFor(f, 'after-revoke-implicit.txt');
    assert.notEqual(implicit.grantId, taskId);
  } finally { await f.stop(); }
});

// ─── decide(), receipts and basis ────────────────────────────────────────

test('plan mode denies a write; the record and receipt name the grant and its chain', async () => {
  const f = await fixture();
  try {
    const { rootId, chatId, taskId } = await chain(f, 'plan', 'plan');
    const r = await ask(f, f.agent, 'write', 'plan-write.txt');
    assert.equal(r.decision, 'deny');
    assert.equal(f.asked.length, 0, 'nobody is asked');

    const rec = await recordFor(f, 'plan-write.txt');
    assert.equal(rec.decision, 'deny');
    assert.equal(rec.asked, false);
    assert.match(rec.reason, /plan mode/);
    assert.equal(rec.basis, 'grant');
    assert.equal(rec.grantId, taskId);
    assert.equal(rec.caller, 'Agent');

    const receipt = r.receipt;
    assert.ok(receipt, 'the reply carries a receipt');
    assert.equal(receipt.callerId, f.agent.id);
    assert.equal(receipt.taskId, 't1');
    assert.equal(receipt.basis, 'grant');
    assert.equal(receipt.grant?.id, taskId);
    assert.deepEqual([...receipt.grant.chain].sort(), [rootId, chatId, taskId].sort());
    assert.equal(receipt.grant.mode.readOnly, true);
  } finally { await f.stop(); }
});

test('the grant\'s beyond axis answers unattended: deny refuses, allow accepts', async () => {
  const f = await fixture();
  try {
    // Widen the workspace root so beyond=allow is within the ceiling.
    const root = await f.settings.call(f.broker.id, 'grantMode',
      { workspaceId: WS, holderLabel: 'ChatManager', mode: { reach: 'read', beyond: 'allow', readOnly: false }, ceiling: { reach: 'full', beyond: 'allow' } });
    assert.equal(root.success, true, root.error);
    const { taskId } = await chain(f, { reach: 'read', beyond: 'allow', readOnly: false }, { reach: 'read', beyond: 'deny', readOnly: false });
    assert.equal((await f.grant(taskId)).effective.beyond, 'deny');

    const denied = await ask(f, f.agent, 'write', 'beyond-deny.txt');
    assert.equal(denied.decision, 'deny');
    let rec = await recordFor(f, 'beyond-deny.txt');
    assert.equal(rec.asked, false);
    assert.equal(rec.basis, 'grant');
    assert.ok(rec.reason.includes(`grant ${taskId}`), rec.reason);

    const up = await f.chat.call(f.broker.id, 'setMode', { grantId: taskId, mode: { reach: 'read', beyond: 'allow', readOnly: false } });
    // A task grant may only lower; if the broker refuses this raise, derive a fresh allow task instead.
    let allowFrom = f.agent, extra: Record<string, unknown> = {};
    if (!up.success) {
      const d = await f.chat.call(f.broker.id, 'deriveGrant', { parentId: (await f.grant(taskId)).parent,
        holder: f.stranger.id, holderLabel: 'task2', mode: { reach: 'read', beyond: 'allow', readOnly: false }, taskId: 't2' });
      assert.equal(d.success, true, d.error);
      allowFrom = f.stranger; extra = { taskId: 't2' };
    }
    const allowed = await ask(f, allowFrom, 'write', 'beyond-allow.txt', extra);
    assert.equal(allowed.decision, 'accept_once');
    rec = await recordFor(f, 'beyond-allow.txt');
    assert.equal(rec.decision, 'accept_once');
    assert.equal(rec.asked, false);
    assert.equal(rec.basis, 'grant');
    assert.equal(allowed.receipt?.basis, 'grant');
    assert.equal(f.asked.length, 0, 'nobody is asked either way');
  } finally { await f.stop(); }
});

test('a grant named by someone who does not hold it is refused and recorded', async () => {
  const f = await fixture();
  try {
    const { taskId } = await chain(f, 'acceptEdits', 'acceptEdits');
    const r = await f.stranger.call(f.broker.id, 'requestPermission',
      { type: 'directory', operation: 'read', resource: target('smuggled.txt'), grantId: taskId, taskId: 't1' });
    assert.equal(r.decision, 'deny');
    const rec = await recordFor(f, 'smuggled.txt');
    assert.equal(rec.decision, 'deny');
    assert.equal(rec.caller, 'Stranger');
    assert.notEqual(rec.grantId, taskId, 'the stranger did not run under the grant');
  } finally { await f.stop(); }
});

test('a prompt under a grant shows the chain and grant options; the answer is recorded with basis person', async () => {
  const f = await fixture();
  try {
    const { taskId } = await chain(f, 'manual', 'manual');
    f.answer({ answered: true, confirmed: false });
    const r = await ask(f, f.agent, 'write', 'asked-write.txt');
    assert.equal(f.asked.length, 1, 'the person was asked once');
    const spec = JSON.stringify(f.asked[0]);
    assert.match(spec, /Authorized by/);
    assert.match(spec, /Effective mode/);
    assert.match(spec, /grant_deny_stop/, 'a task grant offers deny-and-stop');
    assert.match(spec, /grant_switch_auto/, 'a chat grant in the chain offers switch-to-Auto');

    assert.equal(r.decision, 'deny');
    const rec = await recordFor(f, 'asked-write.txt');
    assert.equal(rec.asked, true);
    assert.equal(rec.basis, 'person');
    assert.equal(rec.grantId, taskId);
    assert.equal(r.receipt?.basis, 'person');
    assert.equal(r.receipt?.grant?.id, taskId);
  } finally { await f.stop(); }
});
