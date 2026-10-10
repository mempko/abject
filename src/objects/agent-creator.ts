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
import type { AgentAction } from './agent-abject.js';
import { Log } from '../core/timed-log.js';
import { noulOf } from '../llm/decision.js';
import { askScopeQuestions } from '../core/decision-questions.js';

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

  /** What this object advises on and leaves to others: its ask answers and its scope check both read it. */
  private static readonly ASK_GUIDE = `\n\n## AgentCreator: Autonomous Agent, Scheduler, and Watcher Creation Specialist

I provide design advice for new autonomous behavior that requires multiple cooperating objects: an agent with an LLM decision loop, a scheduler that fires on a recurring trigger, a watcher that reacts to events.

Examples I can advise on:
- "Create an agent that delivers a morning briefing every day at 6 AM" (agent + scheduler)
- "Build an agent that reviews code changes and provides feedback" (agent + watcher on a code source)
- "Set up a recurring check every 10 minutes that posts to chat when something changes" (scheduler + watcher)

### What's outside my scope
- Modifying existing Abject source — that's ObjectCreator's job.
- Single-object create/wrap (bridges, proxies, relays, adapters, integrations) — also ObjectCreator unless the request is a multi-object autonomous system.
- Running an existing agent — ObjectAgent invokes existing objects.

I am advisory-only and do not execute creation tasks. ObjectCreator implements the design through ScrumMaster-planned tasks. When invited to a Sprint Plan, describe the proposed composition and the implementation work to assign to ObjectCreator. If the goal needs only a single object or only modifications, reply PASS so the work routes to ObjectCreator.`;

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + AgentCreator.ASK_GUIDE;
  }

  protected override async handleAsk(question: string): Promise<string> {
    const scope = await this.askScopeGate(question);
    if (scope.pass) return scope.pass;
    return this.askLlm(this.askPrompt(question) + (scope.hint ? `\n\n${scope.hint}` : ''), question, 'fast');
  }

  /**
   * Whether a question is plainly outside what this object advises on, judged
   * against its own description (site agent.ask-scope). Most goals get PASS
   * here anyway, so only a near-certain judgment counts (in-scope p < 0.15).
   * Acting, that is a PASS with its reason, without the LLM call; held at
   * advise, it is a hint the answering model reads. Otherwise the full
   * answer path runs unchanged.
   */
  private async askScopeGate(question: string): Promise<{ pass?: string; hint?: string }> {
    const site = 'agent.ask-scope';
    if (await this.decisionSiteMode(site) === 'off') return {};
    const outcome = await this.askDecision(site, {
      agent: { name: this.manifest.name, description: `${this.manifest.description}${AgentCreator.ASK_GUIDE}` },
      question: question.slice(0, 3000),
    }, askScopeQuestions(), { onBehalfOf: this.manifest.name, timeoutMs: 5000 });
    const p = noulOf(outcome, 'in_scope');
    if (!outcome || p === undefined) return {};
    const outside = p < 0.15;
    log.info(`[decision:${outcome.mode}] AgentCreator ${site}: in_scope=${p.toFixed(2)}${outside ? (outcome.mode === 'act' ? ' → PASS without an LLM call' : ' → scope hint') : ''}`);
    if (!outside) return {};
    if (outcome.mode === 'advise') {
      return { hint: `A runtime scope check judged this question outside what you advise on (in-scope p=${p.toFixed(2)}). If that holds, answer PASS with the reason.` };
    }
    return { pass: `PASS: judged outside what I advise on (in-scope p=${p.toFixed(2)}); I advise on new autonomous behavior built from several cooperating objects (an agent, a scheduler, a watcher).` };
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

    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      const extra = this.taskExtras.get(taskId);
      if (extra?.lastResult) {
        return { observation: extra.lastResult };
      }
      return { observation: 'AgentCreator is advisory-only. Executable creation work belongs to ScrumMaster-planned ObjectCreator tasks.' };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      const extra = this.taskExtras.get(taskId) ?? {};
      this.taskExtras.set(taskId, extra);
      extra.lastResult = `Unknown action: ${action.action}`;
      return { success: false, error: `Unknown action: ${action.action}` };
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });
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

}

export const AGENT_CREATOR_ID = 'abjects:agent-creator' as AbjectId;
