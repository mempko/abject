/**
 * The private-address guard shared by HttpClient and StreamClient
 * (capabilities/address-policy.ts): private and internal destinations are
 * refused on what a host resolves to, unless listed under Private hosts in
 * Settings > Permissions, and HttpClient applies the same checks to every
 * redirect hop.
 *
 * Real local servers on 127.0.0.1 stand in for internal services. Name
 * resolution is injected where a test needs a name to resolve somewhere
 * specific, so nothing here touches real DNS except `localhost`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';

import {
  AddressPolicy, HostLookup, NetworkPolicyError, isPrivateAddress, parsePrivateHost,
} from './capabilities/address-policy.js';
import { HttpClient } from './capabilities/http-client.js';
import { StreamClient } from './capabilities/stream-client.js';
import { Runtime } from '../runtime/runtime.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, AbjectMessage, InterfaceId } from '../core/types.js';

/** Name resolution from a fixed table. A list of answers is served in turn
 *  (the last one repeats), which is how a rebinding DNS server behaves. */
function fakeLookup(table: Record<string, string | string[] | string[][]>): HostLookup {
  const calls = new Map<string, number>();
  return async (hostname) => {
    const entry = table[hostname];
    if (entry === undefined) {
      const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    const answers = Array.isArray(entry) && Array.isArray(entry[0]) ? entry as string[][] : [[entry].flat() as string[]];
    const n = calls.get(hostname) ?? 0;
    calls.set(hostname, n + 1);
    return answers[Math.min(n, answers.length - 1)].map((address): LookupAddress => ({
      address, family: address.includes(':') ? 6 : 4,
    }));
  };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  assert.fail('expected the request to be refused');
}

interface Hit { url: string; method: string; headers: http.IncomingHttpHeaders; body: string }

/** A local HTTP server that records every request it receives. */
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('private, loopback, link-local and reserved addresses are recognised, in every spelling', () => {
  const privateOnes = [
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fd00::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a00:1',
    'not-an-address',
  ];
  const publicOnes = ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'];
  for (const a of privateOnes) assert.equal(isPrivateAddress(a), true, `${a} is private`);
  for (const a of publicOnes) assert.equal(isPrivateAddress(a), false, `${a} is public`);
});

test('Private hosts entries: names, wildcards, addresses with or without a port, and ranges', () => {
  for (const ok of [
    'localhost', 'localhost:11434', 'MODELS.Internal.', '*.corp.example', 'host_name.lan',
    '127.0.0.1', '127.0.0.1:8080', '::1', '[::1]', '[::1]:8080', '10.0.0.0/8', 'fd00::/8', ' 192.168.0.0/16 ',
  ]) {
    assert.ok(parsePrivateHost(ok), `${ok} parses`);
  }
  for (const bad of [
    '', '   ', 'http://localhost', 'a b', 'host:0', 'host:70000', 'host:port', '10.0.0.0/33', '10.0.0.0/',
    'example/8', '[::1', '*', '*.', 'host:80:90',
  ]) {
    assert.equal(parsePrivateHost(bad), undefined, `${JSON.stringify(bad)} is refused`);
  }
  const policy = new AddressPolicy(['LocalHost:11434', 'not a host', '10.0.0.0/8']);
  assert.deepEqual(policy.entries, ['localhost:11434', '10.0.0.0/8'], 'invalid entries are dropped, the rest normalised');
});

test('a name is judged by every address it resolves to', async () => {
  const lookup = fakeLookup({
    'public.example': '93.184.216.34',
    'sneaky.example': '10.0.0.5',
    'split.example': ['93.184.216.34', '127.0.0.1'],
    'localhost': ['::1', '127.0.0.1'],
    'models.internal': '10.1.2.3',
    'gpu.corp.example': '10.9.9.9',
    'corp.example': '10.9.9.10',
  });
  const closed = new AddressPolicy([], lookup);
  await closed.check('public.example', 443);

  const err = await refusal(closed.check('sneaky.example', 443));
  assert.ok(err instanceof NetworkPolicyError);
  assert.match(err.message, /sneaky\.example resolves to 10\.0\.0\.5/);
  assert.match(err.message, /add "sneaky\.example:443" to Private hosts/);
  await refusal(closed.check('split.example', 443));
  await refusal(closed.check('127.0.0.1', 80));
  await refusal(closed.check('[::ffff:7f00:1]', 80));

  const open = new AddressPolicy(['models.internal:8000', '*.corp.example', '127.0.0.1:9000', '10.0.0.0/8'], lookup);
  await open.check('models.internal', 8000);
  await open.check('MODELS.INTERNAL.', 8000);
  await open.check('models.internal', 1234); // also inside 10.0.0.0/8
  await open.check('gpu.corp.example', 443);
  await open.check('127.0.0.1', 9000);
  await open.check('[::ffff:7f00:1]', 9000);
  await refusal(open.check('127.0.0.1', 9001));
  await refusal(open.check('localhost', 9000)); // ::1 is not covered by 127.0.0.1

  const named = new AddressPolicy(['localhost:9000', 'models.internal:8000'], lookup);
  await named.check('localhost', 9000);
  await refusal(named.check('localhost', 9001));
  await refusal(named.check('models.internal', 8001));
  await refusal(new AddressPolicy(['*.corp.example'], lookup).check('corp.example', 443)); // not the apex
});

test('the connect-time lookup refuses a name whose DNS answer turned private after the first check', async () => {
  const lookup = fakeLookup({ 'rebind.example': [['93.184.216.34'], ['127.0.0.1']] });
  const policy = new AddressPolicy([], lookup);
  await policy.check('rebind.example', 80); // first answer: public

  const connectLookup = policy.connectLookup(80);
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    connectLookup('rebind.example', { all: true }, (e) => resolve(e));
  });
  assert.ok(err instanceof NetworkPolicyError, 'the second answer is refused where the socket would use it');

  type Answer = { err: NodeJS.ErrnoException | null; address: unknown; family?: number };
  const resolveWith = (policy: AddressPolicy, host: string, options: { all?: boolean; family?: number }) =>
    new Promise<Answer>((resolve) => {
      policy.connectLookup(80)(host, options, (e, address, family) => resolve({ err: e, address, family }));
    });
  const lookup2 = fakeLookup({ 'dual.example': ['10.0.0.7', 'fd00::7'] });

  const one = await resolveWith(new AddressPolicy(['10.0.0.0/8', 'fd00::/8'], lookup2), 'dual.example', { family: 6 });
  assert.deepEqual(one, { err: null, address: 'fd00::7', family: 6 }, 'one address of the asked family');
  const all = await resolveWith(new AddressPolicy(['10.0.0.0/8', 'fd00::/8'], lookup2), 'dual.example', { all: true });
  assert.deepEqual((all.address as LookupAddress[]).map(a => a.address), ['10.0.0.7', 'fd00::7']);

  const partial = await resolveWith(new AddressPolicy(['10.0.0.0/8'], lookup2), 'dual.example', { family: 4 });
  assert.ok(partial.err instanceof NetworkPolicyError, 'every private answer must be covered, whatever family the socket asks for');
});

