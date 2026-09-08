import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Abject } from '../core/abject.js';
import { event, request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Chat } from './chat.js';
import { JobManager } from './job-manager.js';

class Endpoint extends Abject {
  progress: Array<{ taskId: string; goalId: string }> = [];
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Chat progress fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] },
      requiredCapabilities: [], providedCapabilities: [] } });
    this.on('progress', msg => { this.progress.push(msg.payload as any); });
  }
  call(to: AbjectId, method: string, payload: unknown, timeout = 250): Promise<any> {
    return this.request(request(this.id, to, method, payload), timeout);
  }
  update(to: AbjectId, aspect: string, value: unknown): void {
    this.send(event(this.id, to, 'changed', { aspect, value }));
  }
}

class Goals extends Endpoint {
  constructor() {
    super('GoalManager');
    this.on('createGoal', () => ({ goalId: 'goal-root' }));
    this.on('getGoal', () => ({ title: 'Pong background', scratchpad: { verified: true } }));
    this.on('getTasksForGoal', () => []);
  }
}

// Exercise the real Chat handlers, goal wait, deferred replies and message bus.
// Only UI/dependency startup is omitted; no window or LLM is needed.
class HeadlessChat extends Chat {
  constructor(goals: AbjectId) {
    super();
    const chat = this as any;
    chat.goalManagerId = goals;
    chat.enterGoalControls = async () => {};
    chat.scheduleActivityRefresh = () => {};
  }
  protected override async onInit(): Promise<void> {}
}

async function fixture() {
  const bus = new MessageBus(), runtime = new Endpoint('Runtime'), goals = new Goals();
  const stranger = new Endpoint('Unrelated'), jobs = new JobManager(), chat = new HeadlessChat(goals.id);
  (jobs as any).discoverDep = async () => null;
  const objects = [runtime, goals, stranger, jobs, chat];
  for (const object of objects) await object.init(bus);
  const payload = {
    taskId: 'chat-task', context: { taskId: 'chat-task' }, queue: 'chat-task', description: 'Pong goal',
    code: `return await call(${JSON.stringify(chat.id)}, 'agentAct', {
      taskId: 'chat-task', step: 0,
      action: { action: 'goal', title: 'Pong background', description: 'Change the Pong background' }
    });`,
  };
  // Capture rejection immediately; negative tests deliberately let the outer
  // request expire while the goal continues, just as in the reported failure.
  const outcome = runtime.call(jobs.id, 'submitJob', payload).then(
    value => ({ value, error: undefined }), error => ({ value: undefined, error }),
  );
  const deadline = Date.now() + 2000;
  while (!(chat as any).pendingGoalCompletions.has('goal-root')) {
    assert.ok(Date.now() < deadline, 'Chat must start its real goal wait');
    await delay(5);
  }
  return { runtime, goals, stranger, jobs, chat, outcome,
    async stop() {
      goals.update(chat.id, 'goalFailed', { goalId: 'goal-root', error: 'fixture cleanup' });
      await delay(20);
      for (const object of objects.reverse()) await object.stop();
    },
  };
}

for (const descendant of [false, true]) {
  test(`Chat keeps the submitJob request alive through ${descendant ? 'descendant' : 'root'} goal progress`, async () => {
    const f = await fixture();
    const goalId = descendant ? 'goal-child' : 'goal-root';
    if (descendant) {
      f.goals.update(f.chat.id, 'goalCreated', { goalId: 'goal-root', title: 'Pong background' });
      f.goals.update(f.chat.id, 'goalCreated', { goalId, parentId: 'goal-root', title: 'Render background' });
    }
    const timer = setInterval(() => f.goals.update(f.chat.id, 'goalUpdated', {
      goalId, parentId: descendant ? 'goal-root' : undefined, message: 'Testing rendering',
    }), 30);
    try {
      // Another task shares both Runtime and JobManager. Chat's heartbeat
      // must not refresh that task's independent submitJob request.
      const unrelated = assert.rejects(f.runtime.call(f.jobs.id, 'submitJob', {
        taskId: 'idle-task', context: { taskId: 'idle-task' }, queue: 'idle-task', description: 'Idle job',
        code: 'await new Promise(resolve => setTimeout(resolve, 600)); return true;',
      }, 150), /Request timeout.*submitJob/);
      // Several outer request budgets elapse; only real progress may extend it.
      await Promise.all([unrelated, delay(800)]);
      f.goals.update(f.chat.id, descendant ? 'goalFailed' : 'goalCompleted', {
        goalId: 'goal-root', result: 'Background updated', error: 'Verification failed',
      });
      const { value, error } = await f.outcome;
      assert.equal(error, undefined);
      assert.equal(value.status, 'completed');
      assert.equal(value.result.success, !descendant);
      if (descendant) assert.equal(value.result.error, 'Verification failed');
      else assert.equal(value.result.data.result, 'Background updated');
      assert.ok(f.runtime.progress.length > 5);
      assert.ok(f.runtime.progress.every(p => p.taskId === 'chat-task' && p.goalId === goalId));
      assert.equal((f.chat as any).pendingGoalCompletions.size, 0);
      const count = f.runtime.progress.length;
      await delay(80);
      assert.equal(f.runtime.progress.length, count, 'terminal goals stop forwarding');
    } finally {
      clearInterval(timer);
      await f.stop();
    }
  });
}

test('unrelated goals and forged goal updates do not extend the waiting Chat request', async () => {
  const f = await fixture();
  const timer = setInterval(() => {
    f.goals.update(f.chat.id, 'goalUpdated', { goalId: 'another-goal', message: 'Busy elsewhere' });
    f.stranger.update(f.chat.id, 'goalUpdated', { goalId: 'goal-root', message: 'Forged progress' });
  }, 30);
  try {
    const { error } = await f.outcome;
    assert.match(error?.message ?? '', /Request timeout.*submitJob/);
    assert.equal(f.runtime.progress.length, 0);
  } finally {
    clearInterval(timer);
    await f.stop();
  }
});

test('a goal that stops progressing still times out after prior valid progress', async () => {
  const f = await fixture();
  try {
    f.goals.update(f.chat.id, 'goalUpdated', { goalId: 'goal-root', message: 'Started rendering' });
    const { error } = await f.outcome;
    assert.match(error?.message ?? '', /Request timeout.*submitJob/);
    assert.equal(f.runtime.progress.length, 1);
  } finally { await f.stop(); }
});
