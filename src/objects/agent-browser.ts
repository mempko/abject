/**
 * AgentBrowser -- UI for browsing registered agents and event watchers.
 *
 * Two-tab layout:
 *   Tab 0 (Agents):    Live list of all registered agents with status
 *   Tab 1 (Watchers):  Discovers watcher-tagged objects, shows their watches
 *
 * Subscribes to AgentAbject and Registry for real-time updates.
 * Schedules are managed by the separate SchedulerBrowser.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('AgentBrowser');

const AGENT_BROWSER_INTERFACE: InterfaceId = 'abjects:agent-browser';

const WIN_W = 620;
const WIN_H = 420;

const TAB_LABELS = ['Agents', 'Watchers'];

const AGENT_STATUS_ICONS: Record<string, string> = {
  idle: '\u25CB',     // ○
  busy: '\u25B8',     // ▸
};

interface AgentInfo {
  agentId: string;
  name: string;
  description: string;
  status: string;
  activeTasks: number;
}

interface WatchInfo {
  watcherName: string;
  watcherId: string;
  id: string;
  targetName: string;
  aspectFilter?: string;
  taskDescription: string;
  enabled: boolean;
  triggerCount: number;
}

export class AgentBrowser extends Abject {
  private agentAbjectId?: AbjectId;
  private registryId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private abjectEditorId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private listWidgetId?: AbjectId;
  private detailLayoutId?: AbjectId;
  private detailTitleId?: AbjectId;
  private detailDescId?: AbjectId;
  private detailMetaId?: AbjectId;
  private editBtnId?: AbjectId;
  private toggleBtnId?: AbjectId;
  private deleteBtnId?: AbjectId;

  private activeTab = 0;
  private agents: AgentInfo[] = [];
  private watches: WatchInfo[] = [];
  private selectedIndex = -1;

  constructor() {
    super({
      manifest: {
        name: 'AgentBrowser',
        description:
          'Browse registered agents and event watchers. Shows real-time updates for agent status and event watch triggers.',
        version: '1.0.0',
        interface: {
          id: AGENT_BROWSER_INTERFACE,
          name: 'AgentBrowser',
          description: 'Agent, schedule, and watcher browser UI',
          methods: [
            {
              name: 'show',
              description: 'Show the agent browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the agent browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return current state of the agent browser',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
                agentCount: { kind: 'primitive', primitive: 'number' },
                watchCount: { kind: 'primitive', primitive: 'number' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display agent browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.agentAbjectId = await this.discoverDep('AgentAbject') ?? undefined;
    this.registryId = await this.discoverDep('Registry') ?? undefined;
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      agentCount: this.agents.length,
      watchCount: this.watches.length,
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AgentBrowser Usage Guide

### Methods
- \`show()\` -- Open the agent browser window. If already open, raises it to front.
- \`hide()\` -- Close the agent browser window.
- \`getState()\` -- Returns { visible, agentCount, watchCount }.

### Three-Tab View
- **Agents**: Lists all registered agents with live status (idle/busy), active task count.
- **Schedules**: Discovers scheduler-tagged objects and shows their schedule entries.
- **Watchers**: Discovers watcher-tagged objects and shows their event watch entries.

### Real-Time Updates
AgentBrowser subscribes to AgentAbject for agent registration/status changes
and to Registry for new scheduler/watcher objects being created.

### Interface ID
\`abjects:agent-browser\``;
  }

  // -- Window lifecycle --

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
        title: '\uD83E\uDD16 Agents',
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

    // Tab bar
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

    // Split: list (left) | detail (right)
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'splitPane',
          windowId: this.windowId,
          orientation: 'horizontal',
          dividerPosition: 0.45,
          minSize: 180,
        }],
      })
    );

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: splitId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Left pane: list
    const leftLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 4,
      })
    );

    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], searchable: false, itemHeight: 28 }],
      })
    );
    this.listWidgetId = listId;

    await this.request(request(this.id, leftLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Right pane: outer VBox with scrollable detail area + buttons at bottom
    const rightOuterId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    // Scrollable detail area (expanding)
    this.detailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 4, left: 12 },
        spacing: 6,
      })
    );

    // Detail labels
    const { widgetIds: detailIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // 0: title
          { type: 'label', windowId: this.windowId, text: 'Select an item',
            style: { fontSize: 14, fontWeight: 'bold', color: this.theme.textHeading, wordWrap: true } },
          // 1: description
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true } },
          // 2: metadata
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textSecondary, wordWrap: true } },
        ],
      })
    );
    this.detailTitleId = detailIds[0];
    this.detailDescId = detailIds[1];
    this.detailMetaId = detailIds[2];

    await this.request(request(this.id, this.detailLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.detailTitleId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 24 } },
        { widgetId: this.detailDescId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.detailMetaId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 40 } },
      ],
    }));

    // Add scrollable detail as expanding child
    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: this.detailLayoutId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Action buttons row (fixed at bottom)
    const btnRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 12, bottom: 8, left: 12 },
        spacing: 8,
      })
    );

    const { widgetIds: btnIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Edit' },
          { type: 'button', windowId: this.windowId, text: 'Toggle' },
          { type: 'button', windowId: this.windowId, text: 'Delete' },
        ],
      })
    );
    this.editBtnId = btnIds[0];
    this.toggleBtnId = btnIds[1];
    this.deleteBtnId = btnIds[2];

    await this.request(request(this.id, btnRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.editBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 70, height: 30 } },
        { widgetId: this.toggleBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
        { widgetId: this.deleteBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 70, height: 30 } },
      ],
    }));

    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: btnRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Assign panes to split
    await this.request(request(this.id, splitId, 'setLeftChild', { widgetId: leftLayoutId }));
    await this.request(request(this.id, splitId, 'setRightChild', { widgetId: rightOuterId }));

    // Subscribe to events
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.editBtnId, 'addDependent', {}));
    this.send(request(this.id, this.toggleBtnId, 'addDependent', {}));
    this.send(request(this.id, this.deleteBtnId!, 'addDependent', {}));

    if (this.agentAbjectId) {
      this.send(request(this.id, this.agentAbjectId, 'addDependent', {}));
    }
    if (this.registryId) {
      this.send(request(this.id, this.registryId, 'addDependent', {}));
    }

    // Populate
    await this.loadTabData();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.agentAbjectId) {
      this.send(request(this.id, this.agentAbjectId, 'removeDependent', {}));
    }
    if (this.registryId) {
      this.send(request(this.id, this.registryId, 'removeDependent', {}));
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.listWidgetId = undefined;
    this.detailLayoutId = undefined;
    this.detailTitleId = undefined;
    this.detailDescId = undefined;
    this.detailMetaId = undefined;
    this.editBtnId = undefined;
    this.toggleBtnId = undefined;
    this.deleteBtnId = undefined;
    this.agents = [];
    this.watches = [];
    this.selectedIndex = -1;
    this.changed('visibility', false);
    return true;
  }

  // -- Data loading --

  private async loadTabData(): Promise<void> {
    this.selectedIndex = -1;
    switch (this.activeTab) {
      case 0: await this.loadAgents(); break;
      case 1: await this.loadWatches(); break;
    }
    await this.rebuildList();
    await this.clearDetail();
  }

  private async loadAgents(): Promise<void> {
    if (!this.agentAbjectId) { this.agents = []; return; }
    try {
      this.agents = await this.request<AgentInfo[]>(
        request(this.id, this.agentAbjectId, 'listAgents', {})
      );
    } catch (err) {
      log.warn('Failed to load agents:', err);
      this.agents = [];
    }
  }

  private async loadWatches(): Promise<void> {
    if (!this.registryId) { this.watches = []; return; }
    this.watches = [];
    try {
      const watchers = await this.request<ObjectRegistration[]>(
        request(this.id, this.registryId, 'discover', { tags: ['watcher'] })
      );
      for (const w of watchers) {
        try {
          const state = await this.request<{ watches?: Array<{
            id: string; targetName: string; aspectFilter?: string;
            taskDescription: string; enabled: boolean; triggerCount: number;
          }> }>(
            request(this.id, w.id, 'getState', {}),
            5000,
          );
          if (state.watches) {
            for (const watch of state.watches) {
              this.watches.push({
                watcherName: w.name,
                watcherId: w.id as string,
                ...watch,
              });
            }
          }
        } catch { /* object may not respond */ }
      }
    } catch (err) {
      log.warn('Failed to load watches:', err);
    }
  }

  // -- List rendering --

  private buildListItems(): ListItem[] {
    switch (this.activeTab) {
      case 0:
        return this.agents.map(a => {
          const icon = AGENT_STATUS_ICONS[a.status] ?? '\u2022';
          const tasks = a.activeTasks > 0 ? ` (${a.activeTasks} active)` : '';
          return { label: `${icon} ${a.name}${tasks}`, value: a.agentId };
        });
      case 1:
        return this.watches.map((w, i) => {
          const icon = w.enabled ? '\u25C9' : '\u25CB';  // ◉ or ○
          const filter = w.aspectFilter ? ` [${w.aspectFilter}]` : '';
          return { label: `${icon} ${w.targetName}${filter}`, value: String(i), secondary: `${w.triggerCount} fires` };
        });
      default:
        return [];
    }
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    const items = this.buildListItems();
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    } catch { /* widget may be gone */ }
  }

  // -- Detail pane --

  private async clearDetail(): Promise<void> {
    await this.updateDetail('Select an item', '', '');
  }

  private async updateDetail(title: string, desc: string, meta: string): Promise<void> {
    if (!this.detailTitleId) return;
    try {
      await Promise.all([
        this.request(request(this.id, this.detailTitleId, 'update', { text: title })),
        this.request(request(this.id, this.detailDescId!, 'update', { text: desc })),
        this.request(request(this.id, this.detailMetaId!, 'update', { text: meta })),
      ]);
    } catch { /* widgets may be gone */ }
  }

  private async showDetailForSelection(): Promise<void> {
    switch (this.activeTab) {
      case 0: {
        const agent = this.agents[this.selectedIndex];
        if (!agent) { await this.clearDetail(); return; }
        const desc = agent.description;
        const meta = `Status: ${agent.status} | Active tasks: ${agent.activeTasks} | ID: ${agent.agentId.slice(0, 12)}...`;
        await this.updateDetail(agent.name, desc, meta);
        break;
      }
      case 1: {
        const watch = this.watches[this.selectedIndex];
        if (!watch) { await this.clearDetail(); return; }
        const desc = `**Task:** ${watch.taskDescription}\n\n**Target:** ${watch.targetName}\n**Filter:** ${watch.aspectFilter || 'All events'}\n**Enabled:** ${watch.enabled ? 'Yes' : 'No'}`;
        const meta = `Watcher: ${watch.watcherName} | Triggered: ${watch.triggerCount} times`;
        await this.updateDetail(`Watch: ${watch.targetName}`, desc, meta);
        break;
      }
    }
  }

  // -- Event handling --

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Tab bar change
    if (fromId === this.tabBarId && aspect === 'tabSelected') {
      const data = value as { index: number } | undefined;
      if (data && typeof data.index === 'number') {
        this.activeTab = data.index;
        await this.loadTabData();
      }
      return;
    }

    // List selection
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      try {
        const data = JSON.parse(value as string) as { index: number; value: string; label: string };
        this.selectedIndex = data.index;
      } catch {
        this.selectedIndex = -1;
      }
      await this.showDetailForSelection();
      return;
    }

    // Edit button
    if (fromId === this.editBtnId && aspect === 'click') {
      await this.handleEdit();
      return;
    }

    // Toggle button
    if (fromId === this.toggleBtnId && aspect === 'click') {
      await this.handleToggle();
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      await this.handleDelete();
      return;
    }

    // AgentAbject events -- refresh agents tab
    if (fromId === this.agentAbjectId) {
      if (aspect === 'agentRegistered' || aspect === 'agentUnregistered' || aspect === 'taskPhaseChanged') {
        if (this.activeTab === 0) {
          await this.loadAgents();
          await this.rebuildList();
          if (this.selectedIndex >= 0) await this.showDetailForSelection();
        }
      }
      return;
    }

    // Registry events -- refresh schedules/watchers if objects changed
    if (fromId === this.registryId) {
      if (aspect === 'objectRegistered' || aspect === 'objectUnregistered') {
        if (this.activeTab === 1) {
          await this.loadTabData();
        }
      }
      return;
    }
  }

  private async handleEdit(): Promise<void> {
    if (this.selectedIndex < 0) return;

    let objectId: string | undefined;
    switch (this.activeTab) {
      case 0: objectId = this.agents[this.selectedIndex]?.agentId; break;
      case 1: objectId = this.watches[this.selectedIndex]?.watcherId; break;
    }
    if (!objectId) return;

    // Try to open in AbjectEditor
    if (!this.abjectEditorId) {
      this.abjectEditorId = await this.discoverDep('AbjectEditor') ?? undefined;
    }
    if (this.abjectEditorId) {
      try {
        await this.request(
          request(this.id, this.abjectEditorId, 'editObject', { objectId }),
          10000,
        );
      } catch {
        log.warn('Failed to open AbjectEditor for', objectId);
      }
    }
  }

  private async handleToggle(): Promise<void> {
    if (this.selectedIndex < 0) return;

    switch (this.activeTab) {
      case 1: {
        const watch = this.watches[this.selectedIndex];
        if (!watch) return;
        const method = watch.enabled ? 'disableWatch' : 'enableWatch';
        if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: true }));
        try {
          await this.request(
            request(this.id, watch.watcherId as AbjectId, method, { watchId: watch.id }),
            5000,
          );
          watch.enabled = !watch.enabled;
          await this.rebuildList();
          await this.showDetailForSelection();
          await this.notify(`Watch ${watch.enabled ? 'enabled' : 'disabled'}`, 'success');
        } catch (err) {
          log.warn('Failed to toggle watch:', err);
          await this.notify('Toggle failed', 'error');
        } finally {
          if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: false }));
        }
        break;
      }
    }
  }

  private async handleDelete(): Promise<void> {
    if (this.activeTab !== 0 || this.selectedIndex < 0) return;
    const agent = this.agents[this.selectedIndex];
    if (!agent) return;

    // Check if agent is user-created by looking for the 'scriptable' tag
    if (!this.registryId) return;
    let isUserCreated = false;
    try {
      const reg = await this.request<{ manifest?: { tags?: string[] } } | null>(
        request(this.id, this.registryId, 'lookup', { objectId: agent.agentId }),
        5000,
      );
      isUserCreated = reg?.manifest?.tags?.includes('scriptable') ?? false;
    } catch { /* best effort */ }

    if (!isUserCreated) {
      log.info(`Cannot delete system agent "${agent.name}"`);
      return;
    }

    const confirmed = await this.confirm({
      title: 'Delete Agent',
      message: `Delete agent "${agent.name}" and its backing object? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      // 1. Unregister from AgentAbject
      if (this.agentAbjectId) {
        await this.request(
          request(agent.agentId as AbjectId, this.agentAbjectId, 'unregisterAgent', {}),
          5000,
        );
      }

      // 2. Remove snapshot from AbjectStore
      const abjectStoreId = await this.discoverDep('AbjectStore');
      if (abjectStoreId) {
        await this.request(
          request(this.id, abjectStoreId, 'remove', { objectId: agent.agentId }),
          5000,
        );
      }

      // 3. Kill the object via Factory
      const factoryId = await this.discoverDep('Factory');
      if (factoryId) {
        await this.request(
          request(this.id, factoryId, 'kill', { objectId: agent.agentId }),
          5000,
        );
      }

      this.selectedIndex = -1;
      await this.loadAgents();
      await this.rebuildList();
      await this.updateDetail('Select an item', '', '');
      await this.notify(`Agent "${agent.name}" deleted`, 'success');
    } catch (err) {
      log.warn('Failed to delete agent:', err);
      const msg = err instanceof Error ? err.message : String(err);
      await this.notify(`Delete failed: ${msg.slice(0, 80)}`, 'error');
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}

export const AGENT_BROWSER_ID = 'abjects:agent-browser' as AbjectId;
