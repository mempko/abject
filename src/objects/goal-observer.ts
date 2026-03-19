/**
 * GoalObserver — per-workspace watchdog that monitors goal health.
 *
 * Periodically sweeps active goals and auto-fails those that are stale,
 * have runaway task counts, or have exhausted all retry attempts.
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
const STALE_FAIL_MS        = 30 * 60_000;     // 30 min → auto-fail
const MAX_TASKS_PER_GOAL   = 20;              // runaway decomposition
const MAX_TOTAL_ATTEMPTS   = 50;              // resource waste across all tasks

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
          'Per-workspace watchdog that monitors goal health. Detects stale goals, runaway task counts, and exhausted retries, auto-failing goals that cannot be achieved.',
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
                { name: 'staleFailMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Stale auto-fail threshold (ms)', optional: true },
                { name: 'maxTasksPerGoal', type: { kind: 'primitive', primitive: 'number' }, description: 'Max tasks per goal', optional: true },
                { name: 'maxTotalAttempts', type: { kind: 'primitive', primitive: 'number' }, description: 'Max total attempts across tasks', optional: true },
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

  // Configurable thresholds
  private staleWarnMs = STALE_WARN_MS;
  private staleFailMs = STALE_FAIL_MS;
  private maxTasksPerGoal = MAX_TASKS_PER_GOAL;
  private maxTotalAttempts = MAX_TOTAL_ATTEMPTS;

  private autoFailedCount = 0;

  protected override async onInit(): Promise<void> {
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;

    // Subscribe as dependent of GoalManager for taskPermanentlyFailed events
    if (this.goalManagerId) {
      this.send(request(this.id, this.goalManagerId, 'addDependent', {}));
    }

    // Start periodic sweep
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
      const { staleWarnMs, staleFailMs, maxTasksPerGoal, maxTotalAttempts } = msg.payload as {
        staleWarnMs?: number; staleFailMs?: number; maxTasksPerGoal?: number; maxTotalAttempts?: number;
      };
      if (staleWarnMs !== undefined) this.staleWarnMs = staleWarnMs;
      if (staleFailMs !== undefined) this.staleFailMs = staleFailMs;
      if (maxTasksPerGoal !== undefined) this.maxTasksPerGoal = maxTasksPerGoal;
      if (maxTotalAttempts !== undefined) this.maxTotalAttempts = maxTotalAttempts;
    });

    // Listen for taskPermanentlyFailed from GoalManager for immediate checks
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value: unknown };
      if (aspect !== 'taskPermanentlyFailed') return;

      const { goalId } = value as { goalId?: string };
      if (goalId) {
        await this.checkGoalTasks(goalId);
      }
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

      // Task-level checks
      await this.checkGoalTasks(goal.id);
    }
  }

  /**
   * Check tasks for a specific goal — runaway count, all permanently failed, resource waste.
   */
  private async checkGoalTasks(goalId: string): Promise<void> {
    if (!this.goalManagerId) return;

    let tasks: Array<{ id: string; fields: Record<string, unknown> }>;
    try {
      tasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId })
      );
    } catch { return; }

    if (tasks.length === 0) return;

    const pending = tasks.filter(t => t.fields.status === 'pending');
    const inProgress = tasks.filter(t => t.fields.status === 'in_progress');
    const permFailed = tasks.filter(t => t.fields.status === 'permanently_failed');
    const done = tasks.filter(t => t.fields.status === 'done');

    log.info(`checkGoalTasks ${goalId.slice(0, 8)}: ${tasks.length} tasks (pending=${pending.length} inProgress=${inProgress.length} done=${done.length} permFailed=${permFailed.length})`);

    // Runaway task count
    if (tasks.length > this.maxTasksPerGoal) {
      log.info(`checkGoalTasks ${goalId.slice(0, 8)}: RUNAWAY ${tasks.length} > ${this.maxTasksPerGoal}`);
      await this.autoFailGoal(goalId, `Runaway task count: ${tasks.length} tasks (max ${this.maxTasksPerGoal})`);
      return;
    }

    // All tasks permanently failed or done with none pending
    if (pending.length === 0 && inProgress.length === 0 && permFailed.length > 0) {
      if (done.length === 0) {
        log.info(`checkGoalTasks ${goalId.slice(0, 8)}: all ${permFailed.length} tasks permanently failed`);
        await this.autoFailGoal(goalId, `All ${permFailed.length} tasks permanently failed`);
        return;
      }
    }

    // Resource waste — total attempts across all tasks
    let totalAttempts = 0;
    for (const task of tasks) {
      totalAttempts += (task.fields.attempts as number) ?? 0;
    }
    if (totalAttempts > this.maxTotalAttempts) {
      log.info(`checkGoalTasks ${goalId.slice(0, 8)}: RESOURCE WASTE ${totalAttempts} > ${this.maxTotalAttempts}`);
      await this.autoFailGoal(goalId, `Excessive resource usage: ${totalAttempts} total attempts (max ${this.maxTotalAttempts})`);
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
