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

  private taskExtras = new Map<string, TaskExtra>();

  /** Cached system prompt (rebuilt when skills change). */
  private cachedSystemPrompt?: string;

  constructor() {
    super({
      manifest: {
        name: 'SkillAgent',
        description:
          'Agent that executes tasks using enabled skills. Has access to shell commands (curl, jq, etc.), ' +
          'HTTP requests, file system, and web search. Use for API integrations, data lookups, ' +
          'finance queries, and any task that installed skills can handle.',
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

    // Subscribe to SkillRegistry changes to rebuild prompt
    if (this.skillRegistryId) {
      this.send(request(this.id, this.skillRegistryId, 'addDependent', {}));
    }

    // Register with AgentAbject -- description includes enabled skill names
    await this.registerWithAgentAbject();

    log.info('Registered with AgentAbject');
  }

  protected override getSourceForAsk(): string | undefined {
    return `## SkillAgent Usage Guide

SkillAgent executes tasks using enabled skills. It has access to:
- Shell commands (curl, jq, git, etc.) via ShellExecutor
- HTTP requests via HttpClient
- File system (read/write/glob/grep) via HostFileSystem
- Web search via WebSearch
- URL content fetching via WebFetch

Enable skills in the Skill Browser and configure their API keys.
Tasks are dispatched automatically by AgentAbject based on task type matching.`;
  }

  private setupHandlers(): void {
    // ── TupleSpace dispatch handler ──
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { goalId, description } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string;
      };

      const taskId = `skill-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, {});

      try {
        const systemPrompt = await this.buildSystemPrompt();
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt,
            goalId,
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
        this.pendingTickets.delete(payload.ticketId);
        pending.resolve(payload);
      }
    });

    // ── AgentAbject callback handlers ──
    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      return this.handleAct(taskId, action);
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => { /* handled by AgentAbject */ });
    this.on('agentActionResult', async () => { /* handled by AgentAbject */ });

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

    // Build description from enabled skills so semantic matching is accurate
    let description = 'Executes tasks using installed skills via shell commands, HTTP requests, and file system.';
    const skillNames: string[] = [];

    if (this.skillRegistryId) {
      try {
        const skills = await this.request<Array<{ name: string; description: string }>>(
          request(this.id, this.skillRegistryId, 'getEnabledSkills', {}),
        );
        if (skills.length > 0) {
          skillNames.push(...skills.map(s => s.name));
          description = `Executes tasks using enabled skills: ${skills.map(s => `${s.name} (${s.description.slice(0, 80)})`).join('; ')}. ` +
            'Has access to shell commands, HTTP requests, file system, and web search.';
        } else {
          description = 'Skill execution agent (no skills currently enabled).';
        }
      } catch { /* use default */ }
    }

    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'SkillAgent',
      description,
      taskTypes: ['skill'],
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
    return { observation: lastResult };
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
          result = `HTTP ${httpResult.status}\n${httpResult.body?.slice(0, 5000) ?? ''}`;
          break;
        }

        case 'read_file': {
          if (!this.hostFileSystemId) return { success: false, error: 'HostFileSystem not available' };
          const path = action.path as string;
          if (!path) return { success: false, error: 'read_file action requires "path" field' };

          const fileResult = await this.request<{ content: string; lines: number }>(
            request(this.id, this.hostFileSystemId, 'readFile', { path }),
          );
          result = fileResult.content.slice(0, 5000);
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
            request(this.id, this.webFetchId, 'fetch', { url, maxLength: 5000 }),
          );
          result = fetchResult.content;
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
| done | result | Task complete. Include the answer in result. |
| fail | reason | Task cannot be completed |
| reply | message | Send a progress update to the user |

Every action can include a "reasoning" field explaining your thinking.

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

    this.cachedSystemPrompt = prompt;
    return prompt;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ticket waiting (same pattern as WebAgent)
  // ═══════════════════════════════════════════════════════════════════

  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private waitForTaskResult(ticketId: string, timeout: number): Promise<{ success: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        reject(new Error(`Task ${ticketId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingTickets.set(ticketId, {
        resolve: (payload: unknown) => {
          clearTimeout(timer);
          const p = payload as { success?: boolean; result?: unknown; error?: string; state?: { result?: unknown; error?: string } };
          const success = p.success !== false && !p.error;
          resolve({
            success,
            result: p.result ?? p.state?.result,
            error: p.error ?? p.state?.error,
          });
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }
}

export const SKILL_AGENT_ID = 'abjects:skill-agent' as AbjectId;
