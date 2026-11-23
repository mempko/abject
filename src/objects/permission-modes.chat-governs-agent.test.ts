/**
 * The brief's done condition, end to end as far as a test can assemble it:
 * "a chat's chosen mode really governs that chat's agent tool calls".
 *
 * Real objects: PermissionBroker, HostFileSystem, JobManager, Registry, bus.
 * Stand-ins (Endpoints) send the exact messages the real objects send:
 *  - ChatManager: claimRootGrant, then deriveGrant {parentId, holder: chat,
 *    holderLabel, conversationId} with no mode (chat-manager.ts bindChatGrant).
 *  - Chat: setMode {mode, lowerOnly: false} as its window's picker does
 *    (chat.ts setMode, the person's path); the turn grant as
 *    deriveFromChatGrant does: getMyGrant, then deriveGrant {parentId,
 *    holder: the chat itself, holderLabel: 'Chat task', taskId}.
 *  - AgentAbject: submitJob {description, code, taskId, grantId}
 *    (agent-abject.ts submitJob) and getTaskStatus -> {agentId: chat}, which
 *    capabilityCaller (core/abject.ts) uses to name the task's agent.
 * A real Chat and AgentAbject are not stood up: both need an LLM, storage and
 * a window to run a turn. The hops proven with real code are JobManager's
 * invocation context carrying grantId, HostFileSystem's capabilityCaller
 * resolving it to the chat, and the broker's decision under the chat chain.
 * The goal path (Chat -> GoalManager admitTask -> per-task agent grant) is
 * not exercised here.
 *
 * A chat's effective mode is the meet of its chain below the workspace root
 * grant ChatManager claims: the root's mode (default Manual) only seeds new
 * chats, and its ceiling (default Auto) bounds them. The last test pins that
 * a chat raised to Accept edits under a Manual default is not capped, and
 * that lowering the workspace ceiling caps it at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { HostFileSystem } from './capabilities/host-filesystem.js';
import { PermissionBroker } from './permission-broker.js';
import { JobManager } from './job-manager.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Chat-mode fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}, timeout = 5000): Promise<any> {
    return this.request(request(this.id, to, method, payload), timeout);
  }
}

const TURN = 'chat-turn-fixture-1';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-chat-mode-'));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(object: T): Promise<T> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
  };
  const workspaces = await add(new Endpoint('WorkspaceManager'));
  const projects = await add(new Endpoint('ExternalProjectRegistry'));
  const chatManager = await add(new Endpoint('ChatManager'));
  const chat = await add(new Endpoint('Chat'));
  const runtime = await add(new Endpoint('AgentAbject'));
  const settings = await add(new Endpoint('GlobalSettings'));
  const dialog = await add(new Endpoint('DialogBroker'));
  const asked: Array<Record<string, unknown>> = [];
  let reply: { answered: boolean; confirmed: boolean; option?: string } = { answered: true, confirmed: false };
  dialog.on('askPerson', (m) => { asked.push(m.payload as Record<string, unknown>); return reply; });
  const project = { name: 'fixture', root: projectRoot, trusted: true, autonomy: 'edit', protectedPaths: [] as string[] };
  projects.on('resolveProject', msg => {
    const t = (msg.payload as any).nameOrPath;
    return t === project.name || t === project.root || String(t).startsWith(project.root + path.sep) ? project : null;
  });
  const workspace = { workspaceId: 'ws1', name: 'fixture', accessMode: 'local',
    childIds: [chatManager.id, chat.id, runtime.id], exposedObjectIds: [], registryId: registry.id };
  workspaces.on('listWorkspacesDetailed', () => [workspace]);
  // The task runtime names the task's agent: a chat turn's agent is the chat.
  // Every task in this fixture is one of the chat's turns.
  runtime.on('getTaskStatus', () => ({ agentId: chat.id }));
  const host = await add(new HostFileSystem({ allowedPaths: [projectRoot] }));
  const broker: any = await add(new PermissionBroker());
  await broker.request(request(broker.id, host.id, 'setPermissionsAuthority', {}));
  const jobs = await add(new JobManager());
  return {
    projectRoot, chatManager, chat, runtime, settings, broker, host, jobs, asked,
    answer(r: typeof reply) { reply = r; },
    async grant(id: string): Promise<any> {
      const g = (await settings.call(broker.id, 'listGrants') as any[]).find(x => x.id === id);
      assert.ok(g, `grant ${id} is listed`);
      return g;
    },
    async decisions(): Promise<any[]> { return await settings.call(broker.id, 'listDecisions', { limit: 50 }); },
    async stop() { for (const o of objects.reverse()) await o.stop(); await fs.rm(root, { recursive: true, force: true }); },
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** ChatManager binds the chat's grant; the person then picks a mode in the chat window. */
async function chatAt(f: F, mode: string, workspaceMode: string | null = 'auto'): Promise<string> {
  if (workspaceMode) {
    const ws = await f.settings.call(f.broker.id, 'grantMode',
      { workspaceId: 'ws1', holderLabel: 'ChatManager', mode: workspaceMode, ceiling: 'auto' });
    assert.equal(ws.success, true, `workspace default ${workspaceMode}: ${ws.error ?? ''}`);
  }
  const claimed = await f.chatManager.call(f.broker.id, 'claimRootGrant');
  assert.equal(claimed.success, true, `claimRootGrant: ${claimed.error ?? ''}`);
  const bound = await f.chatManager.call(f.broker.id, 'deriveGrant',
    { parentId: claimed.grantId, holder: f.chat.id, holderLabel: 'Chat fixture', conversationId: 'c1' });
  assert.equal(bound.success, true, `bind chat grant: ${bound.error ?? ''}`);
  const picked = await f.chat.call(f.broker.id, 'setMode', { mode, lowerOnly: false });
  assert.equal(picked.success, true, `pick ${mode}: ${picked.error ?? ''}`);
  return bound.grant.id as string;
}

