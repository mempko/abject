import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentAbject } from './agent-abject.js';
import { ObjectCreator } from './object-creator.js';
import { ExternalCreator } from './external-creator.js';
import { ObjectAgent } from './object-agent.js';
import { SkillAgent } from './skill-agent.js';
import { ScrumMaster } from './scrum-master.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import type { AbjectId, AbjectMessage } from '../core/types.js';

const outcome = (command = 'verify', exitCode = 0, signatures: string[] = []) => ({ command, exitCode, signatures, output: '', at: 1 });
function state(): any {
  return { taskId: 'a', taskText: 'fix', project: { name: 'a', root: '/fixture/a', trusted: true, checkCommand: 'check', verifyCommand: 'verify' }, workRoot: '/fixture/a', filesRead: new Set(), filesModified: new Set(['/fixture/a/src/a.ts']), preImages: new Map(), postImages: new Map(), instructionDirsSeen: new Set(), mutationsSinceVerify: 1, checkpoints: [], audit: [], decisions: [], editSetOpen: false };
}
function external(): any { const e: any = new ExternalCreator(); e.audit = () => {}; e.reportProgress = () => {}; e.announceFilesTouched = () => {}; return e; }
function entry(): any { return { state: { id: 'task', task: 'fix', phase: 'done', result: 'ok', step: 1, maxSteps: 5, llmMessages: [] }, agentId: 'worker', callerId: 'caller', config: { terminalActions: {} } }; }

test('fast checks cannot satisfy a distinct full verification requirement', async () => {
  const e = external(), x = state(); e.captureOutcome = async (_x: unknown, command: string) => outcome(command);
  await e.opVerify(x, { full: false });
  assert.equal(e.gateVerdict(x).ok, false);
  await e.opVerify(x, { full: true });
  assert.equal(e.gateVerdict(x).ok, true);
});
test('new failures in untouched consumers block completion on a failing baseline', () => {
  const e = external();
  assert.equal(e.judge(outcome('verify', 1, ['legacy.ts error old', 'consumer.ts error bad type']), outcome('verify', 1, ['legacy.ts error old']), ['src/api.ts']).passed, false);
});
test('different commands cannot share a failing baseline', () => {
  const e = external();
  assert.equal(e.judge(outcome('verify', 1, ['old']), outcome('check', 1, ['old'])).passed, false);
});
test('shell work invalidates verification even when no edit action ran', async () => {
  const e = external(), x = state(); x.filesModified.clear(); x.mutationsSinceVerify = 0;
  e.runCommand = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  await e.opBash(x, { command: 'generate' });
  assert.equal(e.gateVerdict(x).ok, false);
});
test('a failed shell command remains a failed action', async () => {
  const e = external(); e.runCommand = async () => ({ exitCode: 2, stdout: '', stderr: 'bad' });
  assert.equal((await e.opBash(state(), { command: 'test' })).success, false);
});
test('rollback requires a post-image and uses one conditional receiver mutation', async () => {
  const e = external(), x = state(), p = '/fixture/a/src/a.ts'; x.preImages.set(p, 'before');
  assert.equal(await e.rollback(x, p), 'unavailable');
  x.postImages.set(p, 'mine'); e.hostFs = async () => 'fs';
  e.call = async (_id: string, method: string, payload: any) => { assert.equal(method, 'conditionalWrite'); assert.equal(payload.expectedContent, 'mine'); return { success: false, conflict: true }; };
  assert.equal(await e.rollback(x, p), 'changed-by-other');
});
test('first-touch instructions stop a mutation before any write', async () => {
  const e = external(); let wrote = false;
  e.nestedInstructionsFor = async () => 'Read the package policy'; e.call = async () => { wrote = true; };
  const r = await e.opWrite(state(), { path: 'src/new.ts', content: 'new' });
  assert.equal(r.success, false); assert.match(r.error, /No file was changed/); assert.equal(wrote, false);
});
test('project switching cannot conceal unverified changes', async () => {
  const e = external(), x = state(); e.resolveProject = async () => ({ name: 'b', root: '/fixture/b' });
  const r = await e.opSetProject(x, { name: 'b' });
  assert.equal(r.success, false); assert.equal(x.project.name, 'a');
});
test('unrelated widget input does not prove target behavior', async () => {
  const o: any = new ObjectCreator(); o.resolveTarget = async () => 'unrelated'; o.sendRequest = async () => ({ success: false, error: 'rejected' }); o.mergeDiscoveryIntoDeps = () => null; o.ensureDepMethods = async () => {};
  const x: any = { deployTurn: 1, targetObjectId: 'target', draftSource: 'source', lastDeployedSource: 'source', kind: 'modify' };
  await o.opCall(x, { target: 'Other', method: 'input', payload: {} });
  assert.equal(o.gateVerdict(x).ok, false);
});
test('draft resumption needs an explicit reference and matching target identity', async () => {
  const o: any = new ObjectCreator(); o.goalManagerId = 'goals'; o.sendRequest = async () => JSON.stringify({ targetObjectId: 'a', source: 'a source' });
  const x: any = { targetObjectId: 'b', turnLog: [] };
  await o.loadPersistedDraft('goal', x, 'objectcreator:staged-draft/task-a');
  assert.equal(x.draftSource, undefined);
});
test('invalid result schema settles as failure and still notifies the ticket holder', async () => {
  const r: any = new AgentAbject(), x = entry(), notices: any[] = []; x.responseSchema = { type: 'invalid' };
  r.safeSend = (m: any) => notices.push(m); r.changed = () => {};
  await r.finalizeTask(x);
  assert.equal(x.state.phase, 'error'); assert.equal(notices.find(m => m.routing.method === 'taskResult')?.payload.success, false);
});
test('prediction verdicts support expected rejection and leave prose unresolved', () => {
  const r: any = new AgentAbject();
  for (const [expected, verdict] of [['failure', 'supported'], ['success', 'contradicted'], [undefined, 'unresolved']]) {
    const x = entry(); x.state.action = { action: 'call', expect: 'receiver rejects an invalid update', expectOutcome: expected }; x.state.lastResult = { success: false, error: 'invalid' };
    r.recordPrediction(x);
    assert.equal(x.predictions[0].verdict, verdict); assert(x.predictions[0].actualRef);
    assert.equal(!!x.predictions[0].missed, verdict === 'contradicted');
  }
});
test('different files and commands are distinct progress subjects', () => {
  const r: any = new AgentAbject(); const sig = (action: any) => r.actionSignature({ action, lastResult: { success: true } });
  assert.notEqual(sig({ action: 'read', path: 'a' }), sig({ action: 'read', path: 'b' }));
  assert.notEqual(sig({ action: 'bash', command: 'build' }), sig({ action: 'bash', command: 'test' }));
});
test('standalone tasks never inherit another task goal', async () => {
  const a: any = new ObjectAgent(); a._currentGoalId = 'other'; a.goalManagerId = 'goals'; a.taskExtras.set('standalone', {});
  a.request = async () => { throw new Error('must not send'); };
  assert.equal((await a.handleAct('standalone', { action: 'write_scratchpad', key: 'result', value: 'x' })).success, false);
});
test('MCP errors stay failed actions', async () => {
  const a: any = new SkillAgent(); a.resolveBridge = async () => ({ bridgeId: 'bridge' }); a.request = async () => ({ content: 'bad', isError: true });
  assert.equal((await a.handleAct('task', { action: 'mcp_tool_call', server: 'server', tool: 'tool' })).success, false);
});
test('Scrum Ask includes goal identity and does not reuse another goal answer', async () => {
  const s: any = new ScrumMaster(); s.agentAbjectId = 'runtime'; const questions: string[] = [];
  s.request = async (m: any) => { if (m.routing.method === 'listAgents') return [{ agentId: 'worker', name: 'Worker', description: 'current' }]; questions.push(m.payload.question); return 'I can help'; };
  await s.actPollTeam('goal-a', {}); await s.actPollTeam('goal-b', {});
  assert.equal(questions.length, 2); assert.match(questions[0], /goal-a/); assert.match(questions[1], /goal-b/);
});

