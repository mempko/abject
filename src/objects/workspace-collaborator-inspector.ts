/**
 * WorkspaceCollaboratorInspector — inspector window for shared workspaces.
 *
 * Three panes (same idiom as WorkspaceBrowser):
 *   Pane 1 (left):   Joined + shared workspaces
 *   Pane 2 (middle): Active peer members of the selected workspace
 *   Pane 3 (right):  Detail — presence, latency, catalog items, shared goals backlog
 *
 * Presence comes from PeerRegistry (getConnectedPeers). There is no RTT field
 * anywhere in this system, so latency is measured here by timing an actual
 * round-trip to the peer (WorkspaceShareRegistry.queryPeerWorkspaces).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import type { WorkspaceMemberInfo } from './workspace-share-registry.js';

const log = new Log('WorkspaceCollaboratorInspector');

const WORKSPACE_COLLABORATOR_INSPECTOR_INTERFACE: InterfaceId =
  'abjects:workspace-collaborator-inspector';

const WIN_W = 880;
const WIN_H = 560;

const r0 = { x: 0, y: 0, width: 0, height: 0 };

interface JoinedWorkspaceInfo {
  workspaceId: string;
  name?: string;
  ownerPeerId: string;
  registryId?: string;
  joinedAt: number;
}

interface CatalogItem {
  id?: string;
  name?: string;
  description?: string;
  manifest?: { name?: string; description?: string };
}

interface BacklogGoal {
  id?: string;
  title?: string;
  status?: string;
}

interface MemberRow {
  peerId: string;
  peerName?: string;
  joinedAt: number;
  online: boolean;
  latencyMs?: number;
}

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

type DetailSpec = LabelSpec | ButtonSpec;

export class WorkspaceCollaboratorInspector extends Abject {
  private widgetManagerId?: AbjectId;
  private shareRegistryId?: AbjectId;
  private peerRegistryId?: AbjectId;
  private goalManagerId?: AbjectId;
  private workspaceRegistryId?: AbjectId;
  private workspaceManagerId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private outerSplitId?: AbjectId;
  private innerSplitId?: AbjectId;
  private refreshBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private workspaceListId?: AbjectId;
  private memberListId?: AbjectId;
  private detailPaneId?: AbjectId;

  private detailWidgetIds: AbjectId[] = [];
  private detailButtonIds: Map<AbjectId, string> = new Map();

  // Cached data
  private workspaces: JoinedWorkspaceInfo[] = [];
  private members: MemberRow[] = [];
  private catalogItems: CatalogItem[] = [];
  private backlogGoals: BacklogGoal[] = [];
  private connectedPeers: Set<string> = new Set();

  private selectedWorkspaceIndex = -1;
  private selectedMemberIndex = -1;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceCollaboratorInspector',
        description:
          'Inspect collaborators of shared workspaces: members, presence, latency, catalog and shared goals backlog.',
        version: '1.0.0',
        interface: {
          id: WORKSPACE_COLLABORATOR_INSPECTOR_INTERFACE,
          name: 'WorkspaceCollaboratorInspector',
          description: 'Workspace collaborator inspector UI',
          methods: [
            {
              name: 'show',
              description: 'Show the collaborator inspector window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the collaborator inspector window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'toggle',
              description: 'Toggle the collaborator inspector window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'refresh',
              description: 'Re-fetch members, presence, latency, catalog and goals',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'inspectWorkspace',
              description: 'Show the inspector focused on a specific workspace',
              parameters: [
                {
                  name: 'workspaceId',
                  type: { kind: 'primitive', primitive: 'string' },
                  description: 'ID of the workspace to inspect',
                },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'peer'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('toggle', async () => this.toggle());
    this.on('refresh', async () => this.refresh());

    this.on('inspectWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = (msg.payload ?? {}) as { workspaceId?: string };
      return this.inspectWorkspace(workspaceId ?? '');
    });

    this.on('getState', async () => ({
      visible: !!this.windowId,
      workspaceCount: this.workspaces.length,
      memberCount: this.members.length,
      selectedWorkspaceId: this.selectedWorkspace()?.workspaceId,
    }));

    // Widget events. Button/list widgets report through 'changed'; some report
    // a direct 'clicked'. Both are accepted — whichever the widget emits.
    this.on('changed', async (msg: AbjectMessage) => {
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const aspect = typeof payload['aspect'] === 'string' ? (payload['aspect'] as string) : '';
      await this.onWidgetEvent(msg.routing.from, aspect, payload);
    });

    this.on('clicked', async (msg: AbjectMessage) => {
      await this.onWidgetEvent(
        msg.routing.from,
        'clicked',
        (msg.payload ?? {}) as Record<string, unknown>
      );
    });

    this.on('selectionChanged', async (msg: AbjectMessage) => {
      await this.onWidgetEvent(
        msg.routing.from,
        'selectionChanged',
        (msg.payload ?? {}) as Record<string, unknown>
      );
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

  private async ensureDeps(): Promise<void> {
    if (!this.widgetManagerId) {
      this.widgetManagerId = (await this.discoverDep('WidgetManager')) ?? undefined;
    }
    if (!this.shareRegistryId) {
      this.shareRegistryId = (await this.discoverDep('WorkspaceShareRegistry')) ?? undefined;
    }
    if (!this.peerRegistryId) {
      this.peerRegistryId = (await this.discoverDep('PeerRegistry')) ?? undefined;
    }
    if (!this.goalManagerId) {
      this.goalManagerId = (await this.discoverDep('GoalManager')) ?? undefined;
    }
    if (!this.workspaceRegistryId) {
      this.workspaceRegistryId = (await this.discoverDep('WorkspaceRegistry')) ?? undefined;
    }
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = (await this.discoverDep('WorkspaceManager')) ?? undefined;
    }
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    await this.ensureDeps();
    if (!this.widgetManagerId) {
      log.warn('No WidgetManager — cannot show inspector');
      return false;
    }

    this.selectedMemberIndex = -1;

    await this.fetchWorkspaces();
    if (this.selectedWorkspaceIndex < 0 && this.workspaces.length > 0) {
      this.selectedWorkspaceIndex = 0;
    }

    await this.buildUI();

    await this.rebuildWorkspaceList();
    await this.loadSelectedWorkspace();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    try {
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
    } catch {
      /* window already gone */
    }

    this.windowId = undefined;
    this.resetWidgetTracking();

    this.changed('visibility', false);
    return true;
  }

  async toggle(): Promise<boolean> {
    return this.windowId ? this.hide() : this.show();
  }

  async refresh(): Promise<boolean> {
    if (!this.windowId) return this.show();
    await this.fetchWorkspaces();
    await this.rebuildWorkspaceList();
    await this.loadSelectedWorkspace();
    return true;
  }

  async inspectWorkspace(workspaceId: string): Promise<boolean> {
    await this.show();
    if (!workspaceId) return true;
    const idx = this.workspaces.findIndex(w => w.workspaceId === workspaceId);
    if (idx >= 0) {
      this.selectedWorkspaceIndex = idx;
      this.selectedMemberIndex = -1;
      await this.loadSelectedWorkspace();
    }
    return true;
  }

  private resetWidgetTracking(): void {
    this.rootLayoutId = undefined;
    this.outerSplitId = undefined;
    this.innerSplitId = undefined;
    this.refreshBtnId = undefined;
    this.statusLabelId = undefined;
    this.workspaceListId = undefined;
    this.memberListId = undefined;
    this.detailPaneId = undefined;
    this.detailWidgetIds = [];
    this.detailButtonIds.clear();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Data
  // ═══════════════════════════════════════════════════════════════════

  private selectedWorkspace(): JoinedWorkspaceInfo | undefined {
    if (this.selectedWorkspaceIndex < 0) return undefined;
    if (this.selectedWorkspaceIndex >= this.workspaces.length) return undefined;
    return this.workspaces[this.selectedWorkspaceIndex];
  }

  private async fetchWorkspaces(): Promise<void> {
    this.workspaces = [];
    if (!this.shareRegistryId) return;

    try {
      const joined = await this.request<JoinedWorkspaceInfo[]>(
        request(this.id, this.shareRegistryId, 'getJoinedWorkspaces', {})
      );
      for (const w of joined ?? []) this.workspaces.push(w);
    } catch {
      /* ShareRegistry may not be ready */
    }

    // Workspaces we host and share are collaborator surfaces too.
    try {
      const shared = await this.request<Array<Record<string, unknown>>>(
        request(this.id, this.shareRegistryId, 'getSharedWorkspaces', {})
      );
      for (const s of shared ?? []) {
        const wid = typeof s['workspaceId'] === 'string' ? (s['workspaceId'] as string) : '';
        if (!wid) continue;
        if (this.workspaces.some(w => w.workspaceId === wid)) continue;
        this.workspaces.push({
          workspaceId: wid,
          name: typeof s['name'] === 'string' ? (s['name'] as string) : wid,
          ownerPeerId: '',
          registryId: typeof s['registryId'] === 'string' ? (s['registryId'] as string) : undefined,
          joinedAt: 0,
        });
      }
    } catch {
      /* not shared / not ready */
    }
  }

  private async fetchPresence(): Promise<void> {
    this.connectedPeers = new Set<string>();
    if (!this.peerRegistryId) return;
    try {
      const peers = await this.request<string[]>(
        request(this.id, this.peerRegistryId, 'getConnectedPeers', {})
      );
      for (const p of peers ?? []) this.connectedPeers.add(p);
    } catch {
      /* PeerRegistry unavailable */
    }
  }

  private async fetchMembers(ws: JoinedWorkspaceInfo): Promise<void> {
    this.members = [];
    if (!this.shareRegistryId) return;

    let raw: WorkspaceMemberInfo[] = [];
    try {
      raw = await this.request<WorkspaceMemberInfo[]>(
        request(this.id, this.shareRegistryId, 'getActiveMembers', {
          workspaceId: ws.workspaceId,
        })
      );
    } catch {
      raw = [];
    }

    for (const m of raw ?? []) {
      this.members.push({
        peerId: m.peerId,
        peerName: m.peerName,
        joinedAt: m.joinedAt,
        online: this.connectedPeers.has(m.peerId),
      });
    }

    // The owner of a joined workspace is a collaborator even if it is not
    // listed among the active members we were told about.
    if (ws.ownerPeerId && !this.members.some(m => m.peerId === ws.ownerPeerId)) {
      this.members.unshift({
        peerId: ws.ownerPeerId,
        peerName: undefined,
        joinedAt: ws.joinedAt,
        online: this.connectedPeers.has(ws.ownerPeerId),
      });
    }
  }

  /**
   * Latency is measured, not read: nothing in PeerRouter/PeerRegistry tracks
   * RTT. This times a real request that crosses the peer boundary, so it
   * includes remote processing time, not just network time.
   */
  private async measureLatency(peerId: string): Promise<number | undefined> {
    if (!this.shareRegistryId || !peerId) return undefined;
    const started = Date.now();
    try {
      await this.request(
        request(this.id, this.shareRegistryId, 'queryPeerWorkspaces', { peerId })
      );
      return Date.now() - started;
    } catch {
      return undefined;
    }
  }

  private async measureAllLatencies(): Promise<void> {
    for (const m of this.members) {
      if (!m.online) continue;
      m.latencyMs = await this.measureLatency(m.peerId);
    }
  }

  /**
   * The catalog of a joined workspace lives in that workspace's MIRROR
   * registry (materialized by WorkspaceManager), whose pooled remote entries
   * are exactly what the owner curated to us. The inspector's own workspace
   * registry belongs to a different workspace and knows nothing about it.
   */
  private async fetchCatalog(ws: JoinedWorkspaceInfo): Promise<void> {
    this.catalogItems = [];

    let mirrorRegistryId: AbjectId | undefined = ws.registryId as AbjectId | undefined;
    if (this.workspaceManagerId) {
      try {
        const resolved = await this.request<AbjectId | null>(
          request(this.id, this.workspaceManagerId, 'getWorkspaceRegistryId', { workspaceId: ws.workspaceId })
        );
        if (resolved) mirrorRegistryId = resolved;
      } catch {
        /* fall back to the registry id the share registry recorded */
      }
    }
    if (!mirrorRegistryId) return;

    // listRemote is the pooled (owner-curated) view; list is the wider
    // local-caller view used only when the pooled view is empty.
    for (const method of ['listRemote', 'list'] as const) {
      try {
        const items = await this.request<CatalogItem[]>(
          request(this.id, mirrorRegistryId, method, {})
        );
        if (Array.isArray(items) && items.length > 0) {
          this.catalogItems = items.slice(0, 50);
          return;
        }
      } catch {
        /* try the next source */
      }
    }
  }

  private async fetchBacklog(): Promise<void> {
    this.backlogGoals = [];
    if (!this.goalManagerId) return;
    try {
      const goals = await this.request<BacklogGoal[]>(
        request(this.id, this.goalManagerId, 'listGoals', { status: 'active' })
      );
      this.backlogGoals = (goals ?? []).slice(0, 25);
    } catch {
      /* GoalManager unavailable */
    }
  }

  private async loadSelectedWorkspace(): Promise<void> {
    const ws = this.selectedWorkspace();
    if (!ws) {
      this.members = [];
      this.catalogItems = [];
      this.backlogGoals = [];
      await this.rebuildMemberList();
      await this.rebuildDetailPane();
      await this.updateStatus();
      return;
    }

    await this.fetchPresence();
    await this.fetchMembers(ws);
    await this.measureAllLatencies();
    await this.fetchCatalog(ws);
    await this.fetchBacklog();

    await this.rebuildMemberList();
    await this.rebuildDetailPane();
    await this.updateStatus();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Widget events
  // ═══════════════════════════════════════════════════════════════════

  private readIndex(payload: Record<string, unknown>): number | undefined {
    const raw = payload['index'] ?? payload['selectedIndex'] ?? payload['value'];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
      return Number(raw);
    }
    return undefined;
  }

  private isClick(aspect: string): boolean {
    return (
      aspect === 'clicked' ||
      aspect === 'click' ||
      aspect === 'pressed' ||
      aspect === 'activated'
    );
  }

  private async onWidgetEvent(
    from: AbjectId,
    aspect: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.windowId) return;

    if (from === this.refreshBtnId && this.isClick(aspect)) {
      await this.refresh();
      return;
    }

    const idx = this.readIndex(payload);

    if (from === this.workspaceListId && idx !== undefined) {
      this.selectedWorkspaceIndex = idx;
      this.selectedMemberIndex = -1;
      await this.loadSelectedWorkspace();
      return;
    }

    if (from === this.memberListId && idx !== undefined) {
      this.selectedMemberIndex = idx;
      await this.rebuildDetailPane();
      return;
    }

    const action = this.detailButtonIds.get(from);
    if (action && (this.isClick(aspect) || aspect === '')) {
      await this.handleDetailAction(action);
    }
  }

  private async handleDetailAction(action: string): Promise<void> {
    const ws = this.selectedWorkspace();
    if (!ws || !this.shareRegistryId) return;

    try {
      if (action === 'leave') {
        await this.request(
          request(this.id, this.shareRegistryId, 'leaveWorkspace', {
            workspaceId: ws.workspaceId,
            peerId: ws.ownerPeerId,
          })
        );
        this.selectedWorkspaceIndex = -1;
        await this.refresh();
        return;
      }

      if (action === 'reconcile') {
        await this.request(
          request(this.id, this.shareRegistryId, 'reconcileCatalog', {
            workspaceId: ws.workspaceId,
            peerId: ws.ownerPeerId,
          })
        );
        await this.loadSelectedWorkspace();
        return;
      }

      if (action === 'ping') {
        await this.fetchPresence();
        await this.measureAllLatencies();
        await this.rebuildMemberList();
        await this.rebuildDetailPane();
        await this.updateStatus();
      }
    } catch (err) {
      log.warn('Detail action failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // UI Construction
  // ═══════════════════════════════════════════════════════════════════

  private async attachToLayout(
    layoutId: AbjectId,
    widgetId: AbjectId,
    sizePolicy: Record<string, unknown>,
    preferredSize?: Record<string, unknown>
  ): Promise<void> {
    const child: Record<string, unknown> = { widgetId, sizePolicy };
    if (preferredSize) child['preferredSize'] = preferredSize;
    await this.request(
      request(this.id, layoutId, 'addLayoutChildren', { children: [child] })
    );
  }

  private async buildUI(): Promise<void> {
    const wm = async (method: string, payload: Record<string, unknown>) =>
      this.request<AbjectId>(request(this.id, this.widgetManagerId!, method, payload));

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await wm('createWindowAbject', {
      title: '\uD83D\uDC65 Workspace Collaborators',
      rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
      zIndex: 200,
    });

    this.rootLayoutId = await wm('createVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 4, bottom: 4, left: 4 },
      spacing: 4,
    });

    const headerRowId = await wm('createNestedHBox', {
      parentLayoutId: this.rootLayoutId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 8,
    });
    await this.attachToLayout(
      this.rootLayoutId,
      headerRowId,
      { vertical: 'fixed', horizontal: 'expanding' },
      { height: 30 }
    );

    const windowId = this.windowId;

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // [0] Outer split (workspaces | rest)
          {
            type: 'splitPane',
            windowId,
            orientation: 'horizontal',
            dividerPosition: 0.26,
            minSize: 150,
          },
          // [1] Inner split (members | detail)
          {
            type: 'splitPane',
            windowId,
            orientation: 'horizontal',
            dividerPosition: 0.4,
            minSize: 150,
          },
          // [2] Title
          {
            type: 'label',
            windowId,
            rect: r0,
            text: 'Workspace Collaborators',
            style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 },
          },
          // [3] Refresh
          { type: 'button', windowId, rect: r0, text: 'Refresh', style: { fontSize: 12 } },
          // [4] Workspace list
          { type: 'list', windowId, rect: r0, items: [], searchable: true },
          // [5] Member list
          { type: 'list', windowId, rect: r0, items: [] },
          // [6] Status
          {
            type: 'label',
            windowId,
            rect: r0,
            text: '',
            style: { color: this.theme.statusNeutral, fontSize: 11 },
          },
        ],
      })
    );

    const [outerSplit, innerSplit, titleLabel, refreshBtn, workspaceList, memberList, statusLabel] =
      widgetIds;

    this.outerSplitId = outerSplit;
    this.innerSplitId = innerSplit;
    this.refreshBtnId = refreshBtn;
    this.workspaceListId = workspaceList;
    this.memberListId = memberList;
    this.statusLabelId = statusLabel;

    await this.attachToLayout(this.rootLayoutId, this.outerSplitId, {
      vertical: 'expanding',
      horizontal: 'expanding',
    });

    await this.request(
      request(this.id, headerRowId, 'addLayoutChildren', {
        children: [
          {
            widgetId: titleLabel,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 30 },
          },
          {
            widgetId: this.refreshBtnId,
            sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
            preferredSize: { width: 80, height: 28 },
          },
        ],
      })
    );

    this.detailPaneId = await wm('createDetachedScrollableVBox', {
      windowId,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 4,
    });

    await this.request(
      request(this.id, this.innerSplitId, 'setLeftChild', { widgetId: this.memberListId })
    );
    await this.request(
      request(this.id, this.innerSplitId, 'setRightChild', { widgetId: this.detailPaneId })
    );
    await this.request(
      request(this.id, this.outerSplitId, 'setLeftChild', { widgetId: this.workspaceListId })
    );
    await this.request(
      request(this.id, this.outerSplitId, 'setRightChild', { widgetId: this.innerSplitId })
    );

    await this.attachToLayout(this.rootLayoutId, this.statusLabelId, { vertical: 'fixed' }, { height: 16 });

    this.send(request(this.id, this.refreshBtnId, 'addDependent', {}));
    this.send(request(this.id, this.workspaceListId, 'addDependent', {}));
    this.send(request(this.id, this.memberListId, 'addDependent', {}));
  }

  private async rebuildWorkspaceList(): Promise<void> {
    if (!this.workspaceListId) return;
    const items = this.workspaces.map(w => {
      const label = w.name && w.name !== w.workspaceId ? w.name : w.workspaceId;
      const owner = w.ownerPeerId ? ` \u2190 ${w.ownerPeerId.slice(0, 8)}` : ' (hosted)';
      return `${label}${owner}`;
    });
    try {
      await this.request(
        request(this.id, this.workspaceListId, 'update', {
          items,
          selectedIndex: this.selectedWorkspaceIndex,
        })
      );
    } catch {
      /* widget gone */
    }
  }

  private async rebuildMemberList(): Promise<void> {
    if (!this.memberListId) return;
    const items = this.members.map(m => {
      const dot = m.online ? '\u25CF' : '\u25CB';
      const name = m.peerName || m.peerId.slice(0, 12);
      const lat = m.latencyMs === undefined ? '' : `  ${m.latencyMs}ms`;
      return `${dot} ${name}${lat}`;
    });
    try {
      await this.request(
        request(this.id, this.memberListId, 'update', {
          items,
          selectedIndex: this.selectedMemberIndex,
        })
      );
    } catch {
      /* widget gone */
    }
  }

  private async updateStatus(): Promise<void> {
    if (!this.statusLabelId) return;
    const online = this.members.filter(m => m.online).length;
    const text =
      this.workspaces.length === 0
        ? 'No shared or joined workspaces.'
        : `${this.workspaces.length} workspace(s) \u2022 ${this.members.length} member(s), ${online} online \u2022 ${this.catalogItems.length} catalog item(s) \u2022 ${this.backlogGoals.length} shared goal(s)`;
    try {
      await this.request(request(this.id, this.statusLabelId, 'update', { text }));
    } catch {
      /* widget gone */
    }
  }

  private async rebuildDetailPane(): Promise<void> {
    if (!this.detailPaneId || !this.windowId) return;

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
    } catch {
      /* best effort */
    }

    const windowId = this.windowId;
    const specs: DetailSpec[] = [];

    const heading = (text: string): void => {
      specs.push({
        type: 'label',
        windowId,
        rect: r0,
        text,
        style: { color: this.theme.textHeading, fontSize: 13, fontWeight: 'bold' },
      });
    };
    const line = (text: string): void => {
      specs.push({
        type: 'label',
        windowId,
        rect: r0,
        text,
        style: { color: this.theme.textDescription, fontSize: 11, wordWrap: true },
      });
    };

    const ws = this.selectedWorkspace();

    if (!ws) {
      line('Select a workspace to inspect its collaborators.');
    } else {
      heading(ws.name && ws.name !== ws.workspaceId ? ws.name : ws.workspaceId);
      line(`Workspace ID: ${ws.workspaceId}`);
      line(ws.ownerPeerId ? `Owner peer: ${ws.ownerPeerId}` : 'Owner: this peer (hosted locally)');
      if (ws.registryId) line(`Registry: ${ws.registryId}`);
      if (ws.joinedAt) line(`Joined: ${new Date(ws.joinedAt).toLocaleString()}`);

      // Selected member detail
      const member =
        this.selectedMemberIndex >= 0 && this.selectedMemberIndex < this.members.length
          ? this.members[this.selectedMemberIndex]
          : undefined;

      heading('Members');
      if (this.members.length === 0) {
        line('No active members reported.');
      } else {
        for (const m of this.members) {
          const presence = m.online ? 'online' : 'offline';
          const lat = m.latencyMs === undefined ? 'latency n/a' : `${m.latencyMs}ms`;
          line(`${m.peerName || m.peerId} \u2014 ${presence}, ${lat}`);
        }
      }

      if (member) {
        heading('Selected member');
        line(`Peer ID: ${member.peerId}`);
        line(`Presence: ${member.online ? 'online' : 'offline'}`);
        line(
          member.latencyMs === undefined
            ? 'Latency: not measured (peer offline or unreachable)'
            : `Latency: ${member.latencyMs}ms round-trip`
        );
        if (member.joinedAt) line(`Joined: ${new Date(member.joinedAt).toLocaleString()}`);
      }

      heading(`Catalog (${this.catalogItems.length})`);
      if (this.catalogItems.length === 0) {
        line('No catalog items visible for this workspace.');
      } else {
        for (const item of this.catalogItems) {
          const name = item.manifest?.name || item.name || item.id || '(unnamed)';
          const desc = item.manifest?.description || item.description || '';
          line(desc ? `${name} \u2014 ${desc}` : name);
        }
      }

      heading(`Shared goals backlog (${this.backlogGoals.length})`);
      if (this.backlogGoals.length === 0) {
        line('No active shared goals.');
      } else {
        for (const g of this.backlogGoals) {
          line(`[${g.status || 'active'}] ${g.title || g.id || '(untitled)'}`);
        }
      }

      specs.push({
        type: 'button',
        windowId,
        rect: r0,
        text: 'Ping members',
        style: { fontSize: 12 },
        action: 'ping',
      });
      specs.push({
        type: 'button',
        windowId,
        rect: r0,
        text: 'Reconcile catalog',
        style: { fontSize: 12 },
        action: 'reconcile',
      });
      if (ws.ownerPeerId) {
        specs.push({
          type: 'button',
          windowId,
          rect: r0,
          text: 'Leave workspace',
          style: { fontSize: 12 },
          action: 'leave',
        });
      }
    }

    const createSpecs: Record<string, unknown>[] = specs.map(s => ({
      type: s.type,
      windowId: s.windowId,
      rect: s.rect,
      text: s.text,
      style: s.style,
    }));

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: createSpecs })
    );

    const children: Record<string, unknown>[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const wid = widgetIds[i];
      if (!wid) continue;
      if (spec.type === 'button') {
        this.detailButtonIds.set(wid, spec.action);
        this.send(request(this.id, wid, 'addDependent', {}));
        children.push({
          widgetId: wid,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 150, height: 26 },
        });
      } else {
        this.detailWidgetIds.push(wid);
        children.push({
          widgetId: wid,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 18 },
        });
      }
    }

    if (children.length > 0) {
      await this.request(
        request(this.id, this.detailPaneId, 'addLayoutChildren', { children })
      );
    }
  }
}

export const WORKSPACE_COLLABORATOR_INSPECTOR_ID =
  'abjects:workspace-collaborator-inspector' as AbjectId;
