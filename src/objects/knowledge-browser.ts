/**
 * KnowledgeBrowser -- UI for browsing, searching, and managing the
 * agent knowledge base.
 *
 * Split-pane layout: search input + list on the left, detail view on the
 * right. Tab bar for type filtering. Search triggers MiniSearch full-text
 * recall on the KnowledgeBase (searches content, not just titles).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { KnowledgeEntry, KnowledgeType } from './knowledge-base.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('KnowledgeBrowser');

const KNOWLEDGE_BROWSER_INTERFACE: InterfaceId = 'abjects:knowledge-browser';

const WIN_W = 720;
const WIN_H = 480;

const TYPE_ICONS: Record<KnowledgeType, string> = {
  learned:   '\u2731',  // ✱
  fact:      '\u25C6',  // ◆
  insight:   '\u2605',  // ★
  reference: '\u2192',  // →
};

const TAB_LABELS = ['All', 'Learned', 'Facts', 'Insights', 'References'];
const TAB_TYPES: (KnowledgeType | undefined)[] = [undefined, 'learned', 'fact', 'insight', 'reference'];

export class KnowledgeBrowser extends Abject {
  private knowledgeBaseId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private splitPaneId?: AbjectId;
  private searchInputId?: AbjectId;
  private listWidgetId?: AbjectId;
  private leftLayoutId?: AbjectId;
  private detailLayoutId?: AbjectId;
  private titleLabelId?: AbjectId;
  private typeLabelId?: AbjectId;
  private tagsLabelId?: AbjectId;
  private metaLabelId?: AbjectId;
  private contentLabelId?: AbjectId;
  private deleteBtnId?: AbjectId;
  private emptyLabelId?: AbjectId;

  private entries: KnowledgeEntry[] = [];
  private filteredEntries: KnowledgeEntry[] = [];
  private selectedId?: string;
  private activeTab = 0;
  private searchQuery = '';

  constructor() {
    super({
      manifest: {
        name: 'KnowledgeBrowser',
        description:
          'Browse, search, and manage the agent knowledge base. View learned lessons, discovered facts, agent insights, and reference entries.',
        version: '1.0.0',
        interface: {
          id: KNOWLEDGE_BROWSER_INTERFACE,
          name: 'KnowledgeBrowser',
          description: 'Knowledge base browser UI',
          methods: [
            {
              name: 'show',
              description: 'Show the knowledge browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the knowledge browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display knowledge browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.knowledgeBaseId = await this.discoverDep('KnowledgeBase') ?? undefined;
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
        title: '\uD83E\uDDE0 Knowledge',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // Tab bar for type filtering
    const { widgetIds: [tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'tabBar', windowId: this.windowId, tabs: TAB_LABELS, selectedIndex: 0, closable: false }],
      })
    );
    this.tabBarId = tabBarId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Split pane: left (search+list) | right (detail)
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'splitPane',
          windowId: this.windowId,
          orientation: 'horizontal',
          dividerPosition: 0.38,
          minSize: 160,
        }],
      })
    );
    this.splitPaneId = splitId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.splitPaneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Left pane: search input + list (detached VBox)
    this.leftLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 4,
      })
    );

    // Search input
    const { widgetIds: [searchId, listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId, placeholder: 'Search knowledge...' },
          { type: 'list', windowId: this.windowId, items: [], searchable: false, itemHeight: 26 },
        ],
      })
    );
    this.searchInputId = searchId;
    this.listWidgetId = listId;

    await this.request(request(this.id, this.leftLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.searchInputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 28 } },
        { widgetId: this.listWidgetId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Right pane: detail (scrollable VBox)
    this.detailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // Detail pane widgets
    const { widgetIds: detailIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // 0: title
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 14, fontWeight: 'bold', color: this.theme.textHeading, wordWrap: true } },
          // 1: type badge
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textSecondary } },
          // 2: tags
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.statusNeutral } },
          // 3: metadata
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 10, color: this.theme.textTertiary, wordWrap: true } },
          // 4: divider
          { type: 'divider', windowId: this.windowId },
          // 5: content (markdown, selectable)
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true, selectable: true } },
          // 6: delete button
          { type: 'button', windowId: this.windowId, text: 'Forget',
            style: { color: this.theme.statusError } },
          // 7: empty state
          { type: 'label', windowId: this.windowId, text: 'Select an entry to view details',
            style: { fontSize: 12, color: this.theme.textTertiary, align: 'center' } },
        ],
      })
    );

    this.titleLabelId = detailIds[0];
    this.typeLabelId = detailIds[1];
    this.tagsLabelId = detailIds[2];
    this.metaLabelId = detailIds[3];
    const dividerId = detailIds[4];
    this.contentLabelId = detailIds[5];
    this.deleteBtnId = detailIds[6];
    this.emptyLabelId = detailIds[7];

    await this.request(request(this.id, this.detailLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.emptyLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.titleLabelId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.typeLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: this.tagsLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: this.metaLabelId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: dividerId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 1 } },
        { widgetId: this.contentLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.deleteBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
      ],
    }));

    // Wire split pane
    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.leftLayoutId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.detailLayoutId }));

    // Subscribe to events
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.searchInputId, 'addDependent', {}));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.deleteBtnId, 'addDependent', {}));
    if (this.knowledgeBaseId) {
      this.send(request(this.id, this.knowledgeBaseId, 'addDependent', {}));
    }

    // Show empty state, hide detail widgets
    await this.showEmptyState(true);

    // Load initial data
    await this.loadEntries();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.knowledgeBaseId) {
      this.send(request(this.id, this.knowledgeBaseId, 'removeDependent', {}));
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.splitPaneId = undefined;
    this.searchInputId = undefined;
    this.listWidgetId = undefined;
    this.leftLayoutId = undefined;
    this.detailLayoutId = undefined;
    this.titleLabelId = undefined;
    this.typeLabelId = undefined;
    this.tagsLabelId = undefined;
    this.metaLabelId = undefined;
    this.contentLabelId = undefined;
    this.deleteBtnId = undefined;
    this.emptyLabelId = undefined;
    this.entries = [];
    this.filteredEntries = [];
    this.selectedId = undefined;
    this.activeTab = 0;
    this.searchQuery = '';
    this.changed('visibility', false);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Data loading
  // ═══════════════════════════════════════════════════════════════════

  private async loadEntries(): Promise<void> {
    if (!this.knowledgeBaseId) return;

    try {
      const typeFilter = TAB_TYPES[this.activeTab];

      if (this.searchQuery.trim().length > 0) {
        // Full-text search via KnowledgeBase recall (searches title + content + tags)
        this.filteredEntries = await this.request<KnowledgeEntry[]>(
          request(this.id, this.knowledgeBaseId, 'recall', {
            query: this.searchQuery,
            type: typeFilter,
            limit: 50,
          })
        );
      } else {
        // No search query: list all, filtered by type
        this.filteredEntries = await this.request<KnowledgeEntry[]>(
          request(this.id, this.knowledgeBaseId, 'list', {
            type: typeFilter,
            limit: 200,
          })
        );
      }

      // Keep full entries cache for detail view
      if (!this.searchQuery) {
        this.entries = this.filteredEntries;
      }

      await this.rebuildList();
    } catch (err) {
      log.warn('Failed to load entries:', err instanceof Error ? err.message : String(err));
    }
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;

    const items: ListItem[] = this.filteredEntries.map(entry => {
      const icon = TYPE_ICONS[entry.type] ?? '';
      const tagStr = entry.tags.length > 0 ? entry.tags.slice(0, 3).join(', ') : '';
      return {
        label: `${icon} ${entry.title}`,
        value: entry.id,
        secondary: tagStr,
      };
    });

    await this.request(request(this.id, this.listWidgetId, 'update', { items }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Detail pane
  // ═══════════════════════════════════════════════════════════════════

  private async showEmptyState(empty: boolean): Promise<void> {
    if (!this.emptyLabelId) return;
    const detailVis = !empty;

    await Promise.all([
      this.request(request(this.id, this.emptyLabelId, 'update', { style: { visible: empty } })),
      this.request(request(this.id, this.titleLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.typeLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.tagsLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.metaLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.contentLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.deleteBtnId!, 'update', { style: { visible: detailVis } })),
    ]);
  }

  private async showDetail(entry: KnowledgeEntry): Promise<void> {
    await this.showEmptyState(false);

    const typeColor = this.typeColor(entry.type);
    const icon = TYPE_ICONS[entry.type] ?? '';
    const created = new Date(entry.createdAt).toLocaleDateString();
    const updated = new Date(entry.updatedAt).toLocaleDateString();
    const tagsStr = entry.tags.length > 0 ? entry.tags.join(', ') : 'none';

    await Promise.all([
      this.request(request(this.id, this.titleLabelId!, 'update', { text: entry.title })),
      this.request(request(this.id, this.typeLabelId!, 'update', {
        text: `${icon} ${entry.type}`,
        style: { color: typeColor, visible: true },
      })),
      this.request(request(this.id, this.tagsLabelId!, 'update', {
        text: `Tags: ${tagsStr}`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.metaLabelId!, 'update', {
        text: `Created ${created}  |  Updated ${updated}  |  Accessed ${entry.accessCount} times`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.contentLabelId!, 'update', {
        text: entry.content,
        style: { visible: true },
      })),
    ]);
  }

  private typeColor(type: KnowledgeType): string {
    switch (type) {
      case 'learned': return this.theme.statusWarning;
      case 'fact': return this.theme.statusSuccess;
      case 'insight': return this.theme.statusNeutral;
      case 'reference': return this.theme.textSecondary;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event handling
  // ═══════════════════════════════════════════════════════════════════

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Tab changed
    if (fromId === this.tabBarId && aspect === 'change') {
      const idx = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!isNaN(idx) && idx >= 0 && idx < TAB_LABELS.length) {
        this.activeTab = idx;
        this.selectedId = undefined;
        await this.showEmptyState(true);
        await this.loadEntries();
      }
      return;
    }

    // Search input changed -- full-text search via KnowledgeBase recall
    if (fromId === this.searchInputId && aspect === 'change') {
      this.searchQuery = typeof value === 'string' ? value : '';
      this.selectedId = undefined;
      await this.showEmptyState(true);
      await this.loadEntries();
      return;
    }

    // List selection
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const entryId = (data as { value?: string })?.value;
      if (entryId) {
        this.selectedId = entryId;
        const entry = this.filteredEntries.find(e => e.id === entryId);
        if (entry) await this.showDetail(entry);
      }
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      if (!this.selectedId || !this.knowledgeBaseId) return;

      const entry = this.filteredEntries.find(e => e.id === this.selectedId);
      const confirmed = await this.confirm({
        title: 'Forget this knowledge?',
        message: entry ? `"${entry.title}" will be permanently removed.` : 'This entry will be permanently removed.',
        confirmLabel: 'Forget',
        destructive: true,
      });
      if (!confirmed) return;

      await this.request(
        request(this.id, this.knowledgeBaseId, 'forget', { id: this.selectedId })
      );
      this.selectedId = undefined;
      await this.showEmptyState(true);
      await this.loadEntries();
      return;
    }

    // KnowledgeBase events
    if (fromId === this.knowledgeBaseId) {
      if (aspect === 'entryAdded' || aspect === 'entryUpdated' || aspect === 'entryRemoved') {
        await this.loadEntries();
        if (this.selectedId && aspect === 'entryUpdated') {
          const entry = this.filteredEntries.find(e => e.id === this.selectedId);
          if (entry) await this.showDetail(entry);
        }
        if (this.selectedId && aspect === 'entryRemoved') {
          const data = value as { id?: string } | undefined;
          if (data?.id === this.selectedId) {
            this.selectedId = undefined;
            await this.showEmptyState(true);
          }
        }
      }
      return;
    }
  }
}

export const KNOWLEDGE_BROWSER_ID = 'abjects:knowledge-browser' as AbjectId;
