/**
 * LLMMonitor -- real-time viewer over the LLM object's call ledger.
 *
 * Every tab is a view of the same thing. Active Requests are the ledger
 * entries still in flight, Recent History is the settled ones, and Stats
 * rolls the whole ledger up by provider, model, tier, and day. Each row
 * carries the call's token counts and what it cost; the Stats tab also owns
 * the retention policy that decides how long any of it is kept.
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
import type {
  LLMActiveRequest,
  LLMStats,
  LLMHistoryEntry,
  LLMLedgerEntry,
  LLMLedgerRetention,
  LLMSpendReport,
} from './llm-object.js';

const log = new Log('LLMMonitor');

const LLM_MONITOR_INTERFACE: InterfaceId = 'abjects:llm-monitor';

const WIN_W = 880;
const WIN_H = 500;
const DETAIL_W = 650;
const DETAIL_H = 500;

interface StatsSnapshot {
  stats: LLMStats;
  activeRequests: LLMActiveRequest[];
  history: LLMLedgerEntry[];
  retention?: LLMLedgerRetention;
  paused: boolean;
}

/**
 * Per-row widget IDs. Rows are fixed SLOTS: slot i always renders the i-th
 * entry of the sorted desired list, and cells update in place (diffed against
 * `desc`). This makes arbitrary ordering (newest-on-top, column sorts) free —
 * no layout reordering, no widget churn beyond count changes.
 * Labels are positional against HEADER_COLUMNS.
 */
interface RowWidgets {
  requestId: string;
  containerId: AbjectId;  // the row's HBox; destroying it cascades to labels + btn
  labels: AbjectId[];  // one per HEADER_COLUMNS entry, in that order
  btn: AbjectId;
  /** Last rendered desc; cells whose value is unchanged are not re-sent. */
  desc?: RowDesc;
}

/** Sortable columns, in header order. */
type SortCol = 'name' | 'method' | 'provider' | 'model' | 'started' | 'time' | 'output' | 'tokens' | 'cost';

/** Desired state for a single row, diffed against the slot currently rendered. */
interface RowDesc {
  id: string;
  /** Rendered cell text, aligned to HEADER_COLUMNS. */
  cells: string[];
  nameColor: string;
  actionText: string;
  isKill: boolean;
  /** Raw values for column sorting. */
  sort: Record<SortCol, string | number>;
}

const HEADER_COLUMNS: Array<{ col: SortCol; text: string; width?: number }> = [
  { col: 'name', text: 'Requester' },
  { col: 'method', text: 'Method', width: 62 },
  { col: 'provider', text: 'Provider', width: 72 },
  { col: 'model', text: 'Model', width: 108 },
  { col: 'started', text: 'Started', width: 58 },
  { col: 'time', text: 'Time', width: 46 },
  { col: 'output', text: 'Chars', width: 52 },
  { col: 'tokens', text: 'Tokens', width: 92 },
  { col: 'cost', text: 'Cost', width: 66 },
];

/** Numeric columns read best newest/biggest first; text columns A→Z. */
function defaultSortDir(col: SortCol): 1 | -1 {
  return col === 'started' || col === 'time' || col === 'output'
    || col === 'tokens' || col === 'cost' ? -1 : 1;
}

/** Compact token summary for a request row: in/out, with cache reads noted. */
function formatTokens(usage?: {
  inputTokens: number; outputTokens: number; cacheReadTokens?: number;
}): string {
  if (!usage) return '';
  const cached = usage.cacheReadTokens ? `+${compactCount(usage.cacheReadTokens)}c` : '';
  return `${compactCount(usage.inputTokens)}/${compactCount(usage.outputTokens)}${cached}`;
}

