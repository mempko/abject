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
 * pattern's 'Links: -> NAME' references as clickable chips (click opens
 * the linked pattern), names with no written pattern yet as dimmed
 * "unwritten" labels, and a reverse "Linked from" row of the patterns
 * whose Links name this one.
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

const WIN_W = 900;
const WIN_H = 540;

/** A node in the pattern language map. Ghost nodes are dangling link names. */
interface GraphNode {
  /** Absent for ghost (unwritten) nodes. */
  entry?: KnowledgeEntry;
  title: string;
  norm: string;
  /** Abstract force-layout coordinates. */
  ax: number;
  ay: number;
  /** Last-drawn screen coordinates (hit-testing). */
  sx: number;
  sy: number;
  r: number;
}

interface GraphEdge {
  from: number;
  to: number;
  /** True when the edge points at a ghost node. */
  ghost: boolean;
}

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
  private archivedToggleId?: AbjectId;
  private curateBtnId?: AbjectId;

  private innerSplitId?: AbjectId;
  private graphCanvasId?: AbjectId;
  /** Pattern language map: all workspace patterns + ghost nodes for dangling links. */
  private graphNodes: GraphNode[] = [];
  private graphEdges: GraphEdge[] = [];
  /** View offset applied on top of the fitted layout (centers the selection). */
  private graphPan = { x: 0, y: 0 };

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

    // Raw input from the pattern-map canvas: node clicks select; resizes refit.
    this.on('input', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.graphCanvasId || !this.graphActive()) return;
      const { type, x, y } = msg.payload as { type?: string; x?: number; y?: number };
      if (type === 'canvasResize') {
        await this.drawGraph();
        return;
      }
      if (type !== 'mousedown' || typeof x !== 'number' || typeof y !== 'number') return;

      let hit: GraphNode | undefined;
      let hitDist = Infinity;
      for (const node of this.graphNodes) {
        const d = Math.hypot(node.sx - x, node.sy - y);
        if (d <= Math.max(node.r + 6, 14) && d < hitDist) { hit = node; hitDist = d; }
      }
      if (hit?.entry) await this.selectPattern(hit.entry);
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

    // Split panes: outer = list | rest; inner = graph | detail. The graph
    // pane exists only visually on the Patterns tab (inner divider collapses
    // to 0 elsewhere), so the other tabs keep their two-pane layout.
    const { widgetIds: [splitId, innerSplitId] } = await this.request<{ widgetIds: AbjectId[] }>(
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
        ],
      })
    );
    this.splitPaneId = splitId;
    this.innerSplitId = innerSplitId;

    // Pattern language map canvas (hidden until the Patterns tab is active).
    // Input events (clicks for node selection, canvasResize) come back to
    // this object via the canvas's `input` event.
    this.graphCanvasId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createCanvas', {
        windowId: this.windowId,
        inputTargetId: this.id,
      })
    );
    // createCanvas registers the canvas as a DIRECT window child filling the
    // content area (its no-layout default). Here the split pane manages it,
    // and a widget with two parents gets its backdrop layer re-anchored to
    // whichever render pass ran last (hovering the window snapped the map to
    // the top-left corner). Detach it so only the split pane positions it.
    await this.request(request(this.id, this.windowId, 'removeChild', { widgetId: this.graphCanvasId }));
    await this.request(request(this.id, this.graphCanvasId, 'update', { style: { visible: false } }));

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
    await this.request(request(this.id, this.innerSplitId, 'setLeftChild', { widgetId: this.graphCanvasId }));
    await this.request(request(this.id, this.innerSplitId, 'setRightChild', { widgetId: this.detailLayoutId }));

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
    this.innerSplitId = undefined;
    this.graphCanvasId = undefined;
    this.graphNodes = [];
    this.graphEdges = [];
    this.graphPan = { x: 0, y: 0 };
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
    if (empty) await this.clearLinkRows();

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

    await this.renderPatternLinks(entry);
  }

  // ─── Pattern link navigation ───────────────────────────────────────

  /** Lowercase, strip punctuation, collapse whitespace — the same title key KnowledgeBase resolves links by. */
  private normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /** Parse pattern link names from a pattern body's 'Links: -> NAME, OTHER' line. */
  private parsePatternLinks(content: string): string[] {
    const line = content.match(/^\s*Links:\s*(.+)$/mi)?.[1];
    if (!line) return [];
    return line
      .split(',')
      .map(name => name.replace(/->/g, '').trim())
      .filter(name => name.length > 0);
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
   * 'Links:' names as clickable chips (dimmed "unwritten" when no pattern
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
    return TAB_TYPES[this.activeTab] === 'pattern' && !!this.graphCanvasId;
  }

  /** Collapse or expand the graph pane to match the active tab. */
  private async updateGraphPane(): Promise<void> {
    if (!this.innerSplitId || !this.graphCanvasId) return;
    const active = TAB_TYPES[this.activeTab] === 'pattern';
    await this.request(request(this.id, this.innerSplitId, 'update', {
      dividerPosition: active ? 0.5 : 0,
    })).catch(() => { /* window torn down */ });
    await this.request(request(this.id, this.graphCanvasId, 'update', {
      style: { visible: active },
    })).catch(() => { /* window torn down */ });
    if (active) await this.loadGraph();
  }

  /**
   * Build the language map from ALL workspace patterns (the search box
   * filters the list, never the map): one node per pattern, one directed
   * edge per Links reference, and a ghost node per dangling link name.
   */
  private async loadGraph(): Promise<void> {
    if (!this.knowledgeBaseId || !this.graphCanvasId) return;

    const patterns = await this.request<KnowledgeEntry[]>(
      request(this.id, this.knowledgeBaseId, 'list', { type: 'pattern', limit: 200 }),
    ).catch(() => [] as KnowledgeEntry[]);

    const nodes: GraphNode[] = patterns.map(p => ({
      entry: p,
      title: p.title,
      norm: this.normalizeTitle(p.title),
      ax: 0, ay: 0, sx: 0, sy: 0,
      r: 9 + Math.min(6, p.usefulCount),
    }));
    const byNorm = new Map(nodes.map((node, i) => [node.norm, i]));

    const edges: GraphEdge[] = [];
    for (let i = 0; i < patterns.length; i++) {
      for (const name of this.parsePatternLinks(patterns[i].content)) {
        const norm = this.normalizeTitle(name);
        let target = byNorm.get(norm);
        if (target === undefined) {
          nodes.push({ title: name, norm, ax: 0, ay: 0, sx: 0, sy: 0, r: 7 });
          target = nodes.length - 1;
          byNorm.set(norm, target);
        }
        if (target !== i) edges.push({ from: i, to: target, ghost: !nodes[target].entry });
      }
    }

    this.layoutGraph(nodes, edges);
    this.graphNodes = nodes;
    this.graphEdges = edges;
    this.graphPan = { x: 0, y: 0 };
    await this.drawGraph();
  }

  /**
   * Deterministic force-directed layout in abstract space: seeded on a
   * circle in title order, then relaxed with pairwise repulsion, springs
   * along edges, and light gravity. Small graphs (≤ ~200 nodes) converge
   * in a few hundred cheap iterations.
   */
  private layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    const n = nodes.length;
    if (n === 0) return;
    if (n === 1) { nodes[0].ax = 0; nodes[0].ay = 0; return; }

    const order = nodes.map((_, i) => i)
      .sort((a, b) => nodes[a].norm.localeCompare(nodes[b].norm));
    order.forEach((nodeIdx, k) => {
      const angle = (2 * Math.PI * k) / n;
      nodes[nodeIdx].ax = Math.cos(angle);
      nodes[nodeIdx].ay = Math.sin(angle);
    });

    const REPULSION = 0.5, SPRING = 0.08, REST = 0.55, GRAVITY = 0.04, STEPS = 240;
    const fx = new Array<number>(n), fy = new Array<number>(n);
    for (let step = 0; step < STEPS; step++) {
      const cool = 1 - step / STEPS;
      fx.fill(0); fy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = nodes[i].ax - nodes[j].ax;
          let dy = nodes[i].ay - nodes[j].ay;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-6) { dx = 0.01 * (((i + j) % 5) - 2 || 1); dy = 0.013; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const f = REPULSION / d2 / n;
          fx[i] += (dx / d) * f; fy[i] += (dy / d) * f;
          fx[j] -= (dx / d) * f; fy[j] -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const a = nodes[e.from], b = nodes[e.to];
        const dx = b.ax - a.ax, dy = b.ay - a.ay;
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
        const f = SPRING * (d - REST);
        fx[e.from] += (dx / d) * f; fy[e.from] += (dy / d) * f;
        fx[e.to] -= (dx / d) * f; fy[e.to] -= (dy / d) * f;
      }
      for (let i = 0; i < n; i++) {
        fx[i] -= nodes[i].ax * GRAVITY;
        fy[i] -= nodes[i].ay * GRAVITY;
        const cap = 0.12 * cool;
        nodes[i].ax += Math.max(-cap, Math.min(cap, fx[i]));
        nodes[i].ay += Math.max(-cap, Math.min(cap, fy[i]));
      }
    }
  }

  /** Fit the abstract layout to the canvas (plus pan), render, and record screen coords for hit-testing. */
  private async drawGraph(): Promise<void> {
    if (!this.graphActive()) return;
    // Snapshot nodes+edges together: loadGraph replaces both synchronously,
    // and a resize-triggered draw awaiting getCanvasSize must not mix a
    // stale node array with fresh edge indices.
    const nodes = this.graphNodes;
    const edges = this.graphEdges;

    const size = await this.request<{ width: number; height: number }>(
      request(this.id, this.graphCanvasId!, 'getCanvasSize', {}),
    ).catch(() => null);
    if (!size || size.width < 60 || size.height < 60) return;
    const W = size.width, H = size.height;
    const t = this.theme;
    if (nodes.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const nd of nodes) {
        minX = Math.min(minX, nd.ax); maxX = Math.max(maxX, nd.ax);
        minY = Math.min(minY, nd.ay); maxY = Math.max(maxY, nd.ay);
      }
      const margin = 52;
      const scale = Math.min(
        (W - 2 * margin) / Math.max(maxX - minX, 0.01),
        (H - 2 * margin) / Math.max(maxY - minY, 0.01),
      );
      for (const nd of nodes) {
        nd.sx = (nd.ax - (minX + maxX) / 2) * scale + W / 2 + this.graphPan.x;
        nd.sy = (nd.ay - (minY + maxY) / 2) * scale + H / 2 + this.graphPan.y;
      }
    }

    const cmds: Array<{ type: string; surfaceId: string; params: Record<string, unknown> }> = [];
    const c = (type: string, params: Record<string, unknown>) => cmds.push({ type, surfaceId: 'c', params });

    c('clear', { color: t.canvasBg });
    c('text', { x: 10, y: 16, text: 'Pattern language', fill: t.textTertiary, font: '10px sans-serif' });

    if (nodes.length === 0) {
      c('text', {
        x: W / 2, y: H / 2, align: 'center',
        text: 'No patterns yet — the language grows as goals complete',
        fill: t.textTertiary, font: '11px sans-serif',
      });
    }

    for (const e of edges) {
      const a = nodes[e.from], b = nodes[e.to];
      const stroke = e.ghost ? t.textTertiary : t.divider;
      if (e.ghost) c('setLineDash', { segments: [4, 4] });
      c('line', { x1: a.sx, y1: a.sy, x2: b.sx, y2: b.sy, stroke, lineWidth: 1.2 });
      if (e.ghost) c('setLineDash', { segments: [] });
      // Arrowhead just outside the target node's rim
      const dx = b.sx - a.sx, dy = b.sy - a.sy;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const tipX = b.sx - ux * (b.r + 3), tipY = b.sy - uy * (b.r + 3);
      c('polygon', {
        points: [
          { x: tipX, y: tipY },
          { x: tipX - ux * 7 - uy * 4, y: tipY - uy * 7 + ux * 4 },
          { x: tipX - ux * 7 + uy * 4, y: tipY - uy * 7 - ux * 4 },
        ],
        fill: stroke,
      });
    }

    for (const nd of nodes) {
      const selected = !!nd.entry && nd.entry.id === this.selectedId;
      if (!nd.entry) {
        c('setLineDash', { segments: [3, 3] });
        c('circle', { cx: nd.sx, cy: nd.sy, radius: nd.r, stroke: t.textTertiary, lineWidth: 1 });
        c('setLineDash', { segments: [] });
      } else {
        if (selected) {
          c('circle', { cx: nd.sx, cy: nd.sy, radius: nd.r + 4, stroke: t.accent, lineWidth: 2 });
        }
        c('circle', {
          cx: nd.sx, cy: nd.sy, radius: nd.r,
          fill: t.windowBg,
          stroke: selected ? t.accent : t.textHeading,
          lineWidth: selected ? 2 : 1.4,
        });
      }
      const label = nd.title.length > 20 ? `${nd.title.slice(0, 19)}…` : nd.title;
      c('text', {
        x: nd.sx, y: nd.sy + nd.r + 12, text: label, align: 'center',
        fill: nd.entry ? (selected ? t.accent : t.textPrimary) : t.textTertiary,
        font: selected ? 'bold 10px sans-serif' : '10px sans-serif',
      });
      if (!nd.entry) {
        c('text', {
          x: nd.sx, y: nd.sy + nd.r + 23, text: '(unwritten)', align: 'center',
          fill: t.textTertiary, font: '9px sans-serif',
        });
      }
    }

    await this.request(request(this.id, this.graphCanvasId!, 'draw', { commands: cmds }))
      .catch(err => log.warn('graph draw failed:', err instanceof Error ? err.message : String(err)));
    log.info(`Pattern map drawn: ${nodes.length} nodes, ${edges.length} edges (${W}x${H})`);
  }

  /** Pan the map so the given pattern's node sits at the canvas center, and redraw. */
  private async centerGraphOn(entryId: string): Promise<void> {
    if (!this.graphActive()) return;
    const size = await this.request<{ width: number; height: number }>(
      request(this.id, this.graphCanvasId!, 'getCanvasSize', {}),
    ).catch(() => null);
    const node = this.graphNodes.find(nd => nd.entry?.id === entryId);
    if (size && node) {
      this.graphPan.x += size.width / 2 - node.sx;
      this.graphPan.y += size.height / 2 - node.sy;
    }
    await this.drawGraph();
  }

  /** Shared selection path for graph clicks: sync list, detail pane, and map. */
  private async selectPattern(entry: KnowledgeEntry): Promise<void> {
    this.selectedId = entry.id;
    const idx = this.filteredEntries.findIndex(e => e.id === entry.id);
    if (idx >= 0 && this.listWidgetId) {
      await this.request(request(this.id, this.listWidgetId, 'update', { selectedIndex: idx }))
        .catch(() => { /* list gone */ });
    }
    await this.showDetail(idx >= 0 ? this.filteredEntries[idx] : entry);
    await this.centerGraphOn(entry.id);
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
          if (entry.type === 'pattern') await this.centerGraphOn(entry.id);
        }
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
        if (this.graphActive()) await this.loadGraph();
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
