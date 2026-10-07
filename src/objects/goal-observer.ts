/**
 * GoalObserver — per-workspace watchdog that monitors goal health.
 *
 * Under the Scrum model, ScrumMaster owns goal completion: each scrum's
 * synthesis call decides done / plan-more / fail. GoalObserver MUST NOT
 * race that decision. Its job is now passive: sweep active goals, log
 * stats, emit warnings. The only auto-fail it performs is the staleness
 * backstop (no progress for a long time) — that one survives because
 * "totally stuck" is something only an outside observer can see.
 *
 * What this object used to do but no longer does (the old per-task
 * retry budget is gone, and ScrumMaster is the planner):
 *   - "All tasks permanently failed" → auto-fail. Now ScrumMaster runs
 *     the next scrum on `goalReadyForCompletion` and decides what to do.
 *   - Runaway task count cap. Multi-scrum sprints legitimately accumulate
 *     tasks across rounds; a fixed per-goal cap has no useful meaning.
 *   - Total-attempts cap. Was calibrated for the 3x retry budget that
 *     no longer exists.
 *   - `taskPermanentlyFailed` event listener. Removed because handling
 *     that event is what created the race with ScrumMaster.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { goalHealthQuestions } from '../core/decision-questions.js';
import { choiceOf } from '../llm/decision.js';

const log = new Log('GoalObserver');

const GOAL_OBSERVER_INTERFACE: InterfaceId = 'abjects:goal-observer';

// ─── Thresholds ─────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS    = 60_000;          // 1 min
const STALE_WARN_MS        = 20 * 60_000;     // 20 min no progress → warning
const STALE_FAIL_MS        = 30 * 60_000;     // 30 min → auto-fail backstop
const STALLED_QUIET_MS     = 2 * 60_000;      // quiet this long with nothing left to run → stalled
const MAX_STALL_WAKES      = 2;               // review scrums started for one stall before failing
/** Task states nobody will act on again. */
const SETTLED_TASK_STATES  = new Set(['done', 'failed', 'permanently_failed', 'cancelled', 'superseded']);

// ─── GoalObserver ───────────────────────────────────────────────────

export class GoalObserver extends Abject {
  private goalManagerId?: AbjectId;
  private sweepTimer?: ReturnType<typeof setInterval>;

  private warningsIssued = new Set<string>(); // goalIds already warned about
  /** Goals last seen with nothing running, queued or left to run, and since when. */
  private stalledSince = new Map<string, number>();
  /** Review scrums started for a goal's current stall. */
  private stallWakes = new Map<string, number>();
  /** Stalled goals the planner does not plan (a peer's, a sub-goal): left to the stale backstop. */
  private stallDeclined = new Set<string>();

