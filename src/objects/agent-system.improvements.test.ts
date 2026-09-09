import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { HostFileSystem } from './capabilities/host-filesystem.js';
import { ExternalCreator } from './external-creator.js';
import { ExternalProjectRegistry } from './external-project-registry.js';
import { AgentAbject } from './agent-abject.js';
import { GoalManager } from './goal-manager.js';
import { TaskReviewer } from './task-reviewer.js';
import { KnowledgeBase } from './knowledge-base.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Verification regression fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
  }
  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}
class Creator extends ExternalCreator { protected override async onInit(): Promise<void> {} }
class Projects extends ExternalProjectRegistry { protected override async onInit(): Promise<void> {} }
class Knowledge extends KnowledgeBase { protected override async onInit(): Promise<void> {} }
class Runtime extends AgentAbject { protected override async onInit(): Promise<void> {} }
class Reviewer extends TaskReviewer { protected override async onInit(): Promise<void> {} }

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  return { async add<T extends Abject>(o: T): Promise<T> {
    o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  }, async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

test('restored payload identities cannot alias retained output; diffs have an offset index', () => {
  const runtime: any = new Runtime();
  const restored = { payloads: [{ id: 'res-12', text: 'old output', kind: 'result', storedAt: 1 }] };
  const id = runtime.storePayload(restored, 'new output', 'result');
  assert.equal(id, 'res-13');
  assert.match(runtime.readChunk(restored, { id }), /new output/);
  const diff = 'diff --git a/a.ts b/a.ts\nchange\ndiff --git a/b.ts b/b.ts\nnext';
  const diffId = runtime.storePayload(restored, diff, 'result');
  assert.match(runtime.readChunk(restored, { id: diffId, outline: true }), /@32: diff --git a\/b.ts/);
});

test('verification reuses stable baseline evidence, exposes owned output, and runs again for edits or force', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'abject-reuse-')), f = await fixture();
  try {
    await writeFile(path.join(dir, 'source.ts'), 'one');
    const caller = await f.add(new Endpoint('AgentAbject'));
    await f.add(new HostFileSystem({ allowedPaths: [dir], readOnly: true }));
    const projects: any = await f.add(new Projects()), creator: any = await f.add(new Creator());
    creator.agentAbjectId = caller.id;
    const project = { name: 'fixture', root: dir, trusted: true, vcs: 'none', checkCommand: 'check', verifyCommand: 'verify', isolation: 'none', protectedPaths: [], autonomy: 'full' };
    projects.projects.set('fixture', project);
    const counts: Record<string, number> = {}; let exitCode = 0;
    const output = await f.add(new Endpoint('Output'));
    output.on('readOutput', msg => {
      assert.equal(msg.routing.from, creator.id);
      return { text: 'complete retained evidence', totalBytes: 100000 };
    });
    const shell = await f.add(new Endpoint('ShellExecutor'));
    shell.on('exec', msg => {
      const command = (msg.payload as any).command;
      counts[command] = (counts[command] ?? 0) + 1;
      return { stdout: 'x'.repeat(10000), stderr: '', exitCode, outputObjectId: output.id, truncated: { stream: 'stdout', droppedLines: 100, totalBytes: 100000 } };
    });
    const extra = { taskId: 'review', taskText: 'review', project, workRoot: dir, filesRead: new Set(), filesModified: new Set(), preImages: new Map(), postImages: new Map(), instructionDirsSeen: new Set(), mutationsSinceVerify: 0, checkpoints: [], audit: [], decisions: [], editSetOpen: false };
    creator.taskExtras.set('review', extra);
    await creator.captureBaseline(extra); await (extra as any).verifyBaseline.promise;
    const act = (action: unknown, taskId = 'review') => caller.call(creator.id, 'agentAct', { taskId, action });
    const first = await act({ action: 'verify' });
    assert.equal(first.data.reused, true); assert.equal(counts.verify, 1);
    assert.equal(first.data.outputObjectId, output.id); assert(first.data.outputTruncated);
    assert.match((await act({ action: 'read_output', id: output.id })).payload, /complete retained/);
    output.on('readOutput', msg => {
      const { offset = 0, length } = msg.payload as any;
      assert.equal(length, 30000); assert.equal(msg.routing.from, creator.id);
      return { text: 'd'.repeat(30000), offset, nextOffset: offset + 30000, totalBytes: 60000 };
    });
    const page = await act({ action: 'read_output', id: output.id });
    assert.equal(page.payload.length, 30000); assert.equal(page.data.nextOffset, 30000);
    assert.equal(page.data.readOutput.offset, 30000); assert.equal(page.data.totalBytes, 60000);
    const runtime: any = await f.add(new Runtime()), jobs = await f.add(new Endpoint('JobManager'));
    runtime.jobManagerId = jobs.id;
    jobs.on('submitJob', () => ({ status: 'completed', result: page }));
    for (const directExecution of [true, false]) {
      const entry: any = { config: { directExecution }, state: { id: 'display-page', phase: 'acting', timeout: 5000,
        action: { action: 'read_output', id: output.id }, llmMessages: [] } };
      entry.state.lastResult = await runtime.executeStep(entry, 'Read page', 'return page', async () => page);
      runtime.absorbResultPayload(entry);
      runtime.addActionResultToConversation(entry);
      assert(entry.state.llmMessages.at(-1).content.includes(page.payload), 'the model must receive the entire requested page through both execution paths');
      assert.equal(entry.state.lastResult.payload, undefined, 'raw pages do not ride task state/events');
      const ordinary: any = { state: { action: { action: 'bash' }, lastResult: { ...page, payloadMode: undefined }, llmMessages: [] } };
      runtime.absorbResultPayload(ordinary); runtime.addActionResultToConversation(ordinary);
      assert(!ordinary.state.llmMessages.at(-1).content.includes(page.payload), 'unsolicited bulk still uses a bounded preview');
    }
    assert.equal((await act({ action: 'read_output', id: output.id, length: 60000 })).payload.length, 30000, 'requested pages stay bounded');
    const last = await act(page.data.readOutput);
    assert.equal(last.data.nextOffset, 60000); assert.equal(last.data.readOutput, undefined);
    assert.equal(counts.verify, 1, 'reading full retained output does not execute the command again');
    creator.taskExtras.set('stranger', { ...extra, taskId: 'stranger', commandOutputs: new Set() });
    assert.equal((await act({ action: 'read_output', id: output.id }, 'stranger')).success, false);
    await writeFile(path.join(dir, 'source.ts'), 'two');
    assert.equal((await act({ action: 'verify' })).data.reused, false); assert.equal(counts.verify, 2);
    exitCode = 1;
    const failed = await act({ action: 'verify', force: true });
    assert.equal(failed.data.exitCode, 1); assert.equal(counts.verify, 3);
    assert.equal((await caller.call(creator.id, 'candidateComplete', { taskId: 'review', result: 'candidate' })).accepted, false);
    assert.equal((await act({ action: 'verify' })).data.reused, false, 'a failed rerun supersedes an older passing baseline');
    assert.equal(counts.verify, 4);
    const failedBash = await act({ action: 'bash', command: 'failing' });
    assert.equal(failedBash.success, false); assert.equal(failedBash.data.exitCode, 1);
    assert.equal(failedBash.data.outputObjectId, output.id); assert(failedBash.payload);
    shell.on('stopTaskProcesses', () => ({ cancelled: 0 }));
    await caller.call(creator.id, 'taskCancelled', { taskId: 'review' });
    const beforeCancel = counts.verify;
    assert.equal((await act({ action: 'verify', force: true })).success, false);
    assert.equal(counts.verify, beforeCancel, 'cancelled verification cannot launch another command');
  } finally { await f.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('prediction is recorded before the action and semantic agreement stays unknown', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), goals = await f.add(new Endpoint('GoalManager'));
    runtime.goalManagerId = goals.id;
    const events: any[] = []; goals.on('recordObservation', msg => { events.push(msg.payload); return { success: true }; });
    const entry: any = { goalId: 'goal', payloads: [], state: { id: 'task', step: 0, action: { action: 'call', expect: 'receiver rejects invalid input', expectOutcome: 'failure', patterns: [{ id: 'p', revision: 2, why: 'Validate before writes' }] } } };
    await runtime.preparePrediction(entry);
    assert.equal(events[0].observation.kind, 'prediction'); assert.equal(events[0].observation.outcome, undefined);
    entry.state.action.expect = 'rewritten after execution';
    entry.state.lastResult = { success: false, error: 'invalid input' };
    await runtime.recordPrediction(entry);
    const prediction = entry.predictions[0];
    assert.equal(prediction.expect, 'receiver rejects invalid input');
    assert.equal(prediction.verdict, 'supported'); assert.equal(prediction.semanticVerdict, 'unresolved');
    assert.equal(prediction.patterns[0].revision, undefined); assert.match(prediction.patterns[0].provenanceError, /unresolved/); assert(prediction.predictedAt <= prediction.observedAt);
    assert.equal(entry.payloads.length, 0, 'observations do not evict command output');
    entry.state.step++; entry.state.action = { action: 'call' }; await runtime.preparePrediction(entry);
    entry.state.lastResult = { success: true, data: 'done' }; await runtime.recordPrediction(entry);
    assert.equal(entry.predictions[1].expect, ''); assert.equal(entry.predictions[1].verdict, 'unresolved');
  } finally { await f.stop(); }
});

