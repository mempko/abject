/**
 * Settings object - per-workspace configuration UI with General and Access tabs.
 *
 * Uses direct widget Abject interaction (createWindowAbject, createButton, etc.)
 * instead of the legacy string-based widget ID shim.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import {
  ThemePreset,
  DEFAULT_THEME_ID,
} from '../core/theme-data.js';

const log = new Log('SETTINGS');


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
  private activeTab: 'general' | 'access' | 'appearance' = 'general';
  private tabBarId?: AbjectId;

  // Appearance tab state
  private themeAbjectId?: AbjectId;
  private themeSwatches: Map<AbjectId, string> = new Map();  // swatchId → themeId
  private activeThemeNameLabelId?: AbjectId;
  private resetThemeBtnId?: AbjectId;
  private selectedThemeId: string = DEFAULT_THEME_ID;
  private appearancePresets: ThemePreset[] = [];

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
  private accessSearchInputId?: AbjectId;
  private accessSearchText = '';

  /** Pending access mode from dropdown change (used during tab rebuild). */
  private pendingAccessMode?: string;

  /** Delete workspace button in Danger Zone section. */
  private deleteWorkspaceBtnId?: AbjectId;

  /** Maps delete button AbjectId → object ID for "Created Objects" section. */
  private objectDeleteButtons: Map<AbjectId, string> = new Map();

  /** Maps checkbox AbjectId → object ID for "Exposed" checkboxes on General tab. */

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
    await this.fetchTheme();
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Settings Usage Guide

Settings provides a per-workspace configuration UI with General and Access tabs.

General tab: edit workspace name, description, tags, manage created objects, and
configure which objects are exposed to other peers.
Access tab: set access mode (public/private) and manage the peer whitelist.

### Show / hide the settings window

  await call(await dep('Settings'), 'show', {});
  await call(await dep('Settings'), 'hide', {});

### User interactions (handled internally)

- General tab: edit workspace name/description/tags, click "Save" to persist.
- General tab: view and delete created objects, toggle "exposed" checkboxes.
- Access tab: select access mode (public or private).
- Access tab: search and toggle peer whitelist entries (private mode).
- Danger Zone: delete the entire workspace.

