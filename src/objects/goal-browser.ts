/**
 * GoalBrowser -- the Goals window: what needs you, what is running, what got done.
 *
 * Shows/hides from Taskbar. Subscribes to GoalManager as a dependent to
 * receive real-time goal updates. A list on the left groups goals (needs you,
 * running, then finished goals by day) with one line each of what a goal is
 * doing or produced; the selected goal shows on the right as the same card
 * Chat shows while a goal runs (state, question, planner line, tasks with a
 * step trail), plus its result, the notes sent to it and what was learned.
 * Below about 760 px wide the window shows one pane at a time: the list, or a
 * goal with a Back button.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { requireNonEmpty } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { CONVERSATION_CONTEXT_KEY, type ConversationContext } from '../core/conversation-context.js';
import type { Goal, GoalId } from './goal-manager.js';
import {
  buildGoalDetailRows, buildGoalListRows, matchesFilter, needsPerson, nowLine, oneLine, resultText,
  type GoalFilter, type GoalListItem, type GoalRow, type GoalView, type TaskNode,
} from './goal-tree.js';
import {
  emptyStateMarkdown, emptyStateStyle,
  eyeSigilOps, removeSigilOps, sigilStreamOps, type SceneOp,
} from './ui-kit.js';

const log = new Log('GoalBrowser');

const GOAL_BROWSER_INTERFACE: InterfaceId = 'abjects:goal-browser';

const WIN_W = 960;
const WIN_H = 620;
/** Narrower than this, the window shows the list or one goal, not both. */
const WIDE_MIN = 760;
const LIST_W = 360;
const TOOLBAR_H = 32;
const BAR_H = 36;
const FILTER_W = 100;
/** Height of the empty-state card while there are no goals to list. */
const EMPTY_H = 96;
const EYE_PREFIX = 'goal-browser-eye';
const EYE_SIZE = 20;
/** Motes per second rising off the eye while goals run. */
const STREAM_RATE = 6;
/** Same-effect plays closer together than this collapse into one. */
const EFFECT_COALESCE_MS = 450;
/** After Stop All, the resulting goal failures are the user's own doing. */
const STOP_ALL_QUIET_MS = 5000;
/** How often a progress event rereads the shown goal whole (its notes and question). */
const SELECTED_REREAD_MS = 3000;
/** Bursts of goal events redraw once. */
const REBUILD_DEBOUNCE_MS = 150;

const FILTERS: Array<{ key: GoalFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'needs', label: 'Needs you' },
  { key: 'failed', label: 'Failed' },
];

export class GoalBrowser extends Abject {
  private goalManagerId?: AbjectId;
  private goalObserverId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private bodyLayoutId?: AbjectId;
  private listScrollId?: AbjectId;
  private detailColumnId?: AbjectId;
  private detailScrollId?: AbjectId;
  private detailBarId?: AbjectId;
  private listWidgetId?: AbjectId;
  private detailWidgetId?: AbjectId;
  private searchInputId?: AbjectId;
  private filterBtnIds: AbjectId[] = [];
  private backBtnId?: AbjectId;
  private openBtnId?: AbjectId;
  private againBtnId?: AbjectId;
  private stopAllBtnId?: AbjectId;
  private clearBtnId?: AbjectId;
  /**
   * A destructive confirm is open. A button click can arrive twice (directly
   * and via WidgetManager's forward), which stacked two dialogs; the second
   * delivery is dropped while one is up.
   */
  private confirmOpen = false;
  private statusLabelId?: AbjectId;
  private emptyLabelId?: AbjectId;
  /** Last empty/non-empty state pushed to the layout (avoids redundant updates). */
  private emptyShown?: boolean;
  /** Eye sigil shown while any goal is running. */
  private eyeShown = false;
  private winSize = { width: WIN_W, height: WIN_H };
  /** Last play time per effect name (coalesces bursts of goal events). */
  private effectLastAt = new Map<string, number>();
  /** Goals the user stopped from this window: their failure is not an error. */
  private userStoppedGoals = new Set<GoalId>();
  /** Until this time, goal failures follow the user's Stop All. */
  private stopAllQuietUntil = 0;
  /** Last enabled state pushed to the bottom-bar buttons ("stop|clear"). */
  private buttonState?: string;

  /** Local peer id; remote goals (creatorPeerId !== local) render a badge and lose sprint actions. */
  private localPeerId = '';
  private get selfPeerId(): string { return this.localPeerId || this.id; }
  /**
   * A goal is remote when another peer created it. Its card carries a
   * [Remote: <peer>] badge and no controls: a single ScrumMaster on the owning
   * peer drives each goal, so pausing or stopping it from here would race
   * that owner.
   */
  private isRemoteGoal(creatorPeerId?: string): boolean {
    return !!creatorPeerId && creatorPeerId !== this.selfPeerId;
  }

  /** Cached goals and the tasks of the ones being shown. */
  private goals: Goal[] = [];
  private tasksByGoal: Map<GoalId, TaskNode[]> = new Map();
  /** Goals whose tasks are being fetched, and ones to fetch again when that lands. */
  private fetchingTasks = new Set<GoalId>();
  private refetchTasks = new Set<GoalId>();

