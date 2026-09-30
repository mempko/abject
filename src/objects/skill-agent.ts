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
import type { AgentAction, AgentActionResult } from './agent-abject.js';
import { bulkAwareResult, resultEcho, LARGE_PAYLOAD_CHARS } from './agent-abject.js';
import type { EnabledSkillSummary } from '../core/skill-types.js';
import type { MCPServerSummary, MCPServerDetail } from './mcp-registry-client.js';
import type { ClawHubSkillSummary, SkillBundle } from './clawhub-client.js';
import { buildMcpSkillMd, packageToMcpCommand, sanitiseSkillName } from '../core/skill-synth.js';
import { formatMCPToolList } from '../core/mcp-format.js';
import { choiceOf, noulOf } from '../llm/decision.js';
import type { DecisionQuestion } from '../llm/decision.js';
import { askScopeQuestions } from '../core/decision-questions.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SkillAgent');

const SKILL_AGENT_INTERFACE: InterfaceId = 'abjects:skill-agent';

/**
 * Deadline for requests that can stall behind a user permission dialog.
 * ShellExecutor and HostFileSystem wait up to 120s for the user's decision,
 * so anything shorter here turns "the user is still deciding" into a spurious
 * timeout for the agent.
 */
const PERMISSION_AWARE_TIMEOUT = 180000;

/**
 * Characters of each skill's description carried into this agent's roster
 * line. Long enough for a skill to say what it actually does — a planner
 * choosing between agents has nothing else to go on — while keeping a
 * dozen skills from crowding out the rest of the roster.
 */
const SKILL_SUMMARY_CHARS = 180;

/** Show enough of a secret to confirm which value is set, never the value. */
function maskSecret(value: string): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return '(set)';
  return `(set: ${value.slice(0, 4)}…${value.slice(-2)}, ${value.length} chars)`;
}

/**
 * A skill's line in the team roster. This is the ONLY thing a planner
 * sees when deciding whether this agent covers a request, so it has to
 * survive the cut: an 80-char slice through the middle of a word threw
 * away the half of chief's description that said it queries live state,
 * leaving a fragment about "investigating evidence" that read as a poor
 * match for "get me chief status" — and the goal went elsewhere.
 */
function summarizeSkill(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= SKILL_SUMMARY_CHARS) return clean;
  // Cut on a word boundary and mark it, rather than stopping at the
  // first sentence: a description's later clauses are often the
  // specific ones, and trading them for a tidy full stop is how the
  // clause that would have matched the request goes missing.
  const window = clean.slice(0, SKILL_SUMMARY_CHARS);
  const space = window.lastIndexOf(' ');
  return `${(space > 0 ? window.slice(0, space) : window).replace(/[,;:.]$/, '')}…`;
}

/** A search_catalog hit: an MCP registry server or a ClawHub skill. */
type CatalogHit =
  | { kind: 'mcp'; name: string; description?: string; version?: string }
  | { kind: 'skill'; slug: string; description?: string; version?: string };

/** What the last action ran and what came back, as the result judgment reads it (never env values). */
interface LastCall {
  action: string;
  skill?: string;
  command?: string;
  url?: string;
  server?: string;
  tool?: string;
  exitCode?: number;
  httpStatus?: number;
  ok: boolean;
  head: string;
  tail?: string;
}

interface TaskExtra {
  lastResult?: string;
  /**
   * Goal this task belongs to. Actions must read it from here, not from the
   * shared `_currentGoalId` field: the queue runner starts the next task
   * while the previous executeTask handler is still unwinding, and that
   * handler's cleanup used to wipe the new task's goal context.
   */
  goalId?: string;
  /**
   * Skills this task has loaded, most recent last.
   *
   * The permission layer grants a skill's own programs on the strength of
   * the user having enabled it, and it keys that grant by skill name — so
   * the exec has to say which skill it is running. Sending a constant
   * instead looked up a skill nobody installed and every command fell
   * through to a dialog, however the real skill had been granted.
   */
  loadedSkills?: string[];
  /** The task text, for runtime decisions that judge against it. */
  task?: string;
  /** The last action and its output, for the result judgment (site skill.result). */
  lastCall?: LastCall;
}

export class SkillAgent extends Abject {
  /** Attempts to publish the skill list before giving up until the next
   *  skill change. The only cause of a rejection is the object's own
   *  registration not having landed yet, so a few short retries cover it. */
  private static readonly REGISTRY_PUBLISH_RETRIES = 4;
  private static readonly REGISTRY_PUBLISH_RETRY_MS = 250;

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

  /** The roster description last registered, for the ask-scope judgment. */
  private rosterDescription?: string;

  /** Configured skill env values, kept only to redact them from decision state (rebuilt when skills change). */
  private secretValues?: string[];

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

  protected override askBusyStatus(): string | undefined {
    return this.taskExtras.size > 0
      ? `executing ${this.taskExtras.size} skill task${this.taskExtras.size === 1 ? '' : 's'}`
      : undefined;
  }

  protected override askPrompt(_question: string): string {
    let base = super.askPrompt(_question) + `\n\n## SkillAgent: Installed Skill Execution Agent

I install, enable, disable, and list skills. I execute tasks that match an installed skill's domain at runtime — e.g. "send a Slack message", "list my Linear issues", "create a Gmail draft".`;

    if (this.shellExecutorId) {
      base += `\n\nI have host shell execution enabled via ShellExecutor. I can run CLI commands (git, pytest, gh, npm, terminal scripts) to inspect repositories, run tests, and manage PRs.`;
    }

    const hasShell = Boolean(this.shellExecutorId);
    base += `\n\nCurrently installed skills and their domains:
${this.getInstalledSkillsSummary()}

### My Scope
Skill installation, management, and at-runtime execution of tasks that match an installed skill's domain${hasShell ? ' or host shell execution' : ''}. Authoring or modifying Abject source code is outside my scope; that's a different agent's job. Web browsing of arbitrary public URLs is also outside my scope.

When invited to contribute to a Sprint Plan, describe the specific task I could run using one of my installed skills${hasShell ? ' or host shell execution via ShellExecutor' : ''}. If no installed skill${hasShell ? ' or shell capability' : ''} matches the goal, reply PASS.`;
    return base;
  }

  protected override async handleAsk(question: string): Promise<string> {
    const pass = await this.askScopePass(question);
    if (pass) return pass;
    return this.askLlm(this.askPrompt(question) + await this.askAvailabilityContext(), question, 'fast');
  }

  /**
   * A clearly out-of-scope question answered PASS without the LLM call (site
   * agent.ask-scope, act). The scope read is this agent's own: its manifest
   * (install, manage, execute), the enabled skills in its roster line, and
   * shell execution when that is available.
   */
  private async askScopePass(question: string): Promise<string | undefined> {
    if (await this.decisionSiteMode('agent.ask-scope') === 'off') return undefined;
    const description = [
      this.manifest.description,
      this.rosterDescription ?? '',
      this.shellExecutorId ? 'It also runs host CLI commands (git, test runners, gh, npm, terminal scripts) to inspect repositories, run tests, and manage PRs.' : '',
    ].filter(Boolean).join(' ').slice(0, 4000);
    const outcome = await this.askDecision('agent.ask-scope', {
      agent: { name: this.manifest.name, description },
      question: question.slice(0, 3000),
    }, askScopeQuestions(), { onBehalfOf: this.manifest.name, timeoutMs: 8000 });
    const p = noulOf(outcome, 'in_scope');
    if (!outcome || p === undefined) return undefined;
    const pass = outcome.mode === 'act' && p < 0.1;
    log.info(`[decision:${outcome.mode}] SkillAgent agent.ask-scope: in_scope=${p.toFixed(2)}${pass ? ' → PASS without an LLM call' : ''}`);
    if (!pass) return undefined;
    return `PASS: this asks for work outside installing, managing, and running installed skills (runtime scope check, in_scope p=${p.toFixed(2)}).`;
  }

