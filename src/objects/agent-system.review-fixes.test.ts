import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { PermissionBroker } from './permission-broker.js';
import { GoalManager } from './goal-manager.js';
import { ScrumMaster } from './scrum-master.js';
import { TupleSpace } from './tuple-space.js';
import { KnowledgeBase } from './knowledge-base.js';
import { TaskReviewer } from './task-reviewer.js';
import { RunningProcess } from './capabilities/running-process.js';
import { ShellExecutor } from './capabilities/shell-executor.js';
import { WasmAbject } from './wasm-abject.js';
import { storeWasmModule } from '../sandbox/wasm-module-store.js';
import { extractWasmManifest } from '../sandbox/wasm-instance.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Review regression fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
  }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> {
    return this.request(request(this.id, to, method, payload), 5000);
  }
  public override on(method: string, handler: MessageHandlerFn): void { super.on(method, handler); }
}
class MemoryStore extends Endpoint {
  values = new Map<string, unknown>();
  constructor(name: string) {
    super(name);
    const key = (p: any) => `${p.name ?? ''}:${p.key}`;
    this.on('set', m => { this.values.set(key(m.payload), structuredClone((m.payload as any).value)); return true; });
    this.on('get', m => structuredClone(this.values.get(key(m.payload)) ?? null));
    this.on('keys', () => [...this.values.keys()].filter(k => k.startsWith(':')).map(k => k.slice(1)));
    this.on('getAll', m => {
      const prefix = `${(m.payload as any).name}:`;
      return structuredClone(Object.fromEntries([...this.values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])));
    });
    for (const method of ['create', 'subscribe', 'unsubscribe']) this.on(method, () => true);
  }
}
class HeadlessBroker extends PermissionBroker { protected override async onInit(): Promise<void> {} }
class HeadlessScrum extends ScrumMaster { protected override async onInit(): Promise<void> {} }
class HeadlessKnowledge extends KnowledgeBase { protected override async onInit(): Promise<void> {} }
class HeadlessReviewer extends TaskReviewer { protected override async onInit(): Promise<void> {} }

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  return {
    async add<T extends Abject>(object: T): Promise<T> {
      object.setRegistryHint(registry.id); await object.init(bus);
      registry.registerObject(object.id, object.manifest); objects.push(object); return object;
    },
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}

test('permission-rule mutations require receiver-owned approval, even for direct bus callers', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('UntrustedCaller'));
    const broker = await f.add(new HeadlessBroker());
    const rule = { kind: 'exact', caller: '*', command: 'printf review-fixture', allow: true };
    assert.equal((await caller.call(broker.id, 'addRule', { rule })).success, false, 'no dialog means no authority');
    let decision = 'deny';
    const prompts: any[] = [];
    const settings = new Endpoint('GlobalSettings');
    settings.on('showPermissionPrompt', m => { prompts.push(m); return { decision }; });
    await f.add(settings);
    assert.equal((await caller.call(broker.id, 'addRule', { rule })).success, false);
    assert.deepEqual(await caller.call(broker.id, 'listRules'), []);
    decision = 'approve_rule_change';
    assert.equal((await caller.call(broker.id, 'addRule', { rule })).success, true);
    assert.equal(prompts.at(-1).routing.from, broker.id);
    assert(prompts.at(-1).payload.resource.includes(rule.command));
    assert.match(prompts.at(-1).payload.resource, /may run/);
    decision = 'deny';
    assert.equal((await caller.call(broker.id, 'updateRule', { index: 0, rule: { ...rule, command: 'other command' } })).success, false);
    assert.equal((await caller.call(broker.id, 'removeRule', { index: 0 })).success, false);
    assert.equal((await caller.call(broker.id, 'listRules'))[0].command, rule.command);
    decision = 'approve_rule_change';
    assert.equal((await caller.call(broker.id, 'updateRule', { index: 0, rule: { ...rule, allow: false } })).success, true);
    assert.equal((await caller.call(broker.id, 'removeRule', { index: 0 })).success, true);
    assert.deepEqual(await caller.call(broker.id, 'listRules'), []);
  } finally { await f.stop(); }
});

