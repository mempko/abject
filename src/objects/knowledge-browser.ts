/**
 * KnowledgeBrowser -- UI for browsing, searching, and managing the
 * agent knowledge base.
 *
 * Split-pane layout: search input + list on the left, detail view on the
 * right. Tab bar for type filtering (including the workspace's pattern
 * language), toolbar row with a 'Show archived' toggle and a Curate button
 * (asks the reviewer to run a background curation pass). Search triggers
 * FTS5 full-text recall on the KnowledgeBase (searches content, not just
 * titles).
 *
 * Pattern entries get link navigation: the detail pane renders the
 * pattern's links as clickable chips (click opens
 * the linked pattern), names with no written pattern yet as dimmed
 * "unwritten" labels, and a reverse "Linked from" row of the patterns
 * whose Links name this one.
 *
 * On the Patterns tab a map sits beside the list: the pattern language as a
 * 3D graph (the nodeGraph widget), one node per pattern and a see-through
 * node per unwritten link name. Selection syncs both ways: a click on the
 * map opens the pattern in the detail pane and the list, and choosing a
 * pattern in the list or through a link chip selects it on the map. A
 * newly woven pattern arrives as a flow of living light along its links.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { emptyStateMarkdown, emptyStateStyle } from './ui-kit.js';
import { readPattern, readStructured, renderPatternText } from '../core/pattern.js';
import type { KnowledgeEntry, KnowledgeType } from './knowledge-base.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('KnowledgeBrowser');

const KNOWLEDGE_BROWSER_INTERFACE: InterfaceId = 'abjects:knowledge-browser';

const WIN_W = 900;
const WIN_H = 540;
/** Minimum gap between arrival flashes, so a curation pass reads as one signal. */
const ARRIVAL_FLASH_GAP_MS = 1500;

/** Map node id prefix for unwritten (ghost) patterns: a dangling link name. */
const GHOST_PREFIX = 'unwritten:';

/**
 * Vector icon names for knowledge types. ListWidget renders these at the
 * row leading edge (via ListItem.iconName); colors come from the theme.
 */
