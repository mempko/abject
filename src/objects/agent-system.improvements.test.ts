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
import { ScrumMaster } from './scrum-master.js';

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
class Scrum extends ScrumMaster { protected override async onInit(): Promise<void> {} }

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

test('commit-only completion reports current baseline tests and declared bash checks reuse evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'abject-commit-evidence-')), f = await fixture();
  try {
    await writeFile(path.join(dir, 'source.ts'), 'existing uncommitted change');
    const caller = await f.add(new Endpoint('AgentAbject'));
    await f.add(new HostFileSystem({ allowedPaths: [dir], readOnly: true }));
    const projects: any = await f.add(new Projects()), creator: any = await f.add(new Creator());
    creator.agentAbjectId = caller.id;
    const project = { name: 'fixture', root: dir, trusted: true, vcs: 'none', checkCommand: 'check', verifyCommand: 'tests', isolation: 'none', protectedPaths: [], autonomy: 'full' };
    projects.projects.set(project.name, project);
    const shell = await f.add(new Endpoint('ShellExecutor'));
    const counts: Record<string, number> = {};
    let exitCode = 0;
    shell.on('exec', msg => {
      const { command } = msg.payload as any;
      assert.equal(msg.routing.from, creator.id);
      counts[command] = (counts[command] ?? 0) + 1;
      return { stdout: command === 'tests' ? 'ℹ tests 195\nℹ pass 195\nℹ fail 0\n' : '', stderr: '', exitCode };
    });
    const extra: any = { taskId: 'commit-review', taskText: 'Review and commit existing changes', project, workRoot: dir, filesRead: new Set(), filesModified: new Set(), preImages: new Map(), postImages: new Map(), instructionDirsSeen: new Set(), mutationsSinceVerify: 0, checkpoints: [], audit: [], decisions: [], editSetOpen: false };
    creator.taskExtras.set(extra.taskId, extra);
    await creator.captureBaseline(extra); await extra.verifyBaseline.promise;
    const complete = () => caller.call(creator.id, 'candidateComplete', { taskId: extra.taskId, result: 'Created a commit from the existing changes.' });
    const first = await complete();
    assert.equal(first.accepted, true);
    assert.match(first.result, /tests: exit 0; tests: 195 passed, 0 failed, 195 total; applies to the current project inputs/);
    assert.doesNotMatch(first.result, /No files were changed/);
    const act = (action: unknown) => caller.call(creator.id, 'agentAct', { taskId: extra.taskId, action });
    for (const command of ['check', 'tests']) {
      const reused = await act({ action: 'bash', command });
      assert.equal(reused.success, true); assert.equal(reused.data.reused, true);
      assert.equal(counts[command], 1);
    }
    await act({ action: 'bash', command: 'tests', force: true });
    assert.equal(counts.tests, 2);
    // Only exact declared checks are eligible; shell command equivalence is not guessed.
    await act({ action: 'bash', command: 'tests && check' });
    assert.equal(counts['tests && check'], 1);
    await writeFile(path.join(dir, 'source.ts'), 'concurrent change');
    assert.equal((await complete()).accepted, false, 'a recorded verify cannot claim newer inputs');
    const rerun = await act({ action: 'bash', command: 'tests' });
    assert.equal(rerun.data.reused, false); assert.equal(counts.tests, 3);
    exitCode = 1;
    assert.equal((await act({ action: 'bash', command: 'tests', force: true })).success, false);
    assert.equal((await act({ action: 'bash', command: 'tests' })).data.reused, false, 'a failed rerun prevents reuse of an older pass');
    // An untouched task may report a failing baseline, but never describe it as a pass.
    extra.lastVerify = undefined; extra.lastCheck = undefined;
    extra.filesModified.clear(); extra.unknownEffects = false; extra.mutationsSinceVerify = 0;
    extra.baseline.verify = { ...extra.baseline.verify, exitCode: 1, testSummary: { tests: 195, passed: 194, failed: 1 } };
    const historical = await complete();
    assert.match(historical.result, /194 passed, 1 failed/);
    assert.match(historical.result, /historical result; current coverage is not established/);
  } finally { await f.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('review prioritizes stale task claims over profiles and corrects knowledge in the completion batch', async () => {
  const f = await fixture();
  try {
    const storage = new Endpoint('Storage'); storage.on('set', () => true); storage.on('get', () => null); storage.on('keys', () => []); await f.add(storage);
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Knowledge()), goals = await f.add(new GoalManager());
    const reviewer: any = await f.add(new Reviewer());
    reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id; reviewer.goalManagerId = goals.id;
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Review repository', description: 'Commit changes' });
    const stale = await caller.call(kb.id, 'remember', { title: 'Repository has no test script', content: 'No test runner is available.', type: 'fact', origin: 'agent' });
    const duplicate = await caller.call(kb.id, 'remember', { title: 'Repository tests unavailable', content: 'No tests exist.', type: 'fact', origin: 'agent' });
    const user = await caller.call(kb.id, 'remember', { title: 'User preference', content: 'Preserve my preference.', type: 'fact', origin: 'user' });
    const runtime: any = await f.add(new Runtime());
    const entry: any = { state: { id: 'injected', task: 'Repository test script' }, config: { terminalActions: {}, intermediateActions: [] } };
    const prompt = await runtime.initializeConversation(entry);
    const shown = entry.injectedKnowledge.find((k: any) => k.id === stale.id);
    assert.equal(shown.source, 'relevant'); assert.equal(shown.content, 'No test runner is available.');
    assert(prompt.some((m: any) => m.content.includes(shown.content)));
    const profiles = Array.from({ length: 15 }, (_, i) => ({ id: `profile-${i}`, title: `Unrelated profile ${i}`, content: 'Not relevant to this task', source: 'profile' }));
    const record = { taskId: 'worker', agentName: 'ExternalCreator', task: 'Review repository', phase: 'done', steps: 1, transcript: '',
      result: 'Owner verification: tests: exit 0; tests: 195 passed, 0 failed, 195 total; applies to current inputs.',
      predictions: [{ step: 1, action: 'verify', expect: 'The test script is missing', outcome: 'success', actual: '195 tests passed' }],
      injectedKnowledge: [...profiles, { id: stale.id, title: 'Repository has no test script', content: 'No test runner is available.', source: 'relevant' }],
    };
    const dossier = await reviewer.buildLearningDossier('Review repository', 'context'.repeat(20000), [record]);
    assert(dossier.length <= 40000);
    assert.match(dossier, /No test runner is available/);
    assert.match(dossier, /195 passed/);
    assert(dossier.indexOf(stale.id) < dossier.indexOf('Unrelated profile'), 'task claims precede always-injected profile entries');
    await caller.call(goals.id, 'recordTaskEvidence', { goalId, taskId: record.taskId, record });
    reviewer.taskExtras.set('reconcile', { kind: 'review', goalId, records: [record] });
    reviewer.taskExtras.get('reconcile').knowledgeRefs = Object.fromEntries(await Promise.all([stale, duplicate, user].map(async ({id}) => [id, (await caller.call(kb.id, 'get', {id})).knowledgeRef])));
    const result = {
      assessments: [{ taskId: 'worker', step: 1, verdict: 'contradicted', explanation: 'The registered test script ran 195 tests successfully.' }],
      knowledgeUpdates: [
        { action: 'update_entry', id: stale.id, title: 'Repository test script verified', content: 'The registered test script passed 195 tests in the reviewed workspace. Evidence: worker step 1. Recheck current project configuration on later runs.', evidence: 'worker step 1 and owner completion evidence' },
        { action: 'archive_entry', id: duplicate.id, evidence: 'Obsolete duplicate contradicted by worker step 1' },
      ],
    };
    const done = await caller.call(reviewer.id, 'completeReview', { taskId: 'reconcile', result });
    assert.equal(done.accepted, true); assert.equal(done.result.status, 'complete');
    assert.equal(done.result.saved.length, 3);
    assert.equal(done.result.patterns.helpful, 0, 'correcting facts does not invent pattern applications');
    assert.equal((await caller.call(kb.id, 'get', { id: stale.id })).title, 'Repository test script verified');
    assert.equal((await caller.call(kb.id, 'get', { id: duplicate.id })).archived, true);
    const active = await caller.call(kb.id, 'recall', { query: 'Repository', limit: 10 });
    assert(!active.some((e: any) => e.id === duplicate.id));
    assert.equal(shown.content, 'No test runner is available.', 'historical injection is preserved after correction');
    const snapshot = await caller.call(reviewer.id, 'snapshotTask', { taskId: 'reconcile' });
    reviewer.taskExtras.delete('reconcile');
    await caller.call(reviewer.id, 'restoreTask', { taskId: 'reconcile', snapshot });
    await caller.call(reviewer.id, 'completeReview', { taskId: 'reconcile', result });
    const replay = await caller.call(reviewer.id, 'snapshotTask', { taskId: 'reconcile' });
    assert.equal(replay.decisions.flatMap((d: any) => d.effects).filter((e: any) => e.state === 'applied').length, 2, 'completed corrections are not replayed after restoration');
    const protectedWrite = await caller.call(reviewer.id, 'completeReview', { taskId: 'reconcile', result: {
      knowledgeUpdates: [{ action: 'update_entry', id: user.id, content: 'Overwritten', evidence: 'Claimed contradiction' }],
    } });
    assert.equal(protectedWrite.accepted, true); assert.equal(protectedWrite.result.status, 'partial');
    assert.equal(protectedWrite.result.pending.length, 1);
    assert.equal((await caller.call(kb.id, 'get', { id: user.id })).content, 'Preserve my preference.');
  } finally { await f.stop(); }
});

test('cancellation during knowledge ownership lookup prevents the following mutation', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), kb = await f.add(new Endpoint('KnowledgeBase'));
    const reviewer: any = await f.add(new Reviewer()); reviewer.agentAbjectId = caller.id; reviewer.knowledgeBaseId = kb.id;
    let writes = 0;
    for (const method of ['update', 'archive', 'forget']) kb.on(method, () => { writes++; return { success: true }; });
    for (const action of ['update_entry', 'archive_entry', 'forget_entry']) {
      let release!: () => void, started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      kb.on('get', async () => { started(); await gate; return { origin: 'agent' }; });
      reviewer.taskExtras.set(action, { kind: 'review', records: [] });
      const pending = caller.call(reviewer.id, 'agentAct', { taskId: action, action: { action, id: 'fact', content: 'new claim' } });
      await began;
      await caller.call(reviewer.id, 'taskCancelled', { taskId: action });
      release();
      assert.equal((await pending).success, false);
    }
    assert.equal(writes, 0);
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
    assert.equal(repeat.success, false); assert.equal(repeat.conflict, true); assert.equal(repeat.assessment.verdict, 'contradicted');
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


test('runtime actions retain complete observations and automatic pattern provenance through the bus', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
    const goals = await f.add(new GoalManager()), kb = await f.add(new Knowledge());
    runtime.goalManagerId = goals.id;
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Read retained evidence', description: 'Review a large diff' });
    const { id } = await caller.call(kb.id, 'remember', { type: 'pattern', title: 'READ WHOLE DIFF', content: 'Read every diff section before deciding.' });
    const actions = [
      { action: 'recall', pattern: 'READ WHOLE DIFF', expect: 'Find a relevant reading pattern' },
      { action: 'read_chunk', id: 'res-1', offset: 0, length: 30000, expect: 'Read the first diff section', patterns: [{ id, why: 'Inspect the complete diff', revision: 999 }] },
      { action: 'read_chunk', id: 'res-1', offset: 30000, length: 10000, expect: 'Read the remaining diff' },
      { action: 'remember', title: 'Reviewed files', content: 'Both sections were read.', expect: 'Save the observation' },
      { action: 'replan', reason: 'The second section changes the review plan', expect: 'Record the changed understanding' },
      { action: 'reply', text: 'Review is progressing', expect: 'Send a progress update' },
      { action: 'done', result: 'Reviewed both sections' },
    ];
    let thinks = 0, entry: any;
    const payload = 'a'.repeat(29990) + 'FIRST-END!' + 'b'.repeat(9990) + 'FINAL-END!';
    runtime.think = async (current: any) => {
      entry = current;
      if (thinks === 0) runtime.storePayload(entry, payload, 'result');
      if (thinks === 1) {
        assert.equal(entry.patternSelections[id], JSON.stringify([id, 1]), 'match selections carry receiver-owned receipts');
        await caller.call(kb.id, 'update', { id, content: 'Read the diff and its tests.', expectedRevision: 1 });
      }
      assert(thinks < actions.length, 'no extra model turns are needed for recording');
      return { ...actions[thinks++], expectOutcome: 'success' };
    };
    let finish!: (value: any) => void;
    const finished = new Promise<any>(resolve => { finish = resolve; });
    caller.on('taskResult', msg => { finish(msg.payload); });
    caller.on('agentObserve', () => ({ observation: 'Continue' }));
    await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { directExecution: true, skipFirstObservation: true, maxSteps: 12, intermediateActions: ['reply'] } });
    await caller.call(runtime.id, 'startTask', { taskId: 'runtime-evidence', task: 'Read and review the diff', goalId });
    assert.equal((await finished).success, true);
    const transcript = await caller.call(runtime.id, 'getTaskTranscript', { taskId: 'runtime-evidence' });
    assert.deepEqual(transcript.predictions.map((p: any) => p.step), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(transcript.predictions.map((p: any) => p.action), actions.slice(0, -1).map(a => a.action));
    for (const prediction of transcript.predictions) {
      assert.equal(prediction.outcome, 'success');
      assert.equal(prediction.semanticVerdict, 'unresolved');
      const key = `learning/observation/runtime-evidence:${prediction.step}`;
      const before = await caller.call(goals.id, 'readGoalData', { goalId, key: `${key}:prediction` });
      const after = await caller.call(goals.id, 'readGoalData', { goalId, key });
      assert.equal(before.expect, prediction.expect);
      assert(before.predictedAt <= after.observedAt);
      if (prediction.step === 2) assert(JSON.parse(after.actual).data.text.includes(payload.slice(0, 30000)), 'full evidence survives the preview limit');
      if (prediction.step === 3) assert(JSON.parse(after.actual).data.text.includes(payload.slice(30000)));
    }
    assert.equal(entry.payloads.length, 1, 'learning observations do not consume payload cache slots');
    assert(entry.state.llmMessages.some((m: any) => typeof m.content === 'string' && m.content.includes(payload.slice(0, 30000))));
    const history = await caller.call(kb.id, 'patternHistory', { id });
    assert.equal(history.applications.length, 1, 'retrieval alone is not an application');
    assert.equal(history.applications[0].patternRevision, 1, 'application refers to the version selected before revision');
    assert.equal(history.applications[0].verdict, 'applied', 'usefulness requires reviewer feedback');
    assert(transcript.predictions[1].patterns[0].applicationRef);
  } finally { await f.stop(); }
});

