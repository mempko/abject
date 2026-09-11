/** Run: pnpm tsx --test src/protocol/cassette.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CassetteStore, redactRequest, CASSETTE_CAP_PER_METHOD, type Cassette } from './cassette.js';

function mk(n: number, method = 'listEvents'): Cassette {
  return {
    method, args: { q: n },
    request: { method: 'GET', url: `https://example.test/events?q=${n}` },
    response: { status: 200, body: [{ id: n }] },
    rawBody: `[{"id":${n}}]`,
    parsedOutput: [{ id: n }],
    recordedAt: n,
  };
}

test('redactRequest strips credential headers case-insensitively', () => {
  const r = redactRequest({
    method: 'GET', url: 'https://example.test/x',
    headers: { Authorization: 'Bearer s3cret', 'X-Ok': 'yes', COOKIE: 'a=1', 'set-cookie': 'b=2' },
  });
  assert.deepEqual(r.headers, { 'X-Ok': 'yes' });
});

test('store caps per method with LRU eviction', () => {
  const s = new CassetteStore();
  for (let i = 0; i < CASSETTE_CAP_PER_METHOD + 5; i++) s.add(mk(i));
  const kept = s.byMethod('listEvents');
  assert.equal(kept.length, CASSETTE_CAP_PER_METHOD);
  assert.equal(kept[0].recordedAt, 5); // 0..4 evicted
});

test('matchRequest is exact: a different query string is a different request', () => {
  const s = new CassetteStore([mk(1)]);
  assert.ok(s.matchRequest({ method: 'GET', url: 'https://example.test/events?q=1' }));
  // ?q=other is NOT ?q=1 — serving it would defeat argument-dependent replay.
  assert.equal(s.matchRequest({ method: 'GET', url: 'https://example.test/events?q=other' }), undefined);
  assert.equal(s.matchRequest({ method: 'GET', url: 'https://elsewhere.test/events' }), undefined);
});

test('matchRequestLoose falls back to host+path when no exact match exists', () => {
  const s = new CassetteStore([mk(1)]);
  assert.ok(s.matchRequestLoose({ method: 'GET', url: 'https://example.test/events?q=1' }));
  assert.ok(s.matchRequestLoose({ method: 'GET', url: 'https://example.test/events?q=other' }));
  assert.equal(s.matchRequestLoose({ method: 'GET', url: 'https://elsewhere.test/events' }), undefined);
});

test('toJSON/fromJSON round-trips and skips malformed entries', () => {
  const s = new CassetteStore([mk(1), mk(2)]);
  const back = CassetteStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.all().length, 2);
  assert.equal(back.all()[0].rawBody, '[{"id":1}]');
  const dirty = CassetteStore.fromJSON([mk(3), { junk: true }, 42]);
  assert.equal(dirty.all().length, 1);
});

test('fromJSON derives rawBody for entries recorded before it existed', () => {
  const legacy = { ...mk(7) } as Partial<Cassette>;
  delete legacy.rawBody;
  const store = CassetteStore.fromJSON([legacy]);
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0].rawBody, JSON.stringify([{ id: 7 }]));
});

test('two POSTs to one url with different bodies are distinct cassettes', () => {
  const store = new CassetteStore();
  const base = { method: 'send', args: {}, parsedOutput: 'x', recordedAt: 1 };
  store.add({ ...base, request: { method: 'POST', url: 'https://x.test/api', body: { amount: 1 } },
    response: { status: 200, body: 'a' }, rawBody: 'a' });
  store.add({ ...base, request: { method: 'POST', url: 'https://x.test/api', body: { amount: 2 } },
    response: { status: 200, body: 'b' }, rawBody: 'b' });
  const hit = store.matchRequest({ method: 'POST', url: 'https://x.test/api', body: { amount: 2 } });
  assert.equal(hit?.rawBody, 'b');
});

test('omitting the body does not match a cassette recorded FOR a body', () => {
  const store = new CassetteStore();
  store.add({ method: 'send', args: {},
    request: { method: 'POST', url: 'https://x.test/api', body: { amount: 1 } },
    response: { status: 200, body: 'a' }, rawBody: 'a', parsedOutput: 'a', recordedAt: 1 });
  assert.equal(store.matchRequest({ method: 'POST', url: 'https://x.test/api' }), undefined);
});

test('legacy body-less cassettes still match body-less requests', () => {
  const store = new CassetteStore([mk(1)]);
  assert.notEqual(store.matchRequest({ method: 'GET', url: 'https://example.test/events?q=1' }), undefined);
});

test('body key order does not decide a match', () => {
  const store = new CassetteStore();
  store.add({ method: 'send', args: {},
    request: { method: 'POST', url: 'https://x.test/api', body: { a: 1, b: 2 } },
    response: { status: 200, body: 'a' }, rawBody: 'a', parsedOutput: 'a', recordedAt: 1 });
  assert.notEqual(store.matchRequest({ method: 'POST', url: 'https://x.test/api', body: { b: 2, a: 1 } }), undefined);
});

test('secret query params are redacted before storage', () => {
  const store = new CassetteStore();
  store.add({ method: 'get', args: {},
    request: { method: 'GET', url: 'https://x.test/a?api_key=hunter2&q=1' },
    response: { status: 200, body: 1 }, rawBody: '1', parsedOutput: 1, recordedAt: 1 });
  const url = store.all()[0].request.url;
  assert.doesNotMatch(url, /hunter2/);
  assert.match(url, /q=1/);
});
