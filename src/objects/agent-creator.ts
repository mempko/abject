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
  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
      const { goalId, description } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string;
      };

      const taskId = `ac-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { description, goalId });

      try {
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt: this.buildSystemPrompt(),
            goalId,
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
        this.pendingTickets.delete(payload.ticketId);
        pending.resolve(payload);
      }
    });

    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      const extra = this.taskExtras.get(taskId);
      if (extra?.lastResult) {
        return { observation: extra.lastResult };
      }
      return { observation: 'AgentCreator ready. Analyze the request and decompose into sub-tasks.' };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      const extra = this.taskExtras.get(taskId) ?? {};
      this.taskExtras.set(taskId, extra);
      // decompose, done, fail, reply are all handled by AgentAbject natively.
      // If we get here it's an unknown action.
      extra.lastResult = `Unknown action: ${action.action}`;
      return { success: false, error: `Unknown action: ${action.action}` };
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => {});
    this.on('agentActionResult', async () => {});
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

Use \`dependsOn\` with task indices (0-based) when a task needs a previous task to complete first.
Tasks without dependsOn run in parallel. Tasks with dependsOn wait until all listed tasks are done.

## Examples

"Create an agent that tells me the weather every day at 6:30PM":
\`\`\`json
{ "action": "decompose", "subtasks": [
  { "description": "Create an agent that fetches current weather and top news, registers with AgentAbject with askDescription for weather/news tasks, and posts results to Chat via addNotification when it executes a task", "data": { "role": "agent", "additionalDeps": ["HttpClient", "WebParser"] } },
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

export const AGENT_CREATOR_ID = 'abjects:agent-creator' as AbjectId;
