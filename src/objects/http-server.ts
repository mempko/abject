/**
 * HttpServer -- global HTTP server Abject with sandboxed route handlers.
 *
 * Any abject can register route handlers (code strings) for specific HTTP
 * paths and methods. When a matching request arrives, the handler code runs
 * in a sandboxed vm context with access to `call`, `dep`, `find`, and the
 * request object. The handler returns `{ status?, headers?, body? }`.
 */

import * as http from 'http';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire, requireNonEmpty } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import { validateCode, runSandboxed } from '../core/sandbox.js';
import { Log } from '../core/timed-log.js';

const log = new Log('HttpServer');

const HTTPSERVER_INTERFACE: InterfaceId = 'abjects:http-server';

interface RouteEntry {
  path: string;
  method: string;
  code: string;
  description: string;
  registeredBy: AbjectId;
}

export class HttpServer extends Abject {
  private server: http.Server | null = null;
  private port: number;
  private routes: Map<string, RouteEntry> = new Map();

  constructor(port = 0) {
    super({
      manifest: {
        name: 'HttpServer',
        description:
          'HTTP server with sandboxed route handlers. Any abject can register code that runs when matching HTTP requests arrive.',
        version: '1.0.0',
        interface: {
          id: HTTPSERVER_INTERFACE,
          name: 'HttpServer',
          description: 'HTTP server with sandboxed route handlers',
          methods: [
            {
              name: 'registerRoute',
              description: 'Register a sandboxed handler for an HTTP route. Handler code receives a `req` object and returns `{ status?, headers?, body? }`.',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'URL path to match (e.g. "/api/hello")' },
                { name: 'method', type: { kind: 'primitive', primitive: 'string' }, description: 'HTTP method (GET, POST, PUT, DELETE, etc.)' },
                { name: 'code', type: { kind: 'primitive', primitive: 'string' }, description: 'JavaScript code to execute. Has access to `req`, `call`, `dep`, `find`, `id`. Must return `{ status?, headers?, body? }`.' },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable description of this route', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'unregisterRoute',
              description: 'Remove a registered route handler.',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'URL path' },
                { name: 'method', type: { kind: 'primitive', primitive: 'string' }, description: 'HTTP method' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listRoutes',
              description: 'List all registered routes.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'RouteInfo' } },
            },
            {
              name: 'getPort',
              description: 'Return the port this server is listening on.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'number' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.HTTP_SERVER_LISTEN],
        tags: ['system', 'http'],
      },
    });

    this.port = port;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('registerRoute', (msg: AbjectMessage) => {
      const { path, method, code, description } = msg.payload as {
        path: string; method: string; code: string; description?: string;
      };
      requireNonEmpty(path, 'path');
      requireNonEmpty(method, 'method');
      requireNonEmpty(code, 'code');

      const validation = validateCode(code);
      if (!validation.valid) {
        throw new Error(
          `Route handler code rejected: '${validation.blocked}' is not allowed. ` +
          `Use call(), dep(), and find() to discover and invoke system capabilities.`,
        );
      }

      const key = `${method.toUpperCase()}:${path}`;
      this.routes.set(key, {
        path,
        method: method.toUpperCase(),
        code,
        description: description ?? '',
        registeredBy: msg.routing.from,
      });

      log.info(`Route registered: ${key} by ${msg.routing.from}`);
      this.changed('routeRegistered', { path, method: method.toUpperCase(), description });
      return true;
    });

    this.on('unregisterRoute', (msg: AbjectMessage) => {
      const { path, method } = msg.payload as { path: string; method: string };
      requireNonEmpty(path, 'path');
      requireNonEmpty(method, 'method');

      const key = `${method.toUpperCase()}:${path}`;
      const deleted = this.routes.delete(key);
      if (deleted) {
        log.info(`Route unregistered: ${key}`);
        this.changed('routeUnregistered', { path, method: method.toUpperCase() });
      }
      return deleted;
    });

    this.on('listRoutes', () => {
      return Array.from(this.routes.values()).map(r => ({
        path: r.path,
        method: r.method,
        description: r.description,
        registeredBy: r.registeredBy,
      }));
    });

    this.on('getPort', () => {
      return this.port;
    });
  }

  protected override async onInit(): Promise<void> {
    await this.startServer();
  }

  protected override async onStop(): Promise<void> {
    await this.stopServer();
  }

  private async startServer(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        log.warn('Unhandled error in HTTP handler:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        log.info(`HTTP server listening on port ${this.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  private async stopServer(): Promise<void> {
    if (!this.server) return;
    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        log.info('HTTP server stopped');
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const path = url.pathname;

    const key = `${method}:${path}`;
    const route = this.routes.get(key);

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', path, method }));
      return;
    }

    // Read request body
    const body = await this.readBody(req);

    // Parse query params
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) {
      query[k] = v;
    }

    // Build sandbox context
    const callFn = async (
      to: AbjectId | string | Promise<AbjectId>,
      method: string,
      payload: unknown = {},
    ) => {
      const resolved = await to;
      return this.request<unknown>(
        request(this.id, resolved as AbjectId, method, payload),
        600000,
      );
    };

    const depFn = async (name: string) => this.requireDep(name);
    const findFn = async (name: string) => this.discoverDep(name);

    const reqObj = {
      method,
      path,
      headers: { ...req.headers },
      query,
      body,
    };

    const context = {
      call: callFn,
      dep: depFn,
      find: findFn,
      id: this.id,
      req: reqObj,
    };

    try {
      const result = await runSandboxed(route.code, context, {
        filename: `route-${key}.js`,
        timeout: 30000,
      }) as { status?: number; headers?: Record<string, string>; body?: unknown } | undefined;

      const status = result?.status ?? 200;
      const headers: Record<string, string> = { ...result?.headers };
      let responseBody: string;

      if (result?.body === undefined || result?.body === null) {
        responseBody = '';
      } else if (typeof result.body === 'string') {
        responseBody = result.body;
        if (!headers['content-type']) {
          headers['content-type'] = 'text/plain';
        }
      } else {
        responseBody = JSON.stringify(result.body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
      }

      res.writeHead(status, headers);
      res.end(responseBody);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Route handler error for ${key}: ${errorMsg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorMsg }));
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    contractRequire(this.port >= 0, 'port must be non-negative');
  }
}

export const HTTP_SERVER_ID = 'abjects:http-server' as AbjectId;
