import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
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
import { ScrumMaster } from './scrum-master.js';
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
class Scrum extends ScrumMaster { protected override async onInit(): Promise<void> {} }
class Reviewer extends TaskReviewer { protected override async onInit(): Promise<void> {} }

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  return { async add<T extends Abject>(o: T): Promise<T> {
    o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  }, async stop() { for (const o of objects.reverse()) await o.stop(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert(predicate()); }

test('live logs and runtime state do not invalidate verification; source edits and explicitly included files do', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'abject-verification-'));
  const f = await fixture();
  try {
    await mkdir(path.join(dir, '.abjects')); await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, '.gitignore'), '*.log\n.abjects/\ndist/\n');
    await writeFile(path.join(dir, 'source.ts'), 'original');
    await writeFile(path.join(dir, 'app.log'), 'started');
    await writeFile(path.join(dir, '.abjects', 'state.json'), '{}');
    await writeFile(path.join(dir, 'dist', 'generated.js'), 'one');
    const caller = await f.add(new Endpoint('AgentAbject'));
    const host = await f.add(new HostFileSystem({ allowedPaths: [dir], readOnly: true }));
    const projects: any = await f.add(new Projects());
    const project = { name: 'fixture', root: dir, trusted: true, vcs: 'none', checkCommand: 'check', verifyCommand: 'verify', isolation: 'none', protectedPaths: [] };
    projects.projects.set('fixture', project);
    let generation = 0, failing = false;
    const shell = new Endpoint('ShellExecutor');
    shell.on('exec', async m => {
      const command = (m.payload as any).command;
      await appendFile(path.join(dir, 'app.log'), `\nrequest ${++generation}`);
      await writeFile(path.join(dir, '.abjects', 'state.json'), JSON.stringify({ generation }));
      await writeFile(path.join(dir, 'dist', 'generated.js'), String(generation));
      if (command === 'edit') await writeFile(path.join(dir, 'source.ts'), 'edited');
      return { stdout: 'check output', stderr: failing ? 'source.ts: failure' : '', exitCode: failing ? 1 : 0 };
    });
    await f.add(shell);
    const creator: any = await f.add(new Creator()); creator.agentAbjectId = caller.id;
    const extra = { taskId: 'review', taskText: 'review and commit', project, workRoot: dir, filesRead: new Set(), filesModified: new Set(),
      preImages: new Map(), postImages: new Map(), instructionDirsSeen: new Set(), mutationsSinceVerify: 0, checkpoints: [], audit: [], decisions: [], editSetOpen: false };
    creator.taskExtras.set('review', extra);
    const before = await creator.projectRevision(extra);
    const act = (action: unknown) => caller.call(creator.id, 'agentAct', { taskId: 'review', action });
    const complete = () => caller.call(creator.id, 'candidateComplete', { taskId: 'review', result: 'Reviewed changes.' });
    assert.equal((await act({ action: 'bash', command: 'edit' })).success, true);
    assert.equal((await complete()).accepted, false);
    assert.equal((await act({ action: 'verify', full: true })).success, true);
    assert.equal((await complete()).accepted, true);
    const verified = await creator.projectRevision(extra);
    assert.notEqual(verified.revision, before.revision);
    assert.equal((await act({ action: 'bash', command: 'git status' })).success, true);
    assert.equal((await complete()).accepted, true, 'read-only commands and logs preserve evidence');
    assert.equal((await creator.projectRevision(extra)).revision, verified.revision);
    assert.equal(extra.mutationsSinceVerify, 0);
    const observation = await caller.call(creator.id, 'agentObserve', { taskId: 'review', step: 3 });
    assert.doesNotMatch(observation.observation, /check output/, 'tool results are not duplicated into the next observation');
    await writeFile(path.join(dir, 'source.ts'), 'concurrent edit');
    assert.equal((await complete()).accepted, false, 'a later source change is explained');
    assert.equal((await act({ action: 'bash', command: 'verify' })).success, true);
    assert.equal((await complete()).accepted, true, 'declared commands count when invoked through bash');
    failing = true; await act({ action: 'verify', full: true, force: true });
    assert.equal((await complete()).accepted, false, 'actual failed checks are not presented as passes');
    const scoped = await caller.call(host.id, 'snapshotTree', { root: dir, scope: 'project' });
    assert.equal(scoped.files['app.log'], undefined); assert.equal(scoped.files['dist/generated.js'], undefined);
    const explicit = await caller.call(host.id, 'snapshotTree', { root: dir, scope: 'project', includePaths: ['dist/generated.js'] });
    assert(explicit.files['dist/generated.js']);
    await rm(path.join(dir, 'dist'), { recursive: true });
    const deleted = await caller.call(host.id, 'snapshotTree', { root: dir, scope: 'project', includePaths: ['dist/generated.js'] });
    assert.equal(deleted.complete, true); assert.equal(deleted.files['dist/generated.js'], undefined);
    await assert.rejects(caller.call(host.id, 'snapshotTree', { root: dir, scope: 'project', includePaths: ['../outside'] }), /Included path/);
    assert.equal((await caller.call(host.id, 'snapshotTree', { root: dir, maxFiles: 1 })).complete, false);
  } finally { await f.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('successful commands with limited snapshot coverage finish with an explicit limitation', async () => {
  const creator: any = new Creator();
  const verdict = creator.judge({ command: 'verify', exitCode: 0, stable: false, revision: 'after', snapshotNote: 'Snapshot coverage was incomplete: file limit reached.', signatures: [], at: 1, output: '' });
  assert.equal(verdict.passed, true); assert.equal(verdict.inconclusive, undefined);
  assert.match(creator.renderVerdict(verdict), /exited 0.*passed/);
  assert.match(creator.renderVerdict(verdict), /limitation.*coverage/);
  assert.doesNotMatch(creator.renderVerdict(verdict), /command failed/);
  creator.agentAbjectId = 'runtime';
  creator.verificationSnapshot = async () => ({ complete: false, issues: ['File limit reached'] });
  creator.taskExtras.set('task', { filesModified: new Set(['a.ts']), project: { verifyCommand: 'verify' }, lastVerify: verdict, mutationsSinceVerify: 0 });
  const result = await creator.handlers.get('candidateComplete')({ routing: { from: 'runtime' }, payload: { taskId: 'task', result: 'Work completed.' } });
  assert.equal(result.accepted, true); assert.match(result.result, /coverage.*incomplete/);
});

test('completion correction is bounded and preserves the unresolved report', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
    const results: any[] = []; let runs = 0;
    caller.on('taskResult', m => { results.push(m.payload); });
    caller.on('candidateComplete', () => ({ accepted: false, reason: 'Unresolved evidence' }));
    runtime.runStateMachine = async (entry: any) => { runs++; entry.state.phase = 'done'; entry.state.result = 'Existing commits are available.'; };
    await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { maxSteps: 50, completionMethod: 'candidateComplete' } });
    await caller.call(runtime.id, 'startTask', { taskId: 'bounded', task: 'review' });
    await until(() => results.length > 0);
    assert.equal(runs, 2); assert.equal(results[0].success, false);
    assert.match(results[0].error, /after one correction/); assert.match(results[0].result, /Existing commits/);
  } finally { await f.stop(); }
});

