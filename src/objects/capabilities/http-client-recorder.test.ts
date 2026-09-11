/** Run: pnpm tsx --test src/objects/capabilities/http-client-recorder.test.ts
 *
 * The wiring between HttpClient and the cassette seam. Hermetic: the global
 * fetch is replaced for the duration of each test and restored afterwards —
 * the replay test proves the network is never touched by making fetch throw.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from './http-client.js';
import { CassetteStore, type Cassette } from '../../protocol/cassette.js';
import { setRecorder, clearRecorder } from '../../protocol/cassette-recorder.js';

const CALLER = 'obj-under-test';
const realFetch = globalThis.fetch;

afterEach(() => {
  clearRecorder(CALLER);
  globalThis.fetch = realFetch;
});

const recorded: Cassette = {
  method: '_http', args: {},
  request: { method: 'GET', url: 'https://example.test/events' },
  response: { status: 200, body: [{ id: 1 }] },
  rawBody: '[{"id":1}]',
  parsedOutput: [{ id: 1 }],
  recordedAt: 1,
};

test('replay mode returns the full recorded HttpResponse without calling fetch', async () => {
  globalThis.fetch = (() => { throw new Error('fetch must not be called in replay mode'); }) as typeof fetch;
  setRecorder(CALLER, { mode: 'replay', store: new CassetteStore([recorded]) });

  const res = await new HttpClient().makeRequest(
    { method: 'GET', url: 'https://example.test/events' }, CALLER);

  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.statusText, '');
  assert.deepEqual(res.headers, {});
  assert.equal(res.body, '[{"id":1}]');       // raw text, verbatim
  assert.deepEqual(JSON.parse(res.body), [{ id: 1 }]);
});

test('record mode lands one cassette carrying the raw body', async () => {
  const store = new CassetteStore();
  let persisted = 0;
  setRecorder(CALLER, { mode: 'record', store, onRecord: () => persisted++ });
  globalThis.fetch = (async () => new Response('{"hello":"world"}', {
    status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  const res = await new HttpClient().makeRequest(
    { method: 'GET', url: 'https://example.test/hello' }, CALLER);

  assert.equal(res.body, '{"hello":"world"}');
  assert.equal(persisted, 1);
  assert.equal(store.all().length, 1);
  const [c] = store.all();
  assert.equal(c.request.url, 'https://example.test/hello');
  assert.equal(c.rawBody, '{"hello":"world"}');
  assert.deepEqual(c.parsedOutput, { hello: 'world' });
});

test('an unregistered caller neither replays nor records', async () => {
  const store = new CassetteStore();
  setRecorder(CALLER, { mode: 'record', store });
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;

  await new HttpClient().makeRequest({ method: 'GET', url: 'https://example.test/x' }, 'someone-else');
  assert.equal(store.all().length, 0);
});