  protected override async askAvailabilityContext(): Promise<string> {
    let prompt = '';

    if (this.skillRegistryId) {
      // Fetch skills and MCP servers in parallel
      const [allSkills, servers] = await Promise.all([
        this.request<Array<{ name: string; description: string; enabled: boolean; isMcpServer?: boolean; mcpStatus?: string; error?: string; configFile?: string }>>(
          request(this.id, this.skillRegistryId, 'listSkills', {}), 3000,
        ).catch(() => []),
        this.request<Array<{ name: string; tools: Array<{ name: string; description: string }> }>>(
          request(this.id, this.skillRegistryId, 'getEnabledMCPServers', {}), 3000,
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

    return prompt;
  }

  private getInstalledSkillsSummary(): string {
    return this.installedSkillDescriptions;
  }

  private setupHandlers(): void {
    this.on('snapshotTask', msg => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only the task runtime can snapshot this task');
      return structuredClone(this.taskExtras.get((msg.payload as { taskId: string }).taskId));
    });
    this.on('restoreTask', msg => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only AgentAbject may restore task state');
      const { taskId, snapshot } = msg.payload as { taskId: string; snapshot: TaskExtra };
      if (!snapshot) throw new Error('Missing specialist checkpoint');
      this.taskExtras.set(taskId, structuredClone(snapshot));
      return { success: true };
    });

    // ── TupleSpace dispatch handler ──
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { tupleId, taskId: explicitTaskId, goalId, description, approach, failureHistory } = msg.payload as {
        tupleId: string; taskId?: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; approach?: string;
        failureHistory?: Array<{ agent: string; error: string }>;
      };

      // Use the queue-runner-supplied taskId so AgentAbject's TaskEntry,
      // SkillAgent's TaskExtra, and AgentAbject's queue inFlight slot share
      // one ID. Falls back to a fresh `skill-exec-${...}` for legacy callers.
      const taskId = explicitTaskId ?? tupleId ?? `skill-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { goalId, task: description });
      this._currentGoalId = goalId;

      try {
        const [systemPrompt, preselect] = await Promise.all([
          this.buildSystemPrompt(),
          this.preselectSkill(description, { approach, failureHistory }, { goalId, taskId }),
        ]);
        // An authoring task is the Task Scope's immediate fail; judged
        // confidently, it returns before the loop spends a think on it.
        if (preselect.failFast) {
          log.info(`executeTask: ${preselect.failFast}`);
          return { success: false, error: preselect.failFast };
        }

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
        if (preselect.note) SkillAgent.addTaskNote(initialMessages, description, preselect.note);

        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt,
            goalId,
            dispatchTupleId: tupleId,
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
        // Only clear if it's still ours — the queue runner may have started
        // the next task (which set its own goal) while we were unwinding
        if (this._currentGoalId === goalId) this._currentGoalId = undefined;
      }
    });

    // ── Direct runTask handler ──
    this.on('runTask', async (msg: AbjectMessage) => {
      const { task } = msg.payload as { task: string };
      const taskId = `skill-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { task });

      try {
        const [systemPrompt, preselect] = await Promise.all([
          this.buildSystemPrompt(),
          this.preselectSkill(task, {}, { taskId }),
        ]);
        if (preselect.failFast) {
          log.info(`runTask: ${preselect.failFast}`);
          return { success: false, result: preselect.failFast };
        }
        const initialMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (preselect.note) SkillAgent.addTaskNote(initialMessages, task, preselect.note);
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task,
            systemPrompt,
            initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
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
    this.onDelivery('taskResult', async (msg: AbjectMessage) => {
      if(msg.routing.from!==this.agentAbjectId)throw new Error('Task result must come from AgentAbject');
      this.retainTaskResult(msg.payload);
      const payload = msg.payload as { ticketId: string };
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        pending.resolve(payload);
      }
    });

    // Forward progress to GoalManager so Chat's timeout resets during long operations.
    this.on('progress', (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      // Progress arrives untagged, so it cannot be attributed to one task by
      // inspection. With several running, every live goal is genuinely being
      // worked on and each needs its timer reset, so all of them hear about it
      // — but the message itself belongs to whichever task emitted it, so it
      // is only quoted when there is no ambiguity about whose it is.
      if (this.goalManagerId) {
        const payload = msg.payload as { taskId?: string; phase?: string; message?: string } | undefined;
        const goals = new Set<string>();
        const task = payload?.taskId ? this.taskExtras.get(payload.taskId) : undefined;
        if (task?.goalId) goals.add(task.goalId);

        const attributable = goals.size === 1;
        for (const goalId of goals) {
          this.send(event(this.id, this.goalManagerId, 'updateProgress', {
            goalId,
            message: attributable ? (payload?.message ?? 'working...') : 'working...',
            phase: payload?.phase ?? 'acting',
            agentName: 'SkillAgent',
          }));
        }
      }
    });

    // ── AgentAbject callback handlers ──
    // Each callback proves the agent is still working, so reset the inactivity timeout.
    this.on('agentObserve', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      const { taskId } = msg.payload as { taskId: string; step: number };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      // Heartbeat: long sub-calls (e.g. MCP tool that takes minutes) shouldn't
      // let the parent's inactivity timer fire while we're genuinely working.
      const heartbeat = this.setRecurringTimer(() => this.resetPendingTicketTimeouts((msg.payload as { taskId?: string }).taskId), 60000);
      try {
        return await this.handleAct(taskId, action);
      } finally {
        this.cancelTimer(heartbeat);
      }
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async (msg: AbjectMessage) => { this.resetPendingTicketTimeouts((msg.payload as { taskId?: string }).taskId); });
    this.on('agentActionResult', async (msg: AbjectMessage) => { this.resetPendingTicketTimeouts((msg.payload as { taskId?: string }).taskId); });

    // ── SkillRegistry change handler ──
    this.on('changed', async (msg: AbjectMessage) => {
      if (msg.routing.from === this.skillRegistryId) {
        this.cachedSystemPrompt = undefined;
        this.secretValues = undefined;
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
    // Always append the authoring-exclusion so dispatch never mistakes "wrap
    // a skill in a new object" for a skill-execution task.
    const AUTHORING_EXCLUSION = 'Best for exercising an installed skill or MCP tool to complete the task. Object authoring (widgets, apps, agents, bridges, proxies, relays, skill wrappers) belongs with a creation agent, including when the new object would wrap a skill or MCP server handled here.';
    let description = `Executes tasks only when they match an installed skill. ${AUTHORING_EXCLUSION}`;
    const skillNames: string[] = [];

    if (this.skillRegistryId) {
      try {
        const skills = await this.request<Array<{ name: string; description: string }>>(
          request(this.id, this.skillRegistryId, 'getEnabledSkills', {}),
        );
        if (skills.length > 0) {
          skillNames.push(...skills.map(s => s.name));
          description = `Executes tasks for these installed skills only: ${skills.map(s => `${s.name} (${summarizeSkill(s.description)})`).join('; ')}. ${AUTHORING_EXCLUSION}`;
          this.installedSkillDescriptions = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
        } else {
          description = `Skill execution agent (no skills currently enabled). ${AUTHORING_EXCLUSION}`;
          this.installedSkillDescriptions = '(none currently enabled)';
        }
      } catch { /* use default */ }
    }

    this.rosterDescription = description;
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'SkillAgent',
      description,
      config: {
        snapshotMethod: 'snapshotTask', restoreMethod: 'restoreTask',
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        queueName: `skill-agent-${this.id}`,
      },
    }));

    await this.publishDescriptionToRegistry(description, skillNames);
  }

  /**
   * Publish the live skill list to the Registry as well as the agent roster.
   *
   * These are two different catalogs read by two different kinds of caller.
   * The roster reaches planners through their `team` block; the Registry's
   * catalog is what `Registry.ask` reasons over and what every non-planner —
   * a chat turn, a sandboxed job, any object doing discovery — can see. With
   * the manifest left at its static text, a skill installed at runtime exists
   * in one catalog and not the other, so "who handles <skill>?" asked through
   * the Registry has nothing to find and comes back as "no such object".
   *
   * Best-effort: discovery degrades to the static description, which is how
   * it behaved before, so a Registry that is slow or absent never blocks
   * registration.
   */
  private async publishDescriptionToRegistry(description: string, skillNames: string[], attempt = 0): Promise<void> {
    try {
      const registryId = await this.resolveRegistryId();
      if (!registryId) return;
      const accepted = await this.request<boolean>(request(this.id, registryId, 'updateManifest', {
        objectId: this.id,
        manifest: {
          ...this.manifest,
          description,
          // Skill names as tags too: `search` ranks a tag hit above a
          // description hit, so an exact-name query for an installed skill
          // finds this agent without depending on prose matching.
          tags: [...new Set([...(this.manifest.tags ?? []), ...skillNames.map(n => n.toLowerCase())])],
        },
      }));
      // `false` means the Registry has no entry for this object yet. The
      // first publish runs from onInit, which finishes BEFORE the factory
      // registers the object, so the opening attempt normally lands here and
      // the catalog would keep the static description until some skill
      // happened to change. Retry briefly rather than wait for that.
      if (!accepted && attempt < SkillAgent.REGISTRY_PUBLISH_RETRIES) {
        this.setTimer(() => { void this.publishDescriptionToRegistry(description, skillNames, attempt + 1); },
          SkillAgent.REGISTRY_PUBLISH_RETRY_MS * (attempt + 1));
      }
    } catch (err) {
      log.warn(`Could not publish skill list to the Registry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Observe / Act
  // ═══════════════════════════════════════════════════════════════════

  private async handleObserve(taskId: string): Promise<{ observation: string; tier?: string }> {
    const extra = this.taskExtras.get(taskId);
    const lastResult = extra?.lastResult ?? 'No previous action result.';
    // Invoking skills/MCP tools and reading their results is mechanical work
    // balanced does well and fast; escalate to smart only when the last
    // action errored, where recovery reasoning is worth the cost. A decision
    // model may read what the result means instead (site skill.result): an
    // expected non-zero exit stays on balanced, a rejected credential gets
    // smart and a hint. It runs beside the live skill-state lookups.
    const heuristicTier = extra?.lastResult?.startsWith('Error:') ? 'smart' : 'balanced';
    const [skillState, judged] = await Promise.all([
      this.liveSkillState(),
      this.judgeLastResult(taskId, extra, heuristicTier),
    ]);
    const hint = judged.hint ? `\n\n${judged.hint}` : '';
    return { observation: lastResult + hint + skillState, tier: judged.tier };
  }

  /** Installed skills and connected MCP servers as they stand now, for the observation. */
  private async liveSkillState(): Promise<string> {
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
          // Name the tools, not just count them. A server that connects
          // mid-task is absent from the system prompt built at task start, so
          // this is the only place the agent learns what it can call without
          // reaching for a shell. `list_mcp_tools` gives the full schemas.
          skillState += '\n\nConnected MCP servers (call these with mcp_tool_call):\n' + servers.map(s => {
            if (s.tools.length === 0) return `- ${s.name}: 0 tools (server connected but exposes nothing)`;
            const names = s.tools.map(t => t.name);
            const shown = names.slice(0, 25).join(', ');
            const more = names.length > 25 ? `, +${names.length - 25} more (list_mcp_tools for all)` : '';
            return `- ${s.name} (${names.length} tools): ${shown}${more}`;
          }).join('\n');
        }
      } catch { /* best effort */ }
    }

    return skillState;
  }

  /**
   * Which loaded skill a shell command is running on behalf of.
   *
   * A task may have loaded several. Prefer the one the command actually
   * invokes — its name appearing as a bare word is the strong signal, since
   * a CLI-backed skill is named after its command — and otherwise the most
   * recently loaded, which is the one whose instructions were just read.
   * Undefined when nothing has been loaded: the exec then carries no skill
   * claim at all rather than a false one, and the user is asked as before.
   */
  private static skillForCommand(command: string, loaded: string[] | undefined): string | undefined {
    if (!loaded?.length) return undefined;
    const named = loaded.find(name =>
      new RegExp(String.raw`(^|[\s;|&(])${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}([\s;|&)]|$)`).test(command));
    return named ?? loaded[loaded.length - 1];
  }

  private async handleAct(taskId: string, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const extra = this.taskExtras.get(taskId) ?? {};
    this.taskExtras.set(taskId, extra);
    // Per-task goal context; the shared field is only a legacy fallback
    const goalId = extra.goalId;
    // What ran and what came back, kept for the next observation's result
    // judgment (site skill.result). Env values never enter it.
    const call = SkillAgent.callOf(action);
    const record = (text: string, ok: boolean): void => { extra.lastCall = { ...call, ok, ...SkillAgent.headTail(text) }; };
    // A failure is what the next observation must show; leaving lastResult
    // alone would echo the previous success and keep the tier on balanced.
    const fail = (error: string): { success: false; error: string } => {
      extra.lastResult = `Error: ${error}`;
      record(error, false);
      return { success: false, error };
    };
    // A command or request that ran but failed (non-zero exit, HTTP error)
    // reports as a failure with its output intact: small output reads inline
    // as the error, large output rides the payload channel behind a handle.
    const failedOutput = (summary: string, text: string): AgentActionResult => {
      extra.lastResult = `Error: ${resultEcho(text)}`;
      record(text, false);
      if (text.length <= LARGE_PAYLOAD_CHARS) return fail(text);
      return { ...bulkAwareResult(text), success: false, error: `${summary} (full output held below; read it with read_chunk)` };
    };

    try {
      let result: string;

      switch (action.action) {
        case 'shell': {
          const command = action.command as string;
          if (!command) return fail('shell action requires "command" field');
          if (!this.shellExecutorId) return fail('ShellExecutor not available');

          // ShellExecutor may pause to ask the user for permission, and it
          // gives them two minutes to answer. The request deadline has to
          // outlast that dialog: a shorter one reports a bogus timeout while
          // the user is still reading the prompt, and the agent responds by
          // retrying a variant command, which raises yet another dialog.
          const execResult = await this.request<{ stdout: string; stderr: string; exitCode: number }>(
            request(this.id, this.shellExecutorId, 'exec', {
              command,
              args: action.args as string[] | undefined,
              shell: true,
              timeout: 30000,
              skillName: SkillAgent.skillForCommand(command, extra.loadedSkills),
            }),
            PERMISSION_AWARE_TIMEOUT,
          );
          call.exitCode = execResult.exitCode;
          if (execResult.exitCode !== 0) {
            return failedOutput(`Exit code ${execResult.exitCode}`,
              `Exit code ${execResult.exitCode}\nstdout: ${execResult.stdout}\nstderr: ${execResult.stderr}`);
          }
          result = execResult.stdout || '(no output)';
          break;
        }

        case 'http': {
          if (!this.httpClientId) return fail('HttpClient not available');
          const method = (action.method as string || 'GET').toUpperCase();
          const url = action.url as string;
          if (!url) return fail('http action requires "url" field');

          const httpResult = await this.request<{ status: number; body: string; ok: boolean }>(
            request(this.id, this.httpClientId, 'request', {
              method, url,
              headers: action.headers as Record<string, string> | undefined,
              body: action.body as string | undefined,
            }),
          );
          call.httpStatus = httpResult.status;
          result = `HTTP ${httpResult.status}\n${httpResult.body ?? ''}`;
          if (!httpResult.ok) return failedOutput(`HTTP ${httpResult.status}`, result);
          break;
        }

        case 'read_file': {
          if (!this.hostFileSystemId) return fail('HostFileSystem not available');
          const path = action.path as string;
          if (!path) return fail('read_file action requires "path" field');

          const fileResult = await this.request<{ content: string; lines: number }>(
            request(this.id, this.hostFileSystemId, 'readFile', { path }),
            PERMISSION_AWARE_TIMEOUT,
          );
          result = fileResult.content;
          break;
        }

        case 'write_file': {
          if (!this.hostFileSystemId) return fail('HostFileSystem not available');
          const path = action.path as string;
          const content = action.content as string;
          if (!path || content === undefined) return fail('write_file requires "path" and "content"');

          await this.request(
            request(this.id, this.hostFileSystemId, 'writeFile', { path, content }),
            PERMISSION_AWARE_TIMEOUT,
          );
          result = `Wrote ${content.length} chars to ${path}`;
          break;
        }

        case 'search': {
          if (!this.webSearchId) return fail('WebSearch not available');
          const query = action.query as string;
          if (!query) return fail('search action requires "query" field');

          const searchResult = await this.request<{ results: Array<{ title: string; url: string; snippet: string }> }>(
            request(this.id, this.webSearchId, 'search', { query, maxResults: 5 }),
          );
          result = searchResult.results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
          break;
        }

        case 'fetch': {
          if (!this.webFetchId) return fail('WebFetch not available');
          const url = action.url as string;
          if (!url) return fail('fetch action requires "url" field');

          const fetchResult = await this.request<{ content: string; title: string }>(
            request(this.id, this.webFetchId, 'fetch', { url, maxLength: 30000 }),
          );
          result = fetchResult.content;
          break;
        }

        case 'install_skill': {
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const name = action.name as string;
          const content = action.content as string;
          if (!name || !content) return fail('install_skill requires "name" and "content" fields');

          await this.request(
            request(this.id, this.skillRegistryId, 'installSkill', { name, content }),
          );
          result = `Installed skill "${name}"`;
          break;
        }

        case 'search_catalog': {
          const query = (action.query as string)?.trim() ?? '';
          const limit = typeof action.limit === 'number' && action.limit > 0 ? action.limit : 10;
          if (!query) return fail('search_catalog requires "query" field');
          const hits = await this.searchCatalog(query, limit);
          if (hits.length === 0) {
            result = `No matches for "${query}" in the MCP registry or ClawHub.`;
          } else {
            const lines = hits.map(h => h.kind === 'mcp'
              ? `- [mcp] ${h.name}${h.version ? ' (' + h.version + ')' : ''}: ${h.description ?? ''}`
              : `- [skill] ${h.slug}${h.version ? ' (' + h.version + ')' : ''}: ${h.description ?? ''}`,
            );
            result = `Found ${hits.length} candidates:\n${lines.join('\n')}`;
            const ranking = await this.rankCatalogHits(taskId, query, hits);
            if (ranking) result += `\n\n${ranking}`;
          }
          break;
        }

        case 'install_mcp_server': {
          if (!this.mcpRegistryClientId) return fail('MCPRegistryClient not available');
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const name = action.name as string;
          if (!name) return fail('install_mcp_server requires "name" field');
          result = await this.installMcpServer(name);
          break;
        }

        case 'install_clawhub_skill': {
          if (!this.clawHubClientId) return fail('ClawHubClient not available');
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const slug = action.slug as string;
          if (!slug) return fail('install_clawhub_skill requires "slug" field');
          result = await this.installClawHubSkill(slug);
          break;
        }

        case 'enable_skill': {
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const name = action.name as string;
          if (!name) return fail('enable_skill requires "name" field');

          const enabled = await this.request<{
            success: boolean; warning?: string; mcpStatus?: string; toolCount?: number;
            error?: string; missingEnv?: string[]; hint?: string;
          }>(
            request(this.id, this.skillRegistryId, 'enableSkill', { name }),
            60000,
          );

          // An MCP server that died on startup is a failed enable, not a
          // successful one with a footnote. Fail the action so the next think
          // sees the subprocess's own error instead of "Enabled skill X".
          if (enabled.mcpStatus === 'error') {
            const parts = [
              `Enabled skill "${name}" but its MCP server failed to start.`,
              enabled.error ? `Error: ${enabled.error}` : '',
              enabled.missingEnv?.length ? `Missing env: ${enabled.missingEnv.join(', ')}` : '',
              enabled.hint ?? '',
            ].filter(Boolean);
            return fail(parts.join('\n'));
          }

          result = enabled.mcpStatus
            ? `Enabled skill "${name}" — MCP bridge running with ${enabled.toolCount ?? 0} tools. Call them with mcp_tool_call.`
            : `Enabled skill "${name}"`;
          if (enabled.warning) result += `\nWarning: ${enabled.warning}`;
          break;
        }

        case 'set_skill_config': {
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const name = action.name as string;
          const env = action.env as Record<string, string> | undefined;
          if (!name || !env || typeof env !== 'object') {
            return fail('set_skill_config requires "name" and an "env" object');
          }

          const saved = await this.request<{
            success: boolean; keys?: string[]; restarted?: boolean;
            mcpStatus?: string; toolCount?: number; error?: string;
          }>(
            request(this.id, this.skillRegistryId, 'setSkillConfig', {
              name, env, merge: action.merge !== false,
            }),
            60000,
          );
          // New values must be redacted from decision state from now on.
          this.secretValues = undefined;

          // Never echo the values back: this string lands in the agent's
          // observation and from there in the LLM context and the log.
          const summary = Object.entries(env)
            .map(([k, v]) => `${k}: ${maskSecret(String(v ?? ''))}`)
            .join(', ');
          if (saved.restarted && saved.mcpStatus === 'error') {
            return fail(`Saved config for "${name}" (${summary}) but the MCP server still fails to start.\n${saved.error ?? ''}`);
          }
          result = `Saved config for "${name}" — ${summary}.`
            + (saved.restarted ? ` MCP bridge restarted: ${saved.toolCount ?? 0} tools available.` : '');
          break;
        }

        case 'get_skill_config': {
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const name = action.name as string;
          if (!name) return fail('get_skill_config requires "name" field');

          const config = await this.request<{ env?: Record<string, string> }>(
            request(this.id, this.skillRegistryId, 'getSkillConfig', { name }),
          );
          const entries = Object.entries(config?.env ?? {});
          result = entries.length > 0
            ? entries.map(([k, v]) => `${k}: ${maskSecret(String(v ?? ''))}`).join('\n')
            : `No configuration set for "${name}".`;
          break;
        }

        case 'disable_skill': {
          if (!this.skillRegistryId) return fail('SkillRegistry not available');
          const name = action.name as string;
          if (!name) return fail('disable_skill requires "name" field');

          await this.request(
            request(this.id, this.skillRegistryId, 'disableSkill', { name }),
          );
          result = `Disabled skill "${name}"`;
          break;
        }

        case 'load_skill': {
          if (!this.skillRegistryId) return fail('SkillRegistry unavailable');
          const enabled = await this.request<EnabledSkillSummary[]>(request(this.id, this.skillRegistryId, 'getEnabledSkills', {}));
          const skill = enabled.find(s => s.name === action.name);
          if (!skill) return fail('Skill is not enabled; Ask SkillRegistry about availability');
          // Remember it: a later shell command in this task runs on behalf of
          // this skill, and the permission layer needs its name to find the
          // grant the user made by enabling it.
          const loaded = (extra.loadedSkills ??= []);
          const already = loaded.indexOf(skill.name);
          if (already >= 0) loaded.splice(already, 1);
          loaded.push(skill.name);
          result = `Skill ${skill.name}: ${skill.description}\n${skill.instructions ?? '(no instructions)'}`;
          break;
        }

        case 'list_skills': {
          if (!this.skillRegistryId) return fail('SkillRegistry not available');

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
          if (!server || !tool) return fail('mcp_tool_call requires "server" and "tool" fields');

          const resolved = await this.resolveBridge(server);
          if (!resolved.bridgeId) return fail(resolved.error ?? `MCP server "${server}" is not available`);

          const toolResult = await this.request<{ content: string; isError: boolean }>(
            request(this.id, resolved.bridgeId, 'callTool', { toolName: tool, input }),
            120000,
          );

          if (toolResult.isError) {
            return fail(`MCP tool error: ${toolResult.content}`);
          } else {
            result = toolResult.content;
          }
          break;
        }

        case 'list_mcp_tools': {
          const server = action.server as string;
          if (!server) return fail('list_mcp_tools requires "server" field');

          const resolved = await this.resolveBridge(server);
          if (!resolved.bridgeId) return fail(resolved.error ?? `MCP server "${server}" is not available`);

          const tools = await this.request<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>(
            request(this.id, resolved.bridgeId, 'listTools', {}),
          );
          result = tools.length > 0
            ? `${server} exposes ${tools.length} tool(s):\n${formatMCPToolList(tools)}`
            : `${server} is connected but exposes no tools.`;
          break;
        }

        case 'write_scratchpad': {
          if (!goalId) return fail('write_scratchpad requires an active goal context');
          if (!this.goalManagerId) return fail('GoalManager not available');
          const key = action.key as string;
          if (!key) return fail('write_scratchpad requires "key"');
          await this.request(
            request(this.id, this.goalManagerId, 'writeGoalData', {
              goalId, key, value: action.value,
            }),
          );
          result = `Wrote scratchpad key "${key}"`;
          break;
        }

        case 'read_scratchpad': {
          if (!goalId) return fail('read_scratchpad requires an active goal context');
          if (!this.goalManagerId) return fail('GoalManager not available');
          const key = action.key as string | undefined;
          const value = await this.request(
            request(this.id, this.goalManagerId, 'readGoalData', {
              goalId, ...(key ? { key } : {}),
            }),
          );
          result = typeof value === 'string' ? value : JSON.stringify(value);
          break;
        }

        default:
          return fail(`Unknown action: ${action.action}`);
      }

      // Bulk (an MCP tool's rows, a fetched body, a file) goes back through
      // the payload channel, and the observation points at it rather than
      // quoting it back — this agent echoes its last result as the next
      // observation, so a large one used to be paid for twice.
      extra.lastResult = resultEcho(result);
      record(result, true);
      return bulkAwareResult(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Resolve a server name to its running MCPBridge, with an explanation
   * instead of a shrug when there isn't one. SkillRegistry's diagnostic
   * lookup distinguishes "never installed" from "disabled" from "enabled but
   * the subprocess died", and carries the server's own stderr, so a failed
   * tool call points at the actual fix rather than inviting the agent to go
   * looking for a shell workaround.
   */
  private async resolveBridge(server: string): Promise<{ bridgeId?: AbjectId; error?: string }> {
    if (this.skillRegistryId) {
      try {
        const info = await this.request<{
          found: boolean; status: string; bridgeId?: string;
          error?: string; stderrTail?: string; hint?: string;
        }>(
          request(this.id, this.skillRegistryId, 'getMCPBridgeInfo', { serverName: server }),
        );
        if (info.found && info.bridgeId) return { bridgeId: info.bridgeId as AbjectId };
        const parts = [
          `MCP server "${server}" is not usable (status: ${info.status}).`,
          info.error ? `Error: ${info.error}` : '',
          info.hint ?? '',
        ].filter(Boolean);
        return { error: parts.join('\n') };
      } catch { /* fall through to direct discovery */ }
    }

    const bridgeId = await this.discoverDep(`MCPBridge-${server}`);
    if (bridgeId) return { bridgeId };
    return { error: `MCP server "${server}" not running. Is it installed and enabled?` };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Runtime decisions (skill choice, result meaning, catalog ranking)
  // ═══════════════════════════════════════════════════════════════════
  //
  // A decision model answers typed questions at three points, each its own
  // site with its own policy (src/core/decision-sites.ts): which installed
  // skill a task needs, what the last result means, and which catalog entry
  // matches a request. Advise adds a line the agent reads, act takes effect,
  // and each verdict is logged once. A null answer (site off, no decision
  // model, timeout) leaves today's path. Skill env values never enter a
  // decision state.

  /** Preselect choices that are not skill names. */
  private static readonly PRESELECT_OPTIONS: Record<string, string> = {
    skill_management: 'The task installs, enables, disables, configures, lists, or searches for skills or MCP servers, rather than using one.',
    authoring_out_of_scope: 'The task asks to create, build, design, wrap, or modify an object, widget, app, agent, bridge, proxy, or integration: authoring work, even when the result would wrap a skill.',
    none: 'No installed skill covers the task; it needs general shell, HTTP, file, or web work.',
  };

  /** Characters of preloaded skill instructions; load_skill returns the whole text. */
  private static readonly PRELOAD_CHARS = 12000;

  private static readonly RESULT_QUESTIONS: Record<string, DecisionQuestion> = {
    last_result: {
      type: 'choice',
      instructions: 'A skill-execution agent ran `action` and got the output in `head` (and `tail` when long); `ok` is whether the runtime reported success. What does the result mean for its next step?',
      criteria: {
        success: 'It worked and returned what was asked for.',
        expected_nonzero: 'A non-zero exit or empty result that is itself a normal answer, such as a search with no matches or a check that reports a difference.',
        auth_or_credential: 'A credential is missing, expired, or rejected: unauthorized, forbidden, an invalid token, or a sign-in required.',
        not_found: 'The command, file, tool, resource, or endpoint does not exist.',
        server_or_network: 'A server error, timeout, outage, rate limit, or network failure.',
        usage_error: 'Wrong arguments, flags, parameters, or input shape for the command or tool.',
        other_failure: 'Some other failure.',
      },
    },
  };

  /** Result kinds whose next step needs recovery reasoning (the smart tier). */
  private static readonly SMART_RESULTS = new Set(['auth_or_credential', 'usage_error', 'other_failure']);

  /** Credential-shaped text in a command or output, masked before a decision state leaves the process. */
  private static readonly SECRET_PATTERNS: RegExp[] = [
    /(\bauthorization["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+)?)[^\s"'&,}]+/gi,
    /(\b[\w-]*(?:api[_-]?key|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
    /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|glpat|xox[abpr])[-_][A-Za-z0-9_-]{12,}/g,
  ];

  /** The identifying fields of an action (what ran), without its payloads or env. */
  private static callOf(action: AgentAction): Omit<LastCall, 'ok' | 'head' | 'tail'> {
    const text = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
    const kind = String(action.action);
    const call: Omit<LastCall, 'ok' | 'head' | 'tail'> = { action: kind };
    const skill = text(action.name, 120);
    if (skill) call.skill = skill;
    if (kind === 'shell') { const command = text(action.command, 400); if (command) call.command = command; }
    if (kind === 'http' || kind === 'fetch') { const url = text(action.url, 300); if (url) call.url = url; }
    if (kind === 'mcp_tool_call' || kind === 'list_mcp_tools') {
      const server = text(action.server, 120), tool = text(action.tool, 120);
      if (server) call.server = server;
      if (tool) call.tool = tool;
    }
    return call;
  }

  /** The first 1500 and last 1000 characters of an output (no overlap). */
  private static headTail(text: string): { head: string; tail?: string } {
    return text.length <= 1500 ? { head: text } : { head: text.slice(0, 1500), tail: text.slice(Math.max(1500, text.length - 1000)) };
  }

  /** Add a runtime note to the opening user message, creating one that states the task when there is none. */
  private static addTaskNote(messages: Array<{ role: 'user' | 'assistant'; content: string }>, task: string, note: string): void {
    if (messages[0]?.role === 'user') messages[0].content += `\n\n${note}`;
    else messages.unshift({ role: 'user', content: `Task: ${task}\n\n${note}` });
  }

  /**
   * Which installed skill covers a task (site skill.preselect), asked before
   * the loop starts. Advise, and act below its thresholds, add a hint to load
   * that skill first. Act at ≥ 0.85 preloads the skill's instructions, and
   * the agent still sends load_skill before the skill's commands: only a real
   * load registers the skill for the permission grants its commands run
   * under. Act at ≥ 0.9 on an authoring task returns the scope failure at once.
   */
  private async preselectSkill(
    task: string,
    context: { approach?: string; failureHistory?: Array<{ agent: string; error: string }> },
    scope: { goalId?: string; taskId: string },
  ): Promise<{ note?: string; failFast?: string }> {
    if (!this.skillRegistryId) return {};
    if (await this.decisionSiteMode('skill.preselect') === 'off') return {};
    const [skills, servers] = await Promise.all([
      this.request<EnabledSkillSummary[]>(request(this.id, this.skillRegistryId, 'getEnabledSkills', {}), 5000)
        .catch(() => [] as EnabledSkillSummary[]),
      this.request<Array<{ name: string; tools: Array<{ name: string }> }>>(request(this.id, this.skillRegistryId, 'getEnabledMCPServers', {}), 5000)
        .catch(() => [] as Array<{ name: string; tools: Array<{ name: string }> }>),
    ]);
    const candidates = skills.filter(s => !Object.hasOwn(SkillAgent.PRESELECT_OPTIONS, s.name)).slice(0, 250);
    const criteria: Record<string, string> = {};
    for (const s of candidates) {
      criteria[s.name] = `The installed skill "${s.name}": ${s.description.replace(/\s+/g, ' ').trim()}`.slice(0, 255);
    }
    Object.assign(criteria, SkillAgent.PRESELECT_OPTIONS);
    const outcome = await this.askDecision('skill.preselect', {
      task: task.slice(0, 2000),
      approach: context.approach ? context.approach.slice(0, 600) : null,
      failureHistory: (context.failureHistory ?? []).slice(-3).map(f => ({ agent: f.agent, error: f.error.slice(0, 300) })),
      skills: candidates.map(s => ({ name: s.name, desc: summarizeSkill(s.description) })),
      servers: servers.map(s => ({ name: s.name, tools: s.tools.slice(0, 25).map(t => t.name) })),
    }, {
      skill: {
        type: 'choice',
        instructions: 'Which installed skill covers `task`? A skill covers it when the task names the skill or asks for something its description does. `approach` is the planned route and `failureHistory` lists earlier failed attempts, when present.',
        criteria,
      },
    }, { ...scope, onBehalfOf: this.manifest.name, timeoutMs: 20000 });
    const pick = choiceOf(outcome, 'skill');
    if (!outcome || !pick) return {};
    const p = pick.probabilities[pick.choice] ?? 0;
    const skill = candidates.find(s => s.name === pick.choice);
    log.info(`[decision:${outcome.mode}] SkillAgent skill.preselect: ${pick.choice}@${p.toFixed(2)}`);
    if (outcome.mode === 'act') {
      if (pick.choice === 'authoring_out_of_scope' && p >= 0.9) {
        return { failFast: `This task is object authoring (creating or modifying an object, app, agent, bridge, or integration), which belongs with a creation agent; handing it back for routing (runtime scope check, p=${p.toFixed(2)}).` };
      }
      if (skill && p >= 0.85) {
        const instructions = skill.instructions ?? '(no instructions)';
        const shown = instructions.length > SkillAgent.PRELOAD_CHARS
          ? `${instructions.slice(0, SkillAgent.PRELOAD_CHARS)}\n… [${instructions.length - SkillAgent.PRELOAD_CHARS} more chars; load_skill returns the whole text]`
          : instructions;
        return {
          note: `[Runtime skill check] The installed skill "${skill.name}" likely covers this task (p=${p.toFixed(2)}), so its instructions are loaded below. Before its first command, send load_skill for it (it can share a response with that command): the load registers the skill for this task's permission grants.\n\nSkill ${skill.name}: ${skill.description}\n${shown}`,
        };
      }
    }
    if (skill && p >= 0.6) {
      return { note: `[Runtime skill check] Likely skill: ${skill.name} (p=${p.toFixed(2)}); load_skill it first.` };
    }
    if (pick.choice === 'authoring_out_of_scope' && p >= 0.8) {
      return { note: `[Runtime skill check] This task reads as object authoring (p=${p.toFixed(2)}). Per Task Scope, respond with fail and a short reason so routing reaches a creation agent.` };
    }
    return {};
  }