test('runtime evidence distinguishes failed actions, empty searches, and failed job envelopes', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
    const kb = await f.add(new Endpoint('KnowledgeBase')), jobs = await f.add(new Endpoint('JobManager'));
    kb.on('remember', () => ({ success: false, error: 'Write rejected' }));
    kb.on('get', () => null);
    jobs.on('submitJob', () => ({ status: 'cancelled', error: 'Job cancelled by owner' }));
    const actions = [
      { action: 'read_chunk', id: 'missing', expectOutcome: 'failure' },
      { action: 'read_chunk', id: 'res-1', offset: -1, expectOutcome: 'failure' },
      { action: 'read_chunk', id: 'res-1', offset: 3, expectOutcome: 'failure' },
      { action: 'read_chunk', id: 'res-1', grep: 'absent', expectOutcome: 'success' },
      { action: 'recall', expectOutcome: 'failure' },
      { action: 'recall', id: 'absent', expectOutcome: 'success' },
      { action: 'remember', content: 'Will be rejected', expectOutcome: 'failure' },
      { action: 'submit_job', code: '', expectOutcome: 'failure' },
      { action: 'submit_job', code: 'return 1', expectOutcome: 'failure' },
      { action: 'done', result: 'Checked errors' },
    ];
    let thinks = 0;
    runtime.think = async (entry: any) => {
      if (thinks === 0) runtime.storePayload(entry, 'abc', 'result');
      assert(thinks < actions.length);
      return { expect: 'Observe the documented operation status', ...actions[thinks++] };
    };
    let finish!: (value: any) => void;
    const finished = new Promise<any>(resolve => { finish = resolve; });
    caller.on('taskResult', msg => { finish(msg.payload); });
    await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { directExecution: true, skipFirstObservation: true, maxSteps: 15 } });
    await caller.call(runtime.id, 'startTask', { taskId: 'runtime-errors', task: 'Check runtime failure results' });
    assert.equal((await finished).success, true);
    const { predictions } = await caller.call(runtime.id, 'getTaskTranscript', { taskId: 'runtime-errors' });
    assert.equal(predictions.length, actions.length - 1);
    assert.deepEqual(predictions.map((p: any) => p.outcome), actions.slice(0, -1).map(a => a.expectOutcome));
    assert(predictions.every((p: any) => p.verdict === 'supported'));
    assert.match(predictions[6].actual, /Write rejected/);
    assert.match(predictions[7].actual, /non-empty code/);
    assert.match(predictions[8].actual, /Job cancelled by owner/);
  } finally { await f.stop(); }
});

