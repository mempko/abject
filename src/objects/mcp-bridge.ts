/**
 * MCPBridge -- per-server Abject that owns the link to one MCP server and
 * exposes the server's tools as Abject method handlers.
 *
 * One MCPBridge instance exists per enabled MCP server. SkillRegistry
 * spawns bridges on enable and stops them on disable.
 *
 * A local server (`command`) is a child process spoken to over stdio; a
 * remote one (`url`) is reached over HTTP. When a remote server answers 401,
 * the bridge has OAuthHelper sign the person in (status `signing_in` while
 * it waits for them), then connects with the token it gets, which only this
 * bridge can read. Status changes go to dependents as `bridgeStatus`.
 *
 * A tool its server annotates `destructiveHint: true` runs only after
 * PermissionBroker approves it (type `mcp_tool`), asked on behalf of the
 * caller; a refusal comes back as an `isError` result.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, error } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { refusalMessage, type PermissionReceipt } from '../core/permission-outcome.js';
import { MCPTransport, type MCPClientTransport } from '../network/mcp-transport.js';
import { MCPHttpTransport, MCPAuthRequiredError, type MCPHttpAuth } from '../network/mcp-http-transport.js';
import type {
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPInitResult,
  MCPListToolsResult,
  MCPListResourcesResult,
  MCPToolCallResult,
  MCPReadResourceResult,
  MCPContentItem,
  MCPImage,
} from '../core/mcp-types.js';
import { Log } from '../core/timed-log.js';
import { validateMCPToolInput, MCPInputValidationError } from './mcp-input-validation.js';
import { formatMCPToolList, mcpImageMarker } from '../core/mcp-format.js';

const log = new Log('MCPBridge');

const MCP_BRIDGE_INTERFACE: InterfaceId = 'abjects:mcp-bridge';
const MCP_PROTOCOL_VERSION = '2024-11-05';
/** Remote servers are newer than the stdio ecosystem; HTTP sessions start at this version. */
const MCP_HTTP_PROTOCOL_VERSION = '2025-06-18';
/**
 * How long a sign-in may take: the person has to see the question, agree, and
 * approve in a browser. OAuthHelper's dialogs heartbeat meanwhile; this only
 * bounds a sign-in whose helper has gone.
 */
const SIGN_IN_WAIT_MS = 20 * 60 * 1000;
/** A cached access token this close to expiry is fetched again. */
const TOKEN_SKEW_MS = 60 * 1000;

export const MCP_BRIDGE_ID = 'abjects:mcp-bridge' as AbjectId;

/** `signing_in`: a remote server asked for a sign-in and the person has been asked to approve it. */
export type MCPBridgeStatus = 'idle' | 'connecting' | 'signing_in' | 'connected' | 'error';

/**
 * What a server says about its own tool (MCP tool annotations). They are the
 * server's claims, not guarantees; the bridge acts on `destructiveHint` alone.
 */
interface MCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * How long a destructive call waits on PermissionBroker. The broker's dialog
 * heartbeats while the person decides, which keeps this and every caller
 * behind it alive, so the timer fires only if the broker itself is gone.
 */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;

/** Argument names whose values are never shown in a permission question. */
const SECRET_ARGUMENT = /token|secret|passw|api[-_]?key|auth|credential|cookie|session/i;

/**
 * A tool call's arguments as one short line for a person to judge:
 * `(owner: "me", repo: "demo")`. Strings are clipped, structures are counted,
 * and anything whose name says it is a secret is masked.
 */
function summarizeArguments(input: Record<string, unknown>): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const parts = Object.entries(input).map(([key, value]) => {
    if (SECRET_ARGUMENT.test(key)) return `${key}: ***`;
    if (typeof value === 'string') return `${key}: ${JSON.stringify(clip(value.replace(/\s+/g, ' '), 40))}`;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return `${key}: ${String(value)}`;
    if (Array.isArray(value)) return `${key}: [${value.length} item${value.length === 1 ? '' : 's'}]`;
    if (value && typeof value === 'object') return `${key}: {…}`;
    return `${key}: ${typeof value}`;
  });
  return parts.length > 0 ? `(${clip(parts.join(', '), 160)})` : '';
}

/** Exactly one of `command` (a local server) and `url` (a remote one). */
export interface MCPBridgeConfig {
  serverName: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  configFile?: string;
  /** Remote server: its MCP endpoint. */
  url?: string;
  /** Remote server: headers for every request; `${VAR}` is filled from `env`. */
  headers?: Record<string, string>;
  /** Remote server: a pre-registered OAuth client id. */
  oauthClientId?: string;
}

