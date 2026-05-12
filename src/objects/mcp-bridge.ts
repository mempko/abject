/**
 * MCPBridge -- per-server Abject that owns an MCPTransport and exposes
 * the MCP server's tools as Abject method handlers.
 *
 * One MCPBridge instance exists per enabled MCP server. SkillRegistry
 * spawns bridges on enable and stops them on disable.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, error } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { MCPTransport } from '../network/mcp-transport.js';
import type {
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPInitResult,
  MCPListToolsResult,
  MCPListResourcesResult,
  MCPToolCallResult,
  MCPReadResourceResult,
  MCPContentItem,
} from '../core/mcp-types.js';
import { Log } from '../core/timed-log.js';
import { validateMCPToolInput, MCPInputValidationError } from './mcp-input-validation.js';
import { formatMCPToolList } from '../core/mcp-format.js';

const log = new Log('MCPBridge');

const MCP_BRIDGE_INTERFACE: InterfaceId = 'abjects:mcp-bridge';
const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_BRIDGE_ID = 'abjects:mcp-bridge' as AbjectId;

export type MCPBridgeStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface MCPBridgeConfig {
  serverName: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  configFile?: string;
}

export class MCPBridge extends Abject {
  private serverName: string;
  private command: string;
  private commandArgs: string[];
  private env: Record<string, string>;
  private configFile?: string;
  private transport: MCPTransport | null = null;
  private bridgeStatus: MCPBridgeStatus = 'idle';
  private bridgeStatusError?: string;

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
        description:
          `MCP bridge for "${config.serverName}". Spawns the MCP server as a child process ` +
          'and exposes its tools via message passing.',
        version: '1.0.0',
        interface: {
          id: MCP_BRIDGE_INTERFACE,
          name: 'MCPBridge',
          description: 'MCP server bridge operations',
          methods: [
            {
              name: 'callTool',
              description: 'Invoke an MCP tool on the connected server',
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
              }},
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'mcp'],
      },
    });

    this.serverName = config.serverName;
    this.command = config.command;
    this.commandArgs = config.args ?? [];
    this.env = config.env ?? {};
    this.configFile = config.configFile;

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    let prompt = super.askPrompt(_question);
    prompt += `\n\n## MCPBridge: ${this.serverName}\n\n`;
    prompt += `Owns a single running MCP server subprocess and exposes its tools and resources via message passing. Use this bridge for deterministic, LLM-free tool calls — it is the canonical low-level interface to the server.\n\n`;

    prompt += `### Status\n`;
    prompt += `- Subprocess: \`${this.command} ${this.commandArgs.join(' ')}\`\n`;
    prompt += `- Bridge state: ${this.bridgeStatus}\n`;
    if (this.bridgeStatusError) {
      prompt += `- Last error: ${this.bridgeStatusError}\n`;
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
      prompt += `// result: { content: string, isError: boolean }\n`;
      prompt += '```\n\n';
      prompt += 'Parameter-name aliases are accepted for MCP-standard compatibility: `tool` or `name` for the tool, `arguments` or `args` for the input. Tool names and parameter keys are case-sensitive.\n\n';
      prompt += `### Other methods\n\n`;
      prompt += `- \`listTools\`: returns \`MCPToolDefinition[]\` (the raw list behind the block above).\n`;
      prompt += `- \`readResource({ uri })\`: returns \`{ content, mimeType? }\`.\n`;
      prompt += `- \`getStatus\`: returns \`{ status, serverName, toolCount, error? }\`.\n\n`;
    } else {
      prompt += `### Tools\n\nNone yet (subprocess may still be starting or in an error state). Call \`getStatus\` to check, or \`listTools\` once the bridge reaches 'connected'.\n\n`;
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
    await this.connectToServer();
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

      return await this.callTool(toolName, input);
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
        configFile: this.configFile,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Server Connection
  // ═══════════════════════════════════════════════════════════════════

  private async connectToServer(): Promise<void> {
    this.bridgeStatus = 'connecting';

    this.transport = new MCPTransport();
    this.transport.on({
      onStateChange: (state) => {
        if (state === 'error' || state === 'closed') {
          this.bridgeStatus = 'error';
          this.bridgeStatusError = `Transport ${state}`;
          log.error(`[${this.serverName}] transport ${state}`);
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
        this.bridgeStatus = 'error';
        this.bridgeStatusError = err.message;
        log.error(`[${this.serverName}] error:`, err.message);
      },
    });

    try {
      await this.transport.start(this.command, this.commandArgs, this.env);

      // MCP initialization handshake
      const initResult = await this.transport.sendRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'abjects', version: '1.0.0' },
      }) as MCPInitResult;

      log.info(`[${this.serverName}] initialized: ${initResult.serverInfo?.name ?? 'unknown'} v${initResult.serverInfo?.version ?? '?'}`);
      this.serverInfo = {
        name: initResult.serverInfo?.name,
        version: initResult.serverInfo?.version,
      };

      // Send initialized notification (required by MCP spec)
      this.transport.sendNotification('notifications/initialized');

      // Discover tools and resources
      await this.refreshTools();
      await this.refreshResources();

      this.bridgeStatus = 'connected';
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
    } catch (err) {
      this.bridgeStatus = 'error';
      this.bridgeStatusError = err instanceof Error ? err.message : String(err);
      log.error(`[${this.serverName}] initialization failed:`, this.bridgeStatusError);
      // Don't rethrow -- let the bridge exist in error state so it can be inspected
    }
  }

  private async disconnectFromServer(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.bridgeStatus = 'idle';
    this.cachedTools = [];
    this.cachedResources = [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // Tool / Resource Operations
  // ═══════════════════════════════════════════════════════════════════

  private async callTool(toolName: string, input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    contractRequire(this.transport?.isConnected === true, `MCP server "${this.serverName}" is not connected`);

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

    const result = await this.transport!.sendRequest('tools/call', {
      name: toolName,
      arguments: input,
    }) as MCPToolCallResult;

    // Flatten content items to a string for agent consumption
    const text = this.flattenContent(result.content ?? []);
    return { content: text, isError: result.isError ?? false };
  }

  private async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    contractRequire(this.transport?.isConnected === true, `MCP server "${this.serverName}" is not connected`);

    const result = await this.transport!.sendRequest('resources/read', {
      uri,
    }) as MCPReadResourceResult;

    const first = result.contents?.[0];
    return {
      content: first?.text ?? first?.blob ?? '',
      mimeType: first?.mimeType,
    };
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

  private flattenContent(items: MCPContentItem[]): string {
    return items.map(item => {
      if (item.type === 'text' && item.text) return item.text;
      if (item.type === 'resource' && item.resource?.text) return item.resource.text;
      if (item.type === 'image' && item.data) return `[image: ${item.mimeType ?? 'unknown'}]`;
      return '';
    }).filter(Boolean).join('\n');
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