  /**
   * What the last result means (site skill.result): the think tier follows
   * the judged kind at act, and a likely credential problem adds a hint at
   * advise or act. Configured env values and credential-shaped text are
   * masked in the state.
   */
  private async judgeLastResult(taskId: string, extra: TaskExtra | undefined, heuristic: string): Promise<{ tier: string; hint?: string }> {
    const call = extra?.lastCall;
    if (!call) return { tier: heuristic };
    if (await this.decisionSiteMode('skill.result') === 'off') return { tier: heuristic };
    const redact = await this.secretRedactor();
    const { head, tail, command, url, ...rest } = call;
    const outcome = await this.askDecision('skill.result', {
      ...rest,
      ...(command ? { command: redact(command) } : {}),
      ...(url ? { url: redact(url) } : {}),
      head: redact(head),
      ...(tail ? { tail: redact(tail) } : {}),
    }, SkillAgent.RESULT_QUESTIONS, { goalId: extra?.goalId, taskId, onBehalfOf: this.manifest.name, timeoutMs: 5000 });
    const kind = choiceOf(outcome, 'last_result');
    if (!outcome || !kind) return { tier: heuristic };
    const p = kind.probabilities[kind.choice] ?? 0;
    const retier = outcome.mode === 'act' && p >= 0.6;
    const tier = retier ? (SkillAgent.SMART_RESULTS.has(kind.choice) ? 'smart' : 'balanced') : heuristic;
    const authP = kind.probabilities.auth_or_credential ?? 0;
    const hint = authP >= 0.7
      ? `Runtime result check: the last result looks like a missing or rejected credential (p=${authP.toFixed(2)}); set_skill_config, or ask the user for the missing credential.`
      : undefined;
    log.info(`[decision:${outcome.mode}] SkillAgent skill.result: ${kind.choice}@${p.toFixed(2)} → ${tier}${hint ? ' + credential hint' : ''}`);
    return { tier, hint };
  }

