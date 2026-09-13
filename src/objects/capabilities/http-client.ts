/**
 * HTTP Client capability object - provides HTTP request capability to other objects.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error, event } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('HTTP');

const HTTP_INTERFACE = 'abjects:http';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  headers?: Record<string, string>;
  body?: string | object;
  timeout?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
}

/** What the CassetteRecorder receives per completed request (event
 *  `httpExchange`, sent to that one object only — never broadcast).
 *  Redacted and size-capped BEFORE emission: secrets never cross the bus,
 *  and multi-megabyte bodies never ride it. Bodies stay text — nothing on
 *  this path parses JSON. */
export interface HttpExchangeEvent {
  /** Verified by recorders against the registry, not trusted from here. */
  caller: AbjectId;
  request: { method: string; url: string; headers?: Record<string, string>; bodyText?: string; truncated?: boolean };
  response: { status: number; headers?: Record<string, string>; bodyText?: string; truncated?: boolean };
  durationMs: number;
  at: number;
}

/** Stem match on the NAME of a header, query param, or body field. Stems
 *  rather than exact names, so client_secret, refresh_token, x-amz-security-
 *  token, and whatever header a generated object invents all match; a false
 *  positive redacts something harmless, a false negative persists a live
 *  credential, so this errs toward matching. (`auth(?!or\b)` keeps
 *  authorization in while leaving author alone.) */
const SECRET_NAME_STEM = /key|token|secret|passw|credential|session|signature|cookie|auth(?!or\b)/i;
const EXCHANGE_BODY_CAP = 64 * 1024; // characters, not bytes
/** How long a failed recorder discovery is trusted before asking the
 *  registry again. Bounds the cost of running without a recorder to one
 *  registry request per interval, and bounds the gap after a recorder
 *  restart (recipientGone clears the wait entirely). */
const RECORDER_RETRY_MS = 1000;

/**
 * HTTP Client capability object.
 */
export class HttpClient extends Abject {
  private allowedDomains?: Set<string>;
  private deniedDomains?: Set<string>;
  private webDisabled = false;
  /** The only AbjectId allowed to call updatePermissions. Set once at bootstrap. */
  private permissionsAuthorityId?: AbjectId;
  /** The one recipient of httpExchange events, found through the registry.
   *  Resolved lazily (the recorder spawns after HttpClient at boot) and
   *  dropped on recipientGone so a restarted recorder is picked back up. */
  private recorderId?: AbjectId;
  private nextRecorderResolveAt = 0;
  private recorderResolve?: Promise<void>;
  /** Per-caller verdict of "is this LLM?", decided once per AbjectId against
   *  the global registry's current LLM. An id belongs to one object for its
   *  lifetime and a respawned LLM arrives with a fresh id, so a verdict never
   *  goes stale and a restarted LLM is classified afresh. Callers that cannot
   *  be classified (LLM not registered yet) are never recorded on a guess. */
  private callerIsLlm = new Map<AbjectId, boolean>();