/** The chat starts a turn: the turn's grant is derived from the chat's own, as deriveFromChatGrant does. */
async function startTurn(f: F): Promise<string> {
  const mine = await f.chat.call(f.broker.id, 'getMyGrant');
  const parentId = mine?.grant?.id ?? mine?.id;
  assert.ok(parentId, 'the chat holds a grant');
  const r = await f.chat.call(f.broker.id, 'deriveGrant', { parentId, holder: f.chat.id, holderLabel: 'Chat task', taskId: TURN });
  assert.equal(r.success, true, `derive turn grant: ${r.error ?? ''}`);
  return r.grant.id as string;
}

/** The agent runs a tool call as a job under the turn's task and grant. */
function agentWrites(f: F, file: string, content: string, grantId: string) {
  return f.runtime.call(f.jobs.id, 'submitJob', {
    description: 'Write a fixture file', taskId: TURN, grantId,
    code: `return await call('HostFileSystem', 'writeFile', {path: ${JSON.stringify(file)}, content: ${JSON.stringify(content)}});`,
  }, 15_000);
}

/** The newest decision the broker recorded for this write, read from its audit trail. */
async function decisionFor(f: F, file: string) {
  const all = await f.decisions();
  const rec = all.find(d => d.resource === file);
  assert.ok(rec, `a write decision was recorded for ${file}: ${JSON.stringify(all.slice(0, 3))}`);
  return rec;
}

