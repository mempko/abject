/**
 * WebGateway `http` entries: an abject that serves whole HTTP requests.
 *
 * A web portal needs more than method calls with JSON: pages, sign-in
 * redirects, session cookies, webhooks with their raw body. An `http` entry
 * hands every request under /<workspace>/<abject> to one handler, which
 * answers with status, headers, cookies and body. The gateway keeps what is
 * not the handler's to decide: hop-by-hop headers, cookie scoping to the
 * route, and errors that do not leak the handler's internals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { MessageBus } from '../runtime/message-bus.js';
import { Abject } from '../core/abject.js';
import { Registry } from './registry.js';
import { WebGateway, type WebRequest, type WebResponse } from './web-gateway.js';
import { WebExposure } from './web-exposure.js';
import { SessionStore } from '../../server/auth.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, AbjectMessage, InterfaceId } from '../core/types.js';

function manifestFor(name: string, methods: string[]): AbjectManifest {
  return {
    name, description: `${name} fixture`, version: '1.0.0',
    interface: {
      id: `abjects:${name.toLowerCase()}` as InterfaceId, name, description: name,
      methods: methods.map((m) => ({ name: m, description: m, parameters: [] })),
    },
    requiredCapabilities: [], providedCapabilities: [], tags: ['test'],
  } as unknown as AbjectManifest;
}

/** A small portal: a page, a sign-in redirect that sets a session, a webhook. */
class Portal extends Abject {
  seen: WebRequest[] = [];
  constructor() {
    super({ manifest: manifestFor('Portal', ['handleHttp']) });
    this.on('handleHttp', (msg: AbjectMessage): WebResponse => {
      const req = msg.payload as WebRequest;
      this.seen.push(req);
      switch (`${req.method} ${req.path}`) {
        case 'GET /':
          return { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '1', 'Set-Cookie': 'sneaky=1' },
            body: `<h1>Portal</h1><p>${String(req.query.org)}</p>` };
        case 'GET /login':
          return { redirect: `${req.basePath}/callback?state=xyz`,
            cookies: [{ name: 'session', value: 'abc def;1' }, { name: 'old', value: null }] };
        case 'GET /me':
          return { json: { session: req.cookies.session ?? null } };
        case 'POST /webhook':
          return { status: 202, json: { got: req.body, type: req.headers['content-type'], signature: req.headers['x-signature'] } };
        case 'POST /upload':
          return { json: { bytes: Buffer.from(req.bodyBase64 ?? '', 'base64').length, text: req.body ?? null } };
        case 'GET /bad-header':
          return { headers: { 'X-Bad': 'a\r\nInjected: yes' }, body: 'x' };
        case 'GET /throw':
          throw new Error('database password is hunter2');
        default:
          return { status: 404, body: 'not here' };
      }
    });
  }
}

/** No handleHttp declared. */
class NoHandler extends Abject {
  constructor() { super({ manifest: manifestFor('NoHandler', ['greet']) }); this.on('greet', () => 'hi'); }
}

