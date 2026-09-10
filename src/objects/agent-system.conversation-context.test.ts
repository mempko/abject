import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { captureConversation, identifyMessages } from '../core/conversation-context.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { GoalManager } from './goal-manager.js';
import { Chat } from './chat.js';
import { ChatManager } from './chat-manager.js';
import { AgentAbject } from './agent-abject.js';
import { TupleSpace } from './tuple-space.js';
import { TaskReviewer } from './task-reviewer.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Conversation reference test',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
  }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}
class Store extends Endpoint {
  values = new Map<string, unknown>();
  constructor(name: string) {
    super(name);
    const key = (p: any) => `${p.name ?? ''}:${p.key}`;
    this.on('set', m => { const p = m.payload as any; this.values.set(key(p), structuredClone(p.value)); return true; });
    this.on('get', m => structuredClone(this.values.get(key(m.payload)) ?? null));
    this.on('keys', () => [...this.values.keys()].filter(k => k.startsWith(':')).map(k => k.slice(1)));
    this.on('getAll', m => {
      const prefix = `${(m.payload as any).name}:`;
      return Object.fromEntries([...this.values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), structuredClone(v)]));
    });
    this.on('removeNamespace', m => { const prefix = `${(m.payload as any).name}:`; for (const k of this.values.keys()) if (k.startsWith(prefix)) this.values.delete(k); return true; });
    for (const method of ['create', 'subscribe', 'unsubscribe']) this.on(method, () => true);
  }
}
class Runtime extends AgentAbject { protected override async onInit(): Promise<void> {} }
class Reviewer extends TaskReviewer { protected override async onInit(): Promise<void> {} }
class Chats extends ChatManager { protected override async onInit(): Promise<void> {} }
class HeadlessChat extends Chat {
  constructor() {
    super();
    const self = this as any;
    for (const method of ['enterGoalControls', 'exitGoalControls', 'removeActivityBubble', 'removeWelcomeState', 'appendBubble']) self[method] = async () => {};
    self.scheduleActivityRefresh = () => {};
    self.schedulePersist = () => {};
  }
  protected override async onInit(): Promise<void> {}
}
async function fixture() {
  const registry = new Registry(), bus = new MessageBus(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T) => { o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o; };
  const storage = await add(new Store('Storage'));
  await add(new Store('SharedState'));
  await add(new TupleSpace());
  const client = await add(new Endpoint('Client'));
  let goals = await add(new GoalManager());
  const chat: any = await add(new HeadlessChat());
  Object.assign(chat, { goalManagerId: goals.id, storageId: storage.id, conversationId: 'conversation' });
  const chats: any = await add(new Chats());
  chats.storageId = storage.id;
  chats.conversations.set('conversation', { conversationId: 'conversation' });
  const runtime: any = await add(new Runtime()); runtime.goalManagerId = goals.id;
  return { add, client, storage, chat, chats, runtime, get goals() { return goals; },
    async restartGoals() { await goals.stop(); registry.unregisterObject(goals.id); goals = await add(new GoalManager()); runtime.goalManagerId = goals.id; chat.goalManagerId = goals.id; },
    async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

async function priorResult(f: Awaited<ReturnType<typeof fixture>>, value: unknown, conversationId = 'conversation') {
  const context = captureConversation(conversationId, [{ id: 'question', role: 'user', content: 'Review these items' }]);
  const { goalId } = await f.client.call(f.goals.id, 'createGoal', { title: 'Review', description: 'Choose items', context });
  await f.client.call(f.goals.id, 'writeGoalData', { goalId, key: 'selection', value });
  await f.client.call(f.goals.id, 'completeGoal', { goalId, result: `The complete selection is ${JSON.stringify(value)}` });
  await f.client.call(f.goals.id, 'ackReview', { goalId, report: { status: 'complete' } });
  return goalId;
}

for (const followup of ['use those', 'apply that plan', 'delete the safe ones']) {
  test(`chat follow-up "${followup}" preserves the original selection across chat reload and goal cleanup`, async () => {
    const f = await fixture();
    try {
      const selected = [{ id: 'original-A' }, { id: 'original-B' }];
      const prior = await priorResult(f, selected);
      f.chat.conversationHistory = [{ id: 'question', role: 'user', content: 'Review these items' }];
      await f.chat.deliverLateGoalOutcome({ status: 'completed', result: 'Use original-A and original-B', goalId: prior });
      await f.chat.persistHistory();
      const history = await f.client.call(f.storage.id, 'get', { key: 'chats:history:conversation' });
      const reopened: any = await f.add(new HeadlessChat());
      Object.assign(reopened, { goalManagerId: f.goals.id, conversationId: 'conversation', conversationHistory: history });
      reopened.conversationHistory.push({ id: 'followup', role: 'user', content: followup });
      const result = await f.client.call(reopened.id, 'agentAct', { taskId: 'followup-task', action: { action: 'goal', title: 'Continue', description: 'Act on the earlier selection' } });
      assert.equal(result.success, true);
      const next = reopened._currentGoalId;
      const goal = await f.client.call(f.goals.id, 'getGoal', { goalId: next });
      assert.deepEqual(goal.scratchpad['context/conversation'].sourceGoalIds, [prior]);
      assert.equal(goal.scratchpad['context/conversation'].throughMessageId, 'followup');
      reopened.conversationHistory.push({ id: 'later', role: 'user', content: 'Unrelated later request' });
      await f.client.call(f.goals.id, 'clearCompleted');
      assert.equal((f.goals as any).goals.has(prior), false);
      await f.restartGoals();
      const imported = await f.client.call(f.goals.id, 'readGoalContext', { goalId: next, sourceGoalId: prior, key: 'selection' });
      assert.deepEqual(imported.value, selected);
      assert.equal((f.goals as any).goals.has(prior), false, 'reading retained data does not revive the goal');
      const brief = await f.client.call(f.goals.id, 'getGoalBriefing', { goalId: next, keys: ['unrelated'] });
      assert.match(JSON.stringify(brief.conversationContext), /original-A/);
      assert.doesNotMatch(JSON.stringify(brief.conversationContext), /Unrelated later request/);
      assert.deepEqual((await f.client.call(f.goals.id, 'readGoalData', { goalId: next, key: imported.scratchpadKey })).value, selected);
      // Mutating a returned value cannot change the owner's retained copy.
      imported.value[0].id = 'different';
      await f.restartGoals();
      assert.deepEqual((await f.client.call(f.goals.id, 'readGoalContext', { goalId: next, sourceGoalId: prior, key: 'selection' })).value, selected);
    } finally { await f.stop(); }
  });
}

test('large context values are readable in full and survive payload eviction; task filters and empty task lists retain context', async () => {
  const f = await fixture();
  try {
    const full = 'Original approved list\n' + 'item\n'.repeat(10000) + 'LAST_ITEM';
    const prior = await priorResult(f, full);
    const context = captureConversation('conversation', [
      { id: 'answer', role: 'assistant', content: full, sourceGoalId: prior },
      { id: 'followup', role: 'user', content: 'use those' },
    ]);
    const { goalId } = await f.client.call(f.goals.id, 'createGoal', { title: 'Use list', description: 'Use prior selection', context });
    const brief = await f.client.call(f.goals.id, 'getGoalBriefing', { goalId, keys: ['other'] });
    assert(JSON.stringify(brief.conversationContext).length < 16000);
    assert.equal((await f.client.call(f.goals.id, 'readGoalContext', { goalId, messageId: 'answer' })).content, full);
    assert.match(await f.runtime.buildGoalProgressContext(goalId), /Originating Conversation/);
    const { taskId } = await f.client.call(f.goals.id, 'addTask', { goalId, description: 'Use the approved selection', consumes: ['other'] });
    assert.match(await f.runtime.buildGoalProgressContext(goalId, taskId), /Original approved list/);
    const { goalId: child } = await f.client.call(f.goals.id, 'createGoal', { parentId: goalId, title: 'Delegated work', description: 'Use the same selection' });
    assert.equal((await f.client.call(f.goals.id, 'readGoalContext', { goalId: child, sourceGoalId: prior, key: 'selection' })).value, full);
    const entry = { goalId, state: { action: { action: 'read_context', goalId: 'unrelated', sourceGoalId: prior, key: 'selection' } } };
    const response = await f.runtime.performRuntimeAction(entry);
    assert.match(response.message, /continue with read_chunk/);
    const raw = f.runtime.readChunk(entry, { id: response.result.data.payloadId, grep: 'LAST_ITEM' });
    assert.match(raw, /LAST_ITEM/);
    for (let i = 0; i < 6; i++) f.runtime.storePayload(entry, 'unrelated', 'result');
    const retry = await f.runtime.performRuntimeAction(entry);
    assert.equal(retry.result.success, true);
    const imported = await f.client.call(f.goals.id, 'readGoalContext', { goalId, sourceGoalId: prior, key: 'selection' });
    assert.equal(imported.value, full);
    await assert.rejects(f.client.call(f.goals.id, 'writeGoalData', { goalId, key: imported.scratchpadKey, value: 'replacement' }), /managed by GoalManager/);
  } finally { await f.stop(); }
});

test('context refuses unrelated or missing references and ChatManager honors stable history boundaries', async () => {
  const f = await fixture();
  try {
    const other = await priorResult(f, ['secret'], 'other-conversation');
    const entries = identifyMessages('conversation', [{ role: 'user' as const, content: 'legacy question' }]);
    const context = captureConversation('conversation', entries);
    // Even a supplied reference cannot cross into a different conversation.
    context.sourceGoalIds = [other, 'missing'];
    const { goalId } = await f.client.call(f.goals.id, 'createGoal', { title: 'Follow-up', description: 'Use previous result', context });
    await assert.rejects(f.client.call(f.goals.id, 'readGoalContext', { goalId, sourceGoalId: other }), /another conversation/);
    const brief = await f.client.call(f.goals.id, 'getGoalBriefing', { goalId });
    assert.equal(brief.conversationContext.sources[0].available, false);
    assert.equal(brief.conversationContext.sources[0].title, undefined);
    await assert.rejects(f.client.call(f.goals.id, 'readGoalContext', { goalId, sourceGoalId: 'missing' }), /unavailable/);
    await assert.rejects(f.client.call(f.goals.id, 'readGoalContext', { goalId, sourceGoalId: 'unlinked' }), /not linked/);
    await assert.rejects(f.client.call(f.goals.id, 'readGoalContext', { goalId, messageId: 'missing' }), /not available/);
    await f.client.call(f.storage.id, 'set', { key: 'chats:history:conversation', value: [...entries, { id: 'later', role: 'user', content: 'later request' }] });
    const saved = await f.client.call(f.chats.id, 'getConversationContext', { conversationId: 'conversation', throughMessageId: entries[0].id });
    assert.deepEqual(saved.messages, entries);
    await assert.rejects(f.client.call(f.chats.id, 'getConversationContext', { conversationId: 'conversation', throughMessageId: 'missing' }), /unavailable/);
    await assert.rejects(f.client.call(f.chats.id, 'getConversationContext', { conversationId: 'other', throughMessageId: entries[0].id }), /unavailable/);
  } finally { await f.stop(); }
});

test('a pending chat turn freezes its handoff before later notifications and retains attachment paths without image bytes', async () => {
  const f = await fixture();
  try {
    f.chat.conversationHistory = [{ id: 'trigger', role: 'user', content: 'use those' }];
    f.chat.turnContext = f.chat.captureGoalContext();
    f.chat.conversationHistory.push({ id: 'late', role: 'assistant', content: 'Unrelated notification' });
    const result = await f.client.call(f.chat.id, 'agentAct', { taskId: 'frozen-turn', action: { action: 'goal', title: 'Continue', description: 'Use previous data' } });
    assert.equal(result.success, true);
    const goal = await f.client.call(f.goals.id, 'getGoal', { goalId: f.chat._currentGoalId });
    assert.equal(goal.scratchpad['context/conversation'].throughMessageId, 'trigger');
    assert.equal(goal.scratchpad['context/conversation'].messages.length, 1);
    const context = captureConversation('conversation', [{ id: 'image', role: 'user', content: '![image](data:image/png;base64,AAA)',
      attachment: { path: '/attachments/image.png', name: 'image.png', mimeType: 'image/png', kind: 'image' } }]);
    assert.doesNotMatch(JSON.stringify(context), /base64/);
    assert.equal(context.messages[0].attachment?.path, '/attachments/image.png');
  } finally { await f.stop(); }
});

test('reviewer retrieves the accepted proposal after source cleanup, with paging and reference isolation', async () => {
  const f = await fixture();
  try {
    const proposal = { subject: 'Add conversation references', patch: 'exact patch\n'.repeat(4000) + 'FINAL_HUNK' };
    const prior = await priorResult(f, proposal);
    const other = await priorResult(f, { private: true }, 'other-conversation');
    const context = captureConversation('conversation', [
      { id: 'proposal', role: 'assistant', content: 'Proposed commits', sourceGoalId: prior },
      { id: 'approval', role: 'user', content: 'make these commits' },
    ]);
    // Even a linked id cannot cross conversations.
    context.sourceGoalIds.push(other);
    const { goalId } = await f.client.call(f.goals.id, 'createGoal', { title: 'Execute', description: 'Make approved commits', context });
    await f.client.call(f.goals.id, 'completeGoal', { goalId, result: 'Executed' });
    // Keep this goal's review pending; completed source goals can be removed.
    await f.client.call(f.goals.id, 'clearCompleted');
    await f.restartGoals();
    const reviewer: any = await f.add(new Reviewer());
    reviewer.agentAbjectId = f.client.id;
    reviewer.goalManagerId = f.goals.id;
    reviewer.taskExtras.set('review', { kind: 'review', goalId, records: [] });
    const act = (fields: Record<string, unknown>, taskId = 'review') => f.client.call(reviewer.id, 'agentAct', {
      taskId, action: { action: 'read_evidence', context: true, ...fields },
    });
    assert.match((await act({})).data, /approval/);
    assert.match((await act({ messageId: 'approval' })).data, /make these commits/);
    // A supplied goalId must not override the review's owner-bound context.
    assert.match((await act({ goalId: other, sourceGoalId: prior })).data, /selection/);
    const page = await act({ sourceGoalId: prior, key: 'selection', length: 30000 });
    assert.equal(page.success, true);
    assert.doesNotMatch(page.data, /FINAL_HUNK/);
    assert.match((await act({ sourceGoalId: prior, key: 'selection', offset: 30000, length: 30000 })).data, /FINAL_HUNK/);
    const imported = await f.client.call(f.goals.id, 'readGoalContext', { goalId, sourceGoalId: prior, key: 'selection' });
    assert.deepEqual(imported.value, proposal);
    assert.equal((f.goals as any).goals.has(prior), false, 'review reads do not revive the source goal');
    for (const fields of [{ sourceGoalId: other }, { sourceGoalId: 'unlinked' }, { sourceGoalId: prior, key: 'missing' }, { messageId: 'missing' }, { taskId: 'unrelated' }]) {
      assert.equal((await act(fields)).success, false);
    }
    reviewer.taskExtras.set('standalone', { kind: 'review', records: [] });
    assert.equal((await act({}, 'standalone')).success, false);
  } finally { await f.stop(); }
});