for (const action of ['submit_job', 'remember', 'done']) {
  test(`cancellation while thinking discards a late ${action} response`, async () => {
    const f = await fixture();
    try {
      const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
      const results: any[] = []; let release!: (value: unknown) => void, thinking = false, calls = 0;
      for (const name of ['JobManager', 'KnowledgeBase']) {
        const dep = new Endpoint(name);
        for (const method of ['submitJob', 'remember']) dep.on(method, () => { calls++; return { success: true }; });
        await f.add(dep);
      }
      caller.on('taskResult', m => { results.push(m.payload); });
      runtime.think = async () => { thinking = true; return await new Promise(resolve => { release = resolve; }); };
      await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { directExecution: true, skipFirstObservation: true, maxSteps: 10 } });
      await caller.call(runtime.id, 'startTask', { taskId: `cancel-${action}`, task: 'review' });
      await until(() => thinking);
      assert.equal((await caller.call(runtime.id, 'cancelTask', { taskId: `cancel-${action}` })).success, true);
      release({ action, code: 'return 1;', title: 'Do not store', content: 'Do not store', result: 'Do not accept' });
      await until(() => results.length > 0);
      assert.equal(calls, 0); assert.equal(results[0].success, false); assert.match(results[0].error, /Cancelled/);
    } finally { await f.stop(); }
  });
}

test('late scrum results for retired goals are acknowledged without replaying terminal actions', async () => {
  const f = await fixture();
  try {
    const runtime = await f.add(new Endpoint('AgentAbject')), goals = await f.add(new Endpoint('GoalManager'));
    let status: string | undefined = 'failed', calls = 0;
    goals.on('getGoal', () => status ? { status, scratchpad: {} } : null);
    const scrum: any = await f.add(new Scrum()); scrum.agentAbjectId = runtime.id; scrum.goalManagerId = goals.id;
    scrum.executeTerminalAction = async () => { calls++; throw new Error('must not replay'); };
    for (status of ['failed', 'completed', 'archived', undefined]) {
      const ticketId = `old-${status}`;
      scrum.scrumInFlight.set(ticketId, { goalId: 'retired', staged: [] });
      await runtime.call(scrum.id, 'taskResult', { ticketId, success: true, lastAction: { action: 'dispatch_scrum' } });
      assert.equal(scrum.scrumInFlight.has(ticketId), false);
    }
    assert.equal(calls, 0);
  } finally { await f.stop(); }
});