test('goal briefing bounds scratchpad values while complete learning evidence remains available', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('Caller')), goals = await f.add(new GoalManager());
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Review', description: 'Preserve the user intent' });
    await caller.call(goals.id, 'writeGoalData', { goalId, key: 'input', value: 'x'.repeat(50000) });
    await caller.call(goals.id, 'recordObservation', { goalId, operationId: 'surprise', observation: { actual: 'unexpected'.repeat(10000) } });
    const brief = await caller.call(goals.id, 'getGoalBriefing', { goalId, keys: ['input'] });
    assert(JSON.stringify(brief).length < 20000); assert(brief.omitted.includes('input'));
    assert.equal(brief.description, 'Preserve the user intent');
    assert.equal((await caller.call(goals.id, 'readGoalData', { goalId, key: 'input' })).length, 50000);
    assert((await caller.call(goals.id, 'readGoalData', { goalId, key: 'learning/observation/surprise' })).actual);
  } finally { await f.stop(); }
});

test('review dossier retains surprises, prefetches knowledge, and exposes complete evidence and separate pattern episodes', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Endpoint('KnowledgeBase'));
    const applications = new Map<string, any>(); let gets = 0;
    kb.on('recall', () => [{ id: 'pattern', title: 'Validate input' }]);
    kb.on('get', () => { gets++; return { id: 'pattern', pattern: { learning: { revision: 3 } }, content: 'current pattern' }; });
    kb.on('recordPatternApplication', msg => { const app = (msg.payload as any).application; applications.set(app.id, app); return { success: true }; });
    const reviewer: any = await f.add(new Reviewer()); reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id;
    reviewer.requireLearningProtocol = async () => {};
    const records = Array.from({ length: 8 }, (_, i) => ({ taskId: `task-${i}`, task: 'Review', agentName: 'Worker', phase: 'done', steps: 1, injectedKnowledge: [{ id: 'pattern', title: 'Validate input' }], transcript: 'FULL_EVIDENCE'.repeat(5000), predictions: [{ step: 1, action: 'call', expect: `prediction ${i}`, outcome: 'success', verdict: i === 7 ? 'contradicted' : 'unresolved', actual: `feedback ${i}`, patterns: [{ id: 'pattern', revision: 2, why: 'input validation' }] }] }));
    const material = JSON.stringify(records);
    const dossier = await reviewer.buildLearningDossier('Review predictions', material, records);
    assert(dossier.length <= 40000); assert.match(dossier, /task-7 step 1:.*contradicted/);
    assert.match(dossier, /current pattern/); assert.equal(gets, 1);
    reviewer.taskExtras.set('review', { kind: 'review', goalId: 'goal', records, fullMaterial: material });
    const act = (action: unknown) => caller.call(reviewer.id, 'agentAct', { taskId: 'review', action });
    assert.match((await act({ action: 'read_evidence', taskId: 'task-7' })).data, /FULL_EVIDENCE/);
    assert.equal((await act({ action: 'read_evidence', taskId: 'unrelated' })).success, false);
    for (const [taskId, verdict] of [['task-0', 'helpful'], ['task-7', 'harmful'], ['task-7', 'harmful']]) {
      assert.equal((await act({ action: 'record_pattern_application', id: 'pattern', application: { taskId, step: 1, verdict, context: 'validation', evidence: 'observed feedback', patternRevision: 2 } })).success, true);
    }
    assert.equal(applications.size, 2); assert.deepEqual([...applications.values()].map(a => a.verdict), ['helpful', 'harmful']);
    assert.equal((await act({ action: 'record_pattern_application', id: 'pattern', application: { taskId: 'missing', step: 1 } })).success, false);
  } finally { await f.stop(); }
});

