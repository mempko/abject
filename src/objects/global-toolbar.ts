/**
 * GlobalToolbar -- the System section of the sidebar dock.
 *
 * Owns no window: WorkspaceManager hands it the sidebar dock window and a
 * section layout (`show({ windowId, sectionLayoutId })`), and it builds its
 * rows there. Provides quick-access rows for GlobalSettings (API Keys) and
 * PeerNetwork (identity, signaling, contacts), plus a row for every global
 * abject that asks for one: tagged `launcher`, with `show` and `hide` methods
 * (a system-scope package with a window, say). Tag it `system` as well to keep
 * it out of the per-workspace Abjects list.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { event, request } from '../core/message.js';
import type { ThemeData } from '../core/theme-data.js';
import { Log } from '../core/timed-log.js';
import { ActivityLatch, dockStyles, type DockLauncher } from './dock-style.js';

const log = new Log('GlobalToolbar');

const GLOBAL_TOOLBAR_INTERFACE: InterfaceId = 'abjects:global-toolbar';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const PEER_NETWORK_INTERFACE: InterfaceId = 'abjects:peer-network';

/**
 * The registrations that get a System row: local abjects tagged `launcher`
 * that can `show` and `hide`, by name, with a plain icon when they have none.
 */
export function launchersFrom(all: ObjectRegistration[]): Array<{ id: AbjectId; name: string; icon: string }> {
  return all
    .filter(o => !o.ownerPeerId && (o.manifest.tags ?? []).includes('launcher'))
    .filter(o => {
      const names = (o.manifest.interface?.methods ?? []).map(m => m.name);
      return names.includes('show') && names.includes('hide');
    })
    .map(o => ({ id: o.id, name: o.manifest.name, icon: o.manifest.icon?.trim() || '\u25A3' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class GlobalToolbar extends Abject {
  private widgetManagerId?: AbjectId;
  private globalSettingsId?: AbjectId;
  private peerNetworkId?: AbjectId;
  private objectBrowserId?: AbjectId;

  private objectManagerId?: AbjectId;
  private llmMonitorId?: AbjectId;

  /** Sidebar dock window + this rail's section layout (pushed via show()). */
  private windowId?: AbjectId;
  private sectionLayoutId?: AbjectId;
  /** Single-flight guard for show()'s clear+rebuild (prevents duplicate rows). */
  private buildingUI = false;
  /** True when WorkspaceManager pushed a theme into the pending show(). */
  private pushedTheme = false;
  /** Accordion state: collapsed sections show only their header row. */
  private collapsed = false;
  /** Horizontal dock collapse (pushed via show()): render icon-only rows. */
  private compact = false;
  private headerBtnId?: AbjectId;
  private settingsBtnId?: AbjectId;
  private networkBtnId?: AbjectId;
  private explorerBtnId?: AbjectId;
  private processesBtnId?: AbjectId;
  private llmMonitorBtnId?: AbjectId;
  private notificationsBtnId?: AbjectId;
  /** Launcher rows: button widget → the abject it shows. */
  private launcherBtns = new Map<AbjectId, AbjectId>();
  /** The launchers the section was last built with (id:name:icon), to rebuild only on change. */
  private launcherSignature = '';
  private launcherRecheck?: ReturnType<typeof setTimeout>;
  private registryId?: AbjectId;

  // Cached lookup for the active workspace's NotificationCenter. Refreshed
  // on every click in case the workspace switched.
  private workspaceManagerId?: AbjectId;

  /** The LLM object, whose call lifecycle lights The Eye's row. */
  private llmId?: AbjectId;
  /** Model calls in flight (ids from requestStarted, cleared on completed/error). */
  private activeCalls = new Set<string>();
  /** While lit, a slow check that drops calls whose end we never heard. */
  private reconcileTimer?: ReturnType<typeof setInterval>;
  /**
   * The Eye's light: on while any model call is in flight. The off side is
   * debounced, so an agent's back-to-back calls read as one steady light.
   */
  private eyeLight = new ActivityLatch(
    (busy) => this.onEyeLight(busy),
    { set: (fn, ms) => this.setTimer(fn, ms), cancel: (h) => this.cancelTimer(h) },
  );

  constructor() {
    super({
      manifest: {
        name: 'GlobalToolbar',
        description:
          'Persistent toolbar panel with quick-access buttons for system settings and peer network.',
        version: '1.0.0',
        interface: {
            id: GLOBAL_TOOLBAR_INTERFACE,
            name: 'GlobalToolbar',
            description: 'System toolbar UI',
            methods: [
              {
                name: 'show',
                description: 'Populate the System section of the sidebar dock',
                parameters: [
                  {
                    name: 'windowId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Sidebar dock window to build widgets into',
                  },
                  {
                    name: 'sectionLayoutId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Section layout to add rows to',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Clear the System section',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GlobalToolbar Usage Guide

### Overview
Provider of the System section of the sidebar dock. Builds quick-access rows
for system-wide panels: GlobalSettings (API keys), PeerNetwork (identity and
contacts), ObjectBrowser (Explorer), ProcessExplorer (running processes), and
LLMMonitor (The Eye).

### Methods
- \`show({ windowId, sectionLayoutId, theme? })\` -- Rebuild the section rows
  inside the given sidebar window/section layout. IDs are cached, so a bare
  \`show()\` rebuilds in place.
- \`hide()\` -- Clear the section.

### Behavior
- Each button lazily discovers its target object on first click.
- Clicking a row sends \`show\` to the corresponding system panel.
- Clicking the section header toggles the section collapsed (header only).

### Interface ID
\`abjects:global-toolbar\``;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    await this.watchModelCalls();
    // Launchers come and go with the global registry (packages spawn after us).
    this.registryId = await this.discoverDep('Registry') ?? undefined;
    if (this.registryId) {
      try { await this.request(request(this.id, this.registryId, 'subscribe', {})); } catch { /* rows still load on show */ }
    }
  }

  /** Global abjects asking for a System row: tagged `launcher`, with show and hide. */
  private async listLaunchers(): Promise<Array<{ id: AbjectId; name: string; icon: string }>> {
    if (!this.registryId) this.registryId = await this.discoverDep('Registry') ?? undefined;
    if (!this.registryId) return [];
    let all: ObjectRegistration[] = [];
    try {
      all = await this.request<ObjectRegistration[]>(request(this.id, this.registryId, 'list', {}));
    } catch { return []; }
    return launchersFrom(all);
  }

  /** A registry change may have added or removed a launcher: rebuild if the set changed. */
  private scheduleLauncherRecheck(): void {
    if (this.launcherRecheck) clearTimeout(this.launcherRecheck);
    this.launcherRecheck = setTimeout(() => {
      this.launcherRecheck = undefined;
      void (async () => {
        if (!this.windowId || this.collapsed) return;
        const sig = (await this.listLaunchers()).map(l => `${l.id}:${l.name}:${l.icon}`).join('|');
        if (sig === this.launcherSignature) return;
        if (this.buildingUI) { this.scheduleLauncherRecheck(); return; }
        await this.show();
      })().catch(() => { /* best effort */ });
    }, 400);
  }

  /**
   * Subscribe to the LLM object's call lifecycle (requestStarted /
   * requestCompleted / requestError) and seed the in-flight set from its
   * ledger, so The Eye's row lights while a model call is running. Retried
   * from show() when the LLM object registered after us.
   */
  private async watchModelCalls(): Promise<void> {
    if (this.llmId) return;
    const id = await this.discoverDep('LLM') ?? undefined;
    if (!id) return;
    this.llmId = id;
    this.send(request(this.id, id, 'addDependent', {}));
    await this.reconcileCalls();
  }

  /** Replace the in-flight set with the LLM ledger's active calls. */
  private async reconcileCalls(): Promise<void> {
    if (!this.llmId) return;
    try {
      const res = await this.request<{ entries?: Array<{ id?: string }> }>(
        request(this.id, this.llmId, 'getLedger', { status: 'active', limit: 500 }), 5000,
      );
      this.activeCalls = new Set((res?.entries ?? []).map((e) => e?.id).filter((x): x is string => typeof x === 'string'));
    } catch { return; /* LLM busy or gone: the next lifecycle event catches us up */ }
    this.eyeLight.set(this.activeCalls.size > 0);
  }

  private onEyeLight(busy: boolean): void {
    this.setRowBusy(this.llmMonitorBtnId, busy);
    this.cancelTimer(this.reconcileTimer);
    this.reconcileTimer = busy ? this.setRecurringTimer(() => this.reconcileCalls(), 30_000) : undefined;
  }

  /** Turn a dock row's busy light on or off (one event; the row repaints once). */
  private setRowBusy(btnId: AbjectId | undefined, busy: boolean): void {
    if (!btnId) return;
    try {
      this.send(event(this.id, btnId, 'update', { busy }));
    } catch { /* widget gone */ }
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const { theme, windowId, sectionLayoutId, compact } = msg.payload as {
        theme?: ThemeData; windowId?: AbjectId; sectionLayoutId?: AbjectId; compact?: boolean;
      } ?? {};
      // WorkspaceManager pushes the active workspace's theme on switch/startup.
      if (theme && typeof theme === 'object' && 'canvasBg' in theme) {
        this.theme = theme;
        this.pushedTheme = true;
      }
      // WorkspaceManager pushes fresh sidebar section IDs after each sidebar
      // rebuild; a bare show() rebuilds into the cached section.
      if (windowId && sectionLayoutId) {
        this.windowId = windowId;
        this.sectionLayoutId = sectionLayoutId;
        this.compact = compact ?? false;
      }
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    // The global registry announces spawns, exits and manifest swaps.
    this.on('objectRegistered', async () => this.scheduleLauncherRecheck());
    this.on('objectUnregistered', async () => this.scheduleLauncherRecheck());
    this.on('manifestUpdated', async () => this.scheduleLauncherRecheck());

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (msg.routing.from === this.llmId
        && (aspect === 'requestStarted' || aspect === 'requestCompleted' || aspect === 'requestError')) {
        const callId = (value as { id?: string } | undefined)?.id;
        if (callId) {
          if (aspect === 'requestStarted') this.activeCalls.add(callId);
          else this.activeCalls.delete(callId);
        }
        this.eyeLight.set(this.activeCalls.size > 0);
        return;
      }
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      // A package's launcher row
      const launcherTarget = this.launcherBtns.get(fromId);
      if (launcherTarget) {
        this.send(request(this.id, launcherTarget, 'show', {}));
        return;
      }

      // Section header — accordion toggle
      if (fromId === this.headerBtnId) {
        this.collapsed = !this.collapsed;
        await this.show();
        return;
      }

      // Settings button
      if (fromId === this.settingsBtnId) {
        if (!this.globalSettingsId) {
          this.globalSettingsId = await this.discoverDep('GlobalSettings') ?? undefined;
        }
        if (this.globalSettingsId) {
          this.send(request(this.id, this.globalSettingsId, 'show', {}));
        }
        return;
      }

      // Network button
      if (fromId === this.networkBtnId) {
        if (!this.peerNetworkId) {
          this.peerNetworkId = await this.discoverDep('PeerNetwork') ?? undefined;
        }
        if (this.peerNetworkId) {
          this.send(request(this.id, this.peerNetworkId, 'show', {}));
        }
        return;
      }

      // Explorer button
      if (fromId === this.explorerBtnId) {
        if (!this.objectBrowserId) {
          this.objectBrowserId = await this.discoverDep('ObjectBrowser') ?? undefined;
        }
        if (this.objectBrowserId) {
          this.send(request(this.id, this.objectBrowserId, 'show', {}));
        }
        return;
      }

      // Processes button
      if (fromId === this.processesBtnId) {
        if (!this.objectManagerId) {
          this.objectManagerId = await this.discoverDep('ProcessExplorer') ?? undefined;
        }
        if (this.objectManagerId) {
          this.send(request(this.id, this.objectManagerId, 'show', {}));
        }
        return;
      }

      // LLM Monitor button
      if (fromId === this.llmMonitorBtnId) {
        if (!this.llmMonitorId) {
          this.llmMonitorId = await this.discoverDep('LLMMonitor') ?? undefined;
        }
        if (this.llmMonitorId) {
          this.send(request(this.id, this.llmMonitorId, 'show', {}));
        }
        return;
      }

      // Notifications bell — opens the active workspace's NotificationCenter.
      // NotificationCenter is per-workspace, so we resolve through
      // WorkspaceManager every click (cheap; lets workspace switching work).
      if (fromId === this.notificationsBtnId) {
        const ncId = await this.resolveActiveNotificationCenter();
        if (ncId) {
          this.send(request(this.id, ncId, 'toggle', {}));
        }
        return;
      }
    });
  }

  /**
   * Resolve the NotificationCenter belonging to the currently active
   * workspace via WorkspaceManager. Returns undefined if no workspace is
   * active or the registry can't be reached.
   */
  private async resolveActiveNotificationCenter(): Promise<AbjectId | undefined> {
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
      if (!this.workspaceManagerId) return undefined;
    }
    let active: { registryId?: AbjectId } | null = null;
    try {
      active = await this.request<{ registryId?: AbjectId } | null>(
        request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {}),
      );
    } catch { return undefined; }
    if (!active?.registryId) return undefined;
    try {
      const found = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, active.registryId, 'discover', { name: 'NotificationCenter' }),
      );
      return found?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Pull the active workspace's theme from WidgetManager before (re)building.
   * `discoverDep('Theme')` can't be trusted here (it returns the first registered
   * Theme, not the active workspace's), so the toolbar would otherwise rebuild
   * with a stale palette on startup and workspace switch.
   */
  private async refreshActiveTheme(): Promise<void> {
    if (!this.widgetManagerId) return;
    try {
      const theme = await this.request<ThemeData>(
        request(this.id, this.widgetManagerId, 'getActiveTheme', {})
      );
      if (theme && typeof theme === 'object' && 'canvasBg' in theme) {
        this.theme = theme;
      }
    } catch {
      // Keep the cached theme if WidgetManager isn't ready.
    }
  }

  async show(): Promise<boolean> {
    // Single-flight: a second show() racing in during a workspace switch would
    // clear+repopulate the section concurrently and leave duplicate rows.
    if (this.buildingUI) return true;
    if (!this.windowId || !this.sectionLayoutId) return false;
    this.buildingUI = true;
    try {
    // If WorkspaceManager already pushed the active theme into this show(), use
    // it; otherwise pull it ourselves (e.g. a self-initiated re-show).
    if (this.pushedTheme) {
      this.pushedTheme = false;
    } else {
      await this.refreshActiveTheme();
    }

    // Rebuild in place: clear the section, then repopulate.
    await this.request(request(this.id, this.sectionLayoutId, 'clearLayoutChildren', {}));
    this.headerBtnId = undefined;
    this.settingsBtnId = undefined;
    this.networkBtnId = undefined;
    this.explorerBtnId = undefined;
    this.processesBtnId = undefined;
    this.llmMonitorBtnId = undefined;
    this.notificationsBtnId = undefined;
    this.launcherBtns.clear();
    const launchers = this.collapsed ? [] : await this.listLaunchers();
    this.launcherSignature = launchers.map(l => `${l.id}:${l.name}:${l.icon}`).join('|');

    const btnW = 120;
    const btnH = 30;
    const labelH = 20;

    // Header row: collapse-toggle header button + gear (settings) button
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.sectionLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.sectionLayoutId, 'updateLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: labelH },
    }));

    // "Grimoire index" styling: flat, borderless, left-aligned rows (matches
    // the Abjects rail) rather than boxed pills. Constructivist themes get the
    // red header block and geometric launcher glyphs (see dock-style.ts).
    const compact = this.compact;
    const dock = dockStyles(this.theme, compact);
    const gearStyle = dock.gear;
    const headerStyle = dock.header;
    const row = (key: DockLauncher, label: string) => dock.rowText(key, label);
    // Compact rows are icon-only, so the label moves into a hover tooltip.
    const rowStyle = (label: string, key?: DockLauncher) => dock.rowStyle(label, key);

    // Batch create all widgets: header button, gear button, action buttons.
    // Compact mode drops the gear from the header (no horizontal room).
    const specs: Array<Record<string, unknown>> = [
      { type: 'button', windowId: this.windowId, text: compact ? '\u2699' : dock.headerText('System', this.collapsed), style: compact ? { ...headerStyle, tooltip: 'System' } : headerStyle },
    ];
    if (!compact) {
      specs.push({ type: 'button', windowId: this.windowId, text: '', style: gearStyle });
    }
    const rowStartIdx = specs.length;
    if (!this.collapsed) {
      specs.push(
        { type: 'button', windowId: this.windowId, text: row('network', 'Network'), style: rowStyle('Network', 'network') },
        { type: 'button', windowId: this.windowId, text: row('explorer', 'Explorer'), style: rowStyle('Explorer', 'explorer') },
        { type: 'button', windowId: this.windowId, text: row('procs', 'Procs'), style: rowStyle('Procs', 'procs') },
        { type: 'button', windowId: this.windowId, text: row('eye', 'The Eye'), style: rowStyle('The Eye', 'eye') },
        { type: 'button', windowId: this.windowId, text: row('notifications', 'Notifications'), style: rowStyle('Notifications', 'notifications') },
      );
      for (const l of launchers) {
        specs.push({ type: 'button', windowId: this.windowId, text: compact ? l.icon : `${l.icon}  ${l.name}`, style: compact ? { ...rowStyle(l.name), tooltip: l.name } : rowStyle(l.name) });
      }
    }
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    this.headerBtnId = widgetIds[0];
    this.settingsBtnId = compact ? undefined : widgetIds[1];

    // Add header row children: header toggle (+ gear when expanded)
    const headerChildren: Array<Record<string, unknown>> = [
      { widgetId: this.headerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: labelH } },
    ];
    if (this.settingsBtnId) {
      headerChildren.push({ widgetId: this.settingsBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } });
    }
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', { children: headerChildren }));

    if (!this.collapsed) {
      this.networkBtnId = widgetIds[rowStartIdx];
      this.explorerBtnId = widgetIds[rowStartIdx + 1];
      this.processesBtnId = widgetIds[rowStartIdx + 2];
      this.llmMonitorBtnId = widgetIds[rowStartIdx + 3];
      this.notificationsBtnId = widgetIds[rowStartIdx + 4];

      await this.request(request(this.id, this.sectionLayoutId, 'addLayoutChildren', {
        children: [
          { widgetId: this.networkBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
          { widgetId: this.explorerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
          { widgetId: this.processesBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
          { widgetId: this.llmMonitorBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
          { widgetId: this.notificationsBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
          ...launchers.map((_, i) => ({ widgetId: widgetIds[rowStartIdx + 5 + i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } })),
        ],
      }));
      launchers.forEach((l, i) => this.launcherBtns.set(widgetIds[rowStartIdx + 5 + i], l.id));
    }

    // Fire-and-forget: register as dependent for all buttons
    for (const btnId of widgetIds) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }

    // Fresh rows are born idle: light The Eye if a model call is running.
    if (!this.llmId) void this.watchModelCalls();
    if (this.eyeLight.busy) this.setRowBusy(this.llmMonitorBtnId, true);

    return true;
    } finally {
      this.buildingUI = false;
    }
  }

  async hide(): Promise<boolean> {
    if (this.sectionLayoutId) {
      // Best-effort: the sidebar may already have destroyed the section.
      try {
        await this.request(request(this.id, this.sectionLayoutId, 'clearLayoutChildren', {}));
      } catch { /* section gone */ }
    }
    this.windowId = undefined;
    this.sectionLayoutId = undefined;
    this.headerBtnId = undefined;
    this.settingsBtnId = undefined;
    this.networkBtnId = undefined;
    this.explorerBtnId = undefined;
    this.processesBtnId = undefined;
    this.llmMonitorBtnId = undefined;
    this.notificationsBtnId = undefined;
    return true;
  }
}

export const GLOBAL_TOOLBAR_ID = 'abjects:global-toolbar' as AbjectId;