class RuntimeFixture extends AgentAbject { protected override async onInit(): Promise<void> {} }
class Caller extends Abject {
  results: any[] = []; checks = 0;
  constructor() {
    super({ manifest: { name: 'FixtureAgent', version: '1', description: 'scripted agent', interface: { id: 'abjects:fixture', name: 'Fixture', description: 'test', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
    this.on('candidateComplete', () => ({ accepted: ++this.checks > 1, reason: 'exercise the candidate first' }));
    this.on('taskResult', (m: AbjectMessage) => { this.results.push(m.payload); });
  }
  call(to: AbjectId, method: string, payload: unknown): Promise<any> { return this.request(request(this.id, to, method, payload)); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
test('message path: rejection continues work before any success is published', async () => {
  const bus = new MessageBus(), runtime: any = new RuntimeFixture(), caller = new Caller();
  await runtime.init(bus); await caller.init(bus);
  try {
    let runs = 0;
    runtime.runStateMachine = async (e: any) => { runs++; assert.equal(caller.results.length, 0); e.state.phase = 'done'; e.state.result = 'candidate'; };
    await caller.call(runtime.id, 'registerAgent', { name: 'FixtureAgent', config: { maxSteps: 5, completionMethod: 'candidateComplete' } });
    await caller.call(runtime.id, 'startTask', { taskId: 'repeat', task: 'finish', config: { completionMethod: '' } });
    for (let n = 0; n < 100 && !caller.results.length; n++) await tick();
    assert.equal(runs, 2); assert.equal(caller.results[0]?.success, true); assert.equal(caller.checks, 2);
    const duplicate = await caller.call(runtime.id, 'startTask', { taskId: 'repeat', task: 'finish', config: { completionMethod: '' } });
    assert.equal(duplicate.duplicate, true); assert.equal(runs, 2);
    await assert.rejects(caller.call(runtime.id, 'startTask', { taskId: 'repeat', task: 'different' }), /Conflicting duplicate/);
    await assert.rejects(caller.call(runtime.id, 'startTask', { task: 'schema', responseSchema: { type: 'bogus' } }));
  } finally { await caller.stop(); await runtime.stop(); }
});
