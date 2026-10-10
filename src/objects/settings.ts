/**
 * Settings object - per-workspace configuration UI with General and Access tabs.
 *
 * Uses direct widget Abject interaction (createWindowAbject, createButton, etc.)
 * instead of the legacy string-based widget ID shim.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import {
  ThemePreset,
  DEFAULT_THEME_ID,
} from '../core/theme-data.js';
import {
  sectionHeaderStyle,
  sectionHeaderText,
  hintStyle,
  emptyStateMarkdown,
  emptyStateStyle,
  livingStyle,
} from './ui-kit.js';

const log = new Log('SETTINGS');

/** Row height for an empty-state markdown label (title, gap, one hint line). */
const EMPTY_STATE_HEIGHT = 64;


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
  private activeTab: 'general' | 'access' | 'web' | 'appearance' = 'general';
  // Web tab state
  private webEnableCheckboxId?: AbjectId;
  private webSaveBtnId?: AbjectId;
  private webStatusLabelId?: AbjectId;
  private webExposeCheckboxes = new Map<AbjectId, string>();
  private webAccessSelects = new Map<AbjectId, string>();
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
  private identityId?: AbjectId;
  private clipboardId?: AbjectId;
  private shareLinkText = '';
  private copyShareLinkBtnId?: AbjectId;
  private invitePeerInputId?: AbjectId;
  private invitePeerBtnId?: AbjectId;
  private inviteStatusLabelId?: AbjectId;
  private invitedPeersRevokeButtons: Map<AbjectId, string> = new Map();

  /** Pending access mode from dropdown change (used during tab rebuild). */
  private pendingAccessMode?: string;

  /** Delete workspace button in Danger Zone section. */
  private deleteWorkspaceBtnId?: AbjectId;

  /**
   * Whether the active workspace is one joined from a peer rather than one we
   * own. Decided while the Danger Zone is built and read by the button's click
   * handler, so a single button drives either "Leave" or "Delete".
   */
  private activeWorkspaceIsJoined = false;

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
        tags: ['system', 'ui', 'settings'],
      },
    });

    this.setupHandlers();
  }


  /** Destructive text on the window ground (destructiveText is meant for the destructive face). */
  private dangerTextColor(): string {
    return this.theme.statusError;
  }

  /**
   * Section header label spec from the shared kit.
   */
  private headerSpec(text: string, size = 13, color?: string): Record<string, unknown> {
    const style = sectionHeaderStyle(this.theme, size);
    return { type: 'label', windowId: this.windowId, text: sectionHeaderText(this.theme, text), style: color ? { ...style, color } : style };
  }

  /** Helper-text label spec (kit hint style). */
  private hintSpec(text: string): Record<string, unknown> {
    return { type: 'label', windowId: this.windowId, text, style: hintStyle(this.theme) };
  }

  /**
   * Empty-state label spec: the kit's markdown empty state (title plus what
   * to do next). Lay it out at EMPTY_STATE_HEIGHT.
   */
  private emptySpec(title: string, hint: string): Record<string, unknown> {
    return { type: 'label', windowId: this.windowId, text: emptyStateMarkdown(title, hint), style: emptyStateStyle(this.theme) };
  }

  /** Play a slab effect on the settings window (visual only, fire and forget). */
  private windowEffect(effect: 'shake' | 'flash'): void {
    if (!this.windowId) return;
    this.request(request(this.id, this.windowId, 'effect', { effect }))
      .catch(() => { /* effects are decoration */ });
  }

  /** Write a status line (if it is on screen); errors use the bright error colour. */
  private async setStatusLine(labelId: AbjectId | undefined, text: string, error = false): Promise<void> {
    if (!labelId) return;
    try {
      await this.request(request(this.id, labelId, 'update', {
        text,
        style: error ? { color: this.theme.statusErrorBright } : { color: this.theme.textDescription },
      }));
    } catch { /* widget gone */ }
  }

  /** One-line explanation of an access mode, shown under the mode select. */
  private accessModeHint(mode: string): string {
    if (mode === 'public') return 'Public: any peer can reach the objects you tick below.';
    if (mode === 'shared') return 'Shared: invited peers collaborate on every object here.';
    return 'Local: this workspace stays on this desktop only.';
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    this.identityId = await this.discoverDep('Identity') ?? undefined;
    this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
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

  /**
   * A grouped card for one settings section (WidgetManager createSection:
   * ruled panel, sigil title, wrap-friendly hint) laid out in `parentId`.
   * Add the section's rows to the returned sectionId, not to the parent, and
   * track the sectionId with whichever container owns it. Cards size to their
   * content inside a ScrollableVBox; `expanding` fills the space left over.
   */
  private async sectionCard(
    parentId: AbjectId,
    title: string,
    description?: string,
    hintHeight = 18,
    expanding = false,
  ): Promise<{ sectionId: AbjectId; titleId: AbjectId }> {
    return this.request<{ sectionId: AbjectId; titleId: AbjectId }>(
      request(this.id, this.widgetManagerId!, 'createSection', {
        parentLayoutId: parentId,
        windowId: this.windowId,
        title,
        ...(description ? { description, hintHeight } : {}),
        expanding,
      })
    );
  }

  /** Tint a section card as a danger zone: destructive rule and title (theme slots, so it re-skins). */
  private async tintDangerSection(sectionId: AbjectId, titleId: AbjectId): Promise<void> {
    try {
      await this.request(request(this.id, sectionId, 'update', { style: { borderColor: this.theme.destructiveBorder } }));
      await this.request(request(this.id, titleId, 'update', { style: { color: this.dangerTextColor() } }));
    } catch { /* decoration only */ }
  }

  /** Field label spec (the name above an input inside a card). */
  private fieldLabelSpec(text: string): Record<string, unknown> {
    return { type: 'label', windowId: this.windowId, text, style: { color: this.theme.textHeading, fontSize: 13 } };
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
    this.copyShareLinkBtnId = undefined;
    this.invitePeerInputId = undefined;
    this.invitePeerBtnId = undefined;
    this.inviteStatusLabelId = undefined;
    this.invitedPeersRevokeButtons.clear();
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
        this.activeTab = idx === 0 ? 'general' : idx === 1 ? 'access' : idx === 2 ? 'web' : 'appearance';
        await this.clearTabContent();
        const r0 = { x: 0, y: 0, width: 0, height: 0 };
        if (this.activeTab === 'general') {
          await this.buildGeneralTab(r0);
        } else if (this.activeTab === 'access') {
          await this.buildAccessTab(r0);
        } else if (this.activeTab === 'web') {
          await this.buildWebTab(r0);
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

      if (fromId === this.webSaveBtnId && aspect === 'click') {
        await this.saveWebSettings();
        return;
      }

      // Copy share link button
      if (fromId === this.copyShareLinkBtnId && aspect === 'click') {
        if (!this.clipboardId) {
          this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
        }
        if (this.clipboardId && this.shareLinkText) {
          try {
            await this.request(
              request(this.id, this.clipboardId, 'write', { text: this.shareLinkText })
            );
            if (this.inviteStatusLabelId) {
              await this.request(
                request(this.id, this.inviteStatusLabelId, 'update', {
                  text: 'Share link copied to clipboard!',
                  style: { color: this.theme.textHeading },
                })
              );
            }
          } catch {
            this.windowEffect('shake');
            await this.setStatusLine(this.inviteStatusLabelId, 'Could not copy the link. Select it and copy by hand.', true);
          }
        }
        return;
      }

      // Invite peer button
      if (fromId === this.invitePeerBtnId && aspect === 'click') {
        await this.handleInvitePeer();
        return;
      }

      // Revoke invited peer button
      if (fromId && this.invitedPeersRevokeButtons.has(fromId) && aspect === 'click') {
        const peerId = this.invitedPeersRevokeButtons.get(fromId)!;
        await this.handleRevokePeer(peerId);
        return;
      }

      // Text input submit triggers save
      if (aspect === 'submit') {
        if (fromId === this.invitePeerInputId) {
          await this.handleInvitePeer();
          return;
        }
        if (this.activeTab === 'general') {
          await this.saveGeneralSettings();
        } else {
          await this.saveAccessSettings();
        }
        return;
      }

      // Delete workspace button
      if (fromId === this.deleteWorkspaceBtnId && aspect === 'click') {
        if (this.activeWorkspaceIsJoined) {
          await this.handleLeaveWorkspace();
        } else {
          await this.handleDeleteWorkspace();
        }
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
        const modeMap: Record<string, string> = { 'Local': 'local', 'Shared': 'shared', 'Public': 'public' };
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
        tabs: ['General', 'Access', 'Web', 'Appearance'],
        selectedIndex: this.activeTab === 'general' ? 0 : this.activeTab === 'access' ? 1 : this.activeTab === 'web' ? 2 : 3,
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
    } else if (this.activeTab === 'web') {
      await this.buildWebTab(r0);
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

    // Batch-create the General tab's fields
    const { widgetIds: [nameLabelId, nameInputId, descInputLabelId, descInputId, tagsLabelId, tagsInputId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        this.fieldLabelSpec('Workspace Name'),
        { type: 'textInput', windowId: this.windowId, placeholder: 'Workspace name', text: currentName },
        this.fieldLabelSpec('Description'),
        { type: 'textInput', windowId: this.windowId, placeholder: 'Workspace description', text: currentDescription },
        this.fieldLabelSpec('Tags (comma-separated)'),
        { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. art, tools, games', text: currentTags },
      ] })
    );
    this.trackTabWidget(nameLabelId);
    this.workspaceNameInputId = this.trackTabWidget(nameInputId);
    this.trackTabWidget(descInputLabelId);
    this.descriptionInputId = this.trackTabWidget(descInputId);
    this.trackTabWidget(tagsLabelId);
    this.tagsInputId = this.trackTabWidget(tagsInputId);

    // ── Workspace (card): the fields and their Save ──
    const { sectionId: wsCardId } = await this.sectionCard(cId, 'Workspace',
      'Name and describe this workspace so peers can find it.');
    const wsCard = this.trackTabWidget(wsCardId);

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

    // Save button row + status label: the card's primary action
    await this.buildSaveRow(r0, 'general', wsCard);

    // ── Danger zone (card, last) ──
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

    // P2-3: a public workspace the user never curated publishes nothing beyond
    // the registry itself. That is a safe default but an invisible one, so the
    // Access tab has to say it out loud rather than show an empty whitelist
    // that looks like a rendering failure. WorkspaceManager stamps the flag on
    // every record it lists (`uncuratedPublic`).
    let uncuratedPublic = false;
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        const detailed = await this.request<Array<{ workspaceId: string; uncuratedPublic?: boolean }>>(
          request(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {})
        );
        const mine = Array.isArray(detailed)
          ? detailed.find((w) => w.workspaceId === this.workspaceId)
          : undefined;
        uncuratedPublic = mine?.uncuratedPublic === true;
      } catch { /* absent flag simply means no notice */ }
    }

    const cId = this.tabContentContainerId!;

    // A joined workspace is a local mirror of one a peer hosts. It deliberately
    // keeps `accessMode: 'local'` so restart recovery never re-advertises it as
    // ours (see WorkspaceInfo.joined), which makes the mode alone misleading
    // here: the editable "Local" select would invite the user to change access
    // on a workspace they do not own. Present read-only joined status instead.
    let joinedOwnerPeerId: string | undefined;
    let isJoinedWorkspace = false;
    if (this.workspaceManagerId) {
      try {
        const active = await this.request<{ id: string; joined?: boolean; ownerPeerId?: string } | null>(
          request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
        );
        // Settings is per-workspace, so only borrow the active record's
        // `joined` when the active workspace is in fact this tab's workspace.
        if (active && active.joined === true && (!this.workspaceId || active.id === this.workspaceId)) {
          isJoinedWorkspace = true;
          joinedOwnerPeerId = active.ownerPeerId;
        }
      } catch { /* fall back to the editable presentation */ }
    }

    if (isJoinedWorkspace) {
      await this.buildJoinedAccessSection(cId, joinedOwnerPeerId);
      return;
    }

    // Batch-create the access mode field
    const accessModeIndex = currentAccessMode === 'public' ? 2 : currentAccessMode === 'shared' ? 1 : 0;
    const { widgetIds: [accessLabelId, accessSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        this.fieldLabelSpec('Access Mode'),
        { type: 'select', windowId: this.windowId, options: ['Local', 'Shared', 'Public'], selectedIndex: accessModeIndex },
      ] })
    );
    this.trackTabWidget(accessLabelId);
    this.accessModeSelectId = this.trackTabWidget(accessSelectId);

    // ── Access level (card): the mode select, with a hint naming what the
    // chosen mode means ──
    const { sectionId: modeCardId } = await this.sectionCard(cId, 'Access level',
      'Control who can access this workspace over the network.');
    const modeParent: AbjectId = this.trackTabWidget(modeCardId);

    // Access Mode label
    await this.request(request(this.id, modeParent, 'addLayoutChild', {
      widgetId: accessLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Access Mode select dropdown
    await this.request(request(this.id, this.accessModeSelectId, 'addDependent', {}));
    await this.request(request(this.id, modeParent, 'addLayoutChild', {
      widgetId: this.accessModeSelectId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [modeHintId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [this.hintSpec(this.accessModeHint(currentAccessMode))] })
    );
    this.trackTabWidget(modeHintId);
    await this.request(request(this.id, modeParent, 'addLayoutChild', {
      widgetId: modeHintId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // ── Whitelist container (always present; holds the Share link and Invite
    // peers cards in Shared mode). autoSize: it reports its cards' height to
    // the tab as they size to their content.
    this.whitelistContainerId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: cId,
        autoSize: true,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.whitelistContainerId,
      sizePolicy: { vertical: 'preferred' },
    }));

    if (currentAccessMode === 'shared') {
      await this.buildSharedAccessSection(r0);
    } else {
      await this.request(request(this.id, cId, 'updateLayoutChild', {
        widgetId: this.whitelistContainerId,
        preferredSize: { height: 0 },
      }));
    }

    // ── Shared objects ──
    // Only Public curates an explicit list, so only Public has a list to
    // search: a "Shared objects" card fills the space left in the tab and
    // holds the search box above the scrolling list. A 'shared' workspace
    // exposes everything automatically and shows a notice card in place of the
    // editor; 'local' shares nothing. In those two modes the search box and
    // the list container stay in the tab at zero height.
    const isPublic = currentAccessMode === 'public';
    let exposureParent: AbjectId = cId;
    if (isPublic) {
      const { sectionId: exposureCardId } = await this.sectionCard(cId, 'Shared objects',
        'Select which objects remote peers can access.', 18, true);
      exposureParent = this.trackTabWidget(exposureCardId);
    }

    // Search input for the exposed-objects whitelist
    const searchVisible = isPublic;
    const { widgetIds: [searchId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Search objects...', style: { visible: searchVisible } },
      ] })
    );
    this.accessSearchInputId = this.trackTabWidget(searchId);
    await this.request(request(this.id, this.accessSearchInputId, 'addDependent', {}));
    await this.request(request(this.id, exposureParent, 'addLayoutChild', {
      widgetId: this.accessSearchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: searchVisible ? 30 : 0 },
    }));

    // Exposed Objects container (the scrolling list; fills the card in Public)
    this.exposedContainerId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: exposureParent,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    ));
    await this.request(request(this.id, exposureParent, 'addLayoutChild', {
      widgetId: this.exposedContainerId,
      sizePolicy: { vertical: isPublic ? 'expanding' : 'fixed', horizontal: 'expanding' },
      preferredSize: isPublic ? undefined : { height: 0 },
    }));

    // 'public' offers an unauthenticated joiner only what the user explicitly
    // named, so it keeps the whitelist editor. 'shared' exposes every non-system abject
    // automatically, so an editable list there would imply a gate that no
    // longer exists — state the rule instead of offering a control that does
    // nothing.
    if (currentAccessMode === 'shared') {
      await this.buildSharedExposureNotice();
    } else if (currentAccessMode !== 'local') {
      // P2-3: public-but-never-curated shares nothing. Say so above the editor.
      if (currentAccessMode === 'public' && uncuratedPublic) {
        await this.buildUncuratedPublicNotice();
      }
      await this.buildExposedObjectsSection(r0);
    }

    // Save button row + status label
    await this.buildSaveRow(r0, 'access');
  }

  /**
   * Render the Access tab for a workspace we joined rather than host: read-only
   * shared status in place of the access-mode select. No save row, because
   * there is nothing here we may write — the owning peer controls this
   * workspace's access, and `saveAccessSettings` skips the mode/whitelist/
   * exposed writes entirely while `accessModeSelectId` stays undefined.
   */
  private async buildJoinedAccessSection(cId: AbjectId, ownerPeerId?: string): Promise<void> {
    const ownerText = ownerPeerId
      ? `Hosted by peer ${ownerPeerId.slice(0, 16)} — access is managed by its owner.`
      : 'Hosted by another peer — access is managed by its owner.';
    // One "Access level" card, read-only: its title and hint carry the old
    // header and description; the joined status and owner are its rows.
    const { sectionId } = await this.sectionCard(cId, 'Access level',
      'This workspace is shared with you by another peer.');
    const card = this.trackTabWidget(sectionId);

    const { widgetIds: [statusId, ownerId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        this.fieldLabelSpec('Joined shared workspace'),
        this.hintSpec(ownerText),
      ] })
    );

    const rows: Array<{ widgetId: AbjectId; height: number }> = [
      { widgetId: statusId, height: 20 },
      // The owner line names a peer id, so leave room for it to wrap.
      { widgetId: ownerId, height: 34 },
    ];
    for (const { widgetId, height } of rows) {
      this.trackTabWidget(widgetId);
      await this.request(request(this.id, card, 'addLayoutChild', {
        widgetId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height },
      }));
    }
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
        this.headerSpec('Allowed Contacts'),
        this.hintSpec('Select which contacts can access this workspace.'),
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
          this.emptySpec('No contacts yet', 'Add contacts in Peer Network, then choose who may enter here.'),
        ] })
      );
      this.whitelistWidgetIds.push(emptyLabelId);
      await this.request(request(this.id, containerId, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: EMPTY_STATE_HEIGHT },
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
    this.invitedPeersRevokeButtons.clear();
  }

  /**
   * Build the Share Link & Peer Invite section for Shared access mode.
   */
  private async buildSharedAccessSection(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    const containerId = this.whitelistContainerId!;
    await this.ensureWorkspaceId();

    // Resolve local peer ID
    let localPeerId = '';
    if (!this.identityId) {
      this.identityId = await this.discoverDep('Identity') ?? undefined;
    }
    if (this.identityId) {
      try {
        const idInfo = await this.request<{ peerId: string; name: string }>(
          request(this.id, this.identityId, 'getIdentity', {})
        );
        if (idInfo?.peerId) localPeerId = idInfo.peerId;
      } catch { /* identity not ready */ }
    }
    if (!localPeerId && this.peerRegistryId) {
      try {
        const status = await this.request<{ localPeerId?: string }>(
          request(this.id, this.peerRegistryId, 'getStatus', {})
        );
        if (status?.localPeerId) localPeerId = status.localPeerId;
      } catch { /* peer registry status failed */ }
    }

    const wsId = this.workspaceId || 'default';
    this.shareLinkText = localPeerId ? `abject://${localPeerId}/${wsId}` : `abject://${wsId}`;

    // ── Share link (card) ──
    const { sectionId: shareCard } = await this.sectionCard(containerId, 'Share link',
      'Send peers this link to join the workspace.');
    this.whitelistWidgetIds.push(shareCard);

    // Share link row (HBox)
    const shareRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: shareCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    this.whitelistWidgetIds.push(shareRowId);
    await this.request(request(this.id, shareCard, 'addLayoutChild', {
      widgetId: shareRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [linkInputId, copyBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, text: this.shareLinkText, placeholder: 'Share link' },
        { type: 'button', windowId: this.windowId, text: 'Copy Link', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.whitelistWidgetIds.push(linkInputId, copyBtnId);
    this.copyShareLinkBtnId = copyBtnId;
    await this.request(request(this.id, this.copyShareLinkBtnId, 'addDependent', {}));

    await this.request(request(this.id, shareRowId, 'addLayoutChild', {
      widgetId: linkInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));
    await this.request(request(this.id, shareRowId, 'addLayoutChild', {
      widgetId: copyBtnId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { width: 90, height: 30 },
    }));

    // ── Invite peers (card): invite by id, the status line, and who is invited ──
    const { sectionId: inviteCard } = await this.sectionCard(containerId, 'Invite peers',
      'Invite a peer by Peer ID or address.');
    this.whitelistWidgetIds.push(inviteCard);

    // Invite peer row (HBox)
    const inviteRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: inviteCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    this.whitelistWidgetIds.push(inviteRowId);
    await this.request(request(this.id, inviteCard, 'addLayoutChild', {
      widgetId: inviteRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Invite is this card's primary action.
    const { widgetIds: [inviteInputId, inviteBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Enter Peer ID or address to invite...' },
        { type: 'button', windowId: this.windowId, text: 'Invite', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.whitelistWidgetIds.push(inviteInputId, inviteBtnId);
    this.invitePeerInputId = inviteInputId;
    this.invitePeerBtnId = inviteBtnId;
    await this.request(request(this.id, this.invitePeerInputId, 'addDependent', {}));
    await this.request(request(this.id, this.invitePeerBtnId, 'addDependent', {}));

    await this.request(request(this.id, inviteRowId, 'addLayoutChild', {
      widgetId: inviteInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));
    await this.request(request(this.id, inviteRowId, 'addLayoutChild', {
      widgetId: inviteBtnId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { width: 70, height: 30 },
    }));

    // Status label
    const { widgetIds: [statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textDescription, fontSize: 11 } },
      ] })
    );
    this.whitelistWidgetIds.push(statusLabelId);
    this.inviteStatusLabelId = statusLabelId;
    await this.request(request(this.id, inviteCard, 'addLayoutChild', {
      widgetId: statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 16 },
    }));

    // Whitelisted/Invited Peers list label (a field label: the card carries the header)
    const { widgetIds: [peersHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        this.fieldLabelSpec('Invited Peers'),
      ] })
    );
    this.whitelistWidgetIds.push(peersHeaderId);
    await this.request(request(this.id, inviteCard, 'addLayoutChild', {
      widgetId: peersHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Get current whitelist from workspace manager
    let whitelist: string[] = [];
    if (this.workspaceManagerId && this.workspaceId) {
      try {
        whitelist = await this.request<string[]>(
          request(this.id, this.workspaceManagerId, 'getWhitelist', { workspaceId: this.workspaceId })
        );
      } catch { /* whitelist query failed */ }
    }

    if (whitelist.length === 0) {
      const { widgetIds: [noPeersId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          this.emptySpec('No peers invited yet', 'Invite a peer above; they appear here and can be revoked at any time.'),
        ] })
      );
      this.whitelistWidgetIds.push(noPeersId);
      await this.request(request(this.id, inviteCard, 'addLayoutChild', {
        widgetId: noPeersId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: EMPTY_STATE_HEIGHT },
      }));
    } else {
      for (const peerId of whitelist) {
        const displayName = peerId.length > 24 ? peerId.slice(0, 20) + '...' : peerId;
        const rowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: inviteCard,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        this.whitelistWidgetIds.push(rowId);
        await this.request(request(this.id, inviteCard, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 26 },
        }));

        const { widgetIds: [peerLabelId, revokeBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: displayName, style: { color: this.theme.textHeading, fontSize: 12 } },
            { type: 'button', windowId: this.windowId, text: 'Revoke', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder, fontSize: 11 } },
          ] })
        );
        this.whitelistWidgetIds.push(peerLabelId, revokeBtnId);
        this.invitedPeersRevokeButtons.set(revokeBtnId, peerId);
        await this.request(request(this.id, revokeBtnId, 'addDependent', {}));

        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: peerLabelId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 24 },
        }));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: revokeBtnId,
          sizePolicy: { vertical: 'fixed' },
          preferredSize: { width: 65, height: 24 },
        }));
      }
    }
  }

  /**
   * Handle inviting a peer by ID/address in Shared mode.
   */
  private async handleInvitePeer(): Promise<void> {
    if (!this.invitePeerInputId || !this.workspaceManagerId || !this.workspaceId) return;
    try {
      const peerInput = (await this.request<string>(
        request(this.id, this.invitePeerInputId, 'getValue', {})
      ) || '').trim();
      if (!peerInput) {
        this.windowEffect('shake');
        await this.setStatusLine(this.inviteStatusLabelId, 'Enter a Peer ID to invite.', true);
        return;
      }

      let whitelist = await this.request<string[]>(
        request(this.id, this.workspaceManagerId, 'getWhitelist', { workspaceId: this.workspaceId })
      );
      if (!whitelist.includes(peerInput)) {
        whitelist = [...whitelist, peerInput];
        await this.request(
          request(this.id, this.workspaceManagerId, 'setWhitelist', {
            workspaceId: this.workspaceId,
            whitelist,
          })
        );
      }

      await this.clearTabContent();
      const r0 = { x: 0, y: 0, width: 0, height: 0 };
      await this.buildAccessTab(r0);
      // The peer joined the invite list.
      this.windowEffect('flash');
      if (this.inviteStatusLabelId) {
        try {
          await this.request(request(this.id, this.inviteStatusLabelId, 'update', {
            text: 'Peer invited. They can join with the share link.',
            style: livingStyle(this.theme, 11),
          }));
        } catch { /* widget gone */ }
      }
    } catch (err) {
      log.warn('Failed to invite peer:', err);
      this.windowEffect('shake');
      await this.setStatusLine(this.inviteStatusLabelId, 'Could not invite that peer. Try again.', true);
    }
  }

  /**
   * Handle revoking an invited peer from the whitelist in Shared mode.
   */
  private async handleRevokePeer(peerId: string): Promise<void> {
    if (!this.workspaceManagerId || !this.workspaceId) return;
    try {
      let whitelist = await this.request<string[]>(
        request(this.id, this.workspaceManagerId, 'getWhitelist', { workspaceId: this.workspaceId })
      );
      whitelist = whitelist.filter(id => id !== peerId);
      await this.request(
        request(this.id, this.workspaceManagerId, 'setWhitelist', {
          workspaceId: this.workspaceId,
          whitelist,
        })
      );

      await this.clearTabContent();
      const r0 = { x: 0, y: 0, width: 0, height: 0 };
      await this.buildAccessTab(r0);
    } catch (err) {
      log.warn('Failed to revoke peer:', err);
      this.windowEffect('shake');
      await this.setStatusLine(this.inviteStatusLabelId, 'Could not revoke that peer. Try again.', true);
    }
  }

  /**
   * Build the exposed objects section showing workspace objects as checkboxes.
   */
  /**
   * The 'shared' counterpart to the Exposed Objects whitelist.
   *
   * A shared workspace is collaborative among invited members, so every
   * non-system abject in it reaches them automatically and there is no list to
   * curate. Rendering an editable whitelist here would suggest a gate that the
   * catalog no longer consults, and every object the user never ticked would
   * look withheld when in fact it is shared. Explain the rule instead.
   */
  private async buildSharedExposureNotice(): Promise<void> {
    // A "Shared objects" card in the tab itself, so it sizes to its text and
    // the tab scrolls to it (the list container stays at zero height here).
    const cId = this.tabContentContainerId!;
    const { sectionId } = await this.sectionCard(cId, 'Shared objects',
      'All workspace abjects are shared automatically with members.');
    const card = this.trackTabWidget(sectionId);

    // The body wraps to the card's width as one paragraph.
    const { widgetIds: [bodyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        this.hintSpec(
          'Objects you create here become available to everyone you invite, with '
          + 'no list to maintain. System objects belonging to this desktop (Taskbar, '
          + 'Settings, Storage and other infrastructure) always stay local. '
          + 'Switch to Public to choose individual objects instead.'),
      ] })
    );
    this.trackTabWidget(bodyId);
    await this.request(request(this.id, card, 'addLayoutChild', {
      widgetId: bodyId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 84 },
    }));
  }

  /**
   * P2-3: notice for a PUBLIC workspace whose exposure list the user has never
   * curated.
   *
   * Such a workspace no longer publishes its whole catalog — it publishes the
   * registry and nothing else. Without a word here the whitelist below simply
   * shows every box unticked, which reads as "not saved yet" rather than
   * "deliberately sharing nothing". Render it directly above the editor that
   * resolves it. Curated public workspaces and 'shared'/'local' never see this.
   */
  private async buildUncuratedPublicNotice(): Promise<void> {
    const containerId = this.exposedContainerId!;

    // Inside the "Shared objects" card, above its list: a field-style heading
    // (the card carries the section header) and one wrapped paragraph.
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Nothing is shared yet', style: { color: this.theme.textHeading, fontSize: 13, fontWeight: 'bold' } },
        this.hintSpec(
          'This workspace is Public but no objects have been chosen, so remote '
          + 'peers can reach its registry and nothing else. Tick the objects below '
          + 'and save to share them.'),
      ] })
    );
    this.exposedWidgetIds.push(...widgetIds);

    // heading, then the paragraph (room for three wrapped lines).
    const heights = [20, 52];
    for (let i = 0; i < widgetIds.length; i++) {
      await this.request(request(this.id, containerId, 'addLayoutChild', {
        widgetId: widgetIds[i],
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: heights[i] ?? 18 },
      }));
    }
  }

  private async buildExposedObjectsSection(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    // The rows go straight into the list: the "Shared objects" card around it
    // carries the section header and hint.
    const containerId = this.exposedContainerId!;

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
          this.accessSearchText
            ? this.emptySpec('No matches', 'No object name contains that text. Clear the search to see them all.')
            : this.emptySpec('No objects yet', 'Objects you create in this workspace appear here, ready to share.'),
        ] })
      );
      this.exposedWidgetIds.push(emptyLabelId);
      await this.request(request(this.id, containerId, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: EMPTY_STATE_HEIGHT },
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
  private async buildSaveRow(
    r0: { x: number; y: number; width: number; height: number },
    tab: 'general' | 'access',
    parentId: AbjectId = this.tabContentContainerId!,
  ): Promise<void> {
    // The row lives in its section card when the Save belongs to one card,
    // or at the foot of the tab when it saves several.
    const cId = parentId;

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
      this.windowEffect('shake');
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
      try {
        await this.request(
          request(this.id, this.workspaceManagerId, 'renameWorkspace', {
            workspaceId: this.workspaceId,
            name: workspaceName.trim(),
          })
        );
      } catch (err) {
        // Keep the form open and editable, and say why.
        log.warn('Failed to rename workspace:', err);
        this.windowEffect('shake');
        await this.setStatusLine(this.statusLabelId, 'Could not save. Try again in a moment.', true);
        await this.setControlsDisabled(false, [this.saveBtnId, this.workspaceNameInputId]);
        return;
      }

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

    // Show save feedback (the flash plays inside the pause), then close
    this.windowEffect('flash');
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

    let saveFailed = false;
    // Save access mode
    if (this.workspaceManagerId && this.workspaceId && this.accessModeSelectId) {
      try {
        const selectedValue = await this.request<string>(
          request(this.id, this.accessModeSelectId, 'getValue', {})
        );
        const modeMap: Record<string, string> = { 'Local': 'local', 'Shared': 'shared', 'Public': 'public' };
        const accessMode = modeMap[selectedValue] ?? 'local';
        await this.request(
          request(this.id, this.workspaceManagerId, 'setAccessMode', {
            workspaceId: this.workspaceId,
            accessMode,
          })
        );

        // Save whitelist if in shared mode
        if (accessMode === 'shared' && this.whitelistCheckboxes.size > 0) {
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
      } catch (err) {
        log.warn('Failed to save access settings:', err);
        saveFailed = true;
      }
    }

    if (saveFailed) {
      // Keep the tab open with the choices intact so the save can be retried.
      this.windowEffect('shake');
      await this.setStatusLine(this.accessStatusLabelId, 'Could not save access settings. Try again.', true);
      await this.setControlsDisabled(false, [this.accessSaveBtnId, this.accessModeSelectId]);
      return;
    }

    this.pendingAccessMode = undefined;

    // Show save feedback (the flash plays inside the pause), then close
    this.windowEffect('flash');
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

    // A joined workspace is not ours to delete: what we hold is a local mirror
    // of a workspace hosted by a peer. Deleting it would tear down the mirror
    // while leaving the share registry's joined entry pointing at it, so offer
    // "Leave" — which releases our reference — instead.
    this.activeWorkspaceIsJoined = false;
    if (this.workspaceManagerId) {
      try {
        const active = await this.request<{ id: string; joined?: boolean } | null>(
          request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
        );
        this.activeWorkspaceIsJoined = active?.joined === true;
      } catch { /* fall back to the delete affordance */ }
    }
    const dangerDesc = this.activeWorkspaceIsJoined
      ? 'Stop participating in this shared workspace and remove your local copy.'
      : 'Permanently delete this workspace and all its objects.';
    const dangerBtnText = this.activeWorkspaceIsJoined ? 'Leave shared workspace' : 'Delete Workspace';

    // Danger zone card: the section title and hint carry the header and
    // description; a destructive rule and title set it apart.
    const { sectionId: dangerCardId, titleId: dangerTitleId } = await this.sectionCard(cId, 'Danger zone', dangerDesc,
      this.activeWorkspaceIsJoined ? 34 : 18);
    const dangerCard = this.trackTabWidget(dangerCardId);
    await this.tintDangerSection(dangerCard, dangerTitleId);

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
        { type: 'button', windowId: this.windowId, text: dangerBtnText, style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder } },
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
      this.windowEffect('shake');
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
   * Handle "Leave shared workspace" click: confirm, then release this
   * instance's reference to the joined workspace.
   *
   * Releasing is not deleting. The workspace is reference-counted across its
   * participants and lives on with its host; what goes away is our local
   * mirror, along with the share registry's joined entry for it.
   */
  private async handleLeaveWorkspace(): Promise<void> {
    await this.ensureWorkspaceId();
    if (!this.workspaceManagerId || !this.workspaceId) return;

    let workspaceName = 'this workspace';
    try {
      const active = await this.request<{ id: string; name: string } | null>(
        request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
      );
      if (active) workspaceName = active.name;
    } catch { /* use fallback */ }

    const confirmed = await this.confirm({
      title: 'Leave shared workspace',
      message: `Leave "${workspaceName}"? Your local copy is removed. The workspace itself stays with its host and any other participants.`,
      confirmLabel: 'Leave',
      destructive: true,
    });
    if (!confirmed) return;

    if (this.deleteWorkspaceBtnId) {
      this.send(event(this.id, this.deleteWorkspaceBtnId, 'update', { busy: true }));
    }
    try {
      await this.request(
        request(this.id, this.workspaceManagerId, 'releaseJoinedWorkspace', {
          workspaceId: this.workspaceId,
          destroy: true,
        })
      );
      await this.notify(`Left workspace "${workspaceName}"`, 'success');
      await this.hide();
    } catch (err) {
      // Guard: releasing the workspace may have destroyed us mid-handler.
      if (this._status === 'stopped') return;
      const msg = err instanceof Error ? err.message : String(err);
      this.windowEffect('shake');
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
      await this.notify(`Leave failed: ${msg.slice(0, 80)}`, 'error');
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
      this.windowEffect('shake');
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

    // Active-theme label.
    const { widgetIds: [activeLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: `Active: ${activeName}`,
          style: { color: this.theme.textMeta, fontSize: 12 } },
      ] })
    );
    this.activeThemeNameLabelId = this.trackTabWidget(activeLabelId);

    // ── Theme (card): the active theme, the built-in swatches, and Reset ──
    const { sectionId: themeCardId } = await this.sectionCard(cId, 'Theme',
      'Choose how this workspace looks. Changes apply immediately.');
    const themeCard = this.trackTabWidget(themeCardId);
    await this.request(request(this.id, themeCard, 'addLayoutChild', {
      widgetId: this.activeThemeNameLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // Render swatches: built-ins in the Theme card, user presets in their own.
    const builtins = presets.filter((p) => p.builtin);
    const userThemes = presets.filter((p) => !p.builtin);

    await this.renderSwatchGrid(themeCard, builtins);

    // Reset to default button (closes the Theme card).
    const { widgetIds: [resetBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Reset to default',
          style: { background: this.theme.buttonBg, color: this.theme.buttonText } },
      ] })
    );
    this.resetThemeBtnId = this.trackTabWidget(resetBtnId);
    await this.request(request(this.id, this.resetThemeBtnId, 'addDependent', {}));
    await this.request(request(this.id, themeCard, 'addLayoutChild', {
      widgetId: this.resetThemeBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // ── Your themes (card): themes registered by this desktop's users ──
    if (userThemes.length > 0) {
      const { sectionId: userCardId } = await this.sectionCard(cId, 'Your themes');
      const userCard = this.trackTabWidget(userCardId);
      await this.renderSwatchGrid(userCard, userThemes);
    }
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
      this.windowEffect('shake');
      return;
    }

    // The new palette landed: a flash in the new living light.
    const changedTheme = newId !== this.selectedThemeId;
    this.selectedThemeId = newId;
    if (changedTheme) this.windowEffect('flash');

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

  // ─────────────────────────────── Web tab ───────────────────────────────
  //
  // The Web tab curates which of this workspace\'s abjects the HTTP gateway
  // serves, and on what terms. It is deliberately separate from the Access
  // tab (peer exposure): reaching an abject from a browser and reaching it
  // from another Abject peer are different decisions. The workspace\'s
  // WebExposure holds the config; this tab reads and writes it.

  private async findWebExposure(): Promise<AbjectId | undefined> {
    const registryId = await this.discoverDep('Registry');
    if (!registryId) return undefined;
    try {
      const hits = await this.request<Array<{ id: AbjectId; name: string }>>(
        request(this.id, registryId, 'search', { query: 'WebExposure' }));
      return hits.find(h => h.name === 'WebExposure')?.id;
    } catch { return undefined; }
  }

  /** Workspace abjects that can be offered over HTTP: every child, user objects first. */
  private async webExposableObjects(): Promise<Array<{ id: string; name: string }>> {
    await this.ensureWorkspaceId();
    if (!this.workspaceId || !this.workspaceManagerId) return [];
    let childIds = new Set<string>();
    try {
      const detailed = await this.request<Array<{ workspaceId: string; childIds: string[] }>>(
        request(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {}));
      const mine = detailed.find(w => w.workspaceId === this.workspaceId);
      if (mine) childIds = new Set(mine.childIds);
    } catch { /* none */ }
    const registryId = await this.discoverDep('Registry');
    if (!registryId) return [];
    let all: Array<{ id: string; name: string; manifest?: { tags?: string[] } }> = [];
    try { all = await this.request(request(this.id, registryId, 'list', {})); } catch { return []; }
    const userIds = new Set<string>();
    if (this.abjectStoreId) {
      try { for (const s of await this.request<Array<{ objectId: string }>>(request(this.id, this.abjectStoreId, 'list', {}))) userIds.add(s.objectId); }
      catch { /* store not ready */ }
    }
    // Only objects that actually have callable, non-meta methods are worth a row.
    const rows = all
      .filter(o => childIds.has(o.id))
      .filter(o => o.name !== 'WebExposure' && !(o.manifest?.tags ?? []).includes('capability'))
      .map(o => ({ id: o.id, name: o.name }));
    rows.sort((a, b) => {
      const au = userIds.has(a.id) ? 0 : 1, bu = userIds.has(b.id) ? 0 : 1;
      if (au !== bu) return au - bu;
      return a.name.localeCompare(b.name);
    });
    // Dedup by name — routes are name-addressed, so one row per name.
    const seen = new Set<string>();
    return rows.filter(r => (seen.has(r.name) ? false : (seen.add(r.name), true)));
  }

  private async buildWebTab(r0: { x: number; y: number; width: number; height: number }): Promise<void> {
    const cId = this.tabContentContainerId!;
    this.webExposeCheckboxes.clear();
    this.webAccessSelects.clear();

    const exposureId = await this.findWebExposure();
    let config: { enabled: boolean; entries: Record<string, { access: string; methods: string[] | null }> } = { enabled: false, entries: {} };
    if (exposureId) { try { config = await this.request(request(this.id, exposureId, 'getConfig', {})); } catch { /* defaults */ } }

    // ── Web serving (card): the workspace-wide switch ──
    const { widgetIds: [enableId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, text: 'Serve this workspace over HTTP', checked: config.enabled === true },
      ] }));
    this.webEnableCheckboxId = this.trackTabWidget(enableId);
    const { sectionId: servingCardId } = await this.sectionCard(cId, 'Web serving',
      'Serve chosen abjects over HTTP. The gateway itself is turned on in the Web Gateway window.', 34);
    const servingCard = this.trackTabWidget(servingCardId);
    await this.request(request(this.id, this.webEnableCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, servingCard, 'addLayoutChild', { widgetId: this.webEnableCheckboxId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 26 } }));

    // ── Served abjects (card): one route per abject, with its access ──
    const objects = await this.webExposableObjects();
    const { sectionId: routesCardId } = await this.sectionCard(cId, 'Served abjects',
      objects.length > 0 ? 'Authenticated needs an API token; Public is open to anyone.' : undefined);
    const routesCard = this.trackTabWidget(routesCardId);
    if (objects.length === 0) {
      const { widgetIds: [noneId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          this.emptySpec('Nothing to serve yet', 'Create an abject in this workspace, then tick it here to serve it over HTTP.')] }));
      this.trackTabWidget(noneId);
      await this.request(request(this.id, routesCard, 'addLayoutChild', { widgetId: noneId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: EMPTY_STATE_HEIGHT } }));
    }
    for (const obj of objects) {
      const entry = config.entries[obj.name];
      const rowId = this.trackTabWidget(await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', { parentLayoutId: routesCard, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 })));
      await this.request(request(this.id, routesCard, 'addLayoutChild', { widgetId: rowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } }));
      const { widgetIds: [checkId, selectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'checkbox', windowId: this.windowId, text: obj.name, checked: !!entry },
          { type: 'select', windowId: this.windowId, options: ['Authenticated', 'Public'], selectedIndex: entry?.access === 'public' ? 1 : 0 },
        ] }));
      this.trackTabWidget(checkId); this.trackTabWidget(selectId);
      this.webExposeCheckboxes.set(checkId, obj.name);
      this.webAccessSelects.set(selectId, obj.name);
      await this.request(request(this.id, checkId, 'addDependent', {}));
      await this.request(request(this.id, rowId, 'addLayoutChild', { widgetId: checkId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 26 } }));
      await this.request(request(this.id, rowId, 'addLayoutChild', { widgetId: selectId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 150, height: 28 } }));
    }

    // Save row
    const saveRowId = this.trackTabWidget(await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', { parentLayoutId: cId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 })));
    await this.request(request(this.id, cId, 'addLayoutChild', { widgetId: saveRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 36 } }));
    await this.request(request(this.id, saveRowId, 'addLayoutSpacer', {}));
    const { widgetIds: [btnId, statusId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textDescription, fontSize: 12, align: 'right', selectable: true } },
      ] }));
    this.webSaveBtnId = this.trackTabWidget(btnId);
    this.webStatusLabelId = this.trackTabWidget(statusId);
    await this.request(request(this.id, this.webSaveBtnId, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, 'addLayoutChild', { widgetId: this.webSaveBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: 36 } }));
    await this.request(request(this.id, cId, 'addLayoutChild', { widgetId: this.webStatusLabelId, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 18 } }));
  }

  private async saveWebSettings(): Promise<void> {
    const exposureId = await this.findWebExposure();
    if (!exposureId) {
      this.windowEffect('shake');
      await this.setStatusLine(this.webStatusLabelId, 'Web serving is not available in this workspace yet.', true);
      return;
    }
    let enabled = false;
    if (this.webEnableCheckboxId) {
      try { enabled = (await this.request<string>(request(this.id, this.webEnableCheckboxId, 'getValue', {}))) === 'true'; } catch { /* off */ }
    }
    const access = new Map<string, string>();
    for (const [selectId, name] of this.webAccessSelects) {
      try {
        const v = await this.request<string>(request(this.id, selectId, 'getValue', {}));
        // select getValue is the index as a string, or the label
        access.set(name, v === '1' || v === 'Public' ? 'public' : 'authenticated');
      } catch { access.set(name, 'authenticated'); }
    }
    const entries: Record<string, { access: string; methods: string[] | null }> = {};
    for (const [checkId, name] of this.webExposeCheckboxes) {
      try {
        const checked = await this.request<string>(request(this.id, checkId, 'getValue', {}));
        if (checked === 'true') entries[name] = { access: access.get(name) ?? 'authenticated', methods: null };
      } catch { /* gone */ }
    }
    try {
      await this.request(request(this.id, exposureId, 'setConfig', { config: { enabled, entries } }));
      this.windowEffect('flash');
      if (this.webStatusLabelId) await this.request(request(this.id, this.webStatusLabelId, 'update', { text: `Saved. ${Object.keys(entries).length} abject(s) exposed.`, style: { color: this.theme.textDescription } }));
    } catch (err) {
      this.windowEffect('shake');
      if (this.webStatusLabelId) {
        await this.request(request(this.id, this.webStatusLabelId, 'update', { text: `Save failed: ${err instanceof Error ? err.message.slice(0, 60) : ''}`, style: { color: this.theme.statusError } }));
      }
    }
  }
}

// Well-known settings ID
export const SETTINGS_ID = 'abjects:settings' as AbjectId;
