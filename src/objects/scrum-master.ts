/**
 * ScrumMaster — facilitates the Scrum cycle for goals via an OTA loop.
 *
 * Vocabulary (per Sutherland & Coplien's "A Scrum Book"):
 *   - **Sprint** is the entire goal lifecycle. One sprint per goal.
 *   - **Scrum** is a single recurring meeting within the sprint — review the
 *     prior round's outcomes and decide to either (a) declare the sprint
 *     done, (b) plan more tasks for the next round, or (c) fail the goal.
 *
 * Architecture: ScrumMaster registers itself as an Agent with AgentAbject
 * and runs each scrum as one task through the standard observe/think/act
 * loop. The LLM decides on each cycle whether to look at state, poll
 * specific team members, stage tasks, or terminate the scrum. The two-phase
 * "review then maybe poll" pattern emerges naturally from the action
 * vocabulary plus a system prompt that mandates review-first.
 *
 * Triggers (via GoalManager `changed` events):
 *   - `goalCreated` (top-level goal): enqueue a fresh scrum task (first
 *     meeting of the sprint).
 *   - `goalReadyForCompletion` (every task at currentScrumNumber reached
 *     terminal state): enqueue a scrum task (review then decide).
 *
 * Action vocabulary the OTA loop emits:
 *   - `review_scrum` (intermediate) — fetches goal+tasks+scratchpad summary
 *     as an explicit action result. The system prompt mandates this as
 *     the FIRST action of every scrum.
 *   - `poll_team` (intermediate) — round-robin asks to specific team members
 *   - `add_task` (intermediate) — STAGE one task in the current scrum's plan
 *     (no commit yet); validation and dep-indices resolved at stage time.
 *   - `complete_goal` (TERMINAL success) — synthesize a final answer and
 *     mark the goal completed; abandons any staged tasks.
 *   - `fail_goal` (TERMINAL error) — declare the goal unreachable.
 *   - `dispatch_scrum` (TERMINAL success) — COMMIT staged tasks: reserve a
 *     scrum number, addTask each into TupleSpace, then enqueue the
 *     dependency-free ones. Dependents register in pendingDeps and get
 *     enqueued as upstream taskCompleted events arrive.
 *
 * One ScrumMaster per workspace.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { safeStringify } from '../core/format.js';

const log = new Log('ScrumMaster');

const SCRUM_MASTER_INTERFACE: InterfaceId = 'abjects:scrum-master';

/** A single team-member contribution returned by a poll_team ask. */
interface TeamContribution {
  agentName: string;
  text: string;
}

/** A task staged by `add_task`, awaiting commit by `dispatch_scrum`. */
interface StagedTask {
  description: string;
  assignedAgentName: string;
  assignedAgentId: AbjectId;
  /** Indices into the scrum's `staged` array (0-based). Resolved to taskIds at dispatch. */
  dependsOnIdx: number[];
  produces?: Array<{ key: string; description: string }>;
  consumes?: string[];
}

export class ScrumMaster extends Abject {
  private goalManagerId?: AbjectId;
  private agentAbjectId?: AbjectId;
  /** Optional. Used by review_scrum auto-recall, save_knowledge, lookup_knowledge. */
  private knowledgeBaseId?: AbjectId;
  /** Used for fast-tier synthesis calls (complete_goal markdown formatting). */
  private llmId?: AbjectId;

  /** Idempotency: each (goalId, scrumNumber) only enqueues one scrum task. */
  private scrummedRounds = new Set<string>();

  /**
   * Tasks waiting on upstream dependencies. As `taskCompleted` events arrive
   * for upstream taskIds, dependents whose blockers become empty are enqueued
   * on their assigned agent. `taskPermanentlyFailed` cascades the failure.
   */
  private pendingDeps = new Map<string, {
    goalId: string;
    agentId: AbjectId;
    description: string;
    blockers: Set<string>;
  }>();

  /**
   * Per-OTA-task accumulators for the current scrum. Tasks staged via
   * `add_task` live here until `dispatch_scrum` commits them. If the cycle
   * ends with `complete_goal`/`fail_goal` instead, the staged batch is
   * cleanly abandoned (nothing was written to TupleSpace).
   * Keyed by the OTA task id.
   */
  private scrumInFlight = new Map<string, {
    goalId: string;
    staged: StagedTask[];
  }>();

