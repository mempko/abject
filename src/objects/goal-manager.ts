/**
 * GoalManager — shared, observable coordination surface for cross-agent progress tracking.
 *
 * When agents delegate work to other agents (Chat → ObjectCreator → inner agent),
 * progress events can't reach the UI because Abject mailboxes process messages
 * sequentially. GoalManager provides a shared Goal that any agent in a chain can
 * update. Subscribers (GoalBrowser, Chat) receive `changed` events for real-time UI.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { requireNonEmpty } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('GoalManager');

const GOAL_MANAGER_INTERFACE: InterfaceId = 'abjects:goal-manager';

// ─── Lifecycle TTLs ──────────────────────────────────────────────────

const COMPLETED_TTL_MS = 10 * 60 * 1000;   // 10 min completed → archived
const FAILED_TTL_MS    = 30 * 60 * 1000;   // 30 min failed → archived
const STALE_TTL_MS     = 15 * 60 * 1000;   // 15 min no progress → abandoned
const ARCHIVE_TTL_MS   = 60 * 60 * 1000;   // 1 hr archived → deleted
const MAX_ARCHIVED     = 200;

// ─── Data Model ──────────────────────────────────────────────────────

export type GoalId = string;

export interface ProgressEntry {
  timestamp: number;
  agentName: string;
  message: string;
  phase?: string;
}

export interface Goal {
  id: GoalId;
  parentId?: GoalId;
  title: string;
  status: 'active' | 'completed' | 'failed' | 'archived';
  createdBy: AbjectId;
  creatorName: string;
  progress: ProgressEntry[];
  childIds: GoalId[];
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── GoalManager ─────────────────────────────────────────────────────

export class GoalManager extends Abject {
  private goals: Map<GoalId, Goal> = new Map();
  private goalOrder: GoalId[] = [];
  private goalCounter = 0;

  constructor() {
    super({
      manifest: {
        name: 'GoalManager',
        description:
          'Shared coordination surface for cross-agent progress tracking. Any agent in a delegation chain can update goals, and subscribers receive real-time changed events.',
        version: '1.0.0',
        interface: {
          id: GOAL_MANAGER_INTERFACE,
          name: 'GoalManager',
          description: 'Goal tracking and progress coordination',
          methods: [
            {
              name: 'createGoal',
              description: 'Create a new goal for tracking progress',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal title' },
                { name: 'parentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Parent goal ID for sub-goals', optional: true },
              ],
              returns: { kind: 'object', properties: { goalId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'updateProgress',
              description: 'Append a progress entry to a goal',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Progress message' },
                { name: 'phase', type: { kind: 'primitive', primitive: 'string' }, description: 'Current phase', optional: true },
                { name: 'agentName', type: { kind: 'primitive', primitive: 'string' }, description: 'Agent reporting progress', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'completeGoal',
              description: 'Mark a goal as completed',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'result', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional result data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'failGoal',
              description: 'Mark a goal as failed',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
                { name: 'error', type: { kind: 'primitive', primitive: 'string' }, description: 'Error message', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'getGoal',
              description: 'Get a goal by ID',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID' },
              ],
              returns: { kind: 'reference', reference: 'Goal' },
            },
            {
              name: 'listGoals',
              description: 'List goals, optionally filtered by status or parent',
              parameters: [
                { name: 'status', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by status', optional: true },
                { name: 'parentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by parent goal ID', optional: true },
                { name: 'includeArchived', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Include archived goals', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'Goal' } },
            },
            {
              name: 'clearCompleted',
              description: 'Archive all completed and failed goals (they are deleted after 1 hour)',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
            {
              name: 'getStats',
              description: 'Get goal counts by status',
              parameters: [],
              returns: { kind: 'object', properties: {
                active: { kind: 'primitive', primitive: 'number' },
                completed: { kind: 'primitive', primitive: 'number' },
                failed: { kind: 'primitive', primitive: 'number' },
                archived: { kind: 'primitive', primitive: 'number' },
                total: { kind: 'primitive', primitive: 'number' },
              }},
            },
          ],
          events: [
            { name: 'goalCreated', description: 'A new goal was created', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalUpdated', description: 'A goal received a progress update', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalCompleted', description: 'A goal was completed', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalFailed', description: 'A goal failed', payload: { kind: 'reference', reference: 'Goal' } },
            { name: 'goalsCleared', description: 'Completed/failed goals were cleared', payload: { kind: 'primitive', primitive: 'undefined' } },
            { name: 'goalsSwept', description: 'Goals were archived or deleted by lifecycle sweep', payload: { kind: 'primitive', primitive: 'undefined' } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    // GoalManager is stateless on init — goals are ephemeral per session.
    // SharedState sync can be added later for peer visibility.
  }

  protected override getSourceForAsk(): string | undefined {
    return `## GoalManager Usage Guide

### Create a Goal

  const { goalId } = await call(await dep('GoalManager'), 'createGoal', {
    title: 'Build a counter widget',
    parentId: 'optional-parent-goal-id',  // for sub-goals
  });

### Update Progress

  await call(await dep('GoalManager'), 'updateProgress', {
    goalId,
    message: 'Generating handler code...',
    phase: 'codegen',
    agentName: 'ObjectCreator',
  });

### Complete or Fail a Goal

  await call(await dep('GoalManager'), 'completeGoal', { goalId, result: 'Created successfully' });
  await call(await dep('GoalManager'), 'failGoal', { goalId, error: 'Compilation failed' });

### Query Goals

  const goal = await call(await dep('GoalManager'), 'getGoal', { goalId });
  // goal: { id, title, status, progress: [...], childIds, parentId?, result?, error? }

  const goals = await call(await dep('GoalManager'), 'listGoals', { status: 'active' });
  // Filter by status ('active'|'completed'|'failed'|'archived') and/or parentId
  // Archived goals are excluded by default:
  const allGoals = await call(await dep('GoalManager'), 'listGoals', { includeArchived: true });

### Goal Stats

  const stats = await call(await dep('GoalManager'), 'getStats', {});
  // { active, completed, failed, archived, total }

### Goal Lifecycle
Goals have automatic lifecycle management:
- Active goals with no progress for 15 min are marked as failed (abandoned).
- Completed goals are archived after 10 min, failed goals after 30 min.
- Archived goals are permanently deleted after 1 hour.
- clearCompleted archives completed/failed goals (not immediate delete).
- Sweeps happen lazily on createGoal, getGoal, and listGoals — no timers.

### Subscribe to Goal Events

  await call(await dep('GoalManager'), 'addDependent', {});
  // Receive changed events: goalCreated, goalUpdated, goalCompleted, goalFailed, goalsSwept

### IMPORTANT
- The interface ID is 'abjects:goal-manager'.
- Goals are automatically created by AgentAbject for every task — you usually don't need to create them manually.
- Sub-goals: pass parentId when creating a goal to link it under a parent.
- clearCompleted archives (not deletes) completed/failed goals. Archived goals auto-delete after 1 hour.
- listGoals excludes archived goals by default. Pass includeArchived: true to see them.`;
  }

  private async sweepGoals(): Promise<void> {
    const now = Date.now();
    let changed = false;

    for (const [id, goal] of this.goals) {
      switch (goal.status) {
        case 'active':
          if (now - goal.updatedAt >= STALE_TTL_MS) {
            goal.status = 'failed';
            goal.error = 'abandoned';
            goal.updatedAt = now;
            changed = true;
          }
          break;
        case 'completed':
          if (now - goal.updatedAt >= COMPLETED_TTL_MS) {
            goal.status = 'archived';
            goal.updatedAt = now;
            changed = true;
          }
          break;
        case 'failed':
          if (now - goal.updatedAt >= FAILED_TTL_MS) {
            goal.status = 'archived';
            goal.updatedAt = now;
            changed = true;
          }
          break;
        case 'archived':
          if (now - goal.updatedAt >= ARCHIVE_TTL_MS) {
            this.goals.delete(id);
            const idx = this.goalOrder.indexOf(id);
            if (idx !== -1) this.goalOrder.splice(idx, 1);
            changed = true;
          }
          break;
      }
    }

    // Enforce MAX_ARCHIVED cap — evict oldest first
    const archived = this.goalOrder
      .map(id => this.goals.get(id))
      .filter((g): g is Goal => g !== undefined && g.status === 'archived');

    if (archived.length > MAX_ARCHIVED) {
      const toEvict = archived
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, archived.length - MAX_ARCHIVED);

      for (const goal of toEvict) {
        this.goals.delete(goal.id);
        const idx = this.goalOrder.indexOf(goal.id);
        if (idx !== -1) this.goalOrder.splice(idx, 1);
        changed = true;
      }
    }

    if (changed) {
      this.changed('goalsSwept', {});
    }
  }

  private setupHandlers(): void {
    this.on('createGoal', async (msg: AbjectMessage) => {
      await this.sweepGoals();
      const { title, parentId } = msg.payload as { title: string; parentId?: GoalId };
      requireNonEmpty(title, 'title');

      const goalId = `goal-${++this.goalCounter}-${Date.now()}` as GoalId;
      const callerId = msg.routing.from;

      const goal: Goal = {
        id: goalId,
        parentId,
        title: title.slice(0, 200),
        status: 'active',
        createdBy: callerId,
        creatorName: '', // Will be filled from agent context if available
        progress: [],
        childIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.goals.set(goalId, goal);
      this.goalOrder.push(goalId);

      // Link to parent
      if (parentId) {
        const parent = this.goals.get(parentId);
        if (parent) {
          parent.childIds.push(goalId);
          parent.updatedAt = Date.now();
        }
      }

      log.info(`Goal created: "${goal.title}" (${goalId})`);
      this.changed('goalCreated', { goalId, title: goal.title, parentId });

      return { goalId };
    });

    this.on('updateProgress', async (msg: AbjectMessage) => {
      const { goalId, message, phase, agentName } = msg.payload as {
        goalId: GoalId; message: string; phase?: string; agentName?: string;
      };
      const goal = this.goals.get(goalId);
      if (!goal) return;

      goal.progress.push({
        timestamp: Date.now(),
        agentName: agentName ?? 'Unknown',
        message,
        phase,
      });
      goal.updatedAt = Date.now();

      this.changed('goalUpdated', {
        goalId,
        message,
        phase,
        agentName,
        progress: goal.progress,
      });
    });

    this.on('completeGoal', async (msg: AbjectMessage) => {
      const { goalId, result } = msg.payload as { goalId: GoalId; result?: unknown };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return;

      goal.status = 'completed';
      goal.result = result;
      goal.updatedAt = Date.now();

      log.info(`Goal completed: "${goal.title}" (${goalId})`);
      this.changed('goalCompleted', { goalId, result });
    });

    this.on('failGoal', async (msg: AbjectMessage) => {
      const { goalId, error } = msg.payload as { goalId: GoalId; error?: string };
      const goal = this.goals.get(goalId);
      if (!goal || goal.status !== 'active') return;

      goal.status = 'failed';
      goal.error = error;
      goal.updatedAt = Date.now();

      log.info(`Goal failed: "${goal.title}" (${goalId}) — ${error ?? 'unknown'}`);
      this.changed('goalFailed', { goalId, error });
    });

    this.on('getGoal', async (msg: AbjectMessage) => {
      await this.sweepGoals();
      const { goalId } = msg.payload as { goalId: GoalId };
      return this.goals.get(goalId) ?? null;
    });

    this.on('listGoals', async (msg: AbjectMessage) => {
      await this.sweepGoals();
      const { status, parentId, includeArchived } = (msg.payload ?? {}) as {
        status?: string; parentId?: GoalId; includeArchived?: boolean;
      };
      return this.goalOrder
        .map(id => this.goals.get(id))
        .filter((g): g is Goal => {
          if (!g) return false;
          if (!includeArchived && g.status === 'archived') return false;
          if (status && g.status !== status) return false;
          if (parentId !== undefined && g.parentId !== parentId) return false;
          return true;
        });
    });

    this.on('clearCompleted', async () => {
      const now = Date.now();
      for (const [, goal] of this.goals) {
        if (goal.status === 'completed' || goal.status === 'failed') {
          goal.status = 'archived';
          goal.updatedAt = now;
        }
      }
      this.changed('goalsCleared', {});
    });

    this.on('getStats', async () => {
      await this.sweepGoals();
      let active = 0, completed = 0, failed = 0, archived = 0;
      for (const [, goal] of this.goals) {
        switch (goal.status) {
          case 'active': active++; break;
          case 'completed': completed++; break;
          case 'failed': failed++; break;
          case 'archived': archived++; break;
        }
      }
      return { active, completed, failed, archived, total: this.goals.size };
    });
  }
}

export const GOAL_MANAGER_ID = 'abjects:goal-manager' as AbjectId;
