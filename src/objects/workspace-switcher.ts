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
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const WORKSPACE_SWITCHER_INTERFACE: InterfaceId = 'abjects:workspace-switcher';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const WORKSPACE_MANAGER_INTERFACE: InterfaceId = 'abjects:workspace-manager';

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';

export class WorkspaceSwitcher extends Abject {
  private widgetManagerId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private globalSettingsId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  /** Button AbjectId → workspace ID */
  private workspaceSwitchButtons: Map<AbjectId, string> = new Map();
  private workspaceCreateBtnId?: AbjectId;
  private globalSettingsBtnId?: AbjectId;

  /** Cached workspace data (pushed by WorkspaceManager via show payload) */
  private cachedWorkspaces: Array<{ id: string; name: string }> = [];
  private cachedActiveWorkspaceId?: string;

  /** Current window height (queried by WorkspaceManager for Taskbar positioning) */
  private currentHeight = 0;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceSwitcher',
        description:
          'Global workspace switcher bar. Shows workspace buttons and a "+" button to create new workspaces.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
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
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.globalSettingsId = await this.discoverDep('GlobalSettings') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        workspaces?: Array<{ id: string; name: string }>;
        activeWorkspaceId?: string;
      } | undefined;
      if (payload?.workspaces) {
        this.cachedWorkspaces = payload.workspaces;
        this.cachedActiveWorkspaceId = payload.activeWorkspaceId;
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
            WORKSPACE_MANAGER_INTERFACE, 'switchWorkspace', { workspaceId: wsId }));
        }
        return;
      }

      // Create workspace button
      if (fromId === this.workspaceCreateBtnId) {
        if (this.workspaceManagerId) {
          try {
            const name = `Workspace ${this.cachedWorkspaces.length + 1}`;
            await this.request(request(this.id, this.workspaceManagerId,
              WORKSPACE_MANAGER_INTERFACE, 'createWorkspace', { name }));
            // Refresh cached workspace data
            this.cachedWorkspaces = await this.request<Array<{ id: string; name: string }>>(
              request(this.id, this.workspaceManagerId,
                WORKSPACE_MANAGER_INTERFACE, 'listWorkspaces', {}));
            await this.show();
            // Tell WM to refresh the taskbar position (switcher height may have changed)
            await this.send(request(this.id, this.workspaceManagerId,
              WORKSPACE_MANAGER_INTERFACE, 'refreshTaskbar', {}));
          } catch (err) {
            console.warn('[WorkspaceSwitcher] Failed to create workspace:', err);
          }
        }
        return;
      }

      // Global Settings button
      if (fromId === this.globalSettingsBtnId) {
        if (!this.globalSettingsId) {
          this.globalSettingsId = await this.discoverDep('GlobalSettings') ?? undefined;
        }
        if (this.globalSettingsId) {
          try {
            await this.request(request(this.id, this.globalSettingsId,
              GLOBAL_SETTINGS_INTERFACE, 'show', {}));
          } catch (err) {
            console.warn('[WorkspaceSwitcher] Failed to show GlobalSettings:', err);
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
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    // Reset button tracking
    this.workspaceSwitchButtons.clear();
    this.workspaceCreateBtnId = undefined;
    this.globalSettingsBtnId = undefined;
    this.rootLayoutId = undefined;

    const workspaces = this.cachedWorkspaces;
    const hasWorkspaces = workspaces.length > 0;

    const btnW = 100;
    const btnH = 30;
    const labelH = 20;
    const dividerH = 8;
    const padding = 16;
    const spacing = 6;

    // Workspace section: label + all workspace buttons + "+" button
    const wsBtnCount = hasWorkspaces ? workspaces.length + 1 : 0;
    const wsLabelCount = hasWorkspaces ? 1 : 0;
    const extraHeight = wsLabelCount * (labelH + spacing);
    const barWidth = btnW + padding * 2;
    const barHeight = padding + extraHeight
      + (wsBtnCount > 0 ? wsBtnCount * (btnH + spacing) : 0)
      - spacing + padding;

    this.currentHeight = barHeight;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: '',
        rect: { x: 8, y: 8, width: barWidth, height: barHeight },
        zIndex: 1000,
        chromeless: true,
        draggable: true,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: padding, right: padding, bottom: padding, left: padding },
        spacing,
      })
    );

    const wsActiveStyle = { background: '#1e3a2e', borderColor: '#4caf50' };

    // Helper to add a fixed-size button to the layout
    const addBtn = async (text: string, style?: Record<string, unknown>): Promise<AbjectId> => {
      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text,
          ...(style ? { style } : {}),
        })
      );
      await this.request(
        request(this.id, btnId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: btnId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: btnH },
      }));
      return btnId;
    };

    // Helper to add a section label
    const addSectionLabel = async (text: string): Promise<void> => {
      const labelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text,
          style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: labelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: labelH },
      }));
    };

    // Build workspace buttons
    if (hasWorkspaces) {
      // Section header row: "◈ Workspaces" label + gear button
      const wsHeaderRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 4,
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: wsHeaderRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: labelH },
      }));

      const wsHeaderLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text: '\u25C8 Spaces',
          style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
        })
      );
      await this.request(request(this.id, wsHeaderRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: wsHeaderLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: labelH },
      }));

      this.globalSettingsBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: '\u2699',
          style: { fontSize: 13 },
        })
      );
      await this.request(request(this.id, this.globalSettingsBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
      await this.request(request(this.id, wsHeaderRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.globalSettingsBtnId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 24, height: labelH },
      }));

      for (const ws of workspaces) {
        const isActive = ws.id === this.cachedActiveWorkspaceId;
        const btnId = await addBtn(ws.name, isActive ? wsActiveStyle : undefined);
        this.workspaceSwitchButtons.set(btnId, ws.id);
      }

      // "+" button to create a new workspace
      this.workspaceCreateBtnId = await addBtn('+');
    }

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.workspaceSwitchButtons.clear();
    this.workspaceCreateBtnId = undefined;
    this.globalSettingsBtnId = undefined;
    return true;
  }
}

export const WORKSPACE_SWITCHER_ID = 'abjects:workspace-switcher' as AbjectId;
