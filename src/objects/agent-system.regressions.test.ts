import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { encodeAgentState } from '../core/agent-session-codec.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { AgentAbject } from './agent-abject.js';
import { Chat } from './chat.js';
import { ExternalCreator } from './external-creator.js';
import { ObjectCreator } from './object-creator.js';
import { GoalManager } from './goal-manager.js';
import { TaskSession } from './task-session.js';
import { TupleSpace } from './tuple-space.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Regression fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] },
      requiredCapabilities: [], providedCapabilities: [] } });
  }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> {
    return this.request(request(this.id, to, method, payload), 5000);
  }
}

class MemoryStore extends Endpoint {
  values = new Map<string, unknown>();
  constructor(name: string) {
    super(name);
    const key = (p: any) => `${p.name ?? ''}:${p.key}`;
    this.on('set', m => { this.values.set(key(m.payload), structuredClone((m.payload as any).value)); return true; });
    this.on('get', m => structuredClone(this.values.get(key(m.payload)) ?? null));
    this.on('delete', m => this.values.delete(key(m.payload)));
    this.on('getAll', m => {
      const prefix = `${(m.payload as any).name}:`;
      return structuredClone(Object.fromEntries([...this.values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v])));
    });
    for (const method of ['create', 'subscribe', 'unsubscribe', 'removeNamespace']) this.on(method, () => true);
  }
}

class HeadlessChat extends Chat { protected override async onInit(): Promise<void> {} }
class HeadlessRuntime extends AgentAbject { protected override async onInit(): Promise<void> {} }

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  return {
    async add<T extends Abject>(object: T): Promise<T> {
      object.setRegistryHint(registry.id);
      await object.init(bus);
      registry.registerObject(object.id, object.manifest);
      objects.push(object);
      return object;
    },
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}

test('durable results reach their original conversation when multiple Chats are registered', async () => {
  const f = await fixture();
  try {
    await f.add(new MemoryStore('Storage'));
    const runtime: any = await f.add(new HeadlessRuntime());
    const sessions = await f.add(new TaskSession());
    runtime.sessionStoreId = sessions.id;
    const chats: any[] = [await f.add(new HeadlessChat()), await f.add(new HeadlessChat())];
    for (const chat of chats) await chat.request(request(chat.id, runtime.id, 'registerAgent', { name: 'Chat' }));
    const waits = chats.map((chat, i) => chat.waitForTaskResult(`ticket-${i}`, 1000));
    // Attach rejection handlers immediately so a failing regression is clean.
    const results = Promise.all(waits);
    void results.catch(() => {});
    for (const [i, chat] of chats.entries()) {
      await runtime.request(request(runtime.id, sessions.id, 'checkpoint', {
        id: `ticket-${i}`, expectedRevision: 0, agentId: chat.id, agentName: 'Chat', intent: 'reply', status: 'accepted',
        outbox: [{ id: `delivery-${i}`, destination: chat.id, destinationName: 'Chat', delivered: false,
          payload: { ticketId: `ticket-${i}`, success: true, result: `answer-${i}` } }],
      }));
    }
    await runtime.deliverSessionOutbox();
    assert.deepEqual((await results).map(r => r.result), ['answer-0', 'answer-1']);
    assert.deepEqual(await runtime.request(request(runtime.id, sessions.id, 'pendingDeliveries', {})), []);
    assert.equal(runtime.resolveSessionAgent('missing-chat', 'Chat'), undefined, 'never substitute another conversation');
    assert.equal(runtime.resolveSessionAgent(chats[1].id, 'Chat').agentId, chats[1].id);
    assert.equal(runtime.resolveSessionAgent(undefined, 'Chat'), undefined, 'ambiguous legacy sessions require their original identity');
  } finally { await f.stop(); }
});

const invoke = (object: any, method: string, payload: unknown, from = 'runtime') =>
  object.handlers.get(method)({ routing: { from }, payload });

for (const Kind of [ExternalCreator, ObjectCreator]) {
  test(`${Kind.name} resume preserves collections through actual snapshot and restore messages`, async () => {
    const runtime: any = new AgentAbject(), creator: any = new Kind();
    creator.agentAbjectId = runtime.id;
    runtime.sessionStoreId = 'sessions';
    runtime.registeredAgents.set(creator.id, { agentId: creator.id, name: Kind.name, config: { restoreMethod: 'restoreTask' } });
    const collections = { filesRead: new Set(['src/a.ts']), preImages: new Map([['src/a.ts', 'before']]) };
    const extra = Kind === ExternalCreator
      ? { taskId: 'original', ...collections, mutationsSinceVerify: 0 }
      : { taskId: 'original', state: { ...collections, exercisedSinceDeploy: true } };
    const tasks = Kind === ExternalCreator ? creator.taskExtras : creator.tasks;
    tasks.set('original', extra);
    const specialist = await invoke(creator, 'snapshotTask', { taskId: 'original' }, runtime.id);
    const snapshot = encodeAgentState({ state: { id: 'original', llmMessages: [] }, config: {}, specialist });
    runtime.request = async (m: any) => {
      if (m.routing.method === 'get') return { agentId: creator.id, agentName: Kind.name, snapshot };
      if (m.routing.method === 'resume') return { success: true, session: { attempt: 2, revision: 2 } };
      if (m.routing.method === 'restoreTask') return invoke(creator, 'restoreTask', m.payload, runtime.id);
      throw new Error(m.routing.method);
    };
    runtime.runTaskAsync = async () => {};
    await invoke(runtime, 'resumeTask', { id: 'original', expectedRevision: 1 });
    const restored = tasks.get('original:attempt-2');
    const state = Kind === ExternalCreator ? restored : restored.state;
    assert(state.filesRead.has('src/a.ts'));
    assert.equal(state.preImages.get('src/a.ts'), 'before');
    state.filesRead.add('src/b.ts');
    assert.equal(collections.filesRead.has('src/b.ts'), false, 'restore owns an independent copy');
  });
}

