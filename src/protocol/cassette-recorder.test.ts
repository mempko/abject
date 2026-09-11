/** Run: pnpm tsx --test src/protocol/cassette-recorder.test.ts */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRecorder, clearRecorder, beforeRequest, afterResponse } from './cassette-recorder.js';
import { CassetteStore, HTTP_CASSETTE_METHOD } from './cassette.js';

afterEach(() => clearRecorder('obj-1'));

test('record mode captures 2xx with raw AND parsed body; non-2xx is not recorded', () => {
  const store = new CassetteStore();
  let persisted = 0;
  setRecorder('obj-1', { mode: 'record', store, onRecord: () => persisted++ });
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/a' },
    { status: 200, rawBody: '{"ok":1}' });
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/b' },
    { status: 500, rawBody: 'boom' });
  assert.equal(store.all().length, 1);
  assert.equal(persisted, 1);
  const [c] = store.all();
  assert.equal(c.method, HTTP_CASSETTE_METHOD);
  assert.equal(c.rawBody, '{"ok":1}');
  assert.deepEqual(c.parsedOutput, { ok: 1 });
});

test('a JSON string primitive survives the record/replay round-trip verbatim', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store });
  // The world sent the four characters `"hi"`; JSON.parse of that is `hi`.
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/s' },
    { status: 200, rawBody: '"hi"' });
  setRecorder('obj-1', { mode: 'replay', store });
  const hit = beforeRequest('obj-1', { method: 'GET', url: 'https://example.test/s' });
  assert.equal(hit?.rawBody, '"hi"');
});

test('replay mode serves recorded responses and throws on a miss', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store });
  afterResponse('obj-1', { method: 'GET', url: 'https://example.test/a' },
    { status: 200, rawBody: '{"ok":1}' });
  setRecorder('obj-1', { mode: 'replay', store });
  const hit = beforeRequest('obj-1', { method: 'GET', url: 'https://example.test/a' });
  assert.equal(hit?.status, 200);
  assert.equal(hit?.rawBody, '{"ok":1}');
  assert.throws(() => beforeRequest('obj-1', { method: 'GET', url: 'https://example.test/miss' }),
    /replay miss/);
});

test('unknown object id and live mode pass through', () => {
  assert.equal(beforeRequest(undefined, { method: 'GET', url: 'https://x.test/' }), undefined);
  assert.equal(beforeRequest('never-registered', { method: 'GET', url: 'https://x.test/' }), undefined);
});

test('afterResponse parses rawBody itself, only when recording', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store });
  afterResponse('obj-1', { method: 'GET', url: 'https://x.test/parse' },
    { status: 200, rawBody: '{"n":1}' });
  assert.deepEqual(store.all()[0].response.body, { n: 1 });
  assert.deepEqual(store.all()[0].parsedOutput, { n: 1 });
  assert.equal(store.all()[0].rawBody, '{"n":1}');
});

test('non-JSON rawBody records as the raw text', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store });
  afterResponse('obj-1', { method: 'GET', url: 'https://x.test/text' },
    { status: 200, rawBody: 'plain text' });
  assert.equal(store.all()[0].response.body, 'plain text');
});

test('redactPaths masks recorded response bodies at the declared paths', () => {
  const store = new CassetteStore();
  setRecorder('obj-1', { mode: 'record', store, redactPaths: ['user.ssn'] });
  afterResponse('obj-1', { method: 'GET', url: 'https://x.test/u' },
    { status: 200, rawBody: '{"user":{"ssn":"123-45-6789","name":"A"}}' });
  const rec = store.all()[0];
  assert.deepEqual(rec.response.body, { user: { ssn: 'REDACTED', name: 'A' } });
  assert.doesNotMatch(rec.rawBody, /123-45-6789/);
});