/** Did generation stop because it ran out of room rather than finishing? */
function isTruncated(e: LLMLedgerEntry): boolean {
  return e.finishReason === 'length' || e.finishReason === 'max_tokens';
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Spend table columns. Numeric cells carry raw numbers rather than
 * pre-formatted strings so the table's own header-click sort compares them
 * numerically — "$9.10" sorts above "$12.00" as text, which is exactly the
 * wrong answer for a spend view. Units live in the headers instead.
 */
const STATS_COLUMNS = [
  { key: 'provider', label: 'Provider', width: 90 },
  { key: 'model', label: 'Model' },
  { key: 'requests', label: 'Reqs', width: 60, align: 'right' as const },
  { key: 'inputTokens', label: 'In tok', width: 80, align: 'right' as const },
  { key: 'outputTokens', label: 'Out tok', width: 80, align: 'right' as const },
  { key: 'cachedTokens', label: 'Cached', width: 80, align: 'right' as const },
  { key: 'cost', label: 'Cost $', width: 80, align: 'right' as const },
  { key: 'session', label: 'Session $', width: 80, align: 'right' as const },
];

/** One row of the spend table. */
interface StatsRow extends Record<string, unknown> {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  session: number;
}

/** Money with enough precision to see a single cheap call, without noise. */
function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(5)}`;
  if (Math.abs(amount) < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Round to cents-and-then-some for table cells, keeping the value numeric. */
function roundUsd(amount: number): number {
  return Math.round(amount * 100000) / 100000;
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
  private tabContents: AbjectId[] = [];       // [activeTab, historyTab, spendTab]
  private activeTabListId?: AbjectId;
  private historyTabListId?: AbjectId;
  private selectedTabIndex: number = 0;

  // Spend tab
  private statsSummaryId?: AbjectId;
  private statsNoteId?: AbjectId;
  private statsChartId?: AbjectId;
  private statsTableId?: AbjectId;
  private clearLedgerBtnId?: AbjectId;
  private retentionDaysInputId?: AbjectId;
  private retentionEntriesInputId?: AbjectId;
  private residentTextInputId?: AbjectId;
  private applyRetentionBtnId?: AbjectId;
  private footerNoteId?: AbjectId;
  /** Last rendered spend rows, so an unchanged ledger costs no widget traffic. */
  private lastStatsRowsJson?: string;
  private lastStatsDaysJson?: string;
  /** Retention last written into the inputs, so typing is not overwritten mid-edit. */
  private lastRetentionJson?: string;

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
        // Spend is only fetched while its tab shows, so switching to it has
        // to pull the ledger rather than wait out the refresh interval.
        await this.refreshStatsTab();
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
    this.statsSummaryId = undefined;
    this.statsNoteId = undefined;
    this.statsChartId = undefined;
    this.statsTableId = undefined;
    this.clearLedgerBtnId = undefined;
    this.retentionDaysInputId = undefined;
    this.retentionEntriesInputId = undefined;
    this.residentTextInputId = undefined;
    this.applyRetentionBtnId = undefined;
    this.footerNoteId = undefined;
    this.lastStatsRowsJson = undefined;
    this.lastStatsDaysJson = undefined;
    this.lastRetentionJson = undefined;
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
          tabs: ['Active Requests', 'Recent History', 'Stats'],
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

    await this.buildStatsTab();

    // clearViewTracking() above reset row state, so this first refresh builds
    // every row from empty via the normal incremental reconcile path.
    await this.refreshView();
  }

  /**
   * Build the Spend tab: headline totals, the per-day cost bars, and a
   * sortable per-model table. Unlike the request tabs this one is a table
   * widget rather than hand-reconciled rows — the data is a small aggregate
   * that is cheap to re-send whole, and the widget brings its own sorting.
   */
  private async buildStatsTab(): Promise<void> {
    const spendBox = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId!,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: spendBox,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    await this.request(request(this.id, spendBox, 'update', { style: { visible: false } }));
    this.tabContents.push(spendBox);

    const { widgetIds: [summaryId, noteId, chartId, tableId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.windowId!, text: 'Loading spend...', style: { fontSize: 13, fontWeight: 'bold', color: this.theme.textHeading } },
            { type: 'label', windowId: this.windowId!, text: '', style: { fontSize: 11, color: this.theme.sectionLabel } },
            {
              type: 'chart', windowId: this.windowId!, kind: 'bar',
              series: [{ name: 'Cost (USD)', points: [] }],
              showGrid: true, showLegend: false,
            },
            {
              type: 'table', windowId: this.windowId!, sortable: true,
              columns: STATS_COLUMNS,
              rowsData: [],
            },
          ],
        })
      );

    this.statsSummaryId = summaryId;
    this.statsNoteId = noteId;
    this.statsChartId = chartId;
    this.statsTableId = tableId;

    await this.request(request(this.id, spendBox, 'addLayoutChildren', {
      children: [
        { widgetId: summaryId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 20 } },
        { widgetId: noteId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: chartId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 110 } },
        { widgetId: tableId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Footer: clearing the ledger is destructive and rare, so it lives here
    // rather than in the window-wide control bar.
    const footerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: spendBox,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, spendBox, 'addLayoutChild', {
      widgetId: footerId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 26 },
    }));

    const { widgetIds: [keepLabelId, daysInputId, entriesLabelId, entriesInputId, bodiesLabelId, bodyDaysInputId, applyId, resetId, footerNoteId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.windowId!, text: 'Keep (days)', style: { fontSize: 10, color: this.theme.sectionLabel } },
            { type: 'input', windowId: this.windowId!, text: '', style: { fontSize: 10 } },
            { type: 'label', windowId: this.windowId!, text: 'max calls', style: { fontSize: 10, color: this.theme.sectionLabel } },
            { type: 'input', windowId: this.windowId!, text: '', style: { fontSize: 10 } },
            { type: 'label', windowId: this.windowId!, text: 'prompts in memory', style: { fontSize: 10, color: this.theme.sectionLabel } },
            { type: 'input', windowId: this.windowId!, text: '', style: { fontSize: 10 } },
            { type: 'button', windowId: this.windowId!, text: 'Apply', style: { fontSize: 10 } },
            { type: 'button', windowId: this.windowId!, text: 'Clear ledger', style: { fontSize: 10, background: this.theme.destructiveText, color: '#ffffff', borderColor: this.theme.destructiveText } },
            { type: 'label', windowId: this.windowId!, text: '', style: { fontSize: 10, color: this.theme.sectionLabel, fontStyle: 'italic' } },
          ],
        })
      );
    this.retentionDaysInputId = daysInputId;
    this.retentionEntriesInputId = entriesInputId;
    this.residentTextInputId = bodyDaysInputId;
    this.applyRetentionBtnId = applyId;
    this.clearLedgerBtnId = resetId;
    this.footerNoteId = footerNoteId;
    await this.addDep(applyId);
    await this.addDep(resetId);
    await this.request(request(this.id, footerId, 'addLayoutChildren', {
      children: [
        { widgetId: keepLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 62, height: 24 } },
        { widgetId: daysInputId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 44, height: 24 } },
        { widgetId: entriesLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 54, height: 24 } },
        { widgetId: entriesInputId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 54, height: 24 } },
        { widgetId: bodiesLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 96, height: 24 } },
        { widgetId: bodyDaysInputId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 44, height: 24 } },
        { widgetId: applyId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 54, height: 24 } },
        { widgetId: resetId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 84, height: 24 } },
        { widgetId: footerNoteId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 24 } },
      ],
    }));
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
    await this.refreshStatsTab();

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
    // Both tabs render the same ledger entries; only the elapsed-time
    // reading and the row action differ between a call in flight and one
    // that has settled.
    const activeDesc: RowDesc[] = cappedActive.map((req) => {
      const elapsedSec = Math.round((now - req.startTime) / 1000);
      return this.ledgerRowDesc(req, {
        time: `${elapsedSec}s`,
        timeSort: elapsedSec,
        nameColor: req.streaming ? this.theme.statusSuccess : this.theme.textMeta,
        actionText: 'Kill',
        isKill: true,
      });
    });

    const historyDesc: RowDesc[] = history.map((entry) => this.ledgerRowDesc(entry, {
      time: `${(entry.elapsedMs / 1000).toFixed(1)}s`,
      timeSort: entry.elapsedMs,
      nameColor: entry.error ? this.theme.statusError : this.theme.textHeading,
      actionText: 'View',
      isKill: false,
    }));

    // Order by the tab's sort state (default: started, newest on top). Rows
    // render as fixed slots, so re-ordering is just in-place cell updates.
    this.sortDescs(activeDesc, this.tabSort[0]);
    this.sortDescs(historyDesc, this.tabSort[1]);

    await this.reconcileTab(0, this.activeTabListId!, activeDesc, true, 'No active requests');
    await this.reconcileTab(1, this.historyTabListId!, historyDesc, false, 'No history yet');
  }

  /**
   * Turn one ledger entry into a row. Cells are positional against
   * HEADER_COLUMNS, so adding a column is a change in one place.
   */
  private ledgerRowDesc(
    e: LLMLedgerEntry,
    opts: { time: string; timeSort: number; nameColor: string; actionText: string; isKill: boolean },
  ): RowDesc {
    const name = e.callerName ?? e.callerId.slice(0, 8);
    // A truncated answer returns normally and bills in full, so nothing else
    // in the row would tell you it was cut off. Mark the model it ran on.
    const model = (e.model ?? '') + (isTruncated(e) ? ' ✂' : '');
    const tokens = formatTokens(e.usage);
    // An unpriced call is not a free one: leave the cell blank rather than
    // printing $0.00 for a model nobody has a price for.
    const cost = e.costUsd === undefined ? '' : `${e.costEstimated ? '~' : ''}${formatUsd(e.costUsd)}`;
    return {
      id: e.id,
      cells: [
        name, e.method, e.provider, model,
        this.formatClock(e.startTime), opts.time, `${e.outputChars}`,
        tokens, cost,
      ],
      nameColor: opts.nameColor,
      actionText: opts.actionText,
      isKill: opts.isKill,
      sort: {
        name: name.toLowerCase(),
        method: e.method,
        provider: e.provider,
        model,
        started: e.startTime,
        time: opts.timeSort,
        output: e.outputChars,
        tokens: (e.usage?.inputTokens ?? 0) + (e.usage?.outputTokens ?? 0),
        cost: e.costUsd ?? -1,
      },
    };
  }

  /**
   * Pull the spend rollup and repaint the Spend tab. Only runs while that
   * tab is showing: the rollup is a separate request, and the request tabs
   * refresh every two seconds whether or not anyone is looking at spend.
   */
  private async refreshStatsTab(): Promise<void> {
    if (this.selectedTabIndex !== 2 || !this.statsTableId || !this.llmObjectId) return;

    let report: LLMSpendReport | null = null;
    try {
      report = await this.request<LLMSpendReport>(
        request(this.id, this.llmObjectId, 'getSpend', {})
      );
    } catch (err) {
      log.warn('Failed to fetch LLM spend:', err);
      return;
    }
    if (!report) return;

    const { totals } = report;
    const summary =
      `All time ${formatUsd(totals.costUsd)}` +
      `   ·   Today ${formatUsd(report.todayCostUsd)}` +
      `   ·   This session ${formatUsd(report.sessionCostUsd)}` +
      `   ·   ${totals.requests} calls across ${report.models.length} model${report.models.length === 1 ? '' : 's'}`;

    const noteParts: string[] = [];
    if (totals.reportedCostUsd > 0) noteParts.push(`${formatUsd(totals.reportedCostUsd)} billed by the provider`);
    if (totals.estimatedCostUsd > 0) noteParts.push(`${formatUsd(totals.estimatedCostUsd)} estimated from list prices`);
    if (totals.unpricedRequests > 0) {
      noteParts.push(`${totals.unpricedRequests} call${totals.unpricedRequests === 1 ? '' : 's'} unpriced (no published price for that model — set one with setModelPricing)`);
    }
    if (totals.cacheReadTokens > 0 || totals.cacheWriteTokens > 0) {
      noteParts.push(`cache ${compactCount(totals.cacheReadTokens)} read / ${compactCount(totals.cacheWriteTokens)} written`);
    }
    // Tier is how most callers pick a model, so a per-tier cut usually names
    // the expensive part of a setup faster than the per-model table does.
    if (report.byTier.length > 0) {
      const tiers = report.byTier
        .map(t => `${t.tier} ${formatUsd(t.costUsd)}`)
        .join('  ·  ');
      noteParts.push(`by tier: ${tiers}`);
    }
    const note = noteParts.length > 0 ? noteParts.join('   ·   ') : 'No calls recorded yet.';

    const rows: StatsRow[] = report.models
      .map(m => ({
        provider: m.provider,
        // An unpriced model would otherwise read as a free one; say so in
        // the row rather than letting a 0 in the cost column stand for it.
        model: m.unpricedRequests > 0 && m.costUsd === 0 ? `${m.model}  (unpriced)` : m.model,
        requests: m.requests,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cachedTokens: m.cacheReadTokens + m.cacheWriteTokens,
        cost: roundUsd(m.costUsd),
        session: roundUsd(m.sessionCostUsd),
      }))
      .sort((a, b) => b.cost - a.cost);

    const rowsJson = JSON.stringify(rows);
    if (rowsJson !== this.lastStatsRowsJson) {
      this.lastStatsRowsJson = rowsJson;
      try {
        await this.request(request(this.id, this.statsTableId, 'update', { rowsData: rows }));
      } catch { /* widget gone */ }
    }

    // Day labels shortened to MM-DD; the year is the same for every bar in a
    // 14-day window and just eats axis width.
    const points = report.days.map(d => ({ x: d.day.slice(5), y: roundUsd(d.costUsd) }));
    const daysJson = JSON.stringify(points);
    if (daysJson !== this.lastStatsDaysJson && this.statsChartId) {
      this.lastStatsDaysJson = daysJson;
      try {
        await this.request(request(this.id, this.statsChartId, 'update', {
          series: [{ name: 'Cost (USD)', points }],
        }));
      } catch { /* widget gone */ }
    }

    for (const [widgetId, text] of [[this.statsSummaryId, summary], [this.statsNoteId, note]] as const) {
      if (!widgetId) continue;
      try {
        await this.request(request(this.id, widgetId, 'update', { text }));
      } catch { /* widget gone */ }
    }

    await this.renderRetention(report);
  }

  /**
   * Show the retention policy and the window it produced. The inputs are
   * only written when the stored policy actually changed, so a refresh
   * landing mid-edit does not yank what the user is typing.
   */
  private async renderRetention(report: LLMSpendReport): Promise<void> {
    const r = report.retention;
    const json = JSON.stringify(r);
    if (json !== this.lastRetentionJson) {
      this.lastRetentionJson = json;
      const fields: Array<[AbjectId | undefined, string]> = [
        [this.retentionDaysInputId, String(r.maxAgeDays)],
        [this.retentionEntriesInputId, String(r.maxEntries)],
        [this.residentTextInputId, r.keepText ? String(r.residentTextEntries) : '0'],
      ];
      for (const [widgetId, text] of fields) {
        if (!widgetId) continue;
        try {
          await this.request(request(this.id, widgetId, 'update', { text }));
        } catch { /* widget gone */ }
      }
    }

    if (!this.footerNoteId) return;
    // Say what the totals above actually cover — a spend figure whose window
    // is unstated invites being read as all time when it is not.
    const span = report.windowStart > 0
      ? `${report.entryCount} calls recorded, ${this.formatDate(report.windowStart)} to ${this.formatDate(report.windowEnd)}`
      : 'No calls recorded yet';
    const bounds = [
      r.maxAgeDays > 0 ? `${r.maxAgeDays} days` : 'no age limit',
      r.maxEntries > 0 ? `max ${r.maxEntries} calls` : null,
    ].filter(Boolean).join(' / ');
    const text = r.keepText
      ? `prompts and completions kept with them, newest ${r.residentTextEntries} held in memory`
      : 'prompts and completions not stored';
    try {
      await this.request(request(this.id, this.footerNoteId, 'update', {
        text: `${span}. Everything rolls off at ${bounds}; ${text}.`,
      }));
    } catch { /* widget gone */ }
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Read the retention inputs and push the policy to the LLM object. */
  private async applyRetention(): Promise<void> {
    if (!this.llmObjectId) return;
    const read = async (widgetId?: AbjectId): Promise<number | undefined> => {
      if (!widgetId) return undefined;
      try {
        const v = await this.request<string>(request(this.id, widgetId, 'getValue', {}));
        const n = parseInt(String(v ?? '').trim(), 10);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };
    const maxAgeDays = await read(this.retentionDaysInputId);
    const maxEntries = await read(this.retentionEntriesInputId);
    const resident = await read(this.residentTextInputId);

    const payload: Partial<LLMLedgerRetention> = {};
    if (maxAgeDays !== undefined) payload.maxAgeDays = maxAgeDays;
    if (maxEntries !== undefined) payload.maxEntries = maxEntries;
    if (resident !== undefined) {
      // One field drives both: holding zero prompts in memory is the same
      // ask as not keeping prompts at all.
      payload.keepText = resident > 0;
      payload.residentTextEntries = resident;
    }
    if (Object.keys(payload).length === 0) return;

    try {
      await this.request(request(this.id, this.llmObjectId, 'setLedgerRetention', payload));
    } catch (err) {
      log.warn('Failed to set ledger retention:', err);
    }
    this.lastRetentionJson = undefined;
    this.lastStatsRowsJson = undefined;
    this.lastStatsDaysJson = undefined;
    await this.refreshStatsTab();
    await this.refreshView();
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
      // Column 0 carries the row's status colour as well as its text.
      if (!prev || prev.cells[0] !== d.cells[0] || prev.nameColor !== d.nameColor) {
        await this.request(request(this.id, row.labels[0], 'update', {
          text: d.cells[0], style: { color: d.nameColor },
        }));
      }
      for (let c = 1; c < HEADER_COLUMNS.length; c++) {
        if (!prev || prev.cells[c] !== d.cells[c]) {
          await this.request(request(this.id, row.labels[c], 'update', { text: d.cells[c] }));
        }
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
      ? `${stats.totalRequests} calls | ${this.formatCount(stats.totalInputTokens)} in / ${this.formatCount(stats.totalOutputTokens)} out tokens | ${stats.totalErrors} errors | avg ${avgMs}ms | ${formatUsd(stats.totalCostUsd ?? 0)} spent`
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

    // One label per column, built from HEADER_COLUMNS so a new column needs
    // no matching edit here. Cost gets the accent colour: it is the reason
    // most people open this window.
    const { widgetIds: labelIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: HEADER_COLUMNS.map((c, i) => ({
          type: 'label' as const,
          windowId: this.windowId!,
          text: d.cells[i] ?? '',
          style: i === 0
            ? { fontSize: 12, color: d.nameColor }
            : {
              fontSize: 11,
              color: c.col === 'cost' ? this.theme.accent
                : c.col === 'started' || c.col === 'time' || c.col === 'output' || c.col === 'tokens'
                  ? this.theme.textMeta
                  : this.theme.sectionLabel,
            },
        })),
      })
    );
    await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
      widgetId: labelIds[0],
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: rowH },
    }));
    for (let c = 1; c < HEADER_COLUMNS.length; c++) {
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: labelIds[c],
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: HEADER_COLUMNS[c].width, height: rowH },
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
      labels: labelIds.slice(0, HEADER_COLUMNS.length),
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

    // The detail window is where the whole ledger entry gets shown, so it
    // reports every field the row had no room for: routing, token split,
    // cost basis, and whether the answer was cut off.
    const timeSec = (entry.elapsedMs / 1000).toFixed(1);
    const parts: string[] = [`Provider: ${entry.provider}`];
    if (entry.model) parts.push(`Model: ${entry.model}`);
    if (entry.tier) parts.push(`Tier: ${entry.tier}`);
    if (entry.effort) parts.push(`Effort: ${entry.effort}`);
    parts.push(`Time: ${timeSec}s`);
    if (entry.error) {
      parts.push(`Error: ${entry.error}`);
    } else {
      parts.push(`Chars: ${entry.inputChars} > ${entry.outputChars}`);
      if (entry.usage) {
        const u = entry.usage;
        const cache = [
          u.cacheReadTokens ? `${u.cacheReadTokens} cached` : '',
          u.cacheWriteTokens ? `${u.cacheWriteTokens} written` : '',
          u.reasoningTokens ? `${u.reasoningTokens} reasoning` : '',
        ].filter(Boolean).join(', ');
        parts.push(`Tokens: ${u.inputTokens} in / ${u.outputTokens} out${cache ? ` (${cache})` : ''}`);
      }
      parts.push(entry.costUsd === undefined
        ? 'Cost: unpriced'
        : `Cost: ${formatUsd(entry.costUsd)}${entry.costEstimated ? ' (estimated from list prices)' : ' (billed by provider)'}`);
      if (isTruncated(entry)) {
        parts.push(`TRUNCATED at maxTokens${entry.maxTokens ? ` (${entry.maxTokens})` : ''} — the answer was cut off`);
      }
    }
    const summaryText = parts.join(' | ');

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

    if (fromId === this.applyRetentionBtnId) {
      await this.applyRetention();
      return;
    }

    if (fromId === this.clearLedgerBtnId) {
      if (this.llmObjectId) {
        try {
          await this.request(request(this.id, this.llmObjectId, 'clearLedger', {}));
        } catch (err) {
          log.warn('Failed to clear the ledger:', err);
        }
        this.lastStatsRowsJson = undefined;
        this.lastStatsDaysJson = undefined;
        // History and the stats line are views over the same ledger, so they
        // have to repaint too — clearing spend clears them by construction.
        await this.refreshStatsTab();
        await this.refreshView();
      }
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
- Every tab is a view over one call ledger. Each LLM call is recorded once, with its token counts and cost; nothing is aggregated separately.
- Active Requests: the calls in flight, with kill controls.
- Recent History: the settled calls, newest first, with a View button that opens the full prompt and output (when still retained) plus the call's tier, effort, token split, cost basis, and truncation state. Text for older calls is read back from storage on demand.
- Columns on both: Requester, Method, Provider, Model (with a scissors mark when the answer was cut off at maxTokens), Started (HH:MM:SS), Time, Chars, Tokens (in/out, with +Nc cache reads), Cost. Click any header to sort; click again to flip (▼/▲ marks the active column). A tilde before a cost means it was estimated from list prices rather than billed by the provider; a blank cost means the model is unpriced.
- Stats: totals for the retained window / today / this session, spend broken out by routing tier, a per-day cost chart, and a sortable per-model table of calls, tokens, cached tokens, and cost.
- Retention lives on the Stats tab: how many days to keep everything (prompts and completions included), an optional hard call ceiling, and how many recent prompts to hold in memory (0 stops storing prompt text at all). "Clear ledger" throws away every recorded call, and with it every total rolled up from them.
- The ledger persists across restarts, so yesterday's spend is still there tomorrow. The stats line describes exactly the retained window, which the Spend tab footer names.
- Pause/Unpause buttons to control the LLM object.
- Flicker-free updates: rows are fixed slots whose cells update in place, so re-sorting or new arrivals never rebuild the list.
- Auto-refreshes every 2 seconds and on LLM state change events (event-driven refreshes are debounced).

### Interface ID
\`abjects:llm-monitor\``;
  }
}

export const LLM_MONITOR_ID = 'abjects:llm-monitor' as AbjectId;
