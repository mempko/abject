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
import { TupleSpace } from './tuple-space.js';

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

for (const rejectSecondTask of [false, true]) {
  test(`real Scrum dispatch preserves its executing task during ${rejectSecondTask ? 'partial admission cleanup' : 'replacement cancellation'}`, async () => {
    const f = await fixture();
    try {
      const shared = new Endpoint('SharedState'), values = new Map<string, unknown>();
      shared.on('set', msg => { const p = msg.payload as any; values.set(`${p.name}:${p.key}`, structuredClone(p.value)); return true; });
      shared.on('delete', msg => { const p = msg.payload as any; return values.delete(`${p.name}:${p.key}`); });
      shared.on('getAll', msg => { const prefix = `${(msg.payload as any).name}:`; return Object.fromEntries([...values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), structuredClone(v)])); });
      for (const method of ['create', 'subscribe', 'unsubscribe']) shared.on(method, () => true);
      await f.add(shared);
      const runtime: any = await f.add(new Runtime()), tuples = await f.add(new TupleSpace());
      const goals: any = await f.add(new Goals()), scrum: any = await f.add(new Scrum());
      const client = await f.add(new Endpoint('Client')), worker = await f.add(new Endpoint('Worker'));
      Object.assign(goals, { tupleSpaceId: tuples.id, agentAbjectId: runtime.id });
      Object.assign(scrum, { goalManagerId: goals.id, agentAbjectId: runtime.id });
      runtime.goalManagerId = goals.id;
      const enqueued: any[] = [];
      // Observe worker admission without starting unrelated worker model loops.
      runtime.on('enqueueTask', (msg: any) => { enqueued.push(msg.payload); return { queued: true }; });
      const cancelled: string[] = [];
      worker.on('taskCancelled', msg => {
        const id = (msg.payload as any).taskId; cancelled.push(id);
        runtime.taskEntries.get(id).finished = true;
      });
      const { goalId } = await client.call(goals.id, 'createGoal', { title: 'Replace work', description: 'Dispatch a new plan while retaining selected work' });
      await client.call(goals.id, 'startNextScrum', { goalId });
      const workerTask = async (description: string) => {
        const { taskId } = await client.call(goals.id, 'addTask', { goalId, description, assignedAgentId: worker.id });
        runtime.taskEntries.set(taskId, { agentId: worker.id, goalId, config: {}, finished: false, state: { id: taskId, phase: 'acting' } });
        return taskId;
      };
      const kept = await workerTask('Keep this task'), obsolete = await workerTask('Replace this task');
      if (rejectSecondTask) {
        const original = goals.handlers.get('addTask'); let adds = 0;
        goals.on('addTask', (msg: any) => ++adds === 2 ? { error: 'Fixture admission rejected' } : original(msg));
      }
      scrum.scrumInFlight.set('planner', { goalId, planRevision: 0, staged: [
        { description: 'New task one', assignedAgentId: worker.id, assignedAgentName: 'Worker', dependsOnIdx: [] },
        { description: 'New task two', assignedAgentId: worker.id, assignedAgentName: 'Worker', dependsOnIdx: [] },
      ] });
      const decision = { action: 'dispatch_scrum', keepTaskIds: [kept], expect: 'The coordinator accepts this dispatch', expectOutcome: 'success' };
      runtime.think = async () => decision;
      await scrum.request(request(scrum.id, runtime.id, 'registerAgent', {
        name: 'ScrumMaster', config: { directExecution: true, skipFirstObservation: true, maxSteps: 3,
          actions: ['dispatch_scrum'], terminalActions: { dispatch_scrum: { type: 'success', execute: true } } },
      }));
      await scrum.request(request(scrum.id, runtime.id, 'startTask', { taskId: 'planner', task: 'Dispatch the new round', goalId }));
      await until(() => runtime.taskEntries.get('planner')?.finished);
      const planner = runtime.taskEntries.get('planner');
      assert.equal(planner.state.phase, 'done', planner.state.error);
      assert.equal(planner.state.error, undefined);
      assert.deepEqual(cancelled, [obsolete], 'replacement cancels obsolete work while preserving the planner and retained workers');
      assert.equal(runtime.taskEntries.get(kept).state.phase, 'acting');
      const evidence = await client.call(runtime.id, 'getTaskTranscript', { taskId: 'planner' });
      assert.equal(evidence.predictions.find((p: any) => p.action === 'dispatch_scrum').outcome, 'success', 'dispatch acknowledgement reaches the prediction ledger');
      const goal = await client.call(goals.id, 'getGoal', { goalId });
      assert.deepEqual(goal.scratchpad['learning/backlog/2'], [kept], 'the planner is not a worker backlog tuple');
      const tasks = await client.call(goals.id, 'getTasksForGoal', { goalId });
      assert.equal(tasks.find((t: any) => t.id === obsolete).fields.status, 'superseded');
      assert.equal(tasks.find((t: any) => t.id === kept).fields.status, 'pending');
      if (rejectSecondTask) {
        assert.equal(enqueued.length, 1, 'only the recovery scrum is enqueued');
        assert.equal(enqueued[0].agentId, scrum.id);
        assert.equal(tasks.find((t: any) => t.fields.description === 'New task one').fields.status, 'superseded');
      } else {
        assert.equal(enqueued.length, 2);
        assert(enqueued.every(t => t.agentId === worker.id));
        await runtime.request(request(runtime.id, scrum.id, 'taskResult', { ticketId: 'planner', success: true, lastAction: decision }));
        assert.equal(enqueued.length, 2, 'replaying terminal delivery does not duplicate dispatch');
      }
      // A user stop must still cancel Scrum: the exemption is scoped to this dispatch.
      runtime.taskEntries.set('another-planner', { agentId: scrum.id, goalId, config: {}, finished: false, state: { id: 'another-planner', phase: 'thinking' } });
      await client.call(goals.id, 'stopGoal', { goalId });
      assert.equal(runtime.taskEntries.get('another-planner').state.phase, 'error');
      assert.equal(runtime.taskEntries.get(kept).state.phase, 'error');
    } finally { await f.stop(); }
  });
}

test('quiescence excludes only explicitly preserved planning tasks, not every ScrumMaster operation', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Caller'));
    runtime.registeredAgents.set(caller.id, { agentId: caller.id, name: 'ScrumMaster' });
    runtime.taskEntries.set('stale-planner', { agentId: caller.id, goalId: 'goal', config: {}, finished: true,
      state: { id: 'stale-planner', phase: 'error' }, outstandingOperation: { taskId: 'stale-planner', step: 1 } });
    assert.equal((await caller.call(runtime.id, 'awaitGoalQuiescence', { goalId: 'goal' })).safe, false);
    assert.equal((await caller.call(runtime.id, 'awaitGoalQuiescence', { goalId: 'goal', preserveTaskIds: ['stale-planner'] })).safe, true);
  } finally { await f.stop(); }
});

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