export class MCPBridge extends Abject {
  private serverName: string;
  private command?: string;
  private commandArgs: string[];
  private env: Record<string, string>;
  private configFile?: string;
  private url?: string;
  private headers: Record<string, string>;
  private oauthClientId?: string;
  private transport: MCPClientTransport | null = null;
  private bridgeStatus: MCPBridgeStatus = 'idle';
  private bridgeStatusError?: string;
  /** PermissionBroker, verified built-in; asked before a destructive tool runs. */
  private permissionBrokerId?: AbjectId;
  /** OAuthHelper, verified built-in; signs the person in and hands out this bridge's tokens. */
  private oauthHelperId?: AbjectId;
  /** The last token OAuthHelper gave (or that it had none), so each request does not ask again. */
  private cachedToken?: { token?: string; expiresAt?: number; fetchedAt: number };
  private signingIn = false;

  private cachedTools: MCPToolDefinition[] = [];
  private cachedResources: MCPResourceDefinition[] = [];

  /**
   * The remote MCP server's self-identification from the initialize
   * handshake. Captured for the dynamic manifest description so Registry's
   * catalog reflects what's actually bridged (e.g. "ProtonMail email
   * tools") instead of the static "MCP bridge" placeholder.
   */
  private serverInfo: { name?: string; version?: string } = {};