test('GoalManager discovers a runtime spawned later for dispatch, pause, resume and stop', async () => {
  const f = await fixture();
  try {
    await f.add(new MemoryStore('Storage'));
    await f.add(new MemoryStore('SharedState'));
    await f.add(new TupleSpace());
    const goals = await f.add(new GoalManager()), client = await f.add(new Endpoint('Client'));
    const { goalId } = await client.call(goals.id, 'createGoal', { title: 'Review', description: 'Review repository' });
    const unavailable = await client.call(goals.id, 'cancelOutstandingTasks', { goalId });
    assert.equal(unavailable.safe, false);
    const runtime: any = await f.add(new AgentAbject());
    const receipt = await client.call(goals.id, 'cancelOutstandingTasks', { goalId });
    assert.equal(receipt.safe, true);
    await client.call(goals.id, 'pauseGoal', { goalId });
    assert(runtime.pausedGoals.has(goalId));
    await client.call(goals.id, 'resumeGoal', { goalId });
    assert.equal(runtime.pausedGoals.has(goalId), false);
    // A queued task must be removed by the actual runtime when the goal stops.
    runtime.agentTaskQueues.set('worker', { inFlight: new Map(), pending: [{ taskId: 'queued', goalId }] });
    await client.call(goals.id, 'stopGoal', { goalId });
    assert.equal(runtime.agentTaskQueues.get('worker').pending.length, 0);
  } finally { await f.stop(); }
});

for (const operation of ['pauseGoal', 'requestClarification', 'stopGoal', 'resumeGoal']) {
  test(`${operation} survives restart with matching persisted goal status`, async () => {
    const f = await fixture();
    try {
      const storage = await f.add(new MemoryStore('Storage'));
      await f.add(new MemoryStore('SharedState'));
      await f.add(new TupleSpace());
      const goals = await f.add(new GoalManager());
      await f.add(new AgentAbject());
      const client = await f.add(new Endpoint('Client'));
      const { goalId } = await client.call(goals.id, 'createGoal', { title: 'Review', description: 'Review repository' });
      await client.call(goals.id, 'recordObservation', { goalId, operationId: 'initial', observation: { note: 'working' } });
      if (operation === 'resumeGoal') await client.call(goals.id, 'pauseGoal', { goalId });
      await client.call(goals.id, operation, { goalId, question: 'Which branch?' });
      const expected = operation === 'stopGoal' ? 'failed' : operation === 'resumeGoal' ? 'active' : 'paused';
      const checkpoint = await client.call(storage.id, 'get', { key: `goals:learning:${goalId}` });
      assert.equal(checkpoint.goalState.status, expected);
      assert.equal(typeof checkpoint.goalState.updatedAt, 'number');
      const restarted = await f.add(new GoalManager());
      const restored = await client.call(restarted.id, 'getGoal', { goalId });
      assert.equal(restored.status, expected);
      if (operation === 'stopGoal') assert.equal(restored.error, 'Stopped by user');
    } finally { await f.stop(); }
  });
}

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy' : 'older'} checkpoints cannot override newer shared goal state`, async () => {
    const f = await fixture();
    try {
      const storage = await f.add(new MemoryStore('Storage')), shared = await f.add(new MemoryStore('SharedState'));
      const client = await f.add(new Endpoint('Client'));
      const now = Date.now();
      await client.call(storage.id, 'set', { key: 'goals:index', value: ['goal'] });
      await client.call(storage.id, 'set', { key: 'goals:learning:goal', value: {
        version: 2, goalState: { status: 'active', ...(legacy ? {} : { updatedAt: now - 1000 }) },
        scratchpad: { decision: 'old', evidence: 'preserve me' },
      } });
      await client.call(shared.id, 'set', { name: 'goal-goal', key: 'meta', value: {
        id: 'goal', title: 'Stopped', status: 'failed', error: 'Stopped by user', updatedAt: now,
        scratchpad: { decision: 'new' },
      } });
      const restarted = await f.add(new GoalManager());
      const goal = await client.call(restarted.id, 'getGoal', { goalId: 'goal' });
      assert.equal(goal.status, 'failed');
      assert.equal(goal.error, 'Stopped by user');
      assert.deepEqual(goal.scratchpad, { decision: 'new', evidence: 'preserve me' });
    } finally { await f.stop(); }
  });
}
