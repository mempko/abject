/**
 * Settings object - per-workspace configuration UI with General and Access tabs.
 *
 * Uses direct widget Abject interaction (createWindowAbject, createButton, etc.)
 * instead of the legacy string-based widget ID shim.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const SETTINGS_INTERFACE: InterfaceId = 'abjects:settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const WORKSPACE_MANAGER_INTERFACE: InterfaceId = 'abjects:workspace-manager';
const WORKSPACE_SWITCHER_INTERFACE: InterfaceId = 'abjects:workspace-switcher';
const ABJECT_STORE_INTERFACE: InterfaceId = 'abjects:abject-store';
const PEER_REGISTRY_INTERFACE: InterfaceId = 'abjects:peer-registry';

/**
 * Settings object that provides a per-workspace configuration UI with
 * General and Access tabs.
 *
 * General tab: workspace name + created objects.
 * Access tab: access mode selector + whitelist for private mode.
 */
export class Settings extends Abject {
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private workspaceSwitcherId?: AbjectId;
  private abjectStoreId?: AbjectId;
  private peerRegistryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Tab state
  private activeTab: 'general' | 'access' = 'general';
  private tabBarId?: AbjectId;

  // Widget AbjectIds (General tab)
  private workspaceNameInputId?: AbjectId;
  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Widget AbjectIds (Access tab)
  private accessModeSelectId?: AbjectId;
  private accessSaveBtnId?: AbjectId;
  private accessStatusLabelId?: AbjectId;

  /** Maps delete button AbjectId → object ID for "Created Objects" section. */
  private objectDeleteButtons: Map<AbjectId, string> = new Map();

  /** Maps checkbox AbjectId → peerId for whitelist UI. */
  private whitelistCheckboxes: Map<AbjectId, string> = new Map();

  /** Nested VBox container for the whitelist section (always present in access tab layout). */
  private whitelistContainerId?: AbjectId;
  /** Widget IDs inside the whitelist container, for cleanup on mode change. */
  private whitelistWidgetIds: AbjectId[] = [];

  /** Nested VBox that holds all tab-specific content (destroyed/recreated on tab switch). */
  private tabContentContainerId?: AbjectId;
  /** All widget IDs created inside the tab content container, for cleanup on tab switch. */
  private tabContentWidgetIds: AbjectId[] = [];

  /** The workspace ID this Settings instance belongs to (lazy-discovered). */
  private workspaceId?: string;

