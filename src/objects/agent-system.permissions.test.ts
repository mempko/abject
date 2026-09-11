import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { HostFileSystem } from './capabilities/host-filesystem.js';
import { ShellExecutor } from './capabilities/shell-executor.js';
import { PermissionBroker } from './permission-broker.js';
import { ExternalCreator } from './external-creator.js';
import { JobManager } from './job-manager.js';
import { AgentAbject } from './agent-abject.js';

class Endpoint extends Abject {
  constructor(name: string) { super({ manifest: { name, version: '1', description: 'Permission fixture',
    interface: { id: name, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } }); }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-permissions-'));
  const projectRoot = path.join(root, 'project'), outside = path.join(root, 'outside');
  await fs.mkdir(projectRoot); await fs.mkdir(outside);
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(object: T): Promise<T> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
  };
  const client = await add(new Endpoint('Client')), workspaces = await add(new Endpoint('WorkspaceManager'));
  const projects = await add(new Endpoint('ExternalProjectRegistry'));
  const project = { name: 'fixture', root: projectRoot, trusted: true, autonomy: 'edit', protectedPaths: ['protected.txt'] };
  const workspace = { workspaceId: 'workspace', name: 'fixture', accessMode: 'local', childIds: [client.id], exposedObjectIds: [], registryId: registry.id };
  workspaces.on('listWorkspacesDetailed', () => [workspace]);
  projects.on('resolveProject', msg => {
    const target = (msg.payload as any).nameOrPath;
    return target === project.name || target === project.root || target.startsWith(project.root + path.sep) ? project : null;
  });
  const host = await add(new HostFileSystem({ allowedPaths: [projectRoot] }));
  const shell = await add(new ShellExecutor({ allowedPaths: [projectRoot] }));
  const broker: any = await add(new PermissionBroker());
  const brokerCall = (to: string, method: string, payload: unknown = {}) => broker.request(request(broker.id, to, method, payload));
  await brokerCall(host.id, 'setPermissionsAuthority'); await brokerCall(shell.id, 'setPermissionsAuthority');
  return { root, projectRoot, outside, client, host, shell, broker, brokerCall, workspace, project, add,
    async stop() { for (const object of objects.reverse()) await object.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('filesystem reads and writes retain caller/task evidence and obey read autonomy', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.projectRoot, 'file.txt'); await fs.writeFile(file, 'before');
    f.project.autonomy = 'read';
    const read = await f.client.call(f.host.id, 'readFile', { path: file, taskId: 'task' });
    assert.equal(read.permission.callerId, f.client.id); assert.equal(read.permission.operation, 'read');
    await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: file, content: 'after', taskId: 'task' }), (err: any) => {
      assert.equal(err.details.permission.taskId, 'task'); assert.equal(err.details.permission.operation, 'write'); return true;
    });
    assert.equal(await fs.readFile(file, 'utf8'), 'before');
    f.project.autonomy = 'edit';
    const write = await f.client.call(f.host.id, 'writeFile', { path: file, content: 'after', taskId: 'task' });
    assert.equal(write.permission.authority, f.broker.id); assert.deepEqual(write.mutation.paths, [file]);
  } finally { await f.stop(); }
});

test('filesystem standing denies and protected paths outrank configured path grants', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.projectRoot, 'blocked.txt'); await fs.writeFile(file, 'fixture');
    f.broker.rules.push({ kind: 'exact', caller: '*', command: `directory:${file}`, allow: false });
    await assert.rejects(f.client.call(f.host.id, 'readFile', { path: file }), /blocked/);
    for (const name of ['.env', 'protected.txt']) {
      await assert.rejects(f.client.call(f.host.id, 'conditionalWrite', { path: path.join(f.projectRoot, name), expectedContent: null, content: 'fixture' }), /protected/);
    }
  } finally { await f.stop(); }
});