  // View state.
  private filter: GoalFilter = 'all';
  private query = '';
  private selectedId?: GoalId;
  private wide = true;
  /** In the narrow layout: the list, or the selected goal. */
  private narrowShowsGoal = false;
  /** Card rows the person opened or folded, per goal. */
  private toggles = new Map<string, boolean>();
  private lastDetailRows: GoalRow[] = [];
  private lastDetailKey = '';
  private lastListKey = '';
  private lastFilterLabels = '';
  private lastPaneState = '';
  private lastBarState = '';
  private rebuildTimer?: ReturnType<typeof setTimeout>;
  private selectedReadAt = 0;
  private tickTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super({
      manifest: {
        name: 'GoalBrowser',
        description:
          'Browse and monitor goals: what needs you, what is running and what each task is doing step by step, and what finished goals produced. Live updates as agents work.',
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
              name: 'showGoal',
              description: 'Show the goal browser window with one goal selected',
              parameters: [
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'The goal to select' },
              ],
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
                selectedGoalId: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
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

    // Local peer id, resolved exactly as GoalManager resolves it so both sides
    // agree on what counts as ours. Until Identity answers, selfPeerId falls
    // back to this object's id, which matches no goal's creatorPeerId -- so
    // goals read as remote (read-only) rather than briefly controllable.
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.localPeerId = identity.peerId;
      } catch { /* Identity may not be ready */ }
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('showGoal', async (msg: AbjectMessage) => {
      const { goalId } = (msg.payload ?? {}) as { goalId?: string };
      requireNonEmpty(goalId ?? '', 'showGoal needs a goalId');
      const shown = await this.show();
      if (shown) await this.selectGoal(goalId as GoalId);
      return shown;
    });
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      goalCount: this.goals.length,
      selectedGoalId: this.selectedId ?? '',
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('windowResized', async (msg: AbjectMessage) => {
      const { windowId, width, height } = (msg.payload ?? {}) as { windowId?: AbjectId; width?: number; height?: number };
      if (!this.windowId || (windowId && windowId !== this.windowId)) return;
      if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return;
      this.winSize = { width, height };
      this.wide = width >= WIDE_MIN;
      await this.applyPanes();
      if (this.eyeShown) {
        await this.sendEyeOps([{ op: 'update', id: `${EYE_PREFIX}-sigil`, transform: { position: this.eyePosition() } }]);
      }
    });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GoalBrowser Usage Guide

### Methods
- \`show()\` -- Open the Goals window. If already open, raises it to front.
- \`showGoal({ goalId })\` -- Open the Goals window with that goal selected.
- \`hide()\` -- Close the Goals window and unsubscribe from GoalManager.
- \`getState()\` -- Returns { visible, goalCount, selectedGoalId }.

### What the window shows
GoalBrowser registers as a dependent of GoalManager to receive live progress updates.
The list groups goals: needs you (a goal paused on a question), running, then finished goals by day,
each with one line of what it is doing or produced. Filters (All, Running, Needs you, Failed) and a
search box narrow the list. Selecting a goal shows its card: state, the question it asks, the planner's
latest word, its tasks with each running task's recent steps, and for finished goals the result, the
notes sent to it and what was learned. Open the conversation shows the chat the goal came from; Run
again sends that request to the same chat.

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
    const width = Math.min(WIN_W, Math.max(480, displayInfo.width - 40));
    const height = Math.min(WIN_H, Math.max(360, displayInfo.height - 40));
    this.winSize = { width, height };
    this.wide = width >= WIDE_MIN;
    const winX = Math.max(20, Math.floor((displayInfo.width - width) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - height) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Goals',
        rect: { x: winX, y: winY, width, height },
        zIndex: 200,
        resizable: true,
      })
    );
    const wm = this.widgetManagerId!;
    const windowId = this.windowId;

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, wm, 'createVBox', { windowId, margins: { top: 12, right: 16, bottom: 12, left: 16 }, spacing: 10 })
    );

    // Toolbar: filters, then search.
    const toolbarId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedHBox', { parentLayoutId: this.rootLayoutId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 6 })
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: toolbarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: TOOLBAR_H },
    }));
    const { widgetIds: toolIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wm, 'create', {
        specs: [
          ...FILTERS.map(f => ({ type: 'button', windowId, text: f.label, style: { fontSize: 12 } })),
          { type: 'textInput', windowId, placeholder: 'Search goals' },
        ],
      })
    );
    this.filterBtnIds = toolIds.slice(0, FILTERS.length);
    this.searchInputId = toolIds[FILTERS.length];
    await this.request(request(this.id, toolbarId, 'addLayoutChildren', {
      children: this.filterBtnIds.map(id => ({ widgetId: id, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: FILTER_W, height: TOOLBAR_H } })),
    }));
    // Search takes the rest of the row, so it fits a narrow window too.
    await this.request(request(this.id, toolbarId, 'addLayoutChild', {
      widgetId: this.searchInputId, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: TOOLBAR_H },
    }));

    // Body: the list beside the selected goal.
    this.bodyLayoutId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedHBox', { parentLayoutId: this.rootLayoutId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 14 })
    );
    this.listScrollId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedScrollableVBox', { parentLayoutId: this.bodyLayoutId, autoScroll: false, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 0 })
    );
    this.detailColumnId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedVBox', { parentLayoutId: this.bodyLayoutId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 })
    );
    this.detailScrollId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedScrollableVBox', { parentLayoutId: this.detailColumnId, autoScroll: false, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 0 })
    );
    this.detailBarId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedHBox', { parentLayoutId: this.detailColumnId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 })
    );
    await this.request(request(this.id, this.detailColumnId, 'updateLayoutChild', {
      widgetId: this.detailBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: BAR_H },
    }));

    const { widgetIds: [emptyLabelId, listWidgetId, detailWidgetId, backBtnId, openBtnId, againBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wm, 'create', {
        specs: [
          {
            type: 'label', windowId,
            text: emptyStateMarkdown(
              'No goals yet',
              'Ask a chat to do something that takes several steps. Its goal and the tasks agents take on appear here live.',
            ),
            style: { ...emptyStateStyle(this.theme), selectable: false },
          },
          { type: 'goalProgress', windowId, rows: [], style: { background: 'transparent' } },
          { type: 'goalProgress', windowId, rows: [] },
          { type: 'button', windowId, text: 'Back' },
          { type: 'button', windowId, text: 'Open the conversation' },
          { type: 'button', windowId, text: 'Run again' },
        ],
      })
    );
    this.emptyLabelId = emptyLabelId;
    this.listWidgetId = listWidgetId;
    this.detailWidgetId = detailWidgetId;
    this.backBtnId = backBtnId;
    this.openBtnId = openBtnId;
    this.againBtnId = againBtnId;
    this.emptyShown = undefined;
    await this.request(request(this.id, this.listScrollId, 'addLayoutChildren', {
      children: [
        { widgetId: this.emptyLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: EMPTY_H } },
        { widgetId: this.listWidgetId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 0 } },
      ],
    }));
    await this.request(request(this.id, this.detailScrollId, 'addLayoutChild', {
      widgetId: this.detailWidgetId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 0 },
    }));
    await this.request(request(this.id, this.detailBarId, 'addLayoutChildren', {
      children: [
        { widgetId: this.backBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 72, height: BAR_H } },
        { widgetId: this.openBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 180, height: BAR_H } },
        { widgetId: this.againBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 104, height: BAR_H } },
      ],
    }));
    await this.request(request(this.id, this.detailBarId, 'addLayoutSpacer', {}));

    // Bottom bar: counts, Clear finished, Stop all.
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedHBox', { parentLayoutId: this.rootLayoutId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 })
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: bottomRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: BAR_H },
    }));
    const { widgetIds: [statusLabelId, clearBtnId, stopAllBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wm, 'create', {
        specs: [
          { type: 'label', windowId, text: 'No goals yet', style: { color: this.theme.textMeta, fontSize: 12, wordWrap: false, selectable: false } },
          { type: 'button', windowId, text: 'Clear finished' },
          {
            type: 'button', windowId, text: 'Stop all',
            style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder },
          },
        ],
      })
    );
    this.statusLabelId = statusLabelId;
    this.clearBtnId = clearBtnId;
    this.stopAllBtnId = stopAllBtnId;
    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.statusLabelId, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: BAR_H } },
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 124, height: BAR_H } },
        { widgetId: this.stopAllBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 96, height: BAR_H } },
      ],
    }));

    for (const id of [...this.filterBtnIds, this.searchInputId, this.listWidgetId, this.detailWidgetId,
      this.backBtnId, this.openBtnId, this.againBtnId, this.clearBtnId, this.stopAllBtnId]) {
      this.send(request(this.id, id, 'addDependent', {}));
    }
    this.send(request(this.id, this.goalManagerId!, 'addDependent', {}));

    await this.applyPanes();
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

    if (this.rebuildTimer) { this.cancelTimer(this.rebuildTimer); this.rebuildTimer = undefined; }
    if (this.tickTimer) { this.cancelTimer(this.tickTimer); this.tickTimer = undefined; }
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.bodyLayoutId = undefined;
    this.listScrollId = undefined;
    this.detailColumnId = undefined;
    this.detailScrollId = undefined;
    this.detailBarId = undefined;
    this.listWidgetId = undefined;
    this.detailWidgetId = undefined;
    this.searchInputId = undefined;
    this.filterBtnIds = [];
    this.backBtnId = undefined;
    this.openBtnId = undefined;
    this.againBtnId = undefined;
    this.stopAllBtnId = undefined;
    this.clearBtnId = undefined;
    this.statusLabelId = undefined;
    this.emptyLabelId = undefined;
    this.emptyShown = undefined;
    this.eyeShown = false;
    this.buttonState = undefined;
    this.lastDetailRows = [];
    this.lastDetailKey = '';
    this.lastListKey = '';
    this.lastFilterLabels = '';
    this.lastPaneState = '';
    this.lastBarState = '';
    this.userStoppedGoals.clear();
    this.goals = [];
    this.tasksByGoal.clear();
    this.toggles.clear();
    this.narrowShowsGoal = false;
    this.changed('visibility', false);
    return true;
  }

  // -- Data loading --

  private async loadGoals(): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      // Archived goals included: finished goals moved to cold storage list
      // as summaries, and selecting one reads it whole.
      this.goals = await this.request<Goal[]>(
        request(this.id, this.goalManagerId, 'listGoals', { includeArchived: true })
      );
      if (this.selectedId && !this.goals.some(g => g.id === this.selectedId)) this.selectedId = undefined;
      if (!this.selectedId) this.selectedId = this.defaultSelection();
      await Promise.all(this.goals
        .filter(g => g.status === 'active' || g.status === 'paused' || g.id === this.selectedId)
        .map(g => this.loadTasks(g.id)));
      if (this.selectedId) await this.refreshGoal(this.selectedId);
    } catch (err) {
      log.warn('Failed to load goals:', err);
    }
    await this.rebuild();
  }

  /** First choice to show: a goal waiting on the person, else a running one, else the latest. */
  private defaultSelection(): GoalId | undefined {
    const top = this.goals.filter(g => !g.parentId);
    const needs = top.find(g => needsPerson({ status: g.status, question: g.pendingQuestion?.question }));
    const running = top.find(g => g.status === 'active' || g.status === 'paused');
    const latest = [...top].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return (needs ?? running ?? latest)?.id;
  }

  /** Read one goal whole (an archived summary has no result or log) into the cache. */
  private async refreshGoal(goalId: GoalId): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      const goal = await this.request<Goal | null>(request(this.id, this.goalManagerId, 'getGoal', { goalId }));
      if (!goal) return;
      const idx = this.goals.findIndex(g => g.id === goalId);
      if (idx >= 0) this.goals[idx] = goal; else this.goals.push(goal);
    } catch { /* goal may be gone */ }
  }

  private async loadTasks(goalId: GoalId): Promise<void> {
    if (this.fetchingTasks.has(goalId)) { this.refetchTasks.add(goalId); return; }
    this.fetchingTasks.add(goalId);
    try {
      do {
        this.refetchTasks.delete(goalId);
        this.tasksByGoal.set(goalId, await this.fetchTasksForGoal(goalId));
      } while (this.refetchTasks.has(goalId));
    } finally {
      this.fetchingTasks.delete(goalId);
    }
  }

  private async fetchTasksForGoal(goalId: GoalId): Promise<TaskNode[]> {
    if (!this.goalManagerId) return [];
    try {
      const tuples = await this.request<Array<{ id: string; fields: Record<string, unknown>; claimedBy?: string }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId })
      );
      return tuples.map(t => ({
        id: t.id,
        status: (t.fields.status as string) ?? 'unknown',
        description: (t.fields.description as string) ?? '',
        attempts: (t.fields.attempts as number) ?? 0,
        maxAttempts: (t.fields.maxAttempts as number) ?? 1,
        claimedBy: t.claimedBy,
        agentName: (t.fields.agentName as string) ?? undefined,
        dependsOn: (t.fields.dependsOn as string[]) ?? undefined,
        scrumNumber: typeof t.fields.scrumNumber === 'number' ? t.fields.scrumNumber : undefined,
        result: oneLine(resultText(t.fields.result) ?? '', 220) || undefined,
        error: typeof t.fields.error === 'string' ? oneLine(t.fields.error, 220) : undefined,
      }));
    } catch { return []; }
  }

  // -- Views of the cached goals --

  private viewOf(goal: Goal): GoalView {
    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      progress: goal.progress ?? [],
      tasks: this.tasksByGoal.get(goal.id) ?? [],
      question: goal.pendingQuestion?.question,
      error: goal.error,
      result: resultText(goal.result),
      notes: goal.interjections ?? [],
      learned: learnedFrom(goal),
      children: this.goals
        .filter(g => g.parentId === goal.id)
        .map(g => ({ id: g.id, title: g.title, status: g.status, latest: g.progress?.[g.progress.length - 1]?.message })),
      isRemote: this.isRemoteGoal(goal.creatorPeerId),
      creatorPeerId: goal.creatorPeerId,
    };
  }

  private listItemOf(goal: Goal, now: number): GoalListItem {
    const live = goal.status === 'active' || goal.status === 'paused';
    const line = live
      ? nowLine({ progress: goal.progress ?? [], tasks: this.tasksByGoal.get(goal.id) ?? [], status: goal.status }, now)
      : goal.status === 'failed'
        ? (goal.error ? oneLine(goal.error, 160) : undefined)
        : (resultText(goal.result) ? oneLine(resultText(goal.result)!, 160) : undefined);
    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      question: goal.pendingQuestion?.question,
      line,
      isRemote: this.isRemoteGoal(goal.creatorPeerId),
      creatorPeerId: goal.creatorPeerId,
    };
  }

  private conversationOf(goal: Goal | undefined): ConversationContext | undefined {
    const context = goal?.scratchpad?.[CONVERSATION_CONTEXT_KEY] as ConversationContext | undefined;
    return context && typeof context.conversationId === 'string' && context.conversationId ? context : undefined;
  }

  // -- Drawing --

  private scheduleRebuild(): void {
    if (this.rebuildTimer || !this.windowId) return;
    this.rebuildTimer = this.setTimer(() => {
      this.rebuildTimer = undefined;
      void this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  /** Redraw the list, the selected goal and the bars; only what changed is sent. */
  private async rebuild(): Promise<void> {
    if (!this.windowId) return;
    const now = Date.now();
    const top = this.goals.filter(g => !g.parentId);
    const items = top.map(g => this.listItemOf(g, now));

    // Filter labels with counts.
    const counts: Record<GoalFilter, number> = {
      all: items.length,
      running: items.filter(i => i.status === 'active' || i.status === 'paused').length,
      needs: items.filter(i => needsPerson(i)).length,
      failed: items.filter(i => i.status === 'failed').length,
    };
    const labels = FILTERS.map(f => `${f.label} · ${counts[f.key]}|${f.key === this.filter}`).join(',');
    if (labels !== this.lastFilterLabels) {
      this.lastFilterLabels = labels;
      FILTERS.forEach((f, i) => {
        const selected = f.key === this.filter;
        const id = this.filterBtnIds[i];
        if (!id) return;
        this.send(event(this.id, id, 'update', {
          text: `${f.label} · ${counts[f.key]}`,
          style: selected
            ? { fontSize: 12, background: this.theme.activeItemBg, borderColor: this.theme.activeItemBorder, color: this.theme.textPrimary }
            : { fontSize: 12, background: this.theme.buttonBg, borderColor: this.theme.buttonBorder, color: this.theme.buttonText },
        }));
      });
    }

    // The list.
    const shown = items.filter(i => matchesFilter(i, this.filter, this.query));
    const listRows = buildGoalListRows(shown, { now, selectedId: this.wide || this.narrowShowsGoal ? this.selectedId : undefined });
    const listKey = JSON.stringify(listRows);
    if (listKey !== this.lastListKey && this.listWidgetId) {
      this.lastListKey = listKey;
      try { await this.request(request(this.id, this.listWidgetId, 'update', { rows: listRows })); } catch { /* widget gone */ }
    }
    const empty = shown.length === 0;
    if (this.listScrollId && this.emptyLabelId && empty !== this.emptyShown) {
      this.emptyShown = empty;
      this.send(event(this.id, this.emptyLabelId, 'update', {
        text: items.length === 0
          ? emptyStateMarkdown('No goals yet', 'Ask a chat to do something that takes several steps. Its goal and the tasks agents take on appear here live.')
          : emptyStateMarkdown('No goals match', 'Try another filter or search.'),
      }));
      this.send(request(this.id, this.listScrollId, 'updateLayoutChild', {
        widgetId: this.emptyLabelId,
        preferredSize: { height: empty ? EMPTY_H : 0 },
      }));
    }

    // The selected goal.
    const selected = this.goals.find(g => g.id === this.selectedId);
    const detailRows = selected
      ? buildGoalDetailRows(this.viewOf(selected), { now, isOpen: (id) => this.toggles.get(id), surface: 'browser', withActions: true })
      : [];
    const detailKey = JSON.stringify(detailRows);
    if (detailKey !== this.lastDetailKey && this.detailWidgetId) {
      this.lastDetailKey = detailKey;
      this.lastDetailRows = detailRows;
      try { await this.request(request(this.id, this.detailWidgetId, 'update', { rows: detailRows })); } catch { /* widget gone */ }
    }
    await this.applyDetailBar(selected);
    await this.refreshStatus();

    // Timers move while anything runs.
    const running = this.goals.some(g => g.status === 'active');
    if (running && !this.tickTimer) {
      this.tickTimer = this.setTimer(() => {
        this.tickTimer = undefined;
        void this.rebuild();
      }, 1000);
    }
  }

  /** Wide: list beside the goal. Narrow: one or the other. */
  private async applyPanes(): Promise<void> {
    if (!this.bodyLayoutId || !this.listScrollId || !this.detailColumnId) return;
    const state = this.wide ? 'wide' : this.narrowShowsGoal ? 'goal' : 'list';
    if (state === this.lastPaneState) return;
    this.lastPaneState = state;
    // A hidden pane takes no room in the row; the shown one grows into it.
    await this.request(request(this.id, this.bodyLayoutId, 'updateLayoutChild', {
      widgetId: this.listScrollId,
      ...(state === 'wide'
        ? { sizePolicy: { horizontal: 'fixed', vertical: 'expanding' }, preferredSize: { width: LIST_W } }
        : { sizePolicy: { horizontal: 'expanding', vertical: 'expanding' } }),
    })).catch(() => undefined);
    await this.request(request(this.id, this.listScrollId, 'update', { visible: state !== 'goal' })).catch(() => undefined);
    await this.request(request(this.id, this.detailColumnId, 'update', { visible: state !== 'list' })).catch(() => undefined);
    this.lastBarState = '';
    this.lastListKey = '';
    await this.rebuild();
  }

  /** Back (narrow only), Open the conversation, Run again (finished goals). */
  private async applyDetailBar(selected: Goal | undefined): Promise<void> {
    if (!this.detailBarId) return;
    const hasChat = !!this.conversationOf(selected);
    const finished = !!selected && (selected.status === 'completed' || selected.status === 'failed' || selected.status === 'archived');
    const back = !this.wide && this.narrowShowsGoal;
    const open = !!selected && hasChat;
    const again = finished && hasChat && !this.isRemoteGoal(selected?.creatorPeerId);
    const state = `${back}|${open}|${again}`;
    if (state === this.lastBarState) return;
    this.lastBarState = state;
    const shown = (id: AbjectId | undefined, show: boolean) => id && this.request(request(this.id, id, 'update', { visible: show })).catch(() => undefined);
    await Promise.all([shown(this.backBtnId, back), shown(this.openBtnId, open), shown(this.againBtnId, again)]);
  }

  // -- Status strip, empty state and the eye --

  /** Update the counts line, the bottom buttons and the running eye. */
  private async refreshStatus(): Promise<void> {
    const top = this.goals.filter(g => !g.parentId);
    const running = top.filter(g => g.status === 'active').length;
    const paused = top.filter(g => g.status === 'paused').length;
    const done = top.filter(g => g.status === 'completed').length;
    const failed = top.filter(g => g.status === 'failed').length;

    if (this.statusLabelId) {
      const parts: string[] = [];
      if (running > 0) parts.push(`${running} running`);
      if (paused > 0) parts.push(`${paused} paused`);
      if (done > 0) parts.push(`${done} done`);
      if (failed > 0) parts.push(`${failed} failed`);
      const text = parts.length > 0 ? parts.join(' · ') : top.length > 0 ? `${top.length} goals` : 'No goals yet';
      this.send(event(this.id, this.statusLabelId, 'update', { text }));
    }

    // Stop all is live while any goal is live (running or paused); Clear
    // finished is live while finished goals remain to clear.
    const live = this.goals.some(g => g.status === 'active' || g.status === 'paused');
    const finished = this.goals.some(g => g.status === 'completed' || g.status === 'failed');
    const buttonState = `${live}|${finished}`;
    if (buttonState !== this.buttonState) {
      this.buttonState = buttonState;
      if (this.stopAllBtnId) this.send(event(this.id, this.stopAllBtnId, 'update', { style: { disabled: !live } }));
      if (this.clearBtnId) this.send(event(this.id, this.clearBtnId, 'update', { style: { disabled: !finished } }));
    }

    await this.updateEye(running > 0);
  }

  /** Eye position: in the bottom bar, left of the buttons, px from the window centre. */
  private eyePosition(): [number, number, number] {
    const { width: w, height: h } = this.winSize;
    return [w / 2 - 16 - 96 - 8 - 124 - 16 - EYE_SIZE / 2, h / 2 - 12 - BAR_H / 2, 6];
  }

  /**
   * The eye opens while any goal is running and closes when the last one
   * settles. One scene batch per transition; all motion is client-side.
   */
  private async updateEye(active: boolean): Promise<void> {
    if (!this.windowId || active === this.eyeShown) return;
    if (active) {
      try {
        const r = await this.request<{ width: number; height: number }>(
          request(this.id, this.windowId, 'getRect', {})
        );
        if (r && r.width > 0 && r.height > 0) this.winSize = { width: r.width, height: r.height };
      } catch { /* keep the last known size */ }
      this.eyeShown = true;
      // The eye opens with a thinking stream; both go when the last goal settles.
      await this.sendEyeOps([
        ...eyeSigilOps(EYE_PREFIX, this.eyePosition(), EYE_SIZE),
        ...sigilStreamOps(EYE_PREFIX, EYE_SIZE, STREAM_RATE),
      ]);
    } else {
      this.eyeShown = false;
      await this.sendEyeOps(removeSigilOps(EYE_PREFIX));
    }
  }

  /**
   * Play a one-shot slab effect on the window (visual only). Repeats of the
   * same effect within EFFECT_COALESCE_MS collapse into one, so a batch of
   * goals settling together reads as a single beat.
   */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    const now = Date.now();
    if (now - (this.effectLastAt.get(effect) ?? 0) < EFFECT_COALESCE_MS) return;
    this.effectLastAt.set(effect, now);
    try {
      this.playWindowEffect(this.windowId, effect, color);
    } catch { /* window gone */ }
  }

  private async sendEyeOps(ops: SceneOp[]): Promise<void> {
    if (!this.windowId) return;
    try {
      await this.request(request(this.id, this.windowId, 'scene', { ops }));
    } catch (err) {
      log.warn('Failed to update the goal eye sigil:', err);
    }
  }

  // -- Actions --

  private async selectGoal(goalId: GoalId): Promise<void> {
    if (goalId !== this.selectedId) {
      this.selectedId = goalId;
      this.toggles.clear();
      await Promise.all([this.refreshGoal(goalId), this.loadTasks(goalId)]);
    }
    if (!this.wide) this.narrowShowsGoal = true;
    await this.applyPanes();
    await this.rebuild();
  }

  private async openConversation(): Promise<{ chatId: AbjectId; conversationId: string } | undefined> {
    const goal = this.goals.find(g => g.id === this.selectedId);
    const context = this.conversationOf(goal);
    if (!context) return undefined;
    const chatManagerId = await this.discoverDep('ChatManager');
    const opened = chatManagerId
      ? await this.request<{ conversationId: string; chatId: AbjectId } | false>(
        request(this.id, chatManagerId, 'showConversation', { conversationId: context.conversationId }),
      ).catch(() => false as const)
      : false;
    if (!opened || !opened.chatId) {
      this.playEffect('shake');
      await this.notify('The conversation this goal came from is gone.', 'info');
      return undefined;
    }
    return { chatId: opened.chatId, conversationId: context.conversationId };
  }

  /** Send the goal's request to the chat it came from, as the person first asked it. */
  private async runAgain(): Promise<void> {
    const goal = this.goals.find(g => g.id === this.selectedId);
    const context = this.conversationOf(goal);
    if (!goal || !context) return;
    const asked = [...context.messages].reverse().find(m => m.role === 'user')?.content?.trim() || goal.description || goal.title;
    const chatManagerId = await this.discoverDep('ChatManager');
    if (chatManagerId) {
      const active = await this.request<string | null>(
        request(this.id, chatManagerId, 'getActiveGoal', { conversationId: context.conversationId }),
      ).catch(() => null);
      if (active) {
        this.playEffect('shake');
        await this.notify('That conversation is working on another goal. Run again when it finishes.', 'info');
        return;
      }
    }
    const opened = await this.openConversation();
    if (!opened) return;
    const sent = await this.request<boolean>(
      request(this.id, opened.chatId, 'sendMessage', { message: asked }),
    ).catch(() => false);
    if (sent === false) {
      this.playEffect('shake');
      await this.notify('The conversation is busy. Try again in a moment.', 'info');
    }
  }

  private async goalAction(goalId: GoalId, action: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!this.goalManagerId) return;
    // Remote goals draw without controls, so this catches a card drawn before
    // Identity resolved -- the widget's action glyphs outlive one rebuild.
    const target = this.goals.find(g => g.id === goalId);
    if (this.isRemoteGoal(target?.creatorPeerId)) {
      this.playEffect('shake');
      await this.notify('This goal belongs to another peer and is read-only here.', 'info');
      return;
    }

    let outcome: unknown;
    if (action === 'stop') {
      const confirmed = await this.confirm({
        title: 'Stop Goal',
        message: `Stop "${(target?.title ?? goalId).slice(0, 120)}" and cancel its tasks?`,
        confirmLabel: 'Stop',
        destructive: true,
      });
      if (!confirmed) return;
      this.userStoppedGoals.add(goalId);
      outcome = await this.request(request(this.id, this.goalManagerId, 'stopGoal', { goalId })).catch(() => false);
    } else {
      const method = action === 'pause' ? 'pauseGoal' : 'resumeGoal';
      outcome = await this.request(request(this.id, this.goalManagerId, method, { goalId })).catch(() => false);
    }
    // GoalManager answers false (or fails) when the goal refused the change.
    if (outcome === false) {
      this.userStoppedGoals.delete(goalId);
      this.playEffect('shake');
    }
    await this.refreshGoal(goalId);
    await this.rebuild();
  }

  // -- Event handling --

  private parseId(value: unknown): string | undefined {
    try {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const id = (data as { id?: unknown })?.id;
      return typeof id === 'string' ? id : undefined;
    } catch { return undefined; }
  }

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // The two goal widgets report their natural heights; resize their slots
    // so each pane scrolls when its rows outgrow the window.
    if (aspect === 'contentHeight' && (fromId === this.listWidgetId || fromId === this.detailWidgetId)) {
      const scroll = fromId === this.listWidgetId ? this.listScrollId : this.detailScrollId;
      const height = typeof value === 'number' ? value : Number(value);
      if (scroll && Number.isFinite(height) && height >= 0) {
        this.send(request(this.id, scroll, 'updateLayoutChild', { widgetId: fromId, preferredSize: { height } }));
      }
      return;
    }

    if (fromId === this.listWidgetId && aspect === 'select') {
      const id = this.parseId(value);
      if (id?.startsWith('item:')) await this.selectGoal(id.slice(5));
      return;
    }

    if (fromId === this.detailWidgetId && aspect === 'toggle') {
      const id = this.parseId(value);
      const row = id ? this.lastDetailRows.find(r => r.id === id) : undefined;
      if (id && row) {
        this.toggles.set(id, !(row.expanded ?? false));
        await this.rebuild();
      }
      return;
    }

    if (fromId === this.detailWidgetId && aspect === 'goalAction') {
      try {
        const data = typeof value === 'string' ? JSON.parse(value) : value;
        const { id: rawId, action } = data as { id: string; action: 'pause' | 'resume' | 'stop' };
        await this.goalAction(rawId.replace(/^header:/, ''), action);
      } catch { /* malformed action */ }
      return;
    }

    const filterIndex = this.filterBtnIds.indexOf(fromId);
    if (filterIndex >= 0 && aspect === 'click') {
      this.filter = FILTERS[filterIndex].key;
      await this.rebuild();
      return;
    }

    if (fromId === this.searchInputId && (aspect === 'change' || aspect === 'submit')) {
      this.query = typeof value === 'string' ? value : '';
      await this.rebuild();
      return;
    }

    if (fromId === this.backBtnId && aspect === 'click') {
      this.narrowShowsGoal = false;
      await this.applyPanes();
      return;
    }
    if (fromId === this.openBtnId && aspect === 'click') {
      await this.openConversation();
      return;
    }
    if (fromId === this.againBtnId && aspect === 'click') {
      await this.runAgain();
      return;
    }

    // Stop all
    if (fromId === this.stopAllBtnId && aspect === 'click') {
      if (!this.goalObserverId || this.confirmOpen) return;
      this.confirmOpen = true;
      let confirmed: boolean;
      try {
        confirmed = await this.confirm({
          title: 'Stop All Goals',
          message: 'Stop all active goals and cancel their tasks?',
          confirmLabel: 'Stop All',
          destructive: true,
        });
      } finally {
        this.confirmOpen = false;
      }
      if (!confirmed) return;
      this.stopAllQuietUntil = Date.now() + STOP_ALL_QUIET_MS;
      this.send(event(this.id, this.stopAllBtnId, 'update', { busy: true }));
      try {
        this.send(request(this.id, this.goalObserverId!, 'failAllGoals', {}));
        this.playEffect('flash', '$accent');
        await this.notify('All active goals stopped', 'success');
      } finally {
        this.send(event(this.id, this.stopAllBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Clear finished
    if (fromId === this.clearBtnId && aspect === 'click') {
      if (this.confirmOpen) return;
      this.confirmOpen = true;
      let confirmed: boolean;
      try {
        confirmed = await this.confirm({
          title: 'Clear Goal History',
          message: 'Clear all completed and failed goals from history?',
          confirmLabel: 'Clear',
          destructive: true,
        });
      } finally {
        this.confirmOpen = false;
      }
      if (!confirmed || !this.goalManagerId) return;
      // Wait for the result and reload, so the view shows what was actually
      // cleared (a goal whose learning is still running stays).
      const result = await this.request<{ cleared?: number; archived?: number; kept?: number } | undefined>(
        request(this.id, this.goalManagerId, 'clearCompleted', {}), 60000,
      ).catch(() => undefined);
      this.tasksByGoal.clear();
      await this.loadGoals();
      this.playEffect('flash', '$accent');
      if (result) {
        const cleared = (result.cleared ?? 0) + (result.archived ?? 0);
        const kept = result.kept ?? 0;
        await this.notify(
          `Cleared ${cleared} goal${cleared === 1 ? '' : 's'}${kept > 0 ? `; ${kept} kept until ${kept === 1 ? 'its' : 'their'} learning review finishes` : ''}`,
          'success',
        );
      } else {
        await this.notify('Clearing goal history failed', 'error');
      }
      return;
    }

    // GoalManager events
    if (fromId === this.goalManagerId) {
      const data = value as Record<string, unknown> | undefined;
      if (!data) return;
      const goalId = data.goalId as GoalId;

      switch (aspect) {
        case 'goalCreated': {
          await this.loadGoals();
          break;
        }
        case 'goalUpdated': {
          // The event carries the progress log; patch it in and refresh tasks.
          const goal = this.goals.find(g => g.id === goalId);
          if (!goal) { await this.loadGoals(); break; }
          if (Array.isArray(data.progress)) goal.progress = data.progress as Goal['progress'];
          goal.updatedAt = Date.now();
          // The shown goal's notes and question change without events of their own; reread it now and then.
          if (goalId === this.selectedId && Date.now() - this.selectedReadAt > SELECTED_REREAD_MS) {
            this.selectedReadAt = Date.now();
            await this.refreshGoal(goalId);
          }
          await this.loadTasks(goalId);
          this.scheduleRebuild();
          break;
        }
        case 'goalPaused':
        case 'goalResumed':
        case 'goalClarificationRequested':
        case 'goalInterjection':
        case 'goalCompleted':
        case 'goalFailed':
        case 'taskCompleted':
        case 'taskFailed':
        case 'taskPermanentlyFailed': {
          if (goalId) {
            await Promise.all([this.refreshGoal(goalId), this.loadTasks(goalId)]);
            const goal = this.goals.find(g => g.id === goalId);
            // Slab effects mark top-level outcomes only: a sub-goal settling
            // is a step inside the job (its root may still replan and land).
            if (aspect === 'goalCompleted' && goal) {
              if (!goal.parentId) this.playEffect('burst');
              await this.notify(`Goal completed: ${goal.title}`, 'success');
            } else if (aspect === 'goalFailed' && goal) {
              // A failure the user asked for (Stop / Stop All) is no error.
              const userStopped = this.userStoppedGoals.delete(goalId) || Date.now() < this.stopAllQuietUntil;
              if (!userStopped && !goal.parentId) this.playEffect('glitch');
              await this.notify(`Goal failed: ${goal.title}`, 'error');
            }
          }
          this.scheduleRebuild();
          break;
        }
        case 'goalsCleared':
        case 'goalsSwept':
          this.tasksByGoal.clear();
          await this.loadGoals();
          break;
      }
    }
  }
}

/** What the learning review kept from a goal: the titles of the entries it applied. */
function learnedFrom(goal: Goal): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(goal.scratchpad ?? {})) {
    if (!key.startsWith('learning/decision/') || !value || typeof value !== 'object') continue;
    const effects = (value as { effects?: Array<{ state?: string; input?: Record<string, unknown> }> }).effects ?? [];
    for (const e of effects) {
      if (e.state !== 'applied') continue;
      const title = e.input?.title ?? e.input?.name;
      if (typeof title === 'string' && title.trim() && !out.includes(title.trim())) out.push(title.trim());
    }
  }
  return out.slice(0, 6);
}

export const GOAL_BROWSER_ID = 'abjects:goal-browser' as AbjectId;
export { GOAL_BROWSER_INTERFACE };