  constructor(config?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
  }) {
    super({
      manifest: {
        name: 'HttpClient',
        description:
          'Provides HTTP request capabilities. Objects can make GET, POST, PUT, DELETE requests to external APIs. Use cases: fetch JSON from REST APIs, download images as base64 data URIs, POST form data or JSON, make authenticated requests with custom headers.',
        version: '1.0.0',
        interface: {
            id: HTTP_INTERFACE,
            name: 'HttpClient',
            description: 'HTTP request operations',
            methods: [
              {
                name: 'request',
                description: 'Make an HTTP request',
                parameters: [
                  {
                    name: 'method',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'HTTP method',
                  },
                  {
                    name: 'url',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Request URL',
                  },
                  {
                    name: 'headers',
                    type: {
                      kind: 'object',
                      properties: {},
                    },
                    description: 'Request headers',
                    optional: true,
                  },
                  {
                    name: 'body',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Request body',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'HttpResponse' },
              },
              {
                name: 'get',
                description: 'Make a GET request',
                parameters: [
                  {
                    name: 'url',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Request URL',
                  },
                  {
                    name: 'headers',
                    type: { kind: 'object', properties: {} },
                    description: 'Request headers',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'HttpResponse' },
              },
              {
                name: 'post',
                description: 'Make a POST request',
                parameters: [
                  {
                    name: 'url',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Request URL',
                  },
                  {
                    name: 'body',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Request body',
                  },
                  {
                    name: 'headers',
                    type: { kind: 'object', properties: {} },
                    description: 'Request headers',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'HttpResponse' },
              },
              {
                name: 'getBase64',
                description: 'Fetch a URL and return its content as a base64 data URI. Useful for fetching images or binary files.',
                parameters: [
                  {
                    name: 'url',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'URL to fetch',
                  },
                  {
                    name: 'headers',
                    type: { kind: 'object', properties: {} },
                    description: 'Request headers',
                    optional: true,
                  },
                ],
                returns: {
                  kind: 'object',
                  properties: {
                    dataUri: { kind: 'primitive', primitive: 'string' },
                    mimeType: { kind: 'primitive', primitive: 'string' },
                    size: { kind: 'primitive', primitive: 'number' },
                    ok: { kind: 'primitive', primitive: 'boolean' },
                    status: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
              {
                name: 'postJson',
                description: 'Make a POST request with JSON body',
                parameters: [
                  {
                    name: 'url',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Request URL',
                  },
                  {
                    name: 'data',
                    type: { kind: 'object', properties: {} },
                    description: 'JSON data to send',
                  },
                ],
                returns: { kind: 'reference', reference: 'HttpResponse' },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.HTTP_REQUEST],
        tags: ['system', 'capability', 'http', 'network'],
      },
    });

    if (config?.allowedDomains) {
      this.allowedDomains = new Set(config.allowedDomains);
    }
    if (config?.deniedDomains) {
      this.deniedDomains = new Set(config.deniedDomains);
    }

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // All handlers use DEFERRED_REPLY so the processing loop stays free
    // for health pings during long-running fetches (e.g. LLM API calls).
    // The bus sends this when an httpExchange bounced off a dead recorder.
    // Forget the link so the next exchange re-resolves (a restarted recorder
    // has a new id); everything in between is not recorded, by design.
    this.on('recipientGone', (msg: AbjectMessage) => {
      const { recipient } = msg.payload as { recipient?: AbjectId };
      if (recipient && recipient === this.recorderId) {
        this.recorderId = undefined;
        this.nextRecorderResolveAt = 0;
      }
      return true;
    });

    this.on('request', async (msg: AbjectMessage) => {
      const req = msg.payload as HttpRequest;
      this.tracked(msg, req).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { url, headers } = msg.payload as {
        url: string;
        headers?: Record<string, string>;
      };
      this.tracked(msg, { method: 'GET', url, headers }).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('post', async (msg: AbjectMessage) => {
      const { url, body, headers } = msg.payload as {
        url: string;
        body: string;
        headers?: Record<string, string>;
      };
      this.tracked(msg, { method: 'POST', url, body, headers }).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('getBase64', async (msg: AbjectMessage) => {
      const { url, headers } = msg.payload as {
        url: string;
        headers?: Record<string, string>;
      };
      this.fetchBase64(url, headers).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('postJson', async (msg: AbjectMessage) => {
      const { url, data } = msg.payload as {
        url: string;
        data: object;
      };
      this.tracked(msg, {
        method: 'POST',
        url,
        body: data,
        headers: { 'Content-Type': 'application/json' },
      }).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('setPermissionsAuthority', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId) return { success: false, error: 'Authority already set' };
      this.permissionsAuthorityId = msg.routing.from;
      return { success: true };
    });

    this.on('updatePermissions', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId && msg.routing.from !== this.permissionsAuthorityId) {
        return { success: false, error: 'Unauthorized: only the permissions authority can update permissions' };
      }
      const { enabled, allowedDomains, deniedDomains } = msg.payload as {
        enabled?: boolean;
        allowedDomains?: string[];
        deniedDomains?: string[];
      };
      if (enabled !== undefined) this.webDisabled = !enabled;
      if (allowedDomains !== undefined) {
        this.allowedDomains = allowedDomains.length > 0 ? new Set(allowedDomains) : undefined;
      }
      if (deniedDomains !== undefined) {
        this.deniedDomains = deniedDomains.length > 0 ? new Set(deniedDomains) : undefined;
      }
      return { success: true };
    });
  }

  /**
   * makeRequest plus the `httpExchange` event for the CassetteRecorder.
   * Wraps the message entry points only: `msg.routing.from` is the caller
   * identity the recorder attributes the exchange to. Recording is
   * best-effort and detached: it never delays or breaks the reply.
   */
  private async tracked(msg: AbjectMessage, req: HttpRequest): Promise<HttpResponse> {
    const started = Date.now();
    const result = await this.makeRequest(req);
    this.recordExchange(msg.routing.from, req, result, Date.now() - started)
      .catch((err) => log.warn('httpExchange emission failed', err));
    return result;
  }

  /** Point-to-point, not a broadcast: the exchange goes to the registered
   *  CassetteRecorder and nothing else, so an object cannot subscribe to
   *  other objects' traffic via addDependent. LLM's calls are dropped before
   *  any redaction or serialization runs; with no recorder, nothing runs.
   *  Fails closed: a caller that cannot yet be told apart from LLM is not
   *  recorded either (the recorder would drop an unattributable exchange
   *  anyway, so no evidence is lost by waiting). */
  private async recordExchange(caller: AbjectId | undefined, req: HttpRequest, res: HttpResponse, durationMs: number): Promise<void> {
    if (!caller) return;
    const recorderId = await this.resolveRecorder();
    if (!recorderId) return;
    if (await this.isLlm(caller) !== false) return;
    this.send(event(this.id, recorderId, 'httpExchange', buildExchange(caller, req, res, durationMs)));
  }

  private async resolveRecorder(): Promise<AbjectId | undefined> {
    if (this.recorderId) return this.recorderId;
    if (Date.now() < this.nextRecorderResolveAt) return undefined;
    // Concurrent exchanges share one registry round-trip. A recipientGone
    // that lands while this is in flight can be overwritten by the id that
    // just died; the next send bounces again and self-heals.
    this.recorderResolve ??= (async () => {
      try {
        this.recorderId = await this.discoverDep('CassetteRecorder') ?? undefined;
      } finally {
        if (!this.recorderId) this.nextRecorderResolveAt = Date.now() + RECORDER_RETRY_MS;
        this.recorderResolve = undefined;
      }
    })();
    await this.recorderResolve;
    return this.recorderId;
  }

  /** true = LLM, false = someone else, undefined = cannot tell yet (LLM is
   *  not in the global registry, so no verdict is cached). One registry
   *  discover per new caller id, a Map hit per request after that. Workspace
   *  registries are never consulted: a user object naming itself LLM does
   *  not get itself excused. */
  private async isLlm(caller: AbjectId): Promise<boolean | undefined> {
    const known = this.callerIsLlm.get(caller);
    if (known !== undefined) return known;
    const llmId = await this.discoverDep('LLM');
    if (!llmId) return undefined;
    if (this.callerIsLlm.size >= 512) this.callerIsLlm.clear();
    this.callerIsLlm.set(caller, caller === llmId);
    return caller === llmId;
  }

  /**
   * Make an HTTP request with retry for transient errors.
   */
  async makeRequest(req: HttpRequest): Promise<HttpResponse> {
    if (this.webDisabled) throw new Error('Web access is disabled. Enable it in Settings > Permissions.');
    // Validate URL
    const url = new URL(req.url);
    this.validateScheme(url.protocol);
    this.validateDomain(url.hostname);

    // Build fetch options
    const options: RequestInit = {
      method: req.method,
      headers: req.headers,
    };

    if (req.body) {
      options.body =
        typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const maxAttempts = 3;
    const timeout = req.timeout ?? 30000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(req.url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        // Retry on 429 (rate limit) or 5xx (server error)
        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Extract headers
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        // Read body
        const body = await response.text();

        return {
          status: response.status,
          statusText: response.statusText,
          headers,
          body,
          ok: response.ok,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        if (attempt < maxAttempts) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    // Unreachable but satisfies TypeScript
    throw new Error('HttpClient: max retries exceeded');
  }

  /**
   * Fetch a URL and return its content as a base64 data URI.
   */
  async fetchBase64(
    url: string,
    headers?: Record<string, string>
  ): Promise<{ dataUri: string; mimeType: string; size: number; ok: boolean; status: number }> {
    const parsed = new URL(url);
    this.validateScheme(parsed.protocol);
    this.validateDomain(parsed.hostname);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          dataUri: '',
          mimeType: '',
          size: 0,
          ok: false,
          status: response.status,
        };
      }

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const mimeType = blob.type || 'application/octet-stream';

      // Use Buffer in Node.js for efficiency, btoa for browser
      let b64: string;
      if (typeof Buffer !== 'undefined') {
        b64 = Buffer.from(arrayBuffer).toString('base64');
      } else {
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        b64 = btoa(binary);
      }

      const dataUri = `data:${mimeType};base64,${b64}`;

      return {
        dataUri,
        mimeType,
        size: arrayBuffer.byteLength,
        ok: true,
        status: response.status,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Reject non-HTTP(S) schemes to prevent file:/ftp:/etc. abuse.
   */
  private validateScheme(protocol: string): void {
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Scheme ${protocol} is not allowed — only http: and https: are permitted`);
    }
  }

  /**
   * Validate that a domain is allowed. Blocks private/internal IPs by default (SSRF protection).
   */
  private validateDomain(hostname: string): void {
    if (this.deniedDomains?.has(hostname)) {
      throw new Error(`Domain ${hostname} is denied`);
    }

    if (this.allowedDomains && !this.allowedDomains.has(hostname)) {
      throw new Error(`Domain ${hostname} is not in allowed list`);
    }

    // SSRF protection: block requests to private/internal addresses
    if (this.isPrivateHost(hostname)) {
      throw new Error(`Domain ${hostname} is blocked — private/internal addresses are not allowed`);
    }
  }

  /**
   * Check if a hostname resolves to a private/internal address.
   */
  private isPrivateHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();

    // Block localhost variants
    if (lower === 'localhost' || lower === 'localhost.') return true;

    // Block IPv6 loopback and link-local
    if (lower === '::1' || lower === '[::1]') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('[fe80:')) return true;
    // IPv6 ULA (fd00::/8)
    if (lower.startsWith('fd') && (lower[2] === ':' || lower[2] === undefined || /^fd[0-9a-f]{2}:/.test(lower))) return true;
    if (lower.startsWith('[fd')) return true;

    // Strip brackets for IPv6 literal
    const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;

    // Check IPv4 patterns
    const ipv4Match = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b, c] = ipv4Match.map(Number);
      // 127.0.0.0/8
      if (a === 127) return true;
      // 10.0.0.0/8
      if (a === 10) return true;
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true;
      // 169.254.0.0/16 (link-local / cloud metadata)
      if (a === 169 && b === 254) return true;
      // 0.0.0.0
      if (a === 0 && b === 0 && c === 0) return true;
    }

    return false;
  }

  /**
   * Add an allowed domain.
   */
  allowDomain(domain: string): void {
    if (!this.allowedDomains) {
      this.allowedDomains = new Set();
    }
    this.allowedDomains.add(domain);
  }

  /**
   * Add a denied domain.
   */
  denyDomain(domain: string): void {
    if (!this.deniedDomains) {
      this.deniedDomains = new Set();
    }
    this.deniedDomains.add(domain);
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## HttpClient Usage Guide

### GET Request

  const result = await this.call(
    this.dep('HttpClient'), 'get',
    { url: 'https://api.example.com/data' });
  const data = JSON.parse(result.body);

### POST Request

  const result = await this.call(
    this.dep('HttpClient'), 'post',
    { url: 'https://api.example.com/items', body: '{"name":"foo"}',
      headers: { 'Content-Type': 'application/json' } });

### POST JSON (shorthand)

  const result = await this.call(
    this.dep('HttpClient'), 'postJson',
    { url: 'https://api.example.com/items', data: { name: 'foo', count: 42 } });

### Generic Request

  const result = await this.call(
    this.dep('HttpClient'), 'request',
    { method: 'PUT', url: 'https://api.example.com/items/1',
      headers: { 'Authorization': 'Bearer token' },
      body: '{"name":"updated"}', timeout: 10000 });

### Fetch as Base64 Data URI (for images/binary)

  const result = await this.call(
    this.dep('HttpClient'), 'getBase64',
    { url: 'https://example.com/image.png' });
  // result = { dataUri: 'data:image/png;base64,...', mimeType: 'image/png', size: 12345, ok: true, status: 200 }
  // Use dataUri with the 'imageUrl' draw command to display images on a surface.

### Response Structure

Every response has: { status, statusText, headers, body, ok }
- body is always a string. Use JSON.parse(result.body) to parse JSON responses.
- ok is true when status is 200-299.

### IMPORTANT
- Do NOT use fetch() directly — always go through the HttpClient object.
- Supported methods: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS.
- Requests auto-retry on 429 and 5xx errors (up to 3 attempts).` + this.getRestrictionsGuide();
  }

  private getRestrictionsGuide(): string {
    if (this.webDisabled) {
      return `\n\n### RESTRICTIONS\nWeb access is currently DISABLED.`;
    }
    const parts: string[] = [];
    if (this.allowedDomains && this.allowedDomains.size > 0) {
      parts.push(`Allowed domains: ${[...this.allowedDomains].join(', ')}`);
    }
    if (this.deniedDomains && this.deniedDomains.size > 0) {
      parts.push(`Denied domains: ${[...this.deniedDomains].join(', ')}`);
    }
    return parts.length > 0 ? `\n\n### RESTRICTIONS\n${parts.join('\n')}` : '';
  }
}

// Well-known HTTP client ID
export const HTTP_CLIENT_ID = 'abjects:http-client' as AbjectId;

function buildExchange(caller: AbjectId, req: HttpRequest, res: HttpResponse, durationMs: number): HttpExchangeEvent {
  const reqBody = typeof req.body === 'string' ? req.body
    : req.body !== undefined ? JSON.stringify(req.body) : undefined;
  const [reqBodyText, reqTruncated] = capBody(reqBody);
  const [resBodyText, resTruncated] = capBody(res.body);
  return {
    caller,
    request: {
      method: req.method,
      url: redactUrl(req.url),
      headers: redactHeaders(req.headers),
      ...(reqBodyText !== undefined ? { bodyText: reqBodyText } : {}),
      ...(reqTruncated ? { truncated: true } : {}),
    },
    response: {
      status: res.status,
      headers: redactHeaders(res.headers),
      ...(resBodyText !== undefined ? { bodyText: resBodyText } : {}),
      ...(resTruncated ? { truncated: true } : {}),
    },
    durationMs,
    at: Date.now(),
  };
}

/** Secret-bearing query params and headers are replaced, never dropped:
 *  the shape of the request stays visible, the credential does not. */
function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let touched = false;
    for (const name of Array.from(u.searchParams.keys())) {
      if (SECRET_NAME_STEM.test(name)) {
        u.searchParams.set(name, 'REDACTED');
        touched = true;
      }
    }
    return touched ? u.toString() : rawUrl;
  } catch {
    return rawUrl.split('?')[0];
  }
}

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_NAME_STEM.test(name) ? 'REDACTED' : value;
  }
  return out;
}

/** Field-level scrub of body TEXT: the value of any JSON string field or
 *  form-encoded field whose NAME matches the secret stems is replaced. Plain
 *  regex over text - no JSON.parse on this path, ever. Pattern-based, so it
 *  catches named fields (access_token, client_secret, password), not a
 *  secret embedded in free text under an innocent name. Only string VALUES
 *  are rewritten: `"pin": 1234` or `"token": null` pass through as they
 *  did before.
 *
 *  Linear by construction: the patterns match EVERY string-key/string-value
 *  pair (and every form field) and the stem test happens in the replacer.
 *  Putting the stem alternation inside the key's character class made the
 *  engine backtrack across every split of a long value containing a stem
 *  word (seconds per 100 KB), and this runs synchronously on a shared pool
 *  worker. */
const JSON_STRING_FIELD = /"((?:[^"\\]|\\.)*)"(\s*:\s*")(?:[^"\\]|\\.)*"/g;
const FORM_FIELD = /(^|[&?])([^=&]*=)[^&]*/g;

function redactBodyText(body: string): string {
  return body
    .replace(JSON_STRING_FIELD, (m, key: string, sep: string) =>
      SECRET_NAME_STEM.test(key) ? `"${key}"${sep}REDACTED"` : m)
    .replace(FORM_FIELD, (m, lead: string, name: string) =>
      SECRET_NAME_STEM.test(name) ? `${lead}${name}REDACTED` : m);
}

function capBody(body: string | undefined): [string | undefined, boolean] {
  if (body === undefined) return [undefined, false];
  const scrubbed = redactBodyText(body);
  if (scrubbed.length <= EXCHANGE_BODY_CAP) return [scrubbed, false];
  return [scrubbed.slice(0, EXCHANGE_BODY_CAP), true];
}