test('semantic assessments are reviewer-owned, evidence-backed, replay-safe, and preserve missing predictions as unknown', async () => {
  const f = await fixture();
  try {
    const reviewer = await f.add(new Endpoint('TaskReviewer')), other = await f.add(new Endpoint('Other')), goals = await f.add(new GoalManager());
    const { goalId } = await other.call(goals.id, 'createGoal', { title: 'Learn', description: 'Learn from feedback' });
    await other.call(goals.id, 'recordObservation', { goalId, operationId: 'task:1', observation: { expect: 'exactly three records', outcome: 'success', actual: 'two records' } });
    const assessment = { goalId, taskId: 'task', step: 1, verdict: 'contradicted', explanation: 'The operation succeeded but returned two records rather than three.' };
    await assert.rejects(other.call(goals.id, 'recordPredictionAssessment', assessment), /TaskReviewer/);
    assert.equal((await reviewer.call(goals.id, 'recordPredictionAssessment', assessment)).success, true);
    const repeat = await reviewer.call(goals.id, 'recordPredictionAssessment', { ...assessment, verdict: 'supported' });
    assert.equal(repeat.duplicate, true); assert.equal(repeat.assessment.verdict, 'contradicted');
    const original = await other.call(goals.id, 'readGoalData', { goalId, key: 'learning/observation/task:1' });
    assert.equal(original.outcome, 'success'); assert.equal(original.actual, 'two records');
    await other.call(goals.id, 'recordObservation', { goalId, operationId: 'task:2', observation: { expect: '', outcome: 'success' } });
    assert.equal((await reviewer.call(goals.id, 'recordPredictionAssessment', { ...assessment, step: 2, verdict: 'supported' })).success, false);
    assert.equal((await reviewer.call(goals.id, 'recordPredictionAssessment', { ...assessment, step: 2, verdict: 'unresolved' })).success, true);
  } finally { await f.stop(); }
});

