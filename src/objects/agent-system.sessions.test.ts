import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskSession } from './task-session.js';
import { encodeAgentState, decodeAgentState } from '../core/agent-session-codec.js';
import { RunningProcess } from './capabilities/running-process.js';
import { Abject } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';

function sessions(): any {
  const s: any = new TaskSession(); s.storageId = 'storage'; s.runtimeOnly = async () => {}; s.changed = () => {};
  s.request = async () => true;
  return s;
}
const call = (s: any, method: string, payload: unknown) => s.handlers.get(method)({ routing: { from: 'runtime' }, payload });
test('checkpoint rejects stale writers and cannot resume an uncertain operation', async () => {
  const s = sessions();
  const created = await call(s, 'checkpoint', { id: 'a', expectedRevision: 0, agentName: 'ExternalCreator', intent: 'fix', outstandingOperation: { command: 'migrate' }, status: 'partial' });
  assert.equal(created.session.revision, 1);
  assert.equal((await call(s, 'checkpoint', { id: 'a', expectedRevision: 0 })).conflict, true);
  await assert.rejects(call(s, 'resume', { id: 'a', expectedRevision: 1 }), /unknown/);
  const reconciled = await call(s, 'reconcile', { id: 'a', expectedRevision: 1, evidence: 'receiver reports operation committed', outcome: 'committed' });
  assert.equal(reconciled.session.outstandingOperation, undefined);
  assert.equal((await call(s, 'resume', { id: 'a', expectedRevision: 2 })).session.attempt, 2);
});
test('failed persistence does not acknowledge or publish a checkpoint', async () => {
  const s = sessions(); s.request = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(call(s, 'checkpoint', { id: 'a', expectedRevision: 0, agentName: 'ExternalCreator', intent: 'fix' }), /disk unavailable/);
  assert.equal(await call(s, 'get', { id: 'a' }), null);
});
test('session fork preserves dialogue without copying accepted status', async () => {
  const s = sessions();
  await call(s, 'checkpoint', { id: 'a', expectedRevision: 0, agentName: 'ObjectCreator', intent: 'build', status: 'accepted', snapshot: { hypotheses: ['state survives restore'] } });
  const fork = await call(s, 'fork', { id: 'a', newId: 'b' });
  assert.equal(fork.session.parentId, 'a'); assert.equal(fork.session.status, 'paused'); assert.deepEqual(fork.session.snapshot.hypotheses, ['state survives restore']);
});
test('agent session codec preserves collection state and omits live promises', () => {
  const state = { deps: new Map([['x', { methods: new Set(['read']) }]]), pending: Promise.resolve(), deferredMsg: { old: true } };
  const restored = decodeAgentState<typeof state>(encodeAgentState(state));
  assert(restored.deps.get('x')?.methods.has('read')); assert.equal(restored.pending, undefined); assert.equal(restored.deferredMsg, undefined);
});
class Client extends Abject {
  constructor() { super({ manifest: { name: 'ProcessClient', version: '1', description: 'test', interface: { id: 'abjects:process-client', name: 'Client', description: 'test', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } }); }
  call(id: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, id, method, payload), 10000); }
}
test('running process retains full output behind a message handle and bounds previews', async () => {
  const bus = new MessageBus(), client = new Client(); await client.init(bus);
  const p = new RunningProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(200000))'], owner: client.id, supervisor: client.id, timeout: 5000 });
  await p.init(bus);
  try {
    const result = await client.call(p.id, 'wait');
    assert.equal(result.exitCode, 0); assert.equal(result.outputBytes, 200000, JSON.stringify(result)); assert(result.stdout.length <= 65536);
    const chunk = await client.call(p.id, 'readOutput', { offset: 190000, length: 20000 });
    assert.equal(chunk.text.length, 10000); assert.equal(chunk.nextOffset, 200000);
  } finally { await p.stop(); await client.stop(); }
});
test('running process cancellation is owned, idempotent, and terminates the process', async () => {
  const bus = new MessageBus(), client = new Client(), stranger = new Client(); await client.init(bus); await stranger.init(bus);
  const p = new RunningProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], owner: client.id, supervisor: client.id, timeout: 5000 });
  await p.init(bus);
  try {
    await assert.rejects(stranger.call(p.id, 'stop'), /another caller/);
    await client.call(p.id, 'stop'); await client.call(p.id, 'stop');
    assert.equal((await client.call(p.id, 'wait')).state, 'cancelled');
  } finally { await p.stop(); await client.stop(); await stranger.stop(); }
});
