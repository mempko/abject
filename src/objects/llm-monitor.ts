/**
 * LLMMonitor -- real-time viewer for LLM request activity, history, and stats.
 *
 * Shows active requests and recent history with requester, method, provider,
 * model, elapsed time, and output characters. Provides controls to kill requests,
 * pause/unpause the LLM object, and view full prompt/output of any request.
 * Accessible from the GlobalToolbar.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { LLMActiveRequest, LLMStats, LLMHistoryEntry } from './llm-object.js';

const log = new Log('LLMMonitor');

const LLM_MONITOR_INTERFACE: InterfaceId = 'abjects:llm-monitor';

const WIN_W = 880;
const WIN_H = 500;
const DETAIL_W = 650;
const DETAIL_H = 500;

interface StatsSnapshot {
  stats: LLMStats;
  activeRequests: LLMActiveRequest[];
  history: LLMHistoryEntry[];
  paused: boolean;
}

/**
 * Per-row widget IDs. Rows are fixed SLOTS: slot i always renders the i-th
 * entry of the sorted desired list, and cells update in place (diffed against
 * `desc`). This makes arbitrary ordering (newest-on-top, column sorts) free —
 * no layout reordering, no widget churn beyond count changes.
 * Labels order: name, method, provider, model, started, time, output.
 */
interface RowWidgets {
  requestId: string;
  containerId: AbjectId;  // the row's HBox; destroying it cascades to labels + btn
  labels: AbjectId[];  // [name, method, provider, model, started, time, output]
  btn: AbjectId;
  /** Last rendered desc; cells whose value is unchanged are not re-sent. */
  desc?: RowDesc;
}

/** Sortable columns, in header order. */
type SortCol = 'name' | 'method' | 'provider' | 'model' | 'started' | 'time' | 'output';

/** Desired state for a single row, diffed against the slot currently rendered. */
interface RowDesc {
  id: string;
  name: string;
  method: string;
  provider: string;
  model: string;
  started: string;
  time: string;
  output: string;
  nameColor: string;
  actionText: string;
  isKill: boolean;
  /** Raw values for column sorting. */
  sort: Record<SortCol, string | number>;
}

const HEADER_COLUMNS: Array<{ col: SortCol; text: string; width?: number }> = [
  { col: 'name', text: 'Requester' },
  { col: 'method', text: 'Method', width: 70 },
  { col: 'provider', text: 'Provider', width: 80 },
  { col: 'model', text: 'Model', width: 120 },
  { col: 'started', text: 'Started', width: 62 },
  { col: 'time', text: 'Time', width: 50 },
  { col: 'output', text: 'Output', width: 60 },
];

/** Numeric columns read best newest/biggest first; text columns A→Z. */
function defaultSortDir(col: SortCol): 1 | -1 {
  return col === 'started' || col === 'time' || col === 'output' ? -1 : 1;
}

export class LLMMonitor extends Abject {
  private widgetManagerId?: AbjectId;
  private llmObjectId?: AbjectId;

  // Main window
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private pauseBtnId?: AbjectId;
  private unpauseBtnId?: AbjectId;
  private refreshBtnId?: AbjectId;
  private statsLabelId?: AbjectId;
  private pauseStatusLabelId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private tabContents: AbjectId[] = [];       // [activeTab, historyTab]
  private activeTabListId?: AbjectId;
  private historyTabListId?: AbjectId;
  private selectedTabIndex: number = 0;

  private killButtons: Map<AbjectId, string> = new Map();
  private viewButtons: Map<AbjectId, string> = new Map();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;

  /**
   * Debounce for event-driven refreshes. LLM request start/complete events can
   * arrive in bursts; collapsing them into a single refresh avoids redundant
   * reconciliation passes against the shared WidgetManager.
   */
  private refreshScheduled = false;
  private refreshDebounceTimer?: ReturnType<typeof setTimeout>;
  private static readonly REFRESH_DEBOUNCE_MS = 300;

