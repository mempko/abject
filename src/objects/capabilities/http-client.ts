/**
 * HTTP Client capability object - provides HTTP request capability to other objects.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';

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

/**
 * HTTP Client capability object.
 */
export class HttpClient extends Abject {
  private allowedDomains?: Set<string>;
  private deniedDomains?: Set<string>;

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
        tags: ['capability', 'http', 'network'],
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
    this.on('request', async (msg: AbjectMessage) => {
      const req = msg.payload as HttpRequest;
      this.makeRequest(req).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { url, headers } = msg.payload as {
        url: string;
        headers?: Record<string, string>;
      };
      this.makeRequest({ method: 'GET', url, headers }).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
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
      this.makeRequest({ method: 'POST', url, body, headers }).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
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
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('postJson', async (msg: AbjectMessage) => {
      const { url, data } = msg.payload as {
        url: string;
        data: object;
      };
      this.makeRequest({
        method: 'POST',
        url,
        body: data,
        headers: { 'Content-Type': 'application/json' },
      }).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'HTTP_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });
  }

  /**
   * Make an HTTP request with retry for transient errors.
   */
  async makeRequest(req: HttpRequest): Promise<HttpResponse> {
    // Validate URL
    const url = new URL(req.url);
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
   * Validate that a domain is allowed.
   */
  private validateDomain(hostname: string): void {
    if (this.deniedDomains?.has(hostname)) {
      throw new Error(`Domain ${hostname} is denied`);
    }

    if (this.allowedDomains && !this.allowedDomains.has(hostname)) {
      throw new Error(`Domain ${hostname} is not in allowed list`);
    }
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

  protected override getSourceForAsk(): string | undefined {
    return `## HttpClient Usage Guide

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
- Requests auto-retry on 429 and 5xx errors (up to 3 attempts).`;
  }
}

// Well-known HTTP client ID
export const HTTP_CLIENT_ID = 'abjects:http-client' as AbjectId;