  constructor() {
    super({
      manifest: {
        name: 'Settings',
        description:
          'Per-workspace configuration UI. Manages workspace name and access settings.',
        version: '1.0.0',
        interfaces: [
          {
            id: SETTINGS_INTERFACE,
            name: 'Settings',
            description: 'Workspace configuration',
            methods: [
              {
                name: 'show',
                description: 'Show the settings window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the settings window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display settings window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'settings'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
  }

  /**
   * Lazy-discover which workspace this Settings instance belongs to
   * by querying WidgetManager.getObjectWorkspace (same pattern as AbjectStore).
   */
  private async ensureWorkspaceId(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    if (!this.widgetManagerId) return undefined;
    try {
      const wsId = await this.request<string | null>(
        request(this.id, this.widgetManagerId, WIDGETS_INTERFACE, 'getObjectWorkspace', { objectId: this.id })
      );
      if (wsId) this.workspaceId = wsId;
    } catch { /* not tagged yet */ }
    return this.workspaceId;
  }

  /** Track a widget created inside the tab content container for cleanup. */
  private trackTabWidget(widgetId: AbjectId): AbjectId {
    this.tabContentWidgetIds.push(widgetId);
    return widgetId;
  }

  /**
   * Destroy all tab content widgets, remove+destroy the container, then create a fresh container.
   * The window, root layout, and tab bar persist across tab switches.
   */
  private async clearTabContent(): Promise<void> {
    if (!this.tabContentContainerId || !this.rootLayoutId) return;

    for (const widgetId of this.tabContentWidgetIds) {
      try { await this.request(request(this.id, widgetId, WIDGET_INTERFACE, 'destroy', {})); }
      catch { /* gone */ }
    }
    this.tabContentWidgetIds = [];

    try { await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'removeLayoutChild', { widgetId: this.tabContentContainerId })); }
    catch { /* gone */ }
    try { await this.request(request(this.id, this.tabContentContainerId, WIDGET_INTERFACE, 'destroy', {})); }
    catch { /* gone */ }

    this.tabContentContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.tabContentContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Reset tab-specific widget refs
    this.workspaceNameInputId = undefined;
    this.accessModeSelectId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.accessSaveBtnId = undefined;
    this.accessStatusLabelId = undefined;
    this.objectDeleteButtons.clear();
    this.whitelistCheckboxes.clear();
    this.whitelistContainerId = undefined;
    this.whitelistWidgetIds = [];
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

    // Handle 'changed' events from widget dependents
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // Tab bar change — clear and rebuild tab content without destroying window
      if (fromId === this.tabBarId && aspect === 'change') {
        const idx = value as number;
        this.activeTab = idx === 0 ? 'general' : 'access';
        await this.clearTabContent();
        const r0 = { x: 0, y: 0, width: 0, height: 0 };
        if (this.activeTab === 'general') {
          await this.buildGeneralTab(r0);
        } else {
          await this.buildAccessTab(r0);
        }
        return;
      }

      // General tab save button
      if (fromId === this.saveBtnId && aspect === 'click') {
        await this.saveGeneralSettings();
        return;
      }

      // Access tab save button
      if (fromId === this.accessSaveBtnId && aspect === 'click') {
        await this.saveAccessSettings();
        return;
      }

      // Text input submit triggers save
      if (aspect === 'submit') {
        if (this.activeTab === 'general') {
          await this.saveGeneralSettings();
        } else {
          await this.saveAccessSettings();
        }
        return;
      }

      // Handle delete button clicks for created objects
      if (aspect === 'click' && this.objectDeleteButtons.has(fromId)) {
        const objectId = this.objectDeleteButtons.get(fromId)!;
        await this.deleteCreatedObject(objectId);
        return;
      }

      // Access mode dropdown change — dynamically add/remove whitelist section
      if (fromId === this.accessModeSelectId && aspect === 'change') {
        const modeMap: Record<string, string> = { 'Local': 'local', 'Private': 'private', 'Public': 'public' };
        const newMode = modeMap[value as string] ?? 'local';
        await this.clearWhitelistSection();
        if (newMode === 'private') {
          const r0 = { x: 0, y: 0, width: 0, height: 0 };
          await this.buildWhitelistSection(r0);
        }
        return;
      }
    });
  }

  /**
   * Show the settings window.
   */
  async show(): Promise<boolean> {
    if (this.windowId) return true;

    await this.ensureWorkspaceId();

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winW = 440;
    const winH = 500;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Workspace Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    // Tab bar
    this.tabBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTabBar', {
        windowId: this.windowId, rect: r0,
        tabs: ['General', 'Access'],
        selectedIndex: this.activeTab === 'general' ? 0 : 1,
      })
    );
    await this.request(request(this.id, this.tabBarId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Create tab content container (expanding VBox that holds all tab content)
    this.tabContentContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.tabContentContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Build tab content
    if (this.activeTab === 'general') {
      await this.buildGeneralTab(r0);
    } else {
      await this.buildAccessTab(r0);
    }

    await this.changed('visibility', true);
    return true;
  }

  /**
   * Build the General tab: workspace name + created objects + save button.
   */
  private async buildGeneralTab(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    // Get current workspace name
    let currentName = '';
    if (this.workspaceManagerId) {
      try {
        const active = await this.request<{ id: string; name: string } | null>(
          request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'getActiveWorkspace', {})
        );
        if (active) currentName = active.name;
      } catch { /* use empty */ }
    }

    // Get created objects from AbjectStore
    interface AbjectSnapshot { objectId: string; manifest: { name: string; description: string }; source: string; owner: string; savedAt: number }
    let snapshots: AbjectSnapshot[] = [];
    if (this.abjectStoreId) {
      try {
        snapshots = await this.request<AbjectSnapshot[]>(
          request(this.id, this.abjectStoreId, ABJECT_STORE_INTERFACE, 'list', {})
        );
      } catch { /* AbjectStore may not be ready */ }
    }

    const cId = this.tabContentContainerId!;

    // Section header: "Workspace"
    const sectionHeaderId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Workspace',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    const descLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Configure this workspace.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Workspace Name label
    const nameLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Workspace Name',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Workspace Name input
    this.workspaceNameInputId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Workspace name',
        text: currentName,
      })
    ));
    await this.request(request(this.id, this.workspaceNameInputId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.workspaceNameInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // ── Created Objects Section ──

    // Divider
    const divId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));

    // Section header
    const objHeaderId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Created Objects',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: objHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    if (snapshots.length === 0) {
      const emptyLabelId = this.trackTabWidget(await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No objects created yet.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      ));
      await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const snap of snapshots) {
        // HBox row: name label + delete button
        const rowId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
            parentLayoutId: cId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        ));
        await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        const objNameId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
            windowId: this.windowId, rect: r0, text: snap.manifest.name,
            style: { color: '#e2e4e9', fontSize: 13 },
          })
        ));
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: objNameId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        const delBtnId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId, rect: r0, text: 'Delete',
            style: { background: '#3a1f1f', color: '#ff6b6b', borderColor: '#ff6b6b', fontSize: 11 },
          })
        ));
        await this.request(request(this.id, delBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: delBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 28 },
        }));

        this.objectDeleteButtons.set(delBtnId, snap.objectId);
      }
    }

    // Spacer pushes save button to bottom
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Save button row + status label
    await this.buildSaveRow(r0, 'general');
  }

  /**
   * Build the Access tab: access mode selector + whitelist for private mode + save button.
   */
  private async buildAccessTab(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    // Get current access mode
    let currentAccessMode = 'local';
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        currentAccessMode = await this.request<string>(
          request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'getAccessMode', { workspaceId: this.workspaceId })
        );
      } catch { /* default to local */ }
    }

    const cId = this.tabContentContainerId!;

    // Section header
    const sectionHeaderId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Access Control',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    const descLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Control who can access this workspace over the network.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Access Mode label
    const accessLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Access Mode',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: accessLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Access Mode select dropdown
    const accessModeIndex = currentAccessMode === 'public' ? 2 : currentAccessMode === 'private' ? 1 : 0;
    this.accessModeSelectId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createSelect', {
        windowId: this.windowId, rect: r0,
        options: ['Local', 'Private', 'Public'],
        selectedIndex: accessModeIndex,
      })
    ));
    await this.request(request(this.id, this.accessModeSelectId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.accessModeSelectId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // ── Whitelist container (always present; populated only for Private mode) ──
    this.whitelistContainerId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedVBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.whitelistContainerId,
      sizePolicy: { vertical: 'shrink' },
    }));

    if (currentAccessMode === 'private') {
      await this.buildWhitelistSection(r0);
    }

    // Spacer pushes save button to bottom
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Save button row + status label
    await this.buildSaveRow(r0, 'access');
  }

  /**
   * Build the whitelist section showing contacts as checkboxes.
   * Widgets are added to `whitelistContainerId` and tracked in `whitelistWidgetIds`.
   */
  private async buildWhitelistSection(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    const containerId = this.whitelistContainerId!;

    // Divider
    const divId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    this.whitelistWidgetIds.push(divId);
    await this.request(request(this.id, containerId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));

    // Section header
    const headerLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Allowed Contacts',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    this.whitelistWidgetIds.push(headerLabelId);
    await this.request(request(this.id, containerId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: headerLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Description
    const descId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Select which contacts can access this workspace.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    this.whitelistWidgetIds.push(descId);
    await this.request(request(this.id, containerId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: descId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Get contacts from PeerRegistry
    let contacts: Array<{ peerId: string; name: string; state: string }> = [];
    if (!this.peerRegistryId) {
      this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    }
    if (this.peerRegistryId) {
      try {
        contacts = await this.request<Array<{ peerId: string; name: string; state: string }>>(
          request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'listContacts', {})
        );
      } catch { /* PeerRegistry may not be ready */ }
    }

    // Get current whitelist
    let whitelist: string[] = [];
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        whitelist = await this.request<string[]>(
          request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'getWhitelist', { workspaceId: this.workspaceId })
        );
      } catch { /* whitelist not available yet */ }
    }

    if (contacts.length === 0) {
      const emptyLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No contacts available. Add contacts in Global Settings.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      );
      this.whitelistWidgetIds.push(emptyLabelId);
      await this.request(request(this.id, containerId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const contact of contacts) {
        const isWhitelisted = whitelist.includes(contact.peerId);
        const displayName = contact.name || contact.peerId.slice(0, 16) + '...';

        // HBox row: checkbox + name label
        const rowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
            parentLayoutId: containerId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        this.whitelistWidgetIds.push(rowId);
        await this.request(request(this.id, containerId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        const checkboxId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createCheckbox', {
            windowId: this.windowId, rect: r0,
            checked: isWhitelisted,
            text: displayName,
          })
        );
        await this.request(request(this.id, checkboxId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: checkboxId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        this.whitelistCheckboxes.set(checkboxId, contact.peerId);
      }
    }
  }

  /**
   * Remove all widgets from the whitelist container without destroying the container itself.
   */
  private async clearWhitelistSection(): Promise<void> {
    if (!this.whitelistContainerId) return;
    for (const widgetId of this.whitelistWidgetIds) {
      try {
        await this.request(request(this.id, this.whitelistContainerId, LAYOUT_INTERFACE, 'removeLayoutChild', { widgetId }));
      } catch { /* widget may already be gone */ }
      try {
        await this.request(request(this.id, widgetId, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* best effort */ }
    }
    this.whitelistWidgetIds = [];
    this.whitelistCheckboxes.clear();
  }

  /**
   * Build the save button row and status label at the bottom of a tab.
   */
  private async buildSaveRow(r0: { x: number; y: number; width: number; height: number }, tab: 'general' | 'access'): Promise<void> {
    const cId = this.tabContentContainerId!;

    const saveRowId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: saveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, saveRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    const btnId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    ));
    await this.request(request(this.id, btnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: btnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));

    const statusId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: '',
        style: { color: '#b4b8c8', fontSize: 12, align: 'right' },
      })
    ));
    await this.request(request(this.id, cId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: statusId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    if (tab === 'general') {
      this.saveBtnId = btnId;
      this.statusLabelId = statusId;
    } else {
      this.accessSaveBtnId = btnId;
      this.accessStatusLabelId = statusId;
    }
  }

  /**
   * Hide the settings window.
   */
  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.tabContentContainerId = undefined;
    this.tabContentWidgetIds = [];
    this.workspaceNameInputId = undefined;
    this.accessModeSelectId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.accessSaveBtnId = undefined;
    this.accessStatusLabelId = undefined;
    this.objectDeleteButtons.clear();
    this.whitelistCheckboxes.clear();
    this.whitelistContainerId = undefined;
    this.whitelistWidgetIds = [];

    await this.changed('visibility', false);
    return true;
  }

  private async setControlsDisabled(disabled: boolean, ids: (AbjectId | undefined)[]): Promise<void> {
    const style = { disabled };
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, WIDGET_INTERFACE, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  /**
   * Save General tab settings: workspace name.
   */
  private async saveGeneralSettings(): Promise<void> {
    if (!this.windowId) return;

    await this.setControlsDisabled(true, [this.saveBtnId, this.workspaceNameInputId]);

    const workspaceName = await this.request<string>(
      request(this.id, this.workspaceNameInputId!, WIDGET_INTERFACE, 'getValue', {})
    );

    // Validate non-empty
    if (!workspaceName || workspaceName.trim() === '') {
      if (this.statusLabelId) {
        await this.request(
          request(this.id, this.statusLabelId, WIDGET_INTERFACE, 'update', {
            text: 'Workspace name cannot be empty.',
            style: { color: '#ff6b6b' },
          })
        );
      }
      await this.setControlsDisabled(false, [this.saveBtnId, this.workspaceNameInputId]);
      return;
    }

    // Ensure we know our workspace ID
    await this.ensureWorkspaceId();

    // Rename the workspace
    if (this.workspaceManagerId && this.workspaceId) {
      await this.request(
        request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'renameWorkspace', {
          workspaceId: this.workspaceId,
          name: workspaceName.trim(),
        })
      );

      // Refresh WorkspaceSwitcher to show updated name
      if (!this.workspaceSwitcherId) {
        this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
      }
      if (this.workspaceSwitcherId) {
        try {
          const workspaces = await this.request<Array<{ id: string; name: string }>>(
            request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'listWorkspaces', {})
          );
          await this.request(
            request(this.id, this.workspaceSwitcherId, WORKSPACE_SWITCHER_INTERFACE, 'show', {
              workspaces,
              activeWorkspaceId: this.workspaceId,
            })
          );
        } catch { /* best effort */ }
      }
    }

    // Show save feedback, then close
    if (this.statusLabelId) {
      await this.request(
        request(this.id, this.statusLabelId, WIDGET_INTERFACE, 'update', {
          text: 'Settings saved!',
          style: { color: '#b4b8c8' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await this.hide();
  }

  /**
   * Save Access tab settings: access mode + whitelist.
   */
  private async saveAccessSettings(): Promise<void> {
    if (!this.windowId) return;

    await this.setControlsDisabled(true, [this.accessSaveBtnId, this.accessModeSelectId]);

    await this.ensureWorkspaceId();

    // Save access mode
    if (this.workspaceManagerId && this.workspaceId && this.accessModeSelectId) {
      try {
        const selectedValue = await this.request<string>(
          request(this.id, this.accessModeSelectId, WIDGET_INTERFACE, 'getValue', {})
        );
        const modeMap: Record<string, string> = { 'Local': 'local', 'Private': 'private', 'Public': 'public' };
        const accessMode = modeMap[selectedValue] ?? 'local';
        await this.request(
          request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'setAccessMode', {
            workspaceId: this.workspaceId,
            accessMode,
          })
        );

        // Save whitelist if in private mode
        if (accessMode === 'private' && this.whitelistCheckboxes.size > 0) {
          const whitelist: string[] = [];
          for (const [checkboxId, peerId] of this.whitelistCheckboxes) {
            try {
              const checked = await this.request<string>(
                request(this.id, checkboxId, WIDGET_INTERFACE, 'getValue', {})
              );
              if (checked === 'true') whitelist.push(peerId);
            } catch { /* checkbox gone */ }
          }
          await this.request(
            request(this.id, this.workspaceManagerId, WORKSPACE_MANAGER_INTERFACE, 'setWhitelist', {
              workspaceId: this.workspaceId,
              whitelist,
            })
          );
        }
      } catch { /* access settings save failed */ }
    }

    // Show save feedback, then close
    const statusId = this.accessStatusLabelId;
    if (statusId) {
      await this.request(
        request(this.id, statusId, WIDGET_INTERFACE, 'update', {
          text: 'Access settings saved!',
          style: { color: '#b4b8c8' },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await this.hide();
  }

  /**
   * Delete a user-created object: remove from AbjectStore, kill it, then rebuild the UI.
   */
  private async deleteCreatedObject(objectId: string): Promise<void> {
    if (!this.abjectStoreId) return;

    try {
      // Remove from AbjectStore
      await this.request(
        request(this.id, this.abjectStoreId, ABJECT_STORE_INTERFACE, 'remove', { objectId })
      );

      // Kill the live object via Factory
      const factoryId = await this.discoverDep('Factory');
      if (factoryId) {
        try {
          await this.request(
            request(this.id, factoryId, 'abjects:factory' as InterfaceId, 'kill', { objectId: objectId as AbjectId })
          );
        } catch { /* object may already be dead */ }
      }
    } catch (err) {
      console.warn('[SETTINGS] Failed to delete object:', err);
    }

    // Rebuild tab content to reflect the change (without destroying window)
    await this.clearTabContent();
    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    await this.buildGeneralTab(r0);
  }
}

// Well-known settings ID
export const SETTINGS_ID = 'abjects:settings' as AbjectId;