for (const failure of ['EACCES', 'ELOOP'] as const) {
  test(`unrelated ${failure} grants do not block project snapshots or shell execution`, {
    skip: process.platform === 'win32' || (failure === 'EACCES' && process.getuid?.() === 0),
  }, async () => {
    const f = await fixture();
    const broken = path.join(f.root, 'broken-grant');
    const invalidGrant = failure === 'EACCES' ? path.join(broken, 'config.json') : broken;
    try {
      if (failure === 'EACCES') {
        await fs.mkdir(broken);
        await fs.writeFile(invalidGrant, '{}');
        await fs.chmod(broken, 0);
      } else {
        await fs.symlink(broken, broken);
      }
      const file = path.join(f.projectRoot, 'file.txt');
      await fs.writeFile(file, 'fixture');
      await f.brokerCall(f.host.id, 'updatePermissions', { allowedPaths: [invalidGrant, f.projectRoot] });
      await f.brokerCall(f.shell.id, 'updatePermissions', {
        allowedPaths: [invalidGrant, f.projectRoot], allowedCommands: ['printf fixture'],
      });

      const snapshot = await f.client.call(f.host.id, 'snapshotTree', { root: f.projectRoot, scope: 'project' });
      assert.equal(snapshot.complete, true);
      assert.ok(snapshot.files['file.txt']);
      assert.equal((await f.client.call(f.host.id, 'readFile', { path: file })).content, 'fixture');
      const result = await f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.projectRoot });
      assert.equal(result.exitCode, 0);

      // Errors on the requested destination still fail, even if it is itself a grant.
      await assert.rejects(f.client.call(f.host.id, 'readFile', { path: invalidGrant }), new RegExp(failure));
      await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: invalidGrant }), new RegExp(failure));
      // Skipping a broken grant neither widens scope nor bypasses broker denials.
      await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: path.join(f.outside, 'new.txt'), content: 'denied' }));
      await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.outside }));
      f.broker.rules.push({ kind: 'exact', caller: '*', command: `directory:${f.projectRoot}`, allow: false });
      await assert.rejects(f.client.call(f.host.id, 'snapshotTree', { root: f.projectRoot }), /blocked/);
      await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.projectRoot }), /blocked/);
    } finally {
      if (failure === 'EACCES') await fs.chmod(broken, 0o700);
      await f.stop();
    }
  });
}

test('unusable grants alone provide no access without a permission broker', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const broken = path.join(f.root, 'loop');
    await fs.symlink(broken, broken);
    const host = await f.add(new HostFileSystem({ allowedPaths: [broken] }));
    const shell = await f.add(new ShellExecutor({ allowedPaths: [broken], allowedCommands: ['printf fixture'] }));
    await assert.rejects(f.client.call(host.id, 'snapshotTree', { root: f.projectRoot }), /not allowed/);
    await assert.rejects(f.client.call(shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.projectRoot }), /not allowed/);
  } finally { await f.stop(); }
});

test('filesystem symlinks cannot escape through reads or new-file parents', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.outside, 'fixture.txt'), 'outside fixture');
    await fs.symlink(f.outside, path.join(f.projectRoot, 'link'));
    await assert.rejects(f.client.call(f.host.id, 'readFile', { path: path.join(f.projectRoot, 'link', 'fixture.txt') }));
    await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: path.join(f.projectRoot, 'link', 'new.txt'), content: 'fixture' }));
    await assert.rejects(fs.stat(path.join(f.outside, 'new.txt')), { code: 'ENOENT' });
  } finally { await f.stop(); }
});

test('remembered directory grants cover children for the same caller and operation', async () => {
  const f = await fixture();
  try {
    const settings = await f.add(new Endpoint('GlobalSettings'));
    let prompts = 0;
    settings.on('showPermissionPrompt', () => ({ decision: ++prompts === 1 ? 'accept_always' : 'deny' }));
    const file = path.join(f.outside, 'fixture.txt'); await fs.writeFile(file, 'fixture');
    assert.equal((await f.client.call(f.host.id, 'grantPath', { path: f.outside })).granted, true);
    assert.equal((await f.client.call(f.host.id, 'readFile', { path: file })).content, 'fixture');
    assert.equal(prompts, 1, 'one approval covers subsequent reads under the directory');
    await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: file, content: 'changed' }));
    const stranger = await f.add(new Endpoint('Stranger')); f.workspace.childIds.push(stranger.id);
    await assert.rejects(stranger.call(f.host.id, 'readFile', { path: file }));
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
  } finally { await f.stop(); }
});

