import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { AgentAbject } from './agent-abject.js';
import { ScrumMaster } from './scrum-master.js';
import { GoalManager } from './goal-manager.js';
import { Registry } from './registry.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Dispatch fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
  }
  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 2000); }
}
class Runtime extends AgentAbject { protected override async onInit(): Promise<void> {} }
class Scrum extends ScrumMaster { protected override async onInit(): Promise<void> {} }
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Fixture did not settle');
}
async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  return {
    async add<T extends Abject>(object: T): Promise<T> {
      object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
    },
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}
async function scrumFixture() {
  const f = await fixture();
  const runtime = await f.add(new Endpoint('AgentAbject')), goals = await f.add(new Endpoint('GoalManager')), scrum: any = await f.add(new Scrum());
  scrum.goalManagerId = goals.id; scrum.agentAbjectId = runtime.id;
  const scratchpad: any = { 'learning/plans': [{ revision: 1, operationId: 'first-round' }] };
  const calls: string[] = [], enqueued: any[] = [];
  goals.on('getGoal', () => ({ status: 'active', currentScrumNumber: 1, scratchpad: structuredClone(scratchpad) }));
  goals.on('recordPlan', msg => {
    calls.push('recordPlan');
    const p = msg.payload as any, plans = scratchpad['learning/plans'];
    const prior = plans.find((x: any) => x.operationId === p.operationId);
    if (prior) return { success: true, duplicate: true };
    if (p.expectedRevision !== plans.at(-1).revision) return { success: false, conflict: true, revision: plans.at(-1).revision };
    plans.push({ revision: p.expectedRevision + 1, operationId: p.operationId });
    return { success: true };
  });
  goals.on('cancelOutstandingTasks', () => { calls.push('cancel'); return { safe: true }; });
  goals.on('startNextScrum', () => ({ scrumNumber: 2 }));
  goals.on('addTask', () => ({ taskId: 'commit-task' }));
  goals.on('recordScrumCommit', msg => { const p = msg.payload as any; scratchpad[`learning/commit/${p.operationId}`] = p.outcome ?? true; return { success: true }; });
  goals.on('recordObservation', msg => { const p = msg.payload as any; scratchpad[`learning/observation/${p.operationId}`] = p.observation; return { success: true }; });
  goals.on('writeGoalData', msg => { const p = msg.payload as any; scratchpad[p.key] = p.value; return { success: true }; });
  goals.on('failGoal', () => { calls.push('fail'); });
  runtime.on('enqueueTask', msg => { enqueued.push(msg.payload); return { queued: true }; });
  scrum.scrumInFlight.set('round-2', { goalId: 'goal', planRevision: 1, staged: [{ description: 'Create commits', assignedAgentId: 'worker', assignedAgentName: 'Worker', dependsOnIdx: [] }] });
  return { ...f, runtime, goals, scrum, scratchpad, calls, enqueued };
}

for (const modelRevision of [0, 2, '1']) {
  test(`dispatch uses the observed revision even when the model supplies ${JSON.stringify(modelRevision)}`, async () => {
    const f = await scrumFixture();
    try {
      const result = await f.runtime.call(f.scrum.id, 'agentAct', { taskId: 'round-2', action: { action: 'dispatch_scrum', planRevision: modelRevision } });
      assert.equal(result.success, true);
      assert.equal(f.scratchpad['learning/plans'].at(-1).revision, 2);
      assert.equal(f.enqueued.length, 1);
      await f.runtime.call(f.scrum.id, 'taskResult', { ticketId: 'round-2', success: true, lastAction: { action: 'dispatch_scrum' } });
      assert.equal(f.enqueued.length, 1, 'terminal delivery cannot dispatch accepted work again');
    } finally { await f.stop(); }
  });
}

test('a real revision conflict returns feedback and a fresh observation before any cancellation', async () => {
  const f = await scrumFixture();
  try {
    f.scratchpad['learning/plans'].push({ revision: 2, operationId: 'new-plan' });
    const result = await f.runtime.call(f.scrum.id, 'agentAct', { taskId: 'round-2', action: { action: 'dispatch_scrum' } });
    assert.equal(result.success, false);
    assert.match(result.error, /observed 1, current 2/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.enqueued.length, 0);
    assert.equal(f.scrum.scrumInFlight.get('round-2').staged.length, 0);
    f.scrum.buildReviewSnapshot = async () => ({ data: { planRevision: 2, failed: [], team: [] } });
    const observed = await f.runtime.call(f.scrum.id, 'agentObserve', { taskId: 'round-2', step: 2 });
    assert.match(observed.observation, /"planRevision": 2/);
    assert.equal(f.scrum.scrumInFlight.get('round-2').planRevision, 2);
    await f.runtime.call(f.scrum.id, 'taskResult', { ticketId: 'round-2', success: false, error: result.error, lastAction: { action: 'dispatch_scrum' } });
    assert.equal(f.enqueued.length, 0, 'failed terminal tasks must not replay their last rejected action');
  } finally { await f.stop(); }
});

