/**
 * Web Gateway plain-HTTP regression tests.
 *
 *   WG-1  A plain HTTP GET to the gateway root returns 200 (never 426
 *         "Upgrade Required") once the gateway is enabled and a workspace
 *         exposes an abject.
 *   WG-2  A plain HTTP GET to a served route /<ws>/<abject> (abject named by
 *         its slugified form, e.g. 'EchoSvc' -> 'echosvc') returns the routed
 *         abject's interface page, not a protocol-upgrade demand.
 *   WG-3  A plain HTTP POST to /<ws>/<abject>/<method> invokes the abject
 *         over the bus and returns 200 with the result.
 *   WG-4  setPort(0) (automatic) rebinds an ephemeral port while serving;
 *         getPort reports the bound port.
 *
 * Run: npx tsx --test src/objects/web-gateway.plain-http.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { MessageBus } from '../runtime/message-bus.js';
import { Abject } from '../core/abject.js';
import { Registry } from './registry.js';
import { WebGateway } from './web-gateway.js';
import { SessionStore } from '../../server/auth.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, InterfaceId } from '../core/types.js';

function mkManifest(name: string): AbjectManifest {
  return {
    name,
    description: `${name} test fixture`,
    version: '1.0.0',
    interface: {
      id: `abjects:${name.toLowerCase()}` as InterfaceId,
      name,
      description: `${name} fixture interface`,
      methods: [
        { name: 'greet', description: 'Greet the caller', parameters: [], returns: { kind: 'primitive', primitive: 'string' } },
      ],
    },
    requiredCapabilities: [],
    providedCapabilities: [`abjects:test:${name.toLowerCase()}`],
    tags: ['test'],
  } as unknown as AbjectManifest;
}

/** The abject a workspace exposes over the web. */
class EchoSvc extends Abject {
  constructor() {
    super({ manifest: mkManifest('EchoSvc') });
    this.on('greet', () => 'hello from EchoSvc');
  }
}

/** Stand-in for a workspace registry: answers the gateway's discover calls. */
class DiscStub extends Abject {
  constructor(svcId: AbjectId, svcManifest: AbjectManifest) {
    super({ manifest: mkManifest('DiscStub') });
    this.on('discover', () => [{ id: svcId, manifest: svcManifest, name: svcManifest.name }]);
  }
  async ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

function httpPost(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('WebGateway serves plain HTTP routes without 426 Upgrade Required', async () => {
  const bus = new MessageBus();
  const registry = new Registry();
  await registry.init(bus);

  const svc = new EchoSvc();
  await svc.init(bus);

  const disc = new DiscStub(svc.id, mkManifest('EchoSvc'));
  await disc.init(bus);

  const sessions = new SessionStore();
  const gw = new WebGateway({
    port: 0,
    bind: '127.0.0.1',
    authConfig: { enabled: false, username: '', password: '' },
    sessions,
  });
  await gw.init(bus);

  try {
    // The workspace exposes EchoSvc publicly under slug 'demo'.
    const sync = await disc.ask<{ success: boolean }>(gw.id, 'syncWorkspace', {
      workspaceId: 'ws-demo',
      name: 'Demo',
      slug: 'demo',
      registryId: disc.id,
      enabled: true,
      entries: { EchoSvc: { access: 'public', methods: null } },
    });
    assert.equal(sync.success, true, 'syncWorkspace should succeed');

    // Enable the gateway: it must bind (port 0 = system finds a free port).
    const status1 = await disc.ask<{ enabled: boolean; listening: boolean; port: number }>(gw.id, 'setEnabled', { enabled: true });
    assert.equal(status1.enabled, true);
    assert.equal(status1.listening, true, 'gateway should be listening after setEnabled(true)');
    assert.ok(status1.port > 0, `bound port should be positive, got ${status1.port}`);
    const port = status1.port;

    // WG-1: plain GET / — must never be 426 / "Upgrade Required".
    const root = await httpGet(port, '/');
    assert.notEqual(root.status, 426, 'gateway root must not answer 426 Upgrade Required');
    assert.ok(!root.body.includes('Upgrade Required'), 'no upgrade-demand text on gateway root');
    assert.equal(root.status, 200, `gateway root should be 200, got ${root.status}: ${root.body.slice(0, 200)}`);
    assert.ok(root.body.includes('demo'), 'gateway root should list the exposed workspace slug');

    // WG-2: plain GET to a served route returns the abject's interface.
    const page = await httpGet(port, '/demo/echosvc');
    assert.notEqual(page.status, 426, 'served route must not answer 426 Upgrade Required');
    assert.equal(page.status, 200, `served route should be 200, got ${page.status}: ${page.body.slice(0, 200)}`);
    assert.ok(page.body.includes('EchoSvc'), 'abject page should name the abject');

    // WG-3: plain POST to a method route invokes the abject over the bus.
    const call = await httpPost(port, '/demo/echosvc/greet', {});
    assert.notEqual(call.status, 426, 'method route must not answer 426 Upgrade Required');
    assert.equal(call.status, 200, `method route should be 200, got ${call.status}: ${call.body.slice(0, 200)}`);
    const parsed = JSON.parse(call.body) as { ok: boolean; result: unknown };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result, 'hello from EchoSvc');

    // WG-4: setPort(0) (automatic) while serving — rebinds an ephemeral port.
    const status2 = await disc.ask<{ enabled: boolean; listening: boolean; port: number }>(gw.id, 'setPort', { port: 0 });
    assert.equal(status2.listening, true, 'gateway should still be listening after setPort');
    assert.ok(status2.port > 0, `rebound port should be positive, got ${status2.port}`);
    const root2 = await httpGet(status2.port, '/');
    assert.equal(root2.status, 200, 'gateway serves again on the rebound port');
    const portNow = await disc.ask<number>(gw.id, 'getPort');
    assert.equal(portNow, status2.port, 'getPort reports the bound port');
  } finally {
    await disc.ask(gw.id, 'setEnabled', { enabled: false }).catch(() => {});
    sessions.destroy();
  }
});
