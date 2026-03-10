/**
 * ObjectBrowser — Smalltalk-inspired four-pane object explorer (global).
 *
 * Pane 1: Scope filter (All, per-workspace, remote workspaces)
 * Pane 2: Object Kinds (grouped by manifest.name)
 * Pane 3: Methods/Events for selected kind
 * Pane 4: Detail (signature, status, source, send message, implementors/senders)
 *
 * Features: navigation history, breadcrumbs, investigation tabs,
 * find-implementors, find-senders, inline message sending, source viewing.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  InterfaceDeclaration,
  MethodDeclaration,
  ObjectRegistration,
  SpawnResult,
  TypeDeclaration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { DiscoveredWorkspace } from './workspace-share-registry.js';

const OBJECT_BROWSER_INTERFACE: InterfaceId = 'abjects:object-browser' as InterfaceId;

const WIN_W = 900;
const WIN_H = 600;

// ── Data Model ─────────────────────────────────────────────────────

interface RegistrySource {
  id: AbjectId;
  label: string;
  kind: 'system' | 'local-workspace' | 'remote-workspace';
  workspaceId?: string;
  peerId?: string;
  isRemote: boolean;
}

interface NavState {
  pane1Filter: { scope: string };
  selectedKind?: string;
  selectedItem?: { type: 'method' | 'event'; name: string };
  detailMode?: 'detail' | 'implementors' | 'senders';
  label: string;
}

interface InvestigationTab {
  name: string;
  history: NavState[];
  historyIndex: number;
  searches: [string, string, string];
}

export const OBJECT_BROWSER_ID = 'abjects:object-browser' as AbjectId;

export class ObjectBrowser extends Abject {
  // ── Dependencies ──
  private widgetManagerId?: AbjectId;
  private factoryId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private shareRegistryId?: AbjectId;
  private systemRegistryId?: AbjectId;

  // ── Multi-registry data ──
  private registrySources: Map<string, RegistrySource> = new Map();
  private registryObjects: Map<string, ObjectRegistration[]> = new Map();

  // ── Auto-refresh timer ──
  private refreshTimer?: ReturnType<typeof setTimeout>;

  // ── Window & layout ──
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // ── Toolbar widgets ──
  private tabBarId?: AbjectId;
  private backBtnId?: AbjectId;
  private forwardBtnId?: AbjectId;
  private breadcrumbIds: AbjectId[] = [];
  private breadcrumbLayoutId?: AbjectId;

  // ── Four panes ──
  private outerSplitId?: AbjectId;
  private leftSplitId?: AbjectId;
  private rightSplitId?: AbjectId;
  private pane1VBoxId?: AbjectId;
  private scopeListId?: AbjectId;
  private localWsListId?: AbjectId;
  private remoteWsListId?: AbjectId;
  private pane2ListId?: AbjectId;
  private pane3ListId?: AbjectId;
  private pane4LayoutId?: AbjectId;

  // ── Pane 4 content widgets ──
  private pane4LabelIds: AbjectId[] = [];
  private pane4ButtonIds: Map<AbjectId, string> = new Map();
  private msgParamInputIds: Map<string, AbjectId> = new Map(); // param name → input widget
  private msgSendBtnId?: AbjectId;
  private msgResponseLabelId?: AbjectId;

  // ── Navigation ──
  private tabs: InvestigationTab[] = [];
  private activeTabIndex = 0;

  // ── Computed state from current NavState ──
  private filteredKinds: Array<{ name: string; count: number; isSystem: boolean; isRemote: boolean }> = [];
  private currentKindRegistrations: ObjectRegistration[] = [];
  private currentMethods: Array<{ type: 'method' | 'event'; name: string; decl?: MethodDeclaration; iface?: InterfaceDeclaration }> = [];

  constructor() {
    super({
      manifest: {
        name: 'ObjectBrowser',
        description:
          'Smalltalk-inspired four-pane object explorer. Browse categories, object kinds, methods/events, and details with navigation history and investigation tabs.',
        version: '1.0.0',
        interface: {
          id: OBJECT_BROWSER_INTERFACE,
          name: 'ObjectBrowser',
          description: 'Four-pane object explorer with navigation history',
          methods: [
            {
              name: 'show',
              description: 'Show the object browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the object browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Get current state',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
            {
              name: 'browseKind',
              description: 'Navigate to a specific object kind',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Kind name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'browseScope',
              description: 'Navigate to a specific scope (workspace or remote)',
              parameters: [
                { name: 'scope', type: { kind: 'primitive', primitive: 'string' }, description: 'Scope key' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.factoryId = await this.discoverDep('Factory') ?? undefined;
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    this.systemRegistryId = await this.discoverDep('Registry') ?? undefined;

    // Subscribe to system registry changes
    if (this.systemRegistryId) {
      try {
        await this.request(request(this.id, this.systemRegistryId, 'subscribe', {}));
      } catch { /* may not support subscribe */ }
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      await this.show();
      return true;
    });

    this.on('hide', async () => {
      await this.hide();
      return true;
    });

    this.on('getState', async () => {
      return { visible: this.windowId !== undefined };
    });

    this.on('browseKind', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      await this.show();
      const state: NavState = {
        pane1Filter: { scope: 'all' },
        selectedKind: name,
        label: `All > ${name}`,
      };
      this.navigateTo(state);
      await this.rebuildAllPanes();
      return true;
    });

    this.on('browseScope', async (msg: AbjectMessage) => {
      const { scope } = msg.payload as { scope: string };
      await this.show();
      await this.discoverRegistrySources();
      const source = this.registrySources.get(scope);
      const label = source?.label ?? scope;
      const state: NavState = {
        pane1Filter: { scope },
        label,
      };
      this.navigateTo(state);
      await this.rebuildAllPanes();
      return true;
    });

    // Window close
    this.on('windowCloseRequested', async () => {
      await this.hide();
    });

    // Registry update notifications
    this.on('objectRegistered', async () => {
      if (this.windowId) {
        await this.refreshCaches();
        await this.rebuildPane2();
      }
    });
    this.on('objectUnregistered', async () => {
      if (this.windowId) {
        await this.refreshCaches();
        await this.rebuildPane2();
      }
    });

    // Workspace lifecycle events
    this.on('workspaceCreated', async () => {
      if (this.windowId) {
        await this.discoverRegistrySources();
        await this.refreshCaches();
        await this.rebuildAllPanes();
      }
    });
    this.on('workspaceDeleted', async () => {
      if (this.windowId) {
        await this.discoverRegistrySources();
        await this.refreshCaches();
        await this.rebuildAllPanes();
      }
    });
    this.on('workspacesDiscovered', async () => {
      if (this.windowId) {
        await this.discoverRegistrySources();
        await this.refreshCaches();
        await this.rebuildAllPanes();
      }
    });

    // Handle widget events
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });
  }

  // ── Show/Hide ─────────────────────────────────────────────────────

  async show(): Promise<void> {
    if (this.windowId) {
      // Raise existing window
      await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
        windowId: this.windowId,
      }));
      return;
    }

    // Initialize first tab
    if (this.tabs.length === 0) {
      this.tabs.push({
        name: 'Browse',
        history: [{ pane1Filter: { scope: 'all' }, label: 'All' }],
        historyIndex: 0,
        searches: ['', '', ''],
      });
      this.activeTabIndex = 0;
    }

    await this.discoverRegistrySources();
    await this.refreshCaches();
    await this.buildUI();
    this.startAutoRefresh();
  }

  async hide(): Promise<void> {
    this.stopAutoRefresh();
    if (!this.windowId) return;
    try {
      await this.request(request(this.id, this.widgetManagerId!,
        'destroyWindowAbject', { windowId: this.windowId }));
    } catch { /* already gone */ }
    this.windowId = undefined;
    this.clearWidgetTracking();
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(async () => {
      if (!this.windowId) return;
      try {
        await this.discoverRegistrySources();
        await this.refreshCaches();
        await this.rebuildPane1();
        // Only rebuild pane2 if the user's selected scope data changed
        await this.rebuildPane2();
      } catch { /* best-effort */ }
    }, 15_000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private clearWidgetTracking(): void {
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.backBtnId = undefined;
    this.forwardBtnId = undefined;
    this.breadcrumbIds = [];
    this.breadcrumbLayoutId = undefined;
    this.outerSplitId = undefined;
    this.leftSplitId = undefined;
    this.rightSplitId = undefined;
    this.pane1VBoxId = undefined;
    this.scopeListId = undefined;
    this.localWsListId = undefined;
    this.remoteWsListId = undefined;
    this.pane2ListId = undefined;
    this.pane3ListId = undefined;
    this.pane4LayoutId = undefined;
    this.pane4LabelIds = [];
    this.pane4ButtonIds.clear();
    this.msgParamInputIds.clear();
    this.msgSendBtnId = undefined;
    this.msgResponseLabelId = undefined;
  }

  // ── Tab management ────────────────────────────────────────────────

  private get currentTab(): InvestigationTab {
    return this.tabs[this.activeTabIndex];
  }

  private get currentState(): NavState {
    const tab = this.currentTab;
    return tab.history[tab.historyIndex];
  }

  private navigateTo(state: NavState): void {
    const tab = this.currentTab;
    // Truncate forward history
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(state);
    tab.historyIndex = tab.history.length - 1;
  }

  private goBack(): boolean {
    const tab = this.currentTab;
    if (tab.historyIndex > 0) {
      tab.historyIndex--;
      return true;
    }
    return false;
  }

  private goForward(): boolean {
    const tab = this.currentTab;
    if (tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      return true;
    }
    return false;
  }

  // ── Registry Source Discovery ─────────────────────────────────────

  private async discoverRegistrySources(): Promise<void> {
    // Lazy-discover dependencies that may not have been available at onInit time
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    }
    if (!this.shareRegistryId) {
      this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }
    if (!this.systemRegistryId) {
      this.systemRegistryId = await this.discoverDep('Registry') ?? undefined;
    }

    const oldKeys = new Set(this.registrySources.keys());

    // System registry is always present
    if (this.systemRegistryId) {
      const key = 'system';
      this.registrySources.set(key, {
        id: this.systemRegistryId,
        label: 'System',
        kind: 'system',
        isRemote: false,
      });
      oldKeys.delete(key);
    }

    // Discover local workspaces via WorkspaceManager
    if (this.workspaceManagerId) {
      try {
        const detailed = await this.request<Array<{
          workspaceId: string;
          name: string;
          registryId: AbjectId;
        }>>(request(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {}));

        for (const ws of detailed) {
          const key = `ws:${ws.workspaceId}`;
          this.registrySources.set(key, {
            id: ws.registryId,
            label: ws.name,
            kind: 'local-workspace',
            workspaceId: ws.workspaceId,
            isRemote: false,
          });
          oldKeys.delete(key);

          // Subscribe to each workspace registry for live updates
          try {
            await this.request(request(this.id, ws.registryId, 'subscribe', {}));
          } catch { /* may not support subscribe */ }
        }
      } catch {
        console.warn('[ObjectBrowser] Failed to list workspaces');
      }
    }

    // Discover remote workspaces via WorkspaceShareRegistry
    if (this.shareRegistryId) {
      try {
        const discovered = await this.request<DiscoveredWorkspace[]>(
          request(this.id, this.shareRegistryId, 'getDiscoveredWorkspaces', {})
        );

        for (const dw of discovered) {
          // Skip workspaces without a routable registry ID
          if (!dw.registryId) continue;

          const key = `remote:${dw.ownerPeerId}/${dw.workspaceId}`;
          const ownerLabel = dw.ownerName || dw.ownerPeerId.slice(0, 8);
          this.registrySources.set(key, {
            id: dw.registryId as AbjectId,
            label: `${ownerLabel} / ${dw.name}`,
            kind: 'remote-workspace',
            workspaceId: dw.workspaceId,
            peerId: dw.ownerPeerId,
            isRemote: true,
          });
          oldKeys.delete(key);
        }
      } catch {
        console.warn('[ObjectBrowser] Failed to get discovered workspaces');
      }
    }

    // Clean up stale entries
    for (const staleKey of oldKeys) {
      if (staleKey === 'system') continue; // never remove system
      this.registrySources.delete(staleKey);
      this.registryObjects.delete(staleKey);
    }
  }

  // ── Data loading ──────────────────────────────────────────────────

  private async refreshCaches(): Promise<void> {
    const entries = [...this.registrySources.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([key, source]) => {
        // Use a shorter timeout for remote registries to avoid UI hangs
        const timeoutMs = source.isRemote ? 8000 : 30000;
        const objects = await this.request<ObjectRegistration[]>(
          request(this.id, source.id, 'list', {}),
          timeoutMs,
        );
        return { key, objects };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.registryObjects.set(result.value.key, result.value.objects);
      }
    }
  }

  private getFilteredRegistrations(): ObjectRegistration[] {
    const scope = this.currentState.pane1Filter.scope;

    if (scope === 'all') {
      const combined: ObjectRegistration[] = [];
      const seen = new Set<string>();
      for (const [, regs] of this.registryObjects) {
        for (const reg of regs) {
          if (!seen.has(reg.id)) {
            seen.add(reg.id);
            combined.push(reg);
          }
        }
      }
      return combined;
    }

    return this.registryObjects.get(scope) ?? [];
  }

  private groupByKind(regs: ObjectRegistration[]): Array<{ name: string; count: number; isSystem: boolean; isRemote: boolean }> {
    const kindMap = new Map<string, { count: number; isSystem: boolean; isRemote: boolean }>();

    // Build sets for system and remote object IDs
    const systemIds = new Set<string>();
    const remoteIds = new Set<string>();
    for (const [key, source] of this.registrySources) {
      const objs = this.registryObjects.get(key) ?? [];
      for (const obj of objs) {
        if (source.kind === 'system') systemIds.add(obj.id);
        if (source.isRemote) remoteIds.add(obj.id);
      }
    }

    for (const reg of regs) {
      const name = reg.manifest.name;
      const existing = kindMap.get(name);
      const isSys = systemIds.has(reg.id);
      const isRem = remoteIds.has(reg.id);
      if (existing) {
        existing.count++;
        if (isSys) existing.isSystem = true;
        if (isRem) existing.isRemote = true;
      } else {
        kindMap.set(name, { count: 1, isSystem: isSys, isRemote: isRem });
      }
    }

    return [...kindMap.entries()]
      .map(([name, data]) => ({ name, count: data.count, isSystem: data.isSystem, isRemote: data.isRemote }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private getRegistrationsForKind(kindName: string): ObjectRegistration[] {
    const all: ObjectRegistration[] = [];
    const seen = new Set<string>();
    for (const [, regs] of this.registryObjects) {
      for (const reg of regs) {
        if (reg.manifest.name === kindName && !seen.has(reg.id)) {
          seen.add(reg.id);
          all.push(reg);
        }
      }
    }
    return all;
  }

  private getMethodsAndEvents(kindName: string): Array<{ type: 'method' | 'event'; name: string; decl?: MethodDeclaration; iface?: InterfaceDeclaration }> {
    const regs = this.getRegistrationsForKind(kindName);
    if (regs.length === 0) return [];

    const reg = regs[0];
    const result: Array<{ type: 'method' | 'event'; name: string; decl?: MethodDeclaration; iface?: InterfaceDeclaration }> = [];

    const iface = reg.manifest.interface;
    if (iface) {
      for (const m of iface.methods ?? []) {
        result.push({ type: 'method', name: m.name, decl: m, iface });
      }
      for (const e of (iface as InterfaceDeclaration & { events?: MethodDeclaration[] }).events ?? []) {
        result.push({ type: 'event', name: e.name, decl: e, iface });
      }
    }

    return result;
  }

  // ── Widget helpers ────────────────────────────────────────────────

  private async wm(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request(request(this.id, this.widgetManagerId!, method, payload));
  }

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  private async addToLayout(layoutId: AbjectId, widgetId: AbjectId, sizePolicy: Record<string, string>, preferredSize?: Record<string, number>): Promise<void> {
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId,
      sizePolicy,
      preferredSize,
    }));
  }

  // ── Build UI ──────────────────────────────────────────────────────

  private async buildUI(): Promise<void> {
    const wm = this.wm.bind(this);

    // Center window on display
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    // Create window
    this.windowId = await wm('createWindowAbject', {
      title: 'Object Explorer',
      rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
      resizable: true,
    }) as AbjectId;

    // Root VBox
    this.rootLayoutId = await wm('createVBox', {
      windowId: this.windowId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 0,
    }) as AbjectId;

    // ── Toolbar row (tabs + nav buttons) ──
    const toolbarLayout = await wm('createNestedHBox', {
      parentLayoutId: this.rootLayoutId,
      margins: { top: 4, right: 8, bottom: 2, left: 8 },
      spacing: 4,
    }) as AbjectId;
    await this.addToLayout(this.rootLayoutId, toolbarLayout, { vertical: 'fixed' }, { height: 30 });

    // Tab bar
    const tabNames = this.tabs.map(t => t.name);
    tabNames.push('+');
    this.tabBarId = await wm('createTabBar', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      tabs: tabNames,
      selectedIndex: this.activeTabIndex,
    }) as AbjectId;
    await this.addDep(this.tabBarId);
    await this.addToLayout(toolbarLayout, this.tabBarId, { horizontal: 'expanding' }, { height: 28 });

    // Back button
    this.backBtnId = await wm('createButton', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      text: '\u25C0',
      style: { fontSize: 12 },
    }) as AbjectId;
    await this.addDep(this.backBtnId);
    await this.addToLayout(toolbarLayout, this.backBtnId, { horizontal: 'fixed' }, { width: 32, height: 28 });

    // Forward button
    this.forwardBtnId = await wm('createButton', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      text: '\u25B6',
      style: { fontSize: 12 },
    }) as AbjectId;
    await this.addDep(this.forwardBtnId);
    await this.addToLayout(toolbarLayout, this.forwardBtnId, { horizontal: 'fixed' }, { width: 32, height: 28 });

    // ── Breadcrumb row ──
    this.breadcrumbLayoutId = await wm('createNestedHBox', {
      parentLayoutId: this.rootLayoutId,
      margins: { top: 2, right: 8, bottom: 2, left: 8 },
      spacing: 2,
    }) as AbjectId;
    await this.addToLayout(this.rootLayoutId, this.breadcrumbLayoutId, { vertical: 'fixed' }, { height: 22 });

    // ── Divider ──
    const divId = await wm('createDivider', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    }) as AbjectId;
    await this.addToLayout(this.rootLayoutId, divId, { vertical: 'fixed' }, { height: 1 });

    // ── Four-pane area using HBox ──
    const paneHBox = await wm('createNestedHBox', {
      parentLayoutId: this.rootLayoutId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 1,
    }) as AbjectId;
    await this.addToLayout(this.rootLayoutId, paneHBox, { vertical: 'expanding' });

    // Pane 1: Scope lists in a VBox
    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    this.pane1VBoxId = await wm('createNestedVBox', {
      parentLayoutId: paneHBox,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 2,
    }) as AbjectId;
    await this.addToLayout(paneHBox, this.pane1VBoxId, { horizontal: 'expanding' }, { width: 180 });

    // Scope list (All, System) — fixed height
    this.scopeListId = await wm('createList', {
      windowId: this.windowId, rect: r0, items: [],
    }) as AbjectId;
    await this.addDep(this.scopeListId);
    await this.addToLayout(this.pane1VBoxId, this.scopeListId, { vertical: 'fixed' }, { height: 60 });

    // "Local" label
    const localLabel = await wm('createLabel', {
      windowId: this.windowId, rect: r0, text: 'Local',
      style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
    }) as AbjectId;
    await this.addToLayout(this.pane1VBoxId, localLabel, { vertical: 'fixed' }, { height: 20 });

    // Local workspace list
    this.localWsListId = await wm('createList', {
      windowId: this.windowId, rect: r0, items: [], searchable: true,
    }) as AbjectId;
    await this.addDep(this.localWsListId);
    await this.addToLayout(this.pane1VBoxId, this.localWsListId, { vertical: 'expanding' });

    // "Discovered" label
    const remoteLabel = await wm('createLabel', {
      windowId: this.windowId, rect: r0, text: 'Discovered',
      style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
    }) as AbjectId;
    await this.addToLayout(this.pane1VBoxId, remoteLabel, { vertical: 'fixed' }, { height: 20 });

    // Remote workspace list
    this.remoteWsListId = await wm('createList', {
      windowId: this.windowId, rect: r0, items: [],
    }) as AbjectId;
    await this.addDep(this.remoteWsListId);
    await this.addToLayout(this.pane1VBoxId, this.remoteWsListId, { vertical: 'expanding' });

    // Pane 2: Object Kinds list
    this.pane2ListId = await wm('createList', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      items: [],
      searchable: true,
    }) as AbjectId;
    await this.addDep(this.pane2ListId);
    await this.addToLayout(paneHBox, this.pane2ListId, { horizontal: 'expanding' }, { width: 200 });

    // Pane 3: Methods/Events list
    this.pane3ListId = await wm('createList', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      items: [],
      searchable: true,
    }) as AbjectId;
    await this.addDep(this.pane3ListId);
    await this.addToLayout(paneHBox, this.pane3ListId, { horizontal: 'expanding' }, { width: 200 });

    // Pane 4: Detail (scrollable vbox)
    this.pane4LayoutId = await wm('createNestedScrollableVBox', {
      parentLayoutId: paneHBox,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 4,
    }) as AbjectId;
    await this.addToLayout(paneHBox, this.pane4LayoutId,
      { horizontal: 'expanding' }, { width: 300 });

    // Populate all panes
    await this.rebuildAllPanes();
  }

  // ── Pane Rebuilding ───────────────────────────────────────────────

  private async rebuildAllPanes(): Promise<void> {
    await this.rebuildPane1();
    await this.rebuildPane2();
    await this.rebuildPane3();
    await this.rebuildPane4();
    await this.updateBreadcrumb();
  }

  private async rebuildPane1(): Promise<void> {
    if (!this.scopeListId || !this.localWsListId || !this.remoteWsListId) return;
    const state = this.currentState;
    const scope = state.pane1Filter.scope;

    // Scope list (All, System)
    const scopeItems = [
      { label: scope === 'all' ? '\u25CF All' : '\u25CB All', value: 'scope:all' },
      { label: scope === 'system' ? '\u25CF System' : '\u25CB System', value: 'scope:system' },
    ];
    const scopeSelected = scope === 'all' ? 0 : scope === 'system' ? 1 : -1;
    await this.request(request(this.id, this.scopeListId, 'update', {
      items: scopeItems, selectedIndex: scopeSelected,
    }));

    // Local workspaces
    const localSources = [...this.registrySources.entries()]
      .filter(([, s]) => s.kind === 'local-workspace');
    const localItems = localSources.map(([key, source]) => ({
      label: scope === key ? `\u25CF ${source.label}` : `\u25CB ${source.label}`,
      value: `scope:${key}`,
    }));
    const localSelected = localSources.findIndex(([key]) => scope === key);
    await this.request(request(this.id, this.localWsListId, 'update', {
      items: localItems, selectedIndex: localSelected,
    }));

    // Remote (discovered) workspaces
    const remoteSources = [...this.registrySources.entries()]
      .filter(([, s]) => s.kind === 'remote-workspace');
    const remoteItems = remoteSources.map(([key, source]) => ({
      label: scope === key ? `\u25CF ${source.label}` : `\u25CB ${source.label}`,
      value: `scope:${key}`,
    }));
    const remoteSelected = remoteSources.findIndex(([key]) => scope === key);
    await this.request(request(this.id, this.remoteWsListId, 'update', {
      items: remoteItems, selectedIndex: remoteSelected,
    }));
  }

  private async rebuildPane2(): Promise<void> {
    if (!this.pane2ListId) return;

    const regs = this.getFilteredRegistrations();
    this.filteredKinds = this.groupByKind(regs);

    const items = this.filteredKinds.map(k => ({
      label: k.name,
      value: k.name,
      secondary: `(${k.count})`,
    }));

    // Find selected index
    const state = this.currentState;
    let selectedIndex = -1;
    if (state.selectedKind) {
      selectedIndex = this.filteredKinds.findIndex(k => k.name === state.selectedKind);
    }

    await this.request(request(this.id, this.pane2ListId, 'update', {
      items,
      selectedIndex,
    }));
  }

  private async rebuildPane3(): Promise<void> {
    if (!this.pane3ListId) return;
    const state = this.currentState;

    if (!state.selectedKind) {
      await this.request(request(this.id, this.pane3ListId, 'update', {
        items: [],
        selectedIndex: -1,
      }));
      this.currentMethods = [];
      return;
    }

    this.currentMethods = this.getMethodsAndEvents(state.selectedKind);

    const items = this.currentMethods.map(m => ({
      label: m.type === 'event' ? `\u25B8 ${m.name}` : `\u25B8 ${m.name}`,
      value: `${m.type}:${m.name}`,
      secondary: m.type === 'event' ? 'event' : '',
    }));

    let selectedIndex = -1;
    if (state.selectedItem) {
      selectedIndex = this.currentMethods.findIndex(
        m => m.type === state.selectedItem!.type && m.name === state.selectedItem!.name
      );
    }

    await this.request(request(this.id, this.pane3ListId, 'update', {
      items,
      selectedIndex,
    }));
  }

  private async rebuildPane4(): Promise<void> {
    if (!this.pane4LayoutId || !this.windowId) return;
    const state = this.currentState;

    // Clear existing pane4 content
    await this.clearPane4();

    if (state.detailMode === 'implementors') {
      await this.rebuildPane4Implementors();
    } else if (state.detailMode === 'senders') {
      await this.rebuildPane4Senders();
    } else if (state.selectedItem && state.selectedKind) {
      await this.rebuildPane4Detail();
    } else if (state.selectedKind) {
      await this.rebuildPane4KindOverview();
    } else {
      await this.addPane4Label('Select a category and object kind to browse.', true);
    }
  }

  private async clearPane4(): Promise<void> {
    // Destroy old pane4 widgets
    for (const id of this.pane4LabelIds) {
      try {
        await this.request(request(this.id, this.pane4LayoutId!, 'removeLayoutChild', { widgetId: id }));
        await this.request(request(this.id, id, 'destroy', {}));
      } catch { /* gone */ }
    }
    for (const [id] of this.pane4ButtonIds) {
      try {
        await this.request(request(this.id, this.pane4LayoutId!, 'removeLayoutChild', { widgetId: id }));
        await this.request(request(this.id, id, 'destroy', {}));
      } catch { /* gone */ }
    }
    for (const [, inputId] of this.msgParamInputIds) {
      try {
        await this.request(request(this.id, this.pane4LayoutId!, 'removeLayoutChild', { widgetId: inputId }));
        await this.request(request(this.id, inputId, 'destroy', {}));
      } catch { /* gone */ }
    }
    if (this.msgSendBtnId) {
      try {
        await this.request(request(this.id, this.pane4LayoutId!, 'removeLayoutChild', { widgetId: this.msgSendBtnId }));
        await this.request(request(this.id, this.msgSendBtnId, 'destroy', {}));
      } catch { /* gone */ }
    }
    if (this.msgResponseLabelId) {
      try {
        await this.request(request(this.id, this.pane4LayoutId!, 'removeLayoutChild', { widgetId: this.msgResponseLabelId }));
        await this.request(request(this.id, this.msgResponseLabelId, 'destroy', {}));
      } catch { /* gone */ }
    }
    this.pane4LabelIds = [];
    this.pane4ButtonIds.clear();
    this.msgParamInputIds.clear();
    this.msgSendBtnId = undefined;
    this.msgResponseLabelId = undefined;
  }

  private async addPane4Label(text: string, isSecondary = false, style?: Record<string, unknown>): Promise<AbjectId> {
    const labelId = await this.wm('createLabel', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      text,
      style: {
        fontSize: isSecondary ? 12 : 13,
        color: isSecondary ? undefined : undefined,
        wordWrap: true,
        ...style,
      },
    }) as AbjectId;
    const lines = Math.max(1, Math.ceil(text.length / 40));
    const lineHeight = isSecondary ? 16 : 18;
    await this.addToLayout(this.pane4LayoutId!, labelId, { vertical: 'fixed' },
      { height: Math.max(lineHeight, lines * lineHeight) });
    this.pane4LabelIds.push(labelId);
    return labelId;
  }

  private async addPane4Button(text: string, actionKey: string, style?: Record<string, unknown>): Promise<AbjectId> {
    const btnId = await this.wm('createButton', {
      windowId: this.windowId,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      text,
      style: { fontSize: 11, ...style },
    }) as AbjectId;
    await this.addDep(btnId);
    await this.addToLayout(this.pane4LayoutId!, btnId, { vertical: 'fixed', horizontal: 'fixed' },
      { width: 160, height: 26 });
    this.pane4ButtonIds.set(btnId, actionKey);
    return btnId;
  }

  private async setWidgetDisabled(id: AbjectId | undefined, disabled: boolean): Promise<void> {
    if (!id) return;
    try {
      await this.request(request(this.id, id, 'update', { style: { disabled } }));
    } catch { /* widget gone */ }
  }

  /** Check if current scope is remote */
  private isRemoteScope(): boolean {
    return this.currentState.pane1Filter.scope.startsWith('remote:');
  }

  /** Find the AbjectEditor for the current scope's workspace. */
  private async findAbjectEditorForScope(): Promise<AbjectId | undefined> {
    const scope = this.currentState.pane1Filter.scope;
    if (scope.startsWith('remote:')) return undefined;

    // For workspace scope, search that workspace's cached objects
    // For all/system scope, try finding any workspace with an AbjectEditor
    let wsKey: string | undefined;
    if (scope.startsWith('ws:')) {
      wsKey = scope;
    } else {
      // Find first local workspace
      for (const [key, source] of this.registrySources) {
        if (source.kind === 'local-workspace') {
          wsKey = key;
          break;
        }
      }
    }

    if (!wsKey) return undefined;

    const regs = this.registryObjects.get(wsKey) ?? [];
    const editor = regs.find(r => r.manifest.name === 'AbjectEditor');
    return editor?.id as AbjectId | undefined;
  }

  private async rebuildPane4KindOverview(): Promise<void> {
    const state = this.currentState;
    const kindName = state.selectedKind!;
    const regs = this.getRegistrationsForKind(kindName);
    if (regs.length === 0) return;

    const reg = regs[0];
    const isRemote = this.isRemoteScope();
    const hasSource = (reg as unknown as { source?: string }).source !== undefined;

    await this.addPane4Label(kindName, false, { fontWeight: 'bold', fontSize: 15 });

    if (reg.manifest.description) {
      await this.addPane4Label(reg.manifest.description, true);
    }

    await this.addPane4Label(`Instances: ${regs.length}`, true);

    const tags = reg.manifest.tags ?? [];
    if (tags.length > 0) {
      await this.addPane4Label(`Tags: ${tags.join(', ')}`, true);
    }

    // Show status of first instance
    await this.addPane4Label(`\u2500\u2500\u2500 Status`, true);
    await this.addPane4Label(`State: ${reg.status?.state ?? 'running'}`, true);
    if (reg.status?.errorCount !== undefined && reg.status.errorCount > 0) {
      await this.addPane4Label(`Errors: ${reg.status.errorCount}`, true);
    }

    // ── Actions section ──
    await this.addPane4Label('\u2500\u2500\u2500 Actions', true);

    if (isRemote) {
      // Remote: only Clone (if scriptable with source)
      if (hasSource) {
        await this.addPane4Button('Clone to Local', 'cloneObject');
      }
    } else {
      // Local: Edit Source, Clone, Delete (Clone/Delete only for non-system objects)
      const isSystem = tags.includes('system');
      if (hasSource) {
        const editorId = await this.findAbjectEditorForScope();
        if (editorId) {
          await this.addPane4Button('Edit Source', 'editSource');
        }
        if (!isSystem) {
          await this.addPane4Button('Clone', 'cloneObject');
        }
      }
      if (!isSystem) {
        await this.addPane4Button('Delete', 'deleteObject',
          { background: '#c0392b', color: '#ffffff', borderColor: '#c0392b' });
      }
    }

    // Response label for feedback
    this.msgResponseLabelId = await this.addPane4Label('', true);
  }

  private async rebuildPane4Detail(): Promise<void> {
    const state = this.currentState;
    if (!state.selectedItem || !state.selectedKind) return;

    const method = this.currentMethods.find(
      m => m.type === state.selectedItem!.type && m.name === state.selectedItem!.name
    );
    if (!method) {
      await this.addPane4Label(`${state.selectedItem.name} — not found`, true);
      return;
    }

    // Header
    const typeBadge = method.type === 'event' ? '[Event]' : '[Method]';
    await this.addPane4Label(`${typeBadge} ${method.name}`, false, { fontWeight: 'bold', fontSize: 14 });

    // Signature
    if (method.decl) {
      const params = method.decl.parameters ?? [];
      const paramStr = params.map(p => {
        const typeStr = p.type ? this.formatType(p.type) : 'any';
        return `${p.name}: ${typeStr}`;
      }).join(', ');

      await this.addPane4Label(`(${paramStr})`, true);

      if (method.decl.returns) {
        await this.addPane4Label(`\u2192 ${this.formatType(method.decl.returns)}`, true);
      }

      if (method.decl.description) {
        await this.addPane4Label(method.decl.description, true);
      }
    }

    // Interface info
    if (method.iface) {
      await this.addPane4Label(`Interface: ${method.iface.id}`, true);
    }

    // Divider
    await this.addPane4Label('\u2500\u2500\u2500', true);

    // Find Implementors / Senders buttons
    if (method.type === 'method') {
      await this.addPane4Button('Find Implementors', `implementors:${method.name}`);
      await this.addPane4Button('Find Senders', `senders:${method.name}`);
    }

    // Send Message section
    if (method.type === 'method') {
      await this.addPane4Label('\u2500\u2500\u2500 Send Message', true);

      const regs = this.getRegistrationsForKind(state.selectedKind);
      if (regs.length > 0) {
        const params = method.decl?.parameters ?? [];

        if (params.length === 0) {
          // No declared parameters — show a JSON payload input as fallback
          await this.addPane4Label('payload (JSON)', true);
          const inputId = await this.wm('createTextInput', {
            windowId: this.windowId,
            rect: { x: 0, y: 0, width: 0, height: 0 },
            placeholder: 'JSON payload... (leave empty for {})',
            text: '',
          }) as AbjectId;
          await this.addDep(inputId);
          await this.addToLayout(this.pane4LayoutId!, inputId, { vertical: 'fixed' }, { height: 30 });
          this.msgParamInputIds.set('__raw_json__', inputId);
        } else {
          // Generate a labeled input for each parameter
          for (const param of params) {
            const typeStr = param.type ? this.formatType(param.type) : 'any';
            const optLabel = param.optional ? ' (optional)' : '';
            await this.addPane4Label(`${param.name}: ${typeStr}${optLabel}`, true);

            const isComplex = param.type?.kind === 'object' || param.type?.kind === 'array';
            const placeholder = isComplex
              ? `JSON ${typeStr}...`
              : param.description || `${typeStr} value...`;

            const inputId = await this.wm('createTextInput', {
              windowId: this.windowId,
              rect: { x: 0, y: 0, width: 0, height: 0 },
              placeholder,
              text: '',
            }) as AbjectId;
            await this.addDep(inputId);
            await this.addToLayout(this.pane4LayoutId!, inputId, { vertical: 'fixed' }, { height: 30 });
            this.msgParamInputIds.set(param.name, inputId);
          }
        }

        this.msgSendBtnId = await this.wm('createButton', {
          windowId: this.windowId,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          text: `Send to ${regs[0].manifest.name}`,
          style: { fontSize: 11, background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
        }) as AbjectId;
        await this.addDep(this.msgSendBtnId);
        await this.addToLayout(this.pane4LayoutId!, this.msgSendBtnId, { vertical: 'fixed', horizontal: 'fixed' },
          { width: 180, height: 26 });

        this.msgResponseLabelId = await this.addPane4Label('', true);
      }
    }

  }

  private async rebuildPane4Implementors(): Promise<void> {
    const state = this.currentState;
    if (!state.selectedItem) return;
    const methodName = state.selectedItem.name;

    await this.addPane4Label(`Implementors of "${methodName}"`, false, { fontWeight: 'bold', fontSize: 14 });

    const allRegs = this.getFilteredRegistrations();
    const implementors: string[] = [];

    for (const reg of allRegs) {
      const iface = reg.manifest.interface;
      if (iface) {
        const methods = iface.methods ?? [];
        if (methods.some(m => m.name === methodName)) {
          const name = reg.manifest.name;
          if (!implementors.includes(name)) implementors.push(name);
        }
      }
    }

    if (implementors.length === 0) {
      await this.addPane4Label('No implementors found.', true);
    } else {
      for (const name of implementors.sort()) {
        await this.addPane4Button(name, `navKind:${name}`);
      }
    }
  }

  private async rebuildPane4Senders(): Promise<void> {
    const state = this.currentState;
    if (!state.selectedItem) return;
    const methodName = state.selectedItem.name;

    await this.addPane4Label(`Senders of "${methodName}"`, false, { fontWeight: 'bold', fontSize: 14 });

    const allRegs = this.getFilteredRegistrations();
    const senders: string[] = [];

    // Regex scan source fields for references to the method name
    const pattern = new RegExp(`['"]${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);

    for (const reg of allRegs) {
      const source = (reg as unknown as { source?: string }).source;
      if (source && pattern.test(source)) {
        const name = reg.manifest.name;
        if (!senders.includes(name)) senders.push(name);
      }
    }

    if (senders.length === 0) {
      await this.addPane4Label('No senders found.', true);
    } else {
      for (const name of senders.sort()) {
        await this.addPane4Button(name, `navKind:${name}`);
      }
    }
  }

  // ── Breadcrumb ────────────────────────────────────────────────────

  private async updateBreadcrumb(): Promise<void> {
    if (!this.breadcrumbLayoutId || !this.windowId) return;

    // Remove old breadcrumb widgets
    for (const id of this.breadcrumbIds) {
      try {
        await this.request(request(this.id, this.breadcrumbLayoutId, 'removeLayoutChild', { widgetId: id }));
        await this.request(request(this.id, id, 'destroy', {}));
      } catch { /* gone */ }
    }
    this.breadcrumbIds = [];

    // Build breadcrumb from current state
    const state = this.currentState;
    const parts: string[] = [];

    // Scope label from registrySources
    const scope = state.pane1Filter.scope;
    if (scope === 'all') {
      parts.push('All');
    } else {
      const source = this.registrySources.get(scope);
      parts.push(source?.label ?? scope);
    }

    if (state.selectedKind) parts.push(state.selectedKind);
    if (state.selectedItem) parts.push(`${state.selectedItem.name}()`);
    if (state.detailMode === 'implementors') parts.push('Implementors');
    if (state.detailMode === 'senders') parts.push('Senders');

    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // Arrow separator
        const arrowId = await this.wm('createLabel', {
          windowId: this.windowId,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          text: '>',
          style: { fontSize: 11, color: '#6b7084' },
        }) as AbjectId;
        await this.addToLayout(this.breadcrumbLayoutId, arrowId, { horizontal: 'fixed' }, { width: 12, height: 20 });
        this.breadcrumbIds.push(arrowId);
      }

      const partId = await this.wm('createLabel', {
        windowId: this.windowId,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        text: parts[i],
        style: { fontSize: 11, color: i === parts.length - 1 ? '#e8a84c' : '#b4b8c8' },
      }) as AbjectId;
      const estimatedWidth = Math.min(150, parts[i].length * 7 + 8);
      await this.addToLayout(this.breadcrumbLayoutId, partId, { horizontal: 'fixed' }, { width: estimatedWidth, height: 20 });
      this.breadcrumbIds.push(partId);
    }
  }

  // ── Event Handling ────────────────────────────────────────────────

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, value: unknown): Promise<void> {
    // Tab bar change
    if (fromId === this.tabBarId && aspect === 'change') {
      const idx = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (idx === this.tabs.length) {
        // "+" tab — add new investigation tab
        this.tabs.push({
          name: `Tab ${this.tabs.length + 1}`,
          history: [{ pane1Filter: { scope: 'all' }, label: 'All' }],
          historyIndex: 0,
          searches: ['', '', ''],
        });
        this.activeTabIndex = this.tabs.length - 1;
        // Update tab bar
        const tabNames = this.tabs.map(t => t.name);
        tabNames.push('+');
        await this.request(request(this.id, this.tabBarId!, 'update', {
          tabs: tabNames,
          selectedIndex: this.activeTabIndex,
        }));
        await this.rebuildAllPanes();
      } else if (idx >= 0 && idx < this.tabs.length) {
        this.activeTabIndex = idx;
        await this.rebuildAllPanes();
      }
      return;
    }

    // Tab bar close — remove tab (keep at least 1)
    if (fromId === this.tabBarId && aspect === 'close') {
      const idx = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (idx >= 0 && idx < this.tabs.length && this.tabs.length > 1) {
        this.tabs.splice(idx, 1);
        // Adjust active tab index
        if (this.activeTabIndex >= this.tabs.length) {
          this.activeTabIndex = this.tabs.length - 1;
        } else if (this.activeTabIndex > idx) {
          this.activeTabIndex--;
        }
        // Update tab bar
        const tabNames = this.tabs.map(t => t.name);
        tabNames.push('+');
        await this.request(request(this.id, this.tabBarId!, 'update', {
          tabs: tabNames,
          selectedIndex: this.activeTabIndex,
        }));
        await this.rebuildAllPanes();
      }
      return;
    }

    // Tab bar rename
    if (fromId === this.tabBarId && aspect === 'rename') {
      const { index, name } = value as { index: number; name: string };
      if (index >= 0 && index < this.tabs.length) {
        this.tabs[index].name = name;
        // Update tab bar with new names
        const tabNames = this.tabs.map(t => t.name);
        tabNames.push('+');
        await this.request(request(this.id, this.tabBarId!, 'update', {
          tabs: tabNames,
        }));
      }
      return;
    }

    // Back/Forward buttons
    if (fromId === this.backBtnId && aspect === 'click') {
      if (this.goBack()) {
        await this.rebuildAllPanes();
      }
      return;
    }
    if (fromId === this.forwardBtnId && aspect === 'click') {
      if (this.goForward()) {
        await this.rebuildAllPanes();
      }
      return;
    }

    // Pane 1 scope list selection
    if (fromId === this.scopeListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      await this.request(request(this.id, this.localWsListId!, 'update', { selectedIndex: -1 }));
      await this.request(request(this.id, this.remoteWsListId!, 'update', { selectedIndex: -1 }));
      await this.handlePane1Selection(sel.value);
      return;
    }
    // Pane 1 local workspace list selection
    if (fromId === this.localWsListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      await this.request(request(this.id, this.scopeListId!, 'update', { selectedIndex: -1 }));
      await this.request(request(this.id, this.remoteWsListId!, 'update', { selectedIndex: -1 }));
      await this.handlePane1Selection(sel.value);
      return;
    }
    // Pane 1 remote workspace list selection
    if (fromId === this.remoteWsListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      await this.request(request(this.id, this.scopeListId!, 'update', { selectedIndex: -1 }));
      await this.request(request(this.id, this.localWsListId!, 'update', { selectedIndex: -1 }));
      await this.handlePane1Selection(sel.value);
      return;
    }

    // Pane 2 selection (kind)
    if (fromId === this.pane2ListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      await this.handlePane2Selection(sel.value);
      return;
    }

    // Pane 3 selection (method/event)
    if (fromId === this.pane3ListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      await this.handlePane3Selection(sel.value);
      return;
    }

    // Pane 4 buttons
    if (this.pane4ButtonIds.has(fromId) && aspect === 'click') {
      const action = this.pane4ButtonIds.get(fromId)!;
      await this.handlePane4Action(action);
      return;
    }

    // Send message
    if (fromId === this.msgSendBtnId && aspect === 'click') {
      await this.handleSendMessage();
      return;
    }

    // Send on Enter in any param input
    for (const [, inputId] of this.msgParamInputIds) {
      if (fromId === inputId && aspect === 'submit') {
        await this.handleSendMessage();
        return;
      }
    }
  }

  private async handlePane1Selection(val: string): Promise<void> {
    if (!val.startsWith('scope:')) return;
    const scope = val.substring('scope:'.length);

    // Build label from registrySources
    let label: string;
    if (scope === 'all') {
      label = 'All';
    } else {
      const source = this.registrySources.get(scope);
      label = source?.label ?? scope;
    }

    const newState: NavState = {
      pane1Filter: { scope },
      label,
    };
    this.navigateTo(newState);
    await this.rebuildAllPanes();
  }

  private async handlePane2Selection(kindName: string): Promise<void> {
    const state = this.currentState;
    const newState: NavState = {
      pane1Filter: { ...state.pane1Filter },
      selectedKind: kindName,
      label: `${state.label} > ${kindName}`,
    };
    this.navigateTo(newState);
    await this.rebuildPane3();
    await this.rebuildPane4();
    await this.updateBreadcrumb();
  }

  private async handlePane3Selection(val: string): Promise<void> {
    const [type, name] = val.split(':') as ['method' | 'event', string];
    const state = this.currentState;

    const newState: NavState = {
      pane1Filter: { ...state.pane1Filter },
      selectedKind: state.selectedKind,
      selectedItem: { type, name },
      label: `${state.label} > ${name}()`,
    };
    this.navigateTo(newState);
    await this.rebuildPane4();
    await this.updateBreadcrumb();
  }

  private async handlePane4Action(action: string): Promise<void> {
    if (action.startsWith('implementors:')) {
      const methodName = action.substring('implementors:'.length);
      const state = this.currentState;
      const newState: NavState = {
        pane1Filter: { ...state.pane1Filter },
        selectedKind: state.selectedKind,
        selectedItem: state.selectedItem,
        detailMode: 'implementors',
        label: `${state.selectedKind} > ${methodName} > Implementors`,
      };
      this.navigateTo(newState);
      await this.rebuildPane4();
      await this.updateBreadcrumb();
    } else if (action.startsWith('senders:')) {
      const methodName = action.substring('senders:'.length);
      const state = this.currentState;
      const newState: NavState = {
        pane1Filter: { ...state.pane1Filter },
        selectedKind: state.selectedKind,
        selectedItem: state.selectedItem,
        detailMode: 'senders',
        label: `${state.selectedKind} > ${methodName} > Senders`,
      };
      this.navigateTo(newState);
      await this.rebuildPane4();
      await this.updateBreadcrumb();
    } else if (action.startsWith('navKind:')) {
      const kindName = action.substring('navKind:'.length);
      const state = this.currentState;
      const newState: NavState = {
        pane1Filter: { ...state.pane1Filter },
        selectedKind: kindName,
        label: `${state.label} > ${kindName}`,
      };
      this.navigateTo(newState);
      await this.rebuildAllPanes();
    } else if (action === 'editSource') {
      const state = this.currentState;
      const editorId = await this.findAbjectEditorForScope();
      if (state.selectedKind && editorId) {
        const regs = this.getRegistrationsForKind(state.selectedKind);
        if (regs.length > 0) {
          try {
            await this.request(request(this.id, editorId, 'show', {
              objectId: regs[0].id,
            }));
          } catch { /* editor may not be available */ }
        }
      }
    } else if (action === 'deleteObject') {
      await this.handleDeleteObject();
    } else if (action === 'cloneObject') {
      await this.handleCloneObject();
    }
  }

  // ── Delete ──

  private async handleDeleteObject(): Promise<void> {
    const state = this.currentState;
    if (!state.selectedKind) return;

    // Lazy-discover Factory
    if (!this.factoryId) {
      this.factoryId = await this.discoverDep('Factory') ?? undefined;
    }
    if (!this.factoryId) {
      await this.showFeedback('Error: Factory not found');
      return;
    }

    const regs = this.getRegistrationsForKind(state.selectedKind);
    if (regs.length === 0) return;

    const targetId = regs[0].id as AbjectId;

    try {
      await this.request(request(this.id, this.factoryId, 'kill', { objectId: targetId }));
      await this.showFeedback('Deleted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.showFeedback(`Error: ${msg.slice(0, 50)}`);
    }

    // Refresh and navigate back
    await this.refreshCaches();
    await this.rebuildPane2();
    await this.rebuildPane3();
    await this.rebuildPane4();
  }

  // ── Clone ──

  private async handleCloneObject(): Promise<void> {
    const state = this.currentState;
    if (!state.selectedKind) return;

    const regs = this.getRegistrationsForKind(state.selectedKind);
    if (regs.length === 0) return;

    const obj = regs[0];
    const source = (obj as unknown as { source?: string }).source;
    if (!source) {
      await this.showFeedback('No source to clone');
      return;
    }

    // Lazy-discover Factory
    if (!this.factoryId) {
      this.factoryId = await this.discoverDep('Factory') ?? undefined;
    }
    if (!this.factoryId) {
      await this.showFeedback('Error: Factory not found');
      return;
    }

    // Determine target workspace registry for clone
    const targetRegistryId = await this.findTargetRegistryForClone();
    if (!targetRegistryId) {
      await this.showFeedback('Error: no local workspace found');
      return;
    }

    try {
      const result = await this.request<SpawnResult>(request(this.id, this.factoryId,
        'spawn', {
          manifest: obj.manifest,
          source,
          registryHint: targetRegistryId,
        }));

      // Persist to AbjectStore so it survives restart
      const abjectStoreId = await this.findAbjectStoreForClone(targetRegistryId);
      if (abjectStoreId) {
        try {
          await this.request(request(this.id, abjectStoreId,
            'save', {
              objectId: result.objectId,
              manifest: obj.manifest,
              source,
              owner: this.id,
            }));
        } catch { /* best-effort persist */ }
      }

      await this.showFeedback('Cloned to workspace');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.showFeedback(`Clone error: ${msg.slice(0, 50)}`);
    }

    await this.refreshCaches();
    await this.rebuildPane2();
  }

  /** Find the registry to clone into (active workspace, or first local workspace). */
  private async findTargetRegistryForClone(): Promise<AbjectId | undefined> {
    const scope = this.currentState.pane1Filter.scope;

    // If viewing a local workspace, clone into that workspace
    if (scope.startsWith('ws:')) {
      const source = this.registrySources.get(scope);
      return source?.id;
    }

    // Otherwise find the active workspace registry
    if (this.workspaceManagerId) {
      try {
        const active = await this.request<{ id: string; name: string }>(
          request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
        );
        const wsKey = `ws:${active.id}`;
        const source = this.registrySources.get(wsKey);
        if (source) return source.id;
      } catch { /* fall through */ }
    }

    // Fallback: first local workspace
    for (const [, source] of this.registrySources) {
      if (source.kind === 'local-workspace') return source.id;
    }
    return undefined;
  }

  /** Find AbjectStore in the target workspace for persisting cloned objects. */
  private async findAbjectStoreForClone(registryId: AbjectId): Promise<AbjectId | undefined> {
    // Search all workspace registry objects for AbjectStore
    for (const [key, source] of this.registrySources) {
      if (source.id === registryId) {
        const regs = this.registryObjects.get(key) ?? [];
        const store = regs.find(r => r.manifest.name === 'AbjectStore');
        return store?.id as AbjectId | undefined;
      }
    }
    return undefined;
  }

  /** Show feedback text in the response label, resizing to fit. */
  private async showFeedback(text: string): Promise<void> {
    if (this.msgResponseLabelId && this.pane4LayoutId) {
      try {
        await this.request(request(this.id, this.msgResponseLabelId, 'update', { text }));
        // Resize label to fit wrapped text — count explicit newlines + wrapped lines
        const explicitLines = text.split('\n');
        let totalLines = 0;
        for (const line of explicitLines) {
          totalLines += Math.max(1, Math.ceil((line.length || 1) / 35));
        }
        const height = Math.max(16, totalLines * 16);
        await this.request(request(this.id, this.pane4LayoutId, 'updateLayoutChild', {
          widgetId: this.msgResponseLabelId,
          preferredSize: { height },
        }));
      } catch { /* widget gone */ }
    }
  }

  private async handleSendMessage(): Promise<void> {
    const state = this.currentState;
    if (!state.selectedKind || !state.selectedItem || !this.msgResponseLabelId) return;

    const regs = this.getRegistrationsForKind(state.selectedKind);
    if (regs.length === 0) return;

    const targetId = regs[0].id as AbjectId;
    const methodName = state.selectedItem.name;

    // Look up method declaration for type info
    const method = this.currentMethods.find(
      m => m.type === state.selectedItem!.type && m.name === state.selectedItem!.name
    );
    const paramDecls = method?.decl?.parameters ?? [];

    // Collect values from per-parameter inputs
    let payload: Record<string, unknown> = {};

    // Check for raw JSON fallback (no declared parameters)
    const rawJsonInputId = this.msgParamInputIds.get('__raw_json__');
    if (rawJsonInputId && paramDecls.length === 0) {
      let rawValue: string;
      try {
        rawValue = (await this.request<string>(
          request(this.id, rawJsonInputId, 'getValue', {})
        ) ?? '').trim();
      } catch {
        rawValue = '';
      }
      try {
        payload = rawValue ? JSON.parse(rawValue) : {};
      } catch {
        await this.showFeedback('Error: invalid JSON payload');
        return;
      }
    } else {
      for (const paramDecl of paramDecls) {
        const inputId = this.msgParamInputIds.get(paramDecl.name);
        if (!inputId) continue;

        let rawValue: string;
        try {
          rawValue = (await this.request<string>(
            request(this.id, inputId, 'getValue', {})
          ) ?? '').trim();
        } catch {
          rawValue = '';
        }

        // Skip empty optional params
        if (rawValue === '' && paramDecl.optional) continue;
        if (rawValue === '' && !paramDecl.optional) {
          await this.showFeedback(`Error: "${paramDecl.name}" is required`);
          return;
        }

        // Parse value based on declared type
        const parsed = this.parseParamValue(rawValue, paramDecl.type);
        if (parsed.error) {
          await this.showFeedback(`Error in "${paramDecl.name}": ${parsed.error}`);
          return;
        }
        payload[paramDecl.name] = parsed.value;
      }
    }

    // Disable send button during request
    await this.setWidgetDisabled(this.msgSendBtnId, true);
    await this.showFeedback('Sending...');

    try {
      const result = await this.request(
        request(this.id, targetId, methodName, payload)
      );
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      await this.showFeedback(`Response: ${resultStr}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.showFeedback(`Error: ${errMsg}`);
    }

    await this.setWidgetDisabled(this.msgSendBtnId, false);
  }

  // ── Type parsing / formatting ────────────────────────────────────

  /** Parse a raw string value into the appropriate JS type based on the TypeDeclaration. */
  private parseParamValue(raw: string, type?: TypeDeclaration): { value?: unknown; error?: string } {
    if (!type) {
      // No type info — try JSON, fall back to string
      try { return { value: JSON.parse(raw) }; }
      catch { return { value: raw }; }
    }

    if (type.kind === 'primitive') {
      switch (type.primitive) {
        case 'string':
          return { value: raw };
        case 'number': {
          const n = Number(raw);
          if (isNaN(n)) return { error: `"${raw}" is not a valid number` };
          return { value: n };
        }
        case 'boolean': {
          const lower = raw.toLowerCase();
          if (lower === 'true') return { value: true };
          if (lower === 'false') return { value: false };
          return { error: `"${raw}" is not a boolean (use true/false)` };
        }
        case 'null':
          return { value: null };
        default:
          return { value: raw };
      }
    }

    // object, array, union, reference — parse as JSON
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return { error: 'invalid JSON' };
    }
  }

  private formatType(t: unknown): string {
    if (!t || typeof t !== 'object') return 'any';
    const obj = t as Record<string, unknown>;
    if (obj.kind === 'primitive') return obj.primitive as string;
    if (obj.kind === 'array') return `${this.formatType(obj.elementType)}[]`;
    if (obj.kind === 'reference') return obj.reference as string;
    if (obj.kind === 'object') return 'object';
    return 'any';
  }
}
