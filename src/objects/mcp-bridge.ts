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
    prompt += `\n\nMCP Server: "${this.serverName}"`;
    prompt += `\nCommand: ${this.command} ${this.commandArgs.join(' ')}`;
    prompt += `\nStatus: ${this.bridgeStatus}`;
    if (this.bridgeStatusError) {
      prompt += `\nError: ${this.bridgeStatusError}`;
    }
    if (this.cachedTools.length > 0) {
      prompt += `\nTools (${this.cachedTools.length}): ${this.cachedTools.map(t => t.name).join(', ')}`;
    } else {
      prompt += `\nTools: none discovered (server may have failed to start)`;
    }
    const envKeys = Object.keys(this.env).filter(k => this.env[k]);
    if (envKeys.length > 0) {
      prompt += `\nConfigured env vars: ${envKeys.join(', ')}`;
    }
    if (this.configFile) {
      prompt += `\nConfig file: ${this.configFile}`;
    }
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
      const { toolName, input } = msg.payload as { toolName: string; input?: Record<string, unknown> };
      contractRequire(typeof toolName === 'string' && toolName.length > 0, 'toolName must be non-empty');

      return await this.callTool(toolName, input ?? {});
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
          this.refreshTools().catch((err) =>
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

      // Send initialized notification (required by MCP spec)
      this.transport.sendNotification('notifications/initialized');

      // Discover tools and resources
      await this.refreshTools();
      await this.refreshResources();

      this.bridgeStatus = 'connected';
      log.info(`[${this.serverName}] connected with ${this.cachedTools.length} tools, ${this.cachedResources.length} resources`);
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
}
