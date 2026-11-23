/**
 * The hop the live run showed missing: an agent that calls a capability
 * object directly (ObjectAgent's `call`, SkillAgent's shell/file actions,
 * WebAgent's HttpClient, ExternalCreator's tools) sends no grantId, so the
 * capability's PermissionBroker request carried no grant chain and the
 * approval dialog opened under "Ask every time".
 *
 * capabilityCaller (core/abject.ts) now asks AgentAbject `getTaskGrant`
 * {agentId, taskId?} by message when a call arrives without a grant, and
 * takes the grant (and the runtime task id it is bound to) of that agent's
 * live task. These tests pin that hop with a stand-in AgentAbject that
 * answers the way AgentAbject.getTaskGrant does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';

type Msg = Parameters<MessageHandlerFn>[0];

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Direct-call fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}, timeout = 5000): Promise<any> {
    return this.request(request(this.id, to, method, payload), timeout);
  }
  caller(msg: Msg) { return this.capabilityCaller(msg); }
}

async function fixture(withLookup = true) {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async (object: Endpoint): Promise<Endpoint> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
  };
  const runtime = await add(new Endpoint('AgentAbject'));
  const capability = await add(new Endpoint('ShellExecutor'));
  const agent = await add(new Endpoint('ObjectAgent'));
  const asked: Array<Record<string, unknown>> = [];
  const held = new Map<string, { taskId: string; grantId: string }>();
  if (withLookup) {
    runtime.on('getTaskGrant', async (msg: Msg) => {
      const p = msg.payload as { agentId: string; taskId?: string };
      asked.push({ ...p });
      const h = held.get(p.agentId);
      return h && (!p.taskId || p.taskId === h.taskId) ? h : null;
    });
  }
  capability.on('who', async (msg: Msg) => capability.caller(msg));
  const stop = async () => { for (const o of objects.reverse()) { try { await (o as any).stop?.(); } catch { /* fixture teardown */ } } };
  return { runtime, capability, agent, asked, held, stop };
}

test('a direct agent call without a grant runs under its live task grant', async () => {
  const f = await fixture();
  try {
    f.held.set(f.agent.id, { taskId: 'rt-1', grantId: 'grant-1' });
    const r = await f.agent.call(f.capability.id, 'who', { command: 'ls' });
    assert.equal(r.callerId, f.agent.id);
    assert.equal(r.taskId, 'rt-1');
    assert.equal(r.grantId, 'grant-1');
    assert.deepEqual(f.asked, [{ agentId: f.agent.id }]);
  } finally { await f.stop(); }
});

test('a payload taskId narrows the lookup to that task', async () => {
  const f = await fixture();
  try {
    f.held.set(f.agent.id, { taskId: 'rt-1', grantId: 'grant-1' });
    const named = await f.agent.call(f.capability.id, 'who', { taskId: 'rt-1' });
    assert.equal(named.grantId, 'grant-1');
    assert.deepEqual(f.asked[0], { agentId: f.agent.id, taskId: 'rt-1' });
    const other = await f.agent.call(f.capability.id, 'who', { taskId: 'someone-else' });
    assert.equal(other.grantId, undefined);
    assert.equal(other.taskId, 'someone-else');
  } finally { await f.stop(); }
});

test('a grant the caller presents is used as is, with no lookup', async () => {
  const f = await fixture();
  try {
    f.held.set(f.agent.id, { taskId: 'rt-1', grantId: 'grant-1' });
    const r = await f.agent.call(f.capability.id, 'who', { taskId: 't-x', grantId: 'grant-x' });
    assert.equal(r.grantId, 'grant-x');
    assert.equal(r.taskId, 't-x');
    assert.equal(f.asked.length, 0);
  } finally { await f.stop(); }
});

test('an agent with no live task grant still gets no grant', async () => {
  const f = await fixture();
  try {
    const r = await f.agent.call(f.capability.id, 'who', {});
    assert.equal(r.callerId, f.agent.id);
    assert.equal(r.grantId, undefined);
    assert.equal(f.asked.length, 1);
  } finally { await f.stop(); }
});

test('a runtime that cannot answer getTaskGrant leaves the call ungranted, not failed', async () => {
  const f = await fixture(false);
  try {
    const r = await f.agent.call(f.capability.id, 'who', {});
    assert.equal(r.callerId, f.agent.id);
    assert.equal(r.grantId, undefined);
  } finally { await f.stop(); }
});

test('the runtime itself is never looked up as an agent', async () => {
  const f = await fixture();
  try {
    const r = await f.runtime.call(f.capability.id, 'who', {});
    assert.equal(r.callerId, f.runtime.id);
    assert.equal(f.asked.length, 0);
  } finally { await f.stop(); }
});
