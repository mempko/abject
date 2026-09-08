import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { AgentAbject } from './agent-abject.js';
import { GoalManager } from './goal-manager.js';
import { JobManager } from './job-manager.js';
import { ScrumMaster } from './scrum-master.js';
import { TaskSession } from './task-session.js';
import { TupleSpace } from './tuple-space.js';
import { LLMObject } from './llm-object.js';
import { Registry } from './registry.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import type { LLMProvider, LLMMessage, LLMProviderDescription } from '../llm/provider.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Goal startup test fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] },
      requiredCapabilities: [], providedCapabilities: [] } });
  }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> {
    return this.request(request(this.id, to, method, payload), 10000);
  }
}

class MemoryStore extends Endpoint {
  constructor(name: string) {
    super(name);
    const namespaces = new Map<string, Map<string, unknown>>();
    const values = (name = '') => {
      if (!namespaces.has(name)) namespaces.set(name, new Map());
      return namespaces.get(name)!;
    };
    this.on('set', msg => { const p = msg.payload as any; values(p.name).set(p.key, structuredClone(p.value)); return true; });
    this.on('get', msg => { const p = msg.payload as any; return structuredClone(values(p.name).get(p.key) ?? null); });
    this.on('getAll', msg => structuredClone(Object.fromEntries(values((msg.payload as any).name))));
    this.on('delete', msg => { const p = msg.payload as any; return values(p.name).delete(p.key); });
    this.on('removeNamespace', msg => namespaces.delete((msg.payload as any).name));
    for (const method of ['create', 'subscribe', 'unsubscribe']) this.on(method, () => true);
  }
}

class WorkspaceDirectory extends Endpoint {
  workspaces: Array<{ registryId: AbjectId; childIds: AbjectId[] }> = [];
  constructor() {
    super('WorkspaceManager');
    this.on('listWorkspacesDetailed', () => this.workspaces);
  }
}

class ScriptedProvider implements LLMProvider {
  name = 'fixture';
  calls = 0;
  streams: LLMMessage[][] = [];
  async isAvailable() { return true; }
  resolveModel() { return 'fixture-model'; }
  async listModels() { return []; }
  describe(): LLMProviderDescription {
    return { id: this.name, label: 'Scripted fixture', storageSuffix: 'fixture', credentialMode: 'apiKey', models: [],
      defaultTierModels: { fast: 'fixture-model', balanced: 'fixture-model', smart: 'fixture-model', code: 'fixture-model' } };
  }
  async complete() {
    this.calls++;
    return { content: JSON.stringify({ action: 'complete_goal', synthesis: 'The supplied observation is 12 C and sunny.' }),
      finishReason: 'stop' as const, usage: { inputTokens: 7, outputTokens: 3, costUsd: 0 } };
  }
  async *stream(messages: LLMMessage[]) {
    this.streams.push(messages);
    const result = await this.complete();
    yield { content: result.content, done: true, stopReason: 'stop', usage: result.usage };
  }
}

