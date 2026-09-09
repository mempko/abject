import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { event, request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Chat } from './chat.js';
import { JobManager } from './job-manager.js';
import { AgentAbject } from './agent-abject.js';
import { Registry } from './registry.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Chat event fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] },
      requiredCapabilities: [], providedCapabilities: [] } });
  }
  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown, timeout = 1000): Promise<any> {
    return this.request(request(this.id, to, method, payload), timeout);
  }
  update(to: AbjectId, aspect: string, value: unknown): void {
    this.send(event(this.id, to, 'changed', { aspect, value }));
  }
}
class Goals extends Endpoint {
  creates = 0;
  goalStatus = 'active';
  constructor() {
    super('GoalManager');
    this.on('createGoal', () => { this.creates++; return { goalId: 'goal-root' }; });
    this.on('getGoal', () => ({ title: 'Commit changes', status: this.goalStatus, result: 'Created verified commits', scratchpad: {} }));
    this.on('getTasksForGoal', () => []);
  }
}
class Runtime extends AgentAbject { protected override async onInit(): Promise<void> {} }
class HeadlessChat extends Chat {
  bubbles: string[] = [];
  constructor(goals: AbjectId) {
    super();
    const chat = this as any;
    chat.goalManagerId = goals;
    chat.enterGoalControls = async () => { chat.goalControlsActive = true; };
    chat.exitGoalControls = async () => { chat.goalControlsActive = false; };
    chat.scheduleActivityRefresh = () => {};
    chat.removeWelcomeState = async () => {};
    chat.removeActivityBubble = async () => {};
    chat.appendBubble = async (_role: string, _sender: string, text: string) => { this.bubbles.push(text); };
    chat.schedulePersist = () => {};
  }
  protected override async onInit(): Promise<void> {}
}
async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), client = new Endpoint('Client'), goals = new Goals();
  const stranger = new Endpoint('Unrelated'), jobs = new JobManager(), chat = new HeadlessChat(goals.id), runtime = new Runtime();
  const objects = [registry, client, goals, stranger, jobs, chat, runtime];
  for (const object of objects) {
    object.setRegistryHint(registry.id);
    await object.init(bus);
    if (object !== registry) registry.registerObject(object.id, object.manifest);
  }
  (chat as any).agentAbjectId = runtime.id;
  const handoff = () => client.call(jobs.id, 'submitJob', {
    taskId: 'chat-task', context: { taskId: 'chat-task' }, queue: 'chat-task', description: 'Commit goal',
    code: `return await call(${JSON.stringify(chat.id)}, 'agentAct', {
      taskId: 'chat-task', step: 0, action: { action: 'goal', title: 'Commit changes', description: 'Review and commit changes' }
    });`,
  });
  return { client, goals, stranger, jobs, chat, runtime, handoff,
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}

for (const status of ['completed', 'failed'] as const) {
  test(`Chat releases its job queue and receives a later ${status} goal through the bus`, async () => {
    const f = await fixture();
    try {
      const reply = await f.handoff();
      assert.equal(reply.status, 'completed');
      assert.equal(reply.result.success, true);
      assert.equal((f.chat as any)._currentGoalId, 'goal-root');
      assert.equal((f.chat as any).goalControlsActive, true);
      const next = await f.client.call(f.jobs.id, 'submitJob', { queue: 'chat-task', description: 'next job', code: 'return 42;' });
      assert.equal(next.result, 42, 'the goal must not hold the queue while agents work');
      f.goals.update(f.chat.id, 'goalCreated', { goalId: 'child', parentId: 'goal-root', title: 'Inspect changes' });
      f.goals.update(f.chat.id, 'goalCompleted', { goalId: 'child', result: 'Inspection done' });
      f.stranger.update(f.chat.id, 'goalCompleted', { goalId: 'goal-root', result: 'Forged success' });
      await delay(20);
      assert.equal(f.chat.bubbles.length, 0, 'child results and forged outcomes cannot finish the root goal');
      assert.equal((f.chat as any).goalControlsActive, true);
      f.goals.update(f.chat.id, status === 'completed' ? 'goalCompleted' : 'goalFailed', {
        goalId: 'goal-root', result: 'Created verified commits', error: 'Dispatch failed',
      });
      await delay(20);
      assert.equal(f.chat.bubbles.length, 1);
      assert.match(f.chat.bubbles[0], status === 'completed' ? /Created verified commits/ : /Dispatch failed/);
      assert.equal((f.chat as any)._currentGoalId, undefined);
      assert.equal((f.chat as any).goalControlsActive, false);
      f.goals.update(f.chat.id, 'goalCompleted', { goalId: 'goal-root', result: 'duplicate' });
      await delay(20);
      assert.equal(f.chat.bubbles.length, 1);
    } finally { await f.stop(); }
  });
}

