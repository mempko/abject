/**
 * WebGateway — the one object that listens for inbound HTTP.
 *
 * It turns whitelisted abjects into web routes. Nothing is registered by hand:
 * each workspace's WebExposure pushes which of its abjects are reachable, and
 * the gateway serves them:
 *
 *   GET  /                         index of workspaces that expose anything
 *   GET  /<workspace>/             the workspace's exposed abjects
 *   GET  /<workspace>/<abject>     the abject's generated interface (HTML, or
 *                                  JSON with Accept: application/json)
 *   GET  /<workspace>/<abject>/openapi.json
 *   POST /<workspace>/<abject>/<method>   invoke a method; JSON body is the
 *                                  payload, JSON reply is the result
 *
 * Workspaces and abjects are addressed by a slug of their registered name, so
 * routes survive restarts (AbjectIds do not). A method result maps to a status
 * code through the object's result contract: a domain failure is 422, an
 * unknown method 404, a denial 403, a timeout 504.
 *
 * Defaults are closed: the gateway is off until enabled, binds loopback unless
 * HTTP_BIND says otherwise, and serves nothing until a workspace whitelists an
 * abject. Public routes need no credential; authenticated routes take a bearer
 * token, either an API token minted here (stored only as a hash) or a session
 * token from the desktop's own web login.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { AbjectId, AbjectMessage, InterfaceId, AbjectManifest, MethodDeclaration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { require } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import type { AuthConfig, SessionStore } from '../../server/auth.js';
import type { WorkspaceExposure, WebExposureEntry } from './web-exposure.js';

const log = new Log('WebGateway');

const ENABLED_KEY = 'web-gateway:enabled';
const TOKENS_KEY = 'web-gateway:tokens';
const PORT_KEY = 'web-gateway:port';
const MAX_BODY_BYTES = 1024 * 1024;
const CALL_TIMEOUT_MS = 120_000;

/** Methods never reachable over HTTP whatever a whitelist says. */
const BLOCKED_METHODS = new Set([
  'describe', 'ask', 'getRegistry', 'ping', 'addDependent', 'removeDependent',
  'getSource', 'updateSource', 'updateManifest', 'probe', 'getResultContract',
  'checkpoint', 'snapshotTask', 'restoreTask',
]);

interface ApiToken { id: string; name: string; hash: string; createdAt: number; lastUsedAt?: number; }

export interface WebGatewayArgs { port: number; bind?: string; authConfig: AuthConfig; sessions: SessionStore; }

export class WebGateway extends Abject {
  private port: number;
  private readonly bind: string;
  private readonly authConfig: AuthConfig;
  private readonly sessions: SessionStore;
  private server?: http.Server;
  private storageId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private enabled = false;
  private tokens: ApiToken[] = [];
  /** Live exposure, keyed by workspace id. */
  private workspaces = new Map<string, WorkspaceExposure>();
  private lastResyncAt = 0;
  private resyncing?: Promise<void>;