async function until(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${description}`);
}

test('a workspace goal runs Scrum through the global LLM, accounts usage and delivers its result', async () => {
  const bus = new MessageBus();
  const globalRegistry = new Registry(), workspaceRegistry = new WorkspaceRegistry(), directory = new WorkspaceDirectory();
  const provider = new ScriptedProvider(), llm = new LLMObject();
  llm.registerProvider(provider);
  const storage = new MemoryStore('Storage'), shared = new MemoryStore('SharedState');
  const tuples = new TupleSpace(), goals = new GoalManager(), sessions = new TaskSession();
  const jobs = new JobManager(), runtime = new AgentAbject(), scrum = new ScrumMaster(), client = new Endpoint('Client');
  const local = [storage, shared, tuples, goals, sessions, jobs, runtime, scrum, client];
  const objects = [globalRegistry, workspaceRegistry, directory, llm, ...local];
  directory.workspaces = [{ registryId: workspaceRegistry.id, childIds: local.map(object => object.id) }];
  workspaceRegistry.setFallback(globalRegistry.id);
  await globalRegistry.init(bus);
  for (const object of [directory, llm]) {
    object.setRegistryHint(globalRegistry.id);
    await object.init(bus);
    globalRegistry.registerObject(object.id, object.manifest);
  }
  await workspaceRegistry.init(bus);
  for (const object of local) {
    object.setRegistryHint(workspaceRegistry.id);
    await object.init(bus);
    workspaceRegistry.registerObject(object.id, object.manifest);
  }
  try {
    const { goalId } = await client.call(goals.id, 'createGoal', {
      title: 'Summarize supplied weather', description: 'Report the supplied observation: 12 C and sunny.',
    });
    await until(async () => (await client.call(goals.id, 'getGoal', { goalId })).status === 'completed', 'goal completed through Scrum');
    assert.equal((await client.call(goals.id, 'getGoal', { goalId })).result, 'The supplied observation is 12 C and sunny.');
    assert.equal(provider.streams.length, 1, 'the planning task reaches the model');
    const budget = await client.call(goals.id, 'getBudget', { goalId });
    assert.equal(budget.usedTokens, 10, 'global LLM settles usage in the workspace GoalManager');
    assert.equal(Object.keys(budget.reservations).length, 0);
    assert.equal(Object.keys(budget.receipts).length, 1);
    await until(async () => {
      const records = await client.call(sessions.id, 'list');
      return records.length === 1 && records[0].outbox.length > 0 && records[0].outbox.every((item: any) => item.delivered);
    }, 'durable Scrum result acknowledged');
    const [record] = await client.call(sessions.id, 'list');
    assert.equal(record.goalId, goalId);
    assert.equal(record.agentName, 'ScrumMaster');
    assert.equal(record.status, 'accepted');
    assert.equal(record.outbox[0].payload.success, true);
    assert.deepEqual(await client.call(goals.id, 'getTasksForGoal', { goalId }), [], 'internal planning creates no fake work tuple');
  } finally {
    for (const object of [...objects].reverse()) await object.stop();
  }
});

test('global model calls keep concurrent workspace budgets separate and enforce the owning budget', async () => {
  const bus = new MessageBus(), globalRegistry = new Registry(), directory = new WorkspaceDirectory();
  const provider = new ScriptedProvider(), llm = new LLMObject();
  llm.registerProvider(provider);
  const objects: Abject[] = [globalRegistry];
  await globalRegistry.init(bus);
  for (const object of [directory, llm]) {
    object.setRegistryHint(globalRegistry.id);
    await object.init(bus); objects.push(object);
    globalRegistry.registerObject(object.id, object.manifest);
  }
  try {
    const workspaces = [];
    for (const name of ['A', 'B']) {
      const registry = new WorkspaceRegistry(), storage = new MemoryStore('Storage');
      const goals = new GoalManager(), client = new Endpoint(`Client${name}`);
      registry.setFallback(globalRegistry.id);
      await registry.init(bus); objects.push(registry);
      for (const object of [storage, goals, client]) {
        object.setRegistryHint(registry.id);
        await object.init(bus); objects.push(object);
        registry.registerObject(object.id, object.manifest);
      }
      directory.workspaces.push({ registryId: registry.id, childIds: [storage.id, goals.id, client.id] });
      const { goalId } = await client.call(goals.id, 'createGoal', { title: name, description: `Goal in workspace ${name}` });
      workspaces.push({ registry, goals, client, goalId });
    }
    const [a, b] = workspaces;
    const messages = [{ role: 'user', content: 'Use the supplied observation' }];
    await Promise.all([
      a.client.call(llm.id, 'stream', { messages, goalId: a.goalId, taskId: 'A-task', onBehalfOf: b.client.id }),
      b.client.call(llm.id, 'complete', { messages, goalId: b.goalId, taskId: 'B-task' }),
    ]);
    for (const [index, workspace] of workspaces.entries()) {
      const budget = await workspace.client.call(workspace.goals.id, 'getBudget', { goalId: workspace.goalId });
      assert.equal(budget.usedTokens, 10);
      assert.deepEqual(budget.reservations, {});
      const receipts = Object.values(budget.receipts) as any[];
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].taskId, index === 0 ? 'A-task' : 'B-task');
    }
    await a.client.call(a.goals.id, 'configureBudget', { goalId: a.goalId, maxTokens: 10 });
    await assert.rejects(a.client.call(llm.id, 'stream', { messages, goalId: a.goalId }), /Goal token budget exhausted/);
    await assert.rejects(a.client.call(llm.id, 'complete', { messages, goalId: b.goalId }), /[Gg]oal.*not found|Unknown goal/);
    a.registry.unregisterObject(a.goals.id);
    await assert.rejects(a.client.call(llm.id, 'stream', { messages, goalId: a.goalId }), /GoalManager unavailable in the requesting workspace/);
    assert.equal(provider.calls, 2, 'rejected reservations never call the model');
    assert.equal((await b.client.call(b.goals.id, 'getBudget', { goalId: b.goalId })).usedTokens, 10);
  } finally {
    for (const object of [...objects].reverse()) await object.stop();
  }
});

class AdmissionRuntime extends AgentAbject {
  protected override async onInit(): Promise<void> {}
}

class RejectingRuntime extends AgentAbject {
  constructor() {
    super();
    this.on('startTask', () => { throw new Error('Fixture admission service unavailable'); });
  }
}

test('Scrum receives a durable startup failure and schedules replanning instead of silently stalling', async () => {
  const bus = new MessageBus();
  const storage = new MemoryStore('Storage'), goals = new GoalManager(), sessions = new TaskSession();
  const runtime = new RejectingRuntime(), scrum = new ScrumMaster(), client = new Endpoint('Client');
  const objects = [storage, goals, sessions, runtime, scrum, client];
  const deps = new Map(objects.map(object => [object.manifest.name, object.id]));
  for (const object of objects) (object as any).discoverDep = async (name: string) => deps.get(name) ?? null;
  for (const object of objects) await object.init(bus);
  try {
    const { goalId } = await client.call(goals.id, 'createGoal', { title: 'Retry planning', description: 'Plan when the runtime recovers' });
    await until(async () => (scrum as any).scrumRetryTimers.size === 1, 'Scrum schedules its bounded retry');
    await until(async () => {
      const records = await client.call(sessions.id, 'list');
      return records.length === 1 && records[0].outbox.length > 0 && records[0].outbox.every((item: any) => item.delivered);
    }, 'failed startup durably recorded and acknowledged');
    const [record] = await client.call(sessions.id, 'list');
    assert.equal(record.goalId, goalId);
    assert.equal(record.status, 'partial');
    assert.match(record.outcome.error, /Fixture admission service unavailable/);
    assert.equal(record.outbox[0].payload.success, false);
    assert.equal((scrum as any).scrumAttempts.size, 0, 'early result consumes the registered attempt');
    assert.equal((await client.call(goals.id, 'getGoal', { goalId })).status, 'active');
    await until(async () => (await client.call(runtime.id, 'listAgentQueue', { agentId: scrum.id })).inFlight.length === 0, 'failed queue slot released');
  } finally {
    for (const object of [...objects].reverse()) await object.stop();
  }
});

class LegacyAgent extends Endpoint {
  results: any[] = [];
  executions: string[] = [];
  constructor(runtime: AbjectId) {
    super('LegacyAgent');
    this.on('taskResult', msg => { this.results.push(msg.payload); return true; });
    this.on('executeTask', async msg => {
      const p = msg.payload as any;
      this.executions.push(p.taskId);
      if (p.description === 'throw before start') throw new Error('Fixture setup exception');
      if (p.description === 'return before start') return { success: false, error: 'Fixture setup refusal' };
      // Existing specialist handlers use the transport's tupleId alias here.
      return this.call(runtime, 'startTask', {
        taskId: p.taskId, task: p.description, goalId: p.goalId, dispatchTupleId: p.tupleId,
      });
    });
  }
}

class AdmissionGoals extends Endpoint {
  admissions: string[] = [];
  constructor() {
    super('GoalManager');
    this.on('admitTask', msg => {
      this.admissions.push((msg.payload as any).taskId);
      return { accepted: false, reason: 'Task was removed, settled or superseded' };
    });
    this.on('recordTaskEvidence', () => true);
    this.on('failTask', () => false);
  }
}

test('queue admission distinguishes internal tickets from real work even for legacy executeTask handlers', async () => {
  const bus = new MessageBus(), runtime = new AdmissionRuntime(), agent = new LegacyAgent(runtime.id);
  const goals = new AdmissionGoals();
  const runs: string[] = [];
  (runtime as any).goalManagerId = goals.id;
  (runtime as any).runStateMachine = async (entry: any) => {
    runs.push(entry.state.id); entry.state.phase = 'done'; entry.state.result = 'Internal planning finished';
  };
  for (const object of [runtime, agent, goals]) await object.init(bus);
  try {
    await agent.call(runtime.id, 'registerAgent', { name: 'LegacyAgent', config: { maxConcurrentTasks: 1 } });
    await agent.call(runtime.id, 'enqueueTask', { agentId: agent.id, taskId: 'planning-ticket', task: 'plan', goalId: 'goal' });
    await agent.call(runtime.id, 'enqueueTask', { agentId: agent.id, taskId: 'work-ticket', task: 'execute', goalId: 'goal', dispatchTupleId: 'real-work-tuple' });
    await until(async () => agent.results.length === 2, 'both queue outcomes delivered');
    assert.deepEqual(goals.admissions, ['real-work-tuple'], 'queue record owns the tuple association');
    assert.deepEqual(runs, ['planning-ticket'], 'rejected real work never starts');
    assert.equal(agent.results[0].success, true);
    assert.equal(agent.results[1].success, false);
    assert.match(agent.results[1].error, /removed, settled or superseded/);
    await until(async () => (await agent.call(runtime.id, 'listAgentQueue', { agentId: agent.id })).inFlight.length === 0, 'queue released');
  } finally {
    for (const object of [agent, runtime, goals]) await object.stop();
  }
});

test('thrown and returned setup failures notify callers and unblock the next queued task immediately', async () => {
  const bus = new MessageBus(), runtime = new AdmissionRuntime(), agent = new LegacyAgent(runtime.id);
  (runtime as any).runStateMachine = async (entry: any) => {
    entry.state.phase = 'done'; entry.state.result = 'Recovered';
  };
  await runtime.init(bus); await agent.init(bus);
  try {
    await agent.call(runtime.id, 'registerAgent', { name: 'LegacyAgent', config: { maxConcurrentTasks: 1 } });
    for (const [taskId, task] of [['throws', 'throw before start'], ['refuses', 'return before start'], ['next', 'normal task']]) {
      await agent.call(runtime.id, 'enqueueTask', { agentId: agent.id, taskId, task });
    }
    await until(async () => agent.results.length === 3, 'setup failures and subsequent result delivered without a sweeper');
    assert.deepEqual(agent.executions, ['throws', 'refuses', 'next']);
    assert.match(agent.results[0].error, /Task setup failed:.*Fixture setup exception/);
    assert.match(agent.results[1].error, /Task setup failed:.*Fixture setup refusal/);
    assert.equal(agent.results[2].success, true);
    assert.equal(agent.results[2].result, 'Recovered');
    assert.equal((await agent.call(runtime.id, 'listTasks')).length, 3, 'each attempt is recorded once');
  } finally { await agent.stop(); await runtime.stop(); }
});