test('cancellation during a runtime memory call keeps an unknown outcome and stops subsequent actions', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
    const kb = await f.add(new Endpoint('KnowledgeBase'));
    let release!: (value: unknown) => void, started!: () => void, finish!: (value: any) => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const finished = new Promise<any>(resolve => { finish = resolve; });
    kb.on('remember', () => { started(); return new Promise(resolve => { release = resolve; }); });
    caller.on('taskResult', msg => { finish(msg.payload); });
    let thinks = 0;
    runtime.think = async () => { thinks++; return { action: 'remember', content: 'Interrupted write', expect: 'Save a fact', expectOutcome: 'success' }; };
    await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { directExecution: true, skipFirstObservation: true, maxSteps: 5 } });
    await caller.call(runtime.id, 'startTask', { taskId: 'runtime-cancel', task: 'Save a fact' });
    await began;
    await caller.call(runtime.id, 'cancelTask', { taskId: 'runtime-cancel' });
    release({ id: 'saved-after-cancel' });
    assert.equal((await finished).success, false);
    const { predictions } = await caller.call(runtime.id, 'getTaskTranscript', { taskId: 'runtime-cancel' });
    assert.equal(thinks, 1);
    assert.equal(predictions.length, 1);
    assert.equal(predictions[0].expect, 'Save a fact');
    assert.equal(predictions[0].outcome, 'unknown');
    assert.equal(predictions[0].verdict, 'unresolved');
  } finally { await f.stop(); }
});

