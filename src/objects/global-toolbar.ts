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

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  /** Single-flight guard for show()'s destroy+rebuild (prevents duplicate rails). */
  private buildingUI = false;
  /** True when WorkspaceManager pushed a theme into the pending show(). */
  private pushedTheme = false;
  private settingsBtnId?: AbjectId;
  private networkBtnId?: AbjectId;
  private explorerBtnId?: AbjectId;
  private processesBtnId?: AbjectId;
  private llmMonitorBtnId?: AbjectId;
  private notificationsBtnId?: AbjectId;

  // Cached lookup for the active workspace's NotificationCenter. Refreshed
  // on every click in case the workspace switched.
  private workspaceManagerId?: AbjectId;

  /** Current window height (queried by WorkspaceManager for Taskbar positioning) */
  private currentHeight = 0;

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
                description: 'Show the toolbar at a given y offset',
                parameters: [
                  {
                    name: 'yOffset',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Y position for the toolbar window',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the toolbar',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getHeight',
                description: 'Get the current window height for positioning',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'number' },
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
Persistent chromeless toolbar positioned above the workspace area. Provides
quick-access buttons for system-wide panels: GlobalSettings (API keys),
PeerNetwork (identity and contacts), ObjectBrowser (Explorer), ProcessExplorer
(running processes), and LLMMonitor (The Eye).

### Methods
- \`show({ yOffset })\` -- Show the toolbar at the given vertical offset.
- \`hide()\` -- Destroy the toolbar window.
- \`getHeight()\` -- Returns the current window height (used by WorkspaceManager
  for positioning elements below the toolbar).

### Behavior
- Each button lazily discovers its target object on first click.
- Clicking a button sends \`show\` to the corresponding system panel.
- The toolbar rebuilds from scratch on each \`show()\` call so its position
  can be updated by the caller.

### Interface ID
\`abjects:global-toolbar\``;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const { yOffset, theme } = msg.payload as { yOffset?: number; theme?: ThemeData } ?? {};
      // WorkspaceManager pushes the active workspace's theme on switch/startup.
      if (theme && typeof theme === 'object' && 'canvasBg' in theme) {
        this.theme = theme;
        this.pushedTheme = true;
      }
      return this.show(yOffset ?? 8);
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('getHeight', async () => {
      return this.currentHeight;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

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

  async show(yOffset = 8): Promise<boolean> {
    // Single-flight: a second show() racing in during a workspace switch would
    // destroy+recreate the window concurrently and leave two stacked rails
    // (duplicate header). Bail if a build is already in flight.
    if (this.buildingUI) return true;
    this.buildingUI = true;
    try {
    // If WorkspaceManager already pushed the active theme into this show(), use
    // it; otherwise pull it ourselves (e.g. a self-initiated re-show).
    if (this.pushedTheme) {
      this.pushedTheme = false;
    } else {
      await this.refreshActiveTheme();
    }

    // Always destroy and rebuild (position may have changed)
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    // Reset button tracking
    this.settingsBtnId = undefined;
    this.networkBtnId = undefined;
    this.explorerBtnId = undefined;
    this.processesBtnId = undefined;
    this.llmMonitorBtnId = undefined;
    this.notificationsBtnId = undefined;
    this.rootLayoutId = undefined;

    const btnW = 120;
    const btnH = 30;
    const labelH = 20;
    const padding = 16;
    const spacing = 6;

    // Height: padding + label row + 5 buttons + padding
    const barHeight = padding + labelH + (spacing + btnH) * 5 + padding;
    const barWidth = btnW + padding * 2;

    this.currentHeight = barHeight;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\u2699 System',
        rect: { x: 8, y: yOffset, width: barWidth, height: barHeight },
        zIndex: 1000,
        chromeless: true,
        draggable: true,
        closable: false,
      })
    );

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: padding, right: padding, bottom: padding, left: padding },
        spacing,
      })
    );

    // Header row: "System" label + gear (settings) button
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: labelH },
    }));

    // "Grimoire index" styling: flat, borderless, left-aligned rows (matches
    // the Abjects rail) rather than boxed pills.
    const ghostBg = lightenColor(this.theme.windowBg, 5);
    const appStyle = {
      background: ghostBg, borderColor: this.theme.windowBg,
      color: this.theme.textPrimary, radius: this.theme.tokens.radius.sm,
      align: 'left', fontSize: 12,
    };
    const gearStyle = { background: ghostBg, borderColor: this.theme.windowBg, color: this.theme.textSecondary, radius: this.theme.tokens.radius.sm, fontSize: 13 };

    // Batch create all widgets: header label, gear button, action buttons
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId!, text: '\u2699 System', style: { color: this.theme.accent, fontSize: 12, fontWeight: 'bold', fontFamily: 'display' } },
          { type: 'button', windowId: this.windowId!, text: '\u2699', style: gearStyle },
          { type: 'button', windowId: this.windowId!, text: '\uD83C\uDF10 Network', style: appStyle },
          { type: 'button', windowId: this.windowId!, text: '\uD83D\uDD0D Explorer', style: appStyle },
          { type: 'button', windowId: this.windowId!, text: '\u2699\uFE0F Procs', style: appStyle },
          { type: 'button', windowId: this.windowId!, text: '\uD83D\uDC41 The Eye', style: appStyle },
          { type: 'button', windowId: this.windowId!, text: '\uD83D\uDD14 Notifications', style: appStyle },
        ],
      })
    );

    const labelId = widgetIds[0];
    this.settingsBtnId = widgetIds[1];
    this.networkBtnId = widgetIds[2];
    this.explorerBtnId = widgetIds[3];
    this.processesBtnId = widgetIds[4];
    this.llmMonitorBtnId = widgetIds[5];
    this.notificationsBtnId = widgetIds[6];

    // Add header row children: label + gear button
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: labelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: labelH } },
        { widgetId: this.settingsBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } },
      ],
    }));

    // Add action buttons to root layout
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChildren', {
      children: [
        { widgetId: this.networkBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
        { widgetId: this.explorerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
        { widgetId: this.processesBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
        { widgetId: this.llmMonitorBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
        { widgetId: this.notificationsBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
      ],
    }));

    // Fire-and-forget: register as dependent for all buttons
    this.send(request(this.id, this.settingsBtnId, 'addDependent', {}));
    this.send(request(this.id, this.networkBtnId, 'addDependent', {}));
    this.send(request(this.id, this.explorerBtnId, 'addDependent', {}));
    this.send(request(this.id, this.processesBtnId, 'addDependent', {}));
    this.send(request(this.id, this.llmMonitorBtnId, 'addDependent', {}));
    this.send(request(this.id, this.notificationsBtnId, 'addDependent', {}));

    return true;
    } finally {
      this.buildingUI = false;
    }
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
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
