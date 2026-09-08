import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrumMaster } from './scrum-master.js';
import { GoalManager } from './goal-manager.js';
import { ObjectCreator } from './object-creator.js';

const invoke = (object: any, method: string, payload: unknown, from = 'runtime') => object.handlers.get(method)({ routing: { from }, payload });

test('replaying a recorded Scrum dispatch preserves its already admitted work', async () => {
  const scrum: any = new ScrumMaster();
  scrum.goalManagerId = 'goals'; scrum.agentAbjectId = 'runtime'; scrum.changed = () => {};
  scrum.scrumInFlight.set('decision', { goalId: 'goal', staged: [{ description: 'check result', assignedAgentId: 'checker', assignedAgentName: 'Checker', dependsOnIdx: [] }], planRevision: 0 });
  const calls: any[] = [];
  scrum.request = async (m: any) => {
    calls.push(m);
    switch (m.routing.method) {
      case 'getGoal': return { scratchpad: { 'learning/plans': [{ operationId: 'decision', revision: 1 }] } };
      case 'recordPlan': return { success: true, duplicate: true };
      case 'startNextScrum': return { scrumNumber: 1 };
      case 'addTask': return { taskId: 'stable-task' };
      case 'enqueueTask': return { queued: true };
      default: throw new Error(`Unexpected ${m.routing.method}`);
    }
  };
  await scrum.commitDispatchScrum('decision', 'goal');
  await scrum.commitDispatchScrum('decision', 'goal');
  assert(!calls.some(m => m.routing.method === 'cancelOutstandingTasks'));
  assert.deepEqual(calls.filter(m => m.routing.method === 'addTask').map(m => m.payload.operationId), ['decision:task:0', 'decision:task:0']);
});

test('a stale Scrum decision rejects before cancelling another plan', async () => {
  const scrum: any = new ScrumMaster(); scrum.goalManagerId = 'goals'; scrum.agentAbjectId = 'runtime';
  scrum.scrumInFlight.set('stale', { goalId: 'goal', staged: [{ description: 'check', assignedAgentId: 'checker', dependsOnIdx: [] }], planRevision: 0 });
  scrum.request = async (m: any) => {
    assert.equal(m.routing.method, 'getGoal');
    return { scratchpad: { 'learning/plans': [{ operationId: 'other', revision: 1 }] } };
  };
  await assert.rejects(scrum.commitDispatchScrum('stale', 'goal'), /Plan changed/);
});

test('Scrum terminal delivery retries failed commits and deduplicates the accepted reply', async () => {
  const scrum: any = new ScrumMaster(); scrum.goalManagerId = 'goals'; scrum.agentAbjectId = 'runtime';
  scrum.lookupGoalIdForOTATask = async () => 'goal';
  let attempts = 0, receipts = 0;
  scrum.executeTerminalAction = async () => { if (++attempts === 1) throw new Error('storage interrupted'); };
  scrum.request = async (m: any) => {
    if (m.routing.method === 'getGoal') return { scratchpad: {} };
    if (m.routing.method === 'recordScrumCommit') { receipts++; return { success: true }; }
    throw new Error(m.routing.method);
  };
  const payload = { ticketId: 'decision', deliveryId: 'delivery', success: true, lastAction: { action: 'dispatch_scrum' } };
  await assert.rejects(invoke(scrum, 'taskResult', payload), /storage interrupted/);
  await invoke(scrum, 'taskResult', payload);
  await invoke(scrum, 'taskResult', payload);
  assert.equal(attempts, 2); assert.equal(receipts, 1);
});

test('restart reconstruction preserves dependencies, priority and interrupted sessions', async () => {
  const scrum: any = new ScrumMaster(); scrum.goalManagerId = 'goals'; scrum.agentAbjectId = 'runtime';
  scrum.isRemoteGoal = async () => false;
  const enqueued: any[] = [];
  scrum.request = async (m: any) => {
    switch (m.routing.method) {
      case 'listGoals': return [{ id: 'goal' }];
      case 'getSessions': return [{ id: 'interrupted' }];
      case 'listAgents': return [{ name: 'Checker', agentId: 'new-checker' }];
      case 'getTasksForGoal': return [
        { id: 'producer', fields: { status: 'done' } },
        ...['ready', 'blocked', 'interrupted'].map(id => ({ id, fields: { status: 'pending', description: id, assignedAgentId: 'old-checker', dependsOn: [id === 'blocked' ? 'missing' : 'producer'], data: { assignedAgentName: 'Checker', priority: 7, target: 'app' } } })),
      ];
      case 'enqueueTask': enqueued.push(m.payload); return { queued: true };
      default: throw new Error(m.routing.method);
    }
  };
  await scrum.recoverDispatches(); await scrum.recoverDispatches();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].taskId, 'ready'); assert.equal(enqueued[0].agentId, 'new-checker');
  assert.equal(enqueued[0].priority, 7); assert.equal(enqueued[0].data.target, 'app');
  assert.deepEqual([...scrum.pendingDeps.get('blocked').blockers], ['missing']);
});

test('clearing completed goals retains unreviewed learning evidence', async () => {
  const manager: any = new GoalManager(); manager.saveGoalIndex = () => {}; manager.changed = () => {};
  manager.goals.set('pending-review', { id: 'pending-review', status: 'failed', scratchpad: { 'learning/review': 'pending' } });
  manager.goalOrder.push('pending-review');
  await invoke(manager, 'clearCompleted', {});
  assert(manager.goals.has('pending-review'));
});

test('ObjectCreator visual evidence is bound to the deployed application', async () => {
  const creator: any = new ObjectCreator();
  creator.refreshVisionCapability = async () => true;
  creator.discoverDep = async () => 'screenshot-service';
  const extra = { state: { deployTurn: 1, spawnedObjectId: 'target', visualSinceDeploy: false } };
  const action = { action: 'call', target: 'Screenshot', method: 'captureWindow' };
  await creator.captureVisionFromCall(extra, action, { ok: true, summary: '', data: { imageBase64: 'pixels', ownerId: 'unrelated' } });
  assert.equal(extra.state.visualSinceDeploy, false);
  await creator.captureVisionFromCall(extra, action, { ok: true, summary: '', data: { imageBase64: 'pixels', ownerId: 'target' } });
  assert.equal(extra.state.visualSinceDeploy, true);
});
