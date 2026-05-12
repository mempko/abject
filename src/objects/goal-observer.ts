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

const log = new Log('GoalObserver');

const GOAL_OBSERVER_INTERFACE: InterfaceId = 'abjects:goal-observer';

// ─── Thresholds ─────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS    = 60_000;          // 1 min
const STALE_WARN_MS        = 20 * 60_000;     // 20 min no progress → warning
const STALE_FAIL_MS        = 30 * 60_000;     // 30 min → auto-fail backstop

// ─── GoalObserver ───────────────────────────────────────────────────

export class GoalObserver extends Abject {
  private goalManagerId?: AbjectId;
  private sweepTimer?: ReturnType<typeof setInterval>;

  private warningsIssued = new Set<string>(); // goalIds already warned about

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
- goalWarning: emitted when a goal is stale (20+ min with no progress)
- goalAutoFailed: emitted when a goal is auto-failed by the observer

### IMPORTANT
- Default stale warning at 20 min, auto-fail at 30 min of no progress.
- Auto-fail only triggers on staleness; per-task failures are ScrumMaster's call.
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

    let goals: Array<{ id: string; status: string; updatedAt: number }>;
    try {
      goals = await this.request<Array<{ id: string; status: string; updatedAt: number }>>(
        request(this.id, this.goalManagerId, 'listGoals', { status: 'active' })
      );
    } catch { return; }

    if (goals.length > 0) {
      log.info(`sweep: ${goals.length} active goals`);
    }

    const now = Date.now();

    for (const goal of goals) {
      // Stale check
      const age = now - goal.updatedAt;
      if (age >= this.staleFailMs) {
        log.info(`sweep: goal ${goal.id.slice(0, 8)} stale for ${Math.round(age / 60000)} min — auto-failing`);
        await this.autoFailGoal(goal.id, `Goal stale for ${Math.round(age / 60000)} minutes with no progress`);
        continue;
      }
      if (age >= this.staleWarnMs && !this.warningsIssued.has(goal.id)) {
        log.info(`sweep: goal ${goal.id.slice(0, 8)} stale for ${Math.round(age / 60000)} min — warning`);
        this.warningsIssued.add(goal.id);
        this.changed('goalWarning', { goalId: goal.id, reason: 'stale' });
        continue;
      }

      // No task-level auto-fail under the Scrum model — ScrumMaster owns
      // those decisions. Staleness above is the only auto-fail trigger.
    }
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