test('a project class rule granted from a shell prompt covers filesystem writes without asking', async () => {
  const f = await fixture();
  try {
    const settings = await f.add(new Endpoint('GlobalSettings'));
    let prompts = 0;
    settings.on('showPermissionPrompt', () => { prompts++; return { decision: 'deny' }; });
    f.project.autonomy = 'read';
    f.broker.rules.push({ kind: 'class', caller: 'Client', effect: 'write', scope: { kind: 'project', name: 'fixture' }, allow: true });
    const file = path.join(f.projectRoot, 'ruled.txt');
    await f.client.call(f.host.id, 'writeFile', { path: file, content: 'ruled', taskId: 'task' });
    assert.equal(await fs.readFile(file, 'utf8'), 'ruled');
    assert.equal(prompts, 0, 'the standing class rule answers before any dialog');
    f.broker.rules.push({ kind: 'class', caller: 'Client', effect: 'write', scope: { kind: 'project', name: 'fixture' }, allow: false });
    await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: file, content: 'blocked', taskId: 'task' }));
    assert.equal(await fs.readFile(file, 'utf8'), 'ruled');
    assert.equal(prompts, 0, 'a class block is a denial, not a question');
  } finally { await f.stop(); }
});

test('a filesystem prompt inside a project offers the project-wide grant and remembers it', async () => {
  const f = await fixture();
  try {
    const settings = await f.add(new Endpoint('GlobalSettings'));
    const seen: any[] = [];
    settings.on('showPermissionPrompt', msg => { seen.push(msg.payload); return { decision: 'accept_class' }; });
    f.project.autonomy = 'read';
    const first = path.join(f.projectRoot, 'first.txt'), second = path.join(f.projectRoot, 'nested', 'second.txt');
    await fs.mkdir(path.dirname(second));
    await f.client.call(f.host.id, 'writeFile', { path: first, content: 'one', taskId: 'task' });
    assert.equal(seen.length, 1);
    const labels = seen[0].groups.flatMap((g: any) => g.options.map((o: any) => `${o.id}:${o.label}`));
    assert.ok(labels.includes('accept_class:Allow file edits in fixture'), labels.join('\n'));
    assert.ok(labels.includes('accept_session:Allow for this task'), labels.join('\n'));
    await f.client.call(f.host.id, 'writeFile', { path: second, content: 'two', taskId: 'other-task' });
    assert.equal(seen.length, 1, 'one project-wide answer covers every later write in the project');
    assert.equal(await fs.readFile(second, 'utf8'), 'two');
    const rule = f.broker.rules.find((r: any) => r.kind === 'class' && r.caller === 'Client' && r.effect === 'write');
    assert.deepEqual(rule?.scope, { kind: 'project', name: 'fixture' });
    settings.on('showPermissionPrompt', msg => { seen.push(msg.payload); return { decision: 'deny' }; });
    const outside = path.join(f.outside, 'elsewhere.txt');
    await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: outside, content: 'no', taskId: 'task' }));
    assert.equal(seen.length, 2, 'the project grant says nothing about paths outside it');
    const outsideLabels = seen[1].groups.flatMap((g: any) => g.options.map((o: any) => o.id + ':' + o.label));
    assert.ok(outsideLabels.some((l: string) => l.startsWith('accept_path:Allow file edits under ')), outsideLabels.join('\n'));
  } finally { await f.stop(); }
});