async function content(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

test('a chat in Plan mode: its agent\'s write tool call is denied without asking', async () => {
  const f = await fixture();
  try {
    const chatGrant = await chatAt(f, 'plan');
    const turn = await startTurn(f);
    assert.equal((await f.grant(turn)).effective.readOnly, true, 'the turn inherits Plan');
    const file = path.join(f.projectRoot, 'plan.txt');
    const job = await agentWrites(f, file, 'written', turn);
    assert.notEqual(job.status, 'completed', `the write must not succeed: ${JSON.stringify(job)}`);
    assert.equal(await content(file), null, 'nothing was written');
    const rec = await decisionFor(f, file);
    assert.equal(rec.decision, 'deny', JSON.stringify(rec));
    assert.equal(rec.asked, false, 'Plan denies without a question');
    assert.equal(f.asked.length, 0);
    assert.equal(rec.basis, 'grant', JSON.stringify(rec));
    assert.equal(rec.caller, 'Chat', 'the decision names the chat as the caller');
    assert.equal(rec.grantId, turn, 'decided under the turn grant derived from the chat');
    assert.ok(chatGrant);
  } finally { await f.stop(); }
});

test('a chat in Accept edits: the same write tool call is allowed under the chat\'s grant', async () => {
  const f = await fixture();
  try {
    await chatAt(f, 'acceptEdits');
    const turn = await startTurn(f);
    assert.equal((await f.grant(turn)).effective.reach, 'edit');
    const file = path.join(f.projectRoot, 'edits.txt');
    const job = await agentWrites(f, file, 'written', turn);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(job.result.permission.callerId, f.chat.id, 'HostFileSystem resolved the job to the chat');
    assert.equal(job.result.permission.taskId, TURN);
    assert.equal(await content(file), 'written');
    const rec = await decisionFor(f, file);
    assert.equal(rec.decision.startsWith('accept') || rec.decision === 'allow', true, JSON.stringify(rec));
    assert.equal(rec.asked, false);
    // The allow comes from the project's own edit autonomy (a standing write
    // grant), which the chat's reach lets through: the same project under a
    // Manual chat asks instead (next test). The broker labels this basis 'rule'.
    assert.equal(rec.basis, 'rule', JSON.stringify(rec));
    assert.match(String(rec.reason), /Standing filesystem write grant/);
    assert.equal(rec.caller, 'Chat');
    assert.equal(rec.grantId, turn, 'decided under the turn grant derived from the chat');
    assert.equal(f.asked.length, 0);
  } finally { await f.stop(); }
});

test('a chat at Manual: the same write tool call asks the person, and their No stands', async () => {
  const f = await fixture();
  try {
    await chatAt(f, 'manual');
    const turn = await startTurn(f);
    assert.deepEqual([(await f.grant(turn)).effective.reach, (await f.grant(turn)).effective.beyond], ['read', 'ask']);
    f.answer({ answered: true, confirmed: false });
    const file = path.join(f.projectRoot, 'manual.txt');
    const job = await agentWrites(f, file, 'written', turn);
    assert.notEqual(job.status, 'completed', JSON.stringify(job));
    assert.equal(f.asked.length, 1, 'the person was asked once');
    assert.equal(await content(file), null);
    const rec = await decisionFor(f, file);
    assert.equal(rec.decision, 'deny', JSON.stringify(rec));
    assert.equal(rec.asked, true);
    assert.equal(rec.basis, 'person', JSON.stringify(rec));
    assert.equal(rec.grantId, turn);
  } finally { await f.stop(); }
});

test('lowering the chat to Plan mid-turn governs the running task\'s next tool call', async () => {
  const f = await fixture();
  try {
    await chatAt(f, 'acceptEdits');
    const turn = await startTurn(f);
    const first = path.join(f.projectRoot, 'first.txt'), second = path.join(f.projectRoot, 'second.txt');
    assert.equal((await agentWrites(f, first, 'one', turn)).status, 'completed');
    assert.equal(await content(first), 'one');
    // The person picks Plan while the turn is still running (the turn grant is not touched).
    const lowered = await f.chat.call(f.broker.id, 'setMode', { mode: 'plan', lowerOnly: false });
    assert.equal(lowered.success, true, lowered.error);
    const tg = await f.grant(turn);
    assert.equal(tg.mode.reach, 'edit', 'the turn grant\'s own mode is unchanged');
    assert.equal(tg.effective.readOnly, true, 'its effective mode follows the chat');
    const job = await agentWrites(f, second, 'two', turn);
    assert.notEqual(job.status, 'completed', JSON.stringify(job));
    assert.equal(await content(second), null);
    const rec = await decisionFor(f, second);
    assert.equal(rec.decision, 'deny', JSON.stringify(rec));
    assert.equal(f.asked.length, 0);
  } finally { await f.stop(); }
});

test('the turn grant is honoured only for the chat\'s own task: another task id presenting it is refused', async () => {
  const f = await fixture();
  try {
    await chatAt(f, 'acceptEdits');
    const turn = await startTurn(f);
    const file = path.join(f.projectRoot, 'other-task.txt');
    const job = await f.runtime.call(f.jobs.id, 'submitJob', {
      description: 'Write under a stolen grant', taskId: 'some-other-task', grantId: turn,
      code: `return await call('HostFileSystem', 'writeFile', {path: ${JSON.stringify(file)}, content: 'x'});`,
    }, 15_000);
    assert.notEqual(job.status, 'completed', JSON.stringify(job));
    assert.equal(await content(file), null);
    const rec = await decisionFor(f, file);
    assert.equal(rec.decision, 'deny', JSON.stringify(rec));
    assert.equal(rec.asked, false);
    assert.match(String(rec.reason), /grant not held by caller/);
  } finally { await f.stop(); }
});

test('the workspace default mode only seeds new chats: a chat that picks Accept edits writes unasked; the workspace ceiling still caps it', async () => {
  const f = await fixture();
  try {
    const chatGrant = await chatAt(f, 'acceptEdits', null);
    const cg = await f.grant(chatGrant);
    assert.equal(cg.mode.reach, 'edit', 'the chat stores Accept edits');
    assert.equal(cg.effective.reach, 'edit', 'the workspace default (Manual) does not cap a chat the person raised');
    const turn = await startTurn(f);
    const file = path.join(f.projectRoot, 'unasked.txt');
    const job = await agentWrites(f, file, 'written', turn);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(f.asked.length, 0, 'Accept edits writes in the project without asking');
    assert.equal(await content(file), 'written');

    // Lowering the workspace ceiling to Manual narrows the live chat and its task.
    const lowered = await f.settings.call(f.broker.id, 'grantMode',
      { workspaceId: 'ws1', holderLabel: 'ChatManager', mode: 'manual', ceiling: 'manual' });
    assert.equal(lowered.success, true, lowered.error);
    assert.equal((await f.grant(chatGrant)).effective.reach, 'read');
    f.answer({ answered: true, confirmed: false });
    const capped = path.join(f.projectRoot, 'capped.txt');
    const job2 = await agentWrites(f, capped, 'written', turn);
    assert.notEqual(job2.status, 'completed', JSON.stringify(job2));
    assert.equal(f.asked.length, 1, 'the capped chat asks, as Manual does');
    assert.equal(await content(capped), null);
    const rec = await decisionFor(f, capped);
    assert.equal(rec.asked, true);
    assert.equal(rec.grantId, turn);
  } finally { await f.stop(); }
});