  constructor() {
    super({
      manifest: {
        name: 'GoalObserver',
        description:
          'Per-workspace watchdog that monitors goal health. Sweeps active goals, emits warnings on stale goals, and auto-fails goals that have made no progress for an extended period. ScrumMaster owns done/fail decisions for active goals; GoalObserver is the staleness backstop only.',
        version: '1.0.0',
        interface: {
          id: GOAL_OBSERVER_INTERFACE,
          name: 'GoalObserver',
          description: 'Goal health monitoring and auto-failure',
          methods: [
            {
              name: 'getHealth',
              description: 'Get current monitoring statistics',
              parameters: [],
              returns: { kind: 'object', properties: {
                activeGoals: { kind: 'primitive', primitive: 'number' },
                warningCount: { kind: 'primitive', primitive: 'number' },
                autoFailedCount: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'failAllGoals',
              description: 'Fail all active goals and cancel their tasks. Cleans up TupleSpace and shared state.',
              parameters: [],
              returns: { kind: 'object', properties: {
                failedGoals: { kind: 'primitive', primitive: 'number' },
                cancelledTasks: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'configure',
              description: 'Adjust monitoring thresholds',
              parameters: [
                { name: 'staleWarnMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Stale warning threshold (ms)', optional: true },
                { name: 'staleFailMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Stale auto-fail backstop threshold (ms)', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
          ],
          events: [
            { name: 'goalWarning', description: 'A goal is showing signs of trouble (stale, high resource usage)', payload: { kind: 'object', properties: {
              goalId: { kind: 'primitive', primitive: 'string' },
              reason: { kind: 'primitive', primitive: 'string' },
            }}},
            { name: 'goalAutoFailed', description: 'A goal was auto-failed by the observer', payload: { kind: 'object', properties: {
              goalId: { kind: 'primitive', primitive: 'string' },
              reason: { kind: 'primitive', primitive: 'string' },
            }}},
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'core', 'monitoring'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GoalObserver Usage Guide

Interface: abjects:goal-observer

GoalObserver is a per-workspace watchdog that monitors goal health.
It periodically sweeps active goals, emits warnings for stale goals,
and auto-fails goals only when they have made no progress for an
extended period (the staleness backstop). All other done/fail
decisions belong to ScrumMaster.

### Get Monitoring Health

  const health = await this.call(
    this.dep('GoalObserver'), 'getHealth', {});
  // health = { activeGoals: 3, warningCount: 1, autoFailedCount: 0 }

### Fail All Active Goals

  const result = await this.call(
    this.dep('GoalObserver'), 'failAllGoals', {});
  // result = { failedGoals: 2, cancelledTasks: 5 }
  // Cancels all tasks (removes from TupleSpace) and fails all active goals.

### Configure Thresholds

  await this.call(
    this.dep('GoalObserver'), 'configure',
    { staleWarnMs: 600000, staleFailMs: 1200000 });
  // All parameters are optional; only provided values are updated.

### Events
- goalWarning: emitted when a goal is stale (20+ min with no progress) or stalled
- goalAutoFailed: emitted when a goal is auto-failed by the observer

### IMPORTANT
- Default stale warning at 20 min, auto-fail at 30 min of no progress.
- A goal with nothing running, queued or left to run for two sweeps (and at least 2 min quiet) is stalled: the observer asks ScrumMaster for a review scrum, and fails the goal if two of those do not get it moving.
- Auto-fail only triggers on staleness or a stall nothing can restart; per-task failures are ScrumMaster's call.
- failAllGoals cleans up TupleSpace and shared state entries.`;
  }

  // Configurable thresholds
  private staleWarnMs = STALE_WARN_MS;
  private staleFailMs = STALE_FAIL_MS;

  private autoFailedCount = 0;

  protected override async onInit(): Promise<void> {
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;

    // Periodic sweep is the only signal source now. We deliberately do
    // NOT subscribe to GoalManager events: reacting to taskPermanentlyFailed
    // is what created the auto-fail race against ScrumMaster's next-scrum
    // decision.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  protected override async onStop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private setupHandlers(): void {
    this.on('getHealth', async () => {
      let activeGoals = 0;
      if (this.goalManagerId) {
        try {
          const goals = await this.request<Array<{ status: string }>>(
            request(this.id, this.goalManagerId, 'listGoals', { status: 'active' })
          );
          activeGoals = goals.length;
        } catch { /* best effort */ }
      }
      return {
        activeGoals,
        warningCount: this.warningsIssued.size,
        autoFailedCount: this.autoFailedCount,
      };
    });

    this.on('failAllGoals', async () => {
      return this.failAllActiveGoals();
    });

    this.on('configure', async (msg: AbjectMessage) => {
      const { staleWarnMs, staleFailMs } = msg.payload as {
        staleWarnMs?: number; staleFailMs?: number;
      };
      if (staleWarnMs !== undefined) this.staleWarnMs = staleWarnMs;
      if (staleFailMs !== undefined) this.staleFailMs = staleFailMs;
    });
  }

  /**
   * Periodic sweep of all active goals.
   */
  private async sweep(): Promise<void> {
    if (!this.goalManagerId) return;

    let goals: Array<{ id: string; status: string; updatedAt: number; createdAt?:number; lastMeaningfulProgressAt?:number; title?: string; progress?: Array<{ timestamp: number; agentName: string; message: string; phase?: string }> }>;
    try {
      goals = await this.request<Array<{ id: string; status: string; updatedAt: number }>>(
        request(this.id, this.goalManagerId, 'listGoals', { status: 'active' })
      );
    } catch { return; }

    if (goals.length > 0) {
      log.info(`sweep: ${goals.length} active goals`);
    }

    const now = Date.now();

    // A warning covers one stall. Goals that finished drop out, so the set
    // does not grow with every goal ever warned about.
    const activeIds = new Set(goals.map(g => g.id));
    for (const id of this.warningsIssued) if (!activeIds.has(id)) this.warningsIssued.delete(id);
    for (const id of this.healthCheckedAt.keys()) if (!activeIds.has(id)) this.healthCheckedAt.delete(id);
    for (const id of this.stalledSince.keys()) if (!activeIds.has(id)) this.stalledSince.delete(id);
    for (const id of this.stallWakes.keys()) if (!activeIds.has(id)) this.stallWakes.delete(id);
    for (const id of this.stallDeclined) if (!activeIds.has(id)) this.stallDeclined.delete(id);

    for (const goal of goals) {
      const age = now - (goal.lastMeaningfulProgressAt ?? goal.createdAt ?? goal.updatedAt);
      if (await this.tendStall(goal.id, age, now).catch(() => false)) continue;

      // Stale check
      if (age < Math.min(this.staleWarnMs, this.staleFailMs)) {
        // Progress resumed: a later stall is a new one and earns its own warning.
        this.warningsIssued.delete(goal.id);
        continue;
      }
      if (age >= this.staleFailMs) {
        const runtime=await this.discoverDep('AgentAbject');
        const health=runtime?await this.request<{ownedWorkActive:boolean}>(request(this.id,runtime,'getGoalExecutionHealth',{goalId:goal.id})).catch(()=>null):null;
        if (health?.ownedWorkActive) {
          if(!this.warningsIssued.has(goal.id)){this.warningsIssued.add(goal.id);this.changed('goalWarning',{goalId:goal.id,reason:'No recent accepted evidence; runtime still owns active work',health});}
          continue;
        }
        // The time backstop stands, but a confident "progressing" or
        // "waiting" reading holds the auto-fail for another sweep.
        const judged = await this.judgeHealth(goal, age).catch(() => undefined);
        if (judged?.hold && age < this.staleFailMs * 2) {
          log.info(`sweep: goal ${goal.id.slice(0, 8)} stale for ${Math.round(age / 60000)} min but judged ${judged.health}; holding the auto-fail`);
          continue;
        }
        log.info(`sweep: goal ${goal.id.slice(0, 8)} stale for ${Math.round(age / 60000)} min — auto-failing`);
        await this.autoFailGoal(goal.id, `Goal stale for ${Math.round(age / 60000)} minutes with no progress`);
        continue;
      }
      if (age >= this.staleWarnMs && !this.warningsIssued.has(goal.id)) {
        const judged = await this.judgeHealth(goal, age).catch(() => undefined);
        if (judged?.hold) continue;
        log.info(`sweep: goal ${goal.id.slice(0, 8)} stale for ${Math.round(age / 60000)} min — warning${judged ? ` (${judged.health})` : ''}`);
        this.warningsIssued.add(goal.id);
        this.changed('goalWarning', { goalId: goal.id, reason: judged?.health === 'looping' ? 'looping' : 'stale' });
        continue;
      }

      // No task-level auto-fail under the Scrum model — ScrumMaster owns
      // those decisions. Staleness above is the only auto-fail trigger.
    }
  }

  /**
   * A goal with nothing running, nothing queued and no task left to run has
   * nobody to move it: waiting cannot help, and a health reading has nothing
   * to read. Seen that way on two sweeps, the planner is asked for a review
   * scrum; when two of those leave it stalled again, the goal fails with the
   * reason instead of idling until the stale backstop. Returns true when this
   * sweep acted on the goal.
   */
  private async tendStall(goalId: string, age: number, now: number): Promise<boolean> {
    if (age < STALLED_QUIET_MS) {
      // It moved: a later stall is a new one.
      this.stalledSince.delete(goalId);
      this.stallWakes.delete(goalId);
      this.stallDeclined.delete(goalId);
      return false;
    }
    if (this.stallDeclined.has(goalId)) return false;
    if (!await this.nothingLeftToRun(goalId)) {
      this.stalledSince.delete(goalId);
      return false;
    }
    const since = this.stalledSince.get(goalId);
    if (since === undefined) {
      this.stalledSince.set(goalId, now); // a hand-off between rounds looks like this for a moment
      return false;
    }
    if (now - since < SWEEP_INTERVAL_MS / 2) return false;
    this.stalledSince.delete(goalId);

    const wakes = this.stallWakes.get(goalId) ?? 0;
    if (wakes >= MAX_STALL_WAKES) {
      log.info(`sweep: goal ${goalId.slice(0, 8)} still stalled after ${wakes} review scrums — auto-failing`);
      await this.autoFailGoal(goalId,
        `Nothing was left running or planned for this goal, and ${wakes} review rounds started for it did not get it moving`);
      return true;
    }
    const reason = `quiet ${Math.round(age / 60000)} min with nothing running, queued or left to run`;
    const scrum = await this.discoverDep('ScrumMaster');
    const reply: { started?: boolean; coming?: boolean; reason?: string } = scrum
      ? await this.request<{ started?: boolean; coming?: boolean; reason?: string }>(
        request(this.id, scrum, 'goalStalled', { goalId, reason }), 20000).catch(err => ({ started: false, reason: String(err) }))
      : { started: false, reason: 'ScrumMaster unavailable' };
    if (reply.coming) return false; // a retry is on its backoff; the goal is not abandoned
    if (!reply.started) {
      this.stallDeclined.add(goalId);
      log.info(`sweep: goal ${goalId.slice(0, 8)} stalled (${reason}); no review scrum (${reply.reason ?? 'unknown'}) — leaving it to the stale backstop`);
      return false;
    }
    this.stallWakes.set(goalId, wakes + 1);
    log.info(`sweep: goal ${goalId.slice(0, 8)} stalled (${reason}) — review scrum started (${wakes + 1}/${MAX_STALL_WAKES})`);
    if (!this.warningsIssued.has(goalId)) {
      this.warningsIssued.add(goalId);
      this.changed('goalWarning', { goalId, reason: `Stalled: ${reason}` });
    }
    return true;
  }

  /** True when the runtime holds no work for the goal and none of its tasks is still to run. */
  private async nothingLeftToRun(goalId: string): Promise<boolean> {
    const runtime = await this.discoverDep('AgentAbject');
    if (!runtime || !this.goalManagerId) return false;
    const health = await this.request<{ ownedWorkActive?: boolean; queued?: number }>(
      request(this.id, runtime, 'getGoalExecutionHealth', { goalId }), 5000);
    if (health.ownedWorkActive || (health.queued ?? 0) > 0) return false;
    const tasks = await this.request<Array<{ fields?: { status?: unknown } }>>(
      request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }), 5000);
    return tasks.every(t => SETTLED_TASK_STATES.has(String(t.fields?.status ?? 'pending')));
  }

  /** A goal's last health judgment, reused until the recheck interval passes. */
  private healthCheckedAt = new Map<string, { at: number; judged?: { health: string; hold: boolean } }>();
  private static readonly HEALTH_RECHECK_MS = 5 * 60_000;

  /**
   * How a quiet goal stands (site goal.health). Acting, a confident
   * "progressing" or "waiting on something outside" holds the warning or the
   * auto-fail for now; "looping" names itself in the warning. The timers stay
   * the backstop: nothing is failed on a judgment alone.
   */
  private async judgeHealth(
    goal: { id: string; title?: string; progress?: Array<{ timestamp: number; agentName: string; message: string; phase?: string }> },
    age: number,
  ): Promise<{ health: string; hold: boolean } | undefined> {
    const last = this.healthCheckedAt.get(goal.id);
    if (last && Date.now() - last.at < GoalObserver.HEALTH_RECHECK_MS) return last.judged;
    if (await this.decisionSiteMode('goal.health') === 'off') return undefined;
    this.healthCheckedAt.set(goal.id, { at: Date.now() });
    const now = Date.now();
    // What is still in flight: progress messages go quiet while a task sits on
    // one long action (an approval prompt, a long command), which is waiting,
    // not looping, and only the runtime can show it.
    const runtime = await this.discoverDep('AgentAbject');
    const execution = runtime
      ? await this.request<{ tasks?: Array<{ phase?: string; step?: number; operation?: { action?: Record<string, unknown> } }> }>(
        request(this.id, runtime, 'getGoalExecutionHealth', { goalId: goal.id }), 5000).catch(() => null)
      : null;
    const running = (execution?.tasks ?? []).slice(0, 6).map(t => {
      const action = t.operation?.action;
      return { phase: t.phase, step: t.step, ...(action ? { action: JSON.stringify(action).slice(0, 300) } : {}) };
    });
    const outcome = await this.askDecision('goal.health', {
      title: goal.title ?? '',
      quiet_minutes: Math.round(age / 60000),
      progress: (goal.progress ?? []).slice(-10).map(p => ({ agent: p.agentName, phase: p.phase, message: p.message.slice(0, 200), minutes_ago: Math.round((now - p.timestamp) / 60000) })),
      running,
    }, goalHealthQuestions(), { goalId: goal.id, onBehalfOf: 'GoalObserver', timeoutMs: 20000 });
    const health = choiceOf(outcome, 'health');
    if (!outcome || !health) return undefined;
    const p = health.probabilities[health.choice] ?? 0;
    log.info(`[decision:${outcome.mode}] goal.health ${goal.id.slice(0, 8)}: ${health.choice}@${p.toFixed(2)} after ${Math.round(age / 60000)} quiet min`);
    if (p < 0.8) return undefined;
    const hold = outcome.mode === 'act' && ['progressing', 'waiting_external'].includes(health.choice);
    const judged = { health: health.choice, hold };
    this.healthCheckedAt.set(goal.id, { at: Date.now(), judged });
    return judged;
  }

  private async autoFailGoal(goalId: string, reason: string): Promise<void> {
    if (!this.goalManagerId) return;

    log.info(`Auto-failing goal ${goalId}: ${reason}`);
    this.autoFailedCount++;
    this.warningsIssued.delete(goalId);

    // Cancel tasks FIRST to clean up TupleSpace before failing the goal
    try {
      await this.request(
        request(this.id, this.goalManagerId, 'cancelTasksForGoal', { goalId })
      );
    } catch { /* best effort */ }

    try {
      await this.request(
        request(this.id, this.goalManagerId, 'failGoal', {
          goalId,
          error: `[GoalObserver] ${reason}`,
        })
      );
    } catch { /* best effort */ }

    this.changed('goalAutoFailed', { goalId, reason });
  }

  /**
   * Fail all active goals, cancel their tasks (remove from TupleSpace),
   * and clean up shared state entries.
   */
  private async failAllActiveGoals(): Promise<{ failedGoals: number; cancelledTasks: number }> {
    if (!this.goalManagerId) return { failedGoals: 0, cancelledTasks: 0 };

    let goals: Array<{ id: string }>;
    try {
      goals = await this.request<Array<{ id: string }>>(
        request(this.id, this.goalManagerId, 'listGoals', { status: 'active' })
      );
    } catch { return { failedGoals: 0, cancelledTasks: 0 }; }

    let failedGoals = 0;
    let cancelledTasks = 0;

    for (const goal of goals) {
      // Cancel all tasks for this goal (removes from TupleSpace + shared state)
      try {
        const result = await this.request<{ cancelled: number }>(
          request(this.id, this.goalManagerId!, 'cancelTasksForGoal', {
            goalId: goal.id,
          })
        );
        cancelledTasks += result.cancelled;
      } catch { /* best effort */ }

      // Fail the goal itself
      try {
        await this.request(
          request(this.id, this.goalManagerId!, 'failGoal', {
            goalId: goal.id,
            error: '[GoalObserver] Stopped by user',
          })
        );
        failedGoals++;
      } catch { /* best effort */ }

      this.warningsIssued.delete(goal.id);
    }

    this.autoFailedCount += failedGoals;
    log.info(`Stopped all goals: ${failedGoals} goals failed, ${cancelledTasks} tasks cancelled`);
    this.changed('goalAutoFailed', { goalId: '*', reason: `Stopped all: ${failedGoals} goals, ${cancelledTasks} tasks` });

    return { failedGoals, cancelledTasks };
  }
}

export const GOAL_OBSERVER_ID = 'abjects:goal-observer' as AbjectId;
