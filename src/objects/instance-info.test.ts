/**
 * Headless operation: what an instance reports about itself, the local health
 * endpoint built on the same report, and worker heap ceilings sized to the
 * machine instead of a fixed 8 GB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Runtime } from '../runtime/runtime.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, InterfaceId } from '../core/types.js';
import { InstanceInfo, instanceReport, type InstanceInfoReport } from './instance-info.js';
import { NodeWebSocketServer } from '../network/websocket-server.js';
import { workerHeapMb } from '../../server/node-worker-adapter.js';

const GB = 1024 * 1024 * 1024;

class Probe extends Abject {
  constructor() {
    super({ manifest: { name: 'Probe', description: 'p', version: '1.0.0',
      interface: { id: 'test:probe' as InterfaceId, name: 'Probe', description: 'p', methods: [] },
      requiredCapabilities: [], providedCapabilities: [], tags: [] } as unknown as AbjectManifest });
  }
  ask<T>(to: AbjectId, method: string): Promise<T> { return this.request<T>(request(this.id, to, method, {})); }
}

test('InstanceInfo tells abjects the running version and whether boot has finished', async () => {
  let ready = false;
  const source = { version: '9.9.9', startedAt: Date.now() - 5000, workerCount: 3, ready: () => ready };
  const rt = new Runtime();
  await rt.start();
  try {
    const info = new InstanceInfo(source);
    const probe = new Probe();
    await rt.objectFactory.spawnInstance(info);
    await rt.objectFactory.spawnInstance(probe);
    const before = await probe.ask<InstanceInfoReport>(info.id, 'getInfo');
    assert.equal(before.version, '9.9.9');
    assert.equal(before.ready, false);
    assert.equal(before.workerCount, 3);
    assert.ok(before.uptimeSec >= 5);
    assert.equal(before.node, process.versions.node);
    ready = true;
    assert.equal((await probe.ask<InstanceInfoReport>(info.id, 'getInfo')).ready, true);
  } finally {
    await rt.stop();
  }
});

test('the UI port answers health checks from the same report: 503 while booting, 200 once ready', async () => {
  let ready = false;
  const source = { version: '9.9.9', startedAt: Date.now(), workerCount: 0, ready: () => ready };
  const server = new NodeWebSocketServer({
    port: 0, host: '127.0.0.1', heartbeatMs: 0,
    onHttpRequest: (req, res) => {
      if (req.url !== '/healthz') return false;
      const report = instanceReport(source);
      res.writeHead(report.ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: report.ready ? 'ok' : 'starting', ...report }));
      return true;
    },
  });
  try {
    await server.ready();
    const port = ((server as unknown as { httpServer: http.Server }).httpServer.address() as { port: number }).port;
    const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    assert.equal((await get('/healthz')).status, 503);
    ready = true;
    const ok = await get('/healthz');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).version, '9.9.9');
    assert.match((await get('/')).body, /WebSocket endpoint/, 'other paths keep the old answer');
  } finally {
    await server.close();
  }
});

test('worker heap ceilings are shared out of the machine\'s memory, between 512 MB and 8 GB', () => {
  const saved = process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB;
  delete process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB;
  try {
    assert.equal(workerHeapMb(4 * GB, 3), 896, 'a 4 GB VM with one pool worker plus UI and P2P');
    assert.equal(workerHeapMb(2 * GB, 3), 512, 'never below 512 MB');
    assert.equal(workerHeapMb(64 * GB, 4), 8192, 'never above the old 8 GB');
    process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB = '1500';
    assert.equal(workerHeapMb(64 * GB, 4), 1500, 'the environment still decides when set');
  } finally {
    if (saved === undefined) delete process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB;
    else process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB = saved;
  }
});