test('cancellation during completion validation cannot publish success', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new Runtime()), caller = await f.add(new Endpoint('Worker'));
    let release!: (value: unknown) => void, settling = false;
    const results: any[] = [];
    caller.on('taskResult', m => { results.push(m.payload); });
    caller.on('candidateComplete', () => new Promise(resolve => { release = resolve; settling = true; }));
    runtime.runStateMachine = async (entry: any) => { entry.state.phase = 'done'; entry.state.result = 'candidate'; };
    await caller.call(runtime.id, 'registerAgent', { name: 'Worker', config: { completionMethod: 'candidateComplete' } });
    await caller.call(runtime.id, 'startTask', { taskId: 'settling', task: 'review' });
    await until(() => settling);
    assert.equal((await caller.call(runtime.id, 'cancelTask', { taskId: 'settling' })).success, true);
    release({ accepted: true });
    await until(() => results.length > 0);
    assert.equal(results[0].success, false); assert.match(results[0].error, /Cancelled/);
  } finally { await f.stop(); }
});

test('stopping a goal does not launch an automatic learning review', async () => {
  const f = await fixture();
  try {
    const caller = await f.add(new Endpoint('Caller')), goals = await f.add(new GoalManager());
    const reviewer: any = await f.add(new Reviewer()); reviewer.goalManagerId = goals.id;
    let reviews = 0; reviewer.onGoalTerminal = async () => { reviews++; };
    const { goalId } = await caller.call(goals.id, 'createGoal', { title: 'Stop', description: 'Stop' });
    await caller.call(goals.id, 'stopGoal', { goalId });
    const pending = await caller.call(goals.id, 'pendingReviews');
    assert.equal(pending.length, 0);
    // Authenticated event from the owning goal Abject, as delivered in production.
    await (goals as any).request(request(goals.id, reviewer.id, 'goalFailed', { goalId, error: 'Stopped by user' }));
    assert.equal(reviews, 0);
  } finally { await f.stop(); }
});

test('a task writes a structured verification receipt beside its narrative report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'abject-receipt-'));
  const f = await fixture();
  try {
    await writeFile(path.join(dir, 'source.ts'), 'original');
    const caller = await f.add(new Endpoint('AgentAbject'));
    await f.add(new HostFileSystem({ allowedPaths: [dir], readOnly: true }));
    const projects: any = await f.add(new Projects());
    const project = { name: 'fixture', root: dir, trusted: true, vcs: 'none', checkCommand: 'check', verifyCommand: 'verify', isolation: 'none', protectedPaths: [] };
    projects.projects.set('fixture', project);
    const shell = new Endpoint('ShellExecutor');
    shell.on('exec', async m => {
      if ((m.payload as any).command === 'edit') await writeFile(path.join(dir, 'source.ts'), 'edited');
      return { stdout: 'ℹ tests 290\nℹ pass 290\nℹ fail 0', stderr: '', exitCode: 0 };
    });
    await f.add(shell);
    const goals = await f.add(new Endpoint('GoalManager'));
    const writes: any[] = [];
    goals.on('writeGoalData', msg => { writes.push(msg.payload); return { success: true }; });
    goals.on('readGoalData', () => null);
    const creator: any = await f.add(new Creator()); creator.agentAbjectId = caller.id; creator.goalManagerId = goals.id;
    const extra = { taskId: 'receipt', goalId: 'goal-1', taskText: 'add tests', project, workRoot: dir, filesRead: new Set(), filesModified: new Set(),
      preImages: new Map(), postImages: new Map(), instructionDirsSeen: new Set(), mutationsSinceVerify: 0, checkpoints: [], audit: [], decisions: [], editSetOpen: false };
    creator.taskExtras.set('receipt', extra);
    const act = (action: unknown) => caller.call(creator.id, 'agentAct', { taskId: 'receipt', action });
    assert.equal((await act({ action: 'bash', command: 'edit' })).success, true);
    assert.equal((await act({ action: 'verify', full: true })).success, true);
    await creator.writeSessionSummary(extra, 'Added tests.', creator.gateVerdict(extra), { success: true });
    const receipt = writes.find(w => w.key === 'verification/receipt')?.value;
    assert.ok(receipt, 'receipt written under verification/<taskId>');
    assert.equal(receipt.taskId, 'receipt');
    assert.equal(receipt.outcome, 'complete');
    assert.equal(receipt.gate.ok, true);
    assert.equal(receipt.verify.command, 'verify');
    assert.equal(receipt.verify.exitCode, 0);
    assert.equal(receipt.verify.passed, true);
    assert.equal(typeof receipt.verify.at, 'number');
    assert.deepEqual(receipt.verify.testSummary, { tests: 290, passed: 290, failed: 0 });
  } finally { await f.stop(); await rm(dir, { recursive: true, force: true }); }
});