  /**
   * A function that masks configured skill env values and credential-shaped
   * text. The values are read once and dropped whenever skills or their
   * config change.
   */
  private async secretRedactor(): Promise<(text: string) => string> {
    if (!this.secretValues && this.skillRegistryId) {
      const skills = await this.request<EnabledSkillSummary[]>(
        request(this.id, this.skillRegistryId, 'getEnabledSkills', {}), 3000,
      ).catch(() => undefined);
      if (skills) {
        const values = skills.flatMap(s => Object.values(s.env ?? {})).filter(v => typeof v === 'string' && v.length >= 6);
        this.secretValues = [...new Set(values)].sort((a, b) => b.length - a.length);
      }
    }
    const secrets = this.secretValues ?? [];
    return (text: string): string => {
      let out = text;
      for (const secret of secrets) out = out.split(secret).join('[redacted]');
      for (const pattern of SkillAgent.SECRET_PATTERNS) {
        out = out.replace(pattern, (_m, prefix: unknown) => (typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'));
      }
      return out;
    };
  }

  /**
   * Rank search_catalog hits against the request (site skill.catalog, advise
   * at most): the top three with probabilities ride along in the result
   * text. Installing stays the agent's call, since an MCP server runs
   * someone else's code.
   */
  private async rankCatalogHits(taskId: string, query: string, hits: CatalogHit[]): Promise<string | undefined> {
    if (await this.decisionSiteMode('skill.catalog') === 'off') return undefined;
    const shown = hits.slice(0, 20);
    const labels: Record<string, string> = { none_match: 'none of these' };
    const criteria: Record<string, string> = {};
    shown.forEach((h, i) => {
      const label = h.kind === 'mcp' ? `[mcp] ${h.name}` : `[skill] ${h.slug}`;
      labels[`entry_${i}`] = label;
      criteria[`entry_${i}`] = `${label}: ${(h.description ?? '').replace(/\s+/g, ' ').trim()}`.slice(0, 255);
    });
    criteria.none_match = 'None of these entries provides what the request asks for.';
    const extra = this.taskExtras.get(taskId);
    const outcome = await this.askDecision('skill.catalog', {
      request: (extra?.task ?? query).slice(0, 1500),
      query,
    }, {
      catalog_match: {
        type: 'choice',
        instructions: 'Which catalog entry best provides what `request` asks for? `query` is the search that found these entries.',
        criteria,
      },
    }, { goalId: extra?.goalId, taskId, onBehalfOf: this.manifest.name, timeoutMs: 20000 });
    const match = choiceOf(outcome, 'catalog_match');
    if (!outcome || !match) return undefined;
    const ranked = Object.entries(match.probabilities)
      .filter(([key]) => labels[key])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, prob], i) => `${i + 1}. ${labels[key]} (p=${prob.toFixed(2)})`);
    if (ranked.length === 0) return undefined;
    log.info(`[decision:${outcome.mode}] SkillAgent skill.catalog "${query.slice(0, 60)}": ${ranked.join('; ')}`);
    return `Runtime match check, most likely first: ${ranked.join('; ')}.`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════════════════════

