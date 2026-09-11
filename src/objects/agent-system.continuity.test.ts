import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, isTemporaryAskResponse, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { AgentAbject } from './agent-abject.js';
import { ObjectAgent } from './object-agent.js';
import { SkillAgent } from './skill-agent.js';
import { WebAgent } from './web-agent.js';
import { ScrumMaster } from './scrum-master.js';
import { TaskReviewer } from './task-reviewer.js';
import { ObjectCreator } from './object-creator.js';
import { ExternalCreator } from './external-creator.js';
import { TaskSession } from './task-session.js';
import { encodeAgentState } from '../core/agent-session-codec.js';

class Endpoint extends Abject {
  constructor(name: string) { super({ manifest: { name, version: '1', description: 'Isolated continuity fixture', interface: { id: `test:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } }); }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}
async function fixture() {
  const bus = new MessageBus(), objects: Abject[] = [];
  return {
    async add<T extends Abject>(object: T): Promise<T> { (object as any).onInit = async () => {}; await object.init(bus); objects.push(object); return object; },
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}
const invoke = (object: any, method: string, payload: unknown, from = 'runtime') => object.handlers.get(method)({ routing: { from }, payload });

test('all specialist snapshots enforce runtime ownership and isolate live state', async () => {
  const f = await fixture();
  try {
    const runtime = await f.add(new Endpoint('Runtime')), stranger = await f.add(new Endpoint('Stranger'));
    for (const C of [ObjectAgent, SkillAgent, WebAgent, ScrumMaster, TaskReviewer, ObjectCreator, ExternalCreator]) {
      const specialist: any = await f.add(new C()); specialist.agentAbjectId = runtime.id;
      const live = { marker: { value: 'original' } };
      (specialist.scrumInFlight ?? specialist.taskExtras ?? specialist.tasks).set('task', live);
      await assert.rejects(stranger.call(specialist.id, 'snapshotTask', { taskId: 'task' }), /runtime/i);
      const snapshot = await runtime.call(specialist.id, 'snapshotTask', { taskId: 'task' });
      (snapshot.inflight ?? snapshot).marker.value = 'changed';
      assert.equal(live.marker.value, 'original', C.name);
    }
  } finally { await f.stop(); }
});

test('explicit reviewer restore clears cancellation but retains evidence', async () => {
  const reviewer: any = new TaskReviewer(); reviewer.agentAbjectId = 'runtime';
  const evidence = { taskId: 'worker', predictions: [] };
  const snapshot = { kind: 'review', cancelled: true, records: [evidence] };
  assert.equal(invoke(reviewer, 'restoreTask', { taskId: 'resumed', snapshot }).success, true);
  assert.equal(reviewer.taskExtras.get('resumed').cancelled, false);
  assert.deepEqual(reviewer.taskExtras.get('resumed').records, [evidence]);
  const result = await reviewer.handleAct('resumed', { action: 'assess_prediction' });
  assert.notEqual(result.error, 'Review cancelled');
  assert.equal(snapshot.cancelled, true);
});

test('ExternalCreator handoff distinguishes failed execution from passing verification and keeps full reports', async () => {
  const creator: any = new ExternalCreator(); creator.agentAbjectId = 'runtime';
  creator.readGoalData = async () => undefined;
  let handoff: any; creator.writeGoalData = async (_: unknown, key: string, value: unknown) => {
    // The session handoff and the structured verification receipt are the two writes a task end makes.
    assert.ok(key === 'externalcreator:session' || key === 'verification/worker', key);
    if (key === 'externalcreator:session') handoff = value;
  };
  const extra: any = { taskId: 'worker', goalId: 'goal', taskText: 'Implement changes', filesRead: new Set(), filesModified: new Set(), decisions: [], checkpoints: [], audit: [] };
  creator.taskExtras.set('worker', extra);
  await invoke(creator, 'agentIntermediateAction', { taskId: 'worker', action: { action: 'reply', message: 'Found the cause; preserve the existing bus boundary.' } });
  const report = 'Investigation complete\nRemaining: implement the change and verify.';
  await creator.writeSessionSummary(extra, report, { ok: true, note: 'No edits to verify' }, { success: false, error: 'Step budget exhausted' });
  assert.equal(handoff.outcome.success, false);
  assert.equal(handoff.report, report);
  assert.match(handoff.summary, /Remaining: implement/);
  assert.match(handoff.summary, /Step budget exhausted/);
  assert.doesNotMatch(handoff.summary, /nothing outstanding|task reported complete/i);
  assert.deepEqual(handoff.decisions, ['Found the cause; preserve the existing bus boundary.']);
  await creator.writeSessionSummary(extra, 'Completed', { ok: true, note: 'Checks passed' }, { success: true });
  assert.equal(handoff.outcome.success, true);
});

test('file pages retain source and pagination metadata through runtime ingestion', async () => {
  const creator: any = new ExternalCreator();
  creator.resolveWorkPath = (_: unknown, p: string) => `/project/${p}`;
  creator.hostFs = async () => 'files'; creator.nestedInstructionsFor = async () => ''; creator.displayPath = (_: unknown, p: string) => p; creator.audit = () => {};
  creator.call = async (owner: string, method: string, args: any) => {
    assert.equal(owner, 'files'); assert.equal(method, 'readFile'); assert.equal(args.offset, 100);
    return { content: 'evidence'.repeat(2000), lines: 100, totalLines: 500, truncated: true, nextOffset: 200 };
  };
  const page = await creator.opRead({ filesRead: new Set() }, { action: 'read', path: 'source.ts', offset: 100, limit: 100 });
  const runtime: any = new AgentAbject(), entry: any = { state: { action: { action: 'read' }, lastResult: page, llmMessages: [] } };
  runtime.absorbResultPayload(entry);
  assert.equal(page.data.nextOffset, 200); assert.equal(page.data.truncated, true);
  assert.equal(page.data.path, '/project/source.ts'); assert.equal(page.data.totalLines, 500);
  assert.match(runtime.readChunk(entry, { id: page.payloadId }), /evidence/);
  runtime.addActionResultToConversation(entry);
  assert.match(entry.state.llmMessages.at(-1).content, /Requested page/);
  assert(entry.state.llmMessages.at(-1).content.includes('evidence'.repeat(2000)), 'an explicitly requested page arrives in full without another model step');
});

test('older payloads survive archival and restored sessions, and failed persistence never evicts them', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new AgentAbject()), sessions: any = await f.add(new TaskSession()), storage = await f.add(new Endpoint('Storage'));
    const data = new Map<string, any>();
    storage.on('set', msg => { const p = msg.payload as any; data.set(p.key, structuredClone(p.value)); return true; });
    storage.on('get', msg => data.get((msg.payload as any).key));
    sessions.storageId = storage.id; sessions.discoverDep = async () => runtime.id; runtime.sessionStoreId = sessions.id;
    const entry: any = { state: { id: 'session', action: { action: 'read_chunk', id: 'res-1' } } };
    for (let i = 0; i < 8; i++) runtime.storePayload(entry, `exact-selection-${i}`, 'result');
    await runtime.archivePayloads(entry);
    assert.equal(entry.payloads.length, 5); assert.equal(Object.keys(entry.archivedPayloads).length, 3);
    const restored = structuredClone(entry);
    const result = await runtime.performRuntimeAction(restored);
    assert.match(result.message, /exact-selection-0/);
    restored.payloads.find((p: any) => p.id === 'res-1').text = 'changed by reader';
    assert.equal(data.get('agent:payload:session:res-1').text, 'exact-selection-0', 'retrieval never aliases durable evidence');
    const stranger = await f.add(new Endpoint('Stranger'));
    await assert.rejects(stranger.call(sessions.id, 'readPayload', { sessionId: 'session', id: 'res-1' }), /AgentAbject/);
    storage.on('set', () => { throw new Error('Disk unavailable'); });
    runtime.storePayload(restored, 'new exact evidence', 'result');
    const before = restored.payloads.length;
    await runtime.archivePayloads(restored);
    assert.equal(restored.payloads.length, before);
  } finally { await f.stop(); }
});

test('busy SkillAgent Ask reports live capabilities without using an LLM', async () => {
  const f = await fixture();
  try {
    const client = await f.add(new Endpoint('Client')), registry = await f.add(new Endpoint('SkillRegistry'));
    registry.on('listSkills', () => [{ name: 'records', enabled: true, description: 'Inspect records' }]);
    registry.on('getEnabledMCPServers', () => [{ name: 'records', tools: [{ name: 'read_records' }] }]);
    const skill: any = await f.add(new SkillAgent()); skill.skillRegistryId = registry.id;
    skill.taskExtras.set('active', {}); skill.askLlm = () => { throw new Error('Must not call LLM while busy'); };
    const response = await client.call(skill.id, 'ask', { question: 'Can you inspect records?' });
    assert(isTemporaryAskResponse(response)); assert.match(response, /read_records/);
  } finally { await f.stop(); }
});

test('Scrum polls again after a temporary Ask response, then reuses substantive advice', async () => {
  const scrum: any = new ScrumMaster(); scrum.agentAbjectId = 'runtime'; let asks = 0;
  scrum.request = async (msg: any) => {
    if (msg.routing.method === 'listAgents') return [{ agentId: 'worker', name: 'Worker', description: 'Inspect records' }];
    if (msg.routing.method === 'ask') return ++asks === 1 ? '[Currently busy: working] Temporary availability response' : 'I can inspect records using the existing owner.';
    throw new Error(msg.routing.method);
  };
  await scrum.actPollTeam('goal', { question: 'Can you inspect records?' });
  const available = await scrum.actPollTeam('goal', { question: 'Can you inspect records?' });
  await scrum.actPollTeam('goal', { question: 'Can you inspect records?' });
  assert.equal(asks, 2); assert.match(available.data.contributions[0].text, /existing owner/);
});

test('ObjectCreator retains updated Ask guides and can retrieve them after context loss', async () => {
  const creator: any = new ObjectCreator();
  const state: any = { deps: new Map(), renderedGuides: new Set(), turnLog: [], turn: 1 };
  creator.mergeDiscoveryIntoDeps(state, 'Owner', 'owner', 'ask', 'Use version one.');
  state.renderedGuides.add('Owner');
  creator.mergeDiscoveryIntoDeps(state, 'Owner', 'owner', 'ask', 'Version one is obsolete; use version two.');
  assert(!state.renderedGuides.has('Owner'));
  creator.mergeDiscoveryIntoDeps(state, 'Owner', 'owner', 'ask', '[Currently busy: working] Temporary response');
  creator.tasks.set('task', { state, callerId: 'caller' });
  const result = await creator.handleAct('task', { action: 'read_guide', name: 'Owner' }, 'runtime');
  assert.match(result.data, /use version two/); assert.doesNotMatch(result.data, /Currently busy/);
});

test('progress detects repeated evidence across request shapes, permits new evidence and excludes narration', () => {
  const runtime: any = new AgentAbject();
  const entry: any = { config: { intermediateActions: ['reply'] }, state: { llmMessages: [] } };
  for (const [i, action] of [{ action: 'read', path: 'source', offset: 0 }, { action: 'call', method: 'readFile', offset: 100 }, { action: 'read_chunk', id: 'res-1', offset: 200 }].entries()) {
    entry.state.action = action; entry.state.lastResult = { success: true, data: { text: 'unchanged evidence', nextOffset: i * 100 } };
    runtime.detectAndSteerOscillation(entry, 'Reader');
  }
  assert.equal(entry.state.progressHistory.filter((p: any) => p.novel).length, 1);
  assert.equal(entry.state.activity.repeatedEvidence, 2);
  assert(entry.state.llmMessages.some((m: any) => m.content.includes('Repeated evidence')));
  for (let i = 0; i < 6; i++) {
    entry.state.action = { action: 'read', path: `related-${i}` }; entry.state.lastResult = { success: true, data: `new finding ${i}` };
    runtime.recordProgress(entry);
  }
  assert.equal(entry.state.progressHistory.filter((p: any) => p.novel).length, 7);
  entry.state.action = { action: 'reply', message: 'Still working' }; entry.state.lastResult = { success: true, data: 'Update delivered' };
  runtime.recordProgress(entry); assert.equal(entry.state.progressHistory.at(-1).novel, false);
});

test('restart recovery resumes eligible sessions instead of restarting investigation', async () => {
  const scrum: any = new ScrumMaster(); scrum.goalManagerId = 'goals'; scrum.agentAbjectId = 'runtime'; scrum.isRemoteGoal = async () => false;
  const resumed: string[] = [];
  scrum.request = async (msg: any) => {
    switch (msg.routing.method) {
      case 'listGoals': return [{ id: 'goal' }];
      case 'getSessions': return ['interrupted', 'uncertain', 'stopped'].map(id => ({ id, revision: 3, status: 'partial', ...(id === 'uncertain' ? { outstandingOperation: {} } : {}), ...(id === 'stopped' ? { outcome: { error: 'Cancelled' } } : {}) }));
      case 'listAgents': return [{ agentId: 'worker', name: 'Worker' }];
      case 'getTasksForGoal': return ['interrupted', 'uncertain', 'stopped'].map(id => ({ id, fields: { status: 'pending' } }));
      case 'resumeTask': resumed.push(msg.payload.id); return { ticketId: 'resumed' };
      default: throw new Error(`Unexpected restart message: ${msg.routing.method}`);
    }
  };
  await scrum.recoverDispatches(); await scrum.recoverDispatches();
  assert.deepEqual(resumed, ['interrupted']);
});

test('resumption preserves prediction numbering and reserves its queue slot across restoration', async () => {
  const runtime: any = new AgentAbject(); runtime.sessionStoreId = 'sessions';
  runtime.registeredAgents.set('worker', { agentId: 'worker', name: 'Worker', config: { maxSteps: 10, restoreMethod: 'restoreTask' } });
  const snapshot = encodeAgentState({ state: { id: 'original', step: 1, maxSteps: 10, llmMessages: [{ role: 'user', content: 'Retained investigation' }] }, config: {},
    predictions: [{ step: 2, expect: 'Read completes', outcome: 'success' }], pendingPrediction: { step: 2 }, specialist: {} });
  let restoring!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { restoring = r; }), blocked = new Promise<void>(r => { release = r; });
  runtime.request = async (msg: any) => {
    switch (msg.routing.method) {
      case 'get': return { agentId: 'worker', agentName: 'Worker', snapshot };
      case 'resume': return { success: true, session: { attempt: 2, revision: 2 } };
      case 'restoreTask': restoring(); await blocked; return { success: true };
      default: throw new Error(msg.routing.method);
    }
  };
  runtime.runTaskAsync = async () => {};
  let starts = 0; runtime.startQueuedTask = async () => { starts++; };
  const resuming = invoke(runtime, 'resumeTask', { id: 'original', expectedRevision: 1 });
  await entered;
  const queue = { inFlight: new Map(), pending: [{ taskId: 'next', task: 'new work' }] };
  runtime.agentTaskQueues.set('worker', queue);
  runtime.processNextInQueue('worker');
  assert.equal(starts, 0, 'new work cannot overlap restoration');
  await assert.rejects(invoke(runtime, 'resumeTask', { id: 'original', expectedRevision: 1 }), /active work/);
  release(); await resuming;
  const entry = runtime.taskEntries.get('original:attempt-2');
  assert.equal(entry.state.step, 2); assert.equal(entry.pendingPrediction, undefined);
  assert.equal(entry.predictions[0].step, 2); assert.equal(entry.state.maxSteps, 12);
  assert.match(entry.state.llmMessages[0].content, /Retained investigation/);
  assert(queue.inFlight.has('original:attempt-2'));
  assert.equal(starts, 0, 'resumed work owns the execution slot');
  runtime.releaseQueueSlot('worker', 'original:attempt-2');
  assert.equal(starts, 1);
});

test('review report connects recorded predictions and applied revisions to assessments and acknowledged changes', () => {
  const reviewer: any = new TaskReviewer();
  const report = reviewer.learningReport({ records: [{ taskId: 'worker', predictions: [{ step: 1, expect: 'Capability is unavailable', actual: 'Owner completed the request', actualRef: 'learning/observation/worker:1', patterns: [{ id: 'pattern', revision: 2, why: 'Availability constraint' }] }] }],
    assessments: { 'worker:1': { verdict: 'contradicted', explanation: 'Owner evidence disproves the constraint' } },
    decisions: [{ id: 'decision', context: { assessmentRefs: ['learning/assessment/worker:1'] }, evidence: {}, effects: [{ id: 'effect', input: { action: 'update_entry', id: 'pattern' }, state: 'applied', receipt: { revision: 3 } }] }],
  });
  const episode = report.predictions.episodes[0];
  assert.equal(episode.appliedPatterns[0].revision, 2);
  assert.equal(episode.assessment.verdict, 'contradicted');
  assert.equal(episode.consideredBy[0].effects[0].receipt.revision, 3);
});
