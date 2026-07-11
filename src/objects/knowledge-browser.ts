/**
 * KnowledgeBrowser -- UI for browsing, searching, and managing the
 * agent knowledge base.
 *
 * Split-pane layout: search input + list on the left, detail view on the
 * right. Tab bar for type filtering, toolbar row with a 'Show archived'
 * toggle and a Curate button (asks the reviewer to run a background
 * curation pass). Search triggers FTS5 full-text recall on the
 * KnowledgeBase (searches content, not just titles).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { KnowledgeEntry, KnowledgeType } from './knowledge-base.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('KnowledgeBrowser');

const KNOWLEDGE_BROWSER_INTERFACE: InterfaceId = 'abjects:knowledge-browser';

const WIN_W = 720;
const WIN_H = 480;

/**
 * Vector icon names for knowledge types. ListWidget renders these at the
 * row leading edge (via ListItem.iconName); colors come from the theme.
 */
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
  private restoreBtnId?: AbjectId;
  private buttonRowId?: AbjectId;
  private emptyLabelId?: AbjectId;
  private archivedToggleId?: AbjectId;
  private curateBtnId?: AbjectId;

  private entries: KnowledgeEntry[] = [];
  private filteredEntries: KnowledgeEntry[] = [];
  private selectedId?: string;
  private activeTab = 0;
  private searchQuery = '';
  private showArchived = false;

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

    // Toolbar: 'Show archived' toggle (left) + Curate button (right)
    const toolbarRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: toolbarRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const { widgetIds: [archToggleId, curateId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'checkbox', windowId: this.windowId, checked: this.showArchived, text: 'Show archived' },
          { type: 'button', windowId: this.windowId, text: 'Curate' },
        ],
      })
    );
    this.archivedToggleId = archToggleId;
    this.curateBtnId = curateId;

    await this.request(request(this.id, toolbarRowId, 'addLayoutChild', {
      widgetId: this.archivedToggleId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 140, height: 24 },
    }));
    await this.request(request(this.id, toolbarRowId, 'addLayoutSpacer', {}));
    await this.request(request(this.id, toolbarRowId, 'addLayoutChild', {
      widgetId: this.curateBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 80, height: 26 },
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
          { type: 'markdown', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true, selectable: true } },
          // 6: delete button
          { type: 'button', windowId: this.windowId, text: 'Forget',
            style: { color: this.theme.statusError } },
          // 7: restore button (archived entries only)
          { type: 'button', windowId: this.windowId, text: 'Restore',
            style: { color: this.theme.statusSuccess } },
          // 8: empty state
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
    this.restoreBtnId = detailIds[7];
    this.emptyLabelId = detailIds[8];

    // Button row (Forget + Restore side by side)
    this.buttonRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    await this.request(request(this.id, this.buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.deleteBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
        { widgetId: this.restoreBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
      ],
    }));

    await this.request(request(this.id, this.detailLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.emptyLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.titleLabelId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.typeLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: this.tagsLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
        { widgetId: this.metaLabelId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: dividerId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 1 } },
        { widgetId: this.contentLabelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.buttonRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } },
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
    this.send(request(this.id, this.restoreBtnId, 'addDependent', {}));
    this.send(request(this.id, this.archivedToggleId, 'addDependent', {}));
    this.send(request(this.id, this.curateBtnId, 'addDependent', {}));
    if (this.knowledgeBaseId) {
      this.send(request(this.id, this.knowledgeBaseId, 'addDependent', {}));
    }

    // Show empty state, hide detail widgets
    await this.showEmptyState(true);

    // Load initial data
    await this.loadEntries();

    // Autofocus the search input so the user can start typing immediately
    // (Paradox of the Active User — surface the primary action without an
    // extra click).
    if (this.windowId && this.searchInputId && this.rootLayoutId) {
      try {
        await this.request(request(this.id, this.windowId, 'focusChild', {
          widgetId: this.searchInputId,
          parentChildId: this.rootLayoutId,
        }));
      } catch { /* window gone */ }
    }

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
    this.restoreBtnId = undefined;
    this.buttonRowId = undefined;
    this.emptyLabelId = undefined;
    this.archivedToggleId = undefined;
    this.curateBtnId = undefined;
    this.entries = [];
    this.filteredEntries = [];
    this.selectedId = undefined;
    this.activeTab = 0;
    this.searchQuery = '';
    this.showArchived = false;
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
            ...(this.showArchived ? { includeArchived: true } : {}),
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
      const tagStr = entry.tags.length > 0 ? entry.tags.slice(0, 3).join(', ') : '';
      // Compact second line: origin badge text + usefulness + tags
      const parts: string[] = [entry.origin];
      if (entry.usefulCount > 0) parts.push(`useful ×${entry.usefulCount}`);
      if (tagStr) parts.push(tagStr);
      return {
        label: entry.title,
        value: entry.id,
        secondary: parts.join('  ·  '),
        badge: entry.archived
          ? { text: 'archived', color: this.theme.textTertiary }
          : { text: entry.type, color: this.typeColor(entry.type) },
      };
    });

    await this.request(request(this.id, this.listWidgetId, 'update', { items }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Curation
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Ask the reviewer to run a knowledge curation pass. The reply arrives
   * immediately ({ started, message? }); curation itself runs in the
   * background and results land via the KnowledgeBase entry-change events
   * this browser already subscribes to.
   */
  private async runCurate(): Promise<void> {
    if (!this.curateBtnId) return;

    this.send(event(this.id, this.curateBtnId, 'update', { busy: true }));
    try {
      const reviewerId = await this.discoverDep('TaskReviewer');
      if (!reviewerId) {
        await this.notify('Reviewer not available', 'warning');
        return;
      }

      const reply = await this.request<{ started: boolean; message?: string }>(
        request(this.id, reviewerId, 'curate', {})
      );
      await this.notify(
        reply.message ?? (reply.started ? 'Curation started' : 'Curation did not start'),
        reply.started ? 'info' : 'warning'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.notify(`Curate failed: ${msg.slice(0, 80)}`, 'error');
    } finally {
      this.send(event(this.id, this.curateBtnId, 'update', { busy: false }));
    }
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
      // Restore stays hidden until showDetail() reveals it for archived entries
      this.request(request(this.id, this.restoreBtnId!, 'update', { style: { visible: false } })),
    ]);
  }

  private async showDetail(entry: KnowledgeEntry): Promise<void> {
    await this.showEmptyState(false);

    const typeColor = this.typeColor(entry.type);
    const created = new Date(entry.createdAt).toLocaleDateString();
    const updated = new Date(entry.updatedAt).toLocaleDateString();
    const tagsStr = entry.tags.length > 0 ? entry.tags.join(', ') : 'none';
    const usefulStr = entry.usefulCount > 0 ? `  |  Useful ×${entry.usefulCount}` : '';

    await Promise.all([
      this.request(request(this.id, this.titleLabelId!, 'update', {
        text: entry.title,
        // Archived entries render dimmed
        style: { color: entry.archived ? this.theme.textTertiary : this.theme.textHeading, visible: true },
      })),
      this.request(request(this.id, this.typeLabelId!, 'update', {
        text: entry.archived ? `${entry.type}  ·  archived` : entry.type,
        style: { color: entry.archived ? this.theme.textTertiary : typeColor, visible: true },
      })),
      this.request(request(this.id, this.tagsLabelId!, 'update', {
        text: `Tags: ${tagsStr}`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.metaLabelId!, 'update', {
        text: `Origin: ${entry.origin}  |  Created ${created}  |  Updated ${updated}  |  Accessed ${entry.accessCount} times${usefulStr}`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.restoreBtnId!, 'update', {
        style: { visible: entry.archived },
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

    // Show-archived toggle. CheckboxWidget emits the string 'true'/'false',
    // not a boolean; accept both shapes.
    if (fromId === this.archivedToggleId && aspect === 'change') {
      this.showArchived = value === true || value === 'true';
      this.selectedId = undefined;
      await this.showEmptyState(true);
      await this.loadEntries();
      return;
    }

    // Curate button -- ask the reviewer to run a curation pass
    if (fromId === this.curateBtnId && aspect === 'click') {
      await this.runCurate();
      return;
    }

    // Restore button -- un-archive the selected entry
    if (fromId === this.restoreBtnId && aspect === 'click') {
      if (!this.selectedId || !this.knowledgeBaseId) return;

      const entry = this.filteredEntries.find(e => e.id === this.selectedId);
      this.send(event(this.id, this.restoreBtnId, 'update', { busy: true }));
      try {
        const res = await this.request<{ success?: boolean; error?: string }>(
          request(this.id, this.knowledgeBaseId, 'archive', { id: this.selectedId, archived: false })
        );
        if (res && res.success === false) {
          throw new Error(res.error ?? 'entry no longer exists');
        }
        await this.notify(entry ? `Restored "${entry.title}"` : 'Entry restored', 'success');
        await this.loadEntries();
        const restored = this.filteredEntries.find(e => e.id === this.selectedId);
        if (restored) {
          await this.showDetail(restored);
        } else {
          this.selectedId = undefined;
          await this.showEmptyState(true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.notify(`Restore failed: ${msg.slice(0, 80)}`, 'error');
      } finally {
        this.send(event(this.id, this.restoreBtnId, 'update', { busy: false }));
      }
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

      this.send(event(this.id, this.deleteBtnId, 'update', { busy: true }));
      try {
        await this.request(
          request(this.id, this.knowledgeBaseId, 'forget', { id: this.selectedId })
        );
        await this.notify(entry ? `Forgot "${entry.title}"` : 'Entry forgotten', 'success');
        this.selectedId = undefined;
        await this.showEmptyState(true);
        await this.loadEntries();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.notify(`Forget failed: ${msg.slice(0, 80)}`, 'error');
      } finally {
        this.send(event(this.id, this.deleteBtnId, 'update', { busy: false }));
      }
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
