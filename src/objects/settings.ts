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
  private descriptionInputId?: AbjectId;
  private tagsInputId?: AbjectId;
  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Widget AbjectIds (Access tab)
  private accessModeSelectId?: AbjectId;
  private accessSaveBtnId?: AbjectId;
  private accessStatusLabelId?: AbjectId;

  /** Maps delete button AbjectId → object ID for "Created Objects" section. */
  private objectDeleteButtons: Map<AbjectId, string> = new Map();

  /** Maps checkbox AbjectId → object ID for "Exposed" checkboxes on General tab. */
  private generalExposedCheckboxes: Map<AbjectId, string> = new Map();

  /** Maps checkbox AbjectId → peerId for whitelist UI. */
  private whitelistCheckboxes: Map<AbjectId, string> = new Map();

  /** Maps checkbox AbjectId → object ID for exposed objects UI. */
  private exposedCheckboxes: Map<AbjectId, AbjectId> = new Map();
  /** Nested VBox container for the exposed objects section. */
  private exposedContainerId?: AbjectId;
  /** Widget IDs inside the exposed objects container, for cleanup. */
  private exposedWidgetIds: AbjectId[] = [];

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
        interface: {
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
        request(this.id, this.widgetManagerId, 'getObjectWorkspace', { objectId: this.id })
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
      try { await this.request(request(this.id, widgetId, 'destroy', {})); }
      catch { /* gone */ }
    }
    this.tabContentWidgetIds = [];

    try { await this.request(request(this.id, this.rootLayoutId, 'removeLayoutChild', { widgetId: this.tabContentContainerId })); }
    catch { /* gone */ }
    try { await this.request(request(this.id, this.tabContentContainerId, 'destroy', {})); }
    catch { /* gone */ }

    this.tabContentContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabContentContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Reset tab-specific widget refs
    this.workspaceNameInputId = undefined;
    this.descriptionInputId = undefined;
    this.tagsInputId = undefined;
    this.accessModeSelectId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.accessSaveBtnId = undefined;
    this.accessStatusLabelId = undefined;
    this.objectDeleteButtons.clear();
    this.generalExposedCheckboxes.clear();
    this.whitelistCheckboxes.clear();
    this.whitelistContainerId = undefined;
    this.whitelistWidgetIds = [];
    this.exposedCheckboxes.clear();
    this.exposedContainerId = undefined;
    this.exposedWidgetIds = [];
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

      // Access mode dropdown change — dynamically add/remove whitelist and exposed objects sections
      if (fromId === this.accessModeSelectId && aspect === 'change') {
        const modeMap: Record<string, string> = { 'Local': 'local', 'Private': 'private', 'Public': 'public' };
        const newMode = modeMap[value as string] ?? 'local';
        const r0 = { x: 0, y: 0, width: 0, height: 0 };
        await this.clearWhitelistSection();
        await this.clearExposedObjectsSection();
        if (newMode === 'private') {
          await this.buildWhitelistSection(r0);
        }
        if (newMode !== 'local') {
          await this.buildExposedObjectsSection(r0);
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
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winW = 440;
    const winH = 500;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Workspace Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    // Tab bar
    this.tabBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTabBar', {
        windowId: this.windowId, rect: r0,
        tabs: ['General', 'Access'],
        selectedIndex: this.activeTab === 'general' ? 0 : 1,
      })
    );
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Create tab content container (expanding VBox that holds all tab content)
    this.tabContentContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
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
    // Get current workspace name, description, and tags
    let currentName = '';
    let currentDescription = '';
    let currentTags = '';
    if (this.workspaceManagerId) {
      try {
        const active = await this.request<{ id: string; name: string } | null>(
          request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
        );
        if (active) currentName = active.name;
      } catch { /* use empty */ }
    }
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        currentDescription = await this.request<string>(
          request(this.id, this.workspaceManagerId, 'getDescription', { workspaceId: this.workspaceId })
        );
      } catch { /* use empty */ }
      try {
        const tags = await this.request<string[]>(
          request(this.id, this.workspaceManagerId, 'getTags', { workspaceId: this.workspaceId })
        );
        currentTags = tags.join(', ');
      } catch { /* use empty */ }
    }

    // Get created objects from AbjectStore
    interface AbjectSnapshot { objectId: string; manifest: { name: string; description: string }; source: string; owner: string; savedAt: number }
    let snapshots: AbjectSnapshot[] = [];
    if (this.abjectStoreId) {
      try {
        snapshots = await this.request<AbjectSnapshot[]>(
          request(this.id, this.abjectStoreId, 'list', {})
        );
      } catch { /* AbjectStore may not be ready */ }
    }

    const cId = this.tabContentContainerId!;

    // Section header: "Workspace"
    const sectionHeaderId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Workspace',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    const descLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Configure this workspace.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Workspace Name label
    const nameLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Workspace Name',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Workspace Name input
    this.workspaceNameInputId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Workspace name',
        text: currentName,
      })
    ));
    await this.request(request(this.id, this.workspaceNameInputId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.workspaceNameInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Description label
    const descInputLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Description',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descInputLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Description input
    this.descriptionInputId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Workspace description',
        text: currentDescription,
      })
    ));
    await this.request(request(this.id, this.descriptionInputId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.descriptionInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Tags label
    const tagsLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Tags (comma-separated)',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: tagsLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Tags input
    this.tagsInputId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'e.g. art, tools, games',
        text: currentTags,
      })
    ));
    await this.request(request(this.id, this.tagsInputId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.tagsInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // ── Created Objects Section ──

    // Divider
    const divId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));

    // Section header
    const objHeaderId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Created Objects',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: objHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Fetch current exposed object IDs for checkbox state
    let generalExposedSet = new Set<string>();
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        const exposedIds = await this.request<string[]>(
          request(this.id, this.workspaceManagerId, 'getExposedObjects', { workspaceId: this.workspaceId })
        );
        generalExposedSet = new Set(exposedIds);
      } catch { /* not available */ }
    }

    if (snapshots.length === 0) {
      const emptyLabelId = this.trackTabWidget(await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No objects created yet.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      ));
      await this.request(request(this.id, cId, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const snap of snapshots) {
        // HBox row: exposed checkbox + name label + delete button
        const rowId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: cId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        ));
        await this.request(request(this.id, cId, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        // Exposed checkbox
        const exposedCbId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createCheckbox', {
            windowId: this.windowId, rect: r0,
            checked: generalExposedSet.has(snap.objectId),
            text: '',
          })
        ));
        await this.request(request(this.id, exposedCbId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: exposedCbId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 28, height: 28 },
        }));
        this.generalExposedCheckboxes.set(exposedCbId, snap.objectId);

        const objNameId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createLabel', {
            windowId: this.windowId, rect: r0, text: snap.manifest.name,
            style: { color: '#e2e4e9', fontSize: 13 },
          })
        ));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: objNameId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        const delBtnId = this.trackTabWidget(await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createButton', {
            windowId: this.windowId, rect: r0, text: 'Delete',
            style: { background: '#3a1f1f', color: '#ff6b6b', borderColor: '#ff6b6b', fontSize: 11 },
          })
        ));
        await this.request(request(this.id, delBtnId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: delBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 28 },
        }));

        this.objectDeleteButtons.set(delBtnId, snap.objectId);
      }
    }

    // Spacer pushes save button to bottom
    await this.request(request(this.id, cId, 'addLayoutSpacer', {}));

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
          request(this.id, this.workspaceManagerId, 'getAccessMode', { workspaceId: this.workspaceId })
        );
      } catch { /* default to local */ }
    }

    const cId = this.tabContentContainerId!;

    // Section header
    const sectionHeaderId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Access Control',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    const descLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Control who can access this workspace over the network.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Access Mode label
    const accessLabelId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Access Mode',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: accessLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Access Mode select dropdown
    const accessModeIndex = currentAccessMode === 'public' ? 2 : currentAccessMode === 'private' ? 1 : 0;
    this.accessModeSelectId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createSelect', {
        windowId: this.windowId, rect: r0,
        options: ['Local', 'Private', 'Public'],
        selectedIndex: accessModeIndex,
      })
    ));
    await this.request(request(this.id, this.accessModeSelectId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.accessModeSelectId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // ── Whitelist container (always present; populated only for Private mode) ──
    this.whitelistContainerId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.whitelistContainerId,
      sizePolicy: { vertical: 'preferred' },
    }));

    if (currentAccessMode === 'private') {
      await this.buildWhitelistSection(r0);
      // Set preferred height based on content: divider(1) + spacing(8) + header(20) + spacing(8) + desc(18) + spacing(8)
      // plus either "no contacts" label(18) or contact rows(28 each with 8px spacing between)
      const itemCount = this.whitelistCheckboxes.size;
      const baseHeight = 1 + 8 + 20 + 8 + 18 + 8;
      const itemsHeight = itemCount === 0
        ? 18  // "no contacts" label
        : (itemCount * 28) + ((itemCount - 1) * 8);
      await this.request(request(this.id, cId, 'updateLayoutChild', {
        widgetId: this.whitelistContainerId,
        preferredSize: { height: baseHeight + itemsHeight },
      }));
    }

    // ── Exposed Objects container (visible for private or public mode) ──
    this.exposedContainerId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.exposedContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    if (currentAccessMode !== 'local') {
      await this.buildExposedObjectsSection(r0);
    }

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
      request(this.id, this.widgetManagerId!, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    this.whitelistWidgetIds.push(divId);
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));

    // Section header
    const headerLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Allowed Contacts',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    this.whitelistWidgetIds.push(headerLabelId);
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: headerLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Description
    const descId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Select which contacts can access this workspace.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    this.whitelistWidgetIds.push(descId);
    await this.request(request(this.id, containerId, 'addLayoutChild', {
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
          request(this.id, this.peerRegistryId, 'listContacts', {})
        );
      } catch { /* PeerRegistry may not be ready */ }
    }

    // Get current whitelist
    let whitelist: string[] = [];
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        whitelist = await this.request<string[]>(
          request(this.id, this.workspaceManagerId, 'getWhitelist', { workspaceId: this.workspaceId })
        );
      } catch { /* whitelist not available yet */ }
    }

    if (contacts.length === 0) {
      const emptyLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No contacts available. Add contacts in Global Settings.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      );
      this.whitelistWidgetIds.push(emptyLabelId);
      await this.request(request(this.id, containerId, 'addLayoutChild', {
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
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: containerId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        this.whitelistWidgetIds.push(rowId);
        await this.request(request(this.id, containerId, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        const checkboxId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createCheckbox', {
            windowId: this.windowId, rect: r0,
            checked: isWhitelisted,
            text: displayName,
          })
        );
        await this.request(request(this.id, checkboxId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
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
        await this.request(request(this.id, this.whitelistContainerId, 'removeLayoutChild', { widgetId }));
      } catch { /* widget may already be gone */ }
      try {
        await this.request(request(this.id, widgetId, 'destroy', {}));
      } catch { /* best effort */ }
    }
    this.whitelistWidgetIds = [];
    this.whitelistCheckboxes.clear();
  }

  /**
   * Build the exposed objects section showing workspace objects as checkboxes.
   */
  private async buildExposedObjectsSection(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    const containerId = this.exposedContainerId!;

    // Divider
    const divId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    this.exposedWidgetIds.push(divId);
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));

    // Section header
    const headerLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Exposed Objects',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    this.exposedWidgetIds.push(headerLabelId);
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: headerLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Description
    const descId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Select which objects remote peers can access.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    this.exposedWidgetIds.push(descId);
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: descId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Get workspace objects from the workspace registry
    await this.ensureWorkspaceId();
    let registryObjects: Array<{ id: string; name: string; tags?: string[] }> = [];
    if (this.workspaceId && this.widgetManagerId) {
      // Get workspace registryId to query its objects
      try {
        const workspaces = await this.request<Array<{ workspaceId: string; childIds: string[] }>>(
          request(this.id, this.workspaceManagerId!, 'listWorkspacesDetailed', {})
        );
        const myWs = workspaces.find(w => w.workspaceId === this.workspaceId);
        if (myWs) {
          // Query the workspace registry for object names
          const registryId = await this.discoverDep('Registry');
          if (registryId) {
            try {
              const allObjects = await this.request<Array<{ id: string; name: string; manifest?: { tags?: string[] } }>>(
                request(this.id, registryId, 'list', {})
              );
              // Filter to only workspace child objects
              const childSet = new Set(myWs.childIds);
              registryObjects = allObjects
                .filter(o => childSet.has(o.id))
                .map(o => ({ id: o.id, name: o.name, tags: o.manifest?.tags }));
            } catch { /* registry query failed */ }
          }
        }
      } catch { /* workspace query failed */ }
    }

    // Build set of user-created object IDs from AbjectStore for reliable sorting
    const userObjectIdSet = new Set<string>();
    if (this.abjectStoreId) {
      try {
        const snapshots = await this.request<Array<{ objectId: string }>>(
          request(this.id, this.abjectStoreId, 'list', {})
        );
        for (const s of snapshots) userObjectIdSet.add(s.objectId);
      } catch { /* AbjectStore may not be ready */ }
    }

    // Sort: user-created objects first, then system objects, alphabetical within each group
    registryObjects.sort((a, b) => {
      const aUser = userObjectIdSet.has(a.id) ? 0 : 1;
      const bUser = userObjectIdSet.has(b.id) ? 0 : 1;
      if (aUser !== bUser) return aUser - bUser;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });

    // Get current exposed list
    let exposedIds: string[] = [];
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        exposedIds = await this.request<string[]>(
          request(this.id, this.workspaceManagerId, 'getExposedObjects', { workspaceId: this.workspaceId })
        );
      } catch { /* not available */ }
    }
    const exposedSet = new Set(exposedIds);

    if (registryObjects.length === 0) {
      const emptyLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No objects in workspace.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      );
      this.exposedWidgetIds.push(emptyLabelId);
      await this.request(request(this.id, containerId, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const obj of registryObjects) {
        const isExposed = exposedSet.has(obj.id);
        const displayName = obj.name || obj.id.slice(0, 16) + '...';

        const rowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: containerId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        this.exposedWidgetIds.push(rowId);
        await this.request(request(this.id, containerId, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        const checkboxId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createCheckbox', {
            windowId: this.windowId, rect: r0,
            checked: isExposed,
            text: displayName,
          })
        );
        await this.request(request(this.id, checkboxId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: checkboxId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        this.exposedCheckboxes.set(checkboxId, obj.id as AbjectId);
      }
    }
  }

  /**
   * Remove all widgets from the exposed objects container without destroying the container itself.
   */
  private async clearExposedObjectsSection(): Promise<void> {
    if (!this.exposedContainerId) return;
    for (const widgetId of this.exposedWidgetIds) {
      try {
        await this.request(request(this.id, this.exposedContainerId, 'removeLayoutChild', { widgetId }));
      } catch { /* widget may already be gone */ }
      try {
        await this.request(request(this.id, widgetId, 'destroy', {}));
      } catch { /* best effort */ }
    }
    this.exposedWidgetIds = [];
    this.exposedCheckboxes.clear();
  }

  /**
   * Build the save button row and status label at the bottom of a tab.
   */
  private async buildSaveRow(r0: { x: number; y: number; width: number; height: number }, tab: 'general' | 'access'): Promise<void> {
    const cId = this.tabContentContainerId!;

    const saveRowId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: saveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, saveRowId, 'addLayoutSpacer', {}));

    const btnId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    ));
    await this.request(request(this.id, btnId, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, 'addLayoutChild', {
      widgetId: btnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));

    const statusId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: '',
        style: { color: '#b4b8c8', fontSize: 12, align: 'right' },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
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
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.tabContentContainerId = undefined;
    this.tabContentWidgetIds = [];
    this.workspaceNameInputId = undefined;
    this.descriptionInputId = undefined;
    this.tagsInputId = undefined;
    this.accessModeSelectId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.accessSaveBtnId = undefined;
    this.accessStatusLabelId = undefined;
    this.objectDeleteButtons.clear();
    this.generalExposedCheckboxes.clear();
    this.whitelistCheckboxes.clear();
    this.whitelistContainerId = undefined;
    this.whitelistWidgetIds = [];
    this.exposedCheckboxes.clear();
    this.exposedContainerId = undefined;
    this.exposedWidgetIds = [];

    await this.changed('visibility', false);
    return true;
  }

  private async setControlsDisabled(disabled: boolean, ids: (AbjectId | undefined)[]): Promise<void> {
    const style = { disabled };
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
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
      request(this.id, this.workspaceNameInputId!, 'getValue', {})
    );

    // Validate non-empty
    if (!workspaceName || workspaceName.trim() === '') {
      if (this.statusLabelId) {
        await this.request(
          request(this.id, this.statusLabelId, 'update', {
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

    // Save workspace name, description, and tags
    if (this.workspaceManagerId && this.workspaceId) {
      await this.request(
        request(this.id, this.workspaceManagerId, 'renameWorkspace', {
          workspaceId: this.workspaceId,
          name: workspaceName.trim(),
        })
      );

      // Save description
      if (this.descriptionInputId) {
        try {
          const description = await this.request<string>(
            request(this.id, this.descriptionInputId, 'getValue', {})
          );
          await this.request(
            request(this.id, this.workspaceManagerId, 'setDescription', {
              workspaceId: this.workspaceId,
              description: description?.trim() ?? '',
            })
          );
        } catch { /* best effort */ }
      }

      // Save tags
      if (this.tagsInputId) {
        try {
          const tagsStr = await this.request<string>(
            request(this.id, this.tagsInputId, 'getValue', {})
          );
          const tags = (tagsStr ?? '').split(',').map(t => t.trim()).filter(t => t.length > 0);
          await this.request(
            request(this.id, this.workspaceManagerId, 'setTags', {
              workspaceId: this.workspaceId,
              tags,
            })
          );
        } catch { /* best effort */ }
      }

      // Save exposed objects from General tab checkboxes
      if (this.generalExposedCheckboxes.size > 0) {
        try {
          const objectIds: string[] = [];
          for (const [checkboxId, objectId] of this.generalExposedCheckboxes) {
            const checked = await this.request<string>(
              request(this.id, checkboxId, 'getValue', {})
            );
            if (checked === 'true') objectIds.push(objectId);
          }
          // Merge: preserve exposed objects that aren't user-created
          const currentExposed = await this.request<string[]>(
            request(this.id, this.workspaceManagerId!, 'getExposedObjects', { workspaceId: this.workspaceId! })
          );
          const userObjectIds = new Set(this.generalExposedCheckboxes.values());
          const nonUserExposed = currentExposed.filter(id => !userObjectIds.has(id));
          await this.request(
            request(this.id, this.workspaceManagerId!, 'setExposedObjects', {
              workspaceId: this.workspaceId!,
              objectIds: [...nonUserExposed, ...objectIds],
            })
          );
        } catch { /* best effort */ }
      }

      // Refresh WorkspaceSwitcher to show updated name
      if (!this.workspaceSwitcherId) {
        this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
      }
      if (this.workspaceSwitcherId) {
        try {
          const workspaces = await this.request<Array<{ id: string; name: string }>>(
            request(this.id, this.workspaceManagerId, 'listWorkspaces', {})
          );
          await this.request(
            request(this.id, this.workspaceSwitcherId, 'show', {
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
        request(this.id, this.statusLabelId, 'update', {
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
          request(this.id, this.accessModeSelectId, 'getValue', {})
        );
        const modeMap: Record<string, string> = { 'Local': 'local', 'Private': 'private', 'Public': 'public' };
        const accessMode = modeMap[selectedValue] ?? 'local';
        await this.request(
          request(this.id, this.workspaceManagerId, 'setAccessMode', {
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
                request(this.id, checkboxId, 'getValue', {})
              );
              if (checked === 'true') whitelist.push(peerId);
            } catch { /* checkbox gone */ }
          }
          await this.request(
            request(this.id, this.workspaceManagerId, 'setWhitelist', {
              workspaceId: this.workspaceId,
              whitelist,
            })
          );
        }

        // Save exposed objects if not local
        if (accessMode !== 'local' && this.exposedCheckboxes.size > 0) {
          const objectIds: string[] = [];
          for (const [checkboxId, objectId] of this.exposedCheckboxes) {
            try {
              const checked = await this.request<string>(
                request(this.id, checkboxId, 'getValue', {})
              );
              if (checked === 'true') objectIds.push(objectId);
            } catch { /* checkbox gone */ }
          }
          await this.request(
            request(this.id, this.workspaceManagerId, 'setExposedObjects', {
              workspaceId: this.workspaceId,
              objectIds,
            })
          );
        }
      } catch { /* access settings save failed */ }
    }

    // Show save feedback, then close
    const statusId = this.accessStatusLabelId;
    if (statusId) {
      await this.request(
        request(this.id, statusId, 'update', {
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
        request(this.id, this.abjectStoreId, 'remove', { objectId })
      );

      // Kill the live object via Factory
      const factoryId = await this.discoverDep('Factory');
      if (factoryId) {
        try {
          await this.request(
            request(this.id, factoryId, 'kill', { objectId: objectId as AbjectId })
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