  /**
   * Pending ticket promises. AgentAbject's queue runner sends `executeTask`
   * to bootstrap the OTA loop; we forward to `startTask` and await the
   * resulting `taskResult` event. This map joins the two — same pattern
   * SkillAgent/WebAgent use.
   */
  private pendingTickets = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    resolve: (payload: unknown) => void;
    reject: (err: Error) => void;
  }>();

  constructor() {
    super({
      manifest: {
        name: 'ScrumMaster',
        description:
          'Facilitates the Scrum cycle for goals via an OTA loop. A goal is a sprint; ' +
          'a scrum is a recurring meeting that reviews the prior round and either declares ' +
          'the sprint done or plans more tasks. ScrumMaster is itself a registered Agent — ' +
          'each scrum is one task in its queue, observed/thought/acted by the LLM. ' +
          'One per workspace.',
        version: '2.0.0',
        interface: {
          id: SCRUM_MASTER_INTERFACE,
          name: 'ScrumMaster',
          description: 'Scrum facilitator for goal-driven sprints (agent-based)',
          methods: [],
          events: [
            {
              name: 'scrumPlanned',
              description: 'A scrum committed staged tasks via dispatch_scrum',
              payload: { kind: 'object', properties: {
                goalId: { kind: 'primitive', primitive: 'string' },
                scrumNumber: { kind: 'primitive', primitive: 'number' },
                tasksPlanned: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'sprintCompleted',
              description: 'A scrum declared the sprint done',
              payload: { kind: 'object', properties: {
                goalId: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.LLM_QUERY, reason: 'Scrum decisions', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'scrum'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.goalManagerId = await this.requireDep('GoalManager');
    this.agentAbjectId = await this.requireDep('AgentAbject');
    // KnowledgeBase is looked up LAZILY (see `getKnowledgeBaseId`). Eager
    // init-time discovery breaks when ScrumMaster spawns BEFORE
    // KnowledgeBase in the workspace bootstrap order — discoverDep returns
    // null, the cache stays empty forever, and every save_knowledge /
    // lookup_knowledge / review_scrum auto-recall silently no-ops with
    // "KnowledgeBase not registered". Lazy lookup makes spawn order
    // irrelevant.
    this.llmId = await this.discoverDep('LLM') ?? undefined;

    // Subscribe to GoalManager events.
    this.send(request(this.id, this.goalManagerId, 'addDependent', {}));

    // Register ourselves as an Agent. canExecute=false so we never receive
    // user-task dispatches; only our own self-enqueued scrum tasks. Filter
    // on name keeps us out of team polls.
    await this.request(
      request(this.id, this.agentAbjectId, 'registerAgent', {
        agentId: this.id,
        name: 'ScrumMaster',
        description: 'Scrum facilitator. Runs scrum meetings for goal-driven sprints.',
        canExecute: false,
        config: {
          maxSteps: 12,
          timeout: 300000,
          terminalActions: {
            complete_goal: { type: 'success' },
            fail_goal: { type: 'error', resultFields: ['reason'] },
            dispatch_scrum: { type: 'success' },
          },
          intermediateActions: [],
        },
        systemPrompt: this.buildSystemPrompt(),
      }),
    ).catch(err => log.warn(`registerAgent failed: ${err instanceof Error ? err.message : String(err)}`));

    log.info('Initialized; registered as Agent and subscribed to GoalManager events');
  }

  private setupHandlers(): void {
    // GoalManager event subscription. Two triggers enqueue a fresh scrum task;
    // taskCompleted/taskPermanentlyFailed drive dep tracking.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value: unknown };

      if (aspect === 'goalCreated') {
        const { goalId, parentId } = value as { goalId: string; parentId?: string };
        if (parentId) return; // only top-level goals
        // Defer one tick so the creator (e.g. Chat) has time to settle.
        setTimeout(() => this.enqueueScrumTask(goalId, 0).catch(err =>
          log.warn(`enqueueScrumTask(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
        ), 200);
      } else if (aspect === 'goalReadyForCompletion') {
        const { goalId, scrumNumber } = value as { goalId: string; scrumNumber: number };
        await this.enqueueScrumTask(goalId, scrumNumber).catch(err =>
          log.warn(`enqueueScrumTask(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
        );
      } else if (aspect === 'goalCompleted' || aspect === 'goalFailed') {
        const { goalId } = value as { goalId: string };
        for (const [pendingId, info] of this.pendingDeps) {
          if (info.goalId === goalId) this.pendingDeps.delete(pendingId);
        }
      } else if (aspect === 'taskCompleted') {
        const { taskId } = value as { taskId: string };
        this.unblockDependents(taskId).catch(err =>
          log.warn(`unblockDependents(${taskId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
        );
      } else if (aspect === 'taskPermanentlyFailed') {
        const { taskId } = value as { taskId: string };
        this.cascadeFailDependents(taskId).catch(err =>
          log.warn(`cascadeFailDependents(${taskId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });

    // Queue-runner bootstrap. AgentAbject's queue runner sends `executeTask`
    // to the agent when it pops a queued task; we forward to startTask to
    // launch the OTA loop, then wait on the matching taskResult event.
    // Without this, the queue stalls — the runner pops the task, sends
    // `executeTask`, gets nothing back, and the OTA loop never starts.
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { tupleId, taskId: explicitTaskId, goalId, description } = msg.payload as {
        tupleId: string; taskId?: string; goalId?: string; description: string;
      };
      const taskId = explicitTaskId ?? tupleId ?? `scrum-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Pre-populate the in-flight entry with the goalId. We need this so
      // `lookupGoalIdForOTATask` works even from the `taskResult` listener,
      // which fires AFTER AgentAbject has cleared the queue's inFlight slot
      // — leaving us with no other way to recover the goalId from just the
      // ticket id. The `staged` array starts empty; `add_task` appends.
      if (goalId) {
        this.scrumInFlight.set(taskId, { goalId, staged: [] });
      }

      try {
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            goalId,
            dispatchTupleId: tupleId,
            config: {
              maxSteps: 12,
              timeout: 300000,
              terminalActions: {
                complete_goal: { type: 'success' },
                fail_goal: { type: 'error', resultFields: ['reason'] },
                dispatch_scrum: { type: 'success' },
              },
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 600000);
        return { success: result.success, result: result.result, error: result.error };
      } catch (err) {
        log.warn(`executeTask for ${taskId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // Agent-callback handlers. AgentAbject's runStateMachine calls these
    // for tasks queued under our agentId.
    this.on('agentObserve', async (msg: AbjectMessage) => this.handleObserve(msg));
    this.on('agentAct', async (msg: AbjectMessage) => this.handleAct(msg));

    // taskResult fires when our own scrum task terminates. Terminal actions
    // (complete_goal / fail_goal / dispatch_scrum) skip AgentAbject's
    // `acting` phase — the state machine sees them as terminal during the
    // thinking phase and jumps straight to `done`. So the side effects
    // (addTask + enqueue for dispatch, completeGoal for done, failGoal for
    // fail) have to happen HERE, gated on `lastAction.action`. This listener
    // is the canonical "scrum cycle terminated, do the commit step" hook.
    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        ticketId: string;
        lastAction?: { action: string; [k: string]: unknown };
      };

      // Run the terminal action's side effect before resolving the ticket.
      try {
        await this.executeTerminalAction(payload.ticketId, payload.lastAction);
      } catch (err) {
        log.warn(`executeTerminalAction failed for ${payload.ticketId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) pending.resolve(payload);
      this.scrumInFlight.delete(payload.ticketId);
    });

    // Forward progress events to reset our pending-ticket inactivity timers.
    this.on('progress', () => {
      for (const [, entry] of this.pendingTickets) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          // Re-arm timeout — only fires if NO further progress lands.
          // Same handler logic as initial timer.
          entry.reject(new Error('Task timed out (no progress)'));
        }, 600000);
      }
    });
  }

  private waitForTaskResult(
    ticketId: string,
    timeout: number,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId }));
        }
        reject(new Error(`Scrum task ${ticketId.slice(0, 8)} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingTickets.set(ticketId, {
        timer,
        resolve: (payload: unknown) => {
          clearTimeout(timer);
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
          clearTimeout(timer);
          this.pendingTickets.delete(ticketId);
          reject(err);
        },
      });
    });
  }

  /**
   * Enqueue a scrum task on ourselves. Idempotent per (goalId, scrumNumber).
   */
  private async enqueueScrumTask(goalId: string, priorScrumNumber: number): Promise<void> {
    if (!this.agentAbjectId) return;
    const roundKey = `${goalId}#${priorScrumNumber}`;
    if (this.scrummedRounds.has(roundKey)) {
      log.info(`Scrum already enqueued for ${goalId.slice(0, 8)} after round ${priorScrumNumber}`);
      return;
    }
    this.scrummedRounds.add(roundKey);

    const taskDesc = priorScrumNumber === 0
      ? `Run the first scrum for goal ${goalId.slice(0, 8)}. No prior round — review the goal description and team roster, plan the initial work.`
      : `Run a scrum for goal ${goalId.slice(0, 8)} after round ${priorScrumNumber}. Review the round's outcomes (completed tasks, scratchpad, failed tasks) and decide: complete_goal, plan more, or fail_goal.`;

    log.info(`Enqueuing scrum task for goal ${goalId.slice(0, 8)} (after round ${priorScrumNumber})`);

    await this.request(
      request(this.id, this.agentAbjectId, 'enqueueTask', {
        agentId: this.id,
        task: taskDesc,
        goalId,
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // OTA — observe
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Observation strings. AgentAbject auto-injects the goal context (title,
   * description, scratchpad, task list) via `buildGoalProgressContext`, so
   * we don't repeat that here — we just remind the LLM of its loop position.
   * The system prompt mandates `review_scrum` as the first action regardless.
   */
  private async handleObserve(msg: AbjectMessage): Promise<{ observation: string }> {
    const { taskId, step } = msg.payload as { taskId: string; step: number };
    if (step === 0) {
      return {
        observation: `Beginning scrum for OTA task ${taskId.slice(0, 8)}. Your first action MUST be review_scrum (look at goal context, completed/failed tasks, scratchpad). Then decide: complete_goal, plan via add_task+dispatch_scrum, or fail_goal.`,
      };
    }
    return {
      observation: `Step ${step}. Your prior action's result is in the conversation above. Decide your next action.`,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // OTA — act
  // ═══════════════════════════════════════════════════════════════════

  private async handleAct(msg: AbjectMessage): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const rawAction = (msg.payload as { action: { action: string; [k: string]: unknown } }).action;
    const taskId = (msg.payload as { taskId: string }).taskId;
    // LLMs sometimes wrap action parameters in a `params` / `arguments` /
    // `input` envelope even when the prompt's example puts fields at the
    // top level. Unwrap so `actAddTask` etc. don't have to know about it.
    // Same defensive pattern MCPBridge.callTool uses for tool inputs.
    const action = this.normalizeActionEnvelope(rawAction);

    const goalId = await this.lookupGoalIdForOTATask(taskId);
    if (!goalId) {
      return { success: false, error: 'No goal associated with this scrum task' };
    }

    try {
      switch (action.action) {
        case 'review_scrum':
          return await this.actReviewScrum(goalId);
        case 'poll_team':
          return await this.actPollTeam(goalId, action);
        case 'add_task':
          return await this.actAddTask(taskId, goalId, action);
        case 'save_knowledge':
          return await this.actSaveKnowledge(action);
        case 'lookup_knowledge':
          return await this.actLookupKnowledge(action);
        case 'forget_knowledge':
          return await this.actForgetKnowledge(action);
        // complete_goal / fail_goal / dispatch_scrum are terminal — they
        // never reach this handler (AgentAbject's state machine routes them
        // straight to `done` from the thinking phase). Their side effects
        // execute in the `taskResult` listener via executeTerminalAction.
        default:
          return { success: false, error: `Unknown action "${action.action}". Valid intermediate: review_scrum, poll_team, add_task, save_knowledge, lookup_knowledge, forget_knowledge. Terminal: complete_goal, fail_goal, dispatch_scrum.` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Some LLMs emit `{ "action": "add_task", "params": { ... } }` instead of
   * the flat `{ "action": "add_task", "description": ..., ... }` shape the
   * prompt asks for. This normalizes both: if the action object has a
   * `params` / `arguments` / `input` envelope, its fields are merged onto
   * the top level (top-level keys win on conflict). Always returns a fresh
   * object — never mutates the caller's.
   */
  private normalizeActionEnvelope(action: { action: string; [k: string]: unknown }): { action: string; [k: string]: unknown } {
    const envelope = (action.params ?? action.arguments ?? action.input) as Record<string, unknown> | undefined;
    if (!envelope || typeof envelope !== 'object') return action;
    return { ...envelope, ...action };
  }

  /**
   * Run the side effect for a terminal action. Called from the `taskResult`
   * listener once the OTA loop has finished. `lastAction` carries the full
   * action object the LLM emitted (including parameters like `synthesis`
   * or `reason`), and the staged tasks for `dispatch_scrum` live in
   * `scrumInFlight[otaTaskId]`.
   */
  private async executeTerminalAction(
    otaTaskId: string,
    lastAction: { action: string; [k: string]: unknown } | undefined,
  ): Promise<void> {
    if (!lastAction) {
      log.warn(`executeTerminalAction: no lastAction for OTA task ${otaTaskId.slice(0, 8)}`);
      return;
    }
    const goalId = await this.lookupGoalIdForOTATask(otaTaskId);
    if (!goalId) {
      log.warn(`executeTerminalAction: no goal for OTA task ${otaTaskId.slice(0, 8)}`);
      return;
    }

    // Same envelope tolerance as handleAct — terminal actions might also
    // arrive as `{ action: "complete_goal", params: { synthesis: ... } }`.
    const normalized = this.normalizeActionEnvelope(lastAction);

    switch (normalized.action) {
      case 'complete_goal':
        await this.commitCompleteGoal(goalId, normalized);
        return;
      case 'fail_goal':
        await this.commitFailGoal(goalId, normalized);
        return;
      case 'dispatch_scrum':
        await this.commitDispatchScrum(otaTaskId, goalId);
        return;
      default:
        // Non-terminal lastAction — nothing to commit. Means the OTA hit
        // maxSteps or errored without a clean terminal. Log so we can see it.
        log.info(`executeTerminalAction: lastAction "${lastAction.action}" not a terminal — no commit needed`);
        return;
    }
  }

  /**
   * The OTA loop only knows the AgentAbject task id. Translate to goalId via
   * AgentAbject's queue inspection. (We could keep a local map but the queue
   * already has it.)
   */
  private async lookupGoalIdForOTATask(taskId: string): Promise<string | undefined> {
    const tracked = this.scrumInFlight.get(taskId);
    if (tracked) return tracked.goalId;
    if (!this.agentAbjectId) return undefined;
    try {
      const queue = await this.request<{ inFlight?: { taskId: string; goalId?: string }; pending: Array<{ taskId: string; goalId?: string }> }>(
        request(this.id, this.agentAbjectId, 'listAgentQueue', { agentId: this.id }),
      );
      if (queue.inFlight?.taskId === taskId) return queue.inFlight.goalId;
      const found = queue.pending.find(p => p.taskId === taskId);
      return found?.goalId;
    } catch { return undefined; }
  }

  // ─── Action: review_scrum ─────────────────────────────────────────

  /**
   * Returns a structured snapshot of the goal: title, description, completed
   * tasks (with results), failed tasks (with errors), scratchpad keys+values,
   * team roster. AgentAbject already injects much of this into the prompt,
   * but having an explicit action result lets the LLM "look at state" as a
   * deliberate first step before deciding.
   */
  private async actReviewScrum(
    goalId: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.goalManagerId || !this.agentAbjectId) return { success: false, error: 'Dependencies unavailable' };

    const goal = await this.request<{
      title: string; description: string; status: string; currentScrumNumber: number;
      scratchpad?: Record<string, unknown>;
    } | null>(
      request(this.id, this.goalManagerId, 'getGoal', { goalId }),
    );
    if (!goal) return { success: false, error: 'Goal not found' };

    const allTasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
      request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }),
    ).catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>);
    const completed = allTasks.filter(t => t.fields.status === 'done');
    const failed = allTasks.filter(t => t.fields.status === 'permanently_failed');

    // Names only — capabilities are dynamic and live in each agent's askPrompt.
    // Static manifest descriptions are stale for any agent whose capabilities
    // are runtime-configurable (SkillAgent's installed skills, MCPBridge's
    // tool list). The planner should call `poll_team` (which uses the ask
    // protocol) when it needs to know what agents can actually do.
    const team = await this.request<Array<{ agentId: AbjectId; name: string; description: string }>>(
      request(this.id, this.agentAbjectId, 'listAgents', {}),
    );
    const eligibleTeamNames = team
      .filter(a => a.name !== 'Chat' && a.name !== 'ScrumMaster')
      .map(a => a.name);

    const scratchpad = goal.scratchpad ?? {};
    const scratchpadSummary: Record<string, string> = {};
    for (const [k, v] of Object.entries(scratchpad)) {
      scratchpadSummary[k] = safeStringify(v, 6000);
    }

    // Auto-recall against the goal description so prior lessons land in
    // the LLM's context without needing an explicit lookup_knowledge call.
    // This is what skips Registry rediscovery on repeat tasks: a previous
    // scrum saved a "this kind of goal routes to that Abject via that
    // method" lesson → the recall surfaces it → the planner uses it directly.
    const relevantKnowledge = await this.recallKnowledge(goal.description);

    return {
      success: true,
      data: {
        goal: {
          title: goal.title,
          description: goal.description,
          currentScrumNumber: goal.currentScrumNumber,
          status: goal.status,
        },
        completed: completed.map(t => ({
          description: (t.fields.description as string ?? '').slice(0, 300),
          producesKeys: ((t.fields.produces as Array<{ key: string }>) ?? []).map(p => p.key),
          assignedAgentId: (t.fields.assignedAgentId as string ?? '').slice(0, 8),
        })),
        failed: failed.map(t => ({
          description: (t.fields.description as string ?? '').slice(0, 300),
          error: (t.fields.error as string ?? '').slice(0, 600),
          assignedAgentId: (t.fields.assignedAgentId as string ?? '').slice(0, 8),
        })),
        scratchpad: scratchpadSummary,
        teamNames: eligibleTeamNames,
        relevantKnowledge,
      },
    };
  }

  /**
   * Lazy lookup of KnowledgeBase. Returns the id if found (caching it for
   * subsequent calls), or undefined if KB hasn't been spawned yet. We do
   * NOT cache `undefined` — every call re-discovers until KB shows up,
   * which makes spawn order irrelevant.
   */
  private async getKnowledgeBaseId(): Promise<AbjectId | undefined> {
    if (this.knowledgeBaseId) return this.knowledgeBaseId;
    const id = await this.discoverDep('KnowledgeBase');
    if (id) this.knowledgeBaseId = id;
    return id ?? undefined;
  }

  /**
   * Pull entries from KnowledgeBase that match a query. Returns a compact
   * shape (id, title, type, content) so the LLM can reference entries by
   * id later (e.g. for forget_knowledge).
   */
  private async recallKnowledge(
    query: string,
    limit = 5,
  ): Promise<Array<{ id: string; title: string; type: string; tags?: string[]; content: string }>> {
    const kbId = await this.getKnowledgeBaseId();
    if (!kbId) return [];
    try {
      const entries = await this.request<Array<{ id: string; title: string; type: string; tags?: string[]; content: string }>>(
        request(this.id, kbId, 'recall', { query, limit }),
        5000,
      );
      return Array.isArray(entries) ? entries : [];
    } catch (err) {
      log.warn(`recallKnowledge failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ─── Action: poll_team ────────────────────────────────────────────

  private async actPollTeam(
    _goalId: string,
    action: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.agentAbjectId) return { success: false, error: 'AgentAbject unavailable' };
    const requestedMembers = action.members as string[] | undefined;
    const question = (action.question as string | undefined) ?? this.defaultPollQuestion();

    const team = await this.request<Array<{ agentId: AbjectId; name: string; description: string }>>(
      request(this.id, this.agentAbjectId, 'listAgents', {}),
    );
    const eligible = team.filter(a => a.name !== 'Chat' && a.name !== 'ScrumMaster');
    const targets = requestedMembers && requestedMembers.length > 0
      ? eligible.filter(a => requestedMembers.includes(a.name))
      : eligible;

    if (targets.length === 0) {
      return { success: true, data: { contributions: [], note: 'No matching team members to poll' } };
    }

    log.info(`poll_team: asking ${targets.length} member(s): ${targets.map(t => t.name).join(', ')}`);
    const results = await Promise.all(
      targets.map(async (member) => {
        try {
          const response = await this.request<string>(
            request(this.id, member.agentId, 'ask', { question }),
            45000,
          );
          const text = (typeof response === 'string' ? response : String(response)).trim();
          if (!text || /^PASS\b/i.test(text)) return null;
          return { agentName: member.name, text };
        } catch (err) {
          log.warn(`poll_team: ${member.name} ask failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );
    const contributions = results.filter((c): c is TeamContribution => c !== null);
    log.info(`poll_team: ${contributions.length} contribution(s) gathered`);
    return { success: true, data: { contributions } };
  }

  private defaultPollQuestion(): string {
    return `Two-part question.

(1) **What can you do for this goal?** Briefly summarize the specific tools, skills, or capabilities you have RIGHT NOW that match this goal — list real tools/skills/MCP servers you can call, not generic role descriptions. If your capabilities are runtime-configurable (installed skills, connected MCP servers, registered objects you can call), enumerate the relevant ones with one-line descriptions of what each does.

(2) **What single concrete task would you contribute next?** 1-3 sentences naming the task and how you'd accomplish it (which tool/skill/method).

Reply PASS if you have no capability that fits the goal. The ScrumMaster uses your reply to decide which agent gets assigned — under-selling yourself or omitting current capabilities means the wrong agent gets picked.`;
  }

  // ─── Action: add_task (stage only) ────────────────────────────────

  private async actAddTask(
    otaTaskId: string,
    goalId: string,
    action: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.agentAbjectId) return { success: false, error: 'AgentAbject unavailable' };

    const description = action.description as string | undefined;
    const assignedAgentName = action.assignedAgentName as string | undefined;
    const dependsOnIdx = (action.dependsOn as number[] | undefined);
    const produces = action.produces as Array<{ key: string; description: string }> | undefined;
    const consumes = action.consumes as string[] | undefined;

    if (!description || !assignedAgentName) {
      return { success: false, error: 'add_task requires description and assignedAgentName' };
    }

    // Resolve agent at stage time so the LLM gets immediate feedback on bad names.
    const team = await this.request<Array<{ agentId: AbjectId; name: string }>>(
      request(this.id, this.agentAbjectId, 'listAgents', {}),
    );
    const agent = team.find(a => a.name === assignedAgentName && a.name !== 'ScrumMaster' && a.name !== 'Chat');
    if (!agent) {
      const validNames = team.filter(a => a.name !== 'ScrumMaster' && a.name !== 'Chat').map(a => a.name).join(', ');
      return { success: false, error: `Unknown agent "${assignedAgentName}". Valid: ${validNames}` };
    }

    let inflight = this.scrumInFlight.get(otaTaskId);
    if (!inflight) {
      inflight = { goalId, staged: [] };
      this.scrumInFlight.set(otaTaskId, inflight);
    }

    // Validate dependsOn indices at stage time.
    let resolvedDeps: number[];
    if (Array.isArray(dependsOnIdx)) {
      const invalid = dependsOnIdx.filter(idx => idx < 0 || idx >= inflight!.staged.length);
      if (invalid.length > 0) {
        return { success: false, error: `Invalid dependsOn indices ${invalid.join(',')} — current staged batch has ${inflight.staged.length} task(s) (valid range 0..${inflight.staged.length - 1})` };
      }
      resolvedDeps = dependsOnIdx;
    } else if (inflight.staged.length > 0) {
      // Default sequential — wait on the previous staged task.
      resolvedDeps = [inflight.staged.length - 1];
    } else {
      resolvedDeps = [];
    }

    inflight.staged.push({
      description,
      assignedAgentName,
      assignedAgentId: agent.agentId,
      dependsOnIdx: resolvedDeps,
      produces,
      consumes,
    });

    log.info(`add_task (staged): "${description.slice(0, 60)}" → ${assignedAgentName} (deps: ${resolvedDeps.length === 0 ? 'none' : resolvedDeps.join(',')}); ${inflight.staged.length} staged total`);
    return {
      success: true,
      data: {
        position: inflight.staged.length - 1,
        stagedCount: inflight.staged.length,
        deps: resolvedDeps,
        note: 'Task is staged but NOT yet committed. Call dispatch_scrum to commit and enqueue, or add more tasks first.',
      },
    };
  }

  // ─── Terminal commit: complete_goal ───────────────────────────────

  private async commitCompleteGoal(
    goalId: string,
    lastAction: Record<string, unknown>,
  ): Promise<void> {
    if (!this.goalManagerId) return;
    const inlineSynthesis = (lastAction.synthesis as string | undefined)?.trim();
    const hint = (lastAction.hint as string | undefined)?.trim();

    // Two paths:
    //   1. LLM provided a non-trivial synthesis directly → use it. The LLM has
    //      already paid the smart-tier cost to generate it; reusing is free.
    //   2. LLM omitted synthesis (or supplied a hint instead) → auto-synthesize
    //      via a FAST-TIER LLM call from goal description + scratchpad. This
    //      is much cheaper than burning smart-tier tokens on what is mostly
    //      markdown formatting — the prior call only had to decide "I'm done"
    //      and could leave the formatting to a cheap follow-up.
    let synthesis: string;
    if (inlineSynthesis && inlineSynthesis.length > 0) {
      synthesis = inlineSynthesis;
    } else {
      synthesis = await this.synthesizeCompletionText(goalId, hint).catch((err) => {
        log.warn(`auto-synthesis failed for ${goalId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        return 'Sprint complete.';
      });
    }

    log.info(`complete_goal: ${goalId.slice(0, 8)} → DONE (${synthesis.slice(0, 80)})`);
    await this.request(
      request(this.id, this.goalManagerId, 'completeGoal', { goalId, result: synthesis }),
    );
    this.changed('sprintCompleted', { goalId });
  }

  /**
   * Generate a self-contained user-facing markdown answer from the goal
   * description + scratchpad via a fast-tier LLM call. Used when complete_goal
   * is emitted without an inline `synthesis` field — the smart-tier think
   * call only needs to decide "we're done"; the haiku-tier call here handles
   * the formatting. Typical speedup: 10–15s on haiku vs 60s+ on opus for the
   * same output.
   */
  private async synthesizeCompletionText(goalId: string, hint?: string): Promise<string> {
    if (!this.llmId || !this.goalManagerId) {
      return hint && hint.length > 0 ? hint : 'Sprint complete.';
    }

    const goal = await this.request<{
      title: string; description: string; scratchpad?: Record<string, unknown>;
    } | null>(
      request(this.id, this.goalManagerId, 'getGoal', { goalId }),
    ).catch(() => null);
    if (!goal) {
      return hint && hint.length > 0 ? hint : 'Sprint complete.';
    }

    const scratchpad = goal.scratchpad ?? {};
    const scratchpadKeys = Object.keys(scratchpad);
    const scratchpadBlock = scratchpadKeys.length > 0
      ? scratchpadKeys.map((k) => `### ${k}\n${safeStringify(scratchpad[k], 8000)}`).join('\n\n')
      : '(empty)';

    const hintBlock = hint && hint.length > 0
      ? `\n\nFraming hint from the planner: ${hint}`
      : '';

    const prompt = `Synthesize a complete, self-contained final answer for the user.

Goal: "${goal.title}"

User's intent:
${goal.description}

Scratchpad (results from completed tasks — this is the data your answer must inline):
${scratchpadBlock}${hintBlock}

Rules:
- The user only sees this text. They do not see the scratchpad, task list, or any internal artifacts.
- INLINE the actual data from the scratchpad. Lists, tables, full content, all of it. Do not say "see above" or reference internal artifacts.
- Markdown formatting is fine and encouraged.
- If the scratchpad is empty or the goal couldn't be resolved, say so plainly.
- Do not include action JSON or any meta-commentary about the scrum process.
- Output the answer directly — no preamble like "Here is the result:".`;

    try {
      const result = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: [{ role: 'user', content: prompt }],
          // 16384 matches the smart-tier think call's budget so a synthesis
          // that enumerates many scratchpad items (long email digests,
          // multi-section reports, large search results) doesn't get clipped
          // mid-list. Haiku is tight — it won't pad to fill the budget — so
          // raising the cap costs nothing on typical short syntheses.
          options: { tier: 'fast', maxTokens: 16384 },
        }),
        120000,
      );
      const text = (result.content ?? '').trim();
      return text.length > 0
        ? text
        : (hint && hint.length > 0 ? hint : 'Sprint complete.');
    } catch (err) {
      log.warn(`synthesizeCompletionText LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
      return hint && hint.length > 0 ? hint : 'Sprint complete.';
    }
  }

  // ─── Terminal commit: fail_goal ───────────────────────────────────

  private async commitFailGoal(
    goalId: string,
    lastAction: Record<string, unknown>,
  ): Promise<void> {
    if (!this.goalManagerId) return;
    const reason = (lastAction.reason as string | undefined) ?? 'Sprint declared unreachable';

    log.info(`fail_goal: ${goalId.slice(0, 8)} → FAILED (${reason.slice(0, 80)})`);
    await this.request(
      request(this.id, this.goalManagerId, 'failGoal', { goalId, error: reason }),
    ).catch(() => { /* best effort */ });
  }

  // ─── Action: save_knowledge ───────────────────────────────────────

  /**
   * Persist a lesson to KnowledgeBase. Use this BEFORE complete_goal on a
   * successful sprint so future scrums can skip rediscovery: record which
   * Abject + method handled a particular kind of goal, the constraint or
   * permission that mattered, etc. Future review_scrum auto-recalls
   * against the goal description and surfaces the lesson, letting the
   * planner reuse it directly without re-asking the team or Registry.
   */
  private async actSaveKnowledge(
    action: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const kbId = await this.getKnowledgeBaseId();
    if (!kbId) return { success: false, error: 'KnowledgeBase not registered in this workspace' };
    const title = action.title as string | undefined;
    const content = action.content as string | undefined;
    const type = (action.type as string | undefined) ?? 'learned';
    const tags = (action.tags as string[] | undefined) ?? [];
    if (!title || !content) {
      return { success: false, error: 'save_knowledge requires title and content' };
    }
    const result = await this.request<{ id?: string; title?: string }>(
      request(this.id, kbId, 'remember', { title, content, type, tags }),
      5000,
    );
    log.info(`save_knowledge: "${title.slice(0, 60)}" (id=${(result.id ?? '?').slice(0, 8)}, type=${type}, tags=[${tags.join(',')}])`);
    return { success: true, data: { id: result.id, title: result.title } };
  }

  // ─── Action: lookup_knowledge ─────────────────────────────────────

  /**
   * Search KnowledgeBase. review_scrum already auto-recalls against the
   * goal description, so most cases are covered passively. Use this when
   * you need a more targeted query (e.g. "previous patterns for tool
   * permission errors") that the goal description wouldn't surface.
   */
  private async actLookupKnowledge(
    action: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const kbId = await this.getKnowledgeBaseId();
    if (!kbId) return { success: false, error: 'KnowledgeBase not registered in this workspace' };
    const query = action.query as string | undefined;
    const type = action.type as string | undefined;
    const tags = action.tags as string[] | undefined;
    const limit = (action.limit as number | undefined) ?? 5;
    if (!query) return { success: false, error: 'lookup_knowledge requires a query string' };
    const entries = await this.request<Array<{ id: string; title: string; type: string; tags?: string[]; content: string }>>(
      request(this.id, kbId, 'recall', { query, type, tags, limit }),
      5000,
    ).catch(() => []);
    log.info(`lookup_knowledge: "${query.slice(0, 60)}" → ${entries.length} entries`);
    return { success: true, data: { entries } };
  }

  // ─── Action: forget_knowledge ─────────────────────────────────────

  /**
   * Delete a KnowledgeBase entry that's no longer accurate. Get the entry
   * `id` from review_scrum's `relevantKnowledge` block or from a
   * lookup_knowledge result. Use when:
   *   - The recorded fact is contradicted by the current scrum's findings
   *   - A captured "lesson" turned out to be wrong or context-specific
   *   - A user-related fact has changed (renamed, moved, switched provider)
   * Prefer save_knowledge for replacements: forget the old, save the new.
   */
  private async actForgetKnowledge(
    action: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const kbId = await this.getKnowledgeBaseId();
    if (!kbId) return { success: false, error: 'KnowledgeBase not registered in this workspace' };
    const id = action.id as string | undefined;
    if (!id) return { success: false, error: 'forget_knowledge requires id (from a prior recall or save result)' };
    const result = await this.request<{ success: boolean }>(
      request(this.id, kbId, 'forget', { id }),
      5000,
    ).catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }) as { success: boolean });
    log.info(`forget_knowledge: id=${id.slice(0, 8)} success=${result.success}`);
    return result.success
      ? { success: true, data: { id, forgotten: true } }
      : { success: false, error: `forget failed: no entry with id ${id} (already removed?)` };
  }

  // ─── Terminal commit: dispatch_scrum ──────────────────────────────

  /**
   * Commit the staged batch:
   *   1. Reserve the next scrum number via startNextScrum.
   *   2. addTask each staged item into TupleSpace (with dependsOn → resolved
   *      taskIds + assignedAgentId + scrumNumber).
   *   3. Register dependents in pendingDeps BEFORE any enqueue (race-free).
   *   4. Enqueue dependency-free tasks.
   *
   * If staged is empty, log a warning — the LLM should have used
   * complete_goal or fail_goal instead. The OTA loop already terminated;
   * we can't surface the error back to it, but the goal will eventually
   * stall and GoalObserver's staleness backstop handles it.
   */
  private async commitDispatchScrum(otaTaskId: string, goalId: string): Promise<void> {
    if (!this.goalManagerId || !this.agentAbjectId) return;

    const inflight = this.scrumInFlight.get(otaTaskId);
    if (!inflight || inflight.staged.length === 0) {
      // No staged tasks — the LLM likely got into a confused state (e.g.
      // its add_task action errored and it gave up, or it called
      // dispatch_scrum without any preceding add_task). Fail the goal
      // explicitly rather than leaving it dangling for the staleness
      // backstop. The chat sees a clear error within seconds instead of
      // waiting 30 minutes for nothing.
      log.warn(`dispatch_scrum committed with no staged tasks for goal ${goalId.slice(0, 8)} — failing the goal`);
      await this.request(
        request(this.id, this.goalManagerId, 'failGoal', {
          goalId,
          error: 'ScrumMaster called dispatch_scrum with no staged tasks. The scrum cycle ended without committing any work — the LLM likely could not determine a valid action.',
        }),
      ).catch(() => { /* best effort */ });
      return;
    }

    const { scrumNumber } = await this.request<{ scrumNumber: number }>(
      request(this.id, this.goalManagerId, 'startNextScrum', { goalId }),
    );

    // Phase 1: addTask for everything.
    const taskIds: string[] = [];
    const blockerSets: string[][] = [];

    for (const s of inflight.staged) {
      const depIds = s.dependsOnIdx.map(idx => taskIds[idx]);
      const addResult = await this.request<{ taskId?: string; error?: string }>(
        request(this.id, this.goalManagerId, 'addTask', {
          goalId,
          description: s.description,
          dependsOn: depIds.length > 0 ? depIds : undefined,
          produces: s.produces,
          consumes: s.consumes,
          assignedAgentId: s.assignedAgentId,
          scrumNumber,
        }),
      );
      if (!addResult.taskId) {
        log.warn(`addTask failed for staged task: ${addResult.error ?? 'unknown'} — partial commit may stall sprint`);
        continue;
      }
      taskIds.push(addResult.taskId);
      blockerSets.push(depIds);
    }

    // Phase 2: register blocked tasks BEFORE any enqueue (race-free).
    for (let i = 0; i < taskIds.length; i++) {
      if (blockerSets[i].length > 0) {
        this.pendingDeps.set(taskIds[i], {
          goalId,
          agentId: inflight.staged[i].assignedAgentId,
          description: inflight.staged[i].description,
          blockers: new Set(blockerSets[i]),
        });
        log.info(`dispatch: task ${taskIds[i].slice(0, 8)} deferred on ${blockerSets[i].length} dep(s): ${blockerSets[i].map(d => d.slice(0, 8)).join(', ')}`);
      }
    }

    // Phase 3: enqueue dependency-free tasks.
    for (let i = 0; i < taskIds.length; i++) {
      if (blockerSets[i].length === 0) {
        await this.request(
          request(this.id, this.agentAbjectId, 'enqueueTask', {
            agentId: inflight.staged[i].assignedAgentId,
            task: inflight.staged[i].description,
            taskId: taskIds[i],
            goalId,
            dispatchTupleId: taskIds[i],
          }),
        );
      }
    }

    log.info(`dispatch_scrum: round ${scrumNumber} of goal ${goalId.slice(0, 8)} → ${taskIds.length} task(s) committed`);
    this.changed('scrumPlanned', { goalId, scrumNumber, tasksPlanned: taskIds.length });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Dependency machinery
  // ═══════════════════════════════════════════════════════════════════

  private async unblockDependents(completedTaskId: string): Promise<void> {
    if (!this.agentAbjectId) return;
    const newlyReady: Array<{ taskId: string; goalId: string; agentId: AbjectId; description: string }> = [];
    for (const [pendingId, info] of this.pendingDeps) {
      if (!info.blockers.has(completedTaskId)) continue;
      info.blockers.delete(completedTaskId);
      if (info.blockers.size === 0) {
        this.pendingDeps.delete(pendingId);
        newlyReady.push({ taskId: pendingId, goalId: info.goalId, agentId: info.agentId, description: info.description });
      }
    }
    for (const t of newlyReady) {
      log.info(`Dep satisfied: enqueuing task ${t.taskId.slice(0, 8)} on agent ${t.agentId.slice(0, 8)} (was waiting on ${completedTaskId.slice(0, 8)})`);
      await this.request(
        request(this.id, this.agentAbjectId!, 'enqueueTask', {
          agentId: t.agentId,
          task: t.description,
          taskId: t.taskId,
          goalId: t.goalId,
          dispatchTupleId: t.taskId,
        }),
      ).catch(err => log.warn(`enqueueTask(${t.taskId.slice(0, 8)}) failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async cascadeFailDependents(failedTaskId: string): Promise<void> {
    if (!this.goalManagerId) return;
    const cascading: Array<{ taskId: string; goalId: string }> = [];
    for (const [pendingId, info] of this.pendingDeps) {
      if (!info.blockers.has(failedTaskId)) continue;
      this.pendingDeps.delete(pendingId);
      cascading.push({ taskId: pendingId, goalId: info.goalId });
    }
    for (const t of cascading) {
      log.info(`Cascade-fail: task ${t.taskId.slice(0, 8)} (upstream ${failedTaskId.slice(0, 8)} failed)`);
      await this.request(
        request(this.id, this.goalManagerId!, 'failTask', {
          taskId: t.taskId,
          goalId: t.goalId,
          error: `Upstream task ${failedTaskId.slice(0, 8)} permanently failed; this task's consumes contract cannot be satisfied`,
          agentName: 'ScrumMaster',
        }),
      ).catch(err => log.warn(`cascade failTask(${t.taskId.slice(0, 8)}) failed: ${err instanceof Error ? err.message : String(err)}`));
      await this.cascadeFailDependents(t.taskId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt — teaches the LLM the action vocabulary
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(): string {
    return `You are the ScrumMaster. Each task in your queue is one scrum meeting for a goal. Your job is to look at the goal's state and decide ONE of:

1. The sprint is **done** — call \`complete_goal({ synthesis })\` with a complete, self-contained final answer for the user.
2. The sprint needs more work — call \`add_task\` (one or more times to stage), then \`dispatch_scrum\` to commit.
3. The sprint is unreachable — call \`fail_goal({ reason })\`.

## Mandatory first action

Your FIRST action every scrum is \`review_scrum\` (no parameters). It returns the goal description, completed tasks (with the scratchpad keys they wrote), failed tasks (with errors), the full scratchpad, and the team roster. **Do not skip this.** You must look at state before deciding.

## Action vocabulary

### \`review_scrum\` — MANDATORY first action
No parameters. Returns:
\`\`\`json
{
  "goal": { "title", "description", "currentScrumNumber", "status" },
  "completed": [{ "description", "producesKeys", "assignedAgentId" }, ...],
  "failed": [{ "description", "error", "assignedAgentId" }, ...],
  "scratchpad": { "key": "value", ... },
  "teamNames": ["<AgentName>", "<AgentName>", ...],
  "relevantKnowledge": [{ "id", "title", "type", "tags", "content" }, ...]
}
\`\`\`

\`teamNames\` is just a list of valid agent names you can pass to \`add_task\`'s \`assignedAgentName\` field — the names ALONE do not tell you what each agent can do. To learn capabilities, call \`poll_team\` (which uses the ask protocol — every agent's reply describes its current tools, skills, and MCP servers). Static manifest descriptions are not exposed here because they're stale for any agent whose capabilities are configurable at runtime.

The \`relevantKnowledge\` array holds prior lessons retrieved from KnowledgeBase via full-text search against the goal description. **Read it carefully** — past sprints may have already discovered the right Abject, tool, or approach for this kind of goal. If a cached entry already names the right agent + method for what the user is asking, plan tasks that use that mapping directly instead of polling the team again. Each entry's \`id\` lets you call \`forget_knowledge\` if the entry turns out to be wrong.

### \`poll_team({ members?: string[], question?: string })\`
Asks selected team members via the ask protocol. **This is how you learn what each agent can actually do** — the default question asks each agent to enumerate its current tools/skills/MCP capabilities AND propose a concrete task. Use whenever:

- The goal needs work AND \`relevantKnowledge\` doesn't already tell you which agent has the right capability.
- You're tempted to guess based on agent name alone — agent names alone do not tell you whether the relevant capability is currently installed and connected. Many agents have runtime-configurable capabilities (skills, connected services, registered Abjects they can call). Polling is the way to find out what each can actually do RIGHT NOW.

Restrict via \`members\` when you can narrow the candidate set to a couple of plausible names from \`teamNames\`. Polling all agents in parallel is a few seconds slower than polling 2-3.

**When to skip the poll**:
- The goal is satisfied — go straight to \`complete_goal\`.
- \`relevantKnowledge\` already names the right agent and tool — skip to \`add_task\`.
- The goal is unreachable — go straight to \`fail_goal\`.

Returns \`{ contributions: [{ agentName, text }, ...] }\`. Each \`text\` is the agent's full reply naming its capabilities and proposed contribution. PASS / empty replies are filtered out.

### \`add_task({ description, assignedAgentName, dependsOn?, produces?, consumes? })\` — STAGE only
Append one task to the current scrum's plan. **This does NOT commit** — it stages the task locally. Call \`dispatch_scrum\` to commit and enqueue all staged tasks at once, or call \`complete_goal\` to abandon them.

- \`description\`: 1-3 sentences. Concrete, atomic, runnable end-to-end through one agent's loop.
- \`assignedAgentName\`: must match a name in the team roster (from \`review_scrum\`).
- \`dependsOn\`: array of indices into THIS scrum's prior add_task calls (0-indexed). Omit for default sequential (each task waits on the previous). Pass \`[]\` for parallel-eligible.
- \`produces\`: \`[{ key, description }, ...]\` — scratchpad keys this task will write.
- \`consumes\`: \`["key", ...]\` — scratchpad keys this task expects to read (auto-injected into the agent's context).

Returns \`{ position, stagedCount, deps }\`. Multiple add_task calls accumulate.

### \`complete_goal({ hint?, synthesis? })\` — TERMINAL success
Mark the goal completed.

**Prefer the fast path.** Most of the time you should omit \`synthesis\` and just emit \`{ "action": "complete_goal" }\` (or include a one-sentence \`hint\` that biases the framing). ScrumMaster auto-synthesizes the user-facing markdown from the goal description + scratchpad on the FAST tier (haiku). That's typically 5–10s on haiku vs 60s+ if you generate the synthesis yourself on smart tier — a major speedup since you've already done the hard reasoning.

When to OMIT synthesis (the default):
- The scratchpad already contains the data the user needs to see (most goals end this way)
- The framing is straightforward: "here are the results" / "task complete"

When to INCLUDE synthesis inline:
- You have insight beyond the scratchpad that the auto-synthesizer wouldn't see (e.g., a key takeaway from a poll_team contribution that didn't land in any scratchpad key)
- The user asked a question the data alone doesn't answer cleanly
- The synthesis is short (1–2 sentences) and you've already composed it during your reasoning

Either way, the synthesis (whether yours or auto-generated) is the user's ONLY view. Inline data from scratchpad. Don't say "see above" — there is no above.

Calling \`complete_goal\` after \`add_task\` cleanly abandons the staged batch (nothing was committed yet).

### \`fail_goal({ reason })\` — TERMINAL error
Declare the goal unreachable. Use when no team member can contribute and replanning won't help.

### \`dispatch_scrum\` — TERMINAL success
Commit the currently-staged batch: addTask each into TupleSpace, enqueue dep-free tasks immediately, defer dependents until upstream completes. Required after one or more \`add_task\` calls. Errors if staged is empty.

### \`save_knowledge({ title, content, type?, tags? })\`
Persist a lesson to KnowledgeBase. Future scrums' \`review_scrum\` will surface it via auto-recall. Use this to bank rediscovery work so the team doesn't repeat slow Registry walks every time. Good candidates:

- **Goal-shape → agent/method mappings**: which agent ended up handling a class of goal, and which method or tool of theirs did the work
- **Pattern lessons**: when one approach beats another for a particular goal shape, with the reason
- **User-identity facts learned during a sprint**: identifiers, addresses, account names confirmed by an actual successful task
- **Constraints discovered**: a permission, dependency, or precondition that mattered

The point is the lesson should be reusable on the NEXT goal of the same shape. Always describe the lesson in terms of capability/goal-shape, never as a context-free name dump.

Don't save:
- The synthesis itself (the user already saw it via complete_goal)
- Task-specific details (those belong in goal scratchpad)
- One-off observations unlikely to recur

\`type\`: 'fact' (durable truth), 'learned' (lesson from outcome), 'insight' (analysis), 'reference' (pointer). Defaults to 'learned'.
\`tags\`: short keywords for filterable retrieval — pick whatever describes the goal domain (the topic the lesson is about) plus the agent/method involved.

Best timing: just BEFORE \`complete_goal\` on a successful sprint, when you know the lesson actually worked end-to-end.

Returns \`{ id, title }\`.

### \`lookup_knowledge({ query, type?, tags?, limit? })\`
Search KnowledgeBase. \`review_scrum\` already auto-recalls against the goal description, so most cases are covered passively. Use this for targeted queries the goal description wouldn't surface — e.g. cross-cutting patterns like "previous tool-permission errors", "common failure modes for external API tasks", or specific topic recalls when the goal description is too generic.

Returns \`{ entries: [{ id, title, type, tags, content }, ...] }\`.

### \`forget_knowledge({ id })\`
Delete a KnowledgeBase entry that's no longer accurate. Pull \`id\` from \`relevantKnowledge\` (in \`review_scrum\`) or a \`lookup_knowledge\` result. Use when:

- The recorded fact contradicts the current scrum's findings (the cached entry names a wrong agent or method that no longer works)
- A captured "lesson" turned out to be too narrow / context-specific
- A user fact has changed (renamed, switched provider, moved)

For replacements, forget the old entry then save the new one.

Returns \`{ id, forgotten: true }\` on success.

## Decision flow

**First scrum (currentScrumNumber=0):**
1. \`review_scrum\` to read goal description, team names, and any relevant cached knowledge.
2. Decide: do I already know which agent has the right capability?
   - **YES** (cached lesson in \`relevantKnowledge\` names the agent + tool, or the goal is so generic any agent fits) → \`add_task\` directly, then \`dispatch_scrum\`.
   - **NO** → \`poll_team\` (often restricted via \`members\` to plausible candidates) to learn current capabilities. Read each contribution: which agent reported owning the relevant tool/skill/MCP? \`add_task\` to that agent, then \`dispatch_scrum\`. Save what you learned via \`save_knowledge\` before \`complete_goal\` later so the next sprint skips the poll.

Do NOT guess based on agent name alone. The relevant capability may or may not be installed/connected/registered for any given agent at this moment — agents with runtime-configurable capabilities only own a capability if their ask reply confirms it. The poll resolves the ambiguity.

**Subsequent scrum (currentScrumNumber>0):**
1. \`review_scrum\` to see completed tasks, scratchpad, and \`relevantKnowledge\`.
2. Decide based on what you see:
   - User's intent satisfied → if you learned something durable (tool/provider mapping, pattern, user fact), call \`save_knowledge\` first, THEN \`complete_goal\` with a self-contained synthesis built from scratchpad data. **No team poll needed for review-only scrums.**
   - Failed tasks need correction → \`add_task\` with corrective work, possibly polling specific agents first if approach is unclear, then \`dispatch_scrum\`. If a cached \`relevantKnowledge\` entry led the prior round astray, \`forget_knowledge\` it before planning the corrective task.
   - Unreachable → \`fail_goal\`.

**Knowledge as memory across sprints:**
The whole point of \`save_knowledge\` / \`lookup_knowledge\` / \`forget_knowledge\` is to amortize discovery work. The first goal of any kind may need an exploratory team poll to find which agent owns the relevant capability. Once that's discovered and the goal completes successfully, save the lesson — describe the goal shape, the agent that handled it, and the method that did the work. Every future scrum on a similar goal surfaces the lesson in \`relevantKnowledge\` and the planner skips straight to \`add_task\` with the right assignment — no team poll. When the cached lesson stops being true (the agent renamed, a tool was removed, the user switched providers), \`forget_knowledge\` removes the bad entry so the planner re-discovers via a poll.

## Rules

- Output ONE action per cycle as JSON in a \`\`\`json\`\`\` block. Output ONLY the JSON block — no prose around it. Any one-sentence note belongs in the JSON's \`reasoning\` field.
- Always start with \`review_scrum\`. Never poll the team or plan tasks before reviewing.
- Don't poll the team if you can already decide from the scratchpad. Polling is expensive.
- Multiple \`add_task\` calls = multiple OTA cycles. Each call stages one task; \`dispatch_scrum\` commits the batch.
- Prefer 1-3 tasks per scrum unless work is naturally parallelizable.
- Synthesis in \`complete_goal\` MUST be self-contained text. Pull data from scratchpad and inline it. No "see above".
- All action fields go on the TOP LEVEL of the JSON object. Do NOT wrap them in a \`params\`, \`arguments\`, or \`input\` envelope. Correct: \`{ "action": "add_task", "description": "...", "assignedAgentName": "..." }\`. Wrong: \`{ "action": "add_task", "params": { "description": "..." } }\`.`;
  }
}

void event; // keep import live; reserved for future events