test('same-task simultaneous verification requests share execution, while another task executes independently', async () => {
  const creator: any = new Creator();
  let resolve!: (result: unknown) => void, executions = 0;
  creator.verificationSnapshot = async () => ({ complete: true, revision: 'same' });
  creator.runCommand = async () => { executions++; return await new Promise(r => { resolve = r; }); };
  const first = creator.captureOutcome({ taskId: 'a' }, 'verify', 1000);
  const second = creator.captureOutcome({ taskId: 'a' }, 'verify', 1000);
  await new Promise(r => setImmediate(r)); assert.equal(executions, 1);
  resolve({ stdout: 'ℹ tests 2\nℹ pass 2\nℹ fail 0', stderr: '', exitCode: 0 });
  const results = await Promise.all([first, second]); assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0].testSummary, { tests: 2, passed: 2, failed: 0 });
  const third = creator.captureOutcome({ taskId: 'b' }, 'verify', 1000);
  await new Promise(r => setImmediate(r)); assert.equal(executions, 2);
  resolve({ stdout: '', stderr: '', exitCode: 0 }); await third;
  creator.reportProgress = () => {}; creator.audit = () => {};
  creator.captureOutcome = async (extra: any, command: string) => { executions++; return { taskId: extra.taskId, command, exitCode: 0, signatures: [], at: Date.now() }; };
  const inherited = { taskId: 'c', project: { verifyCommand: 'verify' }, filesModified: new Set(), mutationsSinceVerify: 0, baseline: { verify: results[0] } };
  assert.equal((await creator.opVerify(inherited, {})).data.reused, false);
  assert.equal(executions, 3, 'a different task cannot reuse the predecessor verification as its own');
});