  /**
   * Per-tab rendered rows, in display order (index 0 = Active, 1 = History).
   * Rows are reconciled incrementally against the latest snapshot: only rows
   * whose request id appeared/disappeared are created/destroyed, and surviving
   * active rows get cheap in-place label updates. This bounds WidgetManager
   * traffic to the handful of rows that actually changed per refresh, instead
   * of destroying and recreating the entire list on every LLM event.
   */
  private tabRows: RowWidgets[][] = [[], []];
  /** Header row container per tab (undefined = not yet built). */
  private headerIds: (AbjectId | undefined)[] = [undefined, undefined];
  /** "No active requests" / "No history yet" placeholder per tab (undefined = not shown). */
  private emptyIds: (AbjectId | undefined)[] = [undefined, undefined];

  /**
   * Sort state per tab. Defaults to newest-on-top. Persists across window
   * close/reopen (not reset in clearViewTracking) so the user's chosen sort
   * sticks for the session.
   */
  private tabSort: Array<{ col: SortCol; dir: 1 | -1 }> = [
    { col: 'started', dir: -1 },
    { col: 'started', dir: -1 },
  ];
  /** Clickable header label → which tab/column it sorts. */
  private headerSortLabels: Map<AbjectId, { tab: number; col: SortCol }> = new Map();
  /** Header label ids per tab, in HEADER_COLUMNS order (for indicator updates). */
  private headerLabelIds: AbjectId[][] = [[], []];

  // Detail window
  private detailWindowId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'LLMMonitor',
        description:
          'Real-time viewer for LLM request activity, history, and aggregate stats. Shows active requests, recent history with prompt/output inspection, and provides pause/kill controls.',
        version: '1.0.0',
        interface: {
          id: LLM_MONITOR_INTERFACE,
          name: 'LLMMonitor',
          description: 'LLM activity monitor',
          methods: [
            {
              name: 'show',
              description: 'Show the LLM monitor window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the LLM monitor window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return current state',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display LLM monitor window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.llmObjectId = await this.discoverDep('LLM') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({ visible: !!this.windowId }));

    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      const { windowId } = (msg.payload ?? {}) as { windowId?: AbjectId };
      if (windowId === this.detailWindowId) {
        await this.hideDetail();
      } else {
        await this.hide();
      }
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };

      // Tab bar change -- show/hide tab content
      if (msg.routing.from === this.tabBarId && aspect === 'change') {
        const idx = parseInt(value as string);
        this.selectedTabIndex = idx;
        for (let i = 0; i < this.tabContents.length; i++) {
          await this.request(request(this.id, this.tabContents[i], 'update', {
            style: { visible: i === idx },
          }));
        }
        return;
      }

      if (aspect === 'click') {
        const fromId = msg.routing.from;
        await this.handleClick(fromId);
        return;
      }