test('runtime captures application receipts before acting and reviewer settles partial learning without inventing revisions', async () => {
  const f = await fixture();
  try {
    const storage = new Endpoint('Storage'); storage.on('set', () => true); storage.on('get', () => null); storage.on('keys', () => []); await f.add(storage);
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
    const storage = new Endpoint('Storage'); storage.on('set', () => true); storage.on('get', () => null); storage.on('keys', () => []); await f.add(storage);
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
    let release!: () => void, started!: () => void, calls = 0, knowledgeCalls = 0;
    kb.on('get', () => { knowledgeCalls++; return { origin: 'agent' }; });
    kb.on('update', () => { knowledgeCalls++; return { success: true }; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    goals.on('recordPredictionAssessment', async msg => { calls++; started(); await gate; return { success: true, assessment: { verdict: (msg.payload as any).verdict } }; });
    const predictions = [1, 2].map(step => ({ step, expect: 'full page', outcome: 'success' }));
    reviewer.taskExtras.set('review', { kind: 'review', goalId: 'goal', records: [{ taskId: 'worker', predictions }] });
    const completion = caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: {
      assessments: predictions.map(p => ({ taskId: 'worker', step: p.step, verdict: 'unresolved', explanation: 'Output unavailable' })),
      knowledgeUpdates: [{ action: 'update_entry', id: 'fact', content: 'Updated claim', evidence: 'worker step 1' }],
    } });
    await entered; await caller.call(reviewer.id, 'taskCancelled', { taskId: 'review' }); release();
    const result = await completion;
    assert.equal(calls, 1); assert.equal(result.accepted, true); assert.equal(result.result.interrupted, true); assert.equal(result.result.status, 'partial');
    assert.equal(knowledgeCalls, 0, 'cancellation also stops the following knowledge corrections');
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

test('long reviews expose final predictions and request one correction for partial assessment batches', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('AgentAbject')), goals = await f.add(new GoalManager());
    const reviewer: any = await f.add(new Reviewer()); Object.assign(reviewer, { agentAbjectId: caller.id, goalManagerId: goals.id });
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Review changes', description: 'Verify and commit' });
    const predictions = Array.from({ length: 25 }, (_, i) => ({ step: i + 1, action: 'verify', expect: i === 23 ? '218 tests will pass' : `Expectation ${i + 1}: ${'context '.repeat(500)}`, actual: i === 23 ? '231 tests passed' : `Observation ${i + 1}: ${'evidence '.repeat(250)}`, outcome: 'success' }));
    const record = { taskId: 'worker', agentName: 'Worker', phase: 'done', predictions, injectedKnowledge: [], transcript: 'context'.repeat(10000) };
    await caller.call(goals.id, 'recordTaskEvidence', { goalId, taskId: 'worker', record });
    reviewer.taskExtras.set('review', { kind: 'review', goalId, records: [record] });
    const dossier = await reviewer.buildLearningDossier('Review', record.transcript, [record]);
    assert(dossier.length <= 40000);
    for (const p of predictions) assert(dossier.includes(`worker step ${p.step}:`), `step ${p.step} must have an index row`);
    assert.match(dossier, /218 tests will pass/); assert.match(dossier, /231 tests passed/);
    const first = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: { assessments: predictions.slice(0, 22).map(p => ({ taskId: 'worker', step: p.step, verdict: 'supported', explanation: 'Observed result agrees with this expectation' })) } });
    assert.equal(first.accepted, false); assert.match(first.reason, /3 predictions/);
    for (const step of [23, 24, 25]) assert(first.reason.includes(`worker step ${step}:`));
    assert(!first.reason.includes('worker step 1:'));
    const done = await caller.call(reviewer.id, 'completeReview', { taskId: 'review', result: { assessments: predictions.slice(22).map(p => ({ taskId: 'worker', step: p.step, verdict: p.step === 24 ? 'contradicted' : 'unresolved', explanation: p.step === 24 ? 'Expected 218 but observed 231 passing tests' : 'The excerpt does not establish all details' })) } });
    assert.equal(done.accepted, true); assert.equal(done.result.predictions.total, 25);
    assert.equal(done.result.predictions.contradicted, 1); assert.equal(done.result.predictions.unresolved, 2);
    assert.equal(done.result.predictions.unassessed.length, 0);
  } finally { await f.stop(); }
});