test('HttpClient refuses private hosts by default and reaches the ones the owner listed', async () => {
  const srv = await serve((_req, res) => res.end('internal'));
  try {
    const closed = new HttpClient();
    const started = Date.now();
    const err = await refusal(closed.makeRequest({ method: 'GET', url: `${srv.base}/` }));
    assert.ok(err instanceof NetworkPolicyError);
    assert.ok(Date.now() - started < 900, 'a refusal is not retried with backoff');
    await refusal(closed.makeRequest({ method: 'GET', url: `http://localhost:${srv.port}/` }));
    await refusal(closed.fetchBase64(`${srv.base}/`));

    const sneaky = new HttpClient({ lookup: fakeLookup({ 'internal.example': '10.0.0.5' }) });
    const viaName = await refusal(sneaky.makeRequest({ method: 'GET', url: 'https://internal.example/' }));
    assert.match(viaName.message, /resolves to 10\.0\.0\.5/, 'a public-looking name pointing inside is caught');
    assert.equal(srv.hits.length, 0, 'nothing reached the server');

    const open = new HttpClient({ privateHosts: [`127.0.0.1:${srv.port}`] });
    const res = await open.makeRequest({ method: 'GET', url: `${srv.base}/` });
    assert.deepEqual({ status: res.status, body: res.body }, { status: 200, body: 'internal' });
    const b64 = await open.fetchBase64(`${srv.base}/`);
    assert.equal(Buffer.from(b64.dataUri.split(',')[1], 'base64').toString(), 'internal');
    await refusal(open.makeRequest({ method: 'GET', url: `http://127.0.0.1:${srv.port + 1}/` }));

    const byName = new HttpClient({ privateHosts: [`localhost:${srv.port}`] });
    const named = await byName.makeRequest({ method: 'GET', url: `http://localhost:${srv.port}/` });
    assert.equal(named.body, 'internal');
  } finally {
    await srv.close();
  }
});

