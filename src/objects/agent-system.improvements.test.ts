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
    assert.match((await act({ action: 'read_output', id: output.id })).data.text, /complete retained/);
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
    assert.equal(prediction.patterns[0].revision, 2); assert(prediction.predictedAt <= prediction.observedAt);
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