test('older observed output pages become retrievable references without compression calls', async () => {
  const f = await fixture();
  try {
    const llm = await f.add(new Endpoint('LLM')); let compressions = 0;
    llm.on('compress', () => { compressions++; throw new Error('Unexpected compression'); });
    const runtime: any = await f.add(new Runtime());
    const entry: any = { state: { llmMessages: [{ role: 'system', content: 'Review every page' }] }, config: { maxConversationMessages: 200, pinnedMessageCount: 1 } };
    for (let i = 0; i < 15; i++) {
      const text = `PAGE-${i}\n${'diff details\n'.repeat(2200)}`;
      entry.state.action = { action: 'read_output', id: 'source-output', offset: i * 30000, expect: 'The requested page is visible' };
      entry.state.lastResult = { success: true, data: { nextOffset: (i + 1) * 30000 }, payload: text, payloadMode: 'page' };
      runtime.absorbResultPayload(entry); runtime.addActionResultToConversation(entry);
      await runtime.trimConversation(entry);
      assert(entry.state.llmMessages.at(-1).content.includes(text), 'newly requested pages reach the model whole');
      runtime.markConversationObserved(entry);
      entry.state.llmMessages.push({ role: 'assistant', content: `Reviewed page ${i}; finding: preserve this reasoning` });
    }
    assert.equal(compressions, 0);
    assert(entry.state.llmMessages.some((m: any) => m.content.includes('[Page body omitted from active context.]')));
    assert(entry.state.llmMessages.some((m: any) => m.content.includes('Reviewed page 0; finding: preserve this reasoning')));
    const held = entry.payloads[0]; assert.match(runtime.readChunk(entry, { id: held.id }), /diff details/);
    assert(entry.state.llmMessages.reduce((n: number, m: any) => n + m.content.length, 0) < 140000);
  } finally { await f.stop(); }
});

