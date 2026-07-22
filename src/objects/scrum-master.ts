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

/** Scratchpad key where a completed sprint's working plan is recorded on the goal. */
const SCRUM_PLAN_KEY = 'scrum/plan';

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
  /**
   * Optional concrete target object (UUID or registered name) when the task
   * operates on an existing Abject. Threaded to the agent's executeTask as
   * `data.target`. The assigned agent decides what to do with it (e.g.
   * ObjectCreator treats a known target as a modify loop and preloads its
   * source). Omit when unknown — the agent resolves the target itself.
   */
  target?: string;
}

function compactLine(value: unknown, max = 220): string {
  return safeStringify(value, max).replace(/\s+/g, ' ').trim();
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
   * Self-healing: retry bookkeeping for in-flight scrum tasks, keyed by the
   * OTA task id our enqueueTask call returned. A scrum task that dies
   * without making a decision (LLM provider outage, step-limit error) used
   * to deadlock the goal — the round's `goalReadyForCompletion` had already
   * been emitted and the idempotency guards blocked any re-run, so nothing
   * ever reviewed the round again. Now a failed scrum retries with backoff,
   * and after MAX_SCRUM_ATTEMPTS the goal fails with an instructive error
   * instead of hanging forever.
   */
  private scrumAttempts = new Map<string, { goalId: string; priorScrumNumber: number; attempt: number }>();
  /** Pending retry timers so onStop can cancel them. */
  private scrumRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private static readonly MAX_SCRUM_ATTEMPTS = 3;
  private static readonly SCRUM_RETRY_BASE_MS = 15_000;

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
    /** Concrete target object, threaded to executeTask when finally enqueued. */
    target?: string;
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
   * Fast path. A goal `quick_dispatch`ed straight to one agent — no planning
   * scrum. Keyed by goalId → the single task's id + agent. When the task's
   * `goalReadyForCompletion` arrives: success → complete the goal directly
   * (zero LLM); failure → fall into a normal review scrum that sees the
   * failure and replans. See commitQuickDispatch.
   */
  private oneShotGoals = new Map<string, { taskId: string; agentId: AbjectId }>();
  /**
   * Goals where `review_scrum` must NOT offer quick_dispatch again — set when
   * a quick_dispatch could not be committed (agent vanished mid-scrum or a
   * malformed action), so the fallback review plans normally instead of
   * re-offering the same doomed shortcut.
   */
  private forceFullScrum = new Set<string>();

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

  protected override async onStop(): Promise<void> {
    for (const timer of this.scrumRetryTimers) clearTimeout(timer);
    this.scrumRetryTimers.clear();
    await super.onStop();
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
        const { goalId, scrumNumber, doneTaskIds } = value as {
          goalId: string; scrumNumber: number; doneTaskIds?: string[];
        };
        // Fast path: a quick_dispatched goal's single task just finished.
        const oneShot = this.oneShotGoals.get(goalId);
        if (oneShot) {
          this.oneShotGoals.delete(goalId);
          if ((doneTaskIds ?? []).includes(oneShot.taskId)) {
            // Success → complete the goal directly, no review scrum.
            await this.completeOneShotGoal(goalId, oneShot.taskId).catch(err =>
              log.warn(`completeOneShotGoal(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
            );
            return;
          }
          // Failure → let the normal review scrum below see the failed task
          // (it re-reads task state) and plan a real recovery. Suppress a
          // repeat quick_dispatch offer so it doesn't retry the same shortcut.
          this.forceFullScrum.add(goalId);
        }
        await this.enqueueScrumTask(goalId, scrumNumber).catch(err =>
          log.warn(`enqueueScrumTask(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
        );
      } else if (aspect === 'goalCompleted' || aspect === 'goalFailed') {
        const { goalId } = value as { goalId: string };
        for (const [pendingId, info] of this.pendingDeps) {
          if (info.goalId === goalId) this.pendingDeps.delete(pendingId);
        }
        for (const [taskId, info] of this.scrumAttempts) {
          if (info.goalId === goalId) this.scrumAttempts.delete(taskId);
        }
        this.oneShotGoals.delete(goalId);
        this.forceFullScrum.delete(goalId);
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
                quick_dispatch: { type: 'success' },
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
        success?: boolean;
        error?: string;
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

      // Self-healing: a scrum task that died without a decision (provider
      // outage, unhandled step error) gets retried with backoff. This fires
      // exactly once per scrum-task death — the taskResult event — so a
      // slow-but-alive scrum can never be double-run.
      const attemptInfo = this.scrumAttempts.get(payload.ticketId);
      if (attemptInfo) {
        this.scrumAttempts.delete(payload.ticketId);
        if (payload.success === false) {
          this.scheduleScrumRetry(attemptInfo, payload.error);
        }
      }
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
   * Enqueue a scrum task on ourselves. Idempotent per (goalId, scrumNumber);
   * `attempt` > 1 marks a self-healing retry (the caller has already cleared
   * the round guard).
   */
  private async enqueueScrumTask(goalId: string, priorScrumNumber: number, attempt = 1): Promise<void> {
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

    log.info(`Enqueuing scrum task for goal ${goalId.slice(0, 8)} (after round ${priorScrumNumber}${attempt > 1 ? `, retry attempt ${attempt}` : ''})`);

    const { taskId } = await this.request<{ taskId: string }>(
      request(this.id, this.agentAbjectId, 'enqueueTask', {
        agentId: this.id,
        task: taskDesc,
        goalId,
      }),
    );
    this.scrumAttempts.set(taskId, { goalId, priorScrumNumber, attempt });
  }

  /**
   * Schedule a retry of a dead scrum with exponential backoff (15s, 30s,
   * 60s). After MAX_SCRUM_ATTEMPTS the goal fails with an instructive
   * error — a visible failure the user can act on beats a silent hang.
   */
  private scheduleScrumRetry(info: { goalId: string; priorScrumNumber: number; attempt: number }, error?: string): void {
    const { goalId, priorScrumNumber, attempt } = info;
    if (attempt >= ScrumMaster.MAX_SCRUM_ATTEMPTS) {
      log.warn(`Scrum for goal ${goalId.slice(0, 8)} round ${priorScrumNumber} failed ${attempt} times — failing the goal`);
      if (this.goalManagerId) {
        this.send(event(this.id, this.goalManagerId, 'failGoal', {
          goalId,
          error: `Scrum review failed ${attempt} times in a row (last error: ${(error ?? 'unknown').slice(0, 200)}). ` +
            `The goal cannot advance without a working scrum — this usually means the LLM provider is down or misconfigured. ` +
            `Fix the provider (Settings → AI) and re-ask.`,
        }));
      }
      return;
    }
    const delay = ScrumMaster.SCRUM_RETRY_BASE_MS * 2 ** (attempt - 1);
    log.info(`Scrum for goal ${goalId.slice(0, 8)} round ${priorScrumNumber} died (attempt ${attempt}: ${(error ?? 'unknown').slice(0, 120)}) — retrying in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(() => {
      this.scrumRetryTimers.delete(timer);
      void this.retryScrum(goalId, priorScrumNumber, attempt + 1);
    }, delay);
    this.scrumRetryTimers.add(timer);
  }

  /**
   * Re-run a dead scrum if the goal still wants one: active → clear the
   * round guard and enqueue; paused → check again later (user is
   * interjecting; the retry must not burn attempts against a paused goal);
   * terminal/gone → drop.
   */
  private async retryScrum(goalId: string, priorScrumNumber: number, attempt: number): Promise<void> {
    if (!this.goalManagerId) return;
    let status: string | undefined;
    try {
      const goal = await this.request<{ status?: string } | null>(
        request(this.id, this.goalManagerId, 'getGoal', { goalId }), 10000,
      );
      status = goal?.status;
    } catch { /* GoalManager unreachable — fall through to reschedule */ }

    if (status === 'paused' || status === undefined) {
      const timer = setTimeout(() => {
        this.scrumRetryTimers.delete(timer);
        void this.retryScrum(goalId, priorScrumNumber, attempt);
      }, 30_000);
      this.scrumRetryTimers.add(timer);
      return;
    }
    if (status !== 'active') return; // completed/failed/archived while we backed off

    this.scrummedRounds.delete(`${goalId}#${priorScrumNumber}`);
    await this.enqueueScrumTask(goalId, priorScrumNumber, attempt).catch(err =>
      log.warn(`scrum retry enqueue for ${goalId.slice(0, 8)} threw: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // OTA — observe
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Observation strings. The first observation (step 0) carries the full
   * goal-state snapshot (buildReviewSnapshot) so the first think decides
   * directly — collapsing the fast path to a single think and saving a think
   * on every scrum's opening round. Later steps just note loop position;
   * AgentAbject already injects goal context via `buildGoalProgressContext`.
   */
  private async handleObserve(msg: AbjectMessage): Promise<{ observation: string; tier?: string }> {
    const { taskId, step } = msg.payload as { taskId: string; step: number };
    if (step === 0) {
      // Deliver the goal-state snapshot up front so the first think decides
      // directly — no separate review_scrum round-trip. This collapses the
      // fast path to a single think (quick_dispatch) and saves a think on
      // every scrum's first round.
      const goalId = await this.lookupGoalIdForOTATask(taskId);
      const snap = goalId ? await this.buildReviewSnapshot(goalId) : { error: 'goal not resolved yet' };
      if ('data' in snap) {
        // Tier the first decision by trouble: a goal with failed tasks or a
        // loop warning needs the strongest reasoning to recover/replan; a
        // clean goal (quick_dispatch, straightforward plan, or completion
        // judgment) is well within balanced, and a misjudgment self-heals.
        const inTrouble = ((snap.data.failed as unknown[] | undefined)?.length ?? 0) > 0
          || snap.data.loopWarning !== undefined;
        return {
          tier: inTrouble ? 'smart' : 'balanced',
          observation:
            `Scrum for this goal. Its full state is below — you already have it, so decide your action directly (no need to call review_scrum first):\n\n` +
            `${JSON.stringify(snap.data, null, 2)}\n\n` +
            `Choose ONE action now: if \`quickDispatchAvailable\` is set and the goal is a single obvious step one \`team\` agent covers, \`quick_dispatch\`; otherwise \`poll_team\` to learn capabilities, \`add_task\`(+\`dispatch_scrum\`) to plan, \`complete_goal\` if already satisfied, or \`fail_goal\` if unreachable.`,
        };
      }
      // Snapshot unavailable (goal not resolvable yet) — fall back to the
      // explicit review action rather than guessing. Keep smart: we can't see
      // state to know it's safe to go lighter.
      return {
        tier: 'smart',
        observation: `Beginning scrum for OTA task ${taskId.slice(0, 8)}. Call review_scrum to load goal state, then decide: quick_dispatch, plan via add_task+dispatch_scrum, complete_goal, or fail_goal.`,
      };
    }
    // Step >= 1 within a scrum means the LLM is mid multi-step plan (e.g.
    // poll_team then add_task then dispatch) — the genuinely complex path —
    // so keep the strongest tier for the follow-through.
    return {
      tier: 'smart',
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
          return { success: false, error: `Unknown action "${action.action}". Valid intermediate: review_scrum, poll_team, add_task, save_knowledge, lookup_knowledge, forget_knowledge. Terminal: complete_goal, fail_goal, dispatch_scrum, quick_dispatch.` };
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
      case 'quick_dispatch':
        await this.commitQuickDispatch(goalId, normalized);
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
   * `review_scrum` action wrapper. The snapshot is now also delivered up
   * front in the first observation (see handleObserve), so the LLM rarely
   * needs to call this — it stays available as an explicit mid-scrum refresh.
   */
  private async actReviewScrum(
    goalId: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const snap = await this.buildReviewSnapshot(goalId);
    if ('error' in snap) return { success: false, error: snap.error };
    return { success: true, data: snap.data };
  }

  /**
   * Build the goal-state snapshot the scrum LLM decides from: title,
   * description, completed tasks, failed tasks (with errors), scratchpad,
   * team roster with capability summaries, quickDispatchAvailable, and
   * recalled knowledge + applicable patterns. Delivered in the opening
   * observation so the first think can act directly (no separate review
   * round-trip), and also returned by the review_scrum action for refreshes.
   */
  private async buildReviewSnapshot(
    goalId: string,
  ): Promise<{ data: Record<string, unknown> } | { error: string }> {
    if (!this.goalManagerId || !this.agentAbjectId) return { error: 'Dependencies unavailable' };

    const goal = await this.request<{
      title: string; description: string; status: string; currentScrumNumber: number;
      scratchpad?: Record<string, unknown>;
    } | null>(
      request(this.id, this.goalManagerId, 'getGoal', { goalId }),
    );
    if (!goal) return { error: 'Goal not found' };

    const allTasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
      request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }),
    ).catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>);
    const completed = allTasks.filter(t => t.fields.status === 'done');
    const failed = allTasks.filter(t => t.fields.status === 'permanently_failed');

    // Roster WITH descriptions. listAgents returns each agent's REGISTRATION
    // description, which is live: SkillAgent rebuilds it from its enabled
    // skills + connected MCP servers and re-registers on every change, so
    // this snapshot reflects current capabilities (unlike the static manifest
    // description). It is a coarse summary — enough to recognize an obvious
    // single-agent match for the quick_dispatch fast path — while `poll_team`
    // remains the deep, live capability probe for anything non-obvious.
    const team = await this.request<Array<{ agentId: AbjectId; name: string; description: string; canExecute?: boolean }>>(
      request(this.id, this.agentAbjectId, 'listAgents', {}),
    );
    const eligible = team.filter(a => a.canExecute !== false && a.name !== 'Chat' && a.name !== 'ScrumMaster');
    const teamRoster = eligible.map(a => ({ name: a.name, description: (a.description ?? '').slice(0, 300) }));

    // Offer quick_dispatch only on the very first look at a fresh goal (no
    // scrum round has planned or run anything yet) and only when this goal
    // hasn't already fallen back to full planning. After any task runs, the
    // goal is past the shortcut and plans normally.
    const quickDispatchAvailable =
      (goal.currentScrumNumber ?? 0) === 0
      && completed.length === 0
      && failed.length === 0
      && !this.forceFullScrum.has(goalId);

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
    // Alongside it, weave the pattern language: patterns whose contexts
    // match this goal (plus their linked patterns) shape task decomposition
    // and ordering. Pattern entries surface only through the weave.
    const [recalled, applicablePatterns] = await Promise.all([
      this.recallKnowledge(goal.description),
      this.weavePatterns(goal.description),
    ]);
    const relevantKnowledge = recalled.filter(e => e.type !== 'pattern');

    // Loop backstop: many rounds with accumulating failures is the signature of
    // retrying the same fix. Surface it deterministically so the planner weighs
    // fail_goal-with-diagnosis against yet another near-identical retry.
    const roundsSpent = goal.currentScrumNumber ?? 0;
    let loopWarning: string | undefined;
    if (roundsSpent >= 4) {
      loopWarning =
        `This goal has already run ${roundsSpent} scrum rounds and accumulated ${failed.length} failed task(s). ` +
        `If recent rounds kept dispatching the same kind of task against the same target and it keeps failing the same way ` +
        `(compare the failed[].error messages), another near-identical retry will not help — that is a loop. ` +
        `Either change strategy decisively, or fail_goal with a precise diagnosis (what recurs, what was tried, what would unblock it). ` +
        `A clear, actionable failure beats an endless "final attempt" loop.`;
    }

    return {
      data: {
        goal: {
          title: goal.title,
          description: goal.description,
          currentScrumNumber: goal.currentScrumNumber,
          status: goal.status,
        },
        ...(loopWarning ? { loopWarning } : {}),
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
        team: teamRoster,
        ...(quickDispatchAvailable ? { quickDispatchAvailable: true } : {}),
        relevantKnowledge,
        ...(applicablePatterns.length > 0 ? { applicablePatterns } : {}),
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

  /**
   * Weave the pattern language against a query: patterns whose contexts
   * match, plus the patterns their Links lines name. The planner reads
   * these to shape task decomposition and ordering.
   */
  private async weavePatterns(
    query: string,
    limit = 3,
  ): Promise<Array<{ id: string; title: string; content: string; via?: string }>> {
    const kbId = await this.getKnowledgeBaseId();
    if (!kbId) return [];
    try {
      const woven = await this.request<{ patterns?: Array<{ id: string; title: string; content: string; via?: string }> } | null>(
        request(this.id, kbId, 'weave', { query, limit }),
        5000,
      );
      if (!woven || !Array.isArray(woven.patterns)) return [];
      return woven.patterns.map(p => ({
        id: p.id,
        title: p.title,
        content: (p.content ?? '').slice(0, 3000),
        via: p.via,
      }));
    } catch (err) {
      log.warn(`weavePatterns failed: ${err instanceof Error ? err.message : String(err)}`);
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
    // Optional concrete target object (UUID or registered name) when the task
    // operates on an existing Abject. Threads through to the agent's
    // executeTask as `data.target`. Accept common aliases the LLM might emit.
    const target = (action.target ?? action.objectId ?? action.objectName) as string | undefined;

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
      target,
    });

    const targetNote = target ? ` →${target}` : '';
    log.info(`add_task (staged): "${description.slice(0, 60)}" → ${assignedAgentName}${targetNote} (deps: ${resolvedDeps.length === 0 ? 'none' : resolvedDeps.join(',')}); ${inflight.staged.length} staged total`);
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
    await this.recordCompletionPlan(goalId, synthesis).catch((err) => {
      log.warn(`recordCompletionPlan failed for ${goalId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.changed('sprintCompleted', { goalId });
  }

  /**
   * Record the raw execution record (what ran, who ran it, what failed) on
   * the goal's own scratchpad. It lives and dies with the goal, so it never
   * pollutes the shared KnowledgeBase. TaskReviewer reads it during the
   * post-goal review and distills recurring shapes into pattern entries;
   * ScrumMaster only records, the reviewer decides what it means.
   */
  private async recordCompletionPlan(goalId: string, synthesis: string): Promise<void> {
    if (!this.goalManagerId) return;

    const goal = await this.request<{
      title: string; description: string; scratchpad?: Record<string, unknown>;
    } | null>(
      request(this.id, this.goalManagerId, 'getGoal', { goalId }),
      5000,
    ).catch(() => null);
    if (!goal) return;

    const tasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
      request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }),
      5000,
    ).catch(() => [] as Array<{ id: string; fields: Record<string, unknown> }>);

    const completed = tasks.filter(t => t.fields.status === 'done');
    const failed = tasks.filter(t => t.fields.status === 'permanently_failed');
    if (completed.length === 0 && failed.length === 0) return;

    const agentNames = new Map<string, string>();
    if (this.agentAbjectId) {
      const team = await this.request<Array<{ agentId: AbjectId; name: string }>>(
        request(this.id, this.agentAbjectId, 'listAgents', {}),
        5000,
      ).catch(() => [] as Array<{ agentId: AbjectId; name: string }>);
      for (const member of team) agentNames.set(member.agentId, member.name);
    }

    const describeTask = (task: { id: string; fields: Record<string, unknown> }): string => {
      const agentId = task.fields.assignedAgentId as string | undefined;
      const agentName = agentId ? agentNames.get(agentId) ?? agentId.slice(0, 8) : 'unassigned';
      const description = compactLine(task.fields.description ?? '(no description)', 280);
      const produces = (task.fields.produces as Array<{ key?: string }> | undefined)
        ?.map(p => p.key)
        .filter((key): key is string => typeof key === 'string' && key.length > 0) ?? [];
      const consumes = (task.fields.consumes as string[] | undefined)
        ?.filter(key => typeof key === 'string' && key.length > 0) ?? [];
      const contracts: string[] = [];
      if (consumes.length > 0) contracts.push(`consumes ${consumes.join(', ')}`);
      if (produces.length > 0) contracts.push(`produces ${produces.join(', ')}`);
      return `- ${agentName}: ${description}${contracts.length > 0 ? ` (${contracts.join('; ')})` : ''}`;
    };

    const completedLines = completed.map(describeTask);
    const failedLines = failed.map(t => {
      const base = describeTask(t);
      const error = compactLine(t.fields.error ?? 'unknown failure', 240);
      return `${base} [failed: ${error}]`;
    });

    const scratchpadKeys = Object.keys(goal.scratchpad ?? {})
      .filter(k => k !== SCRUM_PLAN_KEY)
      .sort();
    const participatingAgents = [...new Set(completed
      .map(t => t.fields.assignedAgentId as string | undefined)
      .filter((id): id is string => Boolean(id))
      .map(id => agentNames.get(id) ?? id.slice(0, 8)))];

    const plan = [
      `Goal:\n${goal.description}`,
      participatingAgents.length > 0
        ? `Participating agents:\n${participatingAgents.join(', ')}`
        : 'Participating agents:\n(none)',
      completedLines.length > 0
        ? `Working plan:\n${completedLines.join('\n')}`
        : 'Working plan:\n(no completed worker tasks recorded)',
      failedLines.length > 0
        ? `Failures/replans:\n${failedLines.join('\n')}`
        : 'Failures/replans:\n(none recorded)',
      scratchpadKeys.length > 0
        ? `Scratchpad keys produced:\n${scratchpadKeys.map(k => `- ${k}`).join('\n')}`
        : 'Scratchpad keys produced:\n(none)',
      `Final answer excerpt:\n${synthesis.slice(0, 1800)}`,
    ].join('\n\n');

    await this.request(
      request(this.id, this.goalManagerId, 'writeGoalData', {
        goalId,
        key: SCRUM_PLAN_KEY,
        value: plan,
      }),
      5000,
    );
    log.info(`recordCompletionPlan: ${goalId.slice(0, 8)} → scratchpad["${SCRUM_PLAN_KEY}"]`);
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
- When the work created or modified objects, open with how the user reaches the result: a window they can open now, or — for objects with no visual surface — say plainly that nothing appears on screen and they use it by asking in chat; offer building a window as a natural next step.
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
    const type = (action.type as string | undefined) ?? 'fact';
    const tags = (action.tags as string[] | undefined) ?? [];
    if (!title || !content) {
      return { success: false, error: 'save_knowledge requires title and content' };
    }
    const result = await this.request<{ id?: string; title?: string }>(
      request(this.id, kbId, 'remember', { title, content, type, tags, origin: 'scrum' }),
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
  // ─── Fast path: quick_dispatch (single task, no planning scrum) ────

  /**
   * Commit a `quick_dispatch`: send ONE task straight to one agent and skip
   * the whole planning cycle (no poll_team / add_task / dispatch_scrum, and
   * no second review). The goal is marked one-shot; its single task's
   * `goalReadyForCompletion` completes the goal directly on success, or falls
   * into a normal review scrum on failure (see the changed handler).
   *
   * Validation is defensive: the LLM picked `agentName` from the roster
   * `review_scrum` just handed it, so a miss means the agent vanished in the
   * intervening seconds — rare. On any miss we re-run a normal scrum with the
   * quick_dispatch offer suppressed, so a bad shortcut degrades to planning
   * rather than dead-ending.
   */
  private async commitQuickDispatch(goalId: string, action: Record<string, unknown>): Promise<void> {
    if (!this.goalManagerId || !this.agentAbjectId) return;

    const agentName = action.agentName as string | undefined;
    const task = action.task as string | undefined;
    const target = (action.target ?? action.objectName ?? action.objectId) as string | undefined;

    if (!agentName || !task) {
      log.warn(`quick_dispatch missing agentName/task for goal ${goalId.slice(0, 8)} — falling back to full scrum`);
      await this.fallBackToFullScrum(goalId);
      return;
    }

    const team = await this.request<Array<{ agentId: AbjectId; name: string; canExecute?: boolean }>>(
      request(this.id, this.agentAbjectId, 'listAgents', {}),
    );
    const agent = team.find(a => a.name === agentName && a.canExecute !== false && a.name !== 'ScrumMaster' && a.name !== 'Chat');
    if (!agent) {
      log.warn(`quick_dispatch to unknown agent "${agentName}" for goal ${goalId.slice(0, 8)} — falling back to full scrum`);
      await this.fallBackToFullScrum(goalId);
      return;
    }

    const { scrumNumber } = await this.request<{ scrumNumber: number }>(
      request(this.id, this.goalManagerId, 'startNextScrum', { goalId }),
    );
    const taskId = await this.dispatchSingleTask(goalId, agent.agentId, task, scrumNumber, target);
    if (!taskId) {
      await this.fallBackToFullScrum(goalId);
      return;
    }

    this.oneShotGoals.set(goalId, { taskId, agentId: agent.agentId });
    const targetNote = target ? ` →${target}` : '';
    log.info(`quick_dispatch: goal ${goalId.slice(0, 8)} → single task to ${agentName}${targetNote} (no planning scrum)`);
    this.changed('scrumPlanned', { goalId, scrumNumber, tasksPlanned: 1 });
  }

  /**
   * addTask + enqueueTask for one directly-assigned task. The tuple carries
   * `dispatchTupleId`, so on termination AgentAbject reports back through
   * completeTask/failTask and the goal's `goalReadyForCompletion` fires — the
   * same accounting the normal dispatch path relies on.
   */
  private async dispatchSingleTask(
    goalId: string, agentId: AbjectId, description: string, scrumNumber: number, target?: string,
  ): Promise<string | undefined> {
    const addResult = await this.request<{ taskId?: string; error?: string }>(
      request(this.id, this.goalManagerId!, 'addTask', {
        goalId, description, assignedAgentId: agentId, scrumNumber,
      }),
    );
    if (!addResult.taskId) {
      log.warn(`dispatchSingleTask addTask failed for goal ${goalId.slice(0, 8)}: ${addResult.error ?? 'unknown'}`);
      return undefined;
    }
    await this.request(
      request(this.id, this.agentAbjectId!, 'enqueueTask', {
        agentId,
        task: description,
        taskId: addResult.taskId,
        goalId,
        dispatchTupleId: addResult.taskId,
        data: target ? { target } : undefined,
      }),
    );
    return addResult.taskId;
  }

  /** Complete a one-shot goal directly with its single task's result — no LLM. */
  private async completeOneShotGoal(goalId: string, taskId: string): Promise<void> {
    if (!this.goalManagerId) return;
    const goal = await this.request<{ scratchpad?: Record<string, unknown> } | null>(
      request(this.id, this.goalManagerId, 'getGoal', { goalId }),
    ).catch(() => null);
    // completeTask mirrors the agent's result to this scratchpad key; use it
    // verbatim as the goal result (the creator composes the user-facing reply).
    const result = goal?.scratchpad?.[`tasks/${taskId}/result`] ?? 'Done.';
    await this.request(request(this.id, this.goalManagerId, 'completeGoal', { goalId, result }));
    log.info(`quick_dispatch complete: goal ${goalId.slice(0, 8)} finished in one task (no planning scrum)`);
  }

  /**
   * Re-run a normal planning scrum for a goal whose quick_dispatch could not
   * commit. Clears the round-0 idempotency guard (the first scrum already
   * consumed it) and suppresses the quick_dispatch offer so the re-review
   * plans normally instead of looping on the same shortcut.
   */
  private async fallBackToFullScrum(goalId: string): Promise<void> {
    this.forceFullScrum.add(goalId);
    this.scrummedRounds.delete(`${goalId}#0`);
    await this.enqueueScrumTask(goalId, 0).catch(err =>
      log.warn(`fallBackToFullScrum(${goalId.slice(0, 8)}) threw: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

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
          target: inflight.staged[i].target,
        });
        log.info(`dispatch: task ${taskIds[i].slice(0, 8)} deferred on ${blockerSets[i].length} dep(s): ${blockerSets[i].map(d => d.slice(0, 8)).join(', ')}`);
      }
    }

    // Phase 3: enqueue dependency-free tasks.
    for (let i = 0; i < taskIds.length; i++) {
      if (blockerSets[i].length === 0) {
        const staged = inflight.staged[i];
        await this.request(
          request(this.id, this.agentAbjectId, 'enqueueTask', {
            agentId: staged.assignedAgentId,
            task: staged.description,
            taskId: taskIds[i],
            goalId,
            dispatchTupleId: taskIds[i],
            data: staged.target ? { target: staged.target } : undefined,
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
    const newlyReady: Array<{ taskId: string; goalId: string; agentId: AbjectId; description: string; target?: string }> = [];
    for (const [pendingId, info] of this.pendingDeps) {
      if (!info.blockers.has(completedTaskId)) continue;
      info.blockers.delete(completedTaskId);
      if (info.blockers.size === 0) {
        this.pendingDeps.delete(pendingId);
        newlyReady.push({ taskId: pendingId, goalId: info.goalId, agentId: info.agentId, description: info.description, target: info.target });
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
          data: t.target ? { target: t.target } : undefined,
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

## Your first action

The goal's full state is handed to you up front, in the opening observation — the goal description, completed tasks (with the scratchpad keys they wrote), failed tasks (with errors), the full scratchpad, the team roster with capability summaries, \`quickDispatchAvailable\`, and any relevant cached knowledge. Read it, then act directly. You do NOT need to call \`review_scrum\` first; it's available only as a mid-scrum refresh if you take an action and want to re-read state afterward.

## Action vocabulary

### \`review_scrum\` — optional state refresh
No parameters. Returns the same snapshot you were already given in the opening observation (goal, completed/failed tasks, scratchpad, team, quickDispatchAvailable, relevantKnowledge, applicablePatterns). You normally don't need it, since the snapshot is delivered up front; use it only to re-read state after taking an intermediate action. Shape:
\`\`\`json
{
  "goal": { "title", "description", "currentScrumNumber", "status" },
  "completed": [{ "description", "producesKeys", "assignedAgentId" }, ...],
  "failed": [{ "description", "error", "assignedAgentId" }, ...],
  "scratchpad": { "key": "value", ... },
  "team": [{ "name": "<AgentName>", "description": "<what it does>" }, ...],
  "quickDispatchAvailable": true,
  "relevantKnowledge": [{ "id", "title", "type", "tags", "content" }, ...],
  "applicablePatterns": [{ "id", "title", "content", "via" }, ...]
}
\`\`\`

\`team\` lists each agent with its live capability summary (kept current as skills and MCP servers come and go). The summaries are enough to recognize when one agent obviously owns a request; they are a coarse summary, not a full tool signature, so when the right agent isn't obvious from the descriptions — or you need to confirm a specific tool/skill/MCP is installed RIGHT NOW — call \`poll_team\`, which asks agents directly and returns their detailed live replies. Pass an agent's \`name\` to \`add_task\`'s \`assignedAgentName\` or to \`quick_dispatch\`.

\`quickDispatchAvailable\` appears only on the first look at a fresh goal. When it's present and the goal is a SINGLE concrete step that one agent's \`team\` description clearly covers, skip planning entirely and emit \`quick_dispatch\` (see below). When the goal needs multiple steps, coordination, verification, or the right agent isn't obvious, plan normally instead.

The \`relevantKnowledge\` array holds prior lessons retrieved from KnowledgeBase via full-text search against the goal description. **Read it carefully** — past sprints may have already discovered the right Abject, tool, or approach for this kind of goal. If a cached entry already names the right agent + method for what the user is asking, plan tasks that use that mapping directly instead of polling the team again. Each entry's \`id\` lets you call \`forget_knowledge\` if the entry turns out to be wrong.

\`applicablePatterns\` (present when the workspace's pattern language has matches) holds Alexander/Coplien-style patterns whose Context sections fit this goal, plus patterns they link to (\`via\` says how each arrived). A pattern is a proven shape for how this kind of goal gets done, its Forces resolved by its Therefore: its Therefore/Contract sections often dictate task decomposition and ordering directly (for example "fetch tasks first, then compute tasks, then presentation tasks"). When a pattern's context genuinely holds, plan the scrum's tasks to follow it and say so in the task descriptions so executing agents apply it too.

### \`poll_team({ members?: string[], question?: string })\`
Asks selected team members via the ask protocol. **This is how you learn what each agent can actually do** — the default question asks each agent to enumerate its current tools/skills/MCP capabilities AND propose a concrete task. Use whenever:

- The goal needs work AND \`relevantKnowledge\` doesn't already tell you which agent has the right capability.
- You're tempted to guess based on agent name alone — agent names alone do not tell you whether the relevant capability is currently installed and connected. Many agents have runtime-configurable capabilities (skills, connected services, registered Abjects they can call). Polling is the way to find out what each can actually do RIGHT NOW.

Restrict via \`members\` when you can narrow the candidate set to a couple of plausible names from \`team\`. Polling all agents in parallel is a few seconds slower than polling 2-3.

**When to skip the poll**:
- The goal is satisfied — go straight to \`complete_goal\`.
- \`relevantKnowledge\` already names the right agent and tool — skip to \`add_task\`.
- The goal is unreachable — go straight to \`fail_goal\`.

Returns \`{ contributions: [{ agentName, text }, ...] }\`. Each \`text\` is the agent's full reply naming its capabilities and proposed contribution. PASS / empty replies are filtered out.

### \`add_task({ description, assignedAgentName, target?, dependsOn?, produces?, consumes? })\` — STAGE only
Append one task to the current scrum's plan. **This does NOT commit** — it stages the task locally. Call \`dispatch_scrum\` to commit and enqueue all staged tasks at once, or call \`complete_goal\` to abandon them.

- \`description\`: 1-3 sentences. Concrete, atomic, runnable end-to-end through one agent's loop. **State the OUTCOME, not the implementation.** Describe what must be true when the task is done and let the agent discover how (it asks the live objects for current usage at build time). Do not embed step-by-step code prescriptions or a diagnosis of why a prior round failed — a wrong theory copied into the task description propagates the error into the next round. On a retry, describe the same outcome and, at most, which approach already failed so the agent picks a genuinely different one; never re-stage a task that prescribes the approach a prior round already proved wrong. **Carry the goal's key requirement phrases through VERBATIM** (quote them): a paraphrase softens the requirement into something weaker that an agent can satisfy with an imitation — "use 3D graphics" rewritten as "a 3D presentation" invites a flat perspective drawing; "delete the old entries" rewritten as "clean up" invites archiving. Outcome wording is yours; the requirement words stay the user's.
- \`assignedAgentName\`: must match a \`name\` in the \`team\` roster (from the goal state in your opening observation).
- \`target\`: OPTIONAL. The concrete object the task operates on, when the goal already names an existing Abject (e.g. "fix the GraphViewer window"). **Prefer the registered name (e.g. "GraphViewer") over a raw UUID** — AbjectIds are ephemeral and change every restart, so an id copied from an older goal or memory is often stale and won't resolve, whereas the name is durable. Pass it so the agent works on that object instead of guessing. The agent decides what to do with it — don't try to specify "create" vs "modify"; that's the agent's call. Omit when there's no known target.
- \`dependsOn\`: array of indices into THIS scrum's prior add_task calls (0-indexed). Omit for default sequential (each task waits on the previous). Pass \`[]\` for parallel-eligible.
- \`produces\`: \`[{ key, description }, ...]\` — scratchpad keys this task will write.
- \`consumes\`: \`["key", ...]\` — scratchpad keys this task expects to read (auto-injected into the agent's context).

Returns \`{ position, stagedCount, deps }\`. Multiple add_task calls accumulate.

### \`complete_goal({ hint?, synthesis? })\` — TERMINAL success
Mark the goal completed.

**Complete only when the goal's outcome durably holds.** A task's \`done\` is its own report, not proof the goal is achieved. When the latest round resolved the goal with a temporary or runtime-only workaround, left its result unverified, or recommended a durable follow-up, the goal is not finished — stage that follow-up via \`add_task\` + \`dispatch_scrum\` instead of completing here. Reserve \`complete_goal\` for when the user-visible outcome genuinely holds (and would survive a restart).

**Prefer the fast path.** Most of the time you should omit \`synthesis\` and just emit \`{ "action": "complete_goal" }\` (or include a one-sentence \`hint\` that biases the framing). ScrumMaster auto-synthesizes the user-facing markdown from the goal description + scratchpad on the FAST tier (haiku). That's typically 5–10s on haiku vs 60s+ if you generate the synthesis yourself on smart tier — a major speedup since you've already done the hard reasoning.

When to OMIT synthesis (the default):
- The scratchpad already contains the data the user needs to see (most goals end this way)
- The framing is straightforward: "here are the results" / "task complete"

When to INCLUDE synthesis inline:
- You have insight beyond the scratchpad that the auto-synthesizer wouldn't see (e.g., a key takeaway from a poll_team contribution that didn't land in any scratchpad key)
- The user asked a question the data alone doesn't answer cleanly
- The synthesis is short (1–2 sentences) and you've already composed it during your reasoning

Either way, the synthesis (whether yours or auto-generated) is the user's ONLY view. Inline data from scratchpad. Don't say "see above" — there is no above. And "deployed" is invisible to the user unless something appears on screen: when the round shipped objects without a window, make sure the synthesis says so plainly and points at the chat/message path for using them (a \`hint\` like "headless — usable via chat only, offer a window" is enough).

Calling \`complete_goal\` after \`add_task\` cleanly abandons the staged batch (nothing was committed yet).

### \`fail_goal({ reason })\` — TERMINAL error
Declare the goal unreachable. Use when no team member can contribute and replanning won't help.

**Also fail here to break a loop.** When the goal state carries a \`loopWarning\` (the goal has run several rounds with accumulating failures) and the recent rounds keep dispatching the same kind of task against the same target with the same failure, another retry will not help. Stop and \`fail_goal\` with a precise diagnosis: the recurring failure, what was already tried across rounds, and the concrete change that would unblock it (often a fix in platform code, or a capability the team genuinely lacks). A clear failure the user can act on beats an endless "final attempt" loop.

### \`quick_dispatch({ agentName, task, target? })\` — TERMINAL success (fast path)
Offered only when the goal state shows \`quickDispatchAvailable\`. Send ONE task straight to one agent and skip the entire planning cycle — no \`poll_team\`, no \`add_task\`, no \`dispatch_scrum\`, and no second review. On success the goal completes automatically with the agent's result; if the single task fails, a normal planning scrum picks it up with the failure in view, so a wrong guess costs only one attempt.

Use it when the request is a single concrete step that one agent's \`team\` description clearly covers — e.g. calling an existing object's method, one lookup, one navigation. Reach for the normal \`add_task\` + \`dispatch_scrum\` flow instead when the goal spans multiple steps, needs coordination or a verification round, or the right agent isn't obvious from the descriptions (poll first).

- \`agentName\`: a \`name\` from the \`team\` roster.
- \`task\`: the full, self-contained task description, written the same way an \`add_task\` description is (state the outcome; carry the user's requirement phrases through verbatim).
- \`target\`: OPTIONAL concrete object the task operates on (prefer a registered name over a UUID), same meaning as \`add_task\`'s \`target\`.

### \`dispatch_scrum\` — TERMINAL success
Commit the currently-staged batch: addTask each into TupleSpace, enqueue dep-free tasks immediately, defer dependents until upstream completes. Required after one or more \`add_task\` calls. Errors if staged is empty.

### \`save_knowledge({ title, content, type?, tags? })\`
Persist a genuinely reusable FACT to KnowledgeBase. The user browses these entries directly and future scrums auto-recall them in \`review_scrum\`, so each one should read like a standalone fact that holds on its own, not a log of this sprint.

Save facts you discovered while planning that will recur on unrelated future goals:

- A capability that was hard to locate: which kind of tool or method turned out to handle a class of work, when that was not obvious from a registry walk.
- A constraint that mattered: a permission, dependency, or precondition that was not apparent up front.
- A user-identity fact confirmed by a successful task: an address, account, or identifier.

Most sprints save nothing. When the work was routine or the team found what it needed quickly, skip it. Lessons, recurring shapes, and patterns are the post-goal reviewer's job: it reads this goal's execution record after completion and distills what generalizes into the pattern language. Your job here is facts only — the execution record you leave behind is its raw material.

Write the entry as the fact itself. The title states the takeaway (for example "Bulk inbox triage needs an agent that drives a real browser"), phrased so a reader who never saw this sprint understands it.

Skip:
- The synthesis the user already saw via \`complete_goal\`
- The working plan and task-specific details (those live on the goal scratchpad)
- One-off observations unlikely to recur
- Lessons about how the goal was approached (the reviewer distills those)

\`type\`: 'fact' (durable truth), 'insight' (analysis), 'reference' (pointer). Defaults to 'fact'.
\`tags\`: short keywords describing the topic plus any capability involved.

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

**First scrum (currentScrumNumber=0):** the goal state (description, \`team\` roster with capability summaries, cached knowledge) is already in your opening observation. Act directly:
1. **Is this a single step one agent obviously owns?** If \`quickDispatchAvailable\` is set and one \`team\` description clearly covers the whole request in one action (call a method on an existing object, one lookup, one navigation) → \`quick_dispatch({ agentName, task })\` and you're done. This is the common case for small requests; don't spin up a full sprint for them.
2. Otherwise decide: do I already know which agent has the right capability?
   - **YES** (cached lesson in \`relevantKnowledge\` names the agent + tool, or the goal is so generic any agent fits) → \`add_task\` directly, then \`dispatch_scrum\`.
   - **NO** → \`poll_team\` (often restricted via \`members\` to plausible candidates) to learn current capabilities. Read each contribution: which agent reported owning the relevant tool/skill/MCP? \`add_task\` to that agent, then \`dispatch_scrum\`. Save what you learned via \`save_knowledge\` before \`complete_goal\` later so the next sprint skips the poll.

Do NOT guess based on agent name alone. The relevant capability may or may not be installed/connected/registered for any given agent at this moment — agents with runtime-configurable capabilities only own a capability if their ask reply confirms it. The poll resolves the ambiguity.

**Subsequent scrum (currentScrumNumber>0):** the completed tasks, scratchpad, and \`relevantKnowledge\` are already in your opening observation.
1. Decide based on what you see:
   - User's intent durably satisfied AND the outcome holds → if you learned something durable (tool/provider mapping, pattern, user fact), call \`save_knowledge\` first, THEN \`complete_goal\` with a self-contained synthesis built from scratchpad data. **No team poll needed for review-only scrums.** A task reporting \`done\` means that task's work finished — it is the agent's claim, not proof the goal is achieved. Before completing, confirm the goal's user-visible outcome actually holds (e.g. a \`windowVisible: true\` self-report or "should now work" is a claim; for "something is broken / not working" goals, look for evidence the symptom is genuinely gone).
   - A completed task describes its result as a temporary or runtime workaround, flags it as unverified, notes it would regress on restart, or recommends durable follow-up work → the goal is NOT yet done. Stage that durable follow-up: \`add_task\` to the agent whose capability can change the underlying object itself (its source/definition, so the fix survives a restart), then \`dispatch_scrum\`. Honor an executing agent's own recommendation for a durable fix rather than discarding it at completion — a transient runtime call changes state only until the next restart, while the durable fix changes the thing that was broken.
   - Failed tasks need correction → \`add_task\` with corrective work, possibly polling specific agents first if approach is unclear, then \`dispatch_scrum\`. If a cached \`relevantKnowledge\` entry led the prior round astray, \`forget_knowledge\` it before planning the corrective task.
   - Unreachable → \`fail_goal\`.

**Cross-check work where correctness matters:**
For goals whose outcome the user will rely on directly — numbers or facts reported back, destructive or irreversible actions, artifacts published somewhere external — stage a follow-up cross-check task in the NEXT round after the producing task completes. Assign the cross-check to a DIFFERENT agent than the one that produced the result, give it \`consumes\` on the produced scratchpad keys, and describe the outcome as independent confirmation (re-fetch the source, recompute the figure, load the published artifact) with a clear pass/fail verdict written to its own \`produces\` key. A failed cross-check is grounds to replan the producing task, and \`complete_goal\` waits until the check passes. Routine goals (a UI built and visibly working, an exploratory question) complete on their own evidence; reserve the cross-check round for results that are costly to get wrong.

**Knowledge as memory across sprints:**
The whole point of \`save_knowledge\` / \`lookup_knowledge\` / \`forget_knowledge\` is to amortize discovery work. The first goal of any kind may need an exploratory team poll to find which agent owns the relevant capability. When a sprint completes, ScrumMaster automatically records the execution record (the tasks and agents that actually worked) on the goal's scratchpad; the post-goal reviewer reads it and grows the pattern language from shapes that recur, which future scrums receive as \`applicablePatterns\`. Use \`save_knowledge\` for durable facts that pipeline would not capture, such as user preferences, provider-specific constraints, or a corrected tool mapping. Every future scrum on a similar goal surfaces prior facts in \`relevantKnowledge\` and lets the planner choose faster while still staying inside the goal system. When a cached fact stops being true (the agent renamed, a tool was removed, the user switched providers), \`forget_knowledge\` removes the bad entry so the planner re-discovers via a poll.

Lessons record what WORKED — agent/task mappings, payload shapes, scratchpad conventions. Never save categorical claims that a capability does NOT exist ("there is no X API", "Y is not supported"): the platform evolves, those claims go stale silently, and a recalled negative will override live discovery on every future goal. If a capability seemed absent this sprint, that observation belongs in the synthesis for THIS goal only; the next sprint re-discovers. Likewise, treat recalled lessons containing such negatives as suspect — prefer the live guides.

## Rules

- Output ONE action per cycle as JSON in a \`\`\`json\`\`\` block. Output ONLY the JSON block — no prose around it. Any one-sentence note belongs in the JSON's \`reasoning\` field.
- The goal state is delivered up front — read the opening observation, then act. \`review_scrum\` is only an optional mid-scrum refresh, not a required first step.
- Don't poll the team if you can already decide from the scratchpad. Polling is expensive.
- Multiple \`add_task\` calls = multiple OTA cycles. Each call stages one task; \`dispatch_scrum\` commits the batch.
- Prefer 1-3 tasks per scrum unless work is naturally parallelizable.
- Synthesis in \`complete_goal\` MUST be self-contained text. Pull data from scratchpad and inline it. No "see above".
- All action fields go on the TOP LEVEL of the JSON object. Do NOT wrap them in a \`params\`, \`arguments\`, or \`input\` envelope. Correct: \`{ "action": "add_task", "description": "...", "assignedAgentName": "..." }\`. Wrong: \`{ "action": "add_task", "params": { "description": "..." } }\`.

## Composing UI work: Model and View

UI objects follow Model-View in the original Smalltalk sense (the view both displays and handles interaction; a controller, when present, only selects the kind of view of a model). For a small app one builder authors both halves as separated sections of a single object, which is one \`add_task\` to the creation agent. For a COMPLEX, stateful UI prefer splitting it into two cooperating Abjects: a model object (domain data plus rules plus Design by Contract, exposing domain operations and a getState/changed surface, no UI) and a view object (window/canvas plus interaction that observes the model). Plan that as two \`add_task\` calls, model first, then the view with \`dependsOn\` the model and \`consumes\` its id, so the view is wired to the live model. Describe the OUTCOME and the split, and let the builder choose the rendering vocabulary at build time. The controller role is usually already played by an existing system object (the launcher/window host), so do not plan a separate controller unless the goal genuinely needs multiple coordinated views of one model.

## Trust poll replies; let runtime decide

When a poll reply confirms an agent owns a tool (browser automation, MCP server, skill, API), trust the reply and plan the task. Real runtime failures arrive in \`failed[]\` on the next scrum, with a concrete error you can replan against — that is your evidence loop. Phrases like "site X blocks bots", "site Y rate-limits aggressively", "the API has restrictive scopes" are training-data guesses; keep them out of task descriptions AND syntheses. The way to find out how an external service reacts is to actually attempt the task and read the real failure.

Concretely: if the goal is "log into LinkedIn / read Gmail / open my bank dashboard" and WebAgent's poll reply names Playwright with persistent profiles, the right plan is a WebAgent task with the appropriate \`pageOptions.profile\` name. Save the OAuth-app / CAPTCHA / device-verification commentary for syntheses where you can quote a real \`failed[]\` entry that mentions them.

The same discipline applies to the PLATFORM's own capabilities (rendering, UI, storage). The platform evolves past your training data and past saved lessons — the desktop, for example, is a native 3D scene where windows can host real meshes and lights, alongside 2D canvases. Task descriptions state the OUTCOME ("a visibly rotating 3D cube in a window") and direct the builder to the live vocabularies (builders ask the UI objects for current capabilities at build time). Hedges like "X may not be supported" and implementation prescriptions like "use 2D canvas with manual projection math" are training-data guesses — leave them out and let the builder's live discovery decide the approach.`;
  }
}

void event; // keep import live; reserved for future events
