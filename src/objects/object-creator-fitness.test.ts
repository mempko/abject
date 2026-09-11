// Run: pnpm tsx --test src/objects/object-creator-fitness.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSandboxInvoker, FITNESS_INVOCATION_TIMEOUT_MS } from '../protocol/sandbox-invoker.js';
import { deployGate, evaluate, verdictDigest } from '../protocol/fitness.js';
import { CassetteStore, type Cassette } from '../protocol/cassette.js';
import type { MethodDeclaration } from '../core/types.js';

const HANDLER_MAP = `{
  async listEvents(msg) {
    const res = await call('HttpClient', 'get', { url: 'https://example.test/events' });
    if (!res.ok) throw new Error('http ' + res.status);
    return JSON.parse(res.body);
  }
}`;

const cassette: Cassette = {
  method: 'listEvents', args: {},
  request: { method: 'GET', url: 'https://example.test/events' },
  response: { status: 200, body: [{ id: 1 }] },
  rawBody: '[{"id":1}]',
  parsedOutput: [{ id: 1 }],
  recordedAt: 1,
};
const methods: MethodDeclaration[] = [{ name: 'listEvents', description: '', parameters: [] }];

test('sandbox invoker runs a handler map with HTTP served from cassettes', async () => {
  const invoker = buildSandboxInvoker();
  const v = await evaluate({ source: HANDLER_MAP },
    { cassettes: new CassetteStore([cassette]), methods }, invoker, { maxMutants: 0 });
  assert.equal(v.pass, true);
});

test("the HttpClient shim returns the shape HttpClient's ask guide teaches", async () => {
  // { status, statusText, headers, body, ok } with body ALWAYS a raw string.
  const echoShape = `{
    async listEvents(msg) {
      const res = await call('HttpClient', 'get', { url: 'https://example.test/events' });
      return { keys: Object.keys(res).sort(), bodyType: typeof res.body, body: res.body, ok: res.ok, status: res.status };
    }
  }`;
  const out = await buildSandboxInvoker()(echoShape, 'listEvents', {},
    () => ({ status: 200, body: [{ id: 1 }], rawBody: '[{"id":1}]' }));
  // Structural, not deepEqual: the value crosses out of the vm realm, so its
  // prototype is not this realm's Object.prototype.
  const got = out as Record<string, unknown>;
  assert.deepEqual([...(got.keys as string[])], ['body', 'headers', 'ok', 'status', 'statusText']);
  assert.equal(got.bodyType, 'string');
  assert.equal(got.body, '[{"id":1}]');
  assert.equal(got.ok, true);
  assert.equal(got.status, 200);
});

