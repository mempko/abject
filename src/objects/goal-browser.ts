/**
 * GoalBrowser — UI widget for viewing goal progress in real time.
 *
 * Shows/hides from Taskbar. Subscribes to GoalManager as a dependent to
 * receive real-time goal status updates. Similar to JobBrowser but for
 * cross-agent goals instead of individual jobs.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { Goal, GoalId } from './goal-manager.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';

const log = new Log('GoalBrowser');

const GOAL_BROWSER_INTERFACE: InterfaceId = 'abjects:goal-browser';

const WIN_W = 400;
const WIN_H = 350;

/** Minimal task info extracted from TupleSpace scan results. */
interface TaskInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  attempts: number;
  maxAttempts: number;
}

const TASK_STATUS_ICONS: Record<string, string> = {
  pending: '\u25CB',              // ○
  in_progress: '\u25D4',         // ◔
  done: '\u25CF',                // ●
  failed: '\u2716',              // ✖
  permanently_failed: '\u2718',  // ✘
};

export class GoalBrowser extends Abject {
  private goalManagerId?: AbjectId;
  private goalObserverId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private goalListId?: AbjectId;
  private stopAllBtnId?: AbjectId;
  private clearBtnId?: AbjectId;
  private goalLabelMap: Map<GoalId, AbjectId> = new Map();
  private updateInProgress = false;
  private updatePending = false;

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
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('getState', async () => {
      return { visible: !!this.windowId, goalCount: this.goalLabelMap.size };
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleChanged(fromId, aspect, value);
    });
  }

  protected override getSourceForAsk(): string | undefined {
    return `## GoalBrowser Usage Guide

### Methods
- \`show()\` — Open the goal browser window. If already open, raises it to front.
- \`hide()\` — Close the goal browser window and unsubscribe from GoalManager.
- \`getState()\` — Returns { visible: boolean, goalCount: number }.

### Real-Time Goal Monitoring
GoalBrowser registers as a dependent of GoalManager to receive live progress updates.
Goal status icons:
- ▸ active — goal is in progress (shows latest progress message)
- ✓ completed — goal finished successfully
- ✗ failed — goal encountered an error
Sub-goals are indented under their parent goal.

### Interface ID
\`abjects:goal-browser\``;
  }

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

    // Scrollable VBox for goal list (expanding, auto-scroll to follow new goals)
    this.goalListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        autoScroll: true,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    // Bottom bar with Clear button
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    // Add layouts to root
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.goalListId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: bottomRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 36 } },
      ],
    }));

    // Spacer pushes buttons right
    await this.request(request(this.id, bottomRowId, 'addLayoutSpacer', {}));

    // Create Stop All + Clear buttons
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Stop All' },
          { type: 'button', windowId: this.windowId, text: 'Clear' },
        ],
      })
    );
    this.stopAllBtnId = widgetIds[0];
    this.clearBtnId = widgetIds[1];

    // Add to layout
    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.stopAllBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
      ],
    }));

    // Register as dependent (await GoalManager so we know we'll get events)
    this.send(request(this.id, this.stopAllBtnId, 'addDependent', {}));
    this.send(request(this.id, this.clearBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.goalManagerId!, 'addDependent', {}));

    // Populate existing goals
    await this.populateExistingGoals();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    // Unsubscribe from GoalManager
    try {
      await this.request(
        request(this.id, this.goalManagerId!, 'removeDependent', {})
      );
    } catch { /* best effort */ }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.goalListId = undefined;
    this.stopAllBtnId = undefined;
    this.clearBtnId = undefined;
    this.goalLabelMap.clear();
    this.changed('visibility', false);
    return true;
  }

  private async populateExistingGoals(): Promise<void> {
    if (!this.goalManagerId || !this.goalListId || !this.windowId) return;

    try {
      const goals = await this.request<Goal[]>(
        request(this.id, this.goalManagerId, 'listGoals', {})
      );

      if (goals.length === 0) return;

      const fontSize = 13;
      const lineHeight = fontSize + 4;
      const availableWidth = WIN_W - 32 - 8;

      // Fetch tasks for each goal in parallel
      const tasksByGoal = await Promise.all(
        goals.map(goal => this.fetchTasksForGoal(goal.id))
      );

      // Build specs for all goal labels (including task lines)
      const specs = goals.map((goal, i) => {
        const { text, color } = this.formatGoalLabel(goal, tasksByGoal[i]);
        return { type: 'label' as const, windowId: this.windowId!, text, style: { color, fontSize, wordWrap: true, selectable: true } };
      });

      // Batch create all labels
      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );

      // Build layout children specs
      const children = goals.map((goal, i) => {
        const { text } = this.formatGoalLabel(goal, tasksByGoal[i]);
        const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
        const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);
        this.goalLabelMap.set(goal.id, widgetIds[i]);
        return { widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed' as const }, preferredSize: { height: estimatedHeight } };
      });

      // Batch add to layout
      await this.request(request(this.id, this.goalListId, 'addLayoutChildren', { children }));
    } catch (err) {
      log.warn('Failed to populate existing goals:', err);
    }
  }

  private formatGoalLabel(goal: Goal, tasks?: TaskInfo[]): { text: string; color: string } {
    const indent = goal.parentId ? '  \u2514\u2500 ' : '';
    const latestProgress = goal.progress.length > 0
      ? goal.progress[goal.progress.length - 1].message
      : '';

    let goalLine: string;
    let color: string;

    switch (goal.status) {
      case 'active': {
        const progressLine = latestProgress ? `\n${indent}  ${latestProgress}` : '';
        goalLine = `${indent}\u25B8 ${goal.title}${progressLine}`;
        color = this.theme.statusWarning;
        break;
      }
      case 'completed':
        goalLine = `${indent}\u2713 ${goal.title}`;
        color = this.theme.statusSuccess;
        break;
      case 'failed': {
        const errorSuffix = goal.error ? ` \u2014 ${goal.error.slice(0, 40)}` : '';
        goalLine = `${indent}\u2717 ${goal.title}${errorSuffix}`;
        color = this.theme.statusError;
        break;
      }
      default:
        goalLine = `${indent}? ${goal.title}`;
        color = this.theme.statusNeutral;
        break;
    }

    // Append task lines if present
    if (tasks && tasks.length > 0) {
      const taskIndent = indent ? '      ' : '   ';
      const taskLines = tasks.map(t => {
        const icon = TASK_STATUS_ICONS[t.status] ?? '\u2022';
        const attempts = t.attempts > 0 ? ` (attempt ${t.attempts}/${t.maxAttempts})` : '';
        const desc = t.description.slice(0, 50);
        return `${taskIndent}${icon} [${t.type}] ${desc}${attempts}`;
      });
      goalLine += '\n' + taskLines.join('\n');
    }

    return { text: goalLine, color };
  }

  /**
   * Refresh a goal label by fetching the full goal + tasks.
   * Falls back to a simple text/color if the goal can't be fetched.
   */
  private async refreshGoalLabel(goalId: GoalId, fallbackText?: string, fallbackColor?: string): Promise<void> {
    try {
      const [goal, tasks] = await Promise.all([
        this.request<Goal>(request(this.id, this.goalManagerId!, 'getGoal', { goalId })),
        this.fetchTasksForGoal(goalId),
      ]);
      if (goal) {
        const { text, color } = this.formatGoalLabel(goal, tasks);
        await this.updateGoalLabel(goalId, text, color);
        return;
      }
    } catch { /* fallback below */ }

    if (fallbackText) {
      await this.updateGoalLabel(goalId, fallbackText, fallbackColor ?? this.theme.statusNeutral);
    }
  }

  /** Fetch tasks for a goal from GoalManager → TupleSpace. */
  private async fetchTasksForGoal(goalId: GoalId): Promise<TaskInfo[]> {
    if (!this.goalManagerId) return [];
    try {
      const tuples = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId })
      );
      return tuples.map(t => ({
        id: t.id,
        type: (t.fields.type as string) ?? 'unknown',
        status: (t.fields.status as string) ?? 'unknown',
        description: (t.fields.description as string) ?? '',
        attempts: (t.fields.attempts as number) ?? 0,
        maxAttempts: (t.fields.maxAttempts as number) ?? 3,
      }));
    } catch { return []; }
  }

  private async appendGoalLabel(goalId: GoalId, text: string, color: string): Promise<void> {
    if (!this.goalListId || !this.windowId) return;

    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const availableWidth = WIN_W - 32 - 8;
    const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
    const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);

    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text, style: { color, fontSize, wordWrap: true, selectable: true } },
        ],
      })
    );
    await this.request(request(this.id, this.goalListId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: estimatedHeight },
    }));
    this.goalLabelMap.set(goalId, labelId);
  }

  private async updateGoalLabel(goalId: GoalId, text: string, color: string): Promise<void> {
    const labelId = this.goalLabelMap.get(goalId);
    if (!labelId) return;

    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const availableWidth = WIN_W - 32 - 8;
    const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
    const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);

    try {
      await this.request(
        request(this.id, labelId, 'update', {
          text,
          style: { color, fontSize, wordWrap: true },
        })
      );
      // Resize the layout child to fit the updated text
      await this.request(
        request(this.id, this.goalListId!, 'updateLayoutChild', {
          widgetId: labelId,
          preferredSize: { height: estimatedHeight },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Stop All button click -- fail all active goals and cancel tasks
    if (fromId === this.stopAllBtnId && aspect === 'click') {
      if (!this.goalObserverId) return;

      const confirmed = await this.confirm({
        title: 'Stop All Goals',
        message: 'Stop all active goals and cancel their tasks? This will fail all running goals and remove pending tasks.',
        confirmLabel: 'Stop All',
        destructive: true,
      });
      if (!confirmed) return;

      try {
        await this.request(
          request(this.id, this.goalObserverId, 'failAllGoals', {}),
          30000,
        );
      } catch { /* best effort */ }

      await this.clearGoalLabels();
      await this.populateExistingGoals();
      return;
    }

    // Clear button click
    if (fromId === this.clearBtnId && aspect === 'click') {
      const confirmed = await this.confirm({
        title: 'Clear Goal History',
        message: 'Clear all completed and failed goals from history?',
        confirmLabel: 'Clear',
        destructive: true,
      });
      if (!confirmed) return;
      if (this.goalManagerId) {
        await this.request(
          request(this.id, this.goalManagerId, 'clearCompleted', {})
        );
      }
      await this.clearGoalLabels();
      await this.populateExistingGoals();
      return;
    }

    // GoalManager events -- guard against concurrent UI updates
    if (fromId === this.goalManagerId) {
      if (this.updateInProgress) {
        this.updatePending = true;
        return;
      }
      this.updateInProgress = true;
      try {
        await this.handleGoalManagerEvent(aspect, value);
      } finally {
        this.updateInProgress = false;
        if (this.updatePending) {
          this.updatePending = false;
          await this.clearGoalLabels();
          await this.populateExistingGoals();
        }
      }
    }
  }

  private async handleGoalManagerEvent(aspect: string, value?: unknown): Promise<void> {
    const data = value as Record<string, unknown> | undefined;
    if (!data) return;

    const goalId = data.goalId as GoalId;

    switch (aspect) {
      case 'goalCreated': {
        const title = data.title as string;
        const parentId = data.parentId as GoalId | undefined;
        const indent = parentId ? '  \u2514\u2500 ' : '';
        await this.appendGoalLabel(goalId, `${indent}\u25B8 ${title}`, this.theme.statusWarning);
        break;
      }
      case 'goalUpdated': {
        const message = data.message as string;
        await this.refreshGoalLabel(goalId, `\u25B8 ${message}`, this.theme.statusWarning);
        break;
      }
      case 'goalCompleted': {
        await this.refreshGoalLabel(goalId, `\u2713 completed`, this.theme.statusSuccess);
        break;
      }
      case 'goalFailed': {
        const error = data.error as string | undefined;
        const errorSuffix = error ? ` \u2014 ${error.slice(0, 30)}` : '';
        await this.refreshGoalLabel(goalId, `\u2717 failed${errorSuffix}`, this.theme.statusError);
        break;
      }
      case 'taskCompleted':
      case 'taskFailed':
      case 'taskPermanentlyFailed': {
        if (goalId) {
          await this.refreshGoalLabel(goalId);
        }
        break;
      }
      case 'goalsCleared':
      case 'goalsSwept':
        await this.clearGoalLabels();
        await this.populateExistingGoals();
        break;
    }
  }

  private async clearGoalLabels(): Promise<void> {
    if (!this.goalListId) return;

    try {
      await this.request(request(this.id, this.goalListId, 'clearLayoutChildren', {}));
    } catch { /* may already be gone */ }

    for (const [, labelId] of this.goalLabelMap) {
      this.send(request(this.id, labelId, 'destroy', {}));
    }
    this.goalLabelMap.clear();
  }
}

export const GOAL_BROWSER_ID = 'abjects:goal-browser' as AbjectId;
export { GOAL_BROWSER_INTERFACE };