  constructor(args: WebGatewayArgs) {
    super({
      manifest: {
        name: 'WebGateway',
        description:
          'The HTTP gateway. Serves whitelisted abjects as web routes at /<workspace>/<abject>, with an index at the root, generated interfaces, an OpenAPI document, and method invocation over POST. Public and authenticated (bearer-token) routes. Off by default and loopback-bound; a workspace opts abjects in through its WebExposure. Ask about routes, tokens, or how to reach an abject over HTTP.',
        version: '1.0.0',
        interface: {
          id: 'abjects:web-gateway' as InterfaceId,
          name: 'WebGateway',
          description: 'Inbound HTTP for abjects',
          methods: [
            { name: 'getStatus', description: 'Whether the gateway is on, its bound address and port, and how many routes are live.', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'setEnabled', description: 'Turn the HTTP listener on or off.', parameters: [{ name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'On or off' }], returns: { kind: 'object', properties: {} } },
            { name: 'getRoutes', description: 'The live routes: one entry per exposed abject, with its workspace, access level, and methods.', parameters: [], returns: { kind: 'array', elementType: { kind: 'object', properties: {} } } },
            { name: 'mintToken', description: 'Create an API token for authenticated routes. The plaintext is returned once and never stored.', parameters: [{ name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'A label for the token' }], returns: { kind: 'object', properties: {} } },
            { name: 'listTokens', description: 'The API tokens, by id and label (never the secret).', parameters: [], returns: { kind: 'array', elementType: { kind: 'object', properties: {} } } },
            { name: 'revokeToken', description: 'Revoke an API token by id.', parameters: [{ name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Token id' }], returns: { kind: 'object', properties: {} } },
            { name: 'setPort', description: 'Set the HTTP gateway port. 0 or null means automatic (the system picks a free port).', parameters: [{ name: 'port', type: { kind: 'primitive', primitive: 'number' }, description: 'TCP port; 0 = automatic' }], returns: { kind: 'object', properties: {} } },
            { name: 'syncWorkspace', description: "Update a workspace's exposure (called by its WebExposure).", parameters: [{ name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace id' }], returns: { kind: 'object', properties: {} } },
            { name: 'dropWorkspace', description: 'Forget a workspace (called when its WebExposure stops).', parameters: [{ name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace id' }], returns: { kind: 'object', properties: {} } },
            { name: 'getPort', description: 'The port the gateway listens on.', parameters: [], returns: { kind: 'primitive', primitive: 'number' } },
          ],
          events: [
            { name: 'gatewayChanged', description: 'The gateway status, routes, or tokens changed', payload: { kind: 'object', properties: {} } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.HTTP_SERVER_LISTEN],
        tags: ['system', 'web'],
      },
    });
    this.port = args.port;
    this.bind = args.bind ?? '127.0.0.1';
    this.authConfig = args.authConfig;
    this.sessions = args.sessions;

    this.on('getStatus', () => this.gwStatus());
    this.on('setEnabled', async (msg: AbjectMessage) => {
      const { enabled } = msg.payload as { enabled: boolean };
      await this.setEnabled(!!enabled);
      return this.gwStatus();
    });
    this.on('setPort', async (msg: AbjectMessage) => {
      const { port } = msg.payload as { port?: number | null };
      await this.setPort(typeof port === 'number' && Number.isFinite(port) ? Math.trunc(port) : 0);
      return this.gwStatus();
    });
    this.on('getRoutes', () => this.routes());
    this.on('mintToken', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name?: string };
      const secret = `abjk_${crypto.randomBytes(24).toString('base64url')}`;
      const token: ApiToken = { id: crypto.randomUUID(), name: (name ?? 'token').slice(0, 80), hash: this.hash(secret), createdAt: Date.now() };
      this.tokens.push(token);
      await this.persistTokens();
      this.changed('gatewayChanged', this.gwStatus());
      // The plaintext leaves exactly once, here.
      return { success: true, id: token.id, name: token.name, token: secret };
    });
    this.on('listTokens', () => this.tokens.map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })));
    this.on('revokeToken', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      const before = this.tokens.length;
      this.tokens = this.tokens.filter(t => t.id !== id);
      await this.persistTokens();
      this.changed('gatewayChanged', this.gwStatus());
      return { success: this.tokens.length < before };
    });
    this.on('syncWorkspace', (msg: AbjectMessage) => {
      const ws = msg.payload as WorkspaceExposure;
      if (!ws?.workspaceId || !ws.registryId) return { success: false, error: 'workspaceId and registryId required' };
      this.workspaces.set(ws.workspaceId, { ...ws, slug: this.uniqueSlug(ws.slug, ws.workspaceId) });
      this.changed('gatewayChanged', this.gwStatus());
      return { success: true };
    });
    this.on('dropWorkspace', (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      this.workspaces.delete(workspaceId);
      this.changed('gatewayChanged', this.gwStatus());
      return { success: true };
    });
    this.on('getPort', () => this.port);
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    if (this.storageId) {
      try {
        this.enabled = (await this.request<boolean | null>(request(this.id, this.storageId, 'get', { key: ENABLED_KEY }))) === true;
        this.tokens = (await this.request<ApiToken[] | null>(request(this.id, this.storageId, 'get', { key: TOKENS_KEY }))) ?? [];
        const storedPort = await this.request<number | null>(request(this.id, this.storageId, 'get', { key: PORT_KEY }));
        if (typeof storedPort === 'number' && Number.isInteger(storedPort) && storedPort > 0 && storedPort <= 65535) this.port = storedPort;
      } catch { /* first run */ }
    }
    // Rebuild the workspace map from scratch, so a gateway restart does not
    // depend on every WebExposure happening to push again. It also reruns
    // lazily on a request miss (workspaces may still be spawning at boot).
    await this.resyncAll();
    if (this.enabled) await this.startServer();
  }

  protected override async onStop(): Promise<void> {
    await this.stopServer();
  }

  /** Resync at most once every few seconds, sharing an in-flight pass. */
  private async ensureFresh(): Promise<void> {
    if (this.resyncing) { await this.resyncing; return; }
    if (Date.now() - this.lastResyncAt < 3000) return;
    this.resyncing = this.resyncAll().finally(() => { this.lastResyncAt = Date.now(); this.resyncing = undefined; });
    await this.resyncing;
  }

  // ── Recovery: ask every workspace what it exposes ──
  private async resyncAll(): Promise<void> {
    if (!this.workspaceManagerId) return;
    let detailed: Array<{ workspaceId: string; name: string; registryId: AbjectId }> = [];
    try {
      detailed = await this.request(request(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {}), 15_000);
    } catch { return; }
    for (const w of detailed) {
      try {
        const hits = await this.request<Array<{ id: AbjectId; name: string }>>(request(this.id, w.registryId, 'search', { query: 'WebExposure' }), 10_000);
        const exp = hits.find(h => h.name === 'WebExposure');
        if (!exp) continue;
        const config = await this.request<{ enabled: boolean; entries: Record<string, WebExposureEntry> }>(request(this.id, exp.id, 'getConfig', {}), 10_000);
        const { slugify } = await import('./web-exposure.js');
        this.workspaces.set(w.workspaceId, {
          workspaceId: w.workspaceId, name: w.name, slug: this.uniqueSlug(slugify(w.name, w.workspaceId), w.workspaceId),
          registryId: w.registryId, enabled: config.enabled, entries: config.entries,
        });
      } catch { /* a workspace without WebExposure simply is not served */ }
    }
  }

  private uniqueSlug(slug: string, workspaceId: string): string {
    for (const [id, ws] of this.workspaces) {
      if (id !== workspaceId && ws.slug === slug) return `${slug}-${workspaceId.slice(0, 4)}`;
    }
    return slug;
  }

  private hash(secret: string): string { return crypto.createHash('sha256').update(secret).digest('hex'); }

  private gwStatus() {
    let routeCount = 0;
    for (const ws of this.workspaces.values()) if (ws.enabled) routeCount += Object.keys(ws.entries).length;
    return { enabled: this.enabled, listening: !!this.server, bind: this.bind, port: this.port,
      baseUrl: `http://${this.bind === '0.0.0.0' ? 'localhost' : this.bind}:${this.port}/`,
      workspaces: [...this.workspaces.values()].filter(w => w.enabled).length, routes: routeCount, tokens: this.tokens.length };
  }

  private routes() {
    const out: Array<{ workspace: string; workspaceSlug: string; abject: string; access: string; methods: string[] | null; path: string }> = [];
    for (const ws of this.workspaces.values()) {
      if (!ws.enabled) continue;
      for (const [name, e] of Object.entries(ws.entries)) {
        out.push({ workspace: ws.name, workspaceSlug: ws.slug, abject: name, access: e.access, methods: e.methods, path: `/${ws.slug}/${this.slug(name)}` });
      }
    }
    return out;
  }

  private slug(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  private async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (this.storageId) { try { await this.request(request(this.id, this.storageId, 'set', { key: ENABLED_KEY, value: enabled })); } catch { /* best effort */ } }
    if (enabled) await this.startServer(); else await this.stopServer();
    this.changed('gatewayChanged', this.gwStatus());
  }

  private async persistTokens(): Promise<void> {
    if (!this.storageId) return;
    try { await this.request(request(this.id, this.storageId, 'set', { key: TOKENS_KEY, value: this.tokens })); }
    catch (err) { log.warn(`could not persist tokens: ${err instanceof Error ? err.message : String(err)}`); }
  }

  // ── HTTP ──
  /** Set the gateway port. 0 means automatic (system picks a free port). */
  private async setPort(port: number): Promise<void> {
    require(Number.isInteger(port) && port >= 0 && port <= 65535, 'port must be an integer in [0, 65535] (0 = automatic)');
    if (port === this.port) return;
    this.port = port;
    if (this.storageId) { try { await this.request(request(this.id, this.storageId, 'set', { key: PORT_KEY, value: port })); } catch { /* best effort */ } }
    if (this.server) {
      await this.stopServer();
      await this.startServer();
    }
    this.changed('gatewayChanged', this.gwStatus());
  }

  private async startServer(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    // Bind the configured port; if it is taken (another instance, a stale
    // process), fall back to an ephemeral port rather than failing outright.
    // Port 0 always means "the system picks a free port".
    let bound = false;
    let lastErr: unknown;
    for (const candidate of this.port === 0 ? [0] : [this.port, 0]) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', (err) => reject(err));
          server.listen(candidate, this.bind, () => { server.removeListener('error', () => {}); resolve(); });
        });
        this.port = candidate === 0 ? (server.address() as { port: number }).port : candidate;
        bound = true;
        break;
      } catch (err) { lastErr = err; }
    }
    if (!bound) throw lastErr;
    this.server = server;
    if (this.storageId) { try { await this.request(request(this.id, this.storageId, 'set', { key: PORT_KEY, value: this.port })); } catch { /* best effort */ } }
    log.info(`HTTP gateway listening on ${this.bind}:${this.port}`);
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const parts = url.pathname.split('/').filter(Boolean);
      const wantsJson = (req.headers.accept ?? '').includes('application/json');

      // A miss may mean the map is simply stale (boot race, gateway restart);
      // refresh once, throttled, before deciding it truly is not there.
      if (parts.length === 0 || ![...this.workspaces.values()].some(w => w.enabled && w.slug === parts[0])) {
        await this.ensureFresh();
      }
      if (parts.length === 0) return this.sendIndex(res, wantsJson);

      const ws = [...this.workspaces.values()].find(w => w.enabled && w.slug === parts[0]);
      if (!ws) return this.fail(res, 404, 'No such workspace', wantsJson);

      if (parts.length === 1) return this.sendWorkspace(res, ws, wantsJson);

      const entryName = Object.keys(ws.entries).find(n => this.slug(n) === parts[1]);
      if (!entryName) return this.fail(res, 404, 'No such abject', wantsJson);
      const entry = ws.entries[entryName];

      const authErr = this.checkAuth(req, entry);
      if (authErr) { res.setHeader('WWW-Authenticate', 'Bearer'); return this.fail(res, 401, authErr, wantsJson); }

      const reg = await this.resolveAbject(ws, entryName);
      if (!reg) return this.fail(res, 404, 'Abject is not running', wantsJson);

      // GET /<ws>/<abject>[/openapi.json]  — the interface
      if (req.method === 'GET') {
        if (parts.length === 3 && parts[2] === 'openapi.json') return this.sendJson(res, 200, this.openapi(ws, entryName, reg.manifest, entry));
        if (parts.length === 2) return this.sendAbject(res, ws, entryName, reg.manifest, entry, wantsJson);
        return this.fail(res, 404, 'Not found', wantsJson);
      }

      // POST /<ws>/<abject>/<method> — invoke
      if (req.method === 'POST' && parts.length === 3) {
        const method = parts[2];
        if (!this.methodAllowed(method, entry, reg.manifest)) return this.fail(res, 404, 'No such method', wantsJson);
        const body = await this.readBody(req);
        if (body === undefined) return this.fail(res, 413, 'Body too large', wantsJson);
        let payload: unknown = {};
        if (body.length > 0) { try { payload = JSON.parse(body); } catch { return this.fail(res, 400, 'Body is not valid JSON', wantsJson); } }
        return this.invoke(res, reg.id, method, payload, reg.manifest);
      }

      return this.fail(res, 405, 'Method not allowed', wantsJson);
    } catch (err) {
      log.warn(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      try { this.fail(res, 500, 'Internal error', false); } catch { /* response already gone */ }
    }
  }

  private checkAuth(req: http.IncomingMessage, entry: WebExposureEntry): string | undefined {
    if (entry.access === 'public') return undefined;
    const header = req.headers.authorization ?? '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return 'Authentication required';
    const token = m[1].trim();
    const hash = this.hash(token);
    const api = this.tokens.find(t => crypto.timingSafeEqual(Buffer.from(t.hash), Buffer.from(hash)));
    if (api) { api.lastUsedAt = Date.now(); return undefined; }
    if (this.sessions.validateSession(token)) return undefined;
    return 'Invalid token';
  }

  private methodAllowed(method: string, entry: WebExposureEntry, manifest: AbjectManifest): boolean {
    if (BLOCKED_METHODS.has(method)) return false;
    if (entry.methods && !entry.methods.includes(method)) return false;
    return manifest.interface.methods.some(m => m.name === method);
  }

  private async resolveAbject(ws: WorkspaceExposure, name: string): Promise<{ id: AbjectId; manifest: AbjectManifest } | undefined> {
    try {
      const hits = await this.request<Array<{ id: AbjectId; manifest: AbjectManifest; name: string }>>(request(this.id, ws.registryId, 'discover', { name }), 10_000);
      const hit = hits.find(h => (h.name ?? h.manifest?.name) === name) ?? hits[0];
      return hit ? { id: hit.id, manifest: hit.manifest } : undefined;
    } catch { return undefined; }
  }

  private async invoke(res: http.ServerResponse, targetId: AbjectId, method: string, payload: unknown, manifest: AbjectManifest): Promise<void> {
    try {
      const reply = await this.request<unknown>(request(this.id, targetId, method, payload), CALL_TIMEOUT_MS);
      // A result contract lets a domain failure ({success:false}) become 422.
      const decl = manifest.interface.methods.find(m => m.name === method);
      const successField = decl?.resultContract && 'successField' in decl.resultContract ? (decl.resultContract as { successField: string }).successField
        : decl?.returns?.kind === 'object' && (decl.returns.properties?.success?.primitive === 'boolean') ? 'success' : undefined;
      if (successField && reply && typeof reply === 'object' && (reply as Record<string, unknown>)[successField] === false) {
        return this.sendJson(res, 422, { ok: false, result: reply });
      }
      return this.sendJson(res, 200, { ok: true, result: reply });
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const message = err instanceof Error ? err.message : String(err);
      const status = code === 'METHOD_NOT_FOUND' ? 404
        : /permission|denied|not allowed|forbidden/i.test(message) ? 403
        : /timeout/i.test(message) ? 504 : 500;
      return this.sendJson(res, status, { ok: false, error: message, code });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      let size = 0; const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY_BYTES) { resolve(undefined); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  // ── Rendering ──
  private sendIndex(res: http.ServerResponse, json: boolean): void {
    const list = [...this.workspaces.values()].filter(w => w.enabled && Object.keys(w.entries).length > 0)
      .map(w => ({ workspace: w.name, slug: w.slug, path: `/${w.slug}/`, abjects: Object.keys(w.entries).length }));
    if (json) return this.sendJson(res, 200, { gateway: 'abject', workspaces: list });
    const rows = list.map(w => `<li><a href="/${w.slug}/">${esc(w.workspace)}</a> — ${w.abjects} abject${w.abjects === 1 ? '' : 's'}</li>`).join('');
    this.sendHtml(res, 200, 'Abject Gateway', `<h1>Abject Gateway</h1>${list.length ? `<ul>${rows}</ul>` : '<p>No workspaces are exposed.</p>'}`);
  }

  private sendWorkspace(res: http.ServerResponse, ws: WorkspaceExposure, json: boolean): void {
    const list = Object.entries(ws.entries).map(([name, e]) => ({ abject: name, access: e.access, path: `/${ws.slug}/${this.slug(name)}` }));
    if (json) return this.sendJson(res, 200, { workspace: ws.name, slug: ws.slug, abjects: list });
    const rows = list.map(a => `<li><a href="${a.path}">${esc(a.abject)}</a> <em>(${a.access})</em></li>`).join('');
    this.sendHtml(res, 200, ws.name, `<p><a href="/">&larr; gateway</a></p><h1>${esc(ws.name)}</h1>${list.length ? `<ul>${rows}</ul>` : '<p>Nothing exposed.</p>'}`);
  }

  private invokableMethods(manifest: AbjectManifest, entry: WebExposureEntry): MethodDeclaration[] {
    return manifest.interface.methods.filter(m => this.methodAllowed(m.name, entry, manifest));
  }

  private sendAbject(res: http.ServerResponse, ws: WorkspaceExposure, name: string, manifest: AbjectManifest, entry: WebExposureEntry, json: boolean): void {
    const methods = this.invokableMethods(manifest, entry);
    if (json) {
      return this.sendJson(res, 200, { workspace: ws.name, abject: name, description: manifest.description, access: entry.access,
        methods: methods.map(m => ({ name: m.name, description: m.description, parameters: m.parameters, returns: m.returns })),
        openapi: `/${ws.slug}/${this.slug(name)}/openapi.json` });
    }
    const base = `/${ws.slug}/${this.slug(name)}`;
    const forms = methods.map(m => {
      const fields = m.parameters.map(p => `<label>${esc(p.name)} <span class="t">${esc(fmtType(p.type))}${p.optional ? '?' : ''}</span><br><input name="${esc(p.name)}" placeholder="${esc(p.description)}"></label>`).join('<br>');
      return `<form class="m" data-method="${esc(m.name)}"><h3>${esc(m.name)}</h3><p>${esc(m.description)}</p>${fields}${fields ? '<br>' : ''}<button type="submit">POST ${base}/${esc(m.name)}</button><pre class="out"></pre></form>`;
    }).join('');
    const script = `<script>document.querySelectorAll('form.m').forEach(f=>f.addEventListener('submit',async e=>{e.preventDefault();const body={};f.querySelectorAll('input').forEach(i=>{if(i.value!==''){try{body[i.name]=JSON.parse(i.value)}catch{body[i.name]=i.value}}});const out=f.querySelector('.out');out.textContent='...';try{const r=await fetch('${base}/'+f.dataset.method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});out.textContent=r.status+' '+await r.text()}catch(err){out.textContent=String(err)}}));</script>`;
    this.sendHtml(res, 200, name, `<p><a href="/${ws.slug}/">&larr; ${esc(ws.name)}</a></p><h1>${esc(name)}</h1><p>${esc(manifest.description)}</p><p class="t">access: ${entry.access} &middot; <a href="${base}/openapi.json">openapi.json</a></p>${forms}${script}`);
  }

  private openapi(ws: WorkspaceExposure, name: string, manifest: AbjectManifest, entry: WebExposureEntry): unknown {
    const base = `/${ws.slug}/${this.slug(name)}`;
    const paths: Record<string, unknown> = {};
    for (const m of this.invokableMethods(manifest, entry)) {
      const props: Record<string, unknown> = {};
      for (const p of m.parameters) props[p.name] = { ...jsonSchema(p.type), description: p.description };
      paths[`${base}/${m.name}`] = { post: { summary: m.description || m.name, operationId: m.name,
        ...(entry.access === 'authenticated' ? { security: [{ bearerAuth: [] }] } : {}),
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: props,
          required: m.parameters.filter(p => !p.optional).map(p => p.name) } } } },
        responses: { '200': { description: 'Result' }, '422': { description: 'Domain failure' } } } };
    }
    return { openapi: '3.0.0', info: { title: `${name} (${ws.name})`, description: manifest.description, version: manifest.version },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, paths };
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  }
  private sendHtml(res: http.ServerResponse, status: number, title: string, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)} — Abject</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:32px;color:#1a1a2e}a{color:#2b8a6f}h1{font-size:20px}form.m{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}input{padding:4px 6px;min-width:220px}button{margin-top:8px;padding:6px 12px;cursor:pointer}.t{color:#888;font-size:12px}pre.out{background:#f6f6f6;padding:8px;border-radius:4px;white-space:pre-wrap;margin-top:8px}pre.out:empty{display:none}</style>${body}`);
  }
  private fail(res: http.ServerResponse, status: number, message: string, json: boolean): void {
    if (json) return this.sendJson(res, status, { ok: false, error: message });
    this.sendHtml(res, status, `${status}`, `<h1>${status}</h1><p>${esc(message)}</p><p><a href="/">gateway</a></p>`);
  }
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, ch => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;');
}
function fmtType(t: { kind: string; primitive?: string; elementType?: unknown; reference?: string } | undefined): string {
  if (!t) return 'any';
  if (t.kind === 'primitive') return t.primitive ?? 'any';
  if (t.kind === 'array') return `${fmtType(t.elementType as never)}[]`;
  if (t.kind === 'reference') return t.reference ?? 'ref';
  return t.kind;
}
function jsonSchema(t: { kind: string; primitive?: string; elementType?: unknown } | undefined): Record<string, unknown> {
  if (!t) return {};
  if (t.kind === 'primitive') return { type: t.primitive === 'number' ? 'number' : t.primitive === 'boolean' ? 'boolean' : 'string' };
  if (t.kind === 'array') return { type: 'array', items: jsonSchema(t.elementType as never) };
  if (t.kind === 'object') return { type: 'object' };
  return {};
}

export const WEB_GATEWAY_ID = 'abjects:web-gateway' as AbjectId;
