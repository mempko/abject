/**
 * LLMMonitor -- real-time viewer for LLM request activity, history, and stats.
 *
 * Shows active requests and recent history with requester, method, provider,
 * elapsed time, and output characters. Provides controls to kill requests,
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

const WIN_W = 700;
const WIN_H = 500;
const DETAIL_W = 650;
const DETAIL_H = 500;

interface StatsSnapshot {
  stats: LLMStats;
  activeRequests: LLMActiveRequest[];
  history: LLMHistoryEntry[];
  paused: boolean;
}

/** Per-row widget IDs for in-place updates. Labels order: name, method, provider, time, output. */
interface RowWidgets {
  requestId: string;
  labels: AbjectId[];  // [name, method, provider, time, output]
  btn: AbjectId;
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

  // Row tracking for in-place updates
  private activeRows: RowWidgets[] = [];
  private historyRows: RowWidgets[] = [];
  private lastActiveIds: string[] = [];
  private lastHistoryIds: string[] = [];

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
          try {
            await this.refreshView();
          } catch (err) {
            log.warn('Failed to refresh LLM monitor:', err);
          }
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
    this.activeRows = [];
    this.historyRows = [];
    this.lastActiveIds = [];
    this.lastHistoryIds = [];
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

    // Force a full rebuild for initial population
    this.lastActiveIds = [];
    this.lastHistoryIds = [];
    await this.refreshView();
  }

  /**
   * Refresh the view. If the row structure (request IDs) hasn't changed,
   * update labels in-place to avoid flicker. Otherwise do a full rebuild.
   */
  private async refreshView(): Promise<void> {
    if (!this.activeTabListId || !this.historyTabListId || !this.rootLayoutId || !this.windowId) return;

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

    // Check if row structure changed
    const activeRequests = snapshot?.activeRequests ?? [];
    const history = snapshot?.history ?? [];
    const newActiveIds = activeRequests.map(r => r.id);
    const newHistoryIds = history.map(h => h.id);

    const structureChanged =
      !this.arraysEqual(newActiveIds, this.lastActiveIds) ||
      !this.arraysEqual(newHistoryIds, this.lastHistoryIds);

    if (structureChanged) {
      await this.rebuildScrollableList(snapshot);
    } else {
      await this.updateRowsInPlace(activeRequests, history);
    }
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

  /**
   * Update only the dynamic label text (time, output) for existing rows.
   */
  private async updateRowsInPlace(
    activeRequests: LLMActiveRequest[],
    history: LLMHistoryEntry[],
  ): Promise<void> {
    const now = Date.now();

    // Update active rows: time and output change frequently
    for (let i = 0; i < activeRequests.length && i < this.activeRows.length; i++) {
      const req = activeRequests[i];
      const row = this.activeRows[i];
      const elapsedSec = Math.round((now - req.startTime) / 1000);
      try {
        await this.request(request(this.id, row.labels[3], 'update', { text: `${elapsedSec}s` }));
        await this.request(request(this.id, row.labels[4], 'update', { text: `${req.outputChars}` }));
      } catch { /* widget gone */ }
    }
    // History rows are static, no updates needed
  }

  /**
   * Full rebuild of both tab content areas. Called when structure changes.
   */
  private async rebuildScrollableList(snapshot: StatsSnapshot | null): Promise<void> {
    if (!this.activeTabListId || !this.historyTabListId || !this.rootLayoutId || !this.windowId) return;

    this.killButtons.clear();
    this.viewButtons.clear();
    this.activeRows = [];
    this.historyRows = [];

    const now = Date.now();
    const activeRequests = snapshot?.activeRequests ?? [];
    const history = snapshot?.history ?? [];

    // Track IDs for next comparison
    this.lastActiveIds = activeRequests.map(r => r.id);
    this.lastHistoryIds = history.map(h => h.id);

    // Rebuild Active Requests tab
    await this.rebuildTabContent(0, async (targetId) => {
      await this.addHeaderRow(targetId);
      if (activeRequests.length === 0) {
        await this.addEmptyLabel(targetId, 'No active requests');
      } else {
        for (const req of activeRequests) {
          const elapsedSec = Math.round((now - req.startTime) / 1000);
          const row = await this.addRequestRow(
            targetId,
            req.callerName ?? req.callerId.slice(0, 8),
            req.method,
            req.provider,
            `${elapsedSec}s`,
            `${req.outputChars}`,
            req.streaming ? this.theme.statusSuccess : this.theme.textMeta,
            'Kill',
            req.id,
            true,
          );
          this.activeRows.push(row);
        }
      }
    });

    // Rebuild Recent History tab
    await this.rebuildTabContent(1, async (targetId) => {
      if (history.length > 0) {
        await this.addHeaderRow(targetId);
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i];
          const timeSec = (entry.elapsedMs / 1000).toFixed(1);
          const nameColor = entry.error ? this.theme.statusError : this.theme.textHeading;
          const row = await this.addRequestRow(
            targetId,
            entry.callerName ?? entry.callerId.slice(0, 8),
            entry.method,
            entry.provider,
            `${timeSec}s`,
            `${entry.outputChars}`,
            nameColor,
            'View',
            entry.id,
            false,
          );
          this.historyRows.push(row);
        }
      } else {
        await this.addEmptyLabel(targetId, 'No history yet');
      }
    });
  }

  /**
   * Destroy a tab's ScrollableVBox, recreate it, preserve visibility, and populate.
   */
  private async rebuildTabContent(
    tabIndex: number,
    populate: (targetLayoutId: AbjectId) => Promise<void>,
  ): Promise<void> {
    const oldId = this.tabContents[tabIndex];

    // Remove old from layout
    try {
      await this.request(request(this.id, this.rootLayoutId!, 'removeLayoutChild', {
        widgetId: oldId,
      }));
    } catch { /* may be gone */ }
    try {
      await this.request(request(this.id, oldId, 'destroy', {}));
    } catch { /* may be gone */ }

    // Create replacement
    const newId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createScrollableVBox', {
        windowId: this.windowId!,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 2,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: newId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Hide if not the selected tab
    if (tabIndex !== this.selectedTabIndex) {
      await this.request(request(this.id, newId, 'update', {
        style: { visible: false },
      }));
    }

    this.tabContents[tabIndex] = newId;
    if (tabIndex === 0) this.activeTabListId = newId;
    else this.historyTabListId = newId;

    await populate(newId);
  }

  // -- Row Helpers --

  private async addSectionLabel(targetLayoutId: AbjectId, text: string): Promise<void> {
    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId!, text, style: { fontSize: 11, color: this.theme.accent, fontWeight: 'bold' } },
        ],
      })
    );
    await this.request(request(this.id, targetLayoutId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 20 },
    }));
  }

  private async addHeaderRow(targetLayoutId: AbjectId): Promise<void> {
    const headerStyle = { color: this.theme.sectionLabel, fontSize: 10, fontWeight: 'bold' };
    const headerTexts = ['Requester', 'Method', 'Provider', 'Time', 'Output', ''];
    const headerWidths: Array<number | undefined> = [undefined, 70, 80, 50, 60, 50];

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

    const { widgetIds: headerLabelIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: headerTexts.map((text) => ({
          type: 'label' as const, windowId: this.windowId!, text, style: headerStyle,
        })),
      })
    );

    for (let h = 0; h < headerLabelIds.length; h++) {
      const width = headerWidths[h];
      await this.request(request(this.id, headerRowId, 'addLayoutChild', {
        widgetId: headerLabelIds[h],
        sizePolicy: { vertical: 'fixed', horizontal: width ? 'fixed' : 'expanding' },
        preferredSize: width ? { width, height: 18 } : { height: 18 },
      }));
    }
  }

  private async addEmptyLabel(targetLayoutId: AbjectId, text: string): Promise<void> {
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
  }

  private async addRequestRow(
    targetLayoutId: AbjectId,
    requesterName: string,
    method: string,
    provider: string,
    time: string,
    output: string,
    nameColor: string,
    actionText: string,
    requestId: string,
    isKill: boolean,
  ): Promise<RowWidgets> {
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

    const { widgetIds: [nameId, methodId, providerId, timeId, outputId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.windowId!, text: requesterName, style: { fontSize: 12, color: nameColor } },
            { type: 'label', windowId: this.windowId!, text: method, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.windowId!, text: provider, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.windowId!, text: time, style: { fontSize: 11, color: this.theme.textMeta } },
            { type: 'label', windowId: this.windowId!, text: output, style: { fontSize: 11, color: this.theme.textMeta } },
          ],
        })
      );

    await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
      widgetId: nameId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: rowH },
    }));
    for (const [wid, w] of [[methodId, 70], [providerId, 80], [timeId, 50], [outputId, 60]] as const) {
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: wid,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: w, height: rowH },
      }));
    }

    // Action button
    const btnStyle = isKill
      ? { fontSize: 10, background: this.theme.destructiveText, color: '#ffffff', borderColor: this.theme.destructiveText }
      : { fontSize: 10 };

    const { widgetIds: [btnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId!, text: actionText, style: btnStyle },
        ],
      })
    );
    await this.addDep(btnId);
    if (isKill) {
      this.killButtons.set(btnId, requestId);
    } else {
      this.viewButtons.set(btnId, requestId);
    }
    await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
      widgetId: btnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 50, height: rowH },
    }));

    return { requestId, labels: [nameId, methodId, providerId, timeId, outputId], btn: btnId };
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
    const summaryText = entry.error
      ? `Provider: ${entry.provider} | Time: ${timeSec}s | Error: ${entry.error}`
      : `Provider: ${entry.provider} | Time: ${timeSec}s | Chars: ${entry.inputChars} > ${entry.outputChars}`;

    const { widgetIds: [summaryId, promptLabelId, promptAreaId, outputLabelId, outputAreaId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.detailWindowId, text: summaryText, style: { fontSize: 11, color: this.theme.sectionLabel } },
            { type: 'label', windowId: this.detailWindowId, text: 'Prompt:', style: { fontSize: 11, color: this.theme.accent, fontWeight: 'bold' } },
            { type: 'textArea', windowId: this.detailWindowId, text: entry.inputMessages || '(no input captured)', style: { fontSize: 11 }, readOnly: true },
            { type: 'label', windowId: this.detailWindowId, text: 'Output:', style: { fontSize: 11, color: this.theme.accent, fontWeight: 'bold' } },
            { type: 'textArea', windowId: this.detailWindowId, text: entry.outputContent || '(no output)', style: { fontSize: 11 }, readOnly: true },
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
      // Force full rebuild on manual refresh
      this.lastActiveIds = [];
      this.lastHistoryIds = [];
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

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  protected override async onStop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## LLMMonitor Usage Guide

### Methods
- \`show()\` -- Open the LLM monitor window. Shows active requests, history, and stats.
- \`hide()\` -- Close the LLM monitor window.
- \`getState()\` -- Returns { visible: boolean }.

### Features
- Real-time view of active LLM requests with kill controls.
- Recent history of completed requests with View button to inspect prompt and output.
- Aggregate stats: total requests, input/output chars, errors, average latency.
- Pause/Unpause buttons to control the LLM object.
- Flicker-free updates: in-place label updates when row structure hasn't changed.
- Auto-refreshes every 2 seconds and on LLM state change events.

### Interface ID
\`abjects:llm-monitor\``;
  }
}

export const LLM_MONITOR_ID = 'abjects:llm-monitor' as AbjectId;