### IMPORTANT
- The interface ID is '${SETTINGS_INTERFACE}'.
- Settings is a UI object with show/hide methods only; all configuration is done through the window.
- Changes are persisted via Storage and WorkspaceManager.`;
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

  /** Shared styling for section "cards" (theme-tracked surface + border). */
  private cardStyle(): { background: string; borderColor: string; radius: number } {
    return { background: this.theme.buttonBg, borderColor: this.theme.divider, radius: 8 };
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
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
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
    this.deleteWorkspaceBtnId = undefined;
    this.accessSaveBtnId = undefined;
    this.accessStatusLabelId = undefined;
    this.objectDeleteButtons.clear();
    this.whitelistCheckboxes.clear();
    this.whitelistContainerId = undefined;
    this.whitelistWidgetIds = [];
    this.exposedCheckboxes.clear();
    this.exposedContainerId = undefined;
    this.exposedWidgetIds = [];
    this.accessSearchInputId = undefined;
    this.accessSearchText = '';

    // Appearance tab refs
    this.themeSwatches.clear();
    this.activeThemeNameLabelId = undefined;
    this.resetThemeBtnId = undefined;
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
        this.activeTab = idx === 0 ? 'general' : idx === 1 ? 'access' : 'appearance';
        await this.clearTabContent();
        const r0 = { x: 0, y: 0, width: 0, height: 0 };
        if (this.activeTab === 'general') {
          await this.buildGeneralTab(r0);
        } else if (this.activeTab === 'access') {
          await this.buildAccessTab(r0);
        } else {
          await this.buildAppearanceTab();
        }
        return;
      }

      // Appearance tab — theme swatch click
      if (this.themeSwatches.has(fromId) && aspect === 'click') {
        const newId = this.themeSwatches.get(fromId)!;
        await this.applySelectedTheme(newId);
        return;
      }

      // Appearance tab — reset button
      if (fromId === this.resetThemeBtnId && aspect === 'click') {
        await this.applySelectedTheme(DEFAULT_THEME_ID);
        return;
      }

      // Appearance tab — preset list updated (user theme registered/removed)
      if (fromId === this.themeAbjectId && aspect === 'presetsChanged' && this.activeTab === 'appearance') {
        await this.clearTabContent();
        await this.buildAppearanceTab();
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

      // Delete workspace button
      if (fromId === this.deleteWorkspaceBtnId && aspect === 'click') {
        await this.handleDeleteWorkspace();
        return;
      }

      // Handle delete button clicks for created objects
      if (aspect === 'click' && this.objectDeleteButtons.has(fromId)) {
        const objectId = this.objectDeleteButtons.get(fromId)!;
        await this.deleteCreatedObject(objectId);
        return;
      }

      // Search input change — filter exposed objects
      if (fromId === this.accessSearchInputId && aspect === 'change') {
        this.accessSearchText = ((value as string) ?? '').toLowerCase();
        await this.clearExposedObjectsSection();
        const r0 = { x: 0, y: 0, width: 0, height: 0 };
        await this.buildExposedObjectsSection(r0);
        return;
      }

      // Access mode dropdown change — rebuild the entire tab for clean layout
      if (fromId === this.accessModeSelectId && aspect === 'change') {
        const modeMap: Record<string, string> = { 'Local': 'local', 'Private': 'private', 'Public': 'public' };
        const newMode = modeMap[value as string] ?? 'local';
        // Stash the selected mode so buildAccessTab picks it up
        this.pendingAccessMode = newMode;
        await this.clearTabContent();
        const r0 = { x: 0, y: 0, width: 0, height: 0 };
        await this.buildAccessTab(r0);
        this.pendingAccessMode = undefined;
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
    const winH = 620;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Workspace Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
        resizable: true,
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
    const { widgetIds: [tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [{
        type: 'tabBar', windowId: this.windowId,
        tabs: ['General', 'Access', 'Appearance'],
        selectedIndex: this.activeTab === 'general' ? 0 : this.activeTab === 'access' ? 1 : 2,
      }] })
    );
    this.tabBarId = tabBarId;
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Create tab content container (scrollable VBox that holds all tab content)
    this.tabContentContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
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
    } else if (this.activeTab === 'access') {
      await this.buildAccessTab(r0);
    } else {
      await this.buildAppearanceTab();
    }

    this.changed('visibility', true);
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

    const cId = this.tabContentContainerId!;

    // Batch-create all General tab header widgets
    const { widgetIds: [sectionHeaderId, descLabelId, nameLabelId, nameInputId, descInputLabelId, descInputId, tagsLabelId, tagsInputId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Workspace', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId, text: 'Configure this workspace.', style: { color: this.theme.textDescription, fontSize: 12 } },
        { type: 'label', windowId: this.windowId, text: 'Workspace Name', style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'textInput', windowId: this.windowId, placeholder: 'Workspace name', text: currentName },
        { type: 'label', windowId: this.windowId, text: 'Description', style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'textInput', windowId: this.windowId, placeholder: 'Workspace description', text: currentDescription },
        { type: 'label', windowId: this.windowId, text: 'Tags (comma-separated)', style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. art, tools, games', text: currentTags },
      ] })
    );
    this.trackTabWidget(sectionHeaderId);
    this.trackTabWidget(descLabelId);
    this.trackTabWidget(nameLabelId);
    this.workspaceNameInputId = this.trackTabWidget(nameInputId);
    this.trackTabWidget(descInputLabelId);
    this.descriptionInputId = this.trackTabWidget(descInputId);
    this.trackTabWidget(tagsLabelId);
    this.tagsInputId = this.trackTabWidget(tagsInputId);

    // "Workspace" section card: a styled sub-VBox that sizes to its children.
    const wsCard = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: cId,
        margins: { top: 12, right: 14, bottom: 12, left: 14 },
        spacing: 6,
        style: this.cardStyle(),
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: wsCard,
      sizePolicy: { vertical: 'preferred', horizontal: 'expanding' },
    }));

    // Section header: "Workspace"
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Workspace Name label
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Workspace Name input
    await this.request(request(this.id, this.workspaceNameInputId, 'addDependent', {}));
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: this.workspaceNameInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Description label
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: descInputLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Description input
    await this.request(request(this.id, this.descriptionInputId, 'addDependent', {}));
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: this.descriptionInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Tags label
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: tagsLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Tags input
    await this.request(request(this.id, this.tagsInputId, 'addDependent', {}));
    await this.request(request(this.id, wsCard, 'addLayoutChild', {
      widgetId: this.tagsInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Save button row + status label
    await this.buildSaveRow(r0, 'general');

    // ── Danger Zone ──
    await this.buildDangerZone();
  }

  /**
   * Build the Access tab: access mode selector + whitelist for private mode + save button.
   */
  private async buildAccessTab(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    // Get current access mode (use pending mode from dropdown if rebuilding after change)
    let currentAccessMode = this.pendingAccessMode ?? 'local';
    if (!this.pendingAccessMode && this.workspaceManagerId && this.workspaceId) {
      try {
        currentAccessMode = await this.request<string>(
          request(this.id, this.workspaceManagerId, 'getAccessMode', { workspaceId: this.workspaceId })
        );
      } catch { /* default to local */ }
    }

    const cId = this.tabContentContainerId!;

    // Batch-create all Access tab header widgets
    const accessModeIndex = currentAccessMode === 'public' ? 2 : currentAccessMode === 'private' ? 1 : 0;
    const { widgetIds: [sectionHeaderId, descLabelId, accessLabelId, accessSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Access Control', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId, text: 'Control who can access this workspace over the network.', style: { color: this.theme.textDescription, fontSize: 12 } },
        { type: 'label', windowId: this.windowId, text: 'Access Mode', style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'select', windowId: this.windowId, options: ['Local', 'Private', 'Public'], selectedIndex: accessModeIndex },
      ] })
    );
    this.trackTabWidget(sectionHeaderId);
    this.trackTabWidget(descLabelId);
    this.trackTabWidget(accessLabelId);
    this.accessModeSelectId = this.trackTabWidget(accessSelectId);

    // Section header
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Access Mode label
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: accessLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Access Mode select dropdown
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

    // ── Search input for exposed objects (hidden in local mode) ──
    const searchVisible = currentAccessMode !== 'local';
    const { widgetIds: [searchId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Search objects...', style: { visible: searchVisible } },
      ] })
    );
    this.accessSearchInputId = this.trackTabWidget(searchId);
    await this.request(request(this.id, this.accessSearchInputId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.accessSearchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: searchVisible ? 30 : 0 },
    }));

    // ── Exposed Objects container (hidden in local mode) ──
    this.exposedContainerId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.exposedContainerId,
      sizePolicy: { vertical: searchVisible ? 'expanding' : 'fixed', horizontal: 'expanding' },
      preferredSize: searchVisible ? undefined : { height: 0 },
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

    // Batch-create whitelist section header widgets
    const { widgetIds: [divId, headerLabelId, descId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'divider', windowId: this.windowId },
        { type: 'label', windowId: this.windowId, text: 'Allowed Contacts', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
        { type: 'label', windowId: this.windowId, text: 'Select which contacts can access this workspace.', style: { color: this.theme.textDescription, fontSize: 12 } },
      ] })
    );
    this.whitelistWidgetIds.push(divId, headerLabelId, descId);

    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: headerLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
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
      const { widgetIds: [emptyLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'No contacts available. Add contacts in Global Settings.', style: { color: this.theme.textDescription, fontSize: 12 } },
        ] })
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

        const { widgetIds: [checkboxId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'checkbox', windowId: this.windowId, checked: isWhitelisted, text: displayName },
          ] })
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

    // Batch-create exposed objects section header widgets
    const { widgetIds: [divId, headerLabelId, descId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'divider', windowId: this.windowId },
        { type: 'label', windowId: this.windowId, text: 'Exposed Objects', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
        { type: 'label', windowId: this.windowId, text: 'Select which objects remote peers can access.', style: { color: this.theme.textDescription, fontSize: 12 } },
      ] })
    );
    this.exposedWidgetIds.push(divId, headerLabelId, descId);

    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: headerLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
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

    // Filter by search text
    if (this.accessSearchText) {
      registryObjects = registryObjects.filter(obj =>
        (obj.name || obj.id).toLowerCase().includes(this.accessSearchText)
      );
    }

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
      const { widgetIds: [emptyLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'No objects in workspace.', style: { color: this.theme.textDescription, fontSize: 12 } },
        ] })
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

        const isUserCreated = userObjectIdSet.has(obj.id);
        const specs: Array<{ type: string; windowId: AbjectId; text: string; checked?: boolean; style?: Record<string, unknown> }> = [
          { type: 'checkbox', windowId: this.windowId!, text: displayName, checked: isExposed },
        ];
        if (isUserCreated) {
          specs.push({ type: 'button', windowId: this.windowId!, text: 'Delete', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } });
        }

        const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs })
        );
        const checkboxId = widgetIds[0];
        this.exposedWidgetIds.push(checkboxId);
        await this.request(request(this.id, checkboxId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: checkboxId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        this.exposedCheckboxes.set(checkboxId, obj.id as AbjectId);

        if (isUserCreated) {
          const delBtnId = widgetIds[1];
          this.exposedWidgetIds.push(delBtnId);
          await this.request(request(this.id, delBtnId, 'addDependent', {}));
          await this.request(request(this.id, rowId, 'addLayoutChild', {
            widgetId: delBtnId,
            sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
            preferredSize: { width: 70, height: 28 },
          }));
          this.objectDeleteButtons.set(delBtnId, obj.id);
        }
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
    this.objectDeleteButtons.clear();
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

    // Batch-create save button and status label
    const { widgetIds: [btnId, statusId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textDescription, fontSize: 12, align: 'right', selectable: true } },
      ] })
    );
    this.trackTabWidget(btnId);
    this.trackTabWidget(statusId);

    await this.request(request(this.id, btnId, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, 'addLayoutChild', {
      widgetId: btnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));
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
    this.deleteWorkspaceBtnId = undefined;
    this.accessSaveBtnId = undefined;
    this.accessStatusLabelId = undefined;
    this.objectDeleteButtons.clear();
    this.whitelistCheckboxes.clear();
    this.whitelistContainerId = undefined;
    this.whitelistWidgetIds = [];
    this.exposedCheckboxes.clear();
    this.exposedContainerId = undefined;
    this.exposedWidgetIds = [];
    this.accessSearchInputId = undefined;
    this.accessSearchText = '';

    this.changed('visibility', false);
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
            style: { color: this.theme.statusErrorBright },
          })
        );
      }
      await this.notify('Workspace name cannot be empty', 'warning');
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
          style: { color: this.theme.textDescription },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await this.notify('Workspace settings saved', 'success');
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
          // Read checked state from visible checkboxes
          const visibleObjectIds = new Set(this.exposedCheckboxes.values());
          const checkedIds: string[] = [];
          for (const [checkboxId, objectId] of this.exposedCheckboxes) {
            try {
              const checked = await this.request<string>(
                request(this.id, checkboxId, 'getValue', {})
              );
              if (checked === 'true') checkedIds.push(objectId);
            } catch { /* checkbox gone */ }
          }

          // Preserve exposed state for objects not currently shown (filtered out by search)
          const currentExposed = await this.request<string[]>(
            request(this.id, this.workspaceManagerId, 'getExposedObjects', { workspaceId: this.workspaceId! })
          );
          const preservedIds = currentExposed.filter(id => !visibleObjectIds.has(id as AbjectId));

          await this.request(
            request(this.id, this.workspaceManagerId, 'setExposedObjects', {
              workspaceId: this.workspaceId,
              objectIds: [...preservedIds, ...checkedIds],
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
          style: { color: this.theme.textDescription },
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await this.hide();
  }

  /**
   * Build the Danger Zone section at the bottom of the General tab.
   */
  private async buildDangerZone(): Promise<void> {
    const cId = this.tabContentContainerId!;

    // Danger Zone card (danger-tinted border replaces the old divider).
    const dangerCard = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: cId,
        margins: { top: 12, right: 14, bottom: 12, left: 14 },
        spacing: 6,
        style: { background: this.theme.buttonBg, borderColor: this.theme.destructiveBorder, radius: 8 },
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: dangerCard,
      sizePolicy: { vertical: 'preferred', horizontal: 'expanding' },
    }));

    // Section header + description
    const { widgetIds: [headerLabelId, descId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Danger Zone', style: { color: this.theme.destructiveText, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId, text: 'Permanently delete this workspace and all its objects.', style: { color: this.theme.textDescription, fontSize: 12 } },
      ] })
    );
    this.trackTabWidget(headerLabelId);
    this.trackTabWidget(descId);

    await this.request(request(this.id, dangerCard, 'addLayoutChild', {
      widgetId: headerLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));
    await this.request(request(this.id, dangerCard, 'addLayoutChild', {
      widgetId: descId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Delete button row (right-aligned)
    const deleteRowId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: dangerCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, dangerCard, 'addLayoutChild', {
      widgetId: deleteRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, deleteRowId, 'addLayoutSpacer', {}));

    const { widgetIds: [deleteBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Delete Workspace', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder } },
      ] })
    );
    this.deleteWorkspaceBtnId = this.trackTabWidget(deleteBtnId);
    await this.request(request(this.id, this.deleteWorkspaceBtnId, 'addDependent', {}));
    await this.request(request(this.id, deleteRowId, 'addLayoutChild', {
      widgetId: this.deleteWorkspaceBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 160, height: 36 },
    }));
  }

  /**
   * Handle "Delete Workspace" button click: confirm, then delete.
   */
  private async handleDeleteWorkspace(): Promise<void> {
    await this.ensureWorkspaceId();
    if (!this.workspaceManagerId || !this.workspaceId) return;

    // Get workspace name for the dialog
    let workspaceName = 'this workspace';
    try {
      const active = await this.request<{ id: string; name: string } | null>(
        request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
      );
      if (active) workspaceName = active.name;
    } catch { /* use fallback */ }

    const confirmed = await this.confirm({
      title: 'Delete Workspace',
      message: `Delete workspace "${workspaceName}"? All objects in it will be destroyed.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    if (this.deleteWorkspaceBtnId) {
      this.send(event(this.id, this.deleteWorkspaceBtnId, 'update', { busy: true }));
    }
    try {
      await this.request(
        request(this.id, this.workspaceManagerId, 'deleteWorkspace', { workspaceId: this.workspaceId })
      );
      await this.notify(`Workspace "${workspaceName}" deleted`, 'success');
      await this.hide();
    } catch (err) {
      // Guard: if Settings was killed mid-handler (e.g. workspace deletion destroyed us),
      // don't attempt requests on a stopped object.
      if (this._status === 'stopped') return;
      const msg = err instanceof Error ? err.message : String(err);
      // Last workspace can't be deleted
      if (this.statusLabelId) {
        try {
          await this.request(
            request(this.id, this.statusLabelId, 'update', {
              text: msg.slice(0, 60),
              style: { color: this.theme.statusErrorBright },
            })
          );
        } catch { /* widget may be gone */ }
      }
      await this.notify(`Delete failed: ${msg.slice(0, 80)}`, 'error');
      if (this.deleteWorkspaceBtnId) {
        this.send(event(this.id, this.deleteWorkspaceBtnId, 'update', { busy: false }));
      }
    }
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
      log.warn('Failed to delete object:', err);
    }

    // Rebuild tab content to reflect the change (without destroying window)
    await this.clearTabContent();
    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    if (this.activeTab === 'general') {
      await this.buildGeneralTab(r0);
    } else if (this.activeTab === 'access') {
      await this.buildAccessTab(r0);
    } else {
      await this.buildAppearanceTab();
    }
  }

  /**
   * Build the Appearance tab: header, current-theme label, swatch grid, reset button.
   */
  private async buildAppearanceTab(): Promise<void> {
    const cId = this.tabContentContainerId!;

    // Discover (and remember) the Theme abject so we can subscribe to its events.
    if (!this.themeAbjectId) {
      this.themeAbjectId = await this.discoverDep('Theme') ?? undefined;
      if (this.themeAbjectId) {
        try {
          await this.request(request(this.id, this.themeAbjectId, 'addDependent', {}));
        } catch { /* best effort */ }
      }
    }

    // Pull preset list and active id from Theme.
    let presets: ThemePreset[] = [];
    let activeId: string = DEFAULT_THEME_ID;
    if (this.themeAbjectId) {
      try {
        presets = await this.request<ThemePreset[]>(
          request(this.id, this.themeAbjectId, 'listPresets', {})
        );
      } catch { /* fall through with empty list */ }
      try {
        activeId = await this.request<string>(
          request(this.id, this.themeAbjectId, 'getActiveThemeId', {})
        );
      } catch { /* keep default */ }
    }
    this.appearancePresets = presets;
    this.selectedThemeId = activeId;

    const activeName = presets.find((p) => p.id === activeId)?.name ?? 'Custom';

    // Section header + description + active-theme label.
    const { widgetIds: [headerId, descId, activeLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Theme',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId,
          text: 'Choose how this workspace looks. Changes apply immediately.',
          style: { color: this.theme.textDescription, fontSize: 12 } },
        { type: 'label', windowId: this.windowId, text: `Active: ${activeName}`,
          style: { color: this.theme.textMeta, fontSize: 12 } },
      ] })
    );
    this.trackTabWidget(headerId);
    this.trackTabWidget(descId);
    this.activeThemeNameLabelId = this.trackTabWidget(activeLabelId);

    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: headerId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.activeThemeNameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Render swatches: built-ins first, then a divider, then user presets.
    const builtins = presets.filter((p) => p.builtin);
    const userThemes = presets.filter((p) => !p.builtin);

    await this.renderSwatchGrid(cId, builtins);

    if (userThemes.length > 0) {
      const { widgetIds: [divId, userHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'divider', windowId: this.windowId },
          { type: 'label', windowId: this.windowId, text: 'Your themes',
            style: { color: this.theme.sectionLabel, fontSize: 12, fontWeight: 'bold' } },
        ] })
      );
      this.trackTabWidget(divId);
      this.trackTabWidget(userHeaderId);
      await this.request(request(this.id, cId, 'addLayoutChild', {
        widgetId: divId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 1 },
      }));
      await this.request(request(this.id, cId, 'addLayoutChild', {
        widgetId: userHeaderId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
      await this.renderSwatchGrid(cId, userThemes);
    }

    // Reset to default button.
    const { widgetIds: [resetBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Reset to default',
          style: { background: this.theme.buttonBg, color: this.theme.buttonText } },
      ] })
    );
    this.resetThemeBtnId = this.trackTabWidget(resetBtnId);
    await this.request(request(this.id, this.resetThemeBtnId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.resetThemeBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
  }

  /**
   * Render a 2-column row-of-rows grid of theme swatches inside the given parent layout.
   */
  private async renderSwatchGrid(parentId: AbjectId, presets: ThemePreset[]): Promise<void> {
    const COLS = 2;
    const SWATCH_H = 110;

    for (let i = 0; i < presets.length; i += COLS) {
      const rowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: parentId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 10,
        })
      );
      this.trackTabWidget(rowId);
      await this.request(request(this.id, parentId, 'addLayoutChild', {
        widgetId: rowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: SWATCH_H },
      }));

      for (let c = 0; c < COLS; c++) {
        const preset = presets[i + c];
        if (!preset) break;
        const { widgetIds: [swatchId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [{
            type: 'themeSwatch', windowId: this.windowId,
            themeId: preset.id,
            themeName: preset.name,
            previewTheme: preset.theme,
            selected: preset.id === this.selectedThemeId,
          }] })
        );
        this.themeSwatches.set(swatchId, preset.id);
        this.trackTabWidget(swatchId);
        await this.request(request(this.id, swatchId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: swatchId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: SWATCH_H },
        }));
      }
    }
  }

  /**
   * Apply the selected theme by id and refresh visual selection state without
   * tearing down the tab — the swatches keep showing their preset colours,
   * only their selection ring (which uses the *active* theme accent) flips.
   */
  private async applySelectedTheme(newId: string): Promise<void> {
    if (!this.themeAbjectId) {
      this.themeAbjectId = await this.discoverDep('Theme') ?? undefined;
    }
    if (!this.themeAbjectId) return;

    try {
      await this.request(
        request(this.id, this.themeAbjectId, 'setThemeById', { id: newId })
      );
    } catch (err) {
      log.warn('setThemeById failed:', err);
      return;
    }

    this.selectedThemeId = newId;

    // Update the "Active: …" label.
    const newName = this.appearancePresets.find((p) => p.id === newId)?.name ?? newId;
    if (this.activeThemeNameLabelId) {
      try {
        await this.request(request(this.id, this.activeThemeNameLabelId, 'update', {
          text: `Active: ${newName}`,
        }));
      } catch { /* widget may have been disposed */ }
    }

    // Move the selection ring to the right swatch.
    for (const [swatchId, themeId] of this.themeSwatches.entries()) {
      try {
        await this.request(request(this.id, swatchId, 'update', {
          selected: themeId === newId,
        }));
      } catch { /* gone */ }
    }
  }
}

// Well-known settings ID
export const SETTINGS_ID = 'abjects:settings' as AbjectId;