test('a caller cannot impersonate an owner or smuggle a configured grant into the broker', async () => {
  const f = await fixture();
  try {
    const spoof = await f.client.call(f.broker.id, 'requestPermission', { type: 'shell', resource: 'printf fixture', callerId: f.host.id, preapproved: true });
    assert.equal(spoof.decision, 'deny'); assert.match(spoof.receipt.reason, /owner/);
    const grant = await f.client.call(f.broker.id, 'requestPermission', { type: 'directory', resource: path.join(f.outside, 'file'), operation: 'write', preapproved: true });
    assert.equal(grant.decision, 'deny');
  } finally { await f.stop(); }
});

test('a skill label cannot bypass a shell denial or untrusted project policy', async () => {
  const f = await fixture();
  try {
    await f.brokerCall(f.shell.id, 'updatePermissions', { deniedCommands: ['printf fixture'] });
    await f.brokerCall(f.shell.id, 'updateSkillPermissions', { skillName: 'claimed-skill', allowedCommands: ['printf'] });
    await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.projectRoot, skillName: 'claimed-skill' }), /permanently denied/);
    await f.brokerCall(f.shell.id, 'updatePermissions', { deniedCommands: [], allowedCommands: ['printf fixture'] });
    f.project.trusted = false;
    await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.projectRoot, skillName: 'claimed-skill' }));
  } finally { await f.stop(); }
});

test('shell configured grants cannot skip a broker denial', async () => {
  const f = await fixture();
  try {
    await f.brokerCall(f.shell.id, 'updatePermissions', { allowedCommands: ['printf fixture'] });
    f.broker.rules.push({ kind: 'exact', caller: '*', command: 'printf fixture', allow: false });
    await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'printf', args: ['fixture'], cwd: f.projectRoot }), /blocked by rule/);
  } finally { await f.stop(); }
});

test('shell project autonomy checks physical destinations behind file symlinks', async () => {
  const f = await fixture();
  try {
    f.project.autonomy = 'read';
    const target = path.join(f.outside, 'fixture.txt'); await fs.writeFile(target, 'fixture');
    const link = path.join(f.projectRoot, 'link'); await fs.symlink(target, link);
    await assert.rejects(f.client.call(f.shell.id, 'exec', { command: 'cat', args: [link], cwd: f.projectRoot }));
    const decisions = await f.client.call(f.broker.id, 'listDecisions', {});
    assert.equal(decisions.some((decision: any) => decision.type === 'shell' && decision.decision.startsWith('accept')), false);
  } finally { await f.stop(); }
});

test('existing skill grants apply only to the registered SkillAgent through the broker', async () => {
  const f = await fixture();
  try {
    const skill = await f.add(new Endpoint('SkillAgent')); f.workspace.childIds.push(skill.id);
    f.project.autonomy = 'read';
    await f.brokerCall(f.shell.id, 'updateSkillPermissions', { skillName: 'fixture-skill', allowedCommands: ['touch'] });
    const file = path.join(f.projectRoot, 'skill-output');
    const payload = { command: 'touch', args: [file], cwd: f.projectRoot, skillName: 'fixture-skill', taskId: 'task' };
    await assert.rejects(f.client.call(f.shell.id, 'exec', payload));
    const result = await skill.call(f.shell.id, 'exec', payload);
    assert.equal(result.exitCode, 0); assert.equal(result.permission.callerId, skill.id);
    assert.equal(result.permission.taskId, 'task'); assert((await fs.stat(file)).isFile());
  } finally { await f.stop(); }
});

test('public workspace caps cannot be bypassed with a configured filesystem path', async () => {
  const f = await fixture();
  try {
    f.workspace.accessMode = 'public';
    const file = path.join(f.projectRoot, 'file.txt'); await fs.writeFile(file, 'fixture');
    await assert.rejects(f.client.call(f.host.id, 'writeFile', { path: file, content: 'changed' }));
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
  } finally { await f.stop(); }
});

