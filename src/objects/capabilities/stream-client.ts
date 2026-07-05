/**
 * StreamClient capability object - persistent outbound streaming connections.
 *
 * Where HttpClient covers request/response, StreamClient holds long-lived
 * connections open: WebSocket (bidirectional) and Server-Sent Events
 * (server push over HTTP). Incoming messages flow to dependents as
 * `streamMessage` events, which makes live external data (market feeds,
 * chat services, job queues, webhooks relayed by a broker) available to
 * triggers, agents, and spoken-into-existence objects.
 *
 * Security model mirrors HttpClient: allow/deny domain sets, scheme
 * allowlist, private-address (SSRF) blocking, a master switch, and a single
 * permissions authority (GlobalSettings) that answers requestPermission for
 * unlisted domains with accept_once / accept_always / deny / deny_always.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error, request } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require } from '../../core/contracts.js';
import WebSocket from 'ws';
import * as http from 'http';
import * as https from 'https';

const STREAM_INTERFACE = 'abjects:stream';

/** Upper bound on simultaneously open connections. */
const MAX_CONNECTIONS = 32;

export type StreamKind = 'ws' | 'sse';

export type StreamState = 'connecting' | 'open' | 'closed';

interface StreamConnection {
  connectionId: string;
  url: string;
  kind: StreamKind;
  /** The Abject that opened the connection (routing.from at connect time). */
  owner: AbjectId;
  openedAt: number;
  messageCount: number;
  state: StreamState;
  ws?: WebSocket;
  sseRequest?: http.ClientRequest;
}

export class StreamClient extends Abject {
  private connections = new Map<string, StreamConnection>();
  private allowedDomains?: Set<string>;
  private deniedDomains?: Set<string>;
  private streamsDisabled = false;
  /** The only AbjectId allowed to call updatePermissions. Set once at bootstrap. */
  private permissionsAuthorityId?: AbjectId;

