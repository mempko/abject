/**
 * AppExplorer — three-pane object explorer.
 *
 * Three vertical panes (like ObjectBrowser):
 *   Pane 1 (left): Kind list grouped into "User Apps" and "System" sections
 *   Pane 2 (middle): Instances of selected kind
 *   Pane 3 (right): Detail — description, manifest info, action buttons
 *
 * Supports remote mode via `browseRemote` handler. In remote mode,
 * Clone/Delete are replaced by "Clone to Local" (copies source to local workspace).
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { isHostLocalObject } from './host-local-objects.js';
import { Log } from '../core/timed-log.js';

const log = new Log('AppExplorer');

const APP_EXPLORER_INTERFACE: InterfaceId = 'abjects:app-explorer';

/**
 * Deep-copy the internal data carried by a registration, so the clone's data
 * is independent of the original's. Returns undefined if the registration has
 * no data or if it isn't JSON-serializable.
 */
function cloneSourceData(obj: ObjectRegistration): Record<string, unknown> | undefined {
  const data = (obj as unknown as { data?: Record<string, unknown> }).data;
  if (data === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return undefined;
  }
}

const WIN_W = 820;
const WIN_H = 500;

export class AppExplorer extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  /**
   * The active workspace's own registry. Peer provenance (`ownerPeerId`) exists
   * only on WorkspaceRegistry's pooled remote entries; the global Registry's
   * `list` never carries it, so the Shared tab must read from here.
   */
  private workspaceRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private outerSplitId?: AbjectId;
  private innerSplitId?: AbjectId;
  private cachedObjects: ObjectRegistration[] = [];

  // ── Remote mode ──
  private isRemote = false;
  private remoteLabel?: string;
  private remoteRegistryId?: AbjectId;

  // ── Pane 1: Kind lists with User/System tabs ──
  private kindPaneVBoxId?: AbjectId;
  private kindTabBarId?: AbjectId;
  private userKindListId?: AbjectId;
  private systemKindListId?: AbjectId;
  private sharedKindListId?: AbjectId;
  private activeKindTab = 0; // 0=user, 1=system, 2=shared
  private userKindEntries: string[] = [];
  private systemKindEntries: string[] = [];
  private sharedKindEntries: string[] = [];

  // ── Pane 2: Instance list ──
  private instancePaneVBoxId?: AbjectId;
  private instanceListId?: AbjectId;
  private instanceEntries: ObjectRegistration[] = [];

  // ── Pane 3: Detail pane (scrollable VBox) ──
  private detailPaneId?: AbjectId;
  private detailWidgetIds: AbjectId[] = [];
  private detailButtonIds: Map<AbjectId, string> = new Map();

  // ── Shared workspace context (drives the optional Shared tab) ──
  private isSharedWorkspace = false;
  private exposedObjectIds: Set<AbjectId> = new Set();
  private sharedOwnerNames: Map<string, string> = new Map();
  private localOwnerName?: string;

  // ── Selection state ──
  private selectedKindName?: string;
  private selectedKindTab = 0; // tab the selected kind came from (0=user, 1=system, 2=shared)
  private selectedInstanceIndex = -1;

  // ── Workspace picker modal ──
  private pickerBackdropId?: AbjectId;
  private pickerDialogId?: AbjectId;
  private pickerSelectId?: AbjectId;
  private pickerCloneBtnId?: AbjectId;
  private pickerCancelBtnId?: AbjectId;
  private pickerResolve?: (index: number | null) => void;

  constructor() {
    super({
      manifest: {
        name: 'AppExplorer',
        description:
          'Workspace Abject explorer — browse, clone, and delete registered Abjects.',
        version: '1.0.0',
        interface: {
            id: APP_EXPLORER_INTERFACE,
            name: 'AppExplorer',
            description: 'Workspace app explorer panel',
            methods: [
              {
                name: 'show',
                description: 'Show the app explorer window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the app explorer window',
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
              {
                name: 'browseRemote',
                description: 'Open in remote mode browsing a remote workspace registry (read-only)',
                parameters: [
                  { name: 'registryId', type: { kind: 'primitive', primitive: 'string' }, description: 'Remote registry AbjectId' },
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Remote peer ID' },
                  { name: 'label', type: { kind: 'primitive', primitive: 'string' }, description: 'Display label for remote workspace' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display explorer window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  private get effectiveRegistryId(): AbjectId | undefined {
    return this.remoteRegistryId ?? this.workspaceRegistryId ?? this.registryId;
  }

  private get selectedKindIsSystem(): boolean {
    return this.selectedKindTab === 1;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.discoverDep('Factory') ?? undefined;
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;

    if (this.registryId) {
      await this.request(request(this.id, this.registryId, 'subscribe', {}));
    }
  }

  private async registryList(): Promise<ObjectRegistration[]> {
    const regId = this.effectiveRegistryId;
    if (!regId) return [];
    try {
      return await this.request<ObjectRegistration[]>(
        request(this.id, regId, 'list', {})
      );
    } catch {
      // Remote registry may be unreachable (route expired, peer disconnected)
      return [];
    }
  }

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

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
    this.outerSplitId = undefined;
    this.innerSplitId = undefined;
    this.kindPaneVBoxId = undefined;
    this.kindTabBarId = undefined;
    this.userKindListId = undefined;
    this.systemKindListId = undefined;
    this.sharedKindListId = undefined;
    this.instancePaneVBoxId = undefined;
    this.instanceListId = undefined;
    this.detailPaneId = undefined;
    this.detailWidgetIds = [];
    this.detailButtonIds.clear();
    this.userKindEntries = [];
    this.systemKindEntries = [];
    this.sharedKindEntries = [];
    this.instanceEntries = [];
  }

  private groupByKind(): { user: Map<string, ObjectRegistration[]>; system: Map<string, ObjectRegistration[]> } {
    const user = new Map<string, ObjectRegistration[]>();
    const system = new Map<string, ObjectRegistration[]>();
    for (const obj of this.cachedObjects) {
      const isSystem = this.isSystemEntry(obj);
      // Peer-owned USER abjects are the Shared tab's business, not these two.
      // Peer-owned SYSTEM abjects are a different case: the Shared tab now turns
      // them away, so if this tab dropped them too they would vanish from the
      // window entirely — a peer's Registry among them. They stay here.
      if (!isSystem && !this.isLocalEntry(obj)) continue;
      const name = obj.manifest.name;
      const target = isSystem ? system : user;
      const group = target.get(name);
      if (group) {
        group.push(obj);
      } else {
        target.set(name, [obj]);
      }
    }
    return { user, system };
  }

  /**
   * Collective abjects of a shared workspace: entries synced in from other
   * peers (they carry `ownerPeerId`) plus the local user's own abjects exposed
   * into this workspace. This view deliberately INCLUDES `ownerPeerId` entries,
   * unlike the taskbar's launch-button provenance filter which suppresses them —
   * the Shared tab is where peer abjects are meant to be visible.
   */
  private groupBySharedKind(): Map<string, ObjectRegistration[]> {
    const shared = new Map<string, ObjectRegistration[]>();
    for (const obj of this.cachedObjects) {
      if (!this.isSharedEntry(obj)) continue;
      const name = obj.manifest.name;
      const group = shared.get(name);
      if (group) {
        group.push(obj);
      } else {
        shared.set(name, [obj]);
      }
    }
    return shared;
  }

  /**
   * System and infrastructure abjects — the desktop shell, the browsers, the
   * per-peer singletons. Read from the same host-local set the outbound catalog
   * uses, so what this window calls shared and what actually leaves this peer
   * cannot drift apart.
   */
  private isSystemEntry(obj: ObjectRegistration): boolean {
    return (obj.manifest.tags ?? []).includes('system')
      || isHostLocalObject(obj.manifest.name);
  }

  /**
   * A remote peer's entry, or a local abject exposed into this workspace —
   * never a system or infrastructure one.
   *
   * A shared workspace exposes every non-system abject automatically, which
   * makes `exposedObjectIds` hold the whole workspace: without this gate the
   * host's own Taskbar, Settings, Storage and ScrumMaster would all show up
   * under "Shared by Me". They belong on the System tab, which keeps peer-owned
   * system entries so nothing is hidden by being excluded here.
   */
  private isSharedEntry(obj: ObjectRegistration): boolean {
    if (this.isSystemEntry(obj)) return false;
    return obj.ownerPeerId !== undefined || this.exposedObjectIds.has(obj.id);
  }
  /**
   * Peer-owned pooled entry (Shared tab): read-only for Edit/Delete, forkable
   * for scriptable kinds. Unlike isSharedEntry, a locally-owned-but-exposed
   * object is NOT remote — its owner keeps full Edit/Clone/Delete.
   */
  private isRemoteEntry(obj: ObjectRegistration): boolean {
    return obj.ownerPeerId !== undefined;
  }

  /**
   * Provenance gate for the User/System tabs. Those tabs read the active
   * workspace's registry, whose list merges in pooled entries from other peers
   * (they carry `ownerPeerId`). Peer abjects belong in the Shared tab and only
   * there — the same suppression the taskbar applies to its launch buttons.
   * Remote-browse mode is the deliberate exception: there the peer's objects
   * ARE the subject of the window, so the filter stands down.
   */
  private isLocalEntry(obj: ObjectRegistration): boolean {
    if (this.remoteRegistryId) return true;
    return obj.ownerPeerId === undefined;
  }

  /** Owner column for a Shared row: peer name, short peer id, or the local user. */
  private ownerLabel(obj: ObjectRegistration): string {
    if (!obj.ownerPeerId) {
      return this.localOwnerName ? `${this.localOwnerName} (you)` : 'You';
    }
    return this.sharedOwnerNames.get(obj.ownerPeerId)
      ?? `${obj.ownerPeerId.slice(0, 8)}...`;
  }

  /**
   * Decide whether the active workspace gets a Shared tab, and cache what that
   * tab needs to label its rows. Two shapes count as shared:
   *   (a) hosted — the workspace is shared out (non-local accessMode, or it
   *       carries exposed objects / a whitelist);
   *   (b) joined — a mirror of another peer's workspace. Joined records keep
   *       accessMode 'local' on purpose, so they are detected through the
   *       `joined` / `ownerPeerId` metadata that getActiveWorkspace surfaces
   *       (listWorkspacesDetailed does not carry it).
   */
  private async refreshSharedContext(): Promise<void> {
    type ActiveWorkspaceInfo = {
      id: string; name: string; registryId?: AbjectId;
      joined?: boolean; ownerPeerId?: string;
    };
    type DetailedWorkspaceInfo = {
      workspaceId: string; accessMode: string; whitelist: string[]; exposedObjectIds: AbjectId[];
      registryId?: AbjectId;
    };

    this.isSharedWorkspace = false;
    this.workspaceRegistryId = undefined;
    this.exposedObjectIds = new Set<AbjectId>();
    this.sharedOwnerNames.clear();
    this.localOwnerName = undefined;

    // Remote browsing already shows a peer's own registry wholesale.
    const wmId = this.workspaceManagerId;
    if (this.isRemote || !wmId) return;

    let active: ActiveWorkspaceInfo | null = null;
    try {
      active = await this.request<ActiveWorkspaceInfo | null>(
        request(this.id, wmId, 'getActiveWorkspace', {})
      );
    } catch {
      // WorkspaceManager unreachable — fall back to no Shared tab
    }
    if (!active) return;
    const activeWs = active;

    // WorkspaceRegistry.list merges local + pooled peer entries + the global
    // fallback catalog, so this is a superset of the global Registry's list and
    // the only source where a remote object's `ownerPeerId` survives.
    this.workspaceRegistryId = activeWs.registryId;

    const joined = activeWs.joined === true || activeWs.ownerPeerId !== undefined;

    let hosted = false;
    try {
      const detailed = await this.request<DetailedWorkspaceInfo[]>(
        request(this.id, wmId, 'listWorkspacesDetailed', {})
      );
      const ws = detailed.find(w => w.workspaceId === activeWs.id);
      if (ws) {
        this.exposedObjectIds = new Set<AbjectId>(ws.exposedObjectIds ?? []);
        // effectiveExposedIds always seeds the workspace registry itself, so
        // the registry entry alone does not mean the user exposed anything.
        const curatedExposure = (ws.exposedObjectIds ?? []).some(id => id !== ws.registryId);
        hosted = ws.accessMode !== 'local'
          || curatedExposure
          || (ws.whitelist?.length ?? 0) > 0;
      }
    } catch {
      // Detail lookup failed — the joined check still stands
    }

    this.isSharedWorkspace = joined || hosted;
    if (this.isSharedWorkspace) {
      await this.loadOwnerNames(activeWs.id, activeWs.ownerPeerId);
    }
  }

  /** Cache peerId → display name for the Shared tab's owner column. */
  private async loadOwnerNames(workspaceId: string, ownerPeerId?: string): Promise<void> {
    try {
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        const me = await this.request<{ peerId: string; name?: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.localOwnerName = me?.name;
      }
    } catch { /* identity unavailable */ }

    const shareRegistryId = await this.discoverDep('WorkspaceShareRegistry');
    if (!shareRegistryId) return;

    try {
      const members = await this.request<Array<{ peerId: string; peerName?: string }>>(
        request(this.id, shareRegistryId, 'getActiveMembers', { workspaceId })
      );
      for (const m of members ?? []) {
        if (m.peerName) this.sharedOwnerNames.set(m.peerId, m.peerName);
      }
    } catch { /* no members recorded yet */ }

    // A joined mirror learns its host's name from the discovery cache.
    try {
      const discovered = await this.request<Array<{ ownerPeerId: string; ownerName?: string }>>(
        request(this.id, shareRegistryId, 'getDiscoveredWorkspaces', {})
      );
      for (const d of discovered ?? []) {
        if (d.ownerName && !this.sharedOwnerNames.has(d.ownerPeerId)) {
          this.sharedOwnerNames.set(d.ownerPeerId, d.ownerName);
        }
      }
    } catch { /* discovery cache unavailable */ }

    if (ownerPeerId && !this.sharedOwnerNames.has(ownerPeerId)) {
      this.sharedOwnerNames.set(ownerPeerId, `${ownerPeerId.slice(0, 8)}...`);
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('getState', async () => {
      return { visible: !!this.windowId };
    });

    this.on('browseRemote', async (msg: AbjectMessage) => {
      const { registryId, label } = msg.payload as {
        registryId: AbjectId;
        peerId: string;
        label: string;
      };
      this.isRemote = true;
      this.remoteLabel = label;
      this.remoteRegistryId = registryId;

      try {
        await this.request(request(this.id, registryId, 'subscribe', {}));
      } catch { /* remote registry may not support subscribe */ }

      await this.show();
      return true;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });

    // Backdrop click dismisses the workspace picker
    this.on('input', async (msg: AbjectMessage) => {
      const input = msg.payload as { type?: string };
      if (input.type === 'mousedown' && this.pickerResolve) {
        this.pickerResolve(null);
      }
    });

    this.on('objectRegistered', async () => {
      this.cachedObjects = await this.registryList();
      if (this.windowId) {
        await this.rebuildKindList();
        if (this.selectedKindName) {
          await this.rebuildInstanceList();
        }
      }
    });

    this.on('objectUnregistered', async () => {
      this.cachedObjects = await this.registryList();
      if (this.windowId) {
        await this.rebuildKindList();
        if (this.selectedKindName) {
          await this.rebuildInstanceList();
        }
      }
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    this.selectedKindName = undefined;
    this.selectedKindTab = 0;
    this.selectedInstanceIndex = -1;
    await this.refreshSharedContext();
    this.cachedObjects = await this.registryList();
    await this.buildUI();
    this.changed('visibility', true);
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
    this.selectedKindName = undefined;
    this.selectedKindTab = 0;
    this.selectedInstanceIndex = -1;
    this.clearWidgetTracking();
    this.changed('visibility', false);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // UI Construction
  // ═══════════════════════════════════════════════════════════════════

  private async buildUI(): Promise<void> {
    const wm = async (method: string, params: Record<string, unknown>) =>
      this.request<AbjectId>(request(this.id, this.widgetManagerId!, method, params));

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    const title = this.isRemote
      ? this.remoteLabel ?? 'Remote Explorer'
      : 'Workspace Abject Explorer';

    this.windowId = await wm('createWindowAbject', {
      title,
      rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
      zIndex: 200,
      resizable: true,
    });

    // Root VBox
    this.rootLayoutId = await wm('createVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 4, bottom: 4, left: 4 },
      spacing: 4,
    });

    // ── Three-pane area using nested split panes ──
    // outerSplit: left=kindPane, right=innerSplit
    // innerSplit: left=instanceList, right=detailPane
    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const windowId = this.windowId;

    const { widgetIds: splitIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // [0] Outer split pane
          { type: 'splitPane', windowId, orientation: 'horizontal',
            dividerPosition: 0.25, minSize: 150 },
          // [1] Inner split pane (instance | detail)
          { type: 'splitPane', windowId, orientation: 'horizontal',
            dividerPosition: 0.42, minSize: 150 },
        ],
      })
    );
    this.outerSplitId = splitIds[0];
    this.innerSplitId = splitIds[1];
    await this.addToLayout(this.rootLayoutId, this.outerSplitId, { vertical: 'expanding', horizontal: 'expanding' });

    // ── Pane 1: Kind lists (user + system) in a detached VBox ──
    this.kindPaneVBoxId = await wm('createDetachedVBox', {
      windowId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 2,
    });

    // ── Batch create all non-layout widgets ──
    // The Shared tab exists only for shared/joined workspaces, so its list is
    // appended last — the earlier indices stay stable either way.
    const kindTabs = this.isSharedWorkspace ? ['User', 'System', 'Shared'] : ['User', 'System'];
    if (this.activeKindTab >= kindTabs.length) this.activeKindTab = 0;

    const kindSpecs: Array<Record<string, unknown>> = [
      // [0] Kind tab bar (User / System [/ Shared])
      { type: 'tabBar', windowId, rect: r0,
        tabs: kindTabs, selectedIndex: this.activeKindTab, closable: false },
      // [1] User kind list (searchable)
      { type: 'list', windowId, rect: r0, items: [], searchable: true },
      // [2] System kind list (searchable)
      { type: 'list', windowId, rect: r0, items: [], searchable: true },
      // [3] Instance list
      { type: 'list', windowId, rect: r0, items: [] },
    ];
    // [4] Shared kind list (searchable) — shared/joined workspaces only
    if (this.isSharedWorkspace) {
      kindSpecs.push({ type: 'list', windowId, rect: r0, items: [], searchable: true });
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: kindSpecs })
    );

    const [kindTabBar, userKindList, systemKindList, instanceList, sharedKindList] = widgetIds;
    this.kindTabBarId = kindTabBar;
    this.userKindListId = userKindList;
    this.systemKindListId = systemKindList;
    this.instanceListId = instanceList;
    this.sharedKindListId = sharedKindList;

    // ── Batch add kind-pane widgets to their layout ──
    const kindPaneChildren: Array<Record<string, unknown>> = [
      { widgetId: this.kindTabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 32 } },
      { widgetId: this.userKindListId, sizePolicy: { vertical: 'expanding' } },
      { widgetId: this.systemKindListId, sizePolicy: { vertical: 'expanding' } },
    ];
    if (this.sharedKindListId) {
      kindPaneChildren.push({ widgetId: this.sharedKindListId, sizePolicy: { vertical: 'expanding' } });
    }
    await this.request(request(this.id, this.kindPaneVBoxId, 'addLayoutChildren', {
      children: kindPaneChildren,
    }));

    // ── Pane 3: Detail (detached scrollable VBox) ──
    this.detailPaneId = await wm('createDetachedScrollableVBox', {
      windowId,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 4,
    });

    // Wire split pane children
    await this.request(request(this.id, this.innerSplitId, 'setLeftChild', { widgetId: this.instanceListId }));
    await this.request(request(this.id, this.innerSplitId, 'setRightChild', { widgetId: this.detailPaneId }));
    await this.request(request(this.id, this.outerSplitId, 'setLeftChild', { widgetId: this.kindPaneVBoxId }));
    await this.request(request(this.id, this.outerSplitId, 'setRightChild', { widgetId: this.innerSplitId }));

    // Fire-and-forget addDep for interactive widgets
    this.send(request(this.id, this.kindTabBarId, 'addDependent', {}));
    this.send(request(this.id, this.userKindListId, 'addDependent', {}));
    this.send(request(this.id, this.systemKindListId, 'addDependent', {}));
    if (this.sharedKindListId) {
      this.send(request(this.id, this.sharedKindListId, 'addDependent', {}));
    }
    this.send(request(this.id, this.instanceListId, 'addDependent', {}));

    // Show only the active tab's list
    await this.switchKindTabVisibility();

    // Populate kind list
    await this.rebuildKindList();

    // Show placeholder in detail pane
    await this.rebuildDetailPane();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Kind List (Pane 1)
  // ═══════════════════════════════════════════════════════════════════

  private async rebuildKindList(): Promise<void> {
    if (!this.userKindListId || !this.systemKindListId) return;

    const { user, system } = this.groupByKind();

    this.userKindEntries = Array.from(user.keys()).sort();
    const userItems = this.userKindEntries.map(name => ({
      label: name, value: name, secondary: `(${user.get(name)!.length})`,
    }));
    let userSelected = -1;
    if (this.selectedKindName && this.selectedKindTab === 0) {
      userSelected = this.userKindEntries.indexOf(this.selectedKindName);
    }
    await this.request(request(this.id, this.userKindListId, 'update', {
      items: userItems, selectedIndex: userSelected,
    }));

    this.systemKindEntries = Array.from(system.keys()).sort();
    const sysItems = this.systemKindEntries.map(name => ({
      label: name, value: name, secondary: `(${system.get(name)!.length})`,
    }));
    let sysSelected = -1;
    if (this.selectedKindName && this.selectedKindTab === 1) {
      sysSelected = this.systemKindEntries.indexOf(this.selectedKindName);
    }
    await this.request(request(this.id, this.systemKindListId, 'update', {
      items: sysItems, selectedIndex: sysSelected,
    }));

    if (!this.sharedKindListId) return;

    const shared = this.groupBySharedKind();
    this.sharedKindEntries = Array.from(shared.keys()).sort();
    const sharedItems = this.sharedKindEntries.map(name => ({
      label: name, value: name, secondary: `(${shared.get(name)!.length})`,
    }));
    let sharedSelected = -1;
    if (this.selectedKindName && this.selectedKindTab === 2) {
      sharedSelected = this.sharedKindEntries.indexOf(this.selectedKindName);
    }
    await this.request(request(this.id, this.sharedKindListId, 'update', {
      items: sharedItems, selectedIndex: sharedSelected,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Instance List (Pane 2)
  // ═══════════════════════════════════════════════════════════════════

  private async rebuildInstanceList(): Promise<void> {
    if (!this.instanceListId) return;

    if (!this.selectedKindName) {
      this.instanceEntries = [];
      this.selectedInstanceIndex = -1;
      await this.request(request(this.id, this.instanceListId, 'update', {
        items: [],
        selectedIndex: -1,
      }));
      await this.rebuildDetailPane();
      return;
    }

    this.instanceEntries = this.cachedObjects.filter(o => {
      if (o.manifest.name !== this.selectedKindName) return false;
      // The Shared tab draws from the workspace's collective entries (local
      // exposed + remote peers), not from the user/system tag split.
      if (this.selectedKindTab === 2) return this.isSharedEntry(o);
      if (!this.isLocalEntry(o)) return false;
      const tags = o.manifest.tags ?? [];
      const isSys = tags.includes('system');
      return isSys === this.selectedKindIsSystem;
    });
    // Auto-select if there's exactly one instance
    this.selectedInstanceIndex = this.instanceEntries.length === 1 ? 0 : -1;

    const items = this.instanceEntries.map(inst => {
      const shortId = inst.id.slice(0, 8);
      return {
        label: `${inst.manifest.name}`,
        value: inst.id,
        secondary: this.selectedKindTab === 2
          ? `${this.ownerLabel(inst)} · [${shortId}...]`
          : `[${shortId}...]`,
      };
    });

    await this.request(request(this.id, this.instanceListId, 'update', {
      items,
      selectedIndex: this.selectedInstanceIndex,
    }));
    await this.rebuildDetailPane();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Detail Pane (Pane 3)
  // ═══════════════════════════════════════════════════════════════════

  private async rebuildDetailPane(): Promise<void> {
    if (!this.detailPaneId || !this.windowId) return;

    // Fire-and-forget destroy old detail widgets
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
    if (this.selectedInstanceIndex < 0 || this.selectedInstanceIndex >= this.instanceEntries.length) {
      const { widgetIds: [placeholderId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId, rect: r0,
              text: 'Select an instance to view details.',
              style: { color: this.theme.sectionLabel, fontSize: 12 } },
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

    const inst = this.instanceEntries[this.selectedInstanceIndex];
    const manifest = inst.manifest;
    const hasSource = (inst as unknown as { source?: string }).source !== undefined;

    // Build label specs (non-button detail widgets)
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
      text: manifest.name,
      style: { color: this.theme.textHeading, fontSize: 13, fontWeight: 'bold' } });

    // Owner (Shared tab only)
    if (this.selectedKindTab === 2) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Owner: ${this.ownerLabel(inst)}`,
        style: { color: this.theme.sectionLabel, fontSize: 11 } });
    }

    // Description
    if (manifest.description) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: manifest.description,
        style: { color: this.theme.textDescription, fontSize: 11, wordWrap: true, selectable: true } });
    }

    // Version
    if (manifest.version) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Version: ${manifest.version}`,
        style: { color: this.theme.textMeta, fontSize: 11, wordWrap: true, selectable: true } });
    }

    // Tags
    const tags = manifest.tags ?? [];
    if (tags.length > 0) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Tags: ${tags.join(', ')}`,
        style: { color: this.theme.textMeta, fontSize: 11, wordWrap: true, selectable: true } });
    }

    // Methods
    const iface = manifest.interface;
    if (iface && 'methods' in iface && Array.isArray(iface.methods) && iface.methods.length > 0) {
      const methodNames = iface.methods.map((m: { name: string }) => `${m.name}()`).join(', ');
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Methods: ${methodNames}`,
        style: { color: this.theme.textMeta, fontSize: 11, wordWrap: true, selectable: true } });
    }

    // Actions separator
    specs.push({ type: 'label', windowId, rect: r0,
      text: '─── Actions',
      style: { color: this.theme.sectionLabel, fontSize: 11, fontWeight: 'bold' } });

    // Browse button (always)
    specs.push({ type: 'button', windowId, rect: r0,
      text: 'Browse', style: { fontSize: 12 }, action: 'browse' });

    // Peer-owned entries (Shared tab) are read-only: Edit Source and Delete are
    // suppressed — never a permission error on click — while scriptable entries
    // can still be forked into a local editable copy via WorkspaceRegistry.
    const remoteEntry = this.isRemoteEntry(inst);
    const isForkable = tags.includes('scriptable') || hasSource;

    if (this.isRemote) {
      if (hasSource) {
        specs.push({ type: 'button', windowId, rect: r0,
          text: 'Clone to Local', style: { fontSize: 12 }, action: 'cloneToLocal' });
      }
    } else if (remoteEntry) {
      specs.push({ type: 'label', windowId, rect: r0,
        text: `Shared from ${this.ownerLabel(inst)} — read-only. Clone to edit your own copy.`,
        style: { color: this.theme.sectionLabel, fontSize: 11, wordWrap: true } });
      if (isForkable) {
        specs.push({ type: 'button', windowId, rect: r0,
          text: 'Clone to Local',
          style: { fontSize: 12, tooltip: 'Fork a local editable copy into your workspace' },
          action: 'cloneShared' });
      }
    } else {
      if (hasSource) {
        const editorId = await this.findAbjectEditor();
        if (editorId) {
          specs.push({ type: 'button', windowId, rect: r0,
            text: 'Edit Source', style: { fontSize: 12 }, action: 'editSource' });
          specs.push({ type: 'button', windowId, rect: r0,
            text: 'History', style: { fontSize: 12 }, action: 'history' });
        }
      }
      // Clone/Delete are owner actions: not for system objects, and not for the
      // Shared tab where an entry may belong to another peer.
      if (this.selectedKindTab === 0) {
        specs.push({ type: 'button', windowId, rect: r0,
          text: 'Clone to...', style: { fontSize: 12 }, action: 'cloneTo' });
        specs.push({ type: 'button', windowId, rect: r0,
          text: 'Delete',
          style: { fontSize: 12, background: this.theme.destructiveText, color: '#ffffff', borderColor: this.theme.destructiveText },
          action: 'delete' });
      }
    }

    // Strip out local `action` field before sending to create
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
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 120, height: 28 },
        });
      } else {
        // Determine height based on label role
        let height = 16;
        if (spec.text === manifest.name) height = 20;
        else if (manifest.description && spec.text === manifest.description) height = 18;
        else if (spec.text === '─── Actions') height = 20;

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
  // Event Handling
  // ═══════════════════════════════════════════════════════════════════

  private async switchKindTabVisibility(): Promise<void> {
    if (this.userKindListId) {
      try {
        await this.request(request(this.id, this.userKindListId, 'update', {
          style: { visible: this.activeKindTab === 0 },
        }));
      } catch { /* widget gone */ }
    }
    if (this.systemKindListId) {
      try {
        await this.request(request(this.id, this.systemKindListId, 'update', {
          style: { visible: this.activeKindTab === 1 },
        }));
      } catch { /* widget gone */ }
    }
    if (this.sharedKindListId) {
      try {
        await this.request(request(this.id, this.sharedKindListId, 'update', {
          style: { visible: this.activeKindTab === 2 },
        }));
      } catch { /* widget gone */ }
    }
  }

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Kind tab bar change
    if (fromId === this.kindTabBarId && aspect === 'change') {
      this.activeKindTab = value as number;
      await this.switchKindTabVisibility();
      return;
    }

    // User kind list selection
    if (fromId === this.userKindListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      this.selectedKindName = sel.value;
      this.selectedKindTab = 0;
      await this.request(request(this.id, this.systemKindListId!, 'update', { selectedIndex: -1 }));
      if (this.sharedKindListId) {
        await this.request(request(this.id, this.sharedKindListId, 'update', { selectedIndex: -1 }));
      }
      await this.rebuildInstanceList();
      return;
    }

    // System kind list selection
    if (fromId === this.systemKindListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      this.selectedKindName = sel.value;
      this.selectedKindTab = 1;
      await this.request(request(this.id, this.userKindListId!, 'update', { selectedIndex: -1 }));
      if (this.sharedKindListId) {
        await this.request(request(this.id, this.sharedKindListId, 'update', { selectedIndex: -1 }));
      }
      await this.rebuildInstanceList();
      return;
    }

    // Shared kind list selection (shared/joined workspaces only)
    if (this.sharedKindListId && fromId === this.sharedKindListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      this.selectedKindName = sel.value;
      this.selectedKindTab = 2;
      await this.request(request(this.id, this.userKindListId!, 'update', { selectedIndex: -1 }));
      await this.request(request(this.id, this.systemKindListId!, 'update', { selectedIndex: -1 }));
      await this.rebuildInstanceList();
      return;
    }

    // Instance list selection
    if (fromId === this.instanceListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      const idx = this.instanceEntries.findIndex(e => e.id === sel.value);
      this.selectedInstanceIndex = idx;
      await this.rebuildDetailPane();
      return;
    }

    // Workspace picker events
    if (this.pickerResolve) {
      if (fromId === this.pickerCloneBtnId && aspect === 'click') {
        this.pickerResolve(this.pickerSelectedIndex);
        return;
      }
      if (fromId === this.pickerCancelBtnId && aspect === 'click') {
        this.pickerResolve(null);
        return;
      }
      if (fromId === this.pickerDialogId && aspect === 'windowCloseRequested') {
        this.pickerResolve(null);
        return;
      }
      if (fromId === this.pickerSelectId && aspect === 'change') {
        this.pickerSelectedIndex = parseInt(value as string, 10);
        return;
      }
    }

    // Detail pane button clicks
    const action = this.detailButtonIds.get(fromId);
    if (action && aspect === 'click') {
      if (action === 'browse') {
        await this.browseSelectedKind();
      } else if (action === 'delete') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          const target = this.instanceEntries[this.selectedInstanceIndex];
          if (this.isRemoteEntry(target)) {
            await this.notify('Shared object is read-only — clone it to get your own copy', 'warning');
          } else {
            await this.deleteObject(target.id);
          }
        }
      } else if (action === 'editSource') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          const target = this.instanceEntries[this.selectedInstanceIndex];
          if (this.isRemoteEntry(target)) {
            await this.notify('Shared object is read-only — clone it to edit your own copy', 'warning');
          } else {
            await this.editSource(target.id);
          }
        }
      } else if (action === 'history') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          const target = this.instanceEntries[this.selectedInstanceIndex];
          if (this.isRemoteEntry(target)) {
            await this.notify('Shared object is read-only — clone it to view your own copy', 'warning');
          } else {
            await this.showHistory(target.id);
          }
        }
      } else if (action === 'cloneTo') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          await this.cloneToWorkspace(this.instanceEntries[this.selectedInstanceIndex]);
        }
      } else if (action === 'cloneToLocal') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          await this.cloneToLocal(this.instanceEntries[this.selectedInstanceIndex]);
        }
      } else if (action === 'cloneShared') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          await this.cloneSharedToLocal(this.instanceEntries[this.selectedInstanceIndex]);
        }
      }
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Browse / Clone / Delete / Clone to Local
  // ═══════════════════════════════════════════════════════════════════

  private async browseSelectedKind(): Promise<void> {
    if (!this.selectedKindName) return;

    try {
      const objectBrowserId = await this.discoverDep('ObjectBrowser');
      if (!objectBrowserId) return;

      await this.request(
        request(this.id, objectBrowserId, 'browseKind', { name: this.selectedKindName })
      );
    } catch (err) {
      log.warn('Browse error:', err);
    }
  }

  private async deleteObject(objectId: AbjectId): Promise<void> {
    if (!this.factoryId) return;

    let ok = true;
    try {
      await this.request(request(this.id, this.factoryId,
        'kill', { objectId }));
    } catch {
      ok = false; /* object may already be gone */
    }
    await this.notify(ok ? 'Object deleted' : 'Delete failed', ok ? 'success' : 'error');

    this.cachedObjects = await this.registryList();

    if (this.selectedKindName) {
      // Mirrors rebuildInstanceList's predicate so "is this kind now empty?"
      // agrees with what the instance pane will actually render.
      const remaining = this.cachedObjects.filter(o => {
        if (o.manifest.name !== this.selectedKindName) return false;
        if (this.selectedKindTab === 2) return this.isSharedEntry(o);
        if (!this.isLocalEntry(o)) return false;
        const tags = o.manifest.tags ?? [];
        return tags.includes('system') === this.selectedKindIsSystem;
      });
      if (remaining.length === 0) {
        this.selectedKindName = undefined;
        this.selectedInstanceIndex = -1;
      }
    }

    await this.rebuildKindList();
    await this.rebuildInstanceList();
  }

  /** Find the AbjectEditor in this workspace's own registry (not the browsed workspace). */
  private async findAbjectEditor(): Promise<AbjectId | undefined> {
    const regId = this.registryId;
    if (!regId) return undefined;
    try {
      const regs = await this.request<ObjectRegistration[]>(
        request(this.id, regId, 'list', {})
      );
      const editor = regs.find(r => r.manifest.name === 'AbjectEditor');
      return editor?.id as AbjectId | undefined;
    } catch {
      return undefined;
    }
  }

  /** Open the AbjectEditor for a given object. */
  private async editSource(objectId: AbjectId): Promise<void> {
    const editorId = await this.findAbjectEditor();
    if (!editorId) return;
    try {
      await this.request(request(this.id, editorId, 'show', { objectId }));
    } catch { /* editor may not be available */ }
  }

  /** Open the editor straight into version history (view + restore prior sources). */
  private async showHistory(objectId: AbjectId): Promise<void> {
    const editorId = await this.findAbjectEditor();
    if (!editorId) return;
    try {
      await this.request(request(this.id, editorId, 'show', { objectId, showHistory: true }));
    } catch { /* editor may not be available */ }
  }

  /** Clone a remote object's source into the active local workspace. */
  private async cloneToLocal(obj: ObjectRegistration): Promise<void> {
    const source = (obj as unknown as { source?: string }).source;
    if (!source) return;

    const cloneData = cloneSourceData(obj);

    if (!this.factoryId) {
      this.factoryId = await this.discoverDep('Factory') ?? undefined;
    }
    if (!this.factoryId) return;

    // Find the active workspace's registry to clone into
    const targetRegistryId = await this.findLocalTargetRegistry();
    if (!targetRegistryId) {
      log.warn('No local workspace found for clone');
      return;
    }

    try {
      const spawnPayload: Record<string, unknown> = {
        manifest: obj.manifest,
        source,
        registryHint: targetRegistryId,
      };
      if (cloneData !== undefined) spawnPayload.data = cloneData;

      const result = await this.request<SpawnResult>(request(this.id, this.factoryId,
        'spawn', spawnPayload));

      // Persist to AbjectStore so it survives restart
      const abjectStoreId = await this.findAbjectStore(targetRegistryId);
      if (abjectStoreId) {
        try {
          const savePayload: Record<string, unknown> = {
            objectId: result.objectId,
            manifest: obj.manifest,
            source,
            owner: this.id,
          };
          if (cloneData !== undefined) savePayload.data = cloneData;
          await this.request(request(this.id, abjectStoreId, 'save', savePayload));
        } catch { /* best-effort persist */ }
      }

      log.info('Cloned to local workspace');
    } catch (err) {
      log.warn('Clone to local error:', err);
    }
  }

  /**
   * Fork a peer-owned shared entry into a local copy via WorkspaceRegistry
   * forkRemote (server-side snapshot + Factory spawn into our workspace).
   * Remote pooled entries may carry no `source` in the list, so the local
   * cloneToLocal path cannot serve them — forkRemote resolves and snapshots
   * the original itself. Closing/keeping the explorer window never touches
   * the remote object; only the new local fork is owned here.
   */
  private async cloneSharedToLocal(obj: ObjectRegistration): Promise<void> {
    const registryId = this.workspaceRegistryId ?? this.registryId;
    if (!registryId) {
      await this.notify('No local workspace registry — cannot clone', 'error');
      return;
    }
    try {
      const fork = await this.request<{ ok: boolean; objectId?: AbjectId; reason?: string }>(
        request(this.id, registryId, 'forkRemote', { objectId: obj.id }));
      if (fork?.ok) {
        await this.notify('Cloned to your workspace', 'success');
        log.info('Cloned shared object to local workspace');        return;
      }
      await this.notify(`Clone failed: ${fork?.reason ?? 'not forkable'}`, 'error');
    } catch (err) {
      log.warn('Clone shared error:', err);
      await this.notify('Clone failed', 'error');
    }
  }

  /** Find the active workspace's registry ID, or first local workspace registry. */
  private async findLocalTargetRegistry(): Promise<AbjectId | undefined> {
    // Try active workspace
    if (this.workspaceManagerId) {
      try {
        const active = await this.request<{ id: string; registryId: AbjectId }>(
          request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
        );
        if (active.registryId) return active.registryId;
      } catch { /* fall through */ }
    }

    // Fallback: use the local registry we already know about
    return this.registryId;
  }

  /** Clone an object into a different workspace, chosen via a picker dialog. */
  private async cloneToWorkspace(obj: ObjectRegistration): Promise<void> {
    if (!this.workspaceManagerId || !this.factoryId) return;

    const source = (obj as unknown as { source?: string }).source;
    if (!source) return;

    const cloneData = cloneSourceData(obj);

    // Get all workspaces with registryIds
    const allWorkspaces = await this.request<Array<{
      workspaceId: string; name: string; registryId: AbjectId;
    }>>(request(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {}));

    if (allWorkspaces.length === 0) return;

    // Show workspace picker with all workspaces
    const selectedIdx = await this.showWorkspacePicker(
      allWorkspaces.map(ws => ws.name)
    );
    if (selectedIdx === null) return; // cancelled
    const targetRegistryId = allWorkspaces[selectedIdx].registryId;

    try {
      const spawnPayload: Record<string, unknown> = {
        manifest: obj.manifest,
        source,
        registryHint: targetRegistryId,
      };
      if (cloneData !== undefined) spawnPayload.data = cloneData;

      const result = await this.request<SpawnResult>(request(this.id, this.factoryId,
        'spawn', spawnPayload));

      // Persist to AbjectStore so it survives restart
      const abjectStoreId = await this.findAbjectStore(targetRegistryId);
      if (abjectStoreId) {
        try {
          const savePayload: Record<string, unknown> = {
            objectId: result.objectId,
            manifest: obj.manifest,
            source,
            owner: this.id,
          };
          if (cloneData !== undefined) savePayload.data = cloneData;
          await this.request(request(this.id, abjectStoreId, 'save', savePayload));
        } catch { /* best-effort persist */ }
      }

      log.info('Cloned to workspace');
    } catch (err) {
      log.warn('Clone to workspace error:', err);
    }
  }

  /**
   * Show a modal workspace picker dialog. Returns the selected index or null if cancelled.
   */
  private async showWorkspacePicker(workspaceNames: string[]): Promise<number | null> {
    const wmId = this.widgetManagerId!;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, wmId, 'getDisplayInfo', {})
    );

    // Backdrop
    this.pickerBackdropId = await this.request<AbjectId>(
      request(this.id, wmId, 'createWindowAbject', {
        title: '',
        rect: { x: 0, y: 0, width: displayInfo.width, height: displayInfo.height },
        chromeless: true,
        transparent: true,
        zIndex: 5000,
      })
    );

    const canvasId = await this.request<AbjectId>(
      request(this.id, wmId, 'createCanvas', {
        windowId: this.pickerBackdropId,
        inputTargetId: this.id,
      })
    );
    await this.request(request(this.id, canvasId, 'draw', {
      commands: [
        { type: 'rect', surfaceId: 'c', params: { x: 0, y: 0, width: displayInfo.width, height: displayInfo.height, fill: 'rgba(0,0,0,0.5)' } },
      ],
    }));

    // Dialog window
    const dialogW = 360;
    const dialogH = 200;
    const dialogX = Math.max(0, Math.floor((displayInfo.width - dialogW) / 2));
    const dialogY = Math.max(0, Math.floor((displayInfo.height - dialogH) / 2));

    this.pickerDialogId = await this.request<AbjectId>(
      request(this.id, wmId, 'createWindowAbject', {
        title: 'Clone to Workspace',
        rect: { x: dialogX, y: dialogY, width: dialogW, height: dialogH },
        zIndex: 5001,
      })
    );

    const rootLayout = await this.request<AbjectId>(
      request(this.id, wmId, 'createVBox', {
        windowId: this.pickerDialogId,
        margins: { top: 16, right: 20, bottom: 16, left: 20 },
        spacing: 12,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const options = workspaceNames.map((name, i) => ({ label: name, value: String(i) }));

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wmId, 'create', {
        specs: [
          { type: 'label', windowId: this.pickerDialogId, rect: r0,
            text: 'Select target workspace:',
            style: { color: this.theme.textPrimary, fontSize: 12 } },
          { type: 'select', windowId: this.pickerDialogId, rect: r0,
            options, selectedIndex: 0 },
          { type: 'button', windowId: this.pickerDialogId, rect: r0,
            text: 'Cancel' },
          { type: 'button', windowId: this.pickerDialogId, rect: r0,
            text: 'Clone', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        ],
      })
    );

    const [labelId, selectId, cancelBtnId, cloneBtnId] = widgetIds;
    this.pickerSelectId = selectId;
    this.pickerCancelBtnId = cancelBtnId;
    this.pickerCloneBtnId = cloneBtnId;

    // Subscribe to interactive widgets
    this.send(request(this.id, selectId, 'addDependent', {}));
    await this.request(request(this.id, cancelBtnId, 'addDependent', {}));
    await this.request(request(this.id, cloneBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.pickerDialogId, 'addDependent', {}));

    // Layout: label, select, spacer, button row
    await this.request(request(this.id, rootLayout, 'addLayoutChildren', {
      children: [
        { widgetId: labelId, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 20 } },
        { widgetId: selectId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 32 } },
      ],
    }));

    await this.request(request(this.id, rootLayout, 'addLayoutSpacer', {}));

    const buttonRow = await this.request<AbjectId>(
      request(this.id, wmId, 'createNestedHBox', {
        parentLayoutId: rootLayout,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, rootLayout, 'addLayoutChild', {
      widgetId: buttonRow,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, buttonRow, 'addLayoutSpacer', {}));
    await this.request(request(this.id, buttonRow, 'addLayoutChildren', {
      children: [
        { widgetId: cancelBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: 36 } },
        { widgetId: cloneBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: 36 } },
      ],
    }));

    // Wait for user response
    const selectedIndex = await new Promise<number | null>((resolve) => {
      this.pickerResolve = resolve;
    });

    // Cleanup
    await this.dismissWorkspacePicker();
    return selectedIndex;
  }

  private pickerSelectedIndex = 0;

  private async dismissWorkspacePicker(): Promise<void> {
    const wmId = this.widgetManagerId;
    if (!wmId) return;
    if (this.pickerDialogId) {
      try { this.send(request(this.id, wmId, 'destroyWindowAbject',
        { windowId: this.pickerDialogId })); } catch { /* gone */ }
    }
    if (this.pickerBackdropId) {
      try { this.send(request(this.id, wmId, 'destroyWindowAbject',
        { windowId: this.pickerBackdropId })); } catch { /* gone */ }
    }
    this.pickerBackdropId = undefined;
    this.pickerDialogId = undefined;
    this.pickerSelectId = undefined;
    this.pickerCloneBtnId = undefined;
    this.pickerCancelBtnId = undefined;
    this.pickerResolve = undefined;
    this.pickerSelectedIndex = 0;
  }

  /** Find AbjectStore registered in a given registry. */
  private async findAbjectStore(registryId: AbjectId): Promise<AbjectId | undefined> {
    try {
      const regs = await this.request<ObjectRegistration[]>(
        request(this.id, registryId, 'list', {})
      );
      const store = regs.find(r => r.manifest.name === 'AbjectStore');
      return store?.id as AbjectId | undefined;
    } catch {
      return undefined;
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AppExplorer Usage Guide

### Methods
- \`show()\` — Open the app explorer window.
- \`hide()\` — Close the app explorer window.
- \`getState()\` — Returns { visible: boolean }.
- \`browseRemote({ registryId, peerId, label })\` — Open in remote read-only mode.

### Three-Pane Layout (vertical, like ObjectBrowser)
1. **Kind List** (left) — All registered Abject types grouped into "User Apps" and "System" sections. Searchable.
2. **Instance List** (middle) — Instances of the selected kind.
3. **Detail Pane** (right) — Description, manifest info, and action buttons.

### Actions
- **Browse** — Open ObjectBrowser for the selected kind.
- **Clone** / **Delete** — Local mode only.
- **Clone to Local** — Shared tab (peer-owned, scriptable): forks a local editable copy via WorkspaceRegistry forkRemote. Edit Source/Delete are hidden for peer-owned entries.
- **Clone to...** — Local mode: clone a user object into a different workspace.
- **Clone to Local** — Remote mode: copies source into active local workspace.

### Interface ID
\`abjects:app-explorer\``;
  }
}

export const APP_EXPLORER_ID = 'abjects:app-explorer' as AbjectId;
