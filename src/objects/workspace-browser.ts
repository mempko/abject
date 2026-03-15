/**
 * WorkspaceBrowser — three-pane browser for discovered remote workspaces.
 *
 * Three vertical panes (like AppExplorer):
 *   Pane 1 (left): Peer list grouped into "Public Peers" and "Private Peers"
 *   Pane 2 (middle): Workspaces belonging to the selected peer
 *   Pane 3 (right): Detail — description, tags, access mode, Browse button
 */

import { AbjectId, AbjectMessage, InterfaceId, SpawnResult } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { DiscoveredWorkspace } from './workspace-share-registry.js';

const log = new Log('WorkspaceBrowser');

const WORKSPACE_BROWSER_INTERFACE: InterfaceId = 'abjects:workspace-browser';

const WIN_W = 820;
const WIN_H = 500;

export class WorkspaceBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private shareRegistryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private refreshBtnId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Cached data
  private cachedWorkspaces: DiscoveredWorkspace[] = [];

  // Pane 1: Peer list with Public/Private tabs
  private peerPaneVBoxId?: AbjectId;
  private peerTabBarId?: AbjectId;
  private publicPeerListId?: AbjectId;
  private privatePeerListId?: AbjectId;
  private publicPeerEntries: string[] = [];  // ownerPeerId values
  private privatePeerEntries: string[] = [];
  private activePeerTab = 0; // 0=public, 1=private

  // Pane 2: Workspace list for selected peer
  private workspaceListId?: AbjectId;
  private workspaceEntries: DiscoveredWorkspace[] = [];

  // Pane 3: Detail pane (scrollable VBox)
  private detailPaneId?: AbjectId;
  private detailWidgetIds: AbjectId[] = [];
  private detailButtonIds: Map<AbjectId, string> = new Map();

  // Selection state
  private selectedPeerId?: string;
  private selectedPeerIsPrivate = false;
  private selectedWorkspaceIndex = -1;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceBrowser',
        description:
          'Browse discovered remote workspaces from connected peers.',
        version: '1.0.0',
        interface: {
            id: WORKSPACE_BROWSER_INTERFACE,
            name: 'WorkspaceBrowser',
            description: 'Remote workspace browser UI',
            methods: [
              {
                name: 'show',
                description: 'Show the workspace browser window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the workspace browser window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'refresh',
                description: 'Refresh workspace discovery and rebuild the UI',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display workspace browser', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'peer'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;

    // Subscribe to WSR events for auto-refresh on new discoveries
    if (this.shareRegistryId) {
      try {
        await this.request(
          request(this.id, this.shareRegistryId, 'addDependent', {})
        );
      } catch { /* WSR may not be ready */ }
    }
  }

  // ── Helpers ──

  private async addToLayout(
    layoutId: AbjectId, widgetId: AbjectId,
    sizePolicy: Record<string, string>,
    preferredSize?: Record<string, number>,
  ): Promise<void> {
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId,
      sizePolicy,
      ...(preferredSize ? { preferredSize } : {}),
    }));
  }

  private clearWidgetTracking(): void {
    this.rootLayoutId = undefined;
    this.peerPaneVBoxId = undefined;
    this.peerTabBarId = undefined;
    this.publicPeerListId = undefined;
    this.privatePeerListId = undefined;
    this.workspaceListId = undefined;
    this.detailPaneId = undefined;
    this.detailWidgetIds = [];
    this.detailButtonIds.clear();
    this.refreshBtnId = undefined;
    this.statusLabelId = undefined;
    this.publicPeerEntries = [];
    this.privatePeerEntries = [];
    this.workspaceEntries = [];
    this.selectedPeerId = undefined;
    this.selectedPeerIsPrivate = false;
    this.selectedWorkspaceIndex = -1;
  }

  // ── Handlers ──

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('refresh', async () => {
      return this.refresh();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });
  }

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    if (fromId === this.refreshBtnId && aspect === 'click') {
      await this.refresh();
      return;
    }

    // Peer tab bar change
    if (fromId === this.peerTabBarId && aspect === 'change') {
      this.activePeerTab = value as number;
      await this.switchPeerTabVisibility();
      return;
    }

    // Public peer list selection
    if (fromId === this.publicPeerListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      this.selectedPeerId = sel.value;
      this.selectedPeerIsPrivate = false;
      await this.request(request(this.id, this.privatePeerListId!, 'update', { selectedIndex: -1 }));
      await this.rebuildWorkspaceList();
      return;
    }

    // Private peer list selection
    if (fromId === this.privatePeerListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      this.selectedPeerId = sel.value;
      this.selectedPeerIsPrivate = true;
      await this.request(request(this.id, this.publicPeerListId!, 'update', { selectedIndex: -1 }));
      await this.rebuildWorkspaceList();
      return;
    }

    // Workspace list selection
    if (fromId === this.workspaceListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      const idx = this.workspaceEntries.findIndex(e =>
        `${e.ownerPeerId}:${e.workspaceId}` === sel.value
      );
      this.selectedWorkspaceIndex = idx;
      await this.rebuildDetailPane();
      return;
    }

    // WSR: new workspaces discovered — auto-refresh if visible
    if (fromId === this.shareRegistryId && aspect === 'workspacesDiscovered') {
      if (this.windowId) {
        await this.fetchAndRebuild();
      }
      return;
    }

    // Detail pane button clicks
    const action = this.detailButtonIds.get(fromId);
    if (action && aspect === 'click') {
      if (action === 'browse') {
        const ws = this.workspaceEntries[this.selectedWorkspaceIndex];
        if (ws) await this.openRemoteBrowser(ws);
      }
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Show / Hide / Refresh
  // ═══════════════════════════════════════════════════════════════════

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    if (!this.shareRegistryId) {
      this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }

    // Reset selection
    this.selectedPeerId = undefined;
    this.selectedPeerIsPrivate = false;
    this.selectedWorkspaceIndex = -1;

    // Fetch workspaces
    await this.fetchWorkspaces();

    // Build UI
    await this.buildUI();

    // Populate pane 1
    await this.rebuildPeerList();
    await this.rebuildDetailPane();

    // Update status
    await this.updateStatus();

    // Kick off background discovery to refresh stale cache
    if (this.shareRegistryId) {
      this.request(
        request(this.id, this.shareRegistryId, 'discoverWorkspaces', { hops: 1 })
      ).catch(() => { /* best-effort background refresh */ });
    }

    await this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.clearWidgetTracking();

    await this.changed('visibility', false);
    return true;
  }

  async refresh(): Promise<boolean> {
    log.info('refresh — calling discoverWorkspaces');
    if (!this.shareRegistryId) {
      this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }

    // Trigger discovery
    if (this.shareRegistryId) {
      try {
        await this.request(
          request(this.id, this.shareRegistryId, 'discoverWorkspaces', { hops: 1 })
        );
      } catch { /* best-effort */ }
    }

    log.info('discovery done, rebuilding UI');
    if (this.windowId) {
      await this.fetchAndRebuild();
    } else {
      await this.show();
    }
    return true;
  }

  private async fetchWorkspaces(): Promise<void> {
    this.cachedWorkspaces = [];
    if (this.shareRegistryId) {
      try {
        this.cachedWorkspaces = await this.request<DiscoveredWorkspace[]>(
          request(this.id, this.shareRegistryId, 'getDiscoveredWorkspaces', {})
        );
      } catch { /* ShareRegistry may not be ready */ }
    }
  }

  private async fetchAndRebuild(): Promise<void> {
    await this.fetchWorkspaces();
    await this.rebuildPeerList();
    if (this.selectedPeerId) {
      await this.rebuildWorkspaceList();
    }
    await this.updateStatus();
  }

  // ═══════════════════════════════════════════════════════════════════
  // UI Construction
  // ═══════════════════════════════════════════════════════════════════

  private async buildUI(): Promise<void> {
    const wm = async (method: string, payload: Record<string, unknown>) =>
      this.request<AbjectId>(request(this.id, this.widgetManagerId!, method, payload));

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await wm('createWindowAbject', {
      title: '\uD83D\uDD0E Workspace Browser',
      rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
      zIndex: 200,
    });

    // Root VBox
    this.rootLayoutId = await wm('createVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 4, bottom: 4, left: 4 },
      spacing: 4,
    });

    // Header row (auto-added to root at pos 0)
    const headerRowId = await wm('createNestedHBox', {
      parentLayoutId: this.rootLayoutId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 8,
    });
    await this.addToLayout(this.rootLayoutId, headerRowId,
      { vertical: 'fixed', horizontal: 'expanding' }, { height: 30 });

    // Three-pane HBox (auto-added to root at pos 1)
    const paneHBox = await wm('createNestedHBox', {
      parentLayoutId: this.rootLayoutId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 4,
    });
    await this.addToLayout(this.rootLayoutId, paneHBox,
      { vertical: 'expanding', horizontal: 'expanding' });

    // Pane 1: Peer list VBox (auto-added to paneHBox at pos 0)
    this.peerPaneVBoxId = await wm('createNestedVBox', {
      parentLayoutId: paneHBox,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 2,
    });
    await this.addToLayout(paneHBox, this.peerPaneVBoxId,
      { horizontal: 'expanding' }, { width: 200 });

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const windowId = this.windowId;

    // Batch create non-layout widgets
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // [0] Title label
          { type: 'label', windowId, rect: r0, text: 'Workspace Browser',
            style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
          // [1] Refresh button
          { type: 'button', windowId, rect: r0, text: 'Refresh',
            style: { fontSize: 12 } },
          // [2] Peer tab bar (Public / Private)
          { type: 'tabBar', windowId, rect: r0,
            tabs: ['Public', 'Private'], selectedIndex: this.activePeerTab, closable: false },
          // [3] Public peer list (searchable)
          { type: 'list', windowId, rect: r0, items: [], searchable: true },
          // [4] Private peer list
          { type: 'list', windowId, rect: r0, items: [] },
          // [5] Workspace list (Pane 2)
          { type: 'list', windowId, rect: r0, items: [] },
          // [6] Status label
          { type: 'label', windowId, rect: r0, text: '',
            style: { color: this.theme.statusNeutral, fontSize: 11 } },
        ],
      })
    );

    const [titleLabel, refreshBtn, peerTabBar, publicPeerList,
      privatePeerList, workspaceList, statusLabel] = widgetIds;

    this.refreshBtnId = refreshBtn;
    this.peerTabBarId = peerTabBar;
    this.publicPeerListId = publicPeerList;
    this.privatePeerListId = privatePeerList;
    this.workspaceListId = workspaceList;
    this.statusLabelId = statusLabel;

    // Header row children
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: titleLabel, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } },
        { widgetId: this.refreshBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 80, height: 28 } },
      ],
    }));

    // Pane 1 children: tab bar, public list, private list
    await this.request(request(this.id, this.peerPaneVBoxId, 'addLayoutChildren', {
      children: [
        { widgetId: this.peerTabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 32 } },
        { widgetId: this.publicPeerListId, sizePolicy: { vertical: 'expanding' } },
        { widgetId: this.privatePeerListId, sizePolicy: { vertical: 'expanding' } },
      ],
    }));

    // Pane 2: workspace list added to paneHBox BEFORE creating detail pane
    await this.addToLayout(paneHBox, this.workspaceListId,
      { horizontal: 'expanding' }, { width: 280 });

    // Pane 3: detail pane (created AFTER workspace list for correct auto-append order)
    this.detailPaneId = await wm('createNestedScrollableVBox', {
      parentLayoutId: paneHBox,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 4,
    });
    await this.addToLayout(paneHBox, this.detailPaneId,
      { horizontal: 'expanding' }, { width: 340 });

    // Status label at bottom of root
    await this.addToLayout(this.rootLayoutId, this.statusLabelId,
      { vertical: 'fixed' }, { height: 16 });

    // Register dependents
    this.send(request(this.id, this.refreshBtnId, 'addDependent', {}));
    this.send(request(this.id, this.peerTabBarId, 'addDependent', {}));
    this.send(request(this.id, this.publicPeerListId, 'addDependent', {}));
    this.send(request(this.id, this.privatePeerListId, 'addDependent', {}));
    this.send(request(this.id, this.workspaceListId, 'addDependent', {}));

    // Show only the active tab's list
    await this.switchPeerTabVisibility();
  }

  private async switchPeerTabVisibility(): Promise<void> {
    if (this.publicPeerListId) {
      try {
        await this.request(request(this.id, this.publicPeerListId, 'update', {
          style: { visible: this.activePeerTab === 0 },
        }));
      } catch { /* widget gone */ }
    }
    if (this.privatePeerListId) {
      try {
        await this.request(request(this.id, this.privatePeerListId, 'update', {
          style: { visible: this.activePeerTab === 1 },
        }));
      } catch { /* widget gone */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Peer List (Pane 1)
  // ═══════════════════════════════════════════════════════════════════

  private groupByPeer(): {
    publicPeers: Map<string, DiscoveredWorkspace[]>;
    privatePeers: Map<string, DiscoveredWorkspace[]>;
  } {
    const publicPeers = new Map<string, DiscoveredWorkspace[]>();
    const privatePeers = new Map<string, DiscoveredWorkspace[]>();
    for (const ws of this.cachedWorkspaces) {
      const target = ws.accessMode === 'private' ? privatePeers : publicPeers;
      const group = target.get(ws.ownerPeerId);
      if (group) group.push(ws);
      else target.set(ws.ownerPeerId, [ws]);
    }
    return { publicPeers, privatePeers };
  }

  private async rebuildPeerList(): Promise<void> {
    if (!this.publicPeerListId || !this.privatePeerListId) return;

    const { publicPeers, privatePeers } = this.groupByPeer();

    // Public peers
    this.publicPeerEntries = Array.from(publicPeers.keys()).sort();
    const publicItems = this.publicPeerEntries.map(peerId => {
      const workspaces = publicPeers.get(peerId)!;
      const name = workspaces[0]?.ownerName || peerId.slice(0, 16) + '...';
      return { label: name, value: peerId, secondary: `(${workspaces.length})` };
    });
    let publicSelected = -1;
    if (this.selectedPeerId && !this.selectedPeerIsPrivate) {
      publicSelected = this.publicPeerEntries.indexOf(this.selectedPeerId);
    }
    await this.request(request(this.id, this.publicPeerListId, 'update', {
      items: publicItems, selectedIndex: publicSelected,
    }));

    // Private peers
    this.privatePeerEntries = Array.from(privatePeers.keys()).sort();
    const privateItems = this.privatePeerEntries.map(peerId => {
      const workspaces = privatePeers.get(peerId)!;
      const name = workspaces[0]?.ownerName || peerId.slice(0, 16) + '...';
      return { label: name, value: peerId, secondary: `(${workspaces.length})` };
    });
    let privateSelected = -1;
    if (this.selectedPeerId && this.selectedPeerIsPrivate) {
      privateSelected = this.privatePeerEntries.indexOf(this.selectedPeerId);
    }
    await this.request(request(this.id, this.privatePeerListId, 'update', {
      items: privateItems, selectedIndex: privateSelected,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Workspace List (Pane 2)
  // ═══════════════════════════════════════════════════════════════════

  private async rebuildWorkspaceList(): Promise<void> {
    if (!this.workspaceListId) return;

    if (!this.selectedPeerId) {
      this.workspaceEntries = [];
      this.selectedWorkspaceIndex = -1;
      await this.request(request(this.id, this.workspaceListId, 'update', {
        items: [], selectedIndex: -1,
      }));
      await this.rebuildDetailPane();
      return;
    }

    const { publicPeers, privatePeers } = this.groupByPeer();
    const peerMap = this.selectedPeerIsPrivate ? privatePeers : publicPeers;
    this.workspaceEntries = peerMap.get(this.selectedPeerId) ?? [];

    // Auto-select if exactly one workspace
    this.selectedWorkspaceIndex = this.workspaceEntries.length === 1 ? 0 : -1;

    const items = this.workspaceEntries.map(ws => ({
      label: ws.name,
      value: `${ws.ownerPeerId}:${ws.workspaceId}`,
      secondary: ws.accessMode,
    }));

    await this.request(request(this.id, this.workspaceListId, 'update', {
      items,
      selectedIndex: this.selectedWorkspaceIndex,
    }));
    await this.rebuildDetailPane();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Detail Pane (Pane 3)
  // ═══════════════════════════════════════════════════════════════════

  private async rebuildDetailPane(): Promise<void> {
    if (!this.detailPaneId || !this.windowId) return;

    // Destroy old detail widgets
    for (const wid of this.detailWidgetIds) {
      this.send(request(this.id, wid, 'destroy', {}));
    }
    for (const [btnId] of this.detailButtonIds) {
      this.send(request(this.id, btnId, 'destroy', {}));
    }
    this.detailWidgetIds = [];
    this.detailButtonIds.clear();

    try {
      await this.request(request(this.id, this.detailPaneId, 'clearLayoutChildren', {}));
    } catch { /* best effort */ }

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const windowId = this.windowId;

    // No selection → placeholder
    if (this.selectedWorkspaceIndex < 0 || this.selectedWorkspaceIndex >= this.workspaceEntries.length) {
      const { widgetIds: [placeholderId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId, rect: r0,
              text: 'Select a workspace to view details.',
              style: { color: this.theme.statusNeutral, fontSize: 12 } },
          ],
        })
      );
      this.detailWidgetIds.push(placeholderId);
      await this.request(request(this.id, this.detailPaneId, 'addLayoutChildren', {
        children: [
          { widgetId: placeholderId, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 20 } },
        ],
      }));
      return;
    }

    const ws = this.workspaceEntries[this.selectedWorkspaceIndex];

    type LabelSpec = {
      type: 'label';
      windowId: AbjectId;
      rect: { x: number; y: number; width: number; height: number };
      text: string;
      style: Record<string, unknown>;
    };
    type ButtonSpec = {
      type: 'button';
      windowId: AbjectId;
      rect: { x: number; y: number; width: number; height: number };
      text: string;
      style: Record<string, unknown>;
      action: string;
    };
    type WidgetSpec = LabelSpec | ButtonSpec;

    const specs: WidgetSpec[] = [];

    // Name (bold)
    specs.push({ type: 'label', windowId, rect: r0,
      text: ws.name,
      style: { color: this.theme.textHeading, fontSize: 13, fontWeight: 'bold' } });

    // Description
    if (ws.description) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: ws.description,
        style: { color: this.theme.textDescription, fontSize: 11, wordWrap: true } });
    }

    // Access mode
    specs.push({ type: 'label', windowId, rect: r0,
      text: `Access: ${ws.accessMode}`,
      style: { color: this.theme.textMeta, fontSize: 11 } });

    // Owner
    const ownerLabel = ws.ownerName || ws.ownerPeerId.slice(0, 16) + '...';
    specs.push({ type: 'label', windowId, rect: r0,
      text: `Owner: ${ownerLabel}`,
      style: { color: this.theme.textMeta, fontSize: 11 } });

    // Tags
    const tags = ws.tags ?? [];
    if (tags.length > 0) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Tags: ${tags.join(', ')}`,
        style: { color: this.theme.textMeta, fontSize: 11 } });
    }

    // Hops
    if (ws.hops > 0) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Hops: ${ws.hops}`,
        style: { color: this.theme.textMeta, fontSize: 11 } });
    }

    // Browse button
    if (ws.registryId) {
      specs.push({ type: 'button', windowId, rect: r0,
        text: 'Browse', style: { fontSize: 12 }, action: 'browse' });
    }

    // Strip action field before sending to create
    const batchSpecs = specs.map(s => {
      const { action: _action, ...rest } = s as ButtonSpec;
      return rest;
    });

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: batchSpecs })
    );

    // Build layout children and track buttons
    type LayoutChild = {
      widgetId: AbjectId;
      sizePolicy: { vertical: string; horizontal?: string };
      preferredSize?: { width?: number; height?: number };
    };
    const layoutChildren: LayoutChild[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const wid = widgetIds[i];
      this.detailWidgetIds.push(wid);

      if (spec.type === 'button') {
        this.detailButtonIds.set(wid, (spec as ButtonSpec).action);
        this.send(request(this.id, wid, 'addDependent', {}));
        layoutChildren.push({
          widgetId: wid,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        });
      } else {
        let height = 16;
        if (spec.text === ws.name) height = 20;
        else if (ws.description && spec.text === ws.description) height = 18;

        layoutChildren.push({
          widgetId: wid,
          sizePolicy: { vertical: 'fixed' },
          preferredSize: { height },
        });
      }
    }

    await this.request(request(this.id, this.detailPaneId, 'addLayoutChildren', {
      children: layoutChildren,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Status
  // ═══════════════════════════════════════════════════════════════════

  private async updateStatus(): Promise<void> {
    if (!this.statusLabelId) return;

    const count = this.cachedWorkspaces.length;
    let statusText = `${count} workspace${count !== 1 ? 's' : ''} discovered`;

    if (count > 0) {
      const newestAt = Math.max(...this.cachedWorkspaces.map(w => w.discoveredAt));
      const ageSec = Math.floor((Date.now() - newestAt) / 1000);
      if (ageSec > 60) {
        const ageMin = Math.floor(ageSec / 60);
        statusText += ` \u00b7 Last updated ${ageMin}m ago`;
      }
    }

    try {
      await this.request(request(this.id, this.statusLabelId, 'update', {
        text: statusText,
      }));
    } catch { /* widget gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Remote Browser
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Open AppExplorer in remote mode for the given workspace.
   */
  private async openRemoteBrowser(ws: DiscoveredWorkspace): Promise<void> {
    if (!ws.registryId) return;

    try {
      // Resolve the current registryId from PeerRouter's workspace route.
      let registryId = ws.registryId;
      const peerRouterId = await this.discoverDep('PeerRouter');
      if (peerRouterId) {
        const resolved = await this.request<string | null>(
          request(this.id, peerRouterId, 'resolveWorkspaceRegistry', {
            ownerPeerId: ws.ownerPeerId,
            workspaceId: ws.workspaceId,
          })
        );
        if (resolved) {
          registryId = resolved;
        }
      }

      const factoryId = await this.discoverDep('Factory');
      if (!factoryId) return;

      const result = await this.request<SpawnResult>(
        request(this.id, factoryId, 'spawn', {
          manifest: {
            name: 'AppExplorer',
            description: '',
            version: '1.0.0',
            requiredCapabilities: [],
            tags: ['system'],
          },
        })
      );

      await this.request(
        request(this.id, result.objectId, 'browseRemote', {
          registryId,
          peerId: ws.ownerPeerId,
          label: `${ws.name} (${ws.ownerName || ws.ownerPeerId.slice(0, 8)})`,
        })
      );
    } catch (err) {
      log.warn('Failed to open remote browser:', err);
    }
  }
}

export const WORKSPACE_BROWSER_ID = 'abjects:workspace-browser' as AbjectId;
