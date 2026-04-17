/**
 * AgentCreator -- orchestrator agent for creating autonomous agents, schedulers,
 * and event watchers.
 *
 * Registers with AgentAbject and claims tasks that involve creating scheduled,
 * autonomous, or event-driven objects.
 *
 * Strategy: decompose the request into sub-tasks via the goal system. Each
 * sub-task includes data.role so the creation agent knows which pattern to follow.
 * AgentAbject's observe phase monitors child goal progress and reports back
 * when sub-tasks complete.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { AgentAction } from './agent-abject.js';
import { Log } from '../core/timed-log.js';

const log = new Log('AgentCreator');

const AGENT_CREATOR_INTERFACE: InterfaceId = 'abjects:agent-creator';

interface TaskExtra {
  description?: string;
  goalId?: string;
  lastResult?: string;
}

export class AgentCreator extends Abject {
  private agentAbjectId?: AbjectId;
  private jobManagerId?: AbjectId;

  private taskExtras = new Map<string, TaskExtra>();
  private pendingTickets = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    timeoutMs: number;
  }>();

  constructor() {
    super({
      manifest: {
        name: 'AgentCreator',
        description:
          'Orchestrator agent for creating autonomous agents, schedulers, and event watchers. ' +
          'Decomposes requests into sub-tasks via the goal system. Each sub-task is dispatched ' +
          'with the right pattern context. Schedulers use JobManager for triggers. ' +
          'Use cases: create scheduled tasks, build autonomous agents, set up event watchers, ' +
          'create recurring automation.',
        version: '1.0.0',
        interface: {
          id: AGENT_CREATOR_INTERFACE,
          name: 'AgentCreator',
          description: 'Agent/scheduler/watcher creation orchestrator',
          methods: [
            {
              name: 'runTask',
              description: 'Analyze a creation request, decompose, and create the needed objects',
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
          { capability: Capabilities.LLM_QUERY, reason: 'LLM analysis for request decomposition', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'agent', 'creation'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;

    await this.registerWithAgentAbject();
    log.info('Registered with AgentAbject');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AgentCreator -- Autonomous Agent, Scheduler, and Watcher Creation Specialist

### What I Handle
I create NEW autonomous agents, scheduled agents, and event watchers. I am the right
choice whenever the user asks to "create an agent" or wants autonomous behavior that
runs on a schedule or responds to events.

Examples of tasks I handle well:
- "Create an agent that delivers a morning briefing every day at 6 AM"
- "Create an agent that analyzes news and writes summaries"
- "Build an agent that reviews code changes and provides feedback"
- "Create an agent that monitors weather and alerts on storms"
- Any task containing the word "agent" that involves creating new autonomous behavior

### My Scope
I create autonomous agents, scheduled agents, and event watchers. Tasks about modifying existing objects, regular widget/app creation, or one-time data fetches belong to other agents.

### How I Work
1. Decompose the request into sub-tasks via the goal system
2. Each sub-task creates a new object (agent, scheduler, or watcher)
3. Monitor child goal progress, report done when all complete

When asked about a task, describe how you would decompose it into agent/scheduler/watcher sub-tasks. Say PASS if the task is about modifying existing objects, regular widget creation, or calling existing objects.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    return this.askLlm(this.askPrompt(question), question, 'fast');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { goalId, description, approach, failureHistory } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; approach?: string;
        failureHistory?: Array<{ agent: string; error: string }>;
      };

      const taskId = `ac-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { description, goalId });

      try {
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
            systemPrompt: this.buildSystemPrompt(),
            goalId,
            initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
            config: {
              maxSteps: 15,
              timeout: 600000,
              queueName: `agent-creator-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 610000);
        return { success: result.success, result: result.result, error: result.error };
      } finally {
        this.taskExtras.delete(taskId);
      }
    });

    this.on('runTask', async (msg: AbjectMessage) => {
      const { task } = msg.payload as { task: string };
      const taskId = `ac-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { description: task });

      try {
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task,
            systemPrompt: this.buildSystemPrompt(),
            config: {
              maxSteps: 15,
              timeout: 600000,
              queueName: `agent-creator-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 610000);
        return { success: result.success, result: result.result };
      } finally {
        this.taskExtras.delete(taskId);
      }
    });

    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        pending.resolve(payload);
      }
    });

    // Each callback proves the agent is still working, so reset the inactivity timeout.
    this.on('agentObserve', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId } = msg.payload as { taskId: string; step: number };
      const extra = this.taskExtras.get(taskId);
      if (extra?.lastResult) {
        return { observation: extra.lastResult };
      }
      return { observation: 'AgentCreator ready. Analyze the request and decompose into sub-tasks.' };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      const extra = this.taskExtras.get(taskId) ?? {};
      this.taskExtras.set(taskId, extra);
      extra.lastResult = `Unknown action: ${action.action}`;
      return { success: false, error: `Unknown action: ${action.action}` };
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
  }

  // ═══════════════════════════════════════════════════════════════════
  // Registration
  // ═══════════════════════════════════════════════════════════════════

  private async registerWithAgentAbject(): Promise<void> {
    if (!this.agentAbjectId) return;

    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'AgentCreator',
      description:
        'Creates autonomous agents, scheduled agents, and event watchers. ' +
        'Any task containing "agent" that involves creating new autonomous behavior belongs here. ' +
        'Decomposes requests into sub-tasks dispatched via the goal system.',
      config: {
        maxSteps: 15,
        timeout: 600000,
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply', 'decompose'],
        queueName: `agent-creator-${this.id}`,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(): string {
    return `You are AgentCreator, an orchestrator for creating autonomous objects.

## What You Do

You analyze requests and decompose them into sub-tasks. Each sub-task gets dispatched via the goal system and the most capable agent claims it. You monitor progress via the observe phase and report done when everything is created.

## Available Actions

| Action | Fields | Description |
|--------|--------|-------------|
| decompose | subtasks | Create sub-tasks dispatched via the goal system. |
| done | result | All done. Summarize what was created. |
| fail | reason | Cannot complete. |
| reply | message | Progress update. |

## How to Decompose

Each subtask has a description and optional data. Tag each with data.role so the creation agent uses the right pattern:

- data.role = "agent" -> Agent Object (registers with AgentAbject, handles tasks autonomously)
- data.role = "scheduler" -> Scheduler Object (Timer-based, submits Jobs via JobManager when triggers fire)
- data.role = "watcher" -> Watcher Object (observes other objects, submits Jobs via JobManager on events)
- No role -> regular object (the creation agent decides the pattern)

Include data.additionalDeps for extra dependencies beyond the pattern base (e.g. ["HttpClient", "WebParser"] for web access).

## Task Dependencies

**Tasks run SEQUENTIALLY by default** — each task waits for the previous one to finish. This is safest when one task's output feeds another, or when tasks share resources.

- Leave \`dependsOn\` unspecified (or omit it) for the default sequential chain.
- Set \`dependsOn: [0, 2]\` with 0-based indices for a specific dependency.
- Set \`dependsOn: []\` (empty array) to explicitly opt into parallel execution — ONLY when you know the tasks are fully independent.

## Examples

"Create an agent that tells me the weather every day at 6:30PM":
\`\`\`json
{ "action": "decompose", "subtasks": [
  { "description": "Create an agent that fetches current weather and top news, registers with AgentAbject for weather/news tasks, and posts results to Chat via addNotification when it executes a task", "data": { "role": "agent", "additionalDeps": ["HttpClient", "WebParser"] } },
  { "description": "Create a scheduler that fires every day at 6:30PM PT and submits a Job via JobManager that creates a goal with a weather briefing task for agent dispatch", "data": { "role": "scheduler" }, "dependsOn": [0] }
], "reasoning": "Scheduler depends on agent existing first" }
\`\`\`

"Create a scheduler that checks news every hour":
\`\`\`json
{ "action": "decompose", "subtasks": [
  { "description": "Create a scheduler that fires every hour and submits a Job via JobManager that creates a goal with a news-checking task", "data": { "role": "scheduler", "additionalDeps": ["HttpClient", "WebParser"] } }
], "reasoning": "Single scheduler, no separate agent needed" }
\`\`\`

"Watch the knowledge base and summarize changes":
\`\`\`json
{ "action": "decompose", "subtasks": [
  { "description": "Create a watcher that observes KnowledgeBase for changes and submits a Job via JobManager that creates a summarization task for agent dispatch", "data": { "role": "watcher" } }
], "reasoning": "Single watcher" }
\`\`\`

## Rules

- Always decompose on the first step
- After decomposing, observe will show child goal progress. Wait until all sub-tasks complete, then report done.
- Each sub-task creates exactly one object
- Schedulers and watchers MUST use JobManager.submitJob in their trigger handlers, never call GoalManager directly
- When one sub-task depends on another (e.g. scheduler needs agent to exist), use dependsOn
- Agents do work, schedulers trigger work. Always decompose timed tasks into separate agent + scheduler sub-tasks. The system has a built-in Scheduler object for all timed triggers.
- When the request involves a specific time or recurring schedule, create at least two sub-tasks: one for the agent (role=agent) and one for the scheduler (role=scheduler, dependsOn the agent)

## Output Format

Respond with ONE JSON object inside \`\`\`json fenced code markers.`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ticket waiting
  // ═══════════════════════════════════════════════════════════════════

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
}

export const AGENT_CREATOR_ID = 'abjects:agent-creator' as AbjectId;
