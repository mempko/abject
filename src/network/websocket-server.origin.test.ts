import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { NodeWebSocketServer, type WsServerConfig } from './websocket-server.js';
import { allowOrigins, refuseAllOrigins } from './origin-policy.js';
import { AbjectClient } from '../../cli/client.js';

const CLIENT_ORIGIN = 'http://127.0.0.1:5174';

async function startServer(config: Partial<WsServerConfig> = {}): Promise<{ server: NodeWebSocketServer; port: number }> {
  const server = new NodeWebSocketServer({ port: 0, host: '127.0.0.1', heartbeatMs: 0, ...config });
  await server.ready();
  const port = server.port;
  assert.ok(port, 'server is bound');
  return { server, port };
}

/** Open a WebSocket the way a page of `origin` would (no origin: as a non-browser client). */
function connect(port: number, origin?: string): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ ok: false, status: res.statusCode ?? 0, body }));
    });
    ws.once('error', reject);
  });
}

test('a page of a foreign origin is answered 403 and never reaches the server', async () => {
  const { server, port } = await startServer({ allowOrigin: allowOrigins([CLIENT_ORIGIN]) });
  let connections = 0;
  server.onConnection(() => { connections++; });
  try {
    const result = await connect(port, 'https://evil.example');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.match(result.body, /may not open this WebSocket/);
    }
    assert.equal(connections, 0);
    assert.equal(server.clientCount, 0);
  } finally {
    await server.close();
  }
});

test('a page of an allowed origin connects', async () => {
  const { server, port } = await startServer({ allowOrigin: allowOrigins([CLIENT_ORIGIN]) });
  try {
    const result = await connect(port, CLIENT_ORIGIN);
    assert.equal(result.ok, true);
    if (result.ok) result.ws.close();
  } finally {
    await server.close();
  }
});

test('a client that is not a browser sends no Origin and connects even when every page is refused', async () => {
  const { server, port } = await startServer({ allowOrigin: refuseAllOrigins });
  try {
    const result = await connect(port);
    assert.equal(result.ok, true);
    if (result.ok) result.ws.close();
  } finally {
    await server.close();
  }
});

test('commune still completes its handshake with a gateway that refuses every page', async () => {
  // As CliServer is configured, answering the handshake as it does with auth off.
  const { server, port } = await startServer({ allowOrigin: refuseAllOrigins });
  server.onConnection((ws) => ws.send(JSON.stringify({ type: 'authNotRequired' })));
  const client = new AbjectClient({
    url: `ws://127.0.0.1:${port}`,
    getCredentials: async () => null,
    onEvent: () => {},
    onClose: () => {},
  });
  try {
    await client.connect();
  } finally {
    client.close();
    await server.close();
  }
});

test('without a policy every page may connect, as before', async () => {
  const { server, port } = await startServer();
  try {
    const result = await connect(port, 'https://evil.example');
    assert.equal(result.ok, true);
    if (result.ok) result.ws.close();
  } finally {
    await server.close();
  }
});

test('plain HTTP requests still reach onHttpRequest', async () => {
  const { server, port } = await startServer({
    allowOrigin: refuseAllOrigins,
    onHttpRequest: (req, res) => {
      if (req.url !== '/healthz') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return true;
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await server.close();
  }
});

test('close() still releases the port with a connection open', async () => {
  const { server, port } = await startServer({ allowOrigin: allowOrigins([CLIENT_ORIGIN]) });
  const result = await connect(port, CLIENT_ORIGIN);
  assert.equal(result.ok, true);
  await server.close();

  const again = new NodeWebSocketServer({ port, host: '127.0.0.1', heartbeatMs: 0 });
  await again.ready();
  await again.close();
});