test('registered project scope follows task switches and goal evidence without accepting foreign updates', async () => {
  const f = await fixture();
  try {
    const owner = await f.add(new Endpoint('ExternalCreator')), outsider = await f.add(new Endpoint('Unrelated'));
    const projects: any = await f.add(new Projects());
    projects.projects.set('first', { name: 'first', root: '/tmp/first' }); projects.projects.set('second', { name: 'second', root: '/tmp/second' });
    const runtime: any = await f.add(new Runtime());
    const entry: any = { agentId: owner.id, state: { id: 'work', task: 'Review repository', llmMessages: [] }, config: { knowledgeScope: 'project:first', terminalActions: {}, intermediateActions: [] } };
    runtime.taskEntries.set('work', entry);
    await assert.rejects(outsider.call(runtime.id, 'setTaskProject', { taskId: 'work', name: 'second' }), /Only the active task agent/);
    await assert.rejects(owner.call(runtime.id, 'setTaskProject', { taskId: 'work', name: 'missing' }), /Registered project unavailable/);
    const switched = await owner.call(runtime.id, 'setTaskProject', { taskId: 'work', name: 'second', systemPrompt: 'Second project instructions' });
    assert.equal(switched.knowledgeScope, 'project:second'); assert.equal(entry.refreshKnowledgePrompt, true);
    assert.deepEqual(entry.knowledgeScopes, ['project:first', 'project:second']);
    const kb = await f.add(new Endpoint('KnowledgeBase')); const scopes: string[] = [];
    kb.on('recall', msg => { scopes.push((msg.payload as any).scope); return []; }); kb.on('weave', msg => { scopes.push((msg.payload as any).scope); return { patterns: [] }; }); kb.on('listTags', () => []);
    await runtime.initializeConversation(entry);
    assert.deepEqual(scopes, ['project:second', 'project:second', 'project:second']);
    const reviewer: any = await f.add(new Reviewer());
    assert.equal(reviewer.reviewScope([{ knowledgeScope: 'project:second' }]), 'project:second');
    assert.equal(reviewer.reviewScope([{ knowledgeScopes: entry.knowledgeScopes }]), undefined, 'multi-project evidence has no guessed common scope');
    const goals = await f.add(new Endpoint('GoalManager')), scrum: any = await f.add(new Scrum()); scrum.goalManagerId = goals.id;
    let goal: any = { title: 'Review first', description: 'Commit changes', scratchpad: {} }; goals.on('getGoal', () => goal);
    assert.equal(await scrum.knowledgeScopeForGoal('goal'), 'project:first');
    goal = { title: 'Review work', scratchpad: { 'learning/task/work': { knowledgeScope: 'project:second' } } };
    assert.equal(await scrum.knowledgeScopeForGoal('goal'), 'project:second');
    goal.scratchpad['learning/task/work'].knowledgeScopes = ['project:first', 'project:second'];
    assert.equal(await scrum.knowledgeScopeForGoal('goal'), undefined);
  } finally { await f.stop(); }
});