test('WebFetch is not stubbed: its live shape is not an HttpResponse', async () => {
  const webFetcher = `{
    async listEvents(msg) { return call('WebFetch', 'fetch', { url: 'https://example.test/events' }); }
  }`;
  const v = await evaluate({ source: webFetcher },
    { cassettes: new CassetteStore([cassette]), methods }, buildSandboxInvoker(), { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /unstubbed I\/O -- call\('WebFetch'/);
});

test('sandbox invoker refuses unstubbed I/O', async () => {
  const leaky = `{
    async listEvents(msg) { return call('ShellExecutor', 'run', { command: 'ls' }); }
  }`;
  const invoker = buildSandboxInvoker();
  const v = await evaluate({ source: leaky },
    { cassettes: new CassetteStore([cassette]), methods }, invoker, { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /unstubbed I\/O/);
});

test('a handler reaches its siblings through `this`, as it does at runtime', async () => {
  const withHelper = `{
    async listEvents(msg) {
      const res = await call('HttpClient', 'get', { url: 'https://example.test/events' });
      if (!res.ok) throw new Error('http ' + res.status);
      return this.shape(JSON.parse(res.body));
    },
    shape(items) { return items.map(e => ({ id: e.id })); }
  }`;
  const v = await evaluate({ source: withHelper },
    { cassettes: new CassetteStore([cassette]), methods }, buildSandboxInvoker(), { maxMutants: 0 });
  assert.equal(v.pass, true, JSON.stringify(v.checks));
});

test('the handler proxy carries the members the runtime proxy carries', async () => {
  const usesProxy = `{
    async listEvents(msg) {
      this.ensure(typeof this.id === 'string', 'id must be a string');
      this.invariant(this.data && typeof this.data === 'object', 'data must be an object');
      this.data.seen = true;
      await this.saveData();
      this.emit('Somewhere', 'looked', {});
      this.changed('items');
      this.observe('Somewhere');
      return [{ id: this.data.seen ? 1 : 0 }];
    }
  }`;
  const v = await evaluate({ source: usesProxy },
    { cassettes: new CassetteStore([cassette]), methods }, buildSandboxInvoker(), { maxMutants: 0 });
  assert.equal(v.pass, true, JSON.stringify(v.checks));
});

test('ensure/invariant throw on a falsy condition', async () => {
  const breach = `{ async listEvents(msg) { this.ensure(false, 'nope'); return []; } }`;
  const v = await evaluate({ source: breach },
    { cassettes: new CassetteStore([cassette]), methods }, buildSandboxInvoker(), { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /ContractViolation \(ensure\): nope/);
});

test('an invocation that never settles is killed by the deadline', async () => {
  // The worker is terminated on expiry, so nothing a candidate does can make
  // the gate wait on it.
  assert.equal(FITNESS_INVOCATION_TIMEOUT_MS, 5000);
  const hangs = `{ async listEvents(msg) { await new Promise(() => {}); return []; } }`;
  const started = Date.now();
  const v = await evaluate({ source: hangs },
    { cassettes: new CassetteStore([cassette]), methods },
    buildSandboxInvoker({ timeoutMs: 100 }), { maxMutants: 0 });
  assert.equal(v.pass, false);
  assert.match(v.checks[0].detail, /fitness: invocation timeout/);
  assert.ok(Date.now() - started < 4000, 'the gate must not wait on a hung candidate');
});

test('verdictDigest covers the declarations and the target, not just the source', () => {
  const src = 'return 1;';
  const more: MethodDeclaration[] = [...methods, { name: 'countEvents', description: '', parameters: [] }];
  assert.notEqual(verdictDigest(src, methods), verdictDigest(src, more));
  assert.equal(verdictDigest(src, methods), verdictDigest(src, [...methods]));
  assert.notEqual(verdictDigest(src, methods), verdictDigest(src, methods, 'obj-a'));
  assert.notEqual(verdictDigest(src, methods, 'obj-a'), verdictDigest(src, methods, 'obj-b'));
});

test('deployGate refuses without a verdict, with a failed verdict, and on a stale digest', () => {
  const src = 'return 1;';
  const digest = verdictDigest(src, methods);
  const passing = { fitnessVerdict: { pass: true, checks: [] }, fitnessSourceDigest: digest };
  assert.equal(deployGate({}, src, methods).ok, false);
  assert.equal(deployGate({ fitnessVerdict: { pass: false, checks: [] }, fitnessSourceDigest: digest }, src, methods).ok, false);
  assert.equal(deployGate(passing, 'return 2;', methods).ok, false);
  // a re-drafted manifest invalidates the verdict too: schema and relations
  // were judged against the declarations as they stood
  assert.equal(deployGate(passing, src,
    [...methods, { name: 'countEvents', description: '', parameters: [] }]).ok, false);
  assert.equal(deployGate(passing, src, methods).ok, true);
});

test('deployGate refuses a verdict earned against a different object', () => {
  const src = 'return 1;';
  const judged = { fitnessVerdict: { pass: true, checks: [] },
    fitnessSourceDigest: verdictDigest(src, methods, 'obj-a') };
  const refusal = deployGate(judged, src, methods, 'obj-b');
  assert.equal(refusal.ok, false);
  assert.equal(deployGate(judged, src, methods, 'obj-a').ok, true);
  // the target lives in the digest, so a targetless deploy cannot use a
  // targeted verdict — and a targeted deploy cannot use a targetless one
  assert.equal(deployGate(judged, src, methods).ok, false);
  const targetless = { fitnessVerdict: { pass: true, checks: [] },
    fitnessSourceDigest: verdictDigest(src, methods) };
  assert.equal(deployGate(targetless, src, methods, 'obj-b').ok, false);
  assert.equal(deployGate(targetless, src, methods).ok, true);
});

test('end to end, in the dialect an LLM actually writes', async () => {
  // Everything the house style puts in one handler: a parenthesized handler
  // map, a thin handler over a private helper reached through `this`, an
  // HttpClient call whose response is checked with `res.ok` and parsed out of
  // the raw `res.body` string — judged against one recorded cassette, through
  // the real sandbox invoker, with every check armed.
  const REAL = `({
    async listEvents(msg) {
      const res = await call('HttpClient', 'get', { url: 'https://example.test/events?q=' + msg.payload.q });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return this.shape(JSON.parse(res.body));
    },
    shape(rows) {
      return rows.map(r => ({ id: r.id, name: r.name }));
    }
  })`;
  const evidence: Cassette = {
    method: 'listEvents', args: { q: 'all' },
    request: { method: 'GET', url: 'https://example.test/events?q=all' },
    response: { status: 200, body: [{ id: 1, name: 'Weekly Standup', extra: 9 }] },
    rawBody: '[{"id":1,"name":"Weekly Standup","extra":9}]',
    parsedOutput: [{ id: 1, name: 'Weekly Standup' }],
    recordedAt: 1,
  };
  const declared: MethodDeclaration[] = [{
    name: 'listEvents', description: '', parameters: [], sideEffects: 'read-only',
    outputSchema: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'name'],
        properties: { id: { type: 'number' }, name: { type: 'string' } },
      },
    },
    relations: [{ kind: 'no-duplicates' }, { kind: 'idempotent' }, { kind: 'non-empty-for-known-entity' }],
    entityRef: 'Weekly Standup',
  }];

  const v = await evaluate({ source: REAL },
    { cassettes: new CassetteStore([evidence]), methods: declared }, buildSandboxInvoker());

  assert.equal(v.pass, true, JSON.stringify(v.checks, null, 2));
  assert.equal(v.checks.find(c => c.check === 'replay')?.detail, '1 cassette(s) reproduced');
  assert.equal(v.checks.find(c => c.check === 'schema')?.detail, 'all outputs validate');
  assert.equal(v.checks.find(c => c.check === 'relations')?.detail, 'all declared relations hold');
});

test('a synchronous spin in a handler is killed by the watchdog, not hung', async () => {
  const spin = `({ async listEvents() { while (true) {} } })`;
  const invoker = buildSandboxInvoker({ timeoutMs: 300 });
  await assert.rejects(() => invoker(spin, 'listEvents', {}, () => undefined),
    /timed out|timeout/i);
});

test('a spin AFTER awaiting the stub is also killed', async () => {
  const spin = `({ async listEvents() {
    await this.call('HttpClient', 'get', { url: 'https://example.test/events?q=1' });
    while (true) {}
  } })`;
  const invoker = buildSandboxInvoker({ timeoutMs: 300 });
  await assert.rejects(() => invoker(spin, 'listEvents', {},
    () => ({ status: 200, body: [1], rawBody: '[1]' })), /timed out|timeout/i);
});

test('a candidate legitimately using timers is judged, not killed', async () => {
  // The worker has its own event loop, so retry-with-backoff style handlers
  // resolve normally instead of being mistaken for hostile code.
  const timerUser = `({ async listEvents() {
    await new Promise(r => setTimeout(r, 10)); return [];
  } })`;
  const invoker = buildSandboxInvoker({ timeoutMs: 3000 });
  const out = await invoker(timerUser, 'listEvents', {}, () => undefined);
  assert.deepEqual(out, []);
});

test('a candidate reaching for Atomics is refused outright', async () => {
  const atomicsUser = `({ async listEvents() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } })`;
  const invoker = buildSandboxInvoker({ timeoutMs: 300 });
  await assert.rejects(() => invoker(atomicsUser, 'listEvents', {}, () => undefined),
    /Atomics|blocked/i);
});

test('every Factory spawn goes through the gated helper', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./object-creator.ts', import.meta.url), 'utf8');
  const direct = src.split('\n')
    .filter(l => l.includes("'spawn'") && l.includes('sendRequest'));
  assert.equal(direct.length, 1,
    `Factory.spawn call sites outside gatedSpawn: ${direct.length - 1} too many`);
});
