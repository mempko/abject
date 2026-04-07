/**
 * GoalBrowser -- UI widget for viewing goal progress in real time.
 *
 * Shows/hides from Taskbar. Subscribes to GoalManager as a dependent to
 * receive real-time goal status updates. Uses a TreeWidget to display the
 * goal/task/progress hierarchy.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { Goal, GoalId } from './goal-manager.js';
import type { TreeItem } from './widgets/tree-widget.js';

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
}

const GOAL_STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  active:    { icon: '\u25B8', color: '' },  // ▸ (color set from theme)
  completed: { icon: '\u2713', color: '' },  // ✓
  failed:    { icon: '\u2717', color: '' },  // ✗
};

const TASK_STATUS_ICONS: Record<string, string> = {
  pending:            '\u25CB',  // ○
  claimed:            '\u25D1',  // ◑
  in_progress:        '\u25D1',  // ◑
  done:               '\u2713',  // ✓
  permanently_failed: '\u2717',  // ✗
};

export class GoalBrowser extends Abject {
  private goalManagerId?: AbjectId;
  private goalObserverId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private treeWidgetId?: AbjectId;
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

  protected override getSourceForAsk(): string | undefined {
    return `## GoalBrowser Usage Guide

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

    // Tree widget for goals -- add to layout first so it appears above the buttons
    const { widgetIds: [treeId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'tree', windowId: this.windowId, treeItems: [], itemHeight: 22 }],
      })
    );
    this.treeWidgetId = treeId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.treeWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
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
    this.send(request(this.id, this.treeWidgetId, 'addDependent', {}));
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
    this.treeWidgetId = undefined;
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
      }));
    } catch { return []; }
  }

  // -- Tree building --

  private buildTreeItems(): TreeItem[] {
    const items: TreeItem[] = [];

    for (const goal of this.goals) {
      const isExpanded = this.expandedGoals.has(goal.id);
      const tasks = this.tasksByGoal.get(goal.id) ?? [];
      const latestProgress = goal.progress.length > 0
        ? goal.progress[goal.progress.length - 1].message
        : '';
      const hasChildren = tasks.length > 0 || (goal.status === 'active' && !!latestProgress);

      // Goal status icon and color
      const statusInfo = GOAL_STATUS_ICONS[goal.status];
      const icon = statusInfo?.icon ?? '?';
      let iconColor: string;
      switch (goal.status) {
        case 'active': iconColor = this.theme.statusWarning; break;
        case 'completed': iconColor = this.theme.statusSuccess; break;
        case 'failed': iconColor = this.theme.statusError; break;
        default: iconColor = this.theme.statusNeutral; break;
      }

      const errorSuffix = goal.status === 'failed' && goal.error
        ? ` -- ${goal.error.slice(0, 40)}`
        : '';

      items.push({
        id: `goal:${goal.id}`,
        label: goal.title + errorSuffix,
        icon,
        iconColor,
        depth: goal.parentId ? 1 : 0,
        expanded: isExpanded,
        hasChildren,
      });

      if (!isExpanded) continue;

      // Task children
      for (const task of tasks) {
        const effectiveStatus = task.status === 'pending' && task.claimedBy ? 'claimed' : task.status;
        const taskIcon = TASK_STATUS_ICONS[effectiveStatus] ?? '\u2022';
        const attempts = task.attempts > 0 ? ` (${task.attempts}/${task.maxAttempts})` : '';
        const desc = task.description.slice(0, 50);

        items.push({
          id: `task:${task.id}`,
          label: `[${task.type}] ${desc}${attempts}`,
          icon: taskIcon,
          iconColor: effectiveStatus === 'done' ? this.theme.statusSuccess
            : effectiveStatus === 'permanently_failed' ? this.theme.statusError
            : this.theme.textSecondary,
          depth: goal.parentId ? 2 : 1,
        });
      }

      // Progress line (child of the task, one level deeper)
      if (goal.status === 'active' && latestProgress) {
        items.push({
          id: `progress:${goal.id}`,
          label: latestProgress,
          icon: '\u2026', // …
          iconColor: this.theme.textTertiary,
          depth: goal.parentId ? 3 : 2,
        });
      }
    }

    return items;
  }

  private async rebuildTree(): Promise<void> {
    if (!this.treeWidgetId) return;
    const items = this.buildTreeItems();
    try {
      await this.request(request(this.id, this.treeWidgetId, 'update', { items }));
    } catch { /* widget may be gone */ }
  }

  // -- Event handling --

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Tree toggle event
    if (fromId === this.treeWidgetId && aspect === 'toggle') {
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
      this.send(request(this.id, this.goalObserverId!, 'failAllGoals', {}));
      this.goals = [];
      this.tasksByGoal.clear();
      this.expandedGoals.clear();
      await this.rebuildTree();
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