  private async buildSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;

    let prompt = `You are a skill execution agent. You complete tasks by exercising installed skills: calling MCP server tools, making HTTP requests, reading/writing configuration and data files, running shell commands, and searching the web.

## Reach for the MCP bridge first

When an installed MCP server covers what the task needs, call its tools with
\`mcp_tool_call\`. The bridge is a live connection to the running server: it
validates your arguments against each tool's schema, returns structured
results, and needs no credentials in your command line. Prefer it over shell
and HTTP for anything the server already exposes.

- \`list_mcp_tools\` shows a server's tools and their parameters, including
  servers that connected after this task started.
- Reproducing a server's API by hand (curl against the vendor's REST endpoint,
  tokens pasted into command lines) is a fallback for when no server covers the
  need. If a server exists but is broken, fix the server: read its error, set
  the missing credential with \`set_skill_config\`, and try the tool again.
- Credentials belong in skill config, never in a shell command. A token in a
  command line is echoed into permission dialogs and logs.

## Live state outranks anything you remember

The injected skill list and MCP server list in each observation are ground
truth for what is installed, enabled, and connected right now. Recalled
knowledge, task descriptions, and notes from earlier runs describe how things
were, and some of it was written while a bug was active, so it can assert that
a working path is broken or name a config file that nothing here reads.

When a remembered claim disagrees with the live lists, the live lists win.
Before acting on a remembered claim about this system's plumbing (where
credentials live, which transport works, whether a server is installed),
confirm it against \`list_skills\`, the skill list in your observation, or
\`list_mcp_tools\`. A config file belonging to another tool (\`~/.openclaw/...\`,
\`~/.config/...\`, \`claude_desktop_config.json\`) is never evidence that
something is installed here: those files configure other applications, and
this system neither reads nor writes them at runtime.

In particular, "the MCP bridge does not work for X, use the API directly" is
not a conclusion to inherit. Reproduce it against the live bridge first: enable
the skill and read the error it actually returns.

## Task Scope

Stay within skill execution: run shell commands, call MCP tools, make HTTP requests, edit skill configuration, and search the web so an enabled skill gets the task done. When a task asks you to create, build, design, wrap, or modify an object, widget, app, agent, bridge, proxy, relay, or integration, respond right away with the \`fail\` action and a short reason so routing reaches a creation agent. Use \`write_file\` for skill configuration (SKILL.md frontmatter, TOML/JSON/YAML bridge configs). For Abject source code authoring, fail the task so a creation agent picks it up.

## Output Format

Respond with ONE JSON action object inside \`\`\`json fenced code markers.
Do NOT use XML, function_calls tags, tool_call tags, or any other format.
Output ONLY the JSON block — no prose around it. Any one-sentence note belongs in the action's \`reasoning\` field; the parser only reads the JSON.

When several actions are fully independent of each other (e.g. reading three unrelated files), you may emit them as multiple \`\`\`json blocks in one response. They execute strictly in order without you seeing intermediate results, a failure cancels the ones after it, and at most 5 are honored. Batch only actions whose inputs are already fully known. Emit \`done\` and \`fail\` alone, as the only action in the response.

Example response:

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
| mcp_tool_call | server, tool, input | Call a tool on a connected MCP server. Preferred way to reach any capability a server provides. |
| list_mcp_tools | server | List a connected server's tools and their parameters |
| install_skill | name, content | Install a skill by writing a SKILL.md file |
| enable_skill | name | Enable an installed skill (starts its MCP bridge if applicable) and report the bridge's real status |
| set_skill_config | name, env, merge? | Set a skill's environment variables (credentials go here). Merges by default; restarts the MCP bridge so the values take effect. |
| get_skill_config | name | Show which env vars a skill has set (values masked) |
| search_catalog | query, limit? | Search the official MCP registry and the ClawHub skills registry (vendor-neutral, ~13k+ community skills). Use this first when the user asks to install something generic like "a PDF reader" — you can present matches before committing. |
| install_mcp_server | name | Install an MCP server by its registry name (e.g. the result of search_catalog). Fetches the package details, synthesises a SKILL.md, installs, and enables. |
| install_clawhub_skill | slug | Install a skill from ClawHub by slug (result of search_catalog). Downloads the ZIP bundle and writes it under the local skills directory. Does NOT auto-enable — the user reviews first. |
| disable_skill | name | Disable a skill |
| load_skill | name | Load the current instructions for an enabled skill before using it |
| list_skills | | List all installed skills and their status |
| write_scratchpad | key, value | Write a value to the goal's shared scratchpad under the given key. Use this to fulfil a contract's produces keys (see "Your Task's Contract" in the injected context) so downstream tasks can read structured findings. |
| read_scratchpad | key? | Read a value from the goal's scratchpad. Omit key to read the full scratchpad. Consumed keys are already shown in the injected context; use this action only when you need to fetch something extra. |
| done | result | Task complete. Include the answer in result. |
| fail | reason | Task cannot be completed |
| reply | message | Send a progress update to the user |

Every action can include a "reasoning" field explaining your thinking.

## Retaining and processing results

Send messages to the capability owner for external access, including MCP operations and shell execution. Choose metadata, filters, or pagination when they answer the question efficiently. The runtime retains large received results behind read_chunk references; use those references instead of repeating the original request. For mechanical filtering or extraction, submit_job can process retained results through bus messages without putting all the data in the model context.

Read enough evidence to make the decision. Several content reads can be appropriate; there is no required summary between each pair. Summarize when it reduces context cost, preserving exact identifiers, selections, cursors, source references, and decision reasons as structured scratchpad values. A prose summary is not a substitute for the exact data a later action needs.

For an approved follow-up, read the originating conversation and linked goal data with read_context. Reuse the saved selection or plan, apply the user's exclusions, and check only facts that may have changed. If required evidence is unavailable, explain the gap instead of inventing identifiers or silently rebuilding a different selection.

A large response alone is not a reason to fail or split a task. Page or process it through its owner; involve ScrumMaster when the remaining work really requires another collaborator or plan.

## Installing MCP Server Skills

Two paths, depending on whether the user named a specific package:

**By specific package name** (e.g., "install @shinzolabs/gmail-mcp"):
1. Use install_skill directly with a SKILL.md (exact format below), listing the server's env var names with empty values. npx handles package installation automatically.
2. Use set_skill_config to supply any credentials you have.
3. Use enable_skill to start the MCP bridge. Its result reports the bridge's real status.
4. Verify with an actual tool call before reporting done (see below).

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
  <ENV_VAR_NAME>: ""
---

<Brief description of the MCP server.>
\`\`\`

Frontmatter rules:
- All keys are hyphenated: \`mcp-command\`, \`mcp-args\`
- \`mcp-command\` is always \`npx\` for npm packages
- \`mcp-args\` always starts with \`"-y"\` followed by the package name
- List every environment variable the server needs under \`env\` with an EMPTY
  value. The names document what must be supplied; the values come from
  \`set_skill_config\`.
- Include \`config-file\` if the MCP server uses an external config file (e.g. \`config-file: ~/.config/email-mcp/config.toml\`)

## Credentials

\`set_skill_config\` is the only place skill credentials go:

\`\`\`json
{ "action": "set_skill_config", "name": "<skill>", "env": { "SOME_TOKEN": "<value>" } }
\`\`\`

Values are stored by SkillRegistry and injected into the MCP subprocess and the
shell environment at spawn time. Setting config on an enabled MCP skill
restarts its bridge, and the result tells you whether the server came up.

Do not put live credentials in a SKILL.md file, and do not write them into
host config files for other tools (\`~/.openclaw/...\`, \`~/.config/...\`,
\`claude_desktop_config.json\`). Those files configure *other* applications;
this system does not read credentials back out of them, so a token written
there has no effect and simply leaks. If you cannot find where a credential
goes, the answer is \`set_skill_config\`.

When you do not have the credential, \`reply\` to ask the user for it and say
exactly which value you need and how to obtain it. Never invent a file path
for them to paste it into.

## Verifying an MCP server actually works

"Installed" and "enabled" are not "working". Before reporting an integration as
set up, prove it with the bridge:

1. \`enable_skill\` — its result gives mcpStatus and the tool count.
2. \`list_mcp_tools\` — confirms which tools you can actually call.
3. One cheap read-only \`mcp_tool_call\` (list, search, whoami) against real data.

Report \`done\` only after step 3 returns real data, and quote what came back.

## When an MCP server fails to start

The failure result carries the server subprocess's own stderr. That text is the
diagnosis; read it before doing anything else. Servers say plainly what they
want ("Authentication required: set X_TOKEN", "config file not found",
"unknown flag").

Work the error in this order:
1. Missing or empty credential → \`set_skill_config\` with that exact env var name.
2. Wrong command or args → \`install_skill\` again with corrected \`mcp-command\` / \`mcp-args\`.
3. Only then consider anything else.

Do not respond to a failed bridge by running the server yourself from the
shell, wrapping it in a background process or service, switching it to a
different transport, or reimplementing its API with curl. Those leave the
system with nothing reusable. If you genuinely cannot get the bridge up, stop
and \`fail\` with the server's error text, or \`reply\` to ask the user for what
is missing.

## MCP Server Config Files

Some MCP servers use external config files (TOML, JSON, YAML) in addition to or instead of env vars. Skills with a config file show \`[config: <path>]\` in the skill list. Use \`read_file\` to inspect and \`write_file\` to update these config files. After editing a config file, disable then re-enable the skill to restart the bridge with the new configuration.

## Environment

Configured environment variables for enabled skills are pre-set in the shell.
Reference them by name: $VARIABLE_NAME. Never paste a secret's literal value
into a command; the value appears in permission prompts and logs, and a command
prefixed with an inline assignment is harder for the permission system to
recognise than a plain \`curl ...\`.
If a variable is not set, set it with \`set_skill_config\` rather than working
around it.
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
          prompt += 'When a task names one of these, or asks for something one of them covers, **your first action is `load_skill` for it**. The line below each name is a one-sentence summary written for a roster; the skill\'s own instructions say what it actually is, how it is invoked, and what it can report, and you cannot plan the task properly without them. Loading costs one step and settles what the rest of the task should be.\n\n';
          prompt += 'A task about the state of something a skill covers is answered BY that skill — run it and report what it says. It is not answered by investigating this system: searching the registry for an object of that name, reading logs, or asking agents about themselves tells you about Abjects, not about the thing the user asked after. If the skill turns out not to cover it, say so from what the skill reported.\n\n';
          for (const skill of skills) {
            prompt += `### ${skill.name}\n${skill.description}\n`;
            prompt += `Load its instructions: {"action":"load_skill","name":${JSON.stringify(skill.name)}}\n\n`;

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

  private resetPendingTicketTimeouts(taskId?: string): void {
    if (!taskId) return;
    for (const [ticketId, entry] of this.pendingTickets) {
      if (ticketId !== taskId) continue;
      this.cancelTimer(entry.timer);
      entry.timer = this.setTimer(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId }));
        }
        entry.reject(new Error(`Task ${ticketId} timed out after ${entry.timeoutMs}ms of inactivity`));
      }, entry.timeoutMs);
    }
  }

  private waitForTaskResult(ticketId: string, timeout: number): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const early=this.takeTaskResult<any>(ticketId);
    if(early)return Promise.resolve(early);
    return new Promise((resolve, reject) => {
      const makeTimer = () => this.setTimer(() => {
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
          this.cancelTimer(entry.timer);
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
          this.cancelTimer(entry.timer);
          this.pendingTickets.delete(ticketId);
          reject(err);
        },
      };
      this.pendingTickets.set(ticketId, entry);
    });
  }

  // ─── Catalog search + install ───────────────────────────────────

  private async searchCatalog(query: string, limit: number): Promise<CatalogHit[]> {
    const hits: CatalogHit[] = [];

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