test('cancelled pipelines retain their pre-action prediction with an unknown outcome', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
    const jobs = await f.add(new Endpoint('JobManager'));
    let release!: (value: unknown) => void, started = false;
    const results: any[] = [];
    jobs.on('submitJob', () => { started = true; return new Promise(resolve => { release = resolve; }); });
    caller.on('taskResult', msg => { results.push(msg.payload); });
    runtime.think = async () => ({ action: 'submit_job', code: 'return 1', expect: 'one result', expectOutcome: 'success' });
    await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { directExecution: true, skipFirstObservation: true, maxSteps: 5 } });
    await caller.call(runtime.id, 'startTask', { taskId: 'pipeline', task: 'Run experiment' });
    for (let i = 0; i < 100 && !started; i++) await new Promise(r => setImmediate(r));
    assert(started);
    await caller.call(runtime.id, 'cancelTask', { taskId: 'pipeline' });
    release({ status: 'completed', result: 1 });
    for (let i = 0; i < 100 && !results.length; i++) await new Promise(r => setImmediate(r));
    assert.equal(results[0].success, false);
    const transcript = await caller.call(runtime.id, 'getTaskTranscript', { taskId: 'pipeline' });
    assert.equal(transcript.predictions[0].expect, 'one result');
    assert.equal(transcript.predictions[0].outcome, 'unknown');
    assert.equal(transcript.predictions[0].verdict, 'unresolved');
  } finally { await f.stop(); }
});


test('runtime captures application receipts before acting and reviewer settles partial learning without inventing revisions', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Knowledge());
    const runtime: any = await f.add(new Runtime()), reviewer: any = await f.add(new Reviewer());
    const goals = await f.add(new GoalManager());
    runtime.goalManagerId = goals.id; reviewer.goalManagerId = goals.id;
    reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id;
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Restore', description: 'Validate restoration' });
    const content = JSON.stringify({ format: 1, name: 'RESTORE', context: 'settings', forces: 'live state can conceal lost data', therefore: 'restore and compare', evidence: 'candidate', links: [] });
    const { id } = await caller.call(kb.id, 'remember', { title: 'RESTORE', type: 'pattern', content });
    const selected = await caller.call(kb.id, 'get', { id });
    const entry: any = { goalId, patternSelections: { [id]: selected.patternRef }, state: { id: 'worker', step: 0,
      action: { action: 'call', expect: 'The restored value is unchanged', expectOutcome: 'success',
        patterns: [{ id, why: 'Check restored settings', revision: 999, applicationRef: 'model-invented' }] } } };
    await runtime.preparePrediction(entry);
    const before = await caller.call(kb.id, 'patternHistory', { id });
    assert.equal(before.applications[0].verdict, 'applied');
    const applicationRef = entry.pendingPrediction.action.patterns[0].applicationRef;
    assert(applicationRef && applicationRef !== 'model-invented');
    await caller.call(kb.id, 'update', { id, content, expectedRevision: 1 });
    entry.state.lastResult = { success: true, data: 'Restored value was replaced by an older value' };
    await runtime.recordPrediction(entry);
    assert.equal(entry.predictions[0].verdict, 'supported', 'operation succeeded');
    const record = { taskId: 'worker', predictions: entry.predictions };
    await caller.call(goals.id, 'recordTaskEvidence', { goalId, taskId: 'worker', record });
    reviewer.taskExtras.set('review', { kind: 'review', goalId, records: [record] });
    const act = (action: unknown) => caller.call(reviewer.id, 'agentAct', { taskId: 'review', action });
    const bad = await act({ action: 'record_pattern_application', id: 'unknown', application: { taskId: 'worker', step: 1, verdict: 'helpful', evidence: 'unknown' } });
    assert.equal(bad.learningStatus, 'unresolved');
    const semantic = await act({ action: 'assess_prediction', taskId: 'worker', step: 1, verdict: 'contradicted', explanation: 'The restore succeeded but changed the value' });
    assert.equal(semantic.learningStatus, 'saved');
    const beforeFeedback = await caller.call(reviewer.id, 'completeReview', { taskId: 'review' });
    assert.equal(beforeFeedback.result.patterns.unresolved, 1);
    const feedback = { action: 'record_pattern_application', id, application: { taskId: 'worker', step: 1, verdict: 'harmful', evidence: 'Restoring replaced a newer value' } };
    assert.equal((await act(feedback)).learningStatus, 'saved');
    assert.equal((await act(feedback)).learningStatus, 'saved');
    const history = await caller.call(kb.id, 'patternHistory', { id });
    assert.equal(history.applications.length, 1); assert.equal(history.applications[0].patternRevision, 1);
    const completion = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: 'All predictions held' });
    assert.equal(completion.accepted, true); assert.equal(completion.result.status, 'partial');
    assert.equal(completion.result.predictions.contradicted, 1); assert.equal(completion.result.predictions.supported, 0);
    assert.equal(completion.result.patterns.harmful, 1); assert.equal(completion.result.patterns.unresolved, 0);
    assert.equal(completion.result.pending.length, 1); assert.doesNotMatch(JSON.stringify(completion.result), /All predictions held/);
    const snapshot = await caller.call(reviewer.id, 'snapshotTask', { taskId: 'review' });
    reviewer.taskExtras.delete('review');
    await caller.call(reviewer.id, 'restoreTask', { taskId: 'review', snapshot });
    assert.deepEqual((await caller.call(reviewer.id, 'completeReview', { taskId: 'review' })).result, completion.result);
    await caller.call(reviewer.id, 'taskResult', { ticketId: 'review', success: true });
    assert.equal(await caller.call(goals.id, 'readGoalData', { goalId, key: 'learning/review' }), 'partial');
    assert.equal((await caller.call(goals.id, 'readGoalData', { goalId, key: 'learning/reviewOutcome' })).pending.length, 1);
    assert.equal((await caller.call(goals.id, 'pendingReviews')).length, 0, 'partial settlement does not create an automatic retry loop');
  } finally { await f.stop(); }
});