test('HttpClient checks every redirect hop and follows fetch\'s redirect rules', async () => {
  const secret = await serve((_req, res) => res.end('metadata'));
  const other = await serve((_req, res) => res.end('other origin'));
  const app = await serve((req, res) => {
    const to = (status: number, location: string) => { res.writeHead(status, { Location: location }); res.end(); };
    switch (req.url) {
      case '/to-secret': return to(302, `${secret.base}/latest/meta-data`);
      case '/to-final': return to(301, '/final');
      case '/post-302': return to(302, '/final');
      case '/post-307': return to(307, '/final');
      case '/to-other': return to(302, `${other.base}/landing`);
      case '/to-file': return to(302, 'file:///etc/passwd');
      case '/loop': return to(302, '/loop');
      default: return res.end(`final ${req.method}`);
    }
  });
  try {
    const client = new HttpClient({ privateHosts: [`127.0.0.1:${app.port}`, `127.0.0.1:${other.port}`] });

    const blocked = await refusal(client.makeRequest({ method: 'GET', url: `${app.base}/to-secret` }));
    assert.ok(blocked instanceof NetworkPolicyError);
    assert.match(blocked.message, new RegExp(`127\\.0\\.0\\.1:${secret.port}`));
    assert.equal(secret.hits.length, 0, 'the redirect target was never contacted');

    const followed = await client.makeRequest({ method: 'GET', url: `${app.base}/to-final` });
    assert.equal(followed.body, 'final GET');

    await client.makeRequest({
      method: 'POST', url: `${app.base}/post-302`, body: '{"a":1}', headers: { 'Content-Type': 'application/json' },
    });
    const after302 = app.hits.at(-1)!;
    assert.deepEqual([after302.method, after302.body, after302.headers['content-type']], ['GET', '', undefined],
      '302 after a POST continues as a body-less GET');

    await client.makeRequest({ method: 'POST', url: `${app.base}/post-307`, body: 'keep me' });
    const after307 = app.hits.at(-1)!;
    assert.deepEqual([after307.method, after307.body], ['POST', 'keep me'], '307 keeps the method and body');

    await client.makeRequest({
      method: 'GET', url: `${app.base}/to-other`,
      headers: { Authorization: 'Bearer s3cret', 'x-api-key': 'k', Accept: 'text/plain' },
    });
    const landed = other.hits.at(-1)!;
    assert.equal(landed.headers.authorization, undefined, 'credentials stay with the origin they were meant for');
    assert.equal(landed.headers['x-api-key'], undefined);
    assert.equal(landed.headers.accept, 'text/plain');
    assert.equal(app.hits.find(h => h.url === '/to-other')?.headers.authorization, 'Bearer s3cret');

    assert.match((await refusal(client.makeRequest({ method: 'GET', url: `${app.base}/to-file` }))).message, /Scheme file:/);
    assert.match((await refusal(client.makeRequest({ method: 'GET', url: `${app.base}/loop` }))).message, /Too many redirects/);
  } finally {
    await Promise.all([secret.close(), other.close(), app.close()]);
  }
});

