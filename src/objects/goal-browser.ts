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
import type { Goal, GoalId } from './goal-manager.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';

const GOAL_BROWSER_INTERFACE: InterfaceId = 'abjects:goal-browser';

const WIN_W = 400;
const WIN_H = 350;

export class GoalBrowser extends Abject {
  private goalManagerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private goalListId?: AbjectId;
  private clearBtnId?: AbjectId;
  private goalLabelMap: Map<GoalId, AbjectId> = new Map();

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

    // Spacer pushes button right
    await this.request(request(this.id, bottomRowId, 'addLayoutSpacer', {}));

    // Create clear button
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Clear' },
        ],
      })
    );
    this.clearBtnId = widgetIds[0];

    // Add to layout
    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
      ],
    }));

    // Fire-and-forget: register as dependent
    this.send(request(this.id, this.clearBtnId, 'addDependent', {}));
    this.send(request(this.id, this.goalManagerId!, 'addDependent', {}));

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

      // Build specs for all goal labels
      const specs = goals.map(goal => {
        const { text, color } = this.formatGoalLabel(goal);
        return { type: 'label' as const, windowId: this.windowId!, text, style: { color, fontSize, wordWrap: true, selectable: true } };
      });

      // Batch create all labels
      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );

      // Build layout children specs
      const children = goals.map((goal, i) => {
        const { text } = this.formatGoalLabel(goal);
        const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
        const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);
        this.goalLabelMap.set(goal.id, widgetIds[i]);
        return { widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed' as const }, preferredSize: { height: estimatedHeight } };
      });

      // Batch add to layout
      await this.request(request(this.id, this.goalListId, 'addLayoutChildren', { children }));
    } catch { /* GoalManager may not have any goals yet */ }
  }

  private formatGoalLabel(goal: Goal): { text: string; color: string } {
    const indent = goal.parentId ? '  \u2514\u2500 ' : '';
    const latestProgress = goal.progress.length > 0
      ? goal.progress[goal.progress.length - 1].message
      : '';

    switch (goal.status) {
      case 'active': {
        const progressLine = latestProgress ? `\n${indent}  ${latestProgress}` : '';
        return { text: `${indent}\u25B8 ${goal.title}${progressLine}`, color: this.theme.statusWarning };
      }
      case 'completed':
        return { text: `${indent}\u2713 ${goal.title}`, color: this.theme.statusSuccess };
      case 'failed': {
        const errorSuffix = goal.error ? ` \u2014 ${goal.error.slice(0, 40)}` : '';
        return { text: `${indent}\u2717 ${goal.title}${errorSuffix}`, color: this.theme.statusError };
      }
      default:
        return { text: `${indent}? ${goal.title}`, color: this.theme.statusNeutral };
    }
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

    // GoalManager events
    if (fromId === this.goalManagerId) {
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
          // Fetch the full goal to get context for formatting
          try {
            const goal = await this.request<Goal>(
              request(this.id, this.goalManagerId!, 'getGoal', { goalId })
            );
            if (goal) {
              const { text, color } = this.formatGoalLabel(goal);
              await this.updateGoalLabel(goalId, text, color);
            }
          } catch {
            // Fallback: just update with message
            await this.updateGoalLabel(goalId, `\u25B8 ${message}`, this.theme.statusWarning);
          }
          break;
        }
        case 'goalCompleted': {
          try {
            const goal = await this.request<Goal>(
              request(this.id, this.goalManagerId!, 'getGoal', { goalId })
            );
            if (goal) {
              const { text, color } = this.formatGoalLabel(goal);
              await this.updateGoalLabel(goalId, text, color);
            }
          } catch {
            await this.updateGoalLabel(goalId, `\u2713 completed`, this.theme.statusSuccess);
          }
          break;
        }
        case 'goalFailed': {
          const error = data.error as string | undefined;
          try {
            const goal = await this.request<Goal>(
              request(this.id, this.goalManagerId!, 'getGoal', { goalId })
            );
            if (goal) {
              const { text, color } = this.formatGoalLabel(goal);
              await this.updateGoalLabel(goalId, text, color);
            }
          } catch {
            const errorSuffix = error ? ` \u2014 ${error.slice(0, 30)}` : '';
            await this.updateGoalLabel(goalId, `\u2717 failed${errorSuffix}`, this.theme.statusError);
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