test('interrupted pattern applications cannot be credited as useful and rejected updates stay pending until repaired', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Endpoint('KnowledgeBase'));
    const reviewer: any = await f.add(new Reviewer()); reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id;
    reviewer.requireLearningProtocol = async () => {};
    let feedbackCalls = 0, rejectUpdate = true;
    kb.on('assessPatternApplication', () => { feedbackCalls++; return { success: true }; });
    kb.on('get', () => ({ origin: 'agent' }));
    kb.on('update', () => ({ success: !rejectUpdate, error: rejectUpdate ? 'Receiver rejected the update' : undefined }));
    reviewer.taskExtras.set('review', { kind: 'review', goalId: 'goal', records: [{ taskId: 'interrupted', predictions: [{ step: 1, outcome: 'unknown', patterns: [{ id: 'pattern', applicationRef: 'captured', why: 'Validate' }] }] }] });
    const act = (action: unknown) => caller.call(reviewer.id, 'agentAct', { taskId: 'review', action });
    assert.equal((await act({ action: 'record_pattern_application', id: 'pattern', application: { taskId: 'interrupted', step: 1, verdict: 'helpful', evidence: 'Assumed success' } })).success, false);
    assert.equal(feedbackCalls, 0);
    assert.equal((await act({ action: 'record_pattern_application', id: 'pattern', application: { taskId: 'interrupted', step: 1, verdict: 'inconclusive', evidence: 'No completed observation' } })).learningStatus, 'saved');
    const update = { action: 'update_entry', id: 'fact', content: 'revised fact' };
    assert.equal((await act(update)).learningStatus, 'rejected');
    let report = (await caller.call(reviewer.id, 'completeReview', { taskId: 'review' })).result;
    assert.equal(report.pending.length, 1); assert.equal(report.patterns.inconclusive, 1);
    rejectUpdate = false;
    assert.equal((await act(update)).learningStatus, 'saved');
    report = (await caller.call(reviewer.id, 'completeReview', { taskId: 'review' })).result;
    assert.equal(report.pending.length, 0); assert.equal(report.predictions.unresolved, 1);
    assert.equal(report.attempts.filter((u: any) => u.status === 'rejected').length, 2, 'attempt evidence survives repair');
  } finally { await f.stop(); }
});


test('paging distinct handles and offsets is progress, while repeating the same page still triggers loop detection', () => {
  const runtime: any = new Runtime();
  const entry: any = { state: { llmMessages: [] } };
  const read = (id: string, offset: number) => {
    entry.state.action = { action: 'read_output', id, offset, length: 30000 };
    entry.state.lastResult = { success: true, data: { offset, nextOffset: offset + 30000, totalBytes: 90000 } };
    runtime.detectAndSteerOscillation(entry, 'Worker');
  };
  for (const id of ['first', 'second']) for (const offset of [0, 30000, 60000]) read(id, offset);
  assert.equal(entry.state.llmMessages.length, 0);
  for (let i = 0; i < 3; i++) read('second', 60000);
  assert.equal(entry.state.llmMessages.length, 1);
  assert.match(entry.state.llmMessages[0].content, /Loop detected/);
});

