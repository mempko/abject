/**
 * SkillAgent -- an agent that executes tasks using enabled skills.
 *
 * Registers with AgentAbject and claims tasks that match enabled skill
 * capabilities. Uses ShellExecutor, HttpClient, HostFileSystem, WebSearch,
 * and WebFetch as its action toolkit. Skill instructions and configured
 * env vars are injected into the LLM system prompt.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { AgentAction } from './agent-abject.js';
import type { EnabledSkillSummary } from '../core/skill-types.js';
import type { MCPServerSummary, MCPServerDetail } from './mcp-registry-client.js';
import type { ClawHubSkillSummary, SkillBundle } from './clawhub-client.js';
import { buildMcpSkillMd, packageToMcpCommand, sanitiseSkillName } from '../core/skill-synth.js';
import { formatMCPToolList } from '../core/mcp-format.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SkillAgent');

const SKILL_AGENT_INTERFACE: InterfaceId = 'abjects:skill-agent';

interface TaskExtra {
  lastResult?: string;
}

export class SkillAgent extends Abject {
  private agentAbjectId?: AbjectId;
  private shellExecutorId?: AbjectId;
  private httpClientId?: AbjectId;
  private hostFileSystemId?: AbjectId;
  private webSearchId?: AbjectId;
  private webFetchId?: AbjectId;
  private skillRegistryId?: AbjectId;
  private jobManagerId?: AbjectId;
  private goalManagerId?: AbjectId;
  private mcpRegistryClientId?: AbjectId;
  private clawHubClientId?: AbjectId;
  private _currentGoalId?: string;

  private taskExtras = new Map<string, TaskExtra>();
  private installedSkillDescriptions = '(none)';

  /** Cached system prompt (rebuilt when skills change). */
  private cachedSystemPrompt?: string;

  constructor() {
    super({
      manifest: {
        name: 'SkillAgent',
        description:
          'Agent that installs, manages, and executes skills and MCP servers. ' +
          'Handles skill installation, enable/disable, and routes tasks to skill-specific workflows for API integrations, data lookups, and other skill domains.',
        version: '1.0.0',
        interface: {
          id: SKILL_AGENT_INTERFACE,
          name: 'SkillAgent',
          description: 'Skill-based task execution agent',
          methods: [
            {
              name: 'runTask',
              description: 'Run a task using enabled skills',
              parameters: [
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.SHELL_EXECUTE, reason: 'Run shell commands for skill execution', required: true },
          { capability: Capabilities.LLM_QUERY, reason: 'LLM planning', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'agent', 'skill'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.shellExecutorId = await this.discoverDep('ShellExecutor') ?? undefined;
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.hostFileSystemId = await this.discoverDep('HostFileSystem') ?? undefined;
    this.webSearchId = await this.discoverDep('WebSearch') ?? undefined;
    this.webFetchId = await this.discoverDep('WebFetch') ?? undefined;
    this.skillRegistryId = await this.discoverDep('SkillRegistry') ?? undefined;
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.mcpRegistryClientId = await this.discoverDep('MCPRegistryClient') ?? undefined;
    this.clawHubClientId = await this.discoverDep('ClawHubClient') ?? undefined;

    // Subscribe to SkillRegistry changes to rebuild prompt
    if (this.skillRegistryId) {
      this.send(request(this.id, this.skillRegistryId, 'addDependent', {}));
    }

    // Register with AgentAbject -- description includes enabled skill names
    await this.registerWithAgentAbject();

    log.info('Registered with AgentAbject');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## SkillAgent — Installed Skill Execution Agent

### What I Handle
I manage and execute skills. I handle:
- Installing new MCP servers and skills (e.g., "install @shinzolabs/gmail-mcp")
- Enabling, disabling, and listing installed skills
- Executing tasks that match an installed and enabled skill's domain

Currently installed skills and their domains:
${this.getInstalledSkillsSummary()}

### My Scope
I handle skill installation, management, and tasks that match an installed skill's domain. General object interaction, web browsing, and object creation belong to other agents.

When asked about a task, describe which skill you would use and how. Say PASS if no installed skill matches the task and the task is not about installing or managing skills.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);

    if (this.skillRegistryId) {
      // Fetch skills and MCP servers in parallel
      const [allSkills, servers] = await Promise.all([
        this.request<Array<{ name: string; description: string; enabled: boolean; isMcpServer?: boolean; mcpStatus?: string; error?: string; configFile?: string }>>(
          request(this.id, this.skillRegistryId, 'listSkills', {}),
        ).catch(() => []),
        this.request<Array<{ name: string; tools: Array<{ name: string; description: string }> }>>(
          request(this.id, this.skillRegistryId, 'getEnabledMCPServers', {}),
        ).catch(() => []),
      ]);

      if (allSkills.length > 0) {
        prompt += '\n\nAll installed skills:\n';
        for (const s of allSkills) {
          const status = s.mcpStatus === 'error' ? 'error' : s.enabled ? 'enabled' : 'disabled';
          let line = `- ${s.name} [${status}]${s.error ? ` (${s.error})` : ''}: ${s.description.slice(0, 120)}`;
          if (s.configFile) line += ` [config: ${s.configFile}]`;
          prompt += line + '\n';
        }
      }

      if (servers.length > 0) {
        prompt += '\nConnected MCP servers and tools:\n';
        for (const s of servers) {
          prompt += `- ${s.name}: ${s.tools.map(t => t.name).join(', ')}\n`;
        }
      }
    }

    return this.askLlm(prompt, question, 'fast');
  }

  private getInstalledSkillsSummary(): string {
    return this.installedSkillDescriptions;
  }

  private setupHandlers(): void {
    // ── TupleSpace dispatch handler ──
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { goalId, description, approach, failureHistory } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; approach?: string;
        failureHistory?: Array<{ agent: string; error: string }>;
      };

      const taskId = `skill-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, {});
      this._currentGoalId = goalId;

      try {
        const systemPrompt = await this.buildSystemPrompt();

        const initialMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (failureHistory && failureHistory.length > 0) {
          const failSummary = failureHistory.map(f => `- ${f.agent}: ${f.error}`).join('\n');
          initialMessages.push(
            { role: 'user', content: `Task: ${description}\n\nPrevious attempts at this task failed:\n${failSummary}\n\nLearn from these failures and take a different approach.` },
          );
        }
        if (approach) {
          initialMessages.push(
            { role: 'assistant', content: `I will accomplish this as follows: ${approach}` },
          );
        }

        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt,
            goalId,
            initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
            config: {
              maxSteps: 15,
              timeout: 300000,
              queueName: `skill-agent-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 310000);
        return { success: result.success, result: result.result, error: result.error };
      } finally {
        this.taskExtras.delete(taskId);
        this._currentGoalId = undefined;
      }
    });

    // ── Direct runTask handler ──
    this.on('runTask', async (msg: AbjectMessage) => {
      const { task } = msg.payload as { task: string };
      const taskId = `skill-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, {});

      try {
        const systemPrompt = await this.buildSystemPrompt();
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task,
            systemPrompt,
            config: {
              maxSteps: 15,
              timeout: 300000,
              queueName: `skill-agent-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 310000);
        return { success: result.success, result: result.result };
      } finally {
        this.taskExtras.delete(taskId);
      }
    });

    // ── Ticket result handler ──
    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        pending.resolve(payload);
      }
    });

    // Forward progress to GoalManager so Chat's timeout resets during long operations.
    this.on('progress', (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      if (this._currentGoalId && this.goalManagerId) {
        const payload = msg.payload as { phase?: string; message?: string } | undefined;
        this.send(event(this.id, this.goalManagerId, 'updateProgress', {
          goalId: this._currentGoalId,
          message: payload?.message ?? 'working...',
          phase: payload?.phase ?? 'acting',
          agentName: 'SkillAgent',
        }));
      }
    });

    // ── AgentAbject callback handlers ──
    // Each callback proves the agent is still working, so reset the inactivity timeout.
    this.on('agentObserve', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId } = msg.payload as { taskId: string; step: number };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      return this.handleAct(taskId, action);
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => { this.resetPendingTicketTimeouts(); });
    this.on('agentActionResult', async () => { this.resetPendingTicketTimeouts(); });

    // ── SkillRegistry change handler ──
    this.on('changed', async (msg: AbjectMessage) => {
      if (msg.routing.from === this.skillRegistryId) {
        this.cachedSystemPrompt = undefined;
        // Re-register so agent description reflects current skills
        await this.registerWithAgentAbject();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Registration (dynamic based on enabled skills)
  // ═══════════════════════════════════════════════════════════════════

  private async registerWithAgentAbject(): Promise<void> {
    if (!this.agentAbjectId) return;

    // Build description from enabled skills only -- no generic capability language
    // so semantic matching only routes skill-specific tasks here.
    let description = 'Executes tasks only when they match an installed skill.';
    const skillNames: string[] = [];

    if (this.skillRegistryId) {
      try {
        const skills = await this.request<Array<{ name: string; description: string }>>(
          request(this.id, this.skillRegistryId, 'getEnabledSkills', {}),
        );
        if (skills.length > 0) {
          skillNames.push(...skills.map(s => s.name));
          description = `Executes tasks for these installed skills only: ${skills.map(s => `${s.name} (${s.description.slice(0, 80)})`).join('; ')}.`;
          this.installedSkillDescriptions = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
        } else {
          description = 'Skill execution agent (no skills currently enabled).';
          this.installedSkillDescriptions = '(none currently enabled)';
        }
      } catch { /* use default */ }
    }

    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'SkillAgent',
      description,
      config: {
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        queueName: `skill-agent-${this.id}`,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Observe / Act
  // ═══════════════════════════════════════════════════════════════════

  private async handleObserve(taskId: string): Promise<{ observation: string }> {
    const extra = this.taskExtras.get(taskId);
    const lastResult = extra?.lastResult ?? 'No previous action result.';

    // Include current skill state so the LLM knows what's already done
    let skillState = '';
    if (this.skillRegistryId) {
      try {
        const skills = await this.request<Array<{ name: string; description: string; enabled: boolean; mcpStatus?: string; error?: string; configFile?: string }>>(
          request(this.id, this.skillRegistryId, 'listSkills', {}),
        );
        if (skills.length > 0) {
          skillState = '\n\nInstalled skills:\n' + skills.map(s => {
            const status = s.mcpStatus === 'error' ? 'error' : s.enabled ? 'enabled' : 'disabled';
            let line = `- ${s.name} [${status}]${s.error ? ` (${s.error})` : ''}: ${s.description.slice(0, 100)}`;
            if (s.configFile) line += ` [config: ${s.configFile}]`;
            return line;
          }).join('\n');
        }
      } catch { /* best effort */ }

      try {
        const servers = await this.request<Array<{
          name: string; tools: Array<{ name: string }>;
        }>>(
          request(this.id, this.skillRegistryId, 'getEnabledMCPServers', {}),
        );
        if (servers.length > 0) {
          skillState += '\n\nConnected MCP servers:\n' + servers.map(s =>
            `- ${s.name}: ${s.tools.length} tools available`
          ).join('\n');
        }
      } catch { /* best effort */ }
    }

    return { observation: lastResult + skillState };
  }

  private async handleAct(taskId: string, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const extra = this.taskExtras.get(taskId) ?? {};
    this.taskExtras.set(taskId, extra);

    try {
      let result: string;

      switch (action.action) {
        case 'shell': {
          const command = action.command as string;
          if (!command) return { success: false, error: 'shell action requires "command" field' };
          if (!this.shellExecutorId) return { success: false, error: 'ShellExecutor not available' };

          const execResult = await this.request<{ stdout: string; stderr: string; exitCode: number }>(
            request(this.id, this.shellExecutorId, 'exec', {
              command,
              args: action.args as string[] | undefined,
              shell: true,
              timeout: 30000,
              skillName: 'skill-agent',
            }),
          );
          result = execResult.exitCode === 0
            ? (execResult.stdout || '(no output)')
            : `Exit code ${execResult.exitCode}\nstdout: ${execResult.stdout}\nstderr: ${execResult.stderr}`;
          break;
        }

        case 'http': {
          if (!this.httpClientId) return { success: false, error: 'HttpClient not available' };
          const method = (action.method as string || 'GET').toUpperCase();
          const url = action.url as string;
          if (!url) return { success: false, error: 'http action requires "url" field' };

          const httpResult = await this.request<{ status: number; body: string; ok: boolean }>(
            request(this.id, this.httpClientId, 'request', {
              method, url,
              headers: action.headers as Record<string, string> | undefined,
              body: action.body as string | undefined,
            }),
          );
          result = `HTTP ${httpResult.status}\n${httpResult.body?.slice(0, 30000) ?? ''}`;
          break;
        }

        case 'read_file': {
          if (!this.hostFileSystemId) return { success: false, error: 'HostFileSystem not available' };
          const path = action.path as string;
          if (!path) return { success: false, error: 'read_file action requires "path" field' };

          const fileResult = await this.request<{ content: string; lines: number }>(
            request(this.id, this.hostFileSystemId, 'readFile', { path }),
          );
          result = fileResult.content.slice(0, 30000);
          break;
        }

        case 'write_file': {
          if (!this.hostFileSystemId) return { success: false, error: 'HostFileSystem not available' };
          const path = action.path as string;
          const content = action.content as string;
          if (!path || content === undefined) return { success: false, error: 'write_file requires "path" and "content"' };

          await this.request(
            request(this.id, this.hostFileSystemId, 'writeFile', { path, content }),
          );
          result = `Wrote ${content.length} chars to ${path}`;
          break;
        }

        case 'search': {
          if (!this.webSearchId) return { success: false, error: 'WebSearch not available' };
          const query = action.query as string;
          if (!query) return { success: false, error: 'search action requires "query" field' };

          const searchResult = await this.request<{ results: Array<{ title: string; url: string; snippet: string }> }>(
            request(this.id, this.webSearchId, 'search', { query, maxResults: 5 }),
          );
          result = searchResult.results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
          break;
        }

        case 'fetch': {
          if (!this.webFetchId) return { success: false, error: 'WebFetch not available' };
          const url = action.url as string;
          if (!url) return { success: false, error: 'fetch action requires "url" field' };

          const fetchResult = await this.request<{ content: string; title: string }>(
            request(this.id, this.webFetchId, 'fetch', { url, maxLength: 30000 }),
          );
          result = fetchResult.content;
          break;
        }

        case 'install_skill': {
          if (!this.skillRegistryId) return { success: false, error: 'SkillRegistry not available' };
          const name = action.name as string;
          const content = action.content as string;
          if (!name || !content) return { success: false, error: 'install_skill requires "name" and "content" fields' };

          await this.request(
            request(this.id, this.skillRegistryId, 'installSkill', { name, content }),
          );
          result = `Installed skill "${name}"`;
          break;
        }

        case 'search_catalog': {
          const query = (action.query as string)?.trim() ?? '';
          const limit = typeof action.limit === 'number' && action.limit > 0 ? action.limit : 10;
          if (!query) return { success: false, error: 'search_catalog requires "query" field' };
          const hits = await this.searchCatalog(query, limit);
          if (hits.length === 0) {
            result = `No matches for "${query}" in the MCP registry or ClawHub.`;
          } else {
            const lines = hits.map(h => h.kind === 'mcp'
              ? `- [mcp] ${h.name}${h.version ? ' (' + h.version + ')' : ''}: ${h.description ?? ''}`
              : `- [skill] ${h.slug}${h.version ? ' (' + h.version + ')' : ''}: ${h.description ?? ''}`,
            );
            result = `Found ${hits.length} candidates:\n${lines.join('\n')}`;
          }
          break;
        }

        case 'install_mcp_server': {
          if (!this.mcpRegistryClientId) return { success: false, error: 'MCPRegistryClient not available' };
          if (!this.skillRegistryId) return { success: false, error: 'SkillRegistry not available' };
          const name = action.name as string;
          if (!name) return { success: false, error: 'install_mcp_server requires "name" field' };
          result = await this.installMcpServer(name);
          break;
        }

        case 'install_clawhub_skill': {
          if (!this.clawHubClientId) return { success: false, error: 'ClawHubClient not available' };
          if (!this.skillRegistryId) return { success: false, error: 'SkillRegistry not available' };
          const slug = action.slug as string;
          if (!slug) return { success: false, error: 'install_clawhub_skill requires "slug" field' };
          result = await this.installClawHubSkill(slug);
          break;
        }

        case 'enable_skill': {
          if (!this.skillRegistryId) return { success: false, error: 'SkillRegistry not available' };
          const name = action.name as string;
          if (!name) return { success: false, error: 'enable_skill requires "name" field' };

          await this.request(
            request(this.id, this.skillRegistryId, 'enableSkill', { name }),
          );
          result = `Enabled skill "${name}"`;
          break;
        }

        case 'disable_skill': {
          if (!this.skillRegistryId) return { success: false, error: 'SkillRegistry not available' };
          const name = action.name as string;
          if (!name) return { success: false, error: 'disable_skill requires "name" field' };

          await this.request(
            request(this.id, this.skillRegistryId, 'disableSkill', { name }),
          );
          result = `Disabled skill "${name}"`;
          break;
        }

        case 'list_skills': {
          if (!this.skillRegistryId) return { success: false, error: 'SkillRegistry not available' };

          const skills = await this.request<Array<{ name: string; description: string; enabled: boolean; error?: string }>>(
            request(this.id, this.skillRegistryId, 'listSkills', {}),
          );
          result = skills.length > 0
            ? skills.map(s => `${s.enabled ? '[enabled]' : '[disabled]'} ${s.name}: ${s.description}${s.error ? ` (error: ${s.error})` : ''}`).join('\n')
            : 'No skills installed.';
          break;
        }

        case 'mcp_tool_call': {
          const server = action.server as string;
          const tool = action.tool as string;
          const input = (action.input as Record<string, unknown>) ?? {};
          if (!server || !tool) return { success: false, error: 'mcp_tool_call requires "server" and "tool" fields' };

          // Discover the MCPBridge for this server
          const bridgeId = await this.discoverDep(`MCPBridge-${server}`);
          if (!bridgeId) return { success: false, error: `MCP server "${server}" not running. Is it enabled?` };

          const toolResult = await this.request<{ content: string; isError: boolean }>(
            request(this.id, bridgeId, 'callTool', { toolName: tool, input }),
          );

          if (toolResult.isError) {
            result = `MCP tool error: ${toolResult.content}`;
          } else {
            result = toolResult.content;
          }
          break;
        }

        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }

      extra.lastResult = result;
      return { success: true, data: result };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      extra.lastResult = `Error: ${errMsg}`;
      return { success: false, error: errMsg };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════════════════════

  private async buildSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;

    let prompt = `You are a skill execution agent. You complete tasks by running shell commands, making HTTP requests, reading/writing files, and searching the web.

## Output Format

You MUST respond with EXACTLY ONE JSON object inside \`\`\`json fenced code markers.
Do NOT use XML, function_calls tags, tool_call tags, or any other format.
Do NOT include any text outside the JSON block except brief reasoning before it.

Example response:

I'll fetch the accounts list first.

\`\`\`json
{ "action": "shell", "command": "curl -s -H \\"Authorization: Bearer $API_KEY\\" \\"https://api.example.com/accounts\\" | jq .", "reasoning": "Fetch accounts" }
\`\`\`

## Available Actions

| Action | Fields | Description |
|--------|--------|-------------|
| shell | command | Run a shell command (curl, jq, grep, etc.) |
| http | method, url, headers?, body? | Make an HTTP request |
| read_file | path | Read a file |
| write_file | path, content | Write a file |
| search | query | Search the web |
| fetch | url | Fetch a URL as cleaned text |
| mcp_tool_call | server, tool, input | Call a tool on a connected MCP server |
| install_skill | name, content | Install a skill by writing a SKILL.md file |
| enable_skill | name | Enable an installed skill (starts its MCP bridge if applicable) |
| search_catalog | query, limit? | Search the official MCP registry and the ClawHub skills registry (vendor-neutral, ~13k+ community skills). Use this first when the user asks to install something generic like "a PDF reader" — you can present matches before committing. |
| install_mcp_server | name | Install an MCP server by its registry name (e.g. the result of search_catalog). Fetches the package details, synthesises a SKILL.md, installs, and enables. |
| install_clawhub_skill | slug | Install a skill from ClawHub by slug (result of search_catalog). Downloads the ZIP bundle and writes it under the local skills directory. Does NOT auto-enable — the user reviews first. |
| disable_skill | name | Disable a skill |
| list_skills | | List all installed skills and their status |
| decompose | subtasks | Break a complex task into parallel sub-tasks dispatched to other agents. Each subtask has type (call, browse, create, modify, skill), description, and optional data. |
| done | result | Task complete. Include the answer in result. |
| fail | reason | Task cannot be completed |
| reply | message | Send a progress update to the user |

Every action can include a "reasoning" field explaining your thinking.

## Installing MCP Server Skills

Two paths, depending on whether the user named a specific package:

**By specific package name** (e.g., "install @shinzolabs/gmail-mcp"):
1. Use install_skill directly with a SKILL.md (exact format below). npx handles package installation automatically.
2. Use enable_skill to start the MCP bridge.
3. Check the observation to confirm the bridge connected and tools were discovered.
4. Report done.

**By capability** (e.g., "install a PDF reader", "install something that lets me search GitHub"):
1. Use search_catalog with a focused query to see what's in the MCP registry and ClawHub.
2. If there's a clear best match, call install_mcp_server (for MCP entries) or install_clawhub_skill (for ClawHub entries) with the picked identifier.
3. If several plausible options exist and you're not confident, use reply to list the top 3 and ask the user to pick.
4. Report done once installed. MCP servers are auto-enabled; ClawHub skills are not (the user reviews first), so note that in your reply.

SKILL.md format (frontmatter keys are always hyphenated):

\`\`\`
---
name: <short-name>
description: "<what the server provides>"
mcp-command: npx
mcp-args: ["-y", "<npm-package-name>"]
env:
  <ENV_VAR_NAME>: "<value>"
---

<Brief description of the MCP server.>
\`\`\`

Frontmatter rules:
- All keys are hyphenated: \`mcp-command\`, \`mcp-args\`
- \`mcp-command\` is always \`npx\` for npm packages
- \`mcp-args\` always starts with \`"-y"\` followed by the package name
- Include \`env\` with any required environment variables and their values
- When the user provides credentials, include them in the env block. Otherwise leave values empty and tell the user what is needed before enabling.
- Include \`config-file\` if the MCP server uses an external config file (e.g. \`config-file: ~/.config/email-mcp/config.toml\`)

## MCP Server Config Files

Some MCP servers use external config files (TOML, JSON, YAML) in addition to or instead of env vars. Skills with a config file show \`[config: <path>]\` in the skill list. Use \`read_file\` to inspect and \`write_file\` to update these config files. After editing a config file, disable then re-enable the skill to restart the bridge with the new configuration.

## Environment

Configured environment variables for enabled skills are pre-set in the shell.
You can reference them directly in commands: $VARIABLE_NAME
If a variable is not set, follow the skill's credential-loading instructions as a fallback.
When using curl, use -s (silent) and pipe JSON through jq.
`;

    // Append enabled skill instructions
    if (this.skillRegistryId) {
      try {
        const skills = await this.request<EnabledSkillSummary[]>(
          request(this.id, this.skillRegistryId, 'getEnabledSkills', {}),
        );
        if (skills.length > 0) {
          prompt += '\n## Enabled Skills\n\n';
          for (const skill of skills) {
            prompt += `### ${skill.name}\n${skill.description}\n`;
            if (skill.instructions) prompt += skill.instructions + '\n\n';

            // Show configured env vars (masked)
            if (skill.env) {
              const keys = Object.keys(skill.env).filter(k => skill.env![k]);
              if (keys.length > 0) {
                prompt += 'Configured environment variables (pre-set in shell):\n';
                for (const k of keys) {
                  prompt += `- ${k} (set)\n`;
                }
                prompt += '\n';
              }
            }
          }
        }
      } catch { /* SkillRegistry not available */ }
    }

    // Append connected MCP servers and their tools
    if (this.skillRegistryId) {
      try {
        const servers = await this.request<Array<{
          name: string;
          description: string;
          tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
          bridgeId?: string;
        }>>(
          request(this.id, this.skillRegistryId, 'getEnabledMCPServers', {}),
        );

        if (servers.length > 0) {
          prompt += `\n## Connected MCP Servers\n\n`;
          prompt += `These servers are running locally. To call one of their tools from inside this task, use the \`mcp_tool_call\` action — the LLM decides which tool fits the request. For scheduled or deterministic flows (e.g. polling every minute), prefer calling the MCPBridge directly from job code (\`call(bridgeId, 'callTool', { toolName, input })\`) so the loop runs without an LLM in it; ask the bridge via \`ask\` for a full per-tool schema at that point.\n\n`;
          for (const server of servers) {
            prompt += `### ${server.name}\n${server.description}\n\n`;
            if (server.tools.length > 0) {
              prompt += 'Available tools:\n';
              prompt += formatMCPToolList(server.tools);
              prompt += '\n';
            }
            prompt += `\nUse \`mcp_tool_call\` with \`server: "${server.name}"\`, \`tool: "<tool_name>"\`, and \`input: { ...parameters }\`. Pass parameter names exactly as listed (case-sensitive).\n\n`;
          }
        }
      } catch { /* MCP not available */ }
    }

    this.cachedSystemPrompt = prompt;
    return prompt;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ticket waiting (same pattern as WebAgent)
  // ═══════════════════════════════════════════════════════════════════

  private pendingTickets = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    timeoutMs: number;
  }>();

  private resetPendingTicketTimeouts(): void {
    for (const [ticketId, entry] of this.pendingTickets) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId }));
        }
        entry.reject(new Error(`Task ${ticketId} timed out after ${entry.timeoutMs}ms of inactivity`));
      }, entry.timeoutMs);
    }
  }

  private waitForTaskResult(ticketId: string, timeout: number): Promise<{ success: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const makeTimer = () => setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId }));
        }
        reject(new Error(`Task ${ticketId} timed out after ${timeout}ms of inactivity`));
      }, timeout);

      const entry = {
        timer: makeTimer(),
        timeoutMs: timeout,
        resolve: (payload: unknown) => {
          clearTimeout(entry.timer);
          this.pendingTickets.delete(ticketId);
          const p = payload as { success?: boolean; result?: unknown; error?: string; state?: { result?: unknown; error?: string } };
          const success = p.success !== false && !p.error;
          resolve({
            success,
            result: p.result ?? p.state?.result,
            error: p.error ?? p.state?.error,
          });
        },
        reject: (err: Error) => {
          clearTimeout(entry.timer);
          this.pendingTickets.delete(ticketId);
          reject(err);
        },
      };
      this.pendingTickets.set(ticketId, entry);
    });
  }

  // ─── Catalog search + install ───────────────────────────────────

  private async searchCatalog(query: string, limit: number): Promise<Array<
    | { kind: 'mcp'; name: string; description?: string; version?: string }
    | { kind: 'skill'; slug: string; description?: string; version?: string }
  >> {
    const hits: Array<
      | { kind: 'mcp'; name: string; description?: string; version?: string }
      | { kind: 'skill'; slug: string; description?: string; version?: string }
    > = [];

    if (this.mcpRegistryClientId) {
      try {
        const servers = await this.request<MCPServerSummary[]>(
          request(this.id, this.mcpRegistryClientId, 'search', { query, limit }),
          30000,
        );
        for (const s of servers) {
          hits.push({ kind: 'mcp', name: s.name, description: s.description, version: s.version });
        }
      } catch (err) {
        log.warn(`MCP registry search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.clawHubClientId) {
      try {
        const clawHits = await this.request<ClawHubSkillSummary[]>(
          request(this.id, this.clawHubClientId, 'search', { query, limit }),
          30000,
        );
        for (const s of clawHits) {
          hits.push({
            kind: 'skill',
            slug: s.slug,
            description: s.summary,
            version: s.latestVersion,
          });
        }
      } catch (err) {
        log.warn(`ClawHub search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return hits.slice(0, limit);
  }

  private async installMcpServer(name: string): Promise<string> {
    const detail = await this.request<MCPServerDetail>(
      request(this.id, this.mcpRegistryClientId!, 'getServer', { name }),
      30000,
    );
    const pkg = detail.packages?.find(p => !!p && !!(p.identifier ?? p.name));
    const { command, args } = packageToMcpCommand(pkg);
    if (!command) return `Cannot install "${name}": no supported package registry for this server.`;

    const skillName = sanitiseSkillName(detail.name);
    const content = buildMcpSkillMd({
      name: skillName,
      description: detail.description ?? `MCP server: ${detail.name}`,
      mcpCommand: command,
      mcpArgs: args,
    });

    await this.request(
      request(this.id, this.skillRegistryId!, 'installSkill', { name: skillName, content }),
    );
    await this.request(
      request(this.id, this.skillRegistryId!, 'enableSkill', { name: skillName }),
    );
    return `Installed and enabled MCP server "${detail.name}" as skill "${skillName}".`;
  }

  private async installClawHubSkill(slug: string): Promise<string> {
    const bundle = await this.request<SkillBundle>(
      request(this.id, this.clawHubClientId!, 'downloadSkill', { slug }),
      60000,
    );
    const skillName = sanitiseSkillName(slug);
    await this.request(
      request(this.id, this.skillRegistryId!, 'installSkillBundle', {
        name: skillName,
        entries: bundle.entries,
      }),
    );
    return `Installed skill "${skillName}" from ClawHub. Review the SKILL.md and use enable_skill once you're ready to run it.`;
  }
}

export const SKILL_AGENT_ID = 'abjects:skill-agent' as AbjectId;
