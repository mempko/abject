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
  private activeKindTab = 0; // 0=user, 1=system
  private userKindEntries: string[] = [];
  private systemKindEntries: string[] = [];

  // ── Pane 2: Instance list ──
  private instancePaneVBoxId?: AbjectId;
  private instanceListId?: AbjectId;
  private instanceEntries: ObjectRegistration[] = [];

  // ── Pane 3: Detail pane (scrollable VBox) ──
  private detailPaneId?: AbjectId;
  private detailWidgetIds: AbjectId[] = [];
  private detailButtonIds: Map<AbjectId, string> = new Map();

  // ── Selection state ──
  private selectedKindName?: string;
  private selectedKindIsSystem = false;
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
    return this.remoteRegistryId ?? this.registryId;
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
    this.instancePaneVBoxId = undefined;
    this.instanceListId = undefined;
    this.detailPaneId = undefined;
    this.detailWidgetIds = [];
    this.detailButtonIds.clear();
    this.userKindEntries = [];
    this.systemKindEntries = [];
    this.instanceEntries = [];
  }

  private groupByKind(): { user: Map<string, ObjectRegistration[]>; system: Map<string, ObjectRegistration[]> } {
    const user = new Map<string, ObjectRegistration[]>();
    const system = new Map<string, ObjectRegistration[]>();
    for (const obj of this.cachedObjects) {
      const name = obj.manifest.name;
      const tags = obj.manifest.tags ?? [];
      const target = tags.includes('system') ? system : user;
      const group = target.get(name);
      if (group) {
        group.push(obj);
      } else {
        target.set(name, [obj]);
      }
    }
    return { user, system };
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
    this.selectedKindIsSystem = false;
    this.selectedInstanceIndex = -1;
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
    this.selectedKindIsSystem = false;
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
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // [0] Kind tab bar (User / System)
          { type: 'tabBar', windowId, rect: r0,
            tabs: ['User', 'System'], selectedIndex: this.activeKindTab, closable: false },
          // [1] User kind list (searchable)
          { type: 'list', windowId, rect: r0, items: [], searchable: true },
          // [2] System kind list
          { type: 'list', windowId, rect: r0, items: [] },
          // [3] Instance list
          { type: 'list', windowId, rect: r0, items: [] },
        ],
      })
    );

    const [kindTabBar, userKindList, systemKindList, instanceList] = widgetIds;
    this.kindTabBarId = kindTabBar;
    this.userKindListId = userKindList;
    this.systemKindListId = systemKindList;
    this.instanceListId = instanceList;

    // ── Batch add kind-pane widgets to their layout ──
    await this.request(request(this.id, this.kindPaneVBoxId, 'addLayoutChildren', {
      children: [
        { widgetId: this.kindTabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 32 } },
        { widgetId: this.userKindListId, sizePolicy: { vertical: 'expanding' } },
        { widgetId: this.systemKindListId, sizePolicy: { vertical: 'expanding' } },
      ],
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
    if (this.selectedKindName && !this.selectedKindIsSystem) {
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
    if (this.selectedKindName && this.selectedKindIsSystem) {
      sysSelected = this.systemKindEntries.indexOf(this.selectedKindName);
    }
    await this.request(request(this.id, this.systemKindListId, 'update', {
      items: sysItems, selectedIndex: sysSelected,
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
      const tags = o.manifest.tags ?? [];
      const isSys = tags.includes('system');
      return o.manifest.name === this.selectedKindName
        && isSys === this.selectedKindIsSystem;
    });
    // Auto-select if there's exactly one instance
    this.selectedInstanceIndex = this.instanceEntries.length === 1 ? 0 : -1;

    const items = this.instanceEntries.map(inst => {
      const shortId = inst.id.slice(0, 8);
      return {
        label: `${inst.manifest.name}`,
        value: inst.id,
        secondary: `[${shortId}...]`,
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

    if (this.isRemote) {
      if (hasSource) {
        specs.push({ type: 'button', windowId, rect: r0,
          text: 'Clone to Local', style: { fontSize: 12 }, action: 'cloneToLocal' });
      }
    } else {
      if (hasSource) {
        const editorId = await this.findAbjectEditor();
        if (editorId) {
          specs.push({ type: 'button', windowId, rect: r0,
            text: 'Edit Source', style: { fontSize: 12 }, action: 'editSource' });
        }
      }
      if (!this.selectedKindIsSystem) {
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
      this.selectedKindIsSystem = false;
      await this.request(request(this.id, this.systemKindListId!, 'update', { selectedIndex: -1 }));
      await this.rebuildInstanceList();
      return;
    }

    // System kind list selection
    if (fromId === this.systemKindListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      this.selectedKindName = sel.value;
      this.selectedKindIsSystem = true;
      await this.request(request(this.id, this.userKindListId!, 'update', { selectedIndex: -1 }));
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
          await this.deleteObject(this.instanceEntries[this.selectedInstanceIndex].id);
        }
      } else if (action === 'editSource') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          await this.editSource(this.instanceEntries[this.selectedInstanceIndex].id);
        }
      } else if (action === 'cloneTo') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          await this.cloneToWorkspace(this.instanceEntries[this.selectedInstanceIndex]);
        }
      } else if (action === 'cloneToLocal') {
        if (this.selectedInstanceIndex >= 0 && this.selectedInstanceIndex < this.instanceEntries.length) {
          await this.cloneToLocal(this.instanceEntries[this.selectedInstanceIndex]);
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

    try {
      await this.request(request(this.id, this.factoryId,
        'kill', { objectId }));
    } catch { /* object may already be gone */ }

    this.cachedObjects = await this.registryList();

    if (this.selectedKindName) {
      const remaining = this.cachedObjects.filter(o => {
        const tags = o.manifest.tags ?? [];
        return o.manifest.name === this.selectedKindName
          && tags.includes('system') === this.selectedKindIsSystem;
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
- **Clone to...** — Local mode: clone a user object into a different workspace.
- **Clone to Local** — Remote mode: copies source into active local workspace.

### Interface ID
\`abjects:app-explorer\``;
  }
}

export const APP_EXPLORER_ID = 'abjects:app-explorer' as AbjectId;