class RegistryStub extends Abject {
  constructor(private readonly objects: Abject[]) {
    super({ manifest: manifestFor('RegistryStub', []) });
    this.on('discover', (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.objects.filter((o) => o.manifest.name === name).map((o) => ({ id: o.id, manifest: o.manifest, name: o.manifest.name }));
    });
  }
  ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function send(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test('an http entry serves pages, redirects with route-scoped cookies, webhooks and binary bodies', async () => {
  const bus = new MessageBus();
  const registry = new Registry();
  await registry.init(bus);
  const portal = new Portal();
  await portal.init(bus);
  const noHandler = new NoHandler();
  await noHandler.init(bus);
  const stub = new RegistryStub([portal, noHandler]);
  await stub.init(bus);
  const sessions = new SessionStore();
  const gw = new WebGateway({ port: 0, bind: '127.0.0.1', authConfig: { enabled: false, username: '', password: '' }, sessions });
  await gw.init(bus);
  try {
    await stub.ask(gw.id, 'syncWorkspace', {
      workspaceId: 'ws-acme', name: 'Acme', slug: 'acme', registryId: stub.id, enabled: true,
      entries: {
        Portal: { access: 'public', methods: null, mode: 'http' },
        NoHandler: { access: 'public', methods: null, mode: 'http' },
      },
    });
    await stub.ask(gw.id, 'setEnabled', { enabled: true });
    const port = await stub.ask<number>(gw.id, 'getPort');

    const page = await send(port, 'GET', '/acme/portal?org=acme&org=beta');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.equal(page.body, '<h1>Portal</h1><p>acme,beta</p>');
    assert.equal(page.headers['set-cookie'], undefined, 'a Set-Cookie header is dropped; cookies go through `cookies`');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(portal.seen.at(-1)!.query, { org: ['acme', 'beta'] });
    assert.equal(portal.seen.at(-1)!.basePath, '/acme/portal');

    const login = await send(port, 'GET', '/acme/portal/login');
    assert.equal(login.status, 302);
    assert.equal(login.headers.location, '/acme/portal/callback?state=xyz');
    assert.deepEqual(login.headers['set-cookie'], [
      'session=abc%20def%3B1; Path=/acme/portal; HttpOnly; SameSite=Lax',
      'old=; Path=/acme/portal; Max-Age=0; HttpOnly; SameSite=Lax',
    ], 'scoped to the route, so another workspace\'s portal on this host never receives it');

    const me = await send(port, 'GET', '/acme/portal/me', { headers: { cookie: 'session=abc%20def%3B1; other=x' } });
    assert.deepEqual(JSON.parse(me.body), { session: 'abc def;1' });

    const hook = await send(port, 'POST', '/acme/portal/webhook', {
      headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
      body: '{"event":"paid"}',
    });
    assert.equal(hook.status, 202);
    assert.deepEqual(JSON.parse(hook.body), { got: '{"event":"paid"}', type: 'application/json', signature: 'sha256=deadbeef' },
      'the raw body, byte for byte, so a signature over it can be checked');

    const upload = await send(port, 'POST', '/acme/portal/upload', {
      headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2, 255, 254]),
    });
    assert.deepEqual(JSON.parse(upload.body), { bytes: 5, text: null });

    const injected = await send(port, 'GET', '/acme/portal/bad-header');
    assert.equal(injected.status, 500);
    assert.equal(injected.headers.injected, undefined, 'no header injection');

    const thrown = await send(port, 'GET', '/acme/portal/throw');
    assert.equal(thrown.status, 500);
    assert.doesNotMatch(thrown.body, /hunter2/, 'the handler\'s error is logged, not shown to the public');

    const missing = await send(port, 'GET', '/acme/nohandler');
    assert.equal(missing.status, 500);
    assert.match(missing.body, /not available/);

    const routes = await stub.ask<Array<{ abject: string; mode: string }>>(gw.id, 'getRoutes');
    assert.equal(routes.find((r) => r.abject === 'Portal')?.mode, 'http');
  } finally {
    await stub.ask(gw.id, 'setEnabled', { enabled: false }).catch(() => {});
    sessions.destroy();
  }
});

test('saving exposure from the settings window keeps an http entry\'s mode', () => {
  const exposure = new WebExposure() as unknown as {
    config: { enabled: boolean; entries: Record<string, unknown> };
    sanitize(input: unknown): { entries: Record<string, { mode?: string; handler?: string; access: string }> };
  };
  exposure.config = { enabled: true, entries: { Portal: { access: 'public', methods: null, mode: 'http', handler: 'serve' } } };
  // The settings window knows only access levels and rewrites every entry.
  const saved = exposure.sanitize({ enabled: true, entries: { Portal: { access: 'public', methods: null }, Api: { access: 'authenticated', methods: null } } });
  assert.deepEqual(saved.entries.Portal, { access: 'public', methods: null, mode: 'http', handler: 'serve' });
  assert.equal(saved.entries.Api.mode, undefined);
  // Saying "methods" explicitly does switch it back.
  const switched = exposure.sanitize({ enabled: true, entries: { Portal: { access: 'public', methods: null, mode: 'methods' } } });
  assert.equal(switched.entries.Portal.mode, undefined);
});