function manifestFor(name: string): AbjectManifest {
  return {
    name,
    description: `${name} test object`,
    version: '1.0.0',
    interface: { id: `abjects:test:${name.toLowerCase()}` as InterfaceId, name, description: name, methods: [] },
    requiredCapabilities: [],
    providedCapabilities: [],
    tags: ['test'],
  } as unknown as AbjectManifest;
}

/** Stands in for GlobalSettings (the permissions authority) and for an object
 *  using the network capabilities; collects the stream events it is sent. */
class Probe extends Abject {
  events: Array<{ aspect: string; value: Record<string, unknown> }> = [];
  constructor() {
    super({ manifest: manifestFor('NetProbe') });
    this.on('changed', (m: AbjectMessage) => {
      this.events.push(m.payload as { aspect: string; value: Record<string, unknown> });
    });
  }
  ask<T>(to: AbjectId, method: string, payload: unknown = {}, timeoutMs = 10_000): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload), timeoutMs);
  }
  async until(aspect: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(e => e.aspect === aspect);
      if (hit) return hit.value;
      if (Date.now() > deadline) assert.fail(`no ${aspect} event within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

test('Private hosts arrive with updatePermissions from the authority and govern both capabilities', async () => {
  const sse = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: hello\n\n');
  });
  const rt = new Runtime();
  await rt.start();
  try {
    const httpClient = new HttpClient();
    const streams = new StreamClient({ lookup: fakeLookup({ 'feed.internal': '127.0.0.1' }) });
    const probe = new Probe();
    for (const o of [httpClient, streams, probe]) await rt.objectFactory.spawnInstance(o);
    for (const cap of [httpClient, streams]) await probe.ask(cap.id, 'setPermissionsAuthority');

    await assert.rejects(probe.ask(httpClient.id, 'get', { url: `${sse.base}/` }), /private or internal address/);
    await assert.rejects(probe.ask(streams.id, 'connect', { url: `${sse.base}/events`, kind: 'sse' }), /private or internal address/);
    await assert.rejects(probe.ask(streams.id, 'connect', { url: `http://feed.internal:${sse.port}/`, kind: 'sse' }),
      /feed\.internal resolves to 127\.0\.0\.1/);

    const entries = [`127.0.0.1:${sse.port}`, `feed.internal:${sse.port}`];
    for (const cap of [httpClient, streams]) {
      assert.deepEqual(await probe.ask(cap.id, 'updatePermissions', { privateHosts: entries }), { success: true });
    }

    await probe.ask(streams.id, 'addDependent');
    const { connectionId } = await probe.ask<{ connectionId: string }>(streams.id, 'connect', { url: `http://feed.internal:${sse.port}/events`, kind: 'sse' });
    const message = await probe.until('streamMessage');
    assert.deepEqual([message.connectionId, message.data], [connectionId, 'hello'], 'the stream connected through the guarded lookup');
    await probe.ask(streams.id, 'disconnect', { connectionId });

    await probe.ask(httpClient.id, 'updatePermissions', { enabled: false });
    await assert.rejects(probe.ask(httpClient.id, 'getBase64', { url: `${sse.base}/` }), /Web access is disabled/,
      'getBase64 honours the master switch too');
  } finally {
    await rt.stop();
    await sse.close();
  }
});

test('StreamClient refuses at connect time when the name rebinds to a private address', async () => {
  const sse = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: x\n\n'); });
  const rt = new Runtime();
  await rt.start();
  try {
    // First answer (the up-front check) is public, the second (the socket's) is the local server.
    const streams = new StreamClient({ lookup: fakeLookup({ 'rebind.example': [['93.184.216.34'], ['127.0.0.1']] }) });
    const probe = new Probe();
    for (const o of [streams, probe]) await rt.objectFactory.spawnInstance(o);
    await probe.ask(streams.id, 'addDependent');
    await probe.ask(streams.id, 'connect', { url: `http://rebind.example:${sse.port}/`, kind: 'sse' });
    const failure = await probe.until('streamError');
    assert.match(String(failure.error), /rebind\.example resolves to 127\.0\.0\.1/);
    assert.equal(sse.hits.length, 0, 'the local server was never reached');
  } finally {
    await rt.stop();
    await sse.close();
  }
});