test('passing tests with expected error logs have zero known failures; real runner failures remain failures', () => {
  const creator: any = new Creator();
  const extra = { taskId: 'test', workRoot: '/fixture', baseline: {} };
  const snapshot = { complete: true, revision: 'same' };
  const output = '[Worker] Task error at step 0: Cancelled\nError: Expected fixture rejection\nℹ tests 186\nℹ pass 186\nℹ fail 0\n';
  const passing = creator.checkOutcome(extra, 'pnpm test', { stdout: output, stderr: '', exitCode: 0 }, snapshot, snapshot);
  assert.equal(passing.failureCount, 0); assert.deepEqual(passing.signatures, []);
  assert.deepEqual(passing.testSummary, { tests: 186, passed: 186, failed: 0 });
  assert.match(creator.baselineSummary({ baseline: { verify: { ...passing, signatures: ['old cached diagnostic'] } } }), /0 known failure/);
  const failing = creator.checkOutcome(extra, 'pnpm test', { stdout: 'Error: assertion failed\n# tests 2\n# pass 1\n# fail 1\n', stderr: '', exitCode: 1 }, snapshot, snapshot);
  assert.equal(failing.failureCount, 1); assert.equal(failing.signatures.length, 1);
  assert.equal(creator.judge(failing, passing, []).passed, false);
  const compiler = creator.checkOutcome(extra, 'pnpm typecheck', { stdout: 'src/a.ts(2,3): error TS2322: wrong type\n', stderr: '', exitCode: 2 }, snapshot, snapshot);
  assert(compiler.signatures[0].includes('TS2322')); assert.equal(compiler.failureCount, undefined);
});

test('one review completion records predictions and applications via their owners without extra model turns', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Knowledge()), goals = await f.add(new GoalManager());
    const reviewer: any = await f.add(new Reviewer()); reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id; reviewer.goalManagerId = goals.id;
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Inspect diffs', description: 'Review all changed code' });
    const { id } = await caller.call(kb.id, 'remember', { title: 'FULL DIFF', type: 'pattern', content: JSON.stringify({ format: 1, name: 'FULL DIFF', context: 'code review', forces: 'previews omit code', therefore: 'read retained pages', evidence: 'candidate', links: [] }) });
    const selected = await caller.call(kb.id, 'get', { id });
    const { applicationRef } = await caller.call(kb.id, 'beginPatternApplication', { id, patternRef: selected.patternRef, applicationId: 'worker:1:pattern', goalId, context: 'Read every diff page' });
    const predictions = Array.from({ length: 17 }, (_, i) => ({ step: i + 1, action: 'read_output', expect: 'Complete requested page is visible', outcome: 'success', verdict: 'supported', actual: i === 0 ? 'Only 2000 characters were displayed; the rest was retained behind a handle' : 'Requested page is visible in the transcript', patterns: i === 0 ? [{ id, applicationRef, why: 'Read the whole diff' }] : [] }));
    const record = { taskId: 'worker', predictions, transcript: 'Full execution evidence', injectedKnowledge: [] };
    await caller.call(goals.id, 'recordTaskEvidence', { goalId, taskId: 'worker', record });
    reviewer.taskExtras.set('review', { kind: 'review', goalId, records: [record] });
    const dossier = await reviewer.buildLearningDossier('Review', '', [record]);
    assert.match(dossier, /Only 2000 characters were displayed/);
    const first = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: 'All predictions aligned; no learnings' });
    assert.equal(first.accepted, false); assert.match(first.reason, /assessments/);
    const result = { assessments: predictions.map(p => ({ taskId: 'worker', step: p.step, verdict: p.step === 1 ? 'contradicted' : 'supported', explanation: p.actual })), applications: [{ id, application: { taskId: 'worker', step: 1, verdict: 'inconclusive', evidence: 'The page was fetched but most of its body was not displayed' } }] };
    const complete = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result });
    assert.equal(complete.accepted, true); assert.equal(complete.result.status, 'complete');
    assert.equal(complete.result.predictions.supported, 16); assert.equal(complete.result.predictions.contradicted, 1); assert.equal(complete.result.predictions.unresolved, 0);
    assert.equal(complete.result.patterns.inconclusive, 1); assert.equal(complete.result.saved.length, 18);
    const assessment = await caller.call(goals.id, 'readGoalData', { goalId, key: 'learning/assessment/worker:1' });
    assert.equal(assessment.verdict, 'contradicted');
    const replay = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result });
    assert.equal(replay.result.saved.length, 18); assert.equal((await caller.call(kb.id, 'patternHistory', { id })).applications.length, 1);
    const invalid = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: { assessments: [{ taskId: 'unrelated', step: 1, verdict: 'supported', explanation: 'Not our evidence' }] } });
    assert.equal(invalid.accepted, true); assert.equal(invalid.result.status, 'partial'); assert.equal(invalid.result.pending.length, 1);
  } finally { await f.stop(); }
});

