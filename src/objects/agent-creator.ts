/**
 * AgentCreator -- advisory object for autonomous agents, schedulers, and
 * event watchers.
 *
 * ScrumMaster owns task planning. This object remains available through the
 * ask protocol for architectural advice, but it is not an executable team
 * member and should not claim creation tasks.
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
          'Advisory object for creating autonomous agents, schedulers, and event watchers. ' +
          'ScrumMaster owns planning and should assign executable creation tasks to ObjectCreator. ' +
          'Schedulers use JobManager for triggers. ' +
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
              description: 'Deprecated executable path. Use the ask protocol for advice; ScrumMaster plans creation tasks.',
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
          { capability: Capabilities.LLM_QUERY, reason: 'LLM analysis for autonomous-object design advice', required: true },
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
    log.info('Registered with AgentAbject as advisory-only');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AgentCreator: Autonomous Agent, Scheduler, and Watcher Creation Specialist

I author NEW autonomous behavior that requires multiple cooperating objects: an agent with an LLM decision loop, a scheduler that fires on a recurring trigger, a watcher that reacts to events.

Examples I handle well:
- "Create an agent that delivers a morning briefing every day at 6 AM" (agent + scheduler)
- "Build an agent that reviews code changes and provides feedback" (agent + watcher on a code source)
- "Set up a recurring check every 10 minutes that posts to chat when something changes" (scheduler + watcher)

### What's outside my scope
- Modifying existing Abject source — that's ObjectCreator's job.
- Single-object create/wrap (bridges, proxies, relays, adapters, integrations) — also ObjectCreator unless the request is a multi-object autonomous system.
- Running an existing agent — ObjectAgent invokes existing objects.

When invited to a Sprint Plan, describe what I'd build and how I'd compose it across multiple cooperating objects. If the goal needs only a single object or only modifications, reply PASS so the work routes to ObjectCreator.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    return this.askLlm(this.askPrompt(question), question, 'fast');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { tupleId, taskId: explicitTaskId, goalId, description, approach, failureHistory } = msg.payload as {
        tupleId: string; taskId?: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; approach?: string;
        failureHistory?: Array<{ agent: string; error: string }>;
      };
      void tupleId;
      void explicitTaskId;
      void goalId;
      void description;
      void approach;
      void failureHistory;

      return {
        success: false,
        error: 'AgentCreator is advisory-only. ScrumMaster should plan the creation scrum and assign executable object creation tasks to ObjectCreator.',
      };
    });

    this.on('runTask', async (msg: AbjectMessage) => {
      const { task } = msg.payload as { task: string };
      void task;
      return {
        success: false,
        error: 'AgentCreator is advisory-only. Ask it for design advice, then let ScrumMaster plan executable ObjectCreator tasks.',
      };
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
      return { observation: 'AgentCreator is advisory-only. Executable creation work belongs to ScrumMaster-planned ObjectCreator tasks.' };
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
        'Creates new autonomous behavior that requires MULTIPLE cooperating objects: an LLM-driven agent, a recurring scheduler, and/or an event watcher, composed together. ' +
        'Advises ScrumMaster on how to split creation work into component Abjects (agent plus scheduler plus watcher as needed). ' +
        'Best when the work needs a new LLM decision loop plus infrastructure to trigger or observe it. ' +
        'Single forwarding objects (bridges, proxies, relays, adapters, integrations that move traffic between endpoints) fit a single-object pattern and go to a creation agent that builds single objects, even when the forwarder polls internally. Running an existing agent on a one-off task goes to a runtime interaction agent; source changes to an existing agent go to a creation-and-modification agent; regular widgets or apps without an autonomous loop go to a creation agent; one-shot data fetches go to a runtime interaction agent.',
      canExecute: false,
      config: {
        maxSteps: 15,
        timeout: 600000,
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        queueName: `agent-creator-${this.id}`,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(): string {
    return `You are AgentCreator, an advisory object for creating autonomous objects.

## What You Do

You advise ScrumMaster on how autonomous agents, schedulers, and watchers should be composed. ScrumMaster owns planning; ObjectCreator owns executable object creation and modification.

## Available Actions

| Action | Fields | Description |
|--------|--------|-------------|
| done | result | All done. Summarize what was created. |
| fail | reason | Cannot complete. |
| reply | message | Progress update. |

## Design Guidance

When asked for advice, describe the component objects ScrumMaster should plan:

- agent object: registers with AgentAbject and handles delegated tasks autonomously
- scheduler object: timer-based object that submits Jobs via JobManager when triggers fire
- watcher object: observes other objects and submits Jobs via JobManager on events
- regular object: single-purpose service or UI object

Schedulers and watchers MUST use JobManager.submitJob in their trigger handlers, never call GoalManager directly.

## Rules

- Agents do work, schedulers trigger work. Timed systems should be planned as separate agent and scheduler object-creation tasks. The system has a built-in Scheduler object for all timed triggers.
- When the request involves a specific time or recurring schedule, advise ScrumMaster to plan at least two ObjectCreator tasks: one for the agent and one for the scheduler.
- If assigned executable work, fail and explain that ScrumMaster should plan ObjectCreator tasks.

## Output Format

Respond with ONE JSON object inside \`\`\`json fenced code markers. Output ONLY the JSON block — no prose around it. Any one-sentence note belongs in the action's \`reasoning\` field; the parser only reads the JSON.`;
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
