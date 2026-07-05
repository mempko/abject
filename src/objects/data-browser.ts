/**
 * DataBrowser -- UI for browsing workspace collections and running
 * read-only SQL against the CollectionStore.
 *
 * Split-pane layout: collection list on the left; SQL editor, Run button,
 * and results on the right. Selecting a collection fills the editor with a
 * starter SELECT and runs it. Results render as an aligned monospace table
 * inside a self-sizing content block.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('DataBrowser');

const DATA_BROWSER_INTERFACE: InterfaceId = 'abjects:data-browser';

const WIN_W = 780;
const WIN_H = 520;
const DISPLAY_ROW_CAP = 50;
const CELL_CAP = 40;

interface CollectionInfo {
  name: string;
  rowCount: number;
}

export class DataBrowser extends Abject {
  private collectionStoreId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private splitPaneId?: AbjectId;
  private leftLayoutId?: AbjectId;
  private rightLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private sqlInputId?: AbjectId;
  private runBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private resultsLayoutId?: AbjectId;
  private resultsBlockId?: AbjectId;

  private collections: CollectionInfo[] = [];

  constructor() {
    super({
      manifest: {
        name: 'DataBrowser',
        description:
          'Browse workspace data collections and run read-only SQL queries against the CollectionStore. Selecting a collection previews its latest rows.',
        version: '1.0.0',
        interface: {
          id: DATA_BROWSER_INTERFACE,
          name: 'DataBrowser',
          description: 'Collection and SQL query browser UI',
          methods: [
            {
              name: 'show',
              description: 'Show the data browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the data browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display data browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.collectionStoreId = await this.discoverDep('CollectionStore') ?? undefined;
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Window lifecycle
  // ═══════════════════════════════════════════════════════════════════

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
        title: '🗄 Data',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // Split pane: collections | query workbench
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'splitPane',
          windowId: this.windowId,
          orientation: 'horizontal',
          dividerPosition: 0.28,
          minSize: 140,
        }],
      })
    );
    this.splitPaneId = splitId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.splitPaneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Left pane: collections list
    this.leftLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 4,
      })
    );
    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], searchable: false }],
      })
    );
    this.listWidgetId = listId;
    await this.request(request(this.id, this.leftLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Right pane: SQL editor + run row + results
    this.rightLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 4, bottom: 4, left: 8 },
        spacing: 6,
      })
    );

    const { widgetIds: [sqlId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'textArea', windowId: this.windowId,
          text: 'SELECT 1',
          monospace: true,
          style: { syntaxHighlight: false },
        }],
      })
    );
    this.sqlInputId = sqlId;
    await this.request(request(this.id, this.rightLayoutId, 'addLayoutChild', {
      widgetId: this.sqlInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 96 },
    }));

    // Run row: button + status label
    const runRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        windowId: this.windowId,
        parentLayoutId: this.rightLayoutId,
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rightLayoutId, 'updateLayoutChild', {
      widgetId: runRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    const { widgetIds: [runId, statusId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Run' },
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textTertiary } },
        ],
      })
    );
    this.runBtnId = runId;
    this.statusLabelId = statusId;
    await this.request(request(this.id, runRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.runBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 28 } },
        { widgetId: this.statusLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Results: a self-sizing content block inside a scrollable area.
    // A dedicated table widget is the follow-up; the aligned monospace
    // markdown block below is the interim rendering.
    this.resultsLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        windowId: this.windowId,
        parentLayoutId: this.rightLayoutId,
        margins: { top: 2, right: 2, bottom: 2, left: 2 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rightLayoutId, 'updateLayoutChild', {
      widgetId: this.resultsLayoutId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    const { widgetIds: [resultsId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'contentBlock', windowId: this.windowId,
          text: 'Select a collection, or write SQL and press Run.',
          style: { fontSize: 12, color: this.theme.textPrimary },
        }],
      })
    );
    this.resultsBlockId = resultsId;
    await this.request(request(this.id, this.resultsLayoutId, 'addLayoutChild', {
      widgetId: this.resultsBlockId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 40 },
    }));

    // Wire split pane
    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.leftLayoutId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.rightLayoutId }));

    // Subscribe to events
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.runBtnId, 'addDependent', {}));
    this.send(request(this.id, this.resultsBlockId, 'addDependent', {}));
    if (this.collectionStoreId) {
      this.send(request(this.id, this.collectionStoreId, 'addDependent', {}));
    }

    await this.refreshCollections();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.collectionStoreId) {
      this.send(request(this.id, this.collectionStoreId, 'removeDependent', {}));
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    // Null every window-scoped id together so no stale handle survives.
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.splitPaneId = undefined;
    this.leftLayoutId = undefined;
    this.rightLayoutId = undefined;
    this.listWidgetId = undefined;
    this.sqlInputId = undefined;
    this.runBtnId = undefined;
    this.statusLabelId = undefined;
    this.resultsLayoutId = undefined;
    this.resultsBlockId = undefined;
    this.collections = [];
    this.changed('visibility', false);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Data
  // ═══════════════════════════════════════════════════════════════════

  private async refreshCollections(): Promise<void> {
    if (!this.collectionStoreId || !this.listWidgetId) return;
    try {
      const infos = await this.request<CollectionInfo[]>(
        request(this.id, this.collectionStoreId, 'listCollections', {})
      );
      this.collections = infos;
      const items: ListItem[] = infos.map(c => ({
        label: c.name,
        value: c.name,
        secondary: `${c.rowCount} row${c.rowCount === 1 ? '' : 's'}`,
      }));
      await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    } catch (err) {
      log.warn('Failed to list collections:', err instanceof Error ? err.message : String(err));
    }
  }

  private async runQuery(): Promise<void> {
    if (!this.collectionStoreId || !this.sqlInputId) return;
    const sql = await this.request<string>(request(this.id, this.sqlInputId, 'getValue', {}));
    if (!sql || sql.trim().length === 0) return;

    const started = Date.now();
    try {
      const { columns, rows, capped } = await this.request<{
        columns: string[]; rows: unknown[][]; capped?: boolean;
      }>(request(this.id, this.collectionStoreId, 'query', { sql }));
      const ms = Date.now() - started;
      await this.setResults(this.formatResults(columns, rows));
      const shown = Math.min(rows.length, DISPLAY_ROW_CAP);
      let status = `${rows.length}${capped ? '+' : ''} row${rows.length === 1 ? '' : 's'} in ${ms}ms`;
      if (rows.length > shown) status += ` (showing first ${shown})`;
      await this.setStatus(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.setResults('**Query error**\n\n```\n' + msg + '\n```');
      await this.setStatus('');
    }
  }

  private formatResults(columns: string[], rows: unknown[][]): string {
    if (columns.length === 0) return 'No results.';
    const display = rows.slice(0, DISPLAY_ROW_CAP);
    const cell = (v: unknown): string => {
      let s: string;
      if (v === null || v === undefined) s = '';
      else if (typeof v === 'object') s = JSON.stringify(v);
      else s = String(v);
      s = s.replace(/\s+/g, ' ');
      return s.length > CELL_CAP ? s.slice(0, CELL_CAP - 1) + '…' : s;
    };
    const table = display.map(r => r.map(cell));
    const widths = columns.map((c, i) =>
      Math.max(c.length, ...table.map(r => r[i]?.length ?? 0)));
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
    const lines = [
      columns.map((c, i) => pad(c, widths[i])).join('  '),
      widths.map(w => '-'.repeat(w)).join('  '),
      ...table.map(r => r.map((s, i) => pad(s, widths[i])).join('  ')),
    ];
    let out = '```\n' + lines.join('\n') + '\n```';
    if (rows.length > display.length) {
      out += `\n${rows.length} rows total, showing first ${display.length}.`;
    }
    return out;
  }

  private async setResults(text: string): Promise<void> {
    if (!this.resultsBlockId) return;
    try {
      await this.request(request(this.id, this.resultsBlockId, 'update', { text }));
    } catch { /* widget gone */ }
  }

  private async setStatus(text: string): Promise<void> {
    if (!this.statusLabelId) return;
    try {
      await this.request(request(this.id, this.statusLabelId, 'update', { text }));
    } catch { /* widget gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event handling
  // ═══════════════════════════════════════════════════════════════════

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Collection selected: seed the editor with a starter query and run it.
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const name = (data as { value?: string })?.value;
      if (name && this.sqlInputId) {
        const sql = `SELECT * FROM ${name} ORDER BY updatedAt DESC LIMIT 50`;
        await this.request(request(this.id, this.sqlInputId, 'update', { text: sql }));
        await this.runQuery();
      }
      return;
    }

    if (fromId === this.runBtnId && aspect === 'click') {
      await this.runQuery();
      return;
    }

    // Results block reports its natural height; grow its slot so the
    // surrounding scrollable layout does the scrolling.
    if (fromId === this.resultsBlockId && aspect === 'contentHeight') {
      const h = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(h) && this.resultsLayoutId) {
        try {
          await this.request(request(this.id, this.resultsLayoutId, 'updateLayoutChild', {
            widgetId: this.resultsBlockId,
            preferredSize: { height: Math.max(40, Math.ceil(h)) },
          }));
        } catch { /* layout gone */ }
      }
      return;
    }

    // CollectionStore data changed: keep the collection list fresh.
    if (fromId === this.collectionStoreId) {
      if (aspect === 'collectionCreated' || aspect === 'collectionDropped'
        || aspect === 'recordInserted' || aspect === 'recordUpdated' || aspect === 'recordRemoved') {
        await this.refreshCollections();
      }
      return;
    }
  }
}

export const DATA_BROWSER_ID = 'abjects:data-browser' as AbjectId;
