/**
 * GoalBrowser -- UI widget for viewing goal progress in real time.
 *
 * Shows/hides from Taskbar. Subscribes to GoalManager as a dependent to
 * receive real-time goal status updates. Uses a TreeWidget to display the
 * goal/task/progress hierarchy.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { Goal, GoalId } from './goal-manager.js';
import { buildGoalRows, type GoalRow, type GoalNode } from './goal-tree.js';

const log = new Log('GoalBrowser');

const GOAL_BROWSER_INTERFACE: InterfaceId = 'abjects:goal-browser';

const WIN_W = 550;
const WIN_H = 400;

/** Minimal task info extracted from TupleSpace scan results. */
interface TaskInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  attempts: number;
  maxAttempts: number;
  claimedBy?: string;
  agentName?: string;
}

export class GoalBrowser extends Abject {
  private goalManagerId?: AbjectId;
  private goalObserverId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private scrollAreaId?: AbjectId;
  private goalWidgetId?: AbjectId;
  private stopAllBtnId?: AbjectId;
  private clearBtnId?: AbjectId;

  /** Track which goals are expanded in the tree. Active goals expand by default. */
  private expandedGoals: Set<GoalId> = new Set();

  /** Cached goals and tasks for rebuilding the tree. */
  private goals: Goal[] = [];
  private tasksByGoal: Map<GoalId, TaskInfo[]> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'GoalBrowser',
        description:
          'Browse and monitor cross-agent goal progress. Shows real-time updates for active, completed, and failed goals across agent delegation chains.',
        version: '1.0.0',
        interface: {
          id: GOAL_BROWSER_INTERFACE,
          name: 'GoalBrowser',
          description: 'Goal progress browser UI',
          methods: [
            {
              name: 'show',
              description: 'Show the goal browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the goal browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return current state of the goal browser',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
                goalCount: { kind: 'primitive', primitive: 'number' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display goal browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.goalManagerId = await this.requireDep('GoalManager');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.goalObserverId = await this.discoverDep('GoalObserver') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      goalCount: this.goals.length,
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GoalBrowser Usage Guide

### Methods
- \`show()\` -- Open the goal browser window. If already open, raises it to front.
- \`hide()\` -- Close the goal browser window and unsubscribe from GoalManager.
- \`getState()\` -- Returns { visible: boolean, goalCount: number }.

### Real-Time Goal Monitoring
GoalBrowser registers as a dependent of GoalManager to receive live progress updates.
Goals are shown in a tree: each goal is a parent node, tasks and progress are children.
Click the arrow to expand/collapse a goal.

### Interface ID
\`abjects:goal-browser\``;
  }

  // -- Window lifecycle --

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83C\uDFAF Goals',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Scrollable area holds the goal-progress widget. The widget reports its
    // own natural height (rows word-wrap and vary in height); the ScrollableVBox
    // scrolls when the tree is taller than the window. Auto-added as expanding,
    // so it sits above the button bar.
    this.scrollAreaId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        autoScroll: false,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 0,
      })
    );