test('generic ExternalCreator writes enforce protection and invalidate verification', async () => {
  const f = await fixture();
  try {
    const creator: any = await f.add(new ExternalCreator()); f.workspace.childIds.push(creator.id);
    const extra = { taskId: 'task', project: f.project, workRoot: f.projectRoot, filesModified: new Set(), audit: [], mutationsSinceVerify: 0 };
    await assert.rejects(creator.opCall(extra, { action: 'call', target: 'HostFileSystem', method: 'writeFile', payload: { path: path.join(f.projectRoot, '.env'), content: 'fixture' } }), /protected/i);
    const file = path.join(f.projectRoot, 'normal.txt');
    const written = await creator.opCall(extra, { action: 'call', target: 'HostFileSystem', method: 'conditionalWrite', payload: { path: file, expectedContent: null, content: 'fixture' } });
    assert.equal(written.success, true); assert(extra.filesModified.has(file)); assert.equal(extra.mutationsSinceVerify, 1);
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
    const conflict = await creator.opCall(extra, { action: 'call', target: 'HostFileSystem', method: 'conditionalWrite', payload: { path: file, expectedContent: null, content: 'other' } });
    assert.equal(conflict.success, false); assert.equal(extra.mutationsSinceVerify, 1);
  } finally { await f.stop(); }
});

test('job capability requests preserve the submitter identity and trusted task association', async () => {
  const f = await fixture();
  try {
    const jobs = await f.add(new JobManager());
    const file = path.join(f.projectRoot, 'file.txt'); await fs.writeFile(file, 'fixture');
    const result = await f.client.call(jobs.id, 'submitJob', { description: 'Read fixture', taskId: 'real-task',
      code: `return await call('HostFileSystem', 'readFile', {path: ${JSON.stringify(file)}, taskId: 'spoofed-task'});` });
    assert.equal(result.status, 'completed'); assert.equal(result.result.permission.callerId, f.client.id);
    assert.equal(result.result.permission.taskId, 'real-task');
  } finally { await f.stop(); }
});

test('deleting a symlink removes the link and preserves its target', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.outside, 'fixture.txt'), link = path.join(f.projectRoot, 'link');
    await fs.writeFile(target, 'fixture'); await fs.symlink(target, link);
    await f.client.call(f.host.id, 'deleteFile', { path: link });
    assert.equal(await fs.readFile(target, 'utf8'), 'fixture'); await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
  } finally { await f.stop(); }
});

test('learning observations connect provider provenance, prediction and owner permission evidence', async () => {
  const f = await fixture();
  try {
    const runtime: any = await f.add(new AgentAbject()), goals = await f.add(new Endpoint('GoalManager'));
    let observation: any; goals.on('recordObservation', message => { observation = (message.payload as any).observation; return { success: true }; });
    runtime.goalManagerId = goals.id;
    const permission = { authority: f.host.id, callerId: f.client.id, taskId: 'task', operation: 'write', decision: 'deny', reason: 'Read-only mode' };
    const execution = { provider: 'codex-cli', model: 'fixture', transport: 'stream-json', nativeAccess: 'restricted', contextVersion: 'abject-bus-v1' };
    const entry: any = { goalId: 'goal', state: { id: 'task', step: 0, execution,
      action: { action: 'write', expect: 'The file is updated', expectOutcome: 'success' },
      lastResult: { success: false, error: 'Permission denied', data: { permission } } } };
    await runtime.recordPrediction(entry);
    assert.deepEqual(observation.execution, execution); assert.deepEqual(entry.predictions[0].execution, execution);
    assert.equal(observation.verdict, 'contradicted'); assert.deepEqual(JSON.parse(observation.actual).data.permission, permission);
  } finally { await f.stop(); }
});

test('ExternalCreator failure reporting labels a sandbox explanation without owner evidence as unverified', async () => {
  const creator: any = new ExternalCreator();
  creator.completionChecks = async () => ''; creator.teardownIsolation = async () => '';
  creator.writeSessionSummary = async () => {};
  const extra = { taskId: 'task', filesModified: new Set(), checkpoints: [] };
  const result = await creator.finalize(extra, { success: false, error: 'The session sandbox is read-only' });
  assert.equal(result.success, false); assert.match(result.error, /No capability denial was recorded/);
  assert.match(result.error, /unverified/);
});