test('queued rule approvals cannot overwrite a rule changed while awaiting approval', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('Editor'));
    const broker = await f.add(new HeadlessBroker());
    const settings = await f.add(new Endpoint('GlobalSettings'));
    settings.on('showPermissionPrompt', () => ({ decision: 'approve_rule_change' }));
    const rule = { kind: 'exact', caller: '*', command: 'initial command', allow: true };
    await caller.call(broker.id, 'addRule', { rule });
    const approvals: Array<(value: { decision: string }) => void> = [];
    settings.on('showPermissionPrompt', () => new Promise(resolve => { approvals.push(resolve); }));
    const first = caller.call(broker.id, 'updateRule', { index: 0, rule: { ...rule, command: 'first edit' } });
    const second = caller.call(broker.id, 'updateRule', { index: 0, rule: { ...rule, command: 'second edit' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals.length, 1, 'only one dialog owns approval at a time');
    approvals[0]({ decision: 'approve_rule_change' });
    assert.equal((await first).success, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvals.length, 2);
    approvals[1]({ decision: 'approve_rule_change' });
    assert.equal((await second).success, false);
    assert.equal((await caller.call(broker.id, 'listRules'))[0].command, 'first edit');
  } finally { await f.stop(); }
});

test('replanning waits for retained work and preserves backlog membership on replay and restart', async () => {
  const f = await fixture();
  try {
    const client = await f.add(new Endpoint('Worker'));
    const storage = await f.add(new MemoryStore('Storage'));
    await f.add(new MemoryStore('SharedState'));
    await f.add(new TupleSpace());
    const runtime = new Endpoint('AgentAbject');
    runtime.on('cancelTasksByGoal', () => ({ cancelled: 0 }));
    runtime.on('awaitGoalQuiescence', () => ({ safe: true, pending: [] }));
    runtime.on('enqueueTask', () => ({ queued: true }));
    await f.add(runtime);
    const goals: any = await f.add(new GoalManager());
    const scrum: any = await f.add(new HeadlessScrum());
    scrum.goalManagerId = goals.id; scrum.agentAbjectId = runtime.id;
    const events: any[] = [];
    client.on('goalReadyForCompletion', m => { events.push(m.payload); });
    const { goalId } = await client.call(goals.id, 'createGoal', { title: 'Retained work', description: 'Keep slow work during a replan' });
    await client.call(goals.id, 'startNextScrum', { goalId });
    const { taskId: kept } = await client.call(goals.id, 'addTask', { goalId, description: 'slow retained task', assignedAgentId: client.id });
    scrum.scrumInFlight.set('new-plan', { goalId, planRevision: 0, staged: [{ description: 'new fast task', assignedAgentId: client.id, assignedAgentName: 'Worker', dependsOnIdx: [] }] });
    // Seed planner output, then exercise its real commit and receiver protocols.
    await scrum.commitDispatchScrum('new-plan', goalId, { keepTaskIds: [kept], planRevision: 0 });
    const tasks = await client.call(goals.id, 'getTasksForGoal', { goalId });
    const fresh = tasks.find((t: any) => t.id !== kept);
    assert.equal(tasks.find((t: any) => t.id === kept).fields.scrumNumber, 1);
    assert.equal(fresh.fields.scrumNumber, 2);
    const replay = await client.call(goals.id, 'startNextScrum', { goalId, operationId: 'new-plan' });
    assert.equal(replay.duplicate, true);
    assert.deepEqual((await client.call(goals.id, 'getGoal', { goalId })).scratchpad['learning/backlog/2'], [kept]);
    assert.match(JSON.stringify([...storage.values]), new RegExp(kept));
    await goals.stop();
    const restored = await f.add(new GoalManager());
    assert.deepEqual((await client.call(restored.id, 'getGoal', { goalId })).scratchpad['learning/backlog/2'], [kept]);
    await client.call(restored.id, 'completeTask', { goalId, taskId: fresh.id, result: 'done' });
    assert.equal(events.length, 0);
    await client.call(restored.id, 'completeTask', { goalId, taskId: kept, result: 'done later' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.length, 1);
    assert.deepEqual(new Set(events[0].doneTaskIds), new Set([fresh.id, kept]));
    await assert.rejects(client.call(restored.id, 'startNextScrum', { goalId, preserveTaskIds: ['missing'] }), /Preserved tasks/);
  } finally { await f.stop(); }
});

const pattern = JSON.stringify({ format: 1, name: 'VERIFY RESTORATION', context: 'persistent settings',
  forces: 'live success can conceal failed restoration', therefore: 'restore before acceptance', evidence: 'candidate', links: [] });

for (const implementation of ['typescript', 'wasm'] as const) {
  test(`${implementation} KnowledgeBase supports the learning protocol through the bus`, async () => {
    const f = await fixture();
    const oldData = process.env.ABJECTS_DATA_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), 'abject-learning-review-'));
    process.env.ABJECTS_DATA_DIR = dir;
    try {
      const caller = await f.add(new Endpoint('AgentAbject'));
      const storage = await f.add(new MemoryStore('Storage'));
      await f.add(new MemoryStore('SharedState'));
      const identity = new Endpoint('Identity'); identity.on('getIdentity', () => ({ peerId: 'fixture-peer' })); await f.add(identity);
      let source: string | undefined;
      let manifest: any;
      if (implementation === 'wasm') {
        const bytes = await readFile(new URL('../../native/knowledge-base/main.wasm', import.meta.url));
        source = await storeWasmModule(bytes); manifest = await extractWasmManifest(bytes);
        const metadata = JSON.parse(await readFile(new URL('../../native/knowledge-base/abject.json', import.meta.url), 'utf8'));
        assert.deepEqual(metadata.manifest, manifest, 'shipped metadata describes the compiled receiver');
      }
      const kb = await f.add(source ? new WasmAbject({ manifest, source }) : new HeadlessKnowledge());
      const reviewer: any = await f.add(new HeadlessReviewer());
      reviewer.knowledgeBaseId = kb.id; reviewer.agentAbjectId = caller.id;
      reviewer.taskExtras.set('review', { kind: 'review', goalId: 'goal-a', reviewedTaskIds: ['task-a'] });
      const { id } = await caller.call(kb.id, 'remember', { title: 'VERIFY RESTORATION', content: pattern, type: 'pattern' });
      const application = { id: 'goal-a', goalId: 'goal-a', context: 'persistent settings', verdict: 'helpful', evidence: 'restored value matches saved value', patternRevision: 1 };
      const action = await caller.call(reviewer.id, 'agentAct', { taskId: 'review', action: { action: 'record_pattern_application', id, application } });
      assert.equal(action.success, true, JSON.stringify(action));
      const storedApplication = { ...application, id: `goal-a:${id}` };
      assert.equal((await caller.call(kb.id, 'recordPatternApplication', { id, application: storedApplication })).duplicate, true);
      assert.equal((await caller.call(kb.id, 'recordPatternApplication', { id, application: { ...storedApplication, evidence: 'conflicting observation' } })).success, false);
      await assert.rejects(caller.call(kb.id, 'recordPatternApplication', { id, application: { ...application, id: 'future', patternRevision: 99 } }), /Unknown pattern revision/);
      await caller.call(kb.id, 'recordPatternApplication', { id, application: { ...application, id: 'goal-b', goalId: 'goal-b', verdict: 'harmful', evidence: 'restore overwrote newer settings' } });
      assert.equal((await caller.call(kb.id, 'markUseful', { ids: [id], operationId: 'review-a' })).marked, 1);
      assert.equal((await caller.call(kb.id, 'markUseful', { ids: [id], operationId: 'review-a' })).marked, 0);
      assert.equal((await caller.call(kb.id, 'update', { id, content: pattern, expectedRevision: 1 })).success, true);
      assert.equal((await caller.call(kb.id, 'update', { id, content: pattern, expectedRevision: 1 })).conflict, true);
      const history = await caller.call(kb.id, 'patternHistory', { id });
      assert.equal(history.revision, 2); assert.equal(history.history.length, 1);
      assert.equal(history.applications.length, 2); assert.equal(history.feedbackIds.length, 1);
      assert.equal(JSON.parse(history.history[0].content).learning, undefined, 'history contains independent body snapshots');
      const found = await caller.call(kb.id, 'get', { id });
      assert.equal(found.usefulCount, 1); assert.deepEqual(found.pattern.learning, history);
      assert.match(found.content, /helpful in 1 distinct goals; counterexamples in 1 goals/);
      for (let i = 0; i < 105; i++) await caller.call(kb.id, 'remember', { title: `persistent settings fact ${i}`, content: 'persistent settings', type: 'fact' });
      assert.equal((await caller.call(kb.id, 'weave', { query: 'persistent settings', limit: 1 })).patterns[0].id, id);
      if (source) {
        await new Promise(resolve => setImmediate(resolve));
        assert(storage.values.has(`:knowledge-base:entry:${id}`));
        await kb.stop();
        const restored = await f.add(new WasmAbject({ manifest, source }));
        for (let tries = 0; tries < 50; tries++) {
          if (await caller.call(restored.id, 'patternHistory', { id })) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepEqual(await caller.call(restored.id, 'patternHistory', { id }), history);
        assert.equal((await caller.call(restored.id, 'markUseful', { ids: [id], operationId: 'review-a' })).marked, 0);
      }
    } finally {
      await f.stop();
      if (oldData === undefined) delete process.env.ABJECTS_DATA_DIR; else process.env.ABJECTS_DATA_DIR = oldData;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('reviewer refuses unsupported learning semantics before mutating an older receiver', async () => {
  const f = await fixture();
  try {
    const runtime = await f.add(new Endpoint('AgentAbject'));
    const legacy = await f.add(new Endpoint('KnowledgeBase'));
    let writes = 0; legacy.on('recordPatternApplication', () => { writes++; return { success: true }; });
    const reviewer: any = await f.add(new HeadlessReviewer());
    reviewer.knowledgeBaseId = legacy.id; reviewer.agentAbjectId = runtime.id;
    const result = await runtime.call(reviewer.id, 'agentAct', { taskId: 'review', action: { action: 'record_pattern_application', id: 'pattern', application: {} } });
    assert.equal(result.success, false); assert.match(result.error, /does not support the learning protocol/); assert.equal(writes, 0);
  } finally { await f.stop(); }
});

test('process previews report either-stream truncation and retain complete output behind the bus handle', async () => {
  const f = await fixture();
  try {
    const owner = await f.add(new Endpoint('Owner'));
    for (const stream of ['stdout', 'stderr'] as const) {
      const child = await f.add(new RunningProcess({ command: process.execPath, args: ['-e', `process.${stream}.write('x'.repeat(100000))`], owner: owner.id, supervisor: owner.id, timeout: 5000 }));
      const result = await owner.call(child.id, 'wait');
      assert.equal(result.outputBytes, 100000); assert.equal(result[stream].length, 65536);
      assert.equal(result.truncated, true); assert.deepEqual(result.truncatedStreams, [stream]);
      let text = '', offset = 0;
      while (offset < result.outputBytes) {
        const page = await owner.call(child.id, 'readOutput', { offset, length: 65536 });
        assert(page.nextOffset > offset); text += page.text; offset = page.nextOffset;
      }
      assert.equal(text, 'x'.repeat(100000));
    }
    const shell = await f.add(new ShellExecutor({ allowedCommands: [`${process.execPath} -e process.stdout.write('x'.repeat(100000))`], defaultTimeout: 5000 }));
    const result = await owner.call(shell.id, 'exec', { command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(100000))"] });
    assert.equal(result.exitCode, 0); assert.equal(result.truncated.totalBytes, 100000); assert.equal(result.truncated.stream, 'stdout');
    assert.equal((await owner.call(result.outputObjectId, 'readOutput', { offset: 99990 })).text, 'x'.repeat(10));
  } finally { await f.stop(); }
});