test('Chat reconciles completion that beats the goal creation reply and reuses an active handoff', async () => {
  const f = await fixture();
  try {
    await f.handoff(); await f.handoff();
    assert.equal(f.goals.creates, 1);
    f.goals.goalStatus = 'completed';
    await f.handoff();
    assert.equal(f.goals.creates, 1);
    assert.deepEqual(f.chat.bubbles, ['Created verified commits']);
    assert.equal((f.chat as any).goalControlsActive, false);
  } finally { await f.stop(); }
});

test('the Chat runtime stops after the goal handoff without making status-polling model calls', async () => {
  const f = await fixture();
  try {
    let thinks = 0;
    (f.runtime as any).think = async () => {
      assert.equal(++thinks, 1, 'goal handoff must end this routing turn');
      return { action: 'goal', title: 'Commit changes', description: 'Review and commit changes' };
    };
    await (f.chat as any).request(request(f.chat.id, f.runtime.id, 'registerAgent', {
      name: 'Chat', config: { skipFirstObservation: true, terminalActions: { goal: { type: 'success', execute: true } } },
    }));
    const result = await (f.chat as any).runTaskTurn('Review and commit changes', []);
    assert.equal(result.success, true);
    assert.equal(result.goalCreated, true);
    assert.equal(thinks, 1);
    assert.equal((f.chat as any)._currentGoalId, 'goal-root', 'turn completion must preserve the event subscription and controls');
    await delay(50);
    assert.equal(thinks, 1);
    f.goals.update(f.chat.id, 'goalCompleted', { goalId: 'goal-root', result: 'Created verified commits' });
    await delay(20);
    assert.equal(thinks, 1);
    assert.deepEqual(f.chat.bubbles, ['Created verified commits']);
  } finally { await f.stop(); }
});

test('Chat retains a fast routing result that arrives before its waiter', async () => {
  const f = await fixture();
  try {
    await (f.runtime as any).request(request(f.runtime.id, f.chat.id, 'taskResult', { ticketId: 'early', success: true, result: '' }));
    const result = await (f.chat as any).waitForTaskResult('early', 20);
    assert.equal(result.success, true);
  } finally { await f.stop(); }
});

test('Chat reconnect delivers a goal outcome that arrived while the chat was offline', async () => {
  const f = await fixture();
  try {
    (f.chat as any).conversationId = 'restored-chat';
    (f.chat as any).storageId = f.client.id;
    const writes: any[] = [];
    f.client.on('get', () => 'goal-root');
    f.client.on('delete', msg => { writes.push(msg.payload); return true; });
    f.goals.goalStatus = 'completed';
    await (f.chat as any).reconnectActiveGoal();
    assert.deepEqual(f.chat.bubbles, ['Created verified commits']);
    assert.equal((f.chat as any)._currentGoalId, undefined);
    assert.equal(writes.at(-1).key, 'chats:activegoal:restored-chat');
  } finally { await f.stop(); }
});

test('closing the chat window preserves the tracked goal and its later result', async () => {
  const f = await fixture();
  try {
    await f.handoff();
    (f.chat as any).windowId = 'fixture-window';
    (f.chat as any).widgetManagerId = f.client.id;
    f.client.on('destroyWindowAbject', () => true);
    await f.chat.hide();
    assert.equal((f.chat as any)._currentGoalId, 'goal-root');
    f.goals.update(f.chat.id, 'goalCompleted', { goalId: 'goal-root', result: 'Created verified commits' });
    await delay(20);
    assert.deepEqual(f.chat.bubbles, ['Created verified commits']);
    assert.equal((f.chat as any)._currentGoalId, undefined);
  } finally { await f.stop(); }
});