    const { widgetIds: [goalWidgetId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'goalProgress', windowId: this.windowId, rows: [] }],
      })
    );
    this.goalWidgetId = goalWidgetId;

    await this.request(request(this.id, this.scrollAreaId, 'addLayoutChild', {
      widgetId: this.goalWidgetId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: WIN_H },
    }));

    // Bottom bar (createNestedHBox auto-adds after the tree)
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    // Override the auto-added expanding policy to fixed height
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: bottomRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Spacer pushes buttons right
    await this.request(request(this.id, bottomRowId, 'addLayoutSpacer', {}));

    // Stop All + Clear buttons
    const { widgetIds: btnIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Stop All' },
          { type: 'button', windowId: this.windowId, text: 'Clear' },
        ],
      })
    );
    this.stopAllBtnId = btnIds[0];
    this.clearBtnId = btnIds[1];

    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.stopAllBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
      ],
    }));

    // Subscribe to events
    this.send(request(this.id, this.stopAllBtnId, 'addDependent', {}));
    this.send(request(this.id, this.clearBtnId, 'addDependent', {}));
    this.send(request(this.id, this.goalWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.goalManagerId!, 'addDependent', {}));

    // Populate
    await this.loadGoals();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.send(request(this.id, this.goalManagerId!, 'removeDependent', {}));

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.scrollAreaId = undefined;
    this.goalWidgetId = undefined;
    this.stopAllBtnId = undefined;
    this.clearBtnId = undefined;
    this.goals = [];
    this.tasksByGoal.clear();
    this.expandedGoals.clear();
    this.changed('visibility', false);
    return true;
  }

  // -- Data loading --

  private async loadGoals(): Promise<void> {
    if (!this.goalManagerId) return;

    try {
      this.goals = await this.request<Goal[]>(
        request(this.id, this.goalManagerId, 'listGoals', {})
      );

      // Auto-expand active goals
      for (const goal of this.goals) {
        if (goal.status === 'active') this.expandedGoals.add(goal.id);
      }

      // Fetch tasks for expanded goals
      await Promise.all(
        this.goals
          .filter(g => this.expandedGoals.has(g.id))
          .map(async g => {
            const tasks = await this.fetchTasksForGoal(g.id);
            this.tasksByGoal.set(g.id, tasks);
          })
      );
    } catch (err) {
      log.warn('Failed to load goals:', err);
    }

    await this.rebuildTree();
  }

  private async fetchTasksForGoal(goalId: GoalId): Promise<TaskInfo[]> {
    if (!this.goalManagerId) return [];
    try {
      const tuples = await this.request<Array<{ id: string; fields: Record<string, unknown>; claimedBy?: string }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId })
      );
      return tuples.map(t => ({
        id: t.id,
        type: (t.fields.type as string) ?? 'unknown',
        status: (t.fields.status as string) ?? 'unknown',
        description: (t.fields.description as string) ?? '',
        attempts: (t.fields.attempts as number) ?? 0,
        maxAttempts: (t.fields.maxAttempts as number) ?? 3,
        claimedBy: t.claimedBy,
        agentName: (t.fields.agentName as string) ?? undefined,
      }));
    } catch { return []; }
  }

  // -- Row building --

  /** Map cached Goals into the shared, UI-agnostic node shape. */
  private toGoalNodes(): GoalNode[] {
    return this.goals.map(g => {
      const last = g.progress.length > 0 ? g.progress[g.progress.length - 1] : undefined;
      return {
        id: g.id,
        parentId: g.parentId,
        title: g.title,
        description: g.description,
        status: g.status,
        latestMessage: last?.message,
        latestAgent: last?.agentName,
        error: g.error,
      };
    });
  }

  private buildRows(): GoalRow[] {
    return buildGoalRows({
      goals: this.toGoalNodes(),
      isExpanded: (id) => this.expandedGoals.has(id as GoalId),
      getTasks: (id) => this.tasksByGoal.get(id as GoalId) ?? [],
    });
  }

  private async rebuildTree(): Promise<void> {
    if (!this.goalWidgetId) return;
    const rows = this.buildRows();
    try {
      await this.request(request(this.id, this.goalWidgetId, 'update', { rows }));
    } catch { /* widget may be gone */ }
  }

  // -- Event handling --

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Goal widget reports its natural height; resize its layout child so the
    // ScrollableVBox scrolls when the tree outgrows the window.
    if (fromId === this.goalWidgetId && aspect === 'contentHeight') {
      if (this.scrollAreaId) {
        const height = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(height) && height > 0) {
          this.send(request(this.id, this.scrollAreaId, 'updateLayoutChild', {
            widgetId: this.goalWidgetId,
            preferredSize: { height },
          }));
        }
      }
      return;
    }

    // Tree toggle event
    if (fromId === this.goalWidgetId && aspect === 'toggle') {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const rawId = (data as { id: string }).id;
      // Strip the "goal:" prefix
      const goalId = rawId.startsWith('goal:') ? rawId.slice(5) : rawId;
      if (this.expandedGoals.has(goalId)) {
        this.expandedGoals.delete(goalId);
      } else {
        this.expandedGoals.add(goalId);
        // Fetch tasks if not cached
        if (!this.tasksByGoal.has(goalId)) {
          const tasks = await this.fetchTasksForGoal(goalId);
          this.tasksByGoal.set(goalId, tasks);
        }
      }
      await this.rebuildTree();
      return;
    }

    // Stop All button
    if (fromId === this.stopAllBtnId && aspect === 'click') {
      if (!this.goalObserverId) return;
      const confirmed = await this.confirm({
        title: 'Stop All Goals',
        message: 'Stop all active goals and cancel their tasks?',
        confirmLabel: 'Stop All',
        destructive: true,
      });
      if (!confirmed) return;
      this.send(event(this.id, this.stopAllBtnId, 'update', { busy: true }));
      try {
        this.send(request(this.id, this.goalObserverId!, 'failAllGoals', {}));
        this.goals = [];
        this.tasksByGoal.clear();
        this.expandedGoals.clear();
        await this.rebuildTree();
        await this.notify('All active goals stopped', 'success');
      } finally {
        this.send(event(this.id, this.stopAllBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Clear button
    if (fromId === this.clearBtnId && aspect === 'click') {
      const confirmed = await this.confirm({
        title: 'Clear Goal History',
        message: 'Clear all completed and failed goals from history?',
        confirmLabel: 'Clear',
        destructive: true,
      });
      if (!confirmed) return;
      if (this.goalManagerId) {
        this.send(request(this.id, this.goalManagerId, 'clearCompleted', {}));
      }
      this.goals = [];
      this.tasksByGoal.clear();
      this.expandedGoals.clear();
      await this.rebuildTree();
      return;
    }

    // GoalManager events
    if (fromId === this.goalManagerId) {
      const data = value as Record<string, unknown> | undefined;
      if (!data) return;
      const goalId = data.goalId as GoalId;

      switch (aspect) {
        case 'goalCreated': {
          this.expandedGoals.add(goalId);
          await this.loadGoals();
          break;
        }
        case 'goalUpdated':
        case 'goalCompleted':
        case 'goalFailed':
        case 'taskCompleted':
        case 'taskFailed':
        case 'taskPermanentlyFailed': {
          // Refresh the specific goal's data
          if (goalId) {
            try {
              const [goal, tasks] = await Promise.all([
                this.request<Goal>(request(this.id, this.goalManagerId!, 'getGoal', { goalId })),
                this.fetchTasksForGoal(goalId),
              ]);
              // Update cached data
              const idx = this.goals.findIndex(g => g.id === goalId);
              if (idx >= 0 && goal) {
                this.goals[idx] = goal;
              }
              this.tasksByGoal.set(goalId, tasks);
              // Surface goal-level outcomes as toasts (Goal-Gradient + Zeigarnik).
              // Skip the noisier task-level events.
              if (aspect === 'goalCompleted' && goal) {
                await this.notify(`Goal completed: ${goal.title}`, 'success');
              } else if (aspect === 'goalFailed' && goal) {
                await this.notify(`Goal failed: ${goal.title}`, 'error');
              }
            } catch { /* goal may be gone */ }
          }
          await this.rebuildTree();
          break;
        }
        case 'goalsCleared':
        case 'goalsSwept':
          this.goals = [];
          this.tasksByGoal.clear();
          this.expandedGoals.clear();
          await this.loadGoals();
          break;
      }
    }
  }
}

export const GOAL_BROWSER_ID = 'abjects:goal-browser' as AbjectId;
export { GOAL_BROWSER_INTERFACE };