  constructor(config?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
  }) {
    super({
      manifest: {
        name: 'StreamClient',
        description:
          'Provides persistent outbound streaming connections: WebSocket (bidirectional) and Server-Sent Events (server push). ' +
          'Incoming data arrives as streamMessage events to dependents, so objects react to live external feeds instead of polling. ' +
          'Use cases: live market or sensor data, chat and notification services, event streams from external APIs.',
        version: '1.0.0',
        interface: {
          id: STREAM_INTERFACE,
          name: 'StreamClient',
          description: 'Persistent outbound streaming connections (WebSocket, SSE)',
          methods: [
            {
              name: 'connect',
              description:
                'Open a streaming connection. kind "ws" (default for ws:/wss: URLs) or "sse" (default for http:/https: URLs). ' +
                'Register as a dependent (addDependent) to receive streamOpened/streamMessage/streamClosed/streamError events.',
              parameters: [
                { name: 'url', type: { kind: 'primitive', primitive: 'string' }, description: 'ws://, wss://, http:// or https:// URL' },
                { name: 'kind', type: { kind: 'primitive', primitive: 'string' }, description: 'Connection kind: ws or sse. Inferred from the URL scheme when omitted.', optional: true },
                { name: 'headers', type: { kind: 'object', properties: {} }, description: 'Extra request headers (e.g. Authorization)', optional: true },
              ],
              returns: {
                kind: 'object',
                properties: { connectionId: { kind: 'primitive', primitive: 'string' } },
              },
            },
            {
              name: 'send',
              description: 'Send data over an open WebSocket connection (ws kind only; SSE is receive-only).',
              parameters: [
                { name: 'connectionId', type: { kind: 'primitive', primitive: 'string' }, description: 'Connection to send on' },
                { name: 'data', type: { kind: 'primitive', primitive: 'string' }, description: 'Data to send (string; JSON-encode objects first)' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'disconnect',
              description: 'Close a streaming connection.',
              parameters: [
                { name: 'connectionId', type: { kind: 'primitive', primitive: 'string' }, description: 'Connection to close' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'listConnections',
              description: 'List open and recently closed connections.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'StreamConnectionInfo' } },
            },
          ],
          events: [
            {
              name: 'streamOpened',
              description: 'A connection finished opening and is ready',
              payload: { kind: 'object', properties: {
                connectionId: { kind: 'primitive', primitive: 'string' },
                url: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'streamMessage',
              description: 'A message arrived on a connection. data is a string; binary frames arrive base64-encoded with binary: true.',
              payload: { kind: 'object', properties: {
                connectionId: { kind: 'primitive', primitive: 'string' },
                data: { kind: 'primitive', primitive: 'string' },
                binary: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
            {
              name: 'streamClosed',
              description: 'A connection closed (remote close, disconnect, or failure after open). No automatic reconnect: reopen with connect if wanted.',
              payload: { kind: 'object', properties: {
                connectionId: { kind: 'primitive', primitive: 'string' },
                code: { kind: 'primitive', primitive: 'number' },
                reason: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'streamError',
              description: 'A connection-level error occurred',
              payload: { kind: 'object', properties: {
                connectionId: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.STREAM_CONNECT],
        tags: ['system', 'capability', 'stream', 'network'],
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
    // connect can block on a user permission prompt (up to two minutes), so it
    // defers its reply to keep the processing loop free, like HttpClient does
    // for long fetches.
    this.on('connect', async (msg: AbjectMessage) => {
      const { url, kind, headers } = msg.payload as {
        url: string;
        kind?: StreamKind;
        headers?: Record<string, string>;
      };
      const owner = msg.routing.from;
      this.openConnection(url, kind, headers, owner).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'STREAM_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('send', async (msg: AbjectMessage) => {
      const { connectionId, data } = msg.payload as { connectionId: string; data: string };
      const conn = this.connections.get(connectionId);
      if (!conn) return { success: false, error: `Unknown connection ${connectionId}` };
      if (conn.kind !== 'ws') return { success: false, error: 'SSE connections are receive-only; send works on ws connections' };
      if (conn.state !== 'open' || !conn.ws) return { success: false, error: `Connection is ${conn.state}` };
      conn.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return { success: true };
    });

    this.on('disconnect', async (msg: AbjectMessage) => {
      const { connectionId } = msg.payload as { connectionId: string };
      const conn = this.connections.get(connectionId);
      if (!conn) return { success: false, error: `Unknown connection ${connectionId}` };
      this.closeConnection(conn, 1000, 'disconnect requested');
      return { success: true };
    });

    this.on('listConnections', async () => {
      return [...this.connections.values()].map((c) => ({
        connectionId: c.connectionId,
        url: c.url,
        kind: c.kind,
        owner: c.owner,
        openedAt: c.openedAt,
        messageCount: c.messageCount,
        state: c.state,
      }));
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
      if (enabled !== undefined) this.streamsDisabled = !enabled;
      if (allowedDomains !== undefined) {
        this.allowedDomains = allowedDomains.length > 0 ? new Set(allowedDomains) : undefined;
      }
      if (deniedDomains !== undefined) {
        this.deniedDomains = deniedDomains.length > 0 ? new Set(deniedDomains) : undefined;
      }
      return { success: true };
    });

    // The bus sends this when one of our events bounced off an unregistered
    // recipient. A dead owner cannot consume its streams anymore: close and
    // drop that owner's connections instead of firing events at it forever.
    this.on('recipientGone', async (msg: AbjectMessage) => {
      const { recipient } = msg.payload as { recipient?: AbjectId };
      if (!recipient) return true;
      for (const conn of [...this.connections.values()]) {
        if (conn.owner === recipient) {
          this.closeConnection(conn, 1001, 'owner gone');
          this.connections.delete(conn.connectionId);
        }
      }
      return true;
    });
  }

  // ── Connection lifecycle ──────────────────────────────────────────────

  private async openConnection(
    url: string,
    kind: StreamKind | undefined,
    headers: Record<string, string> | undefined,
    owner: AbjectId,
  ): Promise<{ connectionId: string }> {
    require(typeof url === 'string' && url.length > 0, 'connect requires a url');
    if (this.streamsDisabled) {
      throw new Error('Streaming access is disabled. Enable it in Settings > Permissions.');
    }

    const openCount = [...this.connections.values()].filter(c => c.state !== 'closed').length;
    if (openCount >= MAX_CONNECTIONS) {
      throw new Error(`Connection limit reached (${MAX_CONNECTIONS}). Disconnect an existing stream first.`);
    }

    const parsed = new URL(url);
    const resolvedKind = kind ?? (parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? 'ws' : 'sse');
    this.validateScheme(parsed.protocol, resolvedKind);
    await this.validateDomain(parsed.hostname);

    const connectionId = crypto.randomUUID();
    const conn: StreamConnection = {
      connectionId,
      url,
      kind: resolvedKind,
      owner,
      openedAt: Date.now(),
      messageCount: 0,
      state: 'connecting',
    };
    this.connections.set(connectionId, conn);

    if (resolvedKind === 'ws') {
      this.openWebSocket(conn, headers);
    } else {
      this.openSse(conn, headers);
    }

    return { connectionId };
  }

  private openWebSocket(conn: StreamConnection, headers?: Record<string, string>): void {
    const ws = new WebSocket(conn.url, { headers });
    conn.ws = ws;

    ws.on('open', () => {
      conn.state = 'open';
      this.changed('streamOpened', { connectionId: conn.connectionId, url: conn.url });
    });

    ws.on('message', (raw, isBinary) => {
      conn.messageCount++;
      const data = isBinary
        ? Buffer.isBuffer(raw) ? raw.toString('base64') : Buffer.from(raw as ArrayBuffer).toString('base64')
        : raw.toString();
      this.changed('streamMessage', {
        connectionId: conn.connectionId,
        data,
        binary: !!isBinary,
      });
    });

    ws.on('close', (code, reason) => {
      conn.state = 'closed';
      conn.ws = undefined;
      this.changed('streamClosed', {
        connectionId: conn.connectionId,
        code,
        reason: reason.toString(),
      });
      this.connections.delete(conn.connectionId);
    });

    ws.on('error', (err) => {
      this.changed('streamError', {
        connectionId: conn.connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // 'close' follows 'error' on ws and performs the cleanup.
    });
  }

  /**
   * Minimal Server-Sent Events client over plain http(s): accumulates `data:`
   * lines and dispatches one streamMessage per blank-line-terminated event.
   */
  private openSse(conn: StreamConnection, headers?: Record<string, string>): void {
    const parsed = new URL(conn.url);
    // Union of http.request/https.request overloads is not callable; pick one
    // signature and cast (the option/response shapes are structurally shared).
    const requestFn = (parsed.protocol === 'https:' ? https.request : http.request) as typeof http.request;

    const req = requestFn(conn.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...headers,
      },
    }, (res: http.IncomingMessage) => {
      if (res.statusCode === undefined || res.statusCode >= 400) {
        this.changed('streamError', {
          connectionId: conn.connectionId,
          error: `SSE endpoint answered HTTP ${res.statusCode}`,
        });
        this.closeConnection(conn, res.statusCode, 'http error');
        return;
      }

      conn.state = 'open';
      this.changed('streamOpened', { connectionId: conn.connectionId, url: conn.url });

      let buffer = '';
      let dataLines: string[] = [];

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);

          if (line === '') {
            // Blank line dispatches the accumulated event.
            if (dataLines.length > 0) {
              conn.messageCount++;
              this.changed('streamMessage', {
                connectionId: conn.connectionId,
                data: dataLines.join('\n'),
                binary: false,
              });
              dataLines = [];
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          // Other SSE fields (event:, id:, retry:, comments) are accepted and
          // ignored in v1; the data payload is what objects react to.
        }
      });

      res.on('end', () => {
        conn.state = 'closed';
        this.changed('streamClosed', {
          connectionId: conn.connectionId,
          reason: 'stream ended',
        });
        this.connections.delete(conn.connectionId);
      });
    });

    req.on('error', (err: Error) => {
      this.changed('streamError', {
        connectionId: conn.connectionId,
        error: err.message,
      });
      if (conn.state !== 'closed') {
        conn.state = 'closed';
        this.changed('streamClosed', {
          connectionId: conn.connectionId,
          reason: 'connection error',
        });
        this.connections.delete(conn.connectionId);
      }
    });

    req.end();
    conn.sseRequest = req;
  }

  private closeConnection(conn: StreamConnection, code?: number, reason?: string): void {
    if (conn.state === 'closed') return;
    conn.state = 'closed';
    if (conn.ws) {
      try { conn.ws.close(code ?? 1000, reason); } catch { /* already closing */ }
      conn.ws = undefined;
      // The ws 'close' handler emits streamClosed and deletes the record.
      return;
    }
    if (conn.sseRequest) {
      try { conn.sseRequest.destroy(); } catch { /* already destroyed */ }
      conn.sseRequest = undefined;
    }
    this.changed('streamClosed', {
      connectionId: conn.connectionId,
      code,
      reason: reason ?? '',
    });
    this.connections.delete(conn.connectionId);
  }

  protected override async onStop(): Promise<void> {
    for (const conn of [...this.connections.values()]) {
      this.closeConnection(conn, 1001, 'StreamClient stopping');
    }
    this.connections.clear();
  }

  // ── Validation (mirrors HttpClient) ───────────────────────────────────

  private validateScheme(protocol: string, kind: StreamKind): void {
    const allowed = kind === 'ws'
      ? ['ws:', 'wss:']
      : ['http:', 'https:'];
    if (!allowed.includes(protocol)) {
      throw new Error(`Scheme ${protocol} is not allowed for ${kind} connections; use ${allowed.join(' or ')}`);
    }
  }

  /**
   * Validate a domain: deny list, allow list, SSRF guard, and when the domain
   * is unlisted, ask the permissions authority (accept_once / accept_always /
   * deny / deny_always). Absent an authority, unlisted domains are allowed
   * only when no allow list is configured, matching HttpClient's behavior.
   */
  private async validateDomain(hostname: string): Promise<void> {
    if (this.deniedDomains?.has(hostname)) {
      throw new Error(`Domain ${hostname} is denied`);
    }

    // SSRF protection: block connections to private/internal addresses.
    if (this.isPrivateHost(hostname)) {
      throw new Error(`Domain ${hostname} is blocked: private/internal addresses are not allowed`);
    }

    if (this.allowedDomains && !this.allowedDomains.has(hostname)) {
      // Unlisted domain: ask the permissions authority before failing.
      if (this.permissionsAuthorityId) {
        const response = await this.request<{ decision: string }>(
          request(this.id, this.permissionsAuthorityId, 'requestPermission', {
            type: 'domain',
            resource: hostname,
            description: `Streaming connection to: ${hostname}`,
          }),
          120000,
        );
        switch (response.decision) {
          case 'accept_always':
            this.allowedDomains.add(hostname);
            return;
          case 'accept_once':
            return;
          case 'deny_always':
            if (!this.deniedDomains) this.deniedDomains = new Set();
            this.deniedDomains.add(hostname);
            throw new Error(`Domain ${hostname} was permanently denied by user`);
          case 'deny':
          default:
            throw new Error(`Domain ${hostname} was denied by user`);
        }
      }
      throw new Error(`Domain ${hostname} is not in allowed list`);
    }
  }

  /**
   * Check if a hostname resolves to a private/internal address.
   * Same rules as HttpClient's SSRF guard.
   */
  private isPrivateHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();

    if (lower === 'localhost' || lower === 'localhost.') return true;

    if (lower === '::1' || lower === '[::1]') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('[fe80:')) return true;
    if (lower.startsWith('fd') && (lower[2] === ':' || lower[2] === undefined || /^fd[0-9a-f]{2}:/.test(lower))) return true;
    if (lower.startsWith('[fd')) return true;

    const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;

    const ipv4Match = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b, c] = ipv4Match.map(Number);
      if (a === 127) return true;
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 0 && b === 0 && c === 0) return true;
    }

    return false;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## StreamClient Usage Guide

StreamClient holds persistent outbound connections open (WebSocket and
Server-Sent Events) and delivers incoming data as events, so your object
reacts to live feeds instead of polling.

### WebSocket

  // 1. Connect and register for events
  const { connectionId } = await this.call(
    this.dep('StreamClient'), 'connect',
    { url: 'wss://stream.example.com/ticker' });
  await this.call(this.dep('StreamClient'), 'addDependent', {});

  // 2. Receive messages in your changed handler
  async changed(msg) {
    const { aspect, value } = msg.payload;
    if (aspect === 'streamMessage' && value.connectionId === this._connId) {
      const tick = JSON.parse(value.data);
      // react to the live update
    }
    if (aspect === 'streamClosed' && value.connectionId === this._connId) {
      // reopen with connect if the feed should stay live
    }
  }

  // 3. Send (WebSocket only) and disconnect
  await this.call(this.dep('StreamClient'), 'send',
    { connectionId, data: JSON.stringify({ subscribe: 'BTC-USD' }) });
  await this.call(this.dep('StreamClient'), 'disconnect', { connectionId });

### Server-Sent Events (receive-only)

  const { connectionId } = await this.call(
    this.dep('StreamClient'), 'connect',
    { url: 'https://api.example.com/events', kind: 'sse',
      headers: { Authorization: 'Bearer token' } });
  // Each SSE event's data arrives as one streamMessage.

### Behavior notes
- Events go to dependents: call addDependent once after connecting.
- Connections stay open until disconnect, remote close, or error; there is
  no automatic reconnect, so listen for streamClosed and reopen when the
  feed should stay live.
- Up to ${MAX_CONNECTIONS} concurrent connections.
- Permissions: connections to domains outside the allow list prompt the user
  once (accept once/always or deny once/always) via Settings > Permissions.
  Private and internal addresses stay blocked.` + this.getRestrictionsGuide();
  }

  private getRestrictionsGuide(): string {
    if (this.streamsDisabled) {
      return `\n\n### RESTRICTIONS\nStreaming access is currently DISABLED.`;
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

// Well-known stream client ID
export const STREAM_CLIENT_ID = 'abjects:stream-client' as AbjectId;