test('an old successful task result with a failed dispatch gets one durable replacement and failure evidence', async () => {
  const f = await scrumFixture();
  try {
    f.scratchpad['learning/plans'].push({ revision: 2, operationId: 'new-plan' });
    const payload = { ticketId: 'round-2', deliveryId: 'old-result', success: true, lastAction: { action: 'dispatch_scrum' } };
    await f.runtime.call(f.scrum.id, 'taskResult', payload);
    await f.runtime.call(f.scrum.id, 'taskResult', payload);
    assert.equal(f.enqueued.length, 1);
    assert.equal(f.enqueued[0].taskId, 'round-2:replan');
    assert.equal(f.scratchpad['learning/commit/round-2'], 'replanned');
    assert.equal(f.scratchpad['learning/observation/scrum-recovery/round-2'].verdict, 'contradicted');
    assert(!f.calls.includes('cancel'));
  } finally { await f.stop(); }
});

test('legacy planning conflict recovery has a finite retry budget', async () => {
  const f = await scrumFixture();
  try {
    for (let n = 0; n < 3; n++) {
      const id = `old-${n}`;
      f.scrum.scrumInFlight.set(id, { goalId: 'goal', planRevision: 0, staged: [{ description: 'commit', assignedAgentId: 'worker', dependsOnIdx: [] }] });
      await f.runtime.call(f.scrum.id, 'taskResult', { ticketId: id, success: true, lastAction: { action: 'dispatch_scrum' } });
    }
    assert(f.calls.includes('fail'));
    assert.equal(f.enqueued.length, 2);
  } finally { await f.stop(); }
});

for (const batched of [false, true]) {
  test(`effectful terminal ${batched ? 'in a batch' : 'alone'} records failure, retries, and finishes only after receiver acknowledgement`, async () => {
    const f = await fixture();
    try {
      const runtime: any = await f.add(new Runtime()), worker = await f.add(new Endpoint('Worker'));
      const results: any[] = []; let attempts = 0, thinks = 0, release!: () => void;
      worker.on('taskResult', msg => { results.push(msg.payload); });
      worker.on('agentObserve', () => ({ observation: 'Current state' }));
      worker.on('agentAct', async msg => {
        const p = msg.payload as any;
        if (p.action.action === 'stage') return { success: true };
        if (++attempts === 1) return { success: false, error: 'Plan changed; refresh observation' };
        await new Promise<void>(resolve => { release = resolve; });
        return { success: true, data: 'Dispatch acknowledged' };
      });
      runtime.think = async (entry: any) => {
        thinks++;
        return batched && thinks === 1
          ? runtime.parseAction(entry, '```json\n{"action":"stage"}\n```\n```json\n{"action":"dispatch","reasoning":"ready"}\n```')
          : { action: 'dispatch', expect: 'work is enqueued', expectOutcome: 'success' };
      };
      await worker.call(runtime.id, 'registerAgent', { name: 'Worker', config: { directExecution: true, skipFirstObservation: true, maxSteps: 6, actions: ['stage', 'dispatch'], terminalActions: { dispatch: { type: 'success', execute: true } } } });
      await worker.call(runtime.id, 'startTask', { taskId: 'decision', task: 'Dispatch work' });
      await until(() => !!release);
      assert.equal(results.length, 0);
      assert.equal((await worker.call(runtime.id, 'getTicket', { ticketId: 'decision' })).status, 'running');
      release();
      await until(() => results.length > 0);
      assert.equal(results[0].success, true);
      assert.equal(results[0].result, 'Dispatch acknowledged');
      assert.equal(attempts, 2);
      assert.equal(thinks, 2);
      const transcript = await worker.call(runtime.id, 'getTaskTranscript', { taskId: 'decision' });
      const predictions = transcript.predictions.filter((p: any) => p.action === 'dispatch');
      assert.equal(predictions.length, 2);
      assert.equal(predictions[0].outcome, 'failure');
      assert.equal(predictions[1].outcome, 'success');
    } finally { await f.stop(); }
  });
}

test('a receipt persistence failure retries the receipt without dispatching work twice', async () => {
  const f = await scrumFixture();
  try {
    let writes = 0;
    f.goals.on('recordScrumCommit', msg => {
      const p = msg.payload as any;
      f.scratchpad[`learning/commit/${p.operationId}`] = true;
      if (++writes === 1) throw new Error('storage interrupted');
      return { success: true };
    });
    const payload = { taskId: 'round-2', action: { action: 'dispatch_scrum' } };
    assert.equal((await f.runtime.call(f.scrum.id, 'agentAct', payload)).success, false);
    assert.equal((await f.runtime.call(f.scrum.id, 'agentAct', payload)).success, true);
    assert.equal(f.enqueued.length, 1);
    assert.equal(writes, 2);
  } finally { await f.stop(); }
});

class Goals extends GoalManager { protected override async onInit(): Promise<void> {} }
test('a retried goal-creation operation returns the same goal and remains scoped to its caller', async () => {
  const f = await fixture();
  try {
    const goals = await f.add(new Goals()), chat = await f.add(new Endpoint('Chat')), other = await f.add(new Endpoint('OtherChat'));
    const payload = { title: 'Commit changes', description: 'Review and commit changes', operationId: 'routing-task' };
    const replies = await Promise.all([chat.call(goals.id, 'createGoal', payload), chat.call(goals.id, 'createGoal', payload)]);
    assert.equal(replies[0].goalId, replies[1].goalId);
    assert.equal((await chat.call(goals.id, 'listGoals')).length, 1);
    const unrelated = await other.call(goals.id, 'createGoal', payload);
    assert.notEqual(unrelated.goalId, replies[0].goalId);
    assert.equal((await chat.call(goals.id, 'listGoals')).length, 2);
  } finally { await f.stop(); }
});
