import test from 'node:test';
import assert from 'node:assert/strict';
import { runSandboxed, compileSandboxed } from '../core/sandbox.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';

test('JavaScript helpers retain host object identity and callable arguments', async () => {
  const data = { count: 2 };
  const result = await runSandboxed('return await invoke(data, () => ++data.count);', {
    data,
    invoke: async (received: unknown, callback: () => number) => {
      assert.equal(received, data);
      assert.equal(callback(), 3);
      return received;
    },
  });
  assert.equal(result, data);
  assert.equal(data.count, 3);
});

test('handler compilation supports factories, computed names and synchronous return values', () => {
  const receiver = { data: { count: 2 } };
  const handlers = compileSandboxed('(() => { let calls = 0; return { ["increment"]() { calls++; return this.data.count += calls; } }; })()', {});
  const increment = (handlers.increment as () => number).bind(receiver);
  assert.equal(increment(), 3);
  assert.equal(increment(), 5);
  assert.equal(receiver.data.count, 5);
});

test('in-process execution retains the VM synchronous timeout', async () => {
  await assert.rejects(runSandboxed('while (true) {}', {}, { timeout: 25 }), /timed out/);
});

test('scripted message handlers keep synchronous results and track asynchronous lifecycle work', async () => {
  const source = `({ sync() { return 7; }, async asyncResult() { return 8; },
    throws() { throw new Error('sync failure'); }, async rejects() { throw new Error('async failure'); } })`;
  const object: any = new ScriptableAbject({ name: 'HandlerFixture', version: '1', description: 'fixture',
    interface: { id: 'fixture:handler', name: 'HandlerFixture', description: 'fixture', methods: [] },
    requiredCapabilities: [], providedCapabilities: [] }, source, 'owner');
  await object.init(new MessageBus());
  try {
  const call = (method: string) => object.handlers.get(method)(request(object.id, object.id, method, {}));
  // Exercise initial installation and replacement: both used to force async dispatch.
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(call('sync'), 7, 'no Promise allocated for a synchronous message');
    assert.equal(object.activeUserCalls, 0);
    assert.throws(() => call('throws'), /sync failure/);
    assert.equal(object.activeUserCalls, 0);
    const pending = call('asyncResult');
    assert.equal(object.activeUserCalls, 1, 'cross-realm async work keeps activation blocked');
    assert.equal(await pending, 8);
    assert.equal(object.activeUserCalls, 0);
    await assert.rejects(call('rejects'), /async failure/);
    assert.equal(object.activeUserCalls, 0);
    object.activating = true;
    assert.throws(() => call('sync'), /Source activation in progress/);
    object.activating = false;
    assert.equal(object.applySource(source).success, true);
  }
  } finally { await object.stop(); }
});
