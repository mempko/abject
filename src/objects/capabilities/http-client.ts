/**
 * HTTP Client capability object - provides HTTP request capability to other objects.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
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
          'Provides HTTP request capabilities. Objects can make GET, POST, PUT, DELETE requests to external APIs.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
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
    this.on('request', async (msg: AbjectMessage) => {
      const req = msg.payload as HttpRequest;
      return this.makeRequest(req);
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { url, headers } = msg.payload as {
        url: string;
        headers?: Record<string, string>;
      };
      return this.makeRequest({ method: 'GET', url, headers });
    });

    this.on('post', async (msg: AbjectMessage) => {
      const { url, body, headers } = msg.payload as {
        url: string;
        body: string;
        headers?: Record<string, string>;
      };
      return this.makeRequest({ method: 'POST', url, body, headers });
    });

    this.on('postJson', async (msg: AbjectMessage) => {
      const { url, data } = msg.payload as {
        url: string;
        data: object;
      };
      return this.makeRequest({
        method: 'POST',
        url,
        body: data,
        headers: { 'Content-Type': 'application/json' },
      });
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
}

// Well-known HTTP client ID
export const HTTP_CLIENT_ID = 'abjects:http-client' as AbjectId;