test('empty review correction happens once across restore and genuine evidence gaps settle partially', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), reviewer: any = await f.add(new Reviewer()); reviewer.agentAbjectId = caller.id;
    const records = [{ taskId: 'worker', predictions: [{ step: 1, expect: 'Full diff', outcome: 'success', actual: 'Preview only' }] }];
    reviewer.taskExtras.set('review', { kind: 'review', records });
    assert.equal((await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: 'No lessons' })).accepted, false);
    const snapshot = await caller.call(reviewer.id, 'snapshotTask', { taskId: 'review' });
    reviewer.taskExtras.delete('review');
    await caller.call(reviewer.id, 'restoreTask', { taskId: 'review', snapshot });
    const partial = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: 'No lessons' });
    assert.equal(partial.accepted, true); assert.equal(partial.result.status, 'partial'); assert.equal(partial.result.predictions.unresolved, 1);
    reviewer.taskExtras.set('gap', { kind: 'review', records });
    const gap = await caller.call(reviewer.id, 'completeReview', { taskId: 'gap', result: { unresolvedReason: 'The retained output is unavailable' } });
    assert.equal(gap.accepted, true); assert.equal(gap.result.status, 'partial'); assert.match(gap.result.limitations[0], /unavailable/);
    const repeated = await caller.call(reviewer.id, 'completeReview', { taskId: 'gap', result: gap.result });
    assert.deepEqual(repeated.result.limitations, gap.result.limitations, 'runtime acceptance checks preserve recorded limitations');
  } finally { await f.stop(); }
});

test('cancelling a completion batch stops subsequent learning messages', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Endpoint('KnowledgeBase')), goals = await f.add(new Endpoint('GoalManager'));
    const reviewer: any = await f.add(new Reviewer()); reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id; reviewer.goalManagerId = goals.id;
    let release!: () => void, started!: () => void, calls = 0;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    goals.on('recordPredictionAssessment', async msg => { calls++; started(); await gate; return { success: true, assessment: { verdict: (msg.payload as any).verdict } }; });
    const predictions = [1, 2].map(step => ({ step, expect: 'full page', outcome: 'success' }));
    reviewer.taskExtras.set('review', { kind: 'review', goalId: 'goal', records: [{ taskId: 'worker', predictions }] });
    const completion = caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: { assessments: predictions.map(p => ({ taskId: 'worker', step: p.step, verdict: 'unresolved', explanation: 'Output unavailable' })) } });
    await entered; await caller.call(reviewer.id, 'taskCancelled', { taskId: 'review' }); release();
    const result = await completion;
    assert.equal(calls, 1); assert.equal(result.accepted, true); assert.equal(result.result.interrupted, true); assert.equal(result.result.status, 'partial');
  } finally { await f.stop(); }
});


test('requested pages preserve escaped text verbatim, including small pages and partial failure output', () => {
  const runtime: any = new Runtime();
  const text = '"quoted"\n'.repeat(800);
  assert(text.length < 8000 && JSON.stringify(text).length > 8000);
  for (const success of [true, false]) {
    const entry: any = { state: { action: { action: 'read_output' }, llmMessages: [], lastResult: { success, error: success ? undefined : 'partial read', data: { nextOffset: text.length }, payload: text, payloadMode: 'page' } } };
    runtime.absorbResultPayload(entry); runtime.addActionResultToConversation(entry);
    assert(entry.state.llmMessages.at(-1).content.includes(text));
  }
  const oversized = { state: { action: { action: 'read_output' }, llmMessages: [], lastResult: { success: true, payload: 'a'.repeat(31000) + 'NOT_YET_SHOWN', payloadMode: 'page' } } };
  runtime.absorbResultPayload(oversized); runtime.addActionResultToConversation(oversized);
  const shown = (oversized.state.llmMessages.at(-1) as any).content;
  assert(!shown.includes('NOT_YET_SHOWN')); assert.match(shown, /characters remain/);
});
