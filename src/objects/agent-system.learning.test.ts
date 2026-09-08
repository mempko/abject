import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeBase } from './knowledge-base.js';
import { GoalManager } from './goal-manager.js';
import { TaskReviewer } from './task-reviewer.js';
import { makePattern, serializePattern, readPattern } from '../core/pattern.js';

function pattern(name = 'VERIFY RESTORATION'): string {
  const result = makePattern({ name, context: 'persistent settings', forces: 'live success can conceal failed restoration', therefore: 'restore a candidate before acceptance', evidence: 'candidate', links: [] });
  assert(result.ok); return serializePattern(result.pattern);
}
function kb(): any { const k: any = new KnowledgeBase(); k.changed = () => {}; return k; }
function send(k: any, method: string, payload: unknown): Promise<any> { return k.handlers.get(method)({ routing: { from: 'reviewer' }, payload }); }

test('weave searches patterns before applying its candidate pool cap', async () => {
  const k = kb();
  for (let i = 0; i < 120; i++) await send(k, 'remember', { title: `persistent settings fact ${i}`, content: 'persistent settings', type: 'fact' });
  const saved = await send(k, 'remember', { title: 'VERIFY RESTORATION', content: pattern(), type: 'pattern' });
  const woven = await send(k, 'weave', { query: 'persistent settings', limit: 1 });
  assert.equal(woven.patterns[0].id, saved.id);
});
test('pattern edits preserve history and reject stale revisions', async () => {
  const k = kb(), saved = await send(k, 'remember', { title: 'VERIFY RESTORATION', content: pattern(), type: 'pattern' });
  assert.equal((await send(k, 'update', { id: saved.id, content: pattern(), expectedRevision: 1 })).success, true);
  assert.equal((await send(k, 'update', { id: saved.id, content: pattern(), expectedRevision: 1 })).conflict, true);
  const history = await send(k, 'patternHistory', { id: saved.id });
  assert.equal(history.revision, 2); assert.equal(history.history.length, 1);
  assert.equal(readPattern(history.history[0].content)?.context, 'persistent settings');
});
test('pattern feedback deduplicates episodes and preserves counterexamples', async () => {
  const k = kb(), saved = await send(k, 'remember', { title: 'VERIFY RESTORATION', content: pattern(), type: 'pattern' });
  const application = { id: 'episode-a', goalId: 'goal-a', context: 'settings', verdict: 'helpful', evidence: 'restored value equals saved value', patternRevision: 1 };
  await send(k, 'recordPatternApplication', { id: saved.id, application });
  await send(k, 'recordPatternApplication', { id: saved.id, application });
  await send(k, 'recordPatternApplication', { id: saved.id, application: { ...application, id: 'episode-b', goalId: 'goal-b', verdict: 'harmful', evidence: 'test used a production restore target' } });
  await send(k, 'markUseful', { ids: [saved.id], operationId: 'review-a' });
  await send(k, 'markUseful', { ids: [saved.id], operationId: 'review-a' });
  const found = await send(k, 'get', { id: saved.id });
  assert.equal(found.usefulCount, 1); assert.equal(found.pattern.learning.applications.length, 2);
  assert.match(found.content, /helpful in 1 distinct goals; counterexamples in 1 goals/);
});
test('legacy action failures are not described as proven prediction misses', () => {
  const r: any = new TaskReviewer();
  const text = r.formatPredictions({ predictions: [{ step: 1, action: 'call', expect: 'rejected', missed: true, outcome: 'failure' }] });
  assert.match(text, /unresolved/); assert.doesNotMatch(text, /MISSED/);
});
test('goal plan revisions are conditional and replay-safe', async () => {
  const g: any = new GoalManager(); g.changed = () => {}; g.goals.set('goal', { id: 'goal', status: 'active', scratchpad: {} });
  const payload = { goalId: 'goal', operationId: 'round-a', expectedRevision: 0, plan: { assumptions: ['restoration holds'] } };
  assert.equal((await send(g, 'recordPlan', payload)).revision, 1);
  assert.equal((await send(g, 'recordPlan', payload)).duplicate, true);
  assert.equal((await send(g, 'recordPlan', { ...payload, operationId: 'round-b' })).conflict, true);
  assert.equal((await send(g, 'recordPlan', { ...payload, operationId: 'round-b', expectedRevision: 1, plan: { change: 'test restoration before deployment' } })).revision, 2);
});
test('failed goal retains evidence and a pending review until acknowledged', async () => {
  const g: any = new GoalManager(); const notices: string[] = []; g.changed = (name: string) => notices.push(name);
  g.goals.set('goal', { id: 'goal', title: 'restore settings', status: 'active', scratchpad: {} });
  await send(g, 'recordObservation', { goalId: 'goal', operationId: 'action-a', observation: { expect: 'settings survive', verdict: 'contradicted', actual: 'empty settings' } });
  await send(g, 'failGoal', { goalId: 'goal', error: 'restore did not preserve values' });
  assert.equal((await send(g, 'pendingReviews', {})).length, 1);
  assert.equal(g.goals.get('goal').scratchpad['learning/observation/action-a'].actual, 'empty settings');
  await send(g, 'ackReview', { goalId: 'goal' });
  assert.equal((await send(g, 'pendingReviews', {})).length, 0); assert(notices.includes('goalFailed'));
});