const TAB_LABELS = ['All', 'Patterns', 'Learned', 'Facts', 'Insights', 'References'];
const TAB_TYPES: (KnowledgeType | undefined)[] = [undefined, 'pattern', 'learned', 'fact', 'insight', 'reference'];

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
  private dividerId?: AbjectId;
  /** Empty-state label sharing the list's slot; shown when the list is empty. */
  private listEmptyId?: AbjectId;
  private listEmptyShown?: boolean;
  private archivedToggleId?: AbjectId;
  private curateBtnId?: AbjectId;

  /** This peer's id, for telling locally authored entries from synced ones. */
  private localPeerId = '';

  private innerSplitId?: AbjectId;
  /** Pattern language map (a nodeGraph widget), shown on the Patterns tab. */
  private graphId?: AbjectId;
  /** Pattern ids on the map, with each pattern's outgoing link targets (map node ids). */
  private graphLinks = new Map<string, string[]>();

  private linksRowId?: AbjectId;
  private linkedFromRowId?: AbjectId;
  /** Dynamic chips currently in the link rows, with the row each lives in. */
  private linkRowWidgets: Array<{ rowId: AbjectId; widgetId: AbjectId }> = [];
  /** Link-navigation buttons mapped to the pattern entry they open. */
  private linkButtons: Map<AbjectId, KnowledgeEntry> = new Map();

  private entries: KnowledgeEntry[] = [];
  private filteredEntries: KnowledgeEntry[] = [];
  private selectedId?: string;
  private activeTab = 0;
  private searchQuery = '';
  private showArchived = false;
  /** When the last new-entry flash played. */
  private lastArrivalFlashAt = 0;

  constructor() {
    super({
      manifest: {
        name: 'KnowledgeBrowser',
        description:
          'Browse, search, and manage the agent knowledge base. View learned lessons, discovered facts, agent insights, reference entries, and the workspace pattern language (with clickable links between patterns).',
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

    // Peer id, so entries synced from other peers can be attributed and their
    // edit controls withheld. Falls back to this object's id until Identity
    // answers, which reads every entry as local -- the pre-sharing behaviour.
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.localPeerId = identity.peerId;
      } catch { /* Identity may not be ready */ }
    }
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
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
        spacing: 8,
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
          { type: 'button', windowId: this.windowId, text: 'Curate',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
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

    // Split panes: outer = list | rest; inner = map | detail. The map pane
    // exists only visually on the Patterns tab (inner divider collapses to 0
    // elsewhere), so the other tabs keep their two-pane layout.
    const { widgetIds: [splitId, innerSplitId, graphId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'splitPane',
            windowId: this.windowId,
            orientation: 'horizontal',
            dividerPosition: 0.3,
            minSize: 160,
          },
          {
            type: 'splitPane',
            windowId: this.windowId,
            orientation: 'horizontal',
            dividerPosition: 0,
            minSize: 0,
          },
          // The pattern language map (hidden until the Patterns tab is active).
          {
            type: 'nodeGraph',
            windowId: this.windowId,
            title: 'Pattern language',
            emptyText: 'No patterns yet',
            directed: true,
            groups: [
              { id: 'pattern', label: 'Written', color: '$textPrimary', material: 'ceramic', shape: 'sphere' },
              { id: 'unwritten', label: 'Unwritten', color: '$textSecondary', shape: 'icosphere' },
            ],
            style: { visible: false },
          },
        ],
      })
    );
    this.splitPaneId = splitId;
    this.innerSplitId = innerSplitId;
    this.graphId = graphId;

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
    const { widgetIds: [searchId, listId, listEmptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId, placeholder: 'Search knowledge...' },
          { type: 'list', windowId: this.windowId, items: [], searchable: false, itemHeight: 26 },
          { type: 'label', windowId: this.windowId, text: this.listEmptyText(), style: emptyStateStyle(this.theme) },
        ],
      })
    );
    this.searchInputId = searchId;
    this.listWidgetId = listId;
    this.listEmptyId = listEmptyId;

    await this.request(request(this.id, this.leftLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.searchInputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 28 } },
        { widgetId: this.listWidgetId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.listEmptyId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Right pane: detail (scrollable VBox)
    this.detailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 8,
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
            style: { fontSize: 10, color: this.theme.textMeta, wordWrap: true } },
          // 4: divider
          { type: 'divider', windowId: this.windowId },
          // 5: content (markdown, selectable)
          { type: 'markdown', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true, selectable: true } },
          // 6: delete button
          { type: 'button', windowId: this.windowId, text: 'Forget',
            style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder } },
          // 7: restore button (archived entries only; the primary action there)
          { type: 'button', windowId: this.windowId, text: 'Restore',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
          // 8: empty state
          { type: 'label', windowId: this.windowId,
            text: emptyStateMarkdown(
              'Select an entry',
              'Pick one from the list to read it in full, see its tags and links, and forget or restore it.',
            ),
            style: emptyStateStyle(this.theme) },
        ],
      })
    );

    this.titleLabelId = detailIds[0];
    this.typeLabelId = detailIds[1];
    this.tagsLabelId = detailIds[2];
    this.metaLabelId = detailIds[3];
    const dividerId = this.dividerId = detailIds[4];
    this.contentLabelId = detailIds[5];
    this.deleteBtnId = detailIds[6];
    this.restoreBtnId = detailIds[7];
    this.emptyLabelId = detailIds[8];

    // Pattern link rows: outgoing 'Links' and reverse 'Linked from'. Chips
    // are created per selected pattern in renderPatternLinks; the rows
    // themselves persist (empty rows collapse to zero height).
    this.linksRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    this.linkedFromRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );

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
        { widgetId: this.linksRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.linkedFromRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' } },
        { widgetId: this.buttonRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } },
      ],
    }));

    // Wire split panes: outer = list | inner; inner = graph | detail
    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.leftLayoutId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.innerSplitId }));
    await this.request(request(this.id, this.innerSplitId, 'setLeftChild', { widgetId: this.graphId }));
    await this.request(request(this.id, this.innerSplitId, 'setRightChild', { widgetId: this.detailLayoutId }));

    // Subscribe to events
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.searchInputId, 'addDependent', {}));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.deleteBtnId, 'addDependent', {}));
    this.send(request(this.id, this.restoreBtnId, 'addDependent', {}));
    this.send(request(this.id, this.archivedToggleId, 'addDependent', {}));
    this.send(request(this.id, this.curateBtnId, 'addDependent', {}));
    this.send(request(this.id, this.graphId, 'addDependent', {}));
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
    this.dividerId = undefined;
    this.listEmptyId = undefined;
    this.listEmptyShown = undefined;
    this.archivedToggleId = undefined;
    this.curateBtnId = undefined;
    this.innerSplitId = undefined;
    this.graphId = undefined;
    this.graphLinks.clear();
    this.linksRowId = undefined;
    this.linkedFromRowId = undefined;
    this.linkRowWidgets = [];
    this.linkButtons.clear();
    this.entries = [];
    this.filteredEntries = [];
    this.selectedId = undefined;
    this.activeTab = 0;
    this.searchQuery = '';
    this.showArchived = false;
    this.lastArrivalFlashAt = 0;
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

  /** This peer's id, falling back to the object id before Identity resolves. */
  private get selfPeerId(): string {
    return this.localPeerId || this.id;
  }

  /**
   * An entry authored by another peer. These are shown with their origin peer
   * and are read-only here: forgetting or restoring one would only be undone
   * by the owning peer's next sync, so the controls are withheld instead.
   */
  private isRemoteEntry(entry: KnowledgeEntry): boolean {
    const creator = entry.creatorPeerId;
    return !!creator && creator !== this.selfPeerId;
  }

  /** Short, stable label for a peer id in the UI. */
  private peerLabel(peerId: string): string {
    return peerId.slice(0, 8);
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;

    const items: ListItem[] = this.filteredEntries.map(entry => {
      const tagStr = entry.tags.length > 0 ? entry.tags.slice(0, 3).join(', ') : '';
      const remote = this.isRemoteEntry(entry);
      // Compact second line: origin badge text + peer + usefulness + tags
      const parts: string[] = [entry.origin];
      if (remote) parts.push(`peer ${this.peerLabel(entry.creatorPeerId!)}`);
      if (entry.usefulCount > 0) parts.push(`useful ×${entry.usefulCount}`);
      if (tagStr) parts.push(tagStr);
      return {
        label: entry.title,
        value: entry.id,
        secondary: parts.join('  ·  '),
        badge: entry.archived
          ? { text: 'archived', color: this.theme.textTertiary }
          : remote
            ? { text: `remote · ${entry.type}`, color: this.theme.textTertiary }
            : { text: entry.type, color: this.typeColor(entry.type) },
      };
    });

    await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    await this.applyListEmpty(items.length === 0);
  }

  /** Empty-list text for the current tab and search. */
  private listEmptyText(): string {
    if (this.searchQuery.trim().length > 0) {
      return emptyStateMarkdown('No matches', 'Try other words, or clear the search to see everything.');
    }
    const type = TAB_TYPES[this.activeTab];
    if (type === 'pattern') {
      return emptyStateMarkdown(
        'No patterns yet',
        'Patterns are reusable lessons woven from finished goals. They appear here as agents complete work.',
      );
    }
    const titles: Record<string, string> = {
      learned: 'No lessons learned yet', fact: 'No facts yet',
      insight: 'No insights yet', reference: 'No references yet',
    };
    return emptyStateMarkdown(
      type ? (titles[type] ?? 'Nothing here yet') : 'Nothing remembered yet',
      'Agents record what they learn here as they work. Ask in Chat to remember something, for example "remember that I prefer metric units".',
    );
  }

  /** Swap the list and its empty-state label, refreshing the text. */
  private async applyListEmpty(empty: boolean): Promise<void> {
    if (!this.listWidgetId || !this.listEmptyId) return;
    try {
      if (empty) {
        await this.request(request(this.id, this.listEmptyId, 'update', { text: this.listEmptyText() }));
      }
      if (this.listEmptyShown === empty) return;
      this.listEmptyShown = empty;
      await Promise.all([
        this.request(request(this.id, this.listWidgetId, 'update', { style: { visible: !empty } })),
        this.request(request(this.id, this.listEmptyId, 'update', { style: { visible: empty } })),
      ]);
    } catch { /* widgets may be gone */ }
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
        this.playEffect('shake');
        await this.notify('Reviewer not available', 'warning');
        return;
      }

      const reply = await this.request<{ started: boolean; message?: string }>(
        request(this.id, reviewerId, 'curate', {})
      );
      // Started: the request landed (hand-coloured, the user asked for it).
      // Not started: the reviewer turned it away.
      this.playEffect(reply.started ? 'flash' : 'shake', reply.started ? '$accent' : undefined);
      await this.notify(
        reply.message ?? (reply.started ? 'Curation started' : 'Curation did not start'),
        reply.started ? 'info' : 'warning'
      );
    } catch (err) {
      this.playEffect('shake');
      const msg = err instanceof Error ? err.message : String(err);
      await this.notify(`Curate failed: ${msg.slice(0, 80)}`, 'error');
    } finally {
      this.send(event(this.id, this.curateBtnId, 'update', { busy: false }));
    }
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Detail pane
  // ═══════════════════════════════════════════════════════════════════

  private async showEmptyState(empty: boolean): Promise<void> {
    if (!this.emptyLabelId) return;
    const detailVis = !empty;
    if (empty) await this.clearLinkRows();

    await Promise.all([
      this.request(request(this.id, this.emptyLabelId, 'update', { style: { visible: empty } })),
      this.request(request(this.id, this.titleLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.typeLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.tagsLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.metaLabelId!, 'update', { style: { visible: detailVis } })),
      this.request(request(this.id, this.contentLabelId!, 'update', { style: { visible: detailVis } })),
      ...(this.dividerId ? [this.request(request(this.id, this.dividerId, 'update', { style: { visible: detailVis } }))] : []),
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
    // Entries synced from another peer are labelled and left read-only.
    const remote = this.isRemoteEntry(entry);
    const peerStr = remote ? `  |  Peer ${this.peerLabel(entry.creatorPeerId!)} (read-only)` : '';

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
        text: `Origin: ${entry.origin}${peerStr}  |  Created ${created}  |  Updated ${updated}  |  Accessed ${entry.accessCount} times${usefulStr}`,
        style: { visible: true },
      })),
      this.request(request(this.id, this.restoreBtnId!, 'update', {
        style: { visible: entry.archived && !remote },
      })),
      // showEmptyState() reveals Forget for every detail render; a remote
      // entry takes it away again.
      // The same button forgets a live entry and deletes an archived one, and
      // its label says which.
      this.request(request(this.id, this.deleteBtnId!, 'update', {
        text: entry.archived ? 'Delete' : 'Forget',
        style: { visible: !remote },
      })),
      this.request(request(this.id, this.contentLabelId!, 'update', {
        text: this.displayContent(entry),
        style: { visible: true },
      })),
    ]);

    await this.renderPatternLinks(entry);
  }

  // ─── Pattern link navigation ───────────────────────────────────────

  /** Lowercase, strip punctuation, collapse whitespace — the same title key KnowledgeBase resolves links by. */
  private normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /**
   * A pattern's links, off its structure. The browser used to hunt for a
   * 'Links:' line here, so patterns that wrote their links as a '## Links'
   * block drew as isolated nodes in the graph even though they were linked.
   */
  private parsePatternLinks(content: string): string[] {
    return readPattern(content)?.links ?? [];
  }

  /**
   * Patterns are stored as structure. The KnowledgeBase renders them before
   * handing them out, so this normally receives prose already; it renders
   * anyway, because an entry can also arrive raw over cross-peer sync and a
   * wall of JSON is not what the detail pane is for.
   */
  private displayContent(entry: { type: string; content: string; title: string }): string {
    if (entry.type !== 'pattern') return entry.content;
    const pattern = readStructured(entry.content);
    return pattern ? renderPatternText(pattern) : entry.content;
  }

  private async clearLinkRows(): Promise<void> {
    const widgets = this.linkRowWidgets;
    this.linkRowWidgets = [];
    this.linkButtons.clear();
    for (const { rowId, widgetId } of widgets) {
      try {
        await this.request(request(this.id, rowId, 'removeLayoutChild', { widgetId }));
      } catch { /* row already gone */ }
      try {
        await this.request(request(this.id, widgetId, 'destroy', {}));
      } catch { /* widget already gone */ }
    }
  }

  /**
   * Render the selected pattern's language neighborhood: its outgoing
   * link names as clickable chips (dimmed "unwritten" when no pattern
   * has that title yet) and a reverse row of patterns whose Links name it.
   * Non-pattern entries just clear the rows.
   */
  private async renderPatternLinks(entry: KnowledgeEntry): Promise<void> {
    await this.clearLinkRows();
    if (entry.type !== 'pattern' || !this.linksRowId || !this.linkedFromRowId || !this.knowledgeBaseId) return;

    const patterns = await this.request<KnowledgeEntry[]>(
      request(this.id, this.knowledgeBaseId, 'list', { type: 'pattern', limit: 200 }),
    ).catch(() => [] as KnowledgeEntry[]);
    const byTitle = new Map(patterns.map(p => [this.normalizeTitle(p.title), p]));

    const outgoing = this.parsePatternLinks(entry.content);
    const selfNorm = this.normalizeTitle(entry.title);
    const incoming = patterns.filter(p =>
      p.id !== entry.id
      && this.parsePatternLinks(p.content).some(name => this.normalizeTitle(name) === selfNorm));

    if (outgoing.length > 0) {
      await this.addLinkChip(this.linksRowId, { text: 'Links:' });
      for (const name of outgoing) {
        const target = byTitle.get(this.normalizeTitle(name));
        if (target && target.id !== entry.id) {
          await this.addLinkChip(this.linksRowId, { text: target.title, target });
        } else if (!target) {
          await this.addLinkChip(this.linksRowId, { text: `${name} (unwritten)`, dim: true });
        }
      }
    }
    if (incoming.length > 0) {
      await this.addLinkChip(this.linkedFromRowId, { text: 'Linked from:' });
      for (const p of incoming) {
        await this.addLinkChip(this.linkedFromRowId, { text: p.title, target: p });
      }
    }
    log.info(`renderPatternLinks("${entry.title}"): ${outgoing.length} outgoing, ${incoming.length} incoming`);
  }

  /** Add one chip to a link row: a button when it targets a pattern, a label otherwise. */
  private async addLinkChip(
    rowId: AbjectId,
    chip: { text: string; dim?: boolean; target?: KnowledgeEntry },
  ): Promise<void> {
    const spec = chip.target
      ? { type: 'button', windowId: this.windowId, text: chip.text }
      : {
          type: 'label', windowId: this.windowId, text: chip.text,
          style: { fontSize: 11, color: chip.dim ? this.theme.textTertiary : this.theme.textSecondary },
        };
    const { widgetIds: [widgetId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [spec] }),
    );
    await this.request(request(this.id, rowId, 'addLayoutChild', {
      widgetId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: Math.min(240, chip.text.length * 7 + (chip.target ? 24 : 8)), height: 24 },
    }));
    this.linkRowWidgets.push({ rowId, widgetId });
    if (chip.target) {
      this.linkButtons.set(widgetId, chip.target);
      this.send(request(this.id, widgetId, 'addDependent', {}));
    }
  }

  // ─── Pattern language map (graph pane) ─────────────────────────────

  private graphActive(): boolean {
    return TAB_TYPES[this.activeTab] === 'pattern' && !!this.graphId;
  }

  /** Collapse or expand the map pane to match the active tab. */
  private async updateGraphPane(): Promise<void> {
    if (!this.innerSplitId || !this.graphId) return;
    const active = TAB_TYPES[this.activeTab] === 'pattern';
    await this.request(request(this.id, this.innerSplitId, 'update', {
      dividerPosition: active ? 0.5 : 0,
    })).catch(() => { /* window torn down */ });
    await this.request(request(this.id, this.graphId, 'update', {
      style: { visible: active },
    })).catch(() => { /* window torn down */ });
    if (active) await this.loadGraph();
  }

  /**
   * Build the language map from ALL workspace patterns (the search box
   * filters the list, never the map): one node per pattern, one directed
   * edge per Links reference, and a see-through node per dangling link
   * name. The map widget keeps existing nodes where they are and springs
   * the rest into place.
   */
  private async loadGraph(): Promise<void> {
    if (!this.knowledgeBaseId || !this.graphId) return;

    const patterns = await this.request<KnowledgeEntry[]>(
      request(this.id, this.knowledgeBaseId, 'list', { type: 'pattern', limit: 200 }),
    ).catch(() => [] as KnowledgeEntry[]);

    const byNorm = new Map(patterns.map((p) => [this.normalizeTitle(p.title), p.id]));
    const nodes: Array<Record<string, unknown>> = patterns.map((p) => ({
      id: p.id,
      label: p.title,
      group: 'pattern',
      size: 8 + Math.min(6, p.usefulCount),
    }));
    const ghosts = new Set<string>();
    const edges: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    this.graphLinks.clear();
    for (const p of patterns) {
      const targets: string[] = [];
      for (const name of this.parsePatternLinks(p.content)) {
        const norm = this.normalizeTitle(name);
        let target = byNorm.get(norm);
        const ghost = target === undefined;
        if (ghost) {
          target = `${GHOST_PREFIX}${norm}`;
          if (!ghosts.has(target)) {
            ghosts.add(target);
            nodes.push({ id: target, label: name, group: 'unwritten', ghost: true, size: 6 });
          }
        }
        if (target === p.id || seen.has(`${p.id}>${target}`)) continue;
        seen.add(`${p.id}>${target}`);
        targets.push(target!);
        edges.push({ from: p.id, to: target, ...(ghost ? { style: 'dashed' } : {}) });
      }
      this.graphLinks.set(p.id, targets);
    }

    await this.request(request(this.id, this.graphId, 'setGraph', { nodes, edges }))
      .catch((err) => log.warn('pattern map update failed:', err instanceof Error ? err.message : String(err)));
    if (this.selectedId && patterns.some((p) => p.id === this.selectedId)) {
      await this.request(request(this.id, this.graphId, 'select', { id: this.selectedId })).catch(() => {});
    }
    log.info(`Pattern map: ${nodes.length} nodes (${ghosts.size} unwritten), ${edges.length} links`);
  }

  /** Show the selection on the map (brought into view when it is outside). */
  private async selectOnMap(entryId: string | undefined): Promise<void> {
    if (!this.graphActive()) return;
    await this.request(request(this.id, this.graphId!, 'select', { id: entryId ?? null }))
      .catch(() => { /* not on the map (yet) */ });
  }

  /** A newly woven pattern arrives as living light flowing along its links. */
  private async pulseNewPattern(entryId: string): Promise<void> {
    if (!this.graphActive()) return;
    for (const target of (this.graphLinks.get(entryId) ?? []).slice(0, 6)) {
      await this.request(request(this.id, this.graphId!, 'pulse', { from: entryId, to: target, count: 2 }))
        .catch(() => { /* node not placed yet */ });
    }
  }

  /** Shared selection path for map clicks and link chips: sync list, detail pane, and map. */
  private async selectPattern(entry: KnowledgeEntry): Promise<void> {
    this.selectedId = entry.id;
    const idx = this.filteredEntries.findIndex(e => e.id === entry.id);
    if (idx >= 0 && this.listWidgetId) {
      await this.request(request(this.id, this.listWidgetId, 'update', { selectedIndex: idx }))
        .catch(() => { /* list gone */ });
    }
    await this.showDetail(idx >= 0 ? this.filteredEntries[idx] : entry);
    await this.selectOnMap(entry.id);
  }

  private typeColor(type: KnowledgeType): string {
    switch (type) {
      case 'learned': return this.theme.statusWarning;
      case 'fact': return this.theme.statusSuccess;
      case 'insight': return this.theme.statusNeutral;
      case 'reference': return this.theme.textSecondary;
      case 'pattern': return this.theme.textHeading;
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
        await this.updateGraphPane();
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
      if (entry && this.isRemoteEntry(entry)) {
        this.playEffect('shake');
        await this.notify('This entry belongs to another peer and is read-only here.', 'warning');
        return;
      }
      this.send(event(this.id, this.restoreBtnId, 'update', { busy: true }));
      try {
        const res = await this.request<{ success?: boolean; error?: string }>(
          request(this.id, this.knowledgeBaseId, 'archive', { id: this.selectedId, archived: false })
        );
        if (res && res.success === false) {
          throw new Error(res.error ?? 'entry no longer exists');
        }
        this.playEffect('flash');
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
        this.playEffect('shake');
        const msg = err instanceof Error ? err.message : String(err);
        await this.notify(`Restore failed: ${msg.slice(0, 80)}`, 'error');
      } finally {
        this.send(event(this.id, this.restoreBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Pattern link chip -- navigate to the linked pattern
    if (aspect === 'click' && this.linkButtons.has(fromId)) {
      const target = this.linkButtons.get(fromId)!;
      // Prefer the live entry (the cached one may predate an update)
      const live = this.filteredEntries.find(e => e.id === target.id) ?? target;
      await this.selectPattern(live);
      return;
    }

    // List selection
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const entryId = (data as { value?: string })?.value;
      if (entryId) {
        this.selectedId = entryId;
        const entry = this.filteredEntries.find(e => e.id === entryId);
        if (entry) {
          await this.showDetail(entry);
          if (entry.type === 'pattern') await this.selectOnMap(entry.id);
        }
      }
      return;
    }

    // Map: a click (or double-click) on a pattern node opens it; unwritten
    // names have no entry to open.
    if (fromId === this.graphId && (aspect === 'nodeSelected' || aspect === 'nodeFocused')) {
      const data = typeof value === 'string' ? JSON.parse(value) as { id?: string } : value as { id?: string };
      const id = data?.id;
      if (!id || id.startsWith(GHOST_PREFIX)) return;
      const entry = this.filteredEntries.find(e => e.id === id) ?? this.entries.find(e => e.id === id)
        ?? await this.request<KnowledgeEntry | null>(request(this.id, this.knowledgeBaseId!, 'get', { id })).catch(() => null);
      if (entry) await this.selectPattern(entry);
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      if (!this.selectedId || !this.knowledgeBaseId) return;

      const entry = this.filteredEntries.find(e => e.id === this.selectedId);
      if (entry && this.isRemoteEntry(entry)) {
        this.playEffect('shake');
        await this.notify('This entry belongs to another peer and is read-only here.', 'warning');
        return;
      }
      // Forgetting is two-step, and the dialog says which step this is. A
      // live entry is archived: out of recall and the default list, but kept
      // and restorable. An archived entry is deleted for good, learning
      // history included; the user has now said it twice.
      const deleting = entry?.archived === true;
      const name = entry ? `"${entry.title}"` : 'This entry';
      const confirmed = await this.confirm({
        title: deleting ? 'Delete this knowledge for good?' : 'Forget this knowledge?',
        message: deleting
          ? `${name} is archived and will be permanently removed, along with everything learned from it.`
          : `${name} will be archived: hidden from recall and from this list. Tick "Show archived" to find it again, or forget it once more to delete it.`,
        confirmLabel: deleting ? 'Delete' : 'Forget',
        destructive: true,
      });
      if (!confirmed) return;

      this.send(event(this.id, this.deleteBtnId, 'update', { busy: true }));
      try {
        const res = await this.request<{ success?: boolean; archived?: boolean; deleted?: boolean; error?: string }>(
          request(this.id, this.knowledgeBaseId, 'forget', { id: this.selectedId })
        );
        if (res && res.success === false) {
          throw new Error(res.error ?? 'entry no longer exists');
        }
        await this.notify(
          res?.deleted ? `Deleted ${name}` : `Forgot ${name}: archived, restorable from "Show archived"`,
          'success',
        );
        this.selectedId = undefined;
        await this.showEmptyState(true);
        await this.loadEntries();
      } catch (err) {
        this.playEffect('shake');
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
        // New knowledge saved (by an agent, the reviewer or curation) arrives
        // in the living light; a burst of saves reads as one flash.
        if (aspect === 'entryAdded' && Date.now() - this.lastArrivalFlashAt >= ARRIVAL_FLASH_GAP_MS) {
          this.lastArrivalFlashAt = Date.now();
          this.playEffect('flash');
        }
        await this.loadEntries();
        if (this.graphActive()) {
          await this.loadGraph();
          const added = value as { id?: string; type?: string } | undefined;
          if (aspect === 'entryAdded' && added?.type === 'pattern' && added.id) await this.pulseNewPattern(added.id);
        }
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
