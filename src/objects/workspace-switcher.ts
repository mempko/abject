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
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

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
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

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

  /** Cached y offset for rebuilds (set by WorkspaceManager) */
  private cachedYOffset = 8;

  /** Current window height (queried by WorkspaceManager for Taskbar positioning) */
  private currentHeight = 0;

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
                description: 'Hide the workspace switcher',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getHeight',
                description: 'Get the current window height for Taskbar positioning',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'number' },
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
        yOffset?: number;
      } | undefined;
      if (payload?.workspaces) {
        this.cachedWorkspaces = payload.workspaces;
        this.cachedActiveWorkspaceId = payload.activeWorkspaceId;
      }
      if (payload?.settingsId !== undefined) {
        this.settingsId = payload.settingsId;
      }
      if (payload?.yOffset !== undefined) {
        this.cachedYOffset = payload.yOffset;
      }
      return this.show();
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

      // Lazy-discover WorkspaceManager if not yet found (spawn order race)
      if (!this.workspaceManagerId) {
        this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
      }

      // Workspace switch button — fire-and-forget to avoid deadlock
      if (this.workspaceSwitchButtons.has(fromId)) {
        const wsId = this.workspaceSwitchButtons.get(fromId)!;
        if (this.workspaceManagerId) {
          await this.send(request(this.id, this.workspaceManagerId,
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
            await this.show();
            // Tell WM to refresh the taskbar position (switcher height may have changed)
            await this.send(request(this.id, this.workspaceManagerId,
              'refreshTaskbar', {}));
          } catch (err) {
            log.warn('Failed to create workspace:', err);
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

  async show(): Promise<boolean> {
    // Always destroy and rebuild
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    // Reset button tracking
    this.workspaceSwitchButtons.clear();
    this.workspaceCreateBtnId = undefined;
    this.browseBtnId = undefined;
    this.settingsBtnId = undefined;
    this.rootLayoutId = undefined;

    const workspaces = this.cachedWorkspaces;
    const hasWorkspaces = workspaces.length > 0;

    const btnW = 100;
    const btnH = 30;
    const labelH = 20;
    const padding = 16;
    const spacing = 6;

    // Workspace section: label + all workspace buttons + "+" button + Browse button
    const wsBtnCount = hasWorkspaces ? workspaces.length + 2 : 0; // +2 for "+" and "Browse"
    const wsLabelCount = hasWorkspaces ? 1 : 0;
    const extraHeight = wsLabelCount * (labelH + spacing);
    const barWidth = btnW + padding * 2;
    const barHeight = padding + extraHeight
      + (wsBtnCount > 0 ? wsBtnCount * (btnH + spacing) : 0)
      - spacing + padding;

    this.currentHeight = barHeight;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '',
        rect: { x: 8, y: this.cachedYOffset, width: barWidth, height: barHeight },
        zIndex: 1000,
        chromeless: true,
        draggable: true,
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

    const wsActiveStyle = { background: this.theme.activeItemBg, borderColor: this.theme.activeItemBorder };

    // Build workspace buttons
    if (hasWorkspaces) {
      // ── Spaces section header row: "◈ Spaces" label + gear button ──
      const spacesHeaderRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 4,
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
        widgetId: spacesHeaderRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: labelH },
      }));

      // Batch create all widgets: header label, settings button, workspace buttons, +, Browse
      const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];
      // 0: header label
      specs.push({ type: 'label', windowId: this.windowId!, text: '\u25C8 Spaces', style: { color: this.theme.accent, fontSize: 11, fontWeight: 'bold' } });
      // 1: settings gear button
      specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699', style: { fontSize: 13 } });
      // 2..N-1: workspace buttons
      for (const ws of workspaces) {
        const isActive = ws.id === this.cachedActiveWorkspaceId;
        const accessIcon = ws.accessMode === 'public' ? '\uD83C\uDF0D' : ws.accessMode === 'private' ? '\uD83D\uDD11' : '\uD83D\uDD12';
        specs.push({ type: 'button', windowId: this.windowId!, text: `${accessIcon} ${ws.name}`, ...(isActive ? { style: wsActiveStyle } : {}) });
      }
      // N: "+" button
      specs.push({ type: 'button', windowId: this.windowId!, text: '+' });
      // N+1: Browse button
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83D\uDD0E Browse' });

      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );

      const spacesHeaderLabelId = widgetIds[0];
      this.settingsBtnId = widgetIds[1];

      // Add header row children
      await this.request(request(this.id, spacesHeaderRowId, 'addLayoutChildren', {
        children: [
          { widgetId: spacesHeaderLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: labelH } },
          { widgetId: this.settingsBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } },
        ],
      }));

      // Map workspace buttons and build root layout children
      const rootChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];
      for (let i = 0; i < workspaces.length; i++) {
        const btnId = widgetIds[2 + i];
        this.workspaceSwitchButtons.set(btnId, workspaces[i].id);
        rootChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });
      }

      this.workspaceCreateBtnId = widgetIds[2 + workspaces.length];
      rootChildren.push({ widgetId: this.workspaceCreateBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });

      this.browseBtnId = widgetIds[3 + workspaces.length];
      rootChildren.push({ widgetId: this.browseBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });

      // Batch add all to root layout
      await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChildren', {
        children: rootChildren,
      }));

      // Fire-and-forget: register as dependent for all interactive buttons
      this.send(request(this.id, this.settingsBtnId, 'addDependent', {}));
      for (let i = 0; i < workspaces.length; i++) {
        this.send(request(this.id, widgetIds[2 + i], 'addDependent', {}));
      }
      this.send(request(this.id, this.workspaceCreateBtnId, 'addDependent', {}));
      this.send(request(this.id, this.browseBtnId, 'addDependent', {}));

    }

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
    this.rootLayoutId = undefined;
    this.workspaceSwitchButtons.clear();
    this.workspaceCreateBtnId = undefined;
    this.browseBtnId = undefined;
    this.settingsBtnId = undefined;
    return true;
  }
}

export const WORKSPACE_SWITCHER_ID = 'abjects:workspace-switcher' as AbjectId;
