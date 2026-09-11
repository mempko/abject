import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { TaskReviewer } from './task-reviewer.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Fidelity fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
  }
  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 2000); }
}
class Reviewer extends TaskReviewer { protected override async onInit(): Promise<void> {} }

test('the reviewer records its verdict on the user-facing summary with the goal', async () => {
  const bus = new MessageBus(), registry = new Registry(); await registry.init(bus);
  const objects: Abject[] = [registry];
  const add = async <T extends Abject>(o: T): Promise<T> => { o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o; };
  try {
    const goals = await add(new Endpoint('GoalManager'));
    const writes: any[] = [];
    goals.on('writeGoalData', msg => { writes.push(msg.payload); return { success: true }; });
    const reviewer: any = await add(new Reviewer()); reviewer.goalManagerId = goals.id;
    reviewer.taskExtras.set('review-1', { kind: 'review', goalId: 'goal-1', completionIssues: [] });
    const done = await reviewer.completeReview('review-1', {
      summaryFidelity: { verdict: 'misreported', explanation: 'The summary says 285/285; the newest recorded run counted 290.' },
    });
    assert.equal(done.accepted, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].goalId, 'goal-1');
    assert.equal(writes[0].key, 'learning/summary-fidelity');
    assert.equal(writes[0].value.verdict, 'misreported');
    assert.match(writes[0].value.explanation, /285/);

    reviewer.taskExtras.set('review-2', { kind: 'review', goalId: 'goal-1', completionIssues: [] });
    await reviewer.completeReview('review-2', { summaryFidelity: { verdict: 'somewhat' } });
    assert.equal(writes.length, 1, 'an unknown verdict is refused, not stored');
    assert.match(reviewer.taskExtras.get('review-2').completionIssues[0], /summaryFidelity/);
  } finally { for (const o of objects.reverse()) await o.stop(); }
});
