/**
 * GlobalToolbar -- persistent chromeless panel positioned below WorkspaceSwitcher.
 *
 * Provides quick-access buttons for GlobalSettings (API Keys) and
 * PeerNetwork (identity, signaling, contacts).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { ThemeData } from '../core/theme-data.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { lightenColor } from './widgets/widget-types.js';

const log = new Log('GlobalToolbar');

const GLOBAL_TOOLBAR_INTERFACE: InterfaceId = 'abjects:global-toolbar';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const PEER_NETWORK_INTERFACE: InterfaceId = 'abjects:peer-network';

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

  // Cached lookup for the active workspace's NotificationCenter. Refreshed
  // on every click in case the workspace switched.
  private workspaceManagerId?: AbjectId;

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
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display toolbar', required: true },
        ],
        providedCapabilities: [],
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

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

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
    // the Abjects rail) rather than boxed pills.
    const compact = this.compact;
    const ghostBg = lightenColor(this.theme.windowBg, 5);
    const appStyle = {
      background: ghostBg, flat: true,
      color: this.theme.textPrimary, radius: this.theme.tokens.radius.sm,
      align: compact ? 'center' : 'left', fontSize: compact ? 14 : 12,
    };
    const gearStyle = { background: ghostBg, flat: true, color: this.theme.textSecondary, radius: this.theme.tokens.radius.sm, fontSize: 13 };
    const headerStyle = { background: this.theme.windowBg, flat: true, color: this.theme.accent, fontSize: 12, fontWeight: 'bold', fontFamily: 'display', align: compact ? 'center' : 'left' };
    const chevron = this.collapsed ? '\u25B8' : '\u25BE';
    const row = (icon: string, label: string) => (compact ? icon : `${icon} ${label}`);
    // Compact rows are icon-only, so the label moves into a hover tooltip.
    const rowStyle = (label: string) => (compact ? { ...appStyle, tooltip: label } : appStyle);

    // Batch create all widgets: header button, gear button, action buttons.
    // Compact mode drops the gear from the header (no horizontal room).
    const specs: Array<Record<string, unknown>> = [
      { type: 'button', windowId: this.windowId, text: compact ? '\u2699' : `${chevron} \u2699 System`, style: compact ? { ...headerStyle, tooltip: 'System' } : headerStyle },
    ];
    if (!compact) {
      specs.push({ type: 'button', windowId: this.windowId, text: '\u2699', style: gearStyle });
    }
    const rowStartIdx = specs.length;
    if (!this.collapsed) {
      specs.push(
        { type: 'button', windowId: this.windowId, text: row('\uD83C\uDF10', 'Network'), style: rowStyle('Network') },
        { type: 'button', windowId: this.windowId, text: row('\uD83D\uDD0D', 'Explorer'), style: rowStyle('Explorer') },
        { type: 'button', windowId: this.windowId, text: row('\u2699\uFE0F', 'Procs'), style: rowStyle('Procs') },
        { type: 'button', windowId: this.windowId, text: row('\uD83D\uDC41', 'The Eye'), style: rowStyle('The Eye') },
        { type: 'button', windowId: this.windowId, text: row('\uD83D\uDD14', 'Notifications'), style: rowStyle('Notifications') },
      );
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
        ],
      }));
    }

    // Fire-and-forget: register as dependent for all buttons
    for (const btnId of widgetIds) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }

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