  constructor(config: MCPBridgeConfig) {
    const name = `MCPBridge-${config.serverName}`;
    super({
      manifest: {
        name,
        description: config.url
          ? `MCP bridge for "${config.serverName}". Connects to the remote MCP server at ${config.url} ` +
            'and exposes its tools via message passing.'
          : `MCP bridge for "${config.serverName}". Spawns the MCP server as a child process ` +
            'and exposes its tools via message passing.',
        version: '1.0.0',
        interface: {
          id: MCP_BRIDGE_INTERFACE,
          name: 'MCPBridge',
          description: 'MCP server bridge operations',
          methods: [
            {
              name: 'callTool',
              description: 'Invoke an MCP tool on the connected server. Returns { content, isError, images? }: images the tool returns come back in images (base64), each marked in content where it appeared. A tool its server marks destructive waits for the person\'s approval first and may come back declined, as an isError result that says so.',
              parameters: [
                { name: 'toolName', type: { kind: 'primitive', primitive: 'string' }, description: 'Tool name' },
                { name: 'input', type: { kind: 'object', properties: {} }, description: 'Tool input arguments' },
              ],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'listTools',
              description: 'List available tools on the connected server',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'MCPToolDefinition' } },
            },
            {
              name: 'readResource',
              description: 'Read a resource from the connected server',
              parameters: [
                { name: 'uri', type: { kind: 'primitive', primitive: 'string' }, description: 'Resource URI' },
              ],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'getStatus',
              description: 'Get current bridge connection status',
              parameters: [],
              returns: { kind: 'object', properties: {
                status: { kind: 'primitive', primitive: 'string' },
                serverName: { kind: 'primitive', primitive: 'string' },
                toolCount: { kind: 'primitive', primitive: 'number' },
                error: { kind: 'primitive', primitive: 'string' },
                stderrTail: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        tags: ['system', 'mcp'],
      },
    });

    contractRequire(!!config.command !== !!config.url, 'an MCP bridge needs exactly one of command and url');
    this.serverName = config.serverName;
    this.command = config.command;
    this.commandArgs = config.args ?? [];
    this.env = config.env ?? {};
    this.configFile = config.configFile;
    this.url = config.url;
    this.headers = config.headers ?? {};
    this.oauthClientId = config.oauthClientId;

    this.setupHandlers();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(!!this.command !== !!this.url, 'an MCP bridge has exactly one of command and url');
    invariant(this.bridgeStatus !== 'signing_in' || !!this.url, 'only a remote server signs in');
  }

  protected override askPrompt(_question: string): string {
    let prompt = super.askPrompt(_question);
    prompt += `\n\n## MCPBridge: ${this.serverName}\n\n`;
    prompt += `Owns a single running MCP server subprocess and exposes its tools and resources via message passing. Use this bridge for deterministic, LLM-free tool calls — it is the canonical low-level interface to the server.\n\n`;

    prompt += `### Status\n`;
    if (this.url) {
      prompt += `- Remote server: ${this.url}\n`;
      const headerNames = Object.keys(this.headers);
      if (headerNames.length > 0) prompt += `- Request headers: ${headerNames.join(', ')}\n`;
    } else {
      prompt += `- Subprocess: \`${this.command} ${this.commandArgs.join(' ')}\`\n`;
    }
    prompt += `- Bridge state: ${this.bridgeStatus}\n`;
    if (this.bridgeStatus === 'signing_in') {
      prompt += `- The server asked for a sign-in; the person has been asked to approve access in their browser, and the bridge connects by itself once they do.\n`;
    }
    if (this.bridgeStatusError) {
      prompt += `- Last error: ${this.bridgeStatusError}\n`;
    }
    const diagnostics = this.transport?.diagnosticTail;
    if (diagnostics && !this.bridgeStatusError?.includes(diagnostics)) {
      prompt += `- ${this.url ? 'Server responses' : 'Subprocess stderr'}: ${diagnostics}\n`;
    }
    const envKeys = Object.keys(this.env).filter(k => this.env[k]);
    if (envKeys.length > 0) {
      prompt += `- Configured env vars: ${envKeys.join(', ')}\n`;
    }
    if (this.configFile) {
      prompt += `- Config file: ${this.configFile}\n`;
    }
    prompt += '\n';

    if (this.cachedTools.length > 0) {
      prompt += `### Tools (${this.cachedTools.length})\n\n`;
      prompt += formatMCPToolList(this.cachedTools);
      prompt += `\n\n### Invoking a tool\n\n`;
      prompt += 'From inside job code (recommended for scheduled/deterministic flows):\n';
      prompt += '```js\n';
      prompt += `const result = await call(bridgeId, 'callTool', { toolName: '<tool>', input: { /* params */ } });\n`;
      prompt += `// result: { content: string, isError: boolean, images?: { mimeType: string, data: string }[] }\n`;
      prompt += '```\n\n';
      prompt += 'An image the tool returns arrives in `images` as base64 bytes, and `content` carries a line such as `[image 1: image/png, in images[0]]` where it appeared.\n\n';
      prompt += 'A tool the server marks destructive waits for the person to approve it, and a declined call returns `isError: true` with content saying who declined; report that and choose another way forward.\n\n';
      prompt += 'Parameter-name aliases are accepted for MCP-standard compatibility: `tool` or `name` for the tool, `arguments` or `args` for the input. Tool names and parameter keys are case-sensitive.\n\n';
      prompt += `### Other methods\n\n`;
      prompt += `- \`listTools\`: returns \`MCPToolDefinition[]\` (the raw list behind the block above).\n`;
      prompt += `- \`readResource({ uri })\`: returns \`{ content, mimeType? }\`.\n`;
      prompt += `- \`getStatus\`: returns \`{ status, serverName, toolCount, error? }\`.\n\n`;
    } else {
      prompt += `### Tools\n\nNone yet (the server may still be starting, waiting for a sign-in, or in an error state). Call \`getStatus\` to check, or \`listTools\` once the bridge reaches 'connected'.\n\n`;
    }

    prompt += `### Choosing between this bridge and SkillAgent\n\n`;
    prompt += `- **Scheduled polling, event-driven pipelines, deterministic tool wiring**: call this bridge directly from job code. Each call is one JSON-RPC round trip with zero LLM tokens, so loops that run every minute stay cheap. A polling job should short-circuit on empty results and only dispatch to SkillAgent when there is actually a batch worth reasoning about.\n`;
    prompt += `- **User-phrased natural-language requests** ("send a message on Telegram to Alice saying hi"): dispatch through SkillAgent. Its LLM picks the right tool and fills in arguments from the user's phrasing, then calls this bridge under the hood.\n`;
    prompt += `- **Code that already knows the tool + arguments**: this bridge is the right call. The schema block above names every parameter so job code can paste names verbatim.\n`;

    return prompt;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

  protected override async onInit(): Promise<void> {
    if (this.url) {
      // A remote server's sign-in and tokens come from OAuthHelper, which
      // serves only a registered bridge, and the Factory registers this one
      // only after onInit returns. So the connection starts once registered,
      // in the background; SkillRegistry follows it through bridgeStatus.
      this.setStatus('connecting');
      void this.whenRegistered()
        .then(() => this.connectToServer())
        .catch((err) => this.setStatus('error', err instanceof Error ? err.message : String(err)));
      return;
    }
    await this.connectToServer();
  }

  /** Resolves once the Registry knows this bridge (or after a bounded wait). */
  private async whenRegistered(): Promise<void> {
    const registryId = this.getRegistryId();
    if (!registryId) return;
    for (let delay = 25; delay <= 2000; delay *= 2) {
      try {
        const found = await this.request<unknown>(request(this.id, registryId, 'lookup', { objectId: this.id }), 5000);
        if (found) return;
      } catch { /* registry busy; try again */ }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    log.warn(`[${this.serverName}] not registered after waiting; connecting anyway`);
  }

  protected override async onStop(): Promise<void> {
    await this.disconnectFromServer();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('callTool', async (msg: AbjectMessage) => {
      // Accept multiple naming conventions (MCP standard uses name/arguments,
      // our manifest documents toolName/input). Both should work.
      const payload = msg.payload as {
        toolName?: string; tool?: string; name?: string;
        input?: Record<string, unknown>; arguments?: Record<string, unknown>; args?: Record<string, unknown>;
      };
      const toolName = payload.toolName ?? payload.tool ?? payload.name;
      const rawInput = payload.input ?? payload.arguments ?? payload.args ?? {};
      // Strip envelope-level keys that callers sometimes co-mingle with tool args.
      // `timeout` is a transport-level concern (per-call deadline), NOT an MCP
      // tool parameter — leaving it in `input` causes JSON-Schema validation to
      // reject the call with "unknown parameter timeout" for any tool whose
      // schema does not declare it (which is essentially all of them).
      const { timeout: _envelopeTimeout, ...input } = rawInput as Record<string, unknown>;
      void _envelopeTimeout;  // currently unused; could be wired into sendRequest deadline later
      contractRequire(typeof toolName === 'string' && toolName.length > 0, 'toolName must be non-empty (accepts toolName, tool, or name)');

      return await this.callTool(toolName, input, msg.routing.from, msg);
    });

    this.on('listTools', async (_msg: AbjectMessage) => {
      return this.cachedTools;
    });

    this.on('readResource', async (msg: AbjectMessage) => {
      const { uri } = msg.payload as { uri: string };
      contractRequire(typeof uri === 'string' && uri.length > 0, 'uri must be non-empty');

      return await this.readResource(uri);
    });

    this.on('getStatus', async (_msg: AbjectMessage) => {
      return {
        status: this.bridgeStatus,
        serverName: this.serverName,
        toolCount: this.cachedTools.length,
        error: this.bridgeStatusError,
        stderrTail: this.transport?.diagnosticTail || undefined,
        configFile: this.configFile,
        url: this.url,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Server Connection
  // ═══════════════════════════════════════════════════════════════════

  private async connectToServer(): Promise<void> {
    this.setStatus('connecting');

    const transport: MCPClientTransport = this.url
      ? new MCPHttpTransport({ url: this.url, headers: this.requestHeaders(), auth: this.oauthAuth() })
      : new MCPTransport();
    this.transport = transport;
    transport.on({
      onStateChange: (state) => {
        if (state === 'error' || state === 'closed') {
          log.error(`[${this.serverName}] transport ${state}`);
          this.setStatus('error', this.describeFailure(`Transport ${state}`));
        }
      },
      onNotification: (method, params) => {
        log.info(`[${this.serverName}] notification: ${method}`);
        if (method === 'notifications/tools/list_changed') {
          this.refreshTools()
            .then(() => this.publishEnrichedManifest())
            .catch((err) =>
              log.error(`[${this.serverName}] failed to refresh tools:`, err));
        }
      },
      onError: (err) => {
        log.error(`[${this.serverName}] error:`, err.message);
        this.setStatus('error', err.message);
      },
    });

    try {
      if (transport instanceof MCPHttpTransport) await transport.start();
      else await (transport as MCPTransport).start(this.command!, this.commandArgs, this.env);
      await this.handshake();
    } catch (err) {
      if (err instanceof MCPAuthRequiredError && this.signsInWithOAuth()) {
        // Don't wait for the person here: onInit must return so the Factory
        // can register this bridge. The sign-in runs on its own and connects
        // when it is done.
        this.beginSignIn(err.challenge);
        return;
      }
      const failure = this.describeFailure(err instanceof Error ? err.message : String(err));
      log.error(`[${this.serverName}] initialization failed:`, failure);
      // Don't rethrow -- let the bridge exist in error state so it can be inspected
      this.setStatus('error', failure);
    }
  }

  /** The MCP handshake, then tool and resource discovery. Leaves the bridge connected. */
  private async handshake(): Promise<void> {
    const transport = this.transport;
    contractRequire(transport !== null, 'handshake needs a transport');

    // MCP initialization handshake
    const initResult = await transport!.sendRequest('initialize', {
      protocolVersion: this.url ? MCP_HTTP_PROTOCOL_VERSION : MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'abjects', version: '1.0.0' },
    }) as MCPInitResult;

    log.info(`[${this.serverName}] initialized: ${initResult.serverInfo?.name ?? 'unknown'} v${initResult.serverInfo?.version ?? '?'}`);
    this.serverInfo = {
      name: initResult.serverInfo?.name,
      version: initResult.serverInfo?.version,
    };

    // Send initialized notification (required by MCP spec)
    transport!.sendNotification('notifications/initialized');

    // Discover tools and resources
    await this.refreshTools();
    await this.refreshResources();

    this.setStatus('connected');
    log.info(`[${this.serverName}] connected with ${this.cachedTools.length} tools, ${this.cachedResources.length} resources`);

    // Publish a manifest that reflects what the server actually exposes.
    // Registry's catalog reads `manifest.description` — without this
    // update, it sees only the generic "MCP bridge for foo" line and
    // never knows the bridge can do email/calendar/etc.
    //
    // FIRE-AND-FORGET. We must not block here: `connectToServer` runs
    // inside onInit, and Factory.spawn registers us in Registry AFTER
    // onInit returns. If we awaited the publish synchronously, the
    // updateManifest call would race against a registration that's
    // waiting for us to finish — a deadlock that exhausted the retry
    // budget on every spawn. By detaching, onInit returns quickly,
    // Factory registers us, and the deferred publish (still retrying
    // in the background) finds Registry knows about us within the
    // first one or two attempts.
    this.publishEnrichedManifest().catch((err) => {
      log.warn(`[${this.serverName}] manifest enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Record a status change and tell dependents (SkillRegistry) about it. */
  private setStatus(status: MCPBridgeStatus, error?: string): void {
    const changed = status !== this.bridgeStatus || error !== this.bridgeStatusError;
    this.bridgeStatus = status;
    this.bridgeStatusError = error;
    if (changed) {
      // A sign-in can settle after this bridge has been stopped; there is
      // nobody left to tell then.
      try {
        this.changed('bridgeStatus', { status, error, toolCount: this.cachedTools.length });
      } catch { /* stopped */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Remote servers: headers and sign-in
  // ═══════════════════════════════════════════════════════════════════

  /** The configured headers, with `${VAR}` filled from the skill's env. */
  private requestHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.headers)) {
      out[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => this.env[key] ?? '');
    }
    return out;
  }

  /**
   * A remote server signs in with OAuth unless the skill already sends its
   * own Authorization header (an API key); a refusal of that is a credential
   * problem for the skill's config, not a sign-in.
   */
  private signsInWithOAuth(): boolean {
    return !!this.url && !Object.keys(this.headers).some(h => h.toLowerCase() === 'authorization');
  }

  /** The bearer token source handed to the HTTP transport. */
  private oauthAuth(): MCPHttpAuth | undefined {
    if (!this.signsInWithOAuth()) return undefined;
    return {
      token: async () => {
        const cached = this.cachedToken;
        // Fetched again a little before it expires: a minute early, or a
        // quarter of its life early for a token that lives only minutes.
        const margin = cached?.expiresAt ? Math.min(TOKEN_SKEW_MS, (cached.expiresAt - cached.fetchedAt) / 4) : 0;
        const fresh = cached && (!cached.token || !cached.expiresAt || cached.expiresAt - Date.now() > margin);
        if (fresh) return cached.token;
        return this.fetchToken(false);
      },
      refresh: async () => !!(await this.fetchToken(true)),
    };
  }

  /** Ask OAuthHelper for this bridge's token; undefined when there is no usable grant. */
  private async fetchToken(forceRefresh: boolean): Promise<string | undefined> {
    const helperId = await this.oauthHelper();
    if (!helperId) return undefined;
    try {
      const got = await this.request<{ token?: string; expiresAt?: number }>(
        request(this.id, helperId, 'mcpAccessToken', {
          provider: this.oauthProvider(), serverUrl: this.url, forceRefresh,
        }),
        30000,
      );
      this.cachedToken = { token: got?.token, expiresAt: got?.expiresAt, fetchedAt: Date.now() };
      return got?.token;
    } catch (err) {
      log.warn(`[${this.serverName}] could not get a token: ${err instanceof Error ? err.message : String(err)}`);
      this.cachedToken = undefined;
      return undefined;
    }
  }

  private oauthProvider(): string {
    return `mcp:${this.serverName}`;
  }

  /**
   * Have the person sign in, then connect. Runs in the background; the
   * status says `signing_in` until it settles either way.
   */
  private beginSignIn(challenge: string | undefined): void {
    if (this.signingIn) return;
    this.signingIn = true;
    const host = new URL(this.url!).host;
    this.cachedTools = [];
    this.setStatus('signing_in', `${host} asks for a sign-in. The person has been asked to approve access in their browser; this bridge connects once they do.`);
    void this.signIn(challenge, host)
      .catch((err) => log.warn(`[${this.serverName}] sign-in ended abnormally: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { this.signingIn = false; });
  }

  private async signIn(challenge: string | undefined, host: string): Promise<void> {
    const helperId = await this.oauthHelper();
    if (!helperId) {
      this.setStatus('error', `${host} asks for a sign-in, but OAuthHelper is not running to do it.`);
      return;
    }
    try {
      await this.request(
        request(this.id, helperId, 'authorizeMcp', {
          provider: this.oauthProvider(),
          serverUrl: this.url,
          challenge,
          clientId: this.oauthClientId,
        }),
        SIGN_IN_WAIT_MS,
      );
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).replace(/^[A-Z_]+: /, '');
      log.warn(`[${this.serverName}] sign-in did not complete: ${reason}`);
      this.setStatus('error', `Sign-in to ${host} did not complete: ${reason}. Enabling the skill again asks again.`);
      return;
    }
    if ((this.bridgeStatus as MCPBridgeStatus) !== 'signing_in') return; // stopped meanwhile
    this.cachedToken = undefined;
    try {
      await this.handshake();
    } catch (err) {
      const failure = err instanceof MCPAuthRequiredError
        ? `${host} still refuses access after signing in: ${err.message}`
        : this.describeFailure(err instanceof Error ? err.message : String(err));
      log.error(`[${this.serverName}] connecting after sign-in failed:`, failure);
      this.setStatus('error', failure);
    }
  }

  /**
   * The built-in OAuthHelper, found once. As with PermissionBroker, a name
   * alone proves nothing, so only a built-in registration is used.
   */
  private async oauthHelper(): Promise<AbjectId | undefined> {
    if (this.oauthHelperId) return this.oauthHelperId;
    const id = await this.discoverDep('OAuthHelper').catch(() => null);
    if (!id || !(await this.isBuiltInCaller(id, ['OAuthHelper']))) return undefined;
    this.oauthHelperId = id;
    return id;
  }

  /**
   * Fold the subprocess's own stderr into a failure message. The server
   * almost always prints the actual reason it refused to start (missing
   * credential, malformed config, unknown flag); reporting only the exit
   * code throws that away and leaves the caller guessing.
   */
  private describeFailure(message: string): string {
    const label = this.url ? 'Server responses:' : 'Server stderr:';
    if (message.includes(label)) return message;
    const tail = this.transport?.diagnosticTail;
    return tail ? `${message}\n${label}\n${tail}` : message;
  }

  private async disconnectFromServer(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.bridgeStatus = 'idle';
    this.bridgeStatusError = undefined;
    this.cachedTools = [];
    this.cachedResources = [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // Tool / Resource Operations
  // ═══════════════════════════════════════════════════════════════════

  private async callTool(
    toolName: string,
    input: Record<string, unknown>,
    callerId: AbjectId,
    msg?: AbjectMessage,
  ): Promise<{ content: string; isError: boolean; images?: MCPImage[]; permission?: PermissionReceipt }> {
    this.requireConnected();

    // Validate the tool exists
    const tool = this.cachedTools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found on MCP server "${this.serverName}". Available: ${this.cachedTools.map(t => t.name).join(', ')}`);
    }

    // Validate input against the tool's JSON schema before dispatching.
    // This turns opaque server-side errors (e.g. "Email undefined not found")
    // into deterministic, parameter-level feedback the agent can act on.
    try {
      validateMCPToolInput(toolName, tool.inputSchema, input);
    } catch (err) {
      if (err instanceof MCPInputValidationError) {
        log.info(`[${this.serverName}] rejecting ${toolName}: ${err.message}`);
      }
      throw err;
    }

    const refusal = await this.consentFor(tool, input, callerId, msg);
    if (refusal) return refusal;
    // The person may have taken a while; the server may be gone by now.
    this.requireConnected();

    const result = await this.remote(() => this.transport!.sendRequest('tools/call', {
      name: toolName,
      arguments: input,
    })) as MCPToolCallResult;

    // Text for agents; images travel beside it as data.
    const { text, images } = this.flattenContent(result.content ?? []);
    return { content: text, isError: result.isError ?? false, ...(images.length > 0 ? { images } : {}) };
  }

  /**
   * A tool its server marks destructive runs only once PermissionBroker says
   * so, asked on behalf of whoever called. Only an explicit
   * `destructiveHint: true` counts, and not when the same tool also claims
   * `readOnlyHint: true`; a tool with no annotations runs as before, since
   * reading intent into a name or description is guessing.
   *
   * Returns the refusal as a tool result (`isError`), the shape every caller
   * of callTool already handles, or undefined to go ahead.
   */
  private async consentFor(
    tool: MCPToolDefinition,
    input: Record<string, unknown>,
    callerId: AbjectId,
    msg?: AbjectMessage,
  ): Promise<{ content: string; isError: true; permission: PermissionReceipt } | undefined> {
    const hints = (tool as MCPToolDefinition & { annotations?: MCPToolAnnotations }).annotations;
    if (hints?.destructiveHint !== true || hints.readOnlyHint === true) return undefined;
    // Who is asking, with the task and grant it runs under (permission-modes §6),
    // resolved only for a call that needs consent.
    const who: { callerId: AbjectId; taskId?: string; grantId?: string } = msg
      ? await this.capabilityCaller(msg).catch(() => ({ callerId }))
      : { callerId };

    const scope = `${this.serverName}/${tool.name}`;
    const args = summarizeArguments(input);
    const resource = args ? `${scope} ${args}` : scope;
    const action = `run ${resource}`;
    const receipt = (source: PermissionReceipt['source'], reason: string, decision = 'deny'): PermissionReceipt => ({
      authority: this.id, callerId, operation: 'mcp_tool', resource, decision, source, reason,
    });
    const refuse = (permission: PermissionReceipt) => {
      log.info(`[${this.serverName}] ${tool.name} not run: ${permission.reason}`);
      return { content: refusalMessage(permission, action), isError: true as const, permission };
    };

    const brokerId = await this.permissionBroker();
    if (!brokerId) return refuse(receipt('unavailable', 'no permission broker is running'));
    try {
      const response = await this.request<{ decision: string; receipt?: PermissionReceipt }>(
        request(this.id, brokerId, 'requestPermission', {
          type: 'mcp_tool', scope, resource, callerId: who.callerId,
          ...(who.taskId ? { taskId: who.taskId } : {}),
          ...(who.grantId ? { grantId: who.grantId } : {}),
          description: hints.title ?? tool.name,
          detail: [
            ...(tool.description ? [`Tool       ${tool.description.replace(/\s+/g, ' ').slice(0, 160)}`] : []),
            ...(args ? [`Arguments  ${args}`] : []),
          ],
        }),
        PERMISSION_WAIT_MS,
      );
      if (response?.decision?.startsWith('accept')) return undefined;
      return refuse(response?.receipt ?? receipt('policy', 'refused by PermissionBroker', response?.decision));
    } catch (err) {
      // A broker that stopped answering may have been respawned under a new id.
      this.permissionBrokerId = undefined;
      return refuse(receipt('unavailable', err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * The built-in PermissionBroker, found once. Its registered name alone
   * proves nothing, so the id is accepted only from a built-in registration:
   * an object that merely calls itself PermissionBroker never answers here.
   */
  private async permissionBroker(): Promise<AbjectId | undefined> {
    if (this.permissionBrokerId) return this.permissionBrokerId;
    const id = await this.discoverDep('PermissionBroker').catch(() => null);
    if (!id || !(await this.isBuiltInCaller(id, ['PermissionBroker']))) return undefined;
    this.permissionBrokerId = id;
    return id;
  }

  private async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    this.requireConnected();

    const result = await this.remote(() => this.transport!.sendRequest('resources/read', {
      uri,
    })) as MCPReadResourceResult;

    const first = result.contents?.[0];
    return {
      content: first?.text ?? first?.blob ?? '',
      mimeType: first?.mimeType,
    };
  }

  /** Calls are taken only once the handshake is done and while the link is up. */
  private requireConnected(): void {
    const waiting = this.bridgeStatus === 'signing_in'
      ? ': it is waiting for the person to sign in to the server'
      : '';
    contractRequire(this.bridgeStatus === 'connected' && this.transport?.isConnected === true,
      `MCP server "${this.serverName}" is not connected${waiting}`);
  }

  /**
   * Run a call against the server. A remote server that stops accepting this
   * bridge's token (revoked, or the refresh token expired) sends the bridge
   * back to signing in, and the call fails saying so.
   */
  private async remote<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof MCPAuthRequiredError && this.signsInWithOAuth()) {
        this.beginSignIn(err.challenge);
        throw new Error(`${new URL(this.url!).host} needs the person to sign in again. They have been asked to approve access; try again once they have.`);
      }
      throw err;
    }
  }

  private async refreshTools(): Promise<void> {
    if (!this.transport?.isConnected) return;

    try {
      const result = await this.transport.sendRequest('tools/list', {}) as MCPListToolsResult;
      this.cachedTools = result.tools ?? [];
    } catch (err) {
      log.info(`[${this.serverName}] tools/list not supported or failed:`, err instanceof Error ? err.message : String(err));
      this.cachedTools = [];
    }
  }

  private async refreshResources(): Promise<void> {
    if (!this.transport?.isConnected) return;

    try {
      const result = await this.transport.sendRequest('resources/list', {}) as MCPListResourcesResult;
      this.cachedResources = result.resources ?? [];
    } catch (err) {
      log.info(`[${this.serverName}] resources/list not supported or failed:`, err instanceof Error ? err.message : String(err));
      this.cachedResources = [];
    }
  }

  /**
   * A tool result as text for agents, with its images as data. Each image
   * leaves a marker line where it appeared (mcpImageMarker). Content this
   * bridge cannot pass on is named rather than left out, so a caller never
   * takes its absence for something it was given.
   */
  private flattenContent(items: MCPContentItem[]): { text: string; images: MCPImage[] } {
    const images: MCPImage[] = [];
    const image = (mimeType: string, data: string): string => {
      images.push({ mimeType, data });
      return mcpImageMarker(images.length, mimeType);
    };
    const text = items.map(item => {
      if (item.type === 'text' && item.text) return item.text;
      if (item.type === 'image' && item.data) return image(item.mimeType ?? 'image/png', item.data);
      if (item.type === 'resource' && item.resource?.text) return item.resource.text;
      if (item.type === 'resource' && item.resource?.blob) {
        const { uri, mimeType, blob } = item.resource;
        return mimeType?.startsWith('image/')
          ? image(mimeType, blob)
          : `[${uri}: ${mimeType ?? 'binary'} content, not passed on]`;
      }
      if (item.type === 'resource_link' && item.uri) return `[${item.name ?? item.uri}](${item.uri})`;
      if (item.type === 'audio') return `[audio (${item.mimeType ?? 'unknown type'}), not passed on]`;
      return '';
    }).filter(Boolean).join('\n');
    return { text, images };
  }

  /**
   * Push an updated manifest to Registry that reflects what this bridge
   * actually exposes. Without this, the bridge's catalog entry says only
   * "MCP bridge for foo" — agents asking Registry "which objects do
   * email/calendar/chat?" cannot find it because the manifest gives no
   * signal about the wrapped server's domain.
   *
   * The new description embeds:
   *   - The MCP server's self-reported identity (name + version)
   *   - The full list of tools (name + raw description from the server)
   *
   * No keyword inference, no inferred tags — the raw tool descriptions
   * from the server are the truth. The Registry's ask-LLM classifies
   * (e.g. "MCPBridge-protonmail-mcp exposes search_emails, send_email,
   * read_inbox... → this is email-capable") at retrieval time. If the
   * upstream server later evolves new tools, that signal flows through
   * the next refreshTools cycle automatically (a tools/list_changed
   * notification triggers a republish).
   *
   * Description is capped to keep the catalog manageable; if the tool
   * list overflows, names are kept and descriptions are clipped.
   */
  private async publishEnrichedManifest(): Promise<void> {
    const registryId = this.getRegistryId();
    if (!registryId) return;

    const newDescription = this.buildEnrichedDescription();
    const newManifest = {
      ...this.manifest,
      description: newDescription,
    };

    // Race window: Factory.spawn() registers an object in Registry AFTER
    // `onInit` returns. `connectToServer` (and thus this method) runs
    // inside onInit, so on the first attempt the Registry doesn't know
    // about us yet and `updateManifest` silently returns `false`. Retry
    // with small backoff until the registration lands. The MCP subprocess
    // startup typically takes seconds — by then registration has long
    // since completed, so this usually succeeds on the first try; the
    // retry is for the edge case where connect is fast or registration
    // is slow.
    const maxAttempts = 8;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const ok = await this.request<boolean>(
          request(this.id, registryId, 'updateManifest', {
            objectId: this.id,
            manifest: newManifest,
          }),
          5000,
        );
        if (ok === true) {
          log.info(`[${this.serverName}] published enriched manifest (${this.cachedTools.length} tool(s)) on attempt ${attempt}`);
          return;
        }
        lastError = `Registry returned ${ok}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      // Backoff: 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms, 5000ms, 5000ms
      const delay = Math.min(100 * Math.pow(2, attempt - 1), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    log.warn(`[${this.serverName}] updateManifest never succeeded after ${maxAttempts} attempts (last: ${lastError ?? 'unknown'})`);
  }

  /**
   * Build the manifest description text. Layout:
   *
   *   Bridges MCP server "<server.name>" v<version>. Exposes <N> tool(s)
   *   via callTool({ toolName, input }):
   *     - <tool>: <description>
   *     - <tool>: <description>
   *     ...
   *
   * Total length is bounded; once the budget is hit, remaining tools
   * collapse to a name-only summary line ("plus N more: a, b, c, ...").
   */
  private buildEnrichedDescription(): string {
    const MAX_LEN = 6000;
    const PER_TOOL_DESC_LIMIT = 200;

    const sn = this.serverInfo.name ?? this.serverName;
    const sv = this.serverInfo.version ? ` v${this.serverInfo.version}` : '';
    const head = this.cachedTools.length === 0
      ? `MCP bridge wrapping the "${sn}"${sv} server. The subprocess is connected but currently exposes no tools (call \`getStatus\` for diagnostics).`
      : `MCP bridge wrapping the "${sn}"${sv} server. Exposes ${this.cachedTools.length} tool(s) via \`callTool({ toolName, input })\`. Tools:\n`;

    let body = '';
    const remaining: string[] = [];
    for (let i = 0; i < this.cachedTools.length; i++) {
      const tool = this.cachedTools[i];
      const desc = (tool.description ?? '').trim().replace(/\s+/g, ' ');
      const clipped = desc.length > PER_TOOL_DESC_LIMIT
        ? desc.slice(0, PER_TOOL_DESC_LIMIT) + '…'
        : desc;
      const line = clipped
        ? `  - ${tool.name}: ${clipped}\n`
        : `  - ${tool.name}\n`;
      if (head.length + body.length + line.length > MAX_LEN) {
        remaining.push(tool.name);
      } else {
        body += line;
      }
    }
    if (remaining.length > 0) {
      body += `  - plus ${remaining.length} more tool(s): ${remaining.join(', ')}\n`;
    }
    return head + body;
  }
}
