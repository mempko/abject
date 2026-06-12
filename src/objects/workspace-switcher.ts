/**
 * WorkspaceSwitcher — global chromeless window for switching between workspaces.
 *
 * Exists outside any workspace so it is never hidden/shown during a workspace
 * switch, avoiding the message-passing deadlock that occurs when the Taskbar
 * (a per-workspace object) tries to request WM.switchWorkspace while WM tries
 * to hide/show the same Taskbar.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { ThemeData } from '../core/theme-data.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { lightenColor } from './widgets/widget-types.js';

const log = new Log('WorkspaceSwitcher');

const WORKSPACE_SWITCHER_INTERFACE: InterfaceId = 'abjects:workspace-switcher';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const WORKSPACE_MANAGER_INTERFACE: InterfaceId = 'abjects:workspace-manager';

const WORKSPACE_BROWSER_INTERFACE: InterfaceId = 'abjects:workspace-browser';
const SETTINGS_INTERFACE: InterfaceId = 'abjects:settings';

export class WorkspaceSwitcher extends Abject {
  private widgetManagerId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private workspaceBrowserId?: AbjectId;
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

  /** Button AbjectId → workspace ID */
  private workspaceSwitchButtons: Map<AbjectId, string> = new Map();
  private workspaceCreateBtnId?: AbjectId;
  private browseBtnId?: AbjectId;
  private settingsBtnId?: AbjectId;

  /** Per-workspace Settings ID (pushed by WorkspaceManager via show payload) */
  private settingsId?: AbjectId;

  /** Cached workspace data (pushed by WorkspaceManager via show payload) */
  private cachedWorkspaces: Array<{ id: string; name: string; accessMode: string }> = [];
  private cachedActiveWorkspaceId?: string;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceSwitcher',
        description:
          'Global workspace switcher bar. Shows workspace buttons and a "+" button to create new workspaces.',
        version: '1.0.0',
        interface: {
            id: WORKSPACE_SWITCHER_INTERFACE,
            name: 'WorkspaceSwitcher',
            description: 'Workspace switcher UI',
            methods: [
              {
                name: 'show',
                description: 'Show the workspace switcher with workspace data',
                parameters: [
                  {
                    name: 'workspaces',
                    type: { kind: 'array', elementType: { kind: 'reference', reference: 'WorkspaceInfo' } },
                    description: 'List of workspaces',
                  },
                  {
                    name: 'activeWorkspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Currently active workspace ID',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Clear the Spaces section',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display workspace switcher', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WorkspaceSwitcher Usage Guide

### Overview
Provider of the Spaces section of the sidebar dock. Shows one row per
workspace (with access-mode icons), a "+" button to create new workspaces,
a gear button to open workspace Settings, and a "Browse" row to open
the WorkspaceBrowser for discovering remote workspaces.

### Methods
- \`show({ workspaces, activeWorkspaceId, settingsId?, windowId?, sectionLayoutId?, theme? })\` --
  Rebuild the section rows with the given workspace list inside the sidebar
  section. IDs are cached, so a bare \`show()\` rebuilds in place. The active
  workspace row is highlighted.
- \`hide()\` -- Clear the section.

### Behavior
- Clicking a workspace row sends \`switchWorkspace\` to WorkspaceManager.
- Clicking "+" creates a new workspace and asks WorkspaceManager to refresh.
- Clicking the gear opens the per-workspace Settings panel.
- Clicking "Browse" opens WorkspaceBrowser for remote workspace discovery.
- Clicking the section header toggles the section collapsed (header only).
- Exists outside any workspace to avoid deadlocks during workspace switches.

### Interface ID
\`abjects:workspace-switcher\``;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        workspaces?: Array<{ id: string; name: string; accessMode: string }>;
        activeWorkspaceId?: string;
        settingsId?: AbjectId;
        windowId?: AbjectId;
        sectionLayoutId?: AbjectId;
        compact?: boolean;
        theme?: ThemeData;
      } | undefined;
      if (payload?.workspaces) {
        this.cachedWorkspaces = payload.workspaces;
        this.cachedActiveWorkspaceId = payload.activeWorkspaceId;
      }
      if (payload?.settingsId !== undefined) {
        this.settingsId = payload.settingsId;
      }
      // WorkspaceManager pushes fresh sidebar section IDs after each sidebar
      // rebuild; a bare show() rebuilds into the cached section.
      if (payload?.windowId && payload?.sectionLayoutId) {
        this.windowId = payload.windowId;
        this.sectionLayoutId = payload.sectionLayoutId;
        this.compact = payload.compact ?? false;
      }
      // WorkspaceManager pushes the active workspace's theme on switch/startup.
      if (payload?.theme && typeof payload.theme === 'object' && 'canvasBg' in payload.theme) {
        this.theme = payload.theme;
        this.pushedTheme = true;
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

      // Lazy-discover WorkspaceManager if not yet found (spawn order race)
      if (!this.workspaceManagerId) {
        this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
      }

      // Workspace switch button — fire-and-forget to avoid deadlock
      if (this.workspaceSwitchButtons.has(fromId)) {
        const wsId = this.workspaceSwitchButtons.get(fromId)!;
        if (this.workspaceManagerId) {
          this.send(request(this.id, this.workspaceManagerId,
            'switchWorkspace', { workspaceId: wsId }));
        }
        return;
      }

      // Create workspace button
      if (fromId === this.workspaceCreateBtnId) {
        if (this.workspaceManagerId) {
          try {
            const name = `Workspace ${this.cachedWorkspaces.length + 1}`;
            await this.request(request(this.id, this.workspaceManagerId,
              'createWorkspace', { name }));
            // Refresh cached workspace data
            this.cachedWorkspaces = await this.request<Array<{ id: string; name: string; accessMode: string }>>(
              request(this.id, this.workspaceManagerId,
                'listWorkspaces', {}));
            // Tell WM to rebuild the sidebar (it pushes fresh section IDs back
            // into this rail's show()).
            this.send(request(this.id, this.workspaceManagerId,
              'refreshTaskbar', {}));
            await this.notify(`Workspace "${name}" created`, 'success');
          } catch (err) {
            log.warn('Failed to create workspace:', err);
            const msg = err instanceof Error ? err.message : String(err);
            await this.notify(`Workspace creation failed: ${msg.slice(0, 80)}`, 'error');
          }
        }
        return;
      }

      // Settings gear button
      if (fromId === this.settingsBtnId) {
        if (this.settingsId) {
          try {
            await this.request(request(this.id, this.settingsId,
              'show', {}));
          } catch (err) {
            log.warn('Failed to show Settings:', err);
          }
        }
        return;
      }

      // Browse button
      if (fromId === this.browseBtnId) {
        if (!this.workspaceBrowserId) {
          this.workspaceBrowserId = await this.discoverDep('WorkspaceBrowser') ?? undefined;
        }
        if (this.workspaceBrowserId) {
          try {
            await this.request(request(this.id, this.workspaceBrowserId,
              'show', {}));
          } catch (err) {
            log.warn('Failed to show WorkspaceBrowser:', err);
          }
        }
        return;
      }

    });
  }

  /**
   * Pull the active workspace's theme from WidgetManager before (re)building.
   * As a global object outside any workspace, the switcher can't rely on
   * `discoverDep('Theme')` (returns the first registered Theme, not the active
   * one), so it would otherwise rebuild with a stale palette on startup and
   * workspace switch.
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
    // destroy+recreate the window concurrently and leave two stacked rails
    // (duplicate header). Bail if a build is already in flight.
    if (this.buildingUI) return true;
    if (!this.windowId || !this.sectionLayoutId) return false;
    this.buildingUI = true;
    try {
    // If WorkspaceManager already pushed the active theme into this show(), use
    // it; otherwise pull it ourselves (e.g. a self-initiated re-show on create).
    if (this.pushedTheme) {
      this.pushedTheme = false;
    } else {
      await this.refreshActiveTheme();
    }

    // Rebuild in place: clear the section, then repopulate.
    await this.request(request(this.id, this.sectionLayoutId!, 'clearLayoutChildren', {}));

    // Reset button tracking
    this.workspaceSwitchButtons.clear();
    this.headerBtnId = undefined;
    this.workspaceCreateBtnId = undefined;
    this.browseBtnId = undefined;
    this.settingsBtnId = undefined;

    const workspaces = this.cachedWorkspaces;
    const hasWorkspaces = workspaces.length > 0;

    const btnW = 120;
    const btnH = 30;
    const labelH = 20;

    // "Grimoire index" styling shared with the System/Abjects rails: flat,
    // borderless, left-aligned ghost rows. The active space keeps the accent
    // highlight on top of that base.
    const compact = this.compact;
    const ghostBg = lightenColor(this.theme.windowBg, 5);
    const appStyle = {
      background: ghostBg, flat: true,
      color: this.theme.textPrimary, radius: this.theme.tokens.radius.sm,
      align: compact ? 'center' : 'left', fontSize: compact ? 14 : 12,
    };
    const gearStyle = { background: ghostBg, flat: true, color: this.theme.textSecondary, radius: this.theme.tokens.radius.sm, fontSize: 13, align: 'center' };
    const wsActiveStyle = { ...appStyle, background: this.theme.activeItemBg, borderColor: this.theme.activeItemBorder };
    const headerStyle = { background: this.theme.windowBg, flat: true, color: this.theme.accent, fontSize: 12, fontWeight: 'bold', fontFamily: 'display', align: compact ? 'center' : 'left' };
    const chevron = this.collapsed ? '▸' : '▾';
    const showRows = !this.collapsed && hasWorkspaces;

    {
      // ── Spaces section header row: collapse toggle + "+" + gear ──
      const spacesHeaderRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: this.sectionLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 4,
        })
      );
      await this.request(request(this.id, this.sectionLayoutId!, 'updateLayoutChild', {
        widgetId: spacesHeaderRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: labelH },
      }));

      // Batch create all widgets: header toggle (+ "+" and gear when
      // expanded), then rows. Compact mode drops the header action buttons
      // (no horizontal room) and renders icon-only rows.
      const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];
      // 0: header collapse-toggle button
      specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\u25C8' : `${chevron} \u25C8 Spaces`, style: compact ? { ...headerStyle, tooltip: 'Spaces' } : headerStyle });
      if (!compact) {
        // "+" button and settings gear (in header row)
        specs.push({ type: 'button', windowId: this.windowId!, text: '+', style: gearStyle });
        specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699', style: gearStyle });
      }
      const rowStartIdx = specs.length;
      if (showRows) {
        // workspace buttons
        for (const ws of workspaces) {
          const isActive = ws.id === this.cachedActiveWorkspaceId;
          const accessIcon = ws.accessMode === 'public' ? '\uD83C\uDF0D' : ws.accessMode === 'private' ? '\uD83D\uDD11' : '\uD83D\uDD12';
          const baseStyle = isActive ? wsActiveStyle : appStyle;
          specs.push({ type: 'button', windowId: this.windowId!, text: compact ? accessIcon : `${accessIcon} ${ws.name}`, style: compact ? { ...baseStyle, tooltip: ws.name } : baseStyle });
        }
        // Browse button
        specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\uD83D\uDD0E' : '\uD83D\uDD0E Browse', style: compact ? { ...appStyle, tooltip: 'Browse' } : appStyle });
      }

      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );

      this.headerBtnId = widgetIds[0];
      this.workspaceCreateBtnId = compact ? undefined : widgetIds[1];
      this.settingsBtnId = compact ? undefined : widgetIds[2];

      // Add header row children: toggle (+ "+" + gear when expanded)
      const headerChildren: Array<Record<string, unknown>> = [
        { widgetId: this.headerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: labelH } },
      ];
      if (this.workspaceCreateBtnId) {
        headerChildren.push({ widgetId: this.workspaceCreateBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } });
      }
      if (this.settingsBtnId) {
        headerChildren.push({ widgetId: this.settingsBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } });
      }
      await this.request(request(this.id, spacesHeaderRowId, 'addLayoutChildren', { children: headerChildren }));

      if (showRows) {
        // Map workspace buttons and build section children
        const sectionChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];
        for (let i = 0; i < workspaces.length; i++) {
          const btnId = widgetIds[rowStartIdx + i];
          this.workspaceSwitchButtons.set(btnId, workspaces[i].id);
          sectionChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });
        }

        this.browseBtnId = widgetIds[rowStartIdx + workspaces.length];
        sectionChildren.push({ widgetId: this.browseBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });

        await this.request(request(this.id, this.sectionLayoutId!, 'addLayoutChildren', {
          children: sectionChildren,
        }));
      }

      // Fire-and-forget: register as dependent for all interactive buttons
      for (const btnId of widgetIds) {
        this.send(request(this.id, btnId, 'addDependent', {}));
      }
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
    this.workspaceSwitchButtons.clear();
    this.headerBtnId = undefined;
    this.workspaceCreateBtnId = undefined;
    this.browseBtnId = undefined;
    this.settingsBtnId = undefined;
    return true;
  }
}

export const WORKSPACE_SWITCHER_ID = 'abjects:workspace-switcher' as AbjectId;