      if (
        aspect === 'requestStarted' ||
        aspect === 'requestCompleted' ||
        aspect === 'requestError' ||
        aspect === 'paused' ||
        aspect === 'unpaused'
      ) {
        if (this.windowId) {
          this.scheduleRefresh();
        }
      }
    });
  }

  // -- Show / Hide --

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    if (this.llmObjectId) {
      this.send(request(this.id, this.llmObjectId, 'addDependent', {}));
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'The Eye: LLM Monitor',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    await this.populateView();
    this.changed('visibility', true);

    this.refreshTimer = setInterval(() => {
      if (this.windowId) {
        this.refreshView().catch(() => {});
      }
    }, 2000);

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = undefined;
    }
    this.refreshScheduled = false;

    await this.hideDetail();

    if (this.llmObjectId) {
      this.send(request(this.id, this.llmObjectId, 'removeDependent', {}));
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.clearViewTracking();
    this.changed('visibility', false);
    return true;
  }

  private clearViewTracking(): void {
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.tabContents = [];
    this.activeTabListId = undefined;
    this.historyTabListId = undefined;
    this.selectedTabIndex = 0;
    this.pauseBtnId = undefined;
    this.unpauseBtnId = undefined;
    this.refreshBtnId = undefined;
    this.statsLabelId = undefined;
    this.pauseStatusLabelId = undefined;
    this.killButtons.clear();
    this.viewButtons.clear();
    this.tabRows = [[], []];
    this.headerIds = [undefined, undefined];
    this.emptyIds = [undefined, undefined];
    this.headerSortLabels.clear();
    this.headerLabelIds = [[], []];
    this.refreshing = false;
  }

  // -- Main View --

  private async populateView(): Promise<void> {
    if (this.rootLayoutId && this.windowId) {
      try {
        await this.request(request(this.id, this.windowId, 'removeChild', { widgetId: this.rootLayoutId }));
      } catch { /* may be gone */ }
      try {
        await this.request(request(this.id, this.rootLayoutId, 'destroy', {}));
      } catch { /* already gone */ }
    }
    this.clearViewTracking();

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId!,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // Control bar
    const controlBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: controlBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const { widgetIds: [pauseId, unpauseId, refreshId, pauseStatusId, statsId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'button', windowId: this.windowId!, text: 'Pause', style: { fontSize: 12 } },
            { type: 'button', windowId: this.windowId!, text: 'Unpause', style: { fontSize: 12 } },
            { type: 'button', windowId: this.windowId!, text: 'Refresh', style: { fontSize: 12 } },
            { type: 'label', windowId: this.windowId!, text: '', style: { fontSize: 11, color: this.theme.statusWarning } },
            { type: 'label', windowId: this.windowId!, text: 'Loading stats...', style: { color: this.theme.sectionLabel, fontSize: 11 } },
          ],
        })
      );

    this.pauseBtnId = pauseId;
    this.unpauseBtnId = unpauseId;
    this.refreshBtnId = refreshId;
    this.pauseStatusLabelId = pauseStatusId;
    this.statsLabelId = statsId;

    await this.addDep(this.pauseBtnId);
    await this.addDep(this.unpauseBtnId);
    await this.addDep(this.refreshBtnId);

    await this.request(request(this.id, controlBarId, 'addLayoutChildren', {
      children: [
        { widgetId: this.pauseBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 60, height: 30 } },
        { widgetId: this.unpauseBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 70, height: 30 } },
        { widgetId: this.refreshBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 60, height: 30 } },
        { widgetId: this.pauseStatusLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
      ],
    }));

    // Stats label
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.statsLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // Tab bar
    const { widgetIds: [tabBarWidgetId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'tabBar',
          windowId: this.windowId!,
          tabs: ['Active Requests', 'Recent History'],
          selectedIndex: 0,
          closable: false,
        }],
      })
    );
    this.tabBarId = tabBarWidgetId;
    await this.addDep(this.tabBarId);
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Two tab content ScrollableVBoxes
    this.tabContents = [];
    for (let i = 0; i < 2; i++) {
      const tabVBox = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createScrollableVBox', {
          windowId: this.windowId!,
          margins: { top: 4, right: 0, bottom: 0, left: 0 },
          spacing: 2,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
        widgetId: tabVBox,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
      if (i > 0) {
        await this.request(request(this.id, tabVBox, 'update', {
          style: { visible: false },
        }));
      }
      this.tabContents.push(tabVBox);
    }
    this.activeTabListId = this.tabContents[0];
    this.historyTabListId = this.tabContents[1];

    // clearViewTracking() above reset row state, so this first refresh builds
    // every row from empty via the normal incremental reconcile path.
    await this.refreshView();
  }

  /**
   * Coalesce a burst of LLM events into a single refresh after a short delay.
   * Direct user actions (button clicks, manual refresh) still call refreshView()
   * synchronously for immediate feedback.
   */
  private scheduleRefresh(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshScheduled = false;
      this.refreshDebounceTimer = undefined;
      if (this.windowId) {
        this.refreshView().catch((err) => log.warn('Failed to refresh LLM monitor:', err));
      }
    }, LLMMonitor.REFRESH_DEBOUNCE_MS);
  }

  /**
   * Refresh the view by reconciling rendered rows against the latest snapshot.
   * Only rows that appeared or disappeared are created/destroyed; surviving
   * active rows get cheap in-place label updates.
   */
  private async refreshView(): Promise<void> {
    if (!this.activeTabListId || !this.historyTabListId || !this.rootLayoutId || !this.windowId) return;
    if (this.refreshing) return;
    this.refreshing = true;
    try { await this.refreshViewInner(); } finally { this.refreshing = false; }
  }

  private async refreshViewInner(): Promise<void> {

    // Fetch snapshot
    let snapshot: StatsSnapshot | null = null;
    if (this.llmObjectId) {
      try {
        snapshot = await this.request<StatsSnapshot>(
          request(this.id, this.llmObjectId, 'getStats', {})
        );
      } catch (err) {
        log.warn('Failed to fetch LLM stats:', err);
      }
    }

    // Always update stats and pause labels in-place (no flicker)
    await this.updateStatsLabel(snapshot);
    await this.updatePauseLabel(snapshot);

    const now = Date.now();
    const activeRequests = snapshot?.activeRequests ?? [];
    const history = snapshot?.history ?? [];

    // Active tab: one row per active request. Capped (keeping the newest by
    // arrival) so a burst of concurrent requests can't create unbounded row
    // widgets; history is already capped upstream by the LLM object.
    const MAX_ACTIVE_ROWS = 30;
    const cappedActive = activeRequests.length > MAX_ACTIVE_ROWS
      ? activeRequests.slice(-MAX_ACTIVE_ROWS)
      : activeRequests;
    const activeDesc: RowDesc[] = cappedActive.map((req) => {
      const elapsedSec = Math.round((now - req.startTime) / 1000);
      return {
        id: req.id,
        name: req.callerName ?? req.callerId.slice(0, 8),
        method: req.method,
        provider: req.provider,
        model: req.model ?? '',
        started: this.formatClock(req.startTime),
        time: `${elapsedSec}s`,
        output: `${req.outputChars}`,
        nameColor: req.streaming ? this.theme.statusSuccess : this.theme.textMeta,
        actionText: 'Kill',
        isKill: true,
        sort: {
          name: (req.callerName ?? req.callerId).toLowerCase(),
          method: req.method,
          provider: req.provider,
          model: req.model ?? '',
          started: req.startTime,
          time: elapsedSec,
          output: req.outputChars,
        },
      };
    });

    const historyDesc: RowDesc[] = history.map((entry) => ({
      id: entry.id,
      name: entry.callerName ?? entry.callerId.slice(0, 8),
      method: entry.method,
      provider: entry.provider,
      model: entry.model ?? '',
      started: this.formatClock(entry.startTime),
      time: `${(entry.elapsedMs / 1000).toFixed(1)}s`,
      output: `${entry.outputChars}`,
      nameColor: entry.error ? this.theme.statusError : this.theme.textHeading,
      actionText: 'View',
      isKill: false,
      sort: {
        name: (entry.callerName ?? entry.callerId).toLowerCase(),
        method: entry.method,
        provider: entry.provider,
        model: entry.model ?? '',
        started: entry.startTime,
        time: entry.elapsedMs,
        output: entry.outputChars,
      },
    }));

    // Order by the tab's sort state (default: started, newest on top). Rows
    // render as fixed slots, so re-ordering is just in-place cell updates.
    this.sortDescs(activeDesc, this.tabSort[0]);
    this.sortDescs(historyDesc, this.tabSort[1]);

    await this.reconcileTab(0, this.activeTabListId!, activeDesc, true, 'No active requests');
    await this.reconcileTab(1, this.historyTabListId!, historyDesc, false, 'No history yet');
  }

  private sortDescs(descs: RowDesc[], sort: { col: SortCol; dir: 1 | -1 }): void {
    descs.sort((a, b) => {
      const av = a.sort[sort.col];
      const bv = b.sort[sort.col];
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
      // Stable tiebreak on id so equal keys don't jitter between refreshes.
      return (cmp * sort.dir) || a.id.localeCompare(b.id);
    });
  }

  private formatClock(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  /**
   * Reconcile one tab's rendered rows against the desired (already sorted)
   * row list. Rows are fixed slots: slot i renders desired[i], with cells
   * updated in place only when their value changed. Widgets are created or
   * destroyed only when the row COUNT changes, so any ordering — newest on
   * top, column sorts flipping — costs a handful of label updates, never a
   * teardown.
   */
  private async reconcileTab(
    tabIndex: number,
    listId: AbjectId,
    desired: RowDesc[],
    alwaysHeader: boolean,
    emptyText: string,
  ): Promise<void> {
    const hasData = desired.length > 0;

    // Header: present for the active tab always; for history only when non-empty.
    if (alwaysHeader || hasData) {
      if (this.headerIds[tabIndex] === undefined) {
        this.headerIds[tabIndex] = await this.addHeaderRow(tabIndex, listId);
      }
    } else if (this.headerIds[tabIndex] !== undefined) {
      await this.destroyWidget(listId, this.headerIds[tabIndex]!);
      this.headerIds[tabIndex] = undefined;
      for (const labelId of this.headerLabelIds[tabIndex]) this.headerSortLabels.delete(labelId);
      this.headerLabelIds[tabIndex] = [];
    }

    // Empty placeholder: shown only when there are no rows.
    if (!hasData && this.emptyIds[tabIndex] === undefined) {
      this.emptyIds[tabIndex] = await this.addEmptyLabel(listId, emptyText);
    } else if (hasData && this.emptyIds[tabIndex] !== undefined) {
      await this.destroyWidget(listId, this.emptyIds[tabIndex]!);
      this.emptyIds[tabIndex] = undefined;
    }

    const rows = this.tabRows[tabIndex];

    // Shrink: drop surplus slots from the end.
    while (rows.length > desired.length) {
      await this.destroyRow(listId, rows.pop()!);
    }
    // Grow: append missing slots, created directly with their content.
    while (rows.length < desired.length) {
      rows.push(await this.addRequestRow(listId, desired[rows.length]));
    }
    // Fill every slot in place (no-ops for unchanged cells).
    for (let i = 0; i < desired.length; i++) {
      await this.updateRowSlot(rows[i], desired[i]);
    }
  }

  /** Update a slot's cells to render `d`, sending only the cells that changed. */
  private async updateRowSlot(row: RowWidgets, d: RowDesc): Promise<void> {
    const prev = row.desc;
    if (prev === d) return;
    try {
      if (!prev || prev.name !== d.name || prev.nameColor !== d.nameColor) {
        await this.request(request(this.id, row.labels[0], 'update', { text: d.name, style: { color: d.nameColor } }));
      }
      if (!prev || prev.method !== d.method) {
        await this.request(request(this.id, row.labels[1], 'update', { text: d.method }));
      }
      if (!prev || prev.provider !== d.provider) {
        await this.request(request(this.id, row.labels[2], 'update', { text: d.provider }));
      }
      if (!prev || prev.model !== d.model) {
        await this.request(request(this.id, row.labels[3], 'update', { text: d.model }));
      }
      if (!prev || prev.started !== d.started) {
        await this.request(request(this.id, row.labels[4], 'update', { text: d.started }));
      }
      if (!prev || prev.time !== d.time) {
        await this.request(request(this.id, row.labels[5], 'update', { text: d.time }));
      }
      if (!prev || prev.output !== d.output) {
        await this.request(request(this.id, row.labels[6], 'update', { text: d.output }));
      }
      // Rebind the action button when the slot now shows a different request.
      // isKill/actionText are constant within a tab, so only the id mapping moves.
      if (!prev || prev.id !== d.id || prev.isKill !== d.isKill) {
        this.killButtons.delete(row.btn);
        this.viewButtons.delete(row.btn);
        (d.isKill ? this.killButtons : this.viewButtons).set(row.btn, d.id);
      }
      row.requestId = d.id;
      row.desc = d;
    } catch { /* widget gone */ }
  }

  /** Detach a row from its tab list and destroy it (cascades to its labels + button). */
  private async destroyRow(listId: AbjectId, row: RowWidgets): Promise<void> {
    this.killButtons.delete(row.btn);
    this.viewButtons.delete(row.btn);
    await this.destroyWidget(listId, row.containerId);
  }

  /** Remove a widget from a layout and destroy it. */
  private async destroyWidget(listId: AbjectId, widgetId: AbjectId): Promise<void> {
    try {
      await this.request(request(this.id, listId, 'removeLayoutChild', { widgetId }));
    } catch { /* may be gone */ }
    try {
      await this.request(request(this.id, widgetId, 'destroy', {}));
    } catch { /* already gone */ }
  }

  private async updateStatsLabel(snapshot: StatsSnapshot | null): Promise<void> {
    if (!this.statsLabelId) return;
    const stats = snapshot?.stats;
    const avgMs = stats && stats.totalRequests > 0
      ? Math.round(stats.totalLatencyMs / stats.totalRequests)
      : 0;
    const statsText = stats
      ? `${stats.totalRequests} requests | ${this.formatCount(stats.totalInputChars)} in | ${this.formatCount(stats.totalOutputChars)} out | ${stats.totalErrors} errors | avg ${avgMs}ms`
      : 'No LLM provider available';
    try {
      await this.request(request(this.id, this.statsLabelId, 'update', { text: statsText }));
    } catch { /* widget gone */ }
  }

  private async updatePauseLabel(snapshot: StatsSnapshot | null): Promise<void> {
    if (!this.pauseStatusLabelId) return;
    const paused = snapshot?.paused ?? false;
    try {
      await this.request(request(this.id, this.pauseStatusLabelId, 'update', {
        text: paused ? 'PAUSED' : '',
        style: { color: paused ? this.theme.statusError : this.theme.statusSuccess },
      }));
    } catch { /* widget gone */ }
  }

  // -- Row Helpers --

  /**
   * Build a tab's header row. Column headers are clickable labels that sort
   * the tab: click toggles direction on the active column, or switches to the
   * clicked column at its natural direction (numeric desc, text asc). The
   * active column carries a ▼/▲ indicator.
   */
  private async addHeaderRow(tabIndex: number, targetLayoutId: AbjectId): Promise<AbjectId> {
    const headerStyle = { color: this.theme.sectionLabel, fontSize: 10, fontWeight: 'bold' };

    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: targetLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, targetLayoutId, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    const specs = HEADER_COLUMNS.map((c) => ({
      type: 'label' as const, windowId: this.windowId!,
      text: this.headerText(tabIndex, c.col), style: headerStyle,
    }));
    // Trailing spacer over the action-button column (not sortable).
    specs.push({ type: 'label' as const, windowId: this.windowId!, text: '', style: headerStyle });

    const { widgetIds: labelIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    const widths: Array<number | undefined> = [...HEADER_COLUMNS.map((c) => c.width), 50];
    for (let h = 0; h < labelIds.length; h++) {
      const width = widths[h];
      await this.request(request(this.id, headerRowId, 'addLayoutChild', {
        widgetId: labelIds[h],
        sizePolicy: { vertical: 'fixed', horizontal: width ? 'fixed' : 'expanding' },
        preferredSize: width ? { width, height: 18 } : { height: 18 },
      }));
    }

    this.headerLabelIds[tabIndex] = labelIds.slice(0, HEADER_COLUMNS.length);
    for (let h = 0; h < HEADER_COLUMNS.length; h++) {
      this.headerSortLabels.set(labelIds[h], { tab: tabIndex, col: HEADER_COLUMNS[h].col });
      await this.addDep(labelIds[h]);
    }
    return headerRowId;
  }

  private headerText(tabIndex: number, col: SortCol): string {
    const base = HEADER_COLUMNS.find((c) => c.col === col)!.text;
    const sort = this.tabSort[tabIndex];
    if (sort.col !== col) return base;
    return `${base} ${sort.dir === -1 ? '▼' : '▲'}`;
  }

  /** Re-render a tab's header texts after its sort state changed. */
  private async updateHeaderIndicators(tabIndex: number): Promise<void> {
    const labelIds = this.headerLabelIds[tabIndex];
    for (let h = 0; h < labelIds.length; h++) {
      try {
        await this.request(request(this.id, labelIds[h], 'update', {
          text: this.headerText(tabIndex, HEADER_COLUMNS[h].col),
        }));
      } catch { /* widget gone */ }
    }
  }

  private async addEmptyLabel(targetLayoutId: AbjectId, text: string): Promise<AbjectId> {
    const { widgetIds: [emptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId!, text, style: { fontSize: 12, color: this.theme.sectionLabel, fontStyle: 'italic' } },
        ],
      })
    );
    await this.request(request(this.id, targetLayoutId, 'addLayoutChild', {
      widgetId: emptyId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 26 },
    }));
    return emptyId;
  }

  private async addRequestRow(targetLayoutId: AbjectId, d: RowDesc): Promise<RowWidgets> {
    const rowH = 26;
    const rowLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: targetLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, targetLayoutId, 'addLayoutChild', {
      widgetId: rowLayoutId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: rowH },
    }));

    const { widgetIds: [nameId, methodId, providerId, modelId, startedId, timeId, outputId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.windowId!, text: d.name, style: { fontSize: 12, color: d.nameColor } },
            { type: 'label', windowId: this.windowId!, text: d.method, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.windowId!, text: d.provider, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.windowId!, text: d.model, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.windowId!, text: d.started, style: { fontSize: 11, color: this.theme.textMeta } },
            { type: 'label', windowId: this.windowId!, text: d.time, style: { fontSize: 11, color: this.theme.textMeta } },
            { type: 'label', windowId: this.windowId!, text: d.output, style: { fontSize: 11, color: this.theme.textMeta } },
          ],
        })
      );
    await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
      widgetId: nameId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: rowH },
    }));
    for (const [wid, w] of [[methodId, 70], [providerId, 80], [modelId, 120], [startedId, 62], [timeId, 50], [outputId, 60]] as const) {
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: wid,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: w, height: rowH },
      }));
    }

    // Action button
    const btnStyle = d.isKill
      ? { fontSize: 10, background: this.theme.destructiveText, color: '#ffffff', borderColor: this.theme.destructiveText }
      : { fontSize: 10 };

    const { widgetIds: [btnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId!, text: d.actionText, style: btnStyle },
        ],
      })
    );
    await this.addDep(btnId);
    if (d.isKill) {
      this.killButtons.set(btnId, d.id);
    } else {
      this.viewButtons.set(btnId, d.id);
    }
    await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
      widgetId: btnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 50, height: rowH },
    }));

    return {
      requestId: d.id,
      containerId: rowLayoutId,
      labels: [nameId, methodId, providerId, modelId, startedId, timeId, outputId],
      btn: btnId,
      desc: d,
    };
  }

  // -- Detail View --

  private async showDetail(entry: LLMHistoryEntry): Promise<void> {
    await this.hideDetail();

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - DETAIL_W) / 2) + 30);
    const winY = Math.max(20, Math.floor((displayInfo.height - DETAIL_H) / 2) + 30);

    const callerName = entry.callerName ?? entry.callerId.slice(0, 8);
    const title = `Request Detail: ${callerName} > ${entry.method}`;

    this.detailWindowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title,
        rect: { x: winX, y: winY, width: DETAIL_W, height: DETAIL_H },
        zIndex: 210,
        resizable: true,
      })
    );

    const rootId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.detailWindowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    const timeSec = (entry.elapsedMs / 1000).toFixed(1);
    const modelPart = entry.model ? ` | Model: ${entry.model}` : '';
    const summaryText = entry.error
      ? `Provider: ${entry.provider}${modelPart} | Time: ${timeSec}s | Error: ${entry.error}`
      : `Provider: ${entry.provider}${modelPart} | Time: ${timeSec}s | Chars: ${entry.inputChars} > ${entry.outputChars}`;

    const { widgetIds: [summaryId, promptLabelId, promptAreaId, outputLabelId, outputAreaId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.detailWindowId, text: summaryText, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.detailWindowId, text: 'Prompt:', style: { fontSize: 11, color: this.theme.accent, fontWeight: 'bold' } },
            { type: 'textArea', windowId: this.detailWindowId, text: entry.inputMessages || '(no input captured)', style: { fontSize: 11, wordWrap: true }, readOnly: true },
            { type: 'label', windowId: this.detailWindowId, text: 'Output:', style: { fontSize: 11, color: this.theme.accent, fontWeight: 'bold' } },
            { type: 'textArea', windowId: this.detailWindowId, text: entry.outputContent || '(no output)', style: { fontSize: 11, wordWrap: true }, readOnly: true },
          ],
        })
      );

    await this.request(request(this.id, rootId, 'addLayoutChildren', {
      children: [
        { widgetId: summaryId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
        { widgetId: promptLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
        { widgetId: promptAreaId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: outputLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
        { widgetId: outputAreaId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));
  }

  private async hideDetail(): Promise<void> {
    if (!this.detailWindowId) return;
    try {
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.detailWindowId,
        })
      );
    } catch { /* may already be gone */ }
    this.detailWindowId = undefined;
  }

  // -- Event Handling --

  private async handleClick(fromId: AbjectId): Promise<void> {
    if (fromId === this.pauseBtnId) {
      if (this.llmObjectId) {
        try {
          await this.request(request(this.id, this.llmObjectId, 'pause', {}));
        } catch (err) {
          log.warn('Failed to pause LLM:', err);
        }
        await this.refreshView();
      }
      return;
    }

    if (fromId === this.unpauseBtnId) {
      if (this.llmObjectId) {
        try {
          await this.request(request(this.id, this.llmObjectId, 'unpause', {}));
        } catch (err) {
          log.warn('Failed to unpause LLM:', err);
        }
        await this.refreshView();
      }
      return;
    }

    if (fromId === this.refreshBtnId) {
      await this.refreshView();
      return;
    }

    // Column header click: toggle direction on the active column, or switch
    // to the clicked column at its natural direction.
    const sortRef = this.headerSortLabels.get(fromId);
    if (sortRef) {
      const current = this.tabSort[sortRef.tab];
      if (current.col === sortRef.col) {
        current.dir = current.dir === 1 ? -1 : 1;
      } else {
        this.tabSort[sortRef.tab] = { col: sortRef.col, dir: defaultSortDir(sortRef.col) };
      }
      await this.updateHeaderIndicators(sortRef.tab);
      await this.refreshView();
      return;
    }

    const killId = this.killButtons.get(fromId);
    if (killId && this.llmObjectId) {
      try {
        await this.request(request(this.id, this.llmObjectId, 'killRequest', { requestId: killId }));
      } catch (err) {
        log.warn('Failed to kill request:', err);
      }
      await this.refreshView();
      return;
    }

    const viewId = this.viewButtons.get(fromId);
    if (viewId && this.llmObjectId) {
      try {
        const entry = await this.request<LLMHistoryEntry | null>(
          request(this.id, this.llmObjectId, 'getRequestDetail', { requestId: viewId })
        );
        if (entry) {
          await this.showDetail(entry);
        }
      } catch (err) {
        log.warn('Failed to fetch request detail:', err);
      }
      return;
    }
  }

  // -- Helpers --

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  private formatCount(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return String(count);
  }

  protected override async onStop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = undefined;
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## LLMMonitor Usage Guide

### Methods
- \`show()\` -- Open the LLM monitor window. Shows active requests, history, and stats.
- \`hide()\` -- Close the LLM monitor window.
- \`getState()\` -- Returns { visible: boolean }.

### Features
- Real-time view of active LLM requests with kill controls.
- Recent history of completed requests (newest on top by default) with View button to inspect prompt and output.
- Columns: Requester, Method, Provider, Model (the concrete model id the request ran on), Started (wall-clock HH:MM:SS), Time (elapsed), Output. Click any column header to sort by it; clicking again flips the direction (▼/▲ marks the active column).
- Aggregate stats: total requests, input/output chars, errors, average latency.
- Pause/Unpause buttons to control the LLM object.
- Flicker-free updates: rows are fixed slots whose cells update in place, so re-sorting or new arrivals never rebuild the list.
- Auto-refreshes every 2 seconds and on LLM state change events (event-driven refreshes are debounced).

### Interface ID
\`abjects:llm-monitor\``;
  }
}

export const LLM_MONITOR_ID = 'abjects:llm-monitor' as AbjectId;
