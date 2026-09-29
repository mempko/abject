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
import {
  livingStyle, emptyStateMarkdown, emptyStateStyle,
  eyeSigilOps, removeSigilOps, sigilStreamOps, type SceneOp,
} from './ui-kit.js';

const log = new Log('GoalBrowser');

const GOAL_BROWSER_INTERFACE: InterfaceId = 'abjects:goal-browser';

const WIN_W = 550;
const WIN_H = 400;

/** Status strip height at the top of the window. */
const STATUS_H = 22;
/** Height of the empty-state card while there are no goals. */
const EMPTY_H = 96;
const EYE_PREFIX = 'goal-browser-eye';
const EYE_SIZE = 20;
/** Motes per second rising off the eye while goals run. */
const STREAM_RATE = 6;
/** Same-effect plays closer together than this collapse into one. */
const EFFECT_COALESCE_MS = 450;
/** After Stop All, the resulting goal failures are the user's own doing. */
const STOP_ALL_QUIET_MS = 5000;


/** Minimal task info extracted from TupleSpace scan results. */
interface TaskInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  attempts: number;
  maxAttempts: number;
  dependsOn?: string[];
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
  private statusLabelId?: AbjectId;
  private emptyLabelId?: AbjectId;
  /** Last empty/non-empty state pushed to the layout (avoids redundant updates). */
  private emptyShown?: boolean;
  /** Eye sigil shown while any goal is running. */
  private eyeShown = false;
  private eyeWinSize?: { width: number; height: number };
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
   * A goal is remote when another peer created it. goal-tree renders those rows
   * with a [Remote: <peer>] badge and without controls: a single ScrumMaster on
   * the owning peer drives each goal, so pausing or stopping it from here would
   * race that owner.
   */
  private isRemoteGoal(creatorPeerId?: string): boolean {
    return !!creatorPeerId && creatorPeerId !== this.selfPeerId;
  }
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
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      goalCount: this.goals.length,
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    // Keep the eye anchored to the status strip's right edge on resize.
    this.on('windowResized', async (msg: AbjectMessage) => {
      const { windowId, width, height } = (msg.payload ?? {}) as { windowId?: AbjectId; width?: number; height?: number };
      if (!this.windowId || (windowId && windowId !== this.windowId)) return;
      if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return;
      this.eyeWinSize = { width, height };
      if (!this.eyeShown) return;
      await this.sendEyeOps([{ op: 'update', id: `${EYE_PREFIX}-sigil`, transform: { position: this.eyePosition() } }]);
    });
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
        title: 'Goals',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: 16, bottom: 12, left: 16 },
        spacing: 8,
      })
    );

    // Status strip: running/done counts, phosphor while work is alive.
    const { widgetIds: [statusLabelId, emptyLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'label', windowId: this.windowId, text: 'No goals yet',
            style: { color: this.theme.textMeta, fontSize: 12, wordWrap: false, selectable: false },
          },
          {
            type: 'label', windowId: this.windowId,
            text: emptyStateMarkdown(
              'No goals yet',
              'Ask a chat to do something that takes several steps. Its goal and the tasks agents take on appear here live.',
            ),
            style: { ...emptyStateStyle(this.theme), selectable: false },
          },
        ],
      })
    );
    this.statusLabelId = statusLabelId;
    this.emptyLabelId = emptyLabelId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: STATUS_H },
    }));

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

    // Empty-state card sits above the tree; collapsed to zero height once
    // there are goals to show.
    this.emptyShown = undefined;
    await this.request(request(this.id, this.scrollAreaId, 'addLayoutChild', {
      widgetId: this.emptyLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: EMPTY_H },
    }));

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
          {
            type: 'button', windowId: this.windowId, text: 'Stop All',
            style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder },
          },
          { type: 'button', windowId: this.windowId, text: 'Clear' },
        ],
      })
    );
    this.stopAllBtnId = btnIds[0];
    this.clearBtnId = btnIds[1];

    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 88, height: 36 } },
        { widgetId: this.stopAllBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 96, height: 36 } },
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
    this.statusLabelId = undefined;
    this.emptyLabelId = undefined;
    this.emptyShown = undefined;
    this.eyeShown = false;
    this.eyeWinSize = undefined;
    this.buttonState = undefined;
    this.userStoppedGoals.clear();
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
        dependsOn: (t.fields.dependsOn as string[]) ?? undefined,
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
        // Peer attribution: goal-tree badges these rows and drops their controls.
        creatorPeerId: g.creatorPeerId,
        isRemote: this.isRemoteGoal(g.creatorPeerId),
      };
    });
  }

  private buildRows(): GoalRow[] {
    return buildGoalRows({
      goals: this.toGoalNodes(),
      isExpanded: (id) => this.expandedGoals.has(id as GoalId),
      getTasks: (id) => this.tasksByGoal.get(id as GoalId) ?? [],
      // Per-goal pause/resume/stop controls on live goal rows.
      withActions: true,
    });
  }

  private async rebuildTree(): Promise<void> {
    if (!this.goalWidgetId) return;
    const rows = this.buildRows();
    try {
      await this.request(request(this.id, this.goalWidgetId, 'update', { rows }));
    } catch { /* widget may be gone */ }
    await this.refreshStatus();
  }

  // -- Status strip, empty state and the eye --

  /** Update the counts line, the empty-state card and the running eye. */
  private async refreshStatus(): Promise<void> {
    const running = this.goals.filter(g => g.status === 'active').length;
    const done = this.goals.filter(g => g.status === 'completed').length;
    const failed = this.goals.filter(g => g.status === 'failed').length;

    if (this.statusLabelId) {
      const parts: string[] = [];
      if (running > 0) parts.push(`${running} running`);
      if (done > 0) parts.push(`${done} done`);
      if (failed > 0) parts.push(`${failed} failed`);
      const text = parts.length > 0 ? parts.join(' · ') : this.goals.length > 0 ? `${this.goals.length} goals` : 'No goals yet';
      const style = running > 0
        ? { ...livingStyle(this.theme), fontWeight: 'bold' as const }
        : failed > 0 && done === 0
          ? { color: this.theme.statusError, fontSize: 12, fontWeight: 'normal' as const }
          : { color: this.theme.textMeta, fontSize: 12, fontWeight: 'normal' as const };
      this.send(event(this.id, this.statusLabelId, 'update', { text, style }));
    }

    // Bottom bar: Stop All is live while any goal is live (running or
    // paused); Clear is live while finished goals remain to clear.
    const live = this.goals.some(g => g.status === 'active' || g.status === 'paused');
    const finished = done + failed > 0;
    const buttonState = `${live}|${finished}`;
    if (buttonState !== this.buttonState) {
      this.buttonState = buttonState;
      if (this.stopAllBtnId) this.send(event(this.id, this.stopAllBtnId, 'update', { style: { disabled: !live } }));
      if (this.clearBtnId) this.send(event(this.id, this.clearBtnId, 'update', { style: { disabled: !finished } }));
    }

    const empty = this.goals.length === 0;
    if (this.scrollAreaId && this.emptyLabelId && empty !== this.emptyShown) {
      this.emptyShown = empty;
      this.send(request(this.id, this.scrollAreaId, 'updateLayoutChild', {
        widgetId: this.emptyLabelId,
        preferredSize: { height: empty ? EMPTY_H : 0 },
      }));
    }

    await this.updateEye(running > 0);
  }

  /** Eye position: right end of the status strip, px from the window centre. */
  private eyePosition(): [number, number, number] {
    const w = this.eyeWinSize?.width ?? WIN_W;
    const h = this.eyeWinSize?.height ?? WIN_H;
    // Content starts 36px below the top; the strip sits after a 12px margin.
    return [w / 2 - 16 - EYE_SIZE, -h / 2 + 36 + 12 + STATUS_H / 2, 6];
  }

  /**
   * The eye opens while any goal is running and closes when the last one
   * settles. One scene batch per transition; all motion is client-side.
   */
  private async updateEye(active: boolean): Promise<void> {
    if (!this.windowId || active === this.eyeShown) return;
    if (active) {
      if (!this.eyeWinSize) {
        try {
          const r = await this.request<{ width: number; height: number }>(
            request(this.id, this.windowId, 'getRect', {})
          );
          if (r && r.width > 0 && r.height > 0) this.eyeWinSize = { width: r.width, height: r.height };
        } catch { /* fall back to the default size */ }
      }
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

    // Per-row goal controls (pause/resume/stop glyphs on live goal rows)
    if (fromId === this.goalWidgetId && aspect === 'goalAction') {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const { id: rawId, action } = data as { id: string; action: 'pause' | 'resume' | 'stop' };
      const goalId = (rawId.startsWith('goal:') ? rawId.slice(5) : rawId) as GoalId;
      if (!this.goalManagerId) return;

      // Remote rows render without controls, so this catches a row drawn before
      // Identity resolved -- the widget's action glyphs outlive one rebuild.
      const target = this.goals.find(g => g.id === goalId);
      if (this.isRemoteGoal(target?.creatorPeerId)) {
        this.playEffect('shake');
        await this.notify('This goal belongs to another peer and is read-only here.', 'info');
        return;
      }

      let outcome: unknown;
      if (action === 'stop') {
        const goal = this.goals.find(g => g.id === goalId);
        const confirmed = await this.confirm({
          title: 'Stop Goal',
          message: `Stop "${(goal?.title ?? goalId).slice(0, 120)}" and cancel its tasks?`,
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

      // Refresh the goal row so the controls reflect the new status.
      try {
        const goal = await this.request<Goal>(request(this.id, this.goalManagerId, 'getGoal', { goalId }));
        const idx = this.goals.findIndex(g => g.id === goalId);
        if (idx >= 0 && goal) this.goals[idx] = goal;
      } catch { /* goal may be gone */ }
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
      this.stopAllQuietUntil = Date.now() + STOP_ALL_QUIET_MS;
      this.send(event(this.id, this.stopAllBtnId, 'update', { busy: true }));
      try {
        this.send(request(this.id, this.goalObserverId!, 'failAllGoals', {}));
        this.goals = [];
        this.tasksByGoal.clear();
        this.expandedGoals.clear();
        await this.rebuildTree();
        this.playEffect('flash', '$accent');
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
      // Clear takes the finished goals only; live ones stay in view.
      this.goals = this.goals.filter(g => g.status === 'active' || g.status === 'paused');
      const kept = new Set(this.goals.map(g => g.id));
      for (const id of [...this.tasksByGoal.keys()]) if (!kept.has(id)) this.tasksByGoal.delete(id);
      for (const id of [...this.expandedGoals]) if (!kept.has(id)) this.expandedGoals.delete(id);
      await this.rebuildTree();
      this.playEffect('flash', '$accent');
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
        case 'goalPaused':
        case 'goalResumed':
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
