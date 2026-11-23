/**
 * The approval dialog's grant options against a real PermissionBroker:
 * "Deny and stop this task" must stop the work through the objects that own
 * it (GoalManager.stopGoal for a goal task, AgentAbject.cancelTask otherwise),
 * and a refused "Switch this chat to Auto" must be told to the person. Each
 * effect is proven where it lands: the owner stub records the stop call it
 * received, listGrants shows the revocation, and the dialog stub records the
 * notice the person was shown.
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
    super({ manifest: { name, version: '1', description: 'Broker dialog fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}

const WS = 'ws-dialog';
const target = (name: string) => path.join(os.tmpdir(), 'abject-broker-dialog', name);

type Answer = { answered: boolean; confirmed: boolean; option?: string };

async function fixture(opts: { goalId?: string; cancelOk?: boolean; stopOk?: boolean } = {}) {
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
  const settings = await add(new Endpoint('GlobalSettings'));
  const dialog = await add(new Endpoint('DialogBroker'));
  const runtime = await add(new Endpoint('AgentAbject'));
  const goals = await add(new Endpoint('GoalManager'));

  const asked: Array<Record<string, any>> = [];
  const answers: Answer[] = [];
  dialog.on('askPerson', (m) => {
    asked.push(m.payload as Record<string, any>);
    return answers.shift() ?? { answered: true, confirmed: true, option: 'ok' };
  });

  const cancelled: Array<Record<string, unknown>> = [];
  const stopped: Array<Record<string, unknown>> = [];
  runtime.on('getTaskStatus', () => ({ phase: 'thinking', step: 1, agentId: agent.id }));
  runtime.on('listTasks', () => [{ id: 't1', agentId: agent.id, goalId: opts.goalId ?? null }]);
  runtime.on('cancelTask', (m) => { cancelled.push(m.payload as Record<string, unknown>); return opts.cancelOk === false ? { success: false } : { success: true, where: 'in-flight' }; });
  goals.on('stopGoal', (m) => { stopped.push(m.payload as Record<string, unknown>); return opts.stopOk !== false; });

  const workspace = { workspaceId: WS, name: 'fixture', accessMode: 'local',
    childIds: [chatManager.id, chat.id, agent.id, runtime.id, goals.id], exposedObjectIds: [], registryId: registry.id };
  workspaces.on('listWorkspacesDetailed', () => [workspace]);
  const broker = await add(new PermissionBroker());
  return {
    chatManager, chat, agent, settings, broker, asked, answers, cancelled, stopped,
    async grant(id: string): Promise<any> {
      return (await settings.call(broker.id, 'listGrants') as any[]).find(x => x.id === id);
    },
    async stop() { for (const o of objects.reverse()) await o.stop(); },
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function chain(f: F, chatMode: unknown = 'manual') {
  const claimed = await f.chatManager.call(f.broker.id, 'claimRootGrant');
  assert.equal(claimed.success, true, `claimRootGrant: ${claimed.error ?? ''}`);
  const chatR = await f.chatManager.call(f.broker.id, 'deriveGrant',
    { parentId: claimed.grantId, holder: f.chat.id, holderLabel: 'chat', mode: chatMode, conversationId: 'c1' });
  assert.equal(chatR.success, true, `derive chat grant: ${chatR.error ?? ''}`);
  const taskR = await f.chat.call(f.broker.id, 'deriveGrant',
    { parentId: chatR.grant.id, holder: f.agent.id, holderLabel: 'task', mode: chatMode, taskId: 't1' });
  assert.equal(taskR.success, true, `derive task grant: ${taskR.error ?? ''}`);
  return { chatId: chatR.grant.id as string, taskId: taskR.grant.id as string };
}

function askWrite(f: F, file: string, grantId?: string) {
  return f.agent.call(f.broker.id, 'requestPermission', { type: 'directory', operation: 'write', resource: target(file), taskId: 't1', ...(grantId ? { grantId } : {}) });
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 20));
  }
  return true;
}

test('an agent tool call under a Manual task grant reaches the dialog with both grant options', async () => {
  const f = await fixture();
  try {
    await chain(f, 'manual');
    f.answers.push({ answered: true, confirmed: false });
    const r = await askWrite(f, 'reach.txt');
    assert.equal(r.decision, 'deny');
    assert.equal(f.asked.length, 1, 'the person was asked');
    const ids = (f.asked[0].groups as Array<{ options: Array<{ id: string }> }>).flatMap(g => g.options.map(o => o.id));
    assert.ok(ids.includes('grant_deny_stop'));
    assert.ok(ids.includes('grant_switch_auto'));
    assert.equal(f.asked[0].taskId, 't1');
  } finally { await f.stop(); }
});

test('Deny and stop on a goal task revokes the grant and stops the goal through GoalManager', async () => {
  const f = await fixture({ goalId: 'g1' });
  try {
    const { taskId } = await chain(f, 'manual');
    f.answers.push({ answered: true, confirmed: true, option: 'grant_deny_stop' });
    const r = await askWrite(f, 'stop-goal.txt');
    assert.equal(r.decision, 'deny');
    assert.ok(await until(() => f.stopped.length > 0), 'GoalManager.stopGoal was called');
    assert.deepEqual(f.stopped[0], { goalId: 'g1' });
    assert.equal(f.cancelled.length, 0, 'a stopped goal needs no separate cancel');
    assert.equal((await f.grant(taskId))?.live, false, 'the task grant is no longer live (revoked)');
    // As an agent's tool call does (capabilityCaller forwards the task grant id).
    const after = await askWrite(f, 'after-stop.txt', taskId);
    assert.equal(after.decision, 'deny', 'later requests under the grant are denied');
    assert.equal(f.asked.length, 1, 'no further question and no failure notice');
  } finally { await f.stop(); }
});

test('Deny and stop on a task with no goal cancels the task through AgentAbject', async () => {
  const f = await fixture();
  try {
    await chain(f, 'manual');
    f.answers.push({ answered: true, confirmed: true, option: 'grant_deny_stop' });
    const r = await askWrite(f, 'stop-task.txt');
    assert.equal(r.decision, 'deny');
    assert.ok(await until(() => f.cancelled.length > 0), 'AgentAbject.cancelTask was called');
    assert.equal(f.cancelled[0].taskId, 't1');
    assert.equal(f.cancelled[0].agentId, f.agent.id);
    assert.equal(f.stopped.length, 0);
  } finally { await f.stop(); }
});

test('Deny and stop that cannot stop the task tells the person', async () => {
  const f = await fixture({ cancelOk: false });
  try {
    await chain(f, 'manual');
    f.answers.push({ answered: true, confirmed: true, option: 'grant_deny_stop' });
    await askWrite(f, 'stop-fails.txt');
    assert.ok(await until(() => f.asked.length >= 2), 'a notice followed the question');
    assert.equal(f.asked[1].title, 'Task not stopped');
    assert.match(String(f.asked[1].message), /could not be stopped/);
  } finally { await f.stop(); }
});

test('a refused Switch to Auto allows this request once and tells the person', async () => {
  const f = await fixture();
  try {
    // A workspace ceiling of Manual: the chat cannot be raised to Auto.
    const root = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: WS, mode: 'manual', ceiling: 'manual' });
    assert.equal(root.success, true, root.error);
    const { chatId } = await chain(f, 'manual');
    const before = (await f.grant(chatId)).mode;
    f.answers.push({ answered: true, confirmed: true, option: 'grant_switch_auto' });
    const r = await askWrite(f, 'switch-refused.txt');
    assert.equal(r.decision, 'accept_once');
    assert.deepEqual((await f.grant(chatId)).mode, before, 'the chat mode did not move');
    assert.ok(await until(() => f.asked.length >= 2), 'the refusal was shown to the person');
    assert.equal(f.asked[1].title, 'Chat mode not changed');
    assert.match(String(f.asked[1].message), /could not be switched to Auto/);
  } finally { await f.stop(); }
});

test('an accepted Switch to Auto raises the chat grant and shows no notice', async () => {
  const f = await fixture();
  try {
    const { chatId } = await chain(f, 'manual');
    f.answers.push({ answered: true, confirmed: true, option: 'grant_switch_auto' });
    const r = await askWrite(f, 'switch-ok.txt');
    assert.equal(r.decision, 'accept_once');
    const g = await f.grant(chatId);
    assert.notEqual(g.mode.reach, 'read', `chat moved off Manual (now ${JSON.stringify(g.mode)})`);
    await new Promise(res => setTimeout(res, 100));
    assert.equal(f.asked.length, 1, 'no refusal notice');
  } finally { await f.stop(); }
});
