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
import { parseInviteLink, type WorkspaceAccessMode } from './workspace-manager.js';

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
  private workspaceShareRegistryId?: AbjectId;

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
  private cachedWorkspaces: Array<{ id: string; name: string; accessMode: string; joined?: boolean }> = [];
  private cachedActiveWorkspaceId?: string;

  // ── Add Workspace Dialog State ──────────────────────────────────────────
  private dialogWindowId?: AbjectId;
  private dialogLayoutId?: AbjectId;
  private dialogMode: 'create' | 'join' = 'create';
  private createNameInputId?: AbjectId;
  private createDescInputId?: AbjectId;
  private createTagsInputId?: AbjectId;
  private createAccessMode: WorkspaceAccessMode = 'local';
  private joinUrlInputId?: AbjectId;
  private dialogTabBarId?: AbjectId;
  private accessModeSelectId?: AbjectId;
  private submitBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private statusLabelId?: AbjectId;

  private formNameValue = '';
  private formDescValue = '';
  private formTagsValue = '';
  private formJoinUrlValue = '';
  private dialogStatusText = '';

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceSwitcher',
        description:
          'Global workspace switcher bar. Shows workspace buttons and a "+" button to create or join workspaces.',
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
              {
                name: 'showAddDialog',
                description: 'Open the Add Workspace modal dialog',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'closeAddDialog',
                description: 'Close the Add Workspace modal dialog',
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
    return super.askPrompt(_question) + '\n\n## WorkspaceSwitcher Usage Guide\n\n### Overview\nProvider of the Spaces section of the sidebar dock. Shows one row per\nworkspace (with access-mode icons), a "+" button to open the Add Workspace\nmodal dialog (Create / Join flows), a gear button to open workspace Settings,\nand a "Browse" row to open the WorkspaceBrowser for discovering remote workspaces.\n\n### Methods\n- `show({ workspaces, activeWorkspaceId, settingsId?, windowId?, sectionLayoutId?, theme? })` --\n  Rebuild the section rows with the given workspace list inside the sidebar\n  section. IDs are cached, so a bare `show()` rebuilds in place. The active\n  workspace row is highlighted.\n- `hide()` -- Clear the section.\n- `showAddDialog()` -- Open the Add / Join Workspace modal dialog.\n- `closeAddDialog()` -- Dismiss the Add Workspace dialog.\n\n### Interface ID\n`abjects:workspace-switcher`';
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    this.workspaceShareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        workspaces?: Array<{ id: string; name: string; accessMode: string; joined?: boolean }>;
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
      if (payload?.windowId && payload?.sectionLayoutId) {
        this.windowId = payload.windowId;
        this.sectionLayoutId = payload.sectionLayoutId;
        this.compact = payload.compact ?? false;
      }
      if (payload?.theme && typeof payload.theme === 'object' && 'canvasBg' in payload.theme) {
        this.theme = payload.theme;
        this.pushedTheme = true;
      }
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('showAddDialog', async () => {
      return this.openAddWorkspaceDialog();
    });

    this.on('closeAddDialog', async () => {
      return this.closeAddWorkspaceDialog();
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.dialogWindowId && aspect === 'windowCloseRequested') {
        await this.closeAddWorkspaceDialog();
        return;
      }

      if (aspect === 'input' || aspect === 'text' || aspect === 'change') {
        const textVal = typeof value === 'string' ? value : String(value ?? '');
        if (fromId === this.createNameInputId) {
          this.formNameValue = textVal;
          return;
        }
        if (fromId === this.createDescInputId) {
          this.formDescValue = textVal;
          return;
        }
        if (fromId === this.createTagsInputId) {
          this.formTagsValue = textVal;
          return;
        }
        if (fromId === this.joinUrlInputId) {
          this.formJoinUrlValue = textVal;
          return;
        }
        if (fromId === this.dialogTabBarId) {
          const idx = value as number;
          this.dialogMode = idx === 0 ? 'create' : 'join';
          this.dialogStatusText = '';
          await this.renderDialogContent();
          return;
        }
        if (fromId === this.accessModeSelectId) {
          const modeMap: Record<string, WorkspaceAccessMode> = { 'Local': 'local', 'Shared': 'shared', 'Public': 'public' };
          this.createAccessMode = modeMap[value as string] ?? 'local';
          return;
        }
        if (aspect === 'input' || aspect === 'text') return;
      }

      if (aspect !== 'click') return;

      // Modal Dialog Controls
      if (fromId === this.cancelBtnId) {
        await this.closeAddWorkspaceDialog();
        return;
      }
      if (fromId === this.submitBtnId) {
        if (this.dialogMode === 'create') {
          await this.handleCreateSubmit();
        } else {
          await this.handleJoinSubmit();
        }
        return;
      }

      // Section header — accordion toggle
      if (fromId === this.headerBtnId) {
        this.collapsed = !this.collapsed;
        await this.show();
        return;
      }

      // Lazy-discover WorkspaceManager if not yet found
      if (!this.workspaceManagerId) {
        this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
      }

      // Workspace switch button
      if (this.workspaceSwitchButtons.has(fromId)) {
        const wsId = this.workspaceSwitchButtons.get(fromId)!;
        if (this.workspaceManagerId) {
          this.send(request(this.id, this.workspaceManagerId,
            'switchWorkspace', { workspaceId: wsId }));
        }
        return;
      }

      // Create workspace "+" button -> opens modal dialog
      if (fromId === this.workspaceCreateBtnId) {
        await this.openAddWorkspaceDialog();
        return;
      }

      // Settings gear button
      if (fromId === this.settingsBtnId) {
        if (this.settingsId) {
          try {
            await this.request(request(this.id, this.settingsId, 'show', {}));
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
            await this.request(request(this.id, this.workspaceBrowserId, 'show', {}));
          } catch (err) {
            log.warn('Failed to show WorkspaceBrowser:', err);
          }
        }
        return;
      }
    });
  }

  // ── Add Workspace Modal Dialog ──────────────────────────────────────────

  async openAddWorkspaceDialog(): Promise<boolean> {
    if (!this.widgetManagerId) return false;
    await this.refreshActiveTheme();

    if (!this.dialogWindowId) {
      try {
        let winX = 300;
        let winY = 150;
        const winW = 440;
        const winH = 620;
        try {
          const displayInfo = await this.request<{ width: number; height: number }>(
            request(this.id, this.widgetManagerId, 'getDisplayInfo', {})
          );
          if (displayInfo?.width && displayInfo?.height) {
            winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
            winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));
          }
        } catch {
          // fallback to default coordinates
        }

        this.dialogWindowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId, 'createWindowAbject', {
            title: 'Add Workspace',
            rect: { x: winX, y: winY, width: winW, height: winH },
            zIndex: 300,
          })
        );
        if (this.dialogWindowId) {
          this.send(request(this.id, this.dialogWindowId, 'addDependent', {}));
        }
      } catch {
        // Fallback if window creation handled differently
      }
    }

    if (!this.dialogWindowId) {
      log.warn('Could not create Add Workspace window');
      return false;
    }

    this.dialogMode = 'create';
    this.formNameValue = `Workspace ${this.cachedWorkspaces.length + 1}`;
    this.formDescValue = '';
    this.formTagsValue = '';
    this.formJoinUrlValue = '';
    this.createAccessMode = 'local';
    this.dialogStatusText = '';

    await this.renderDialogContent();
    return true;
  }

  async closeAddWorkspaceDialog(): Promise<boolean> {
    if (this.dialogWindowId && this.widgetManagerId) {
      try {
        await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', {
          windowId: this.dialogWindowId,
        }));
      } catch {
        // window might already be closed
      }
    }
    this.dialogWindowId = undefined;
    this.dialogLayoutId = undefined;
    this.dialogTabBarId = undefined;
    this.createNameInputId = undefined;
    this.createDescInputId = undefined;
    this.createTagsInputId = undefined;
    this.accessModeSelectId = undefined;
    this.joinUrlInputId = undefined;
    this.statusLabelId = undefined;
    this.submitBtnId = undefined;
    this.cancelBtnId = undefined;
    this.dialogStatusText = '';
    return true;
  }

  private async renderDialogContent(): Promise<void> {
    if (!this.dialogWindowId || !this.widgetManagerId) return;

    // Clear existing layout
    if (this.dialogLayoutId) {
      try {
        await this.request(request(this.id, this.dialogLayoutId, 'clearLayoutChildren', {}));
      } catch { /* ignored */ }
    } else {
      this.dialogLayoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createVBox', {
          windowId: this.dialogWindowId,
          margins: { top: 16, right: 16, bottom: 16, left: 16 },
          spacing: 10,
        })
      );
    }

    const t = this.theme;
    const isCreate = this.dialogMode === 'create';

    const labelStyle = { color: t.textSecondary, fontSize: 11, fontWeight: 'bold' };
    const inputStyle = { background: lightenColor(t.windowBg, 5), color: t.textPrimary, borderColor: t.inputBorder, radius: 4 };
    const primaryBtnStyle = { background: t.accent, color: t.actionText, radius: 4, fontWeight: 'bold', align: 'center' };
    const cancelBtnStyle = { background: lightenColor(t.windowBg, 10), color: t.textPrimary, radius: 4, align: 'center' };
    const statusStyle = { color: this.dialogStatusText.startsWith('Error') || this.dialogStatusText.startsWith('Failed') ? '#ff5555' : t.accent, fontSize: 12 };

    const specs: Array<{ type: string; windowId: AbjectId; text?: string; placeholder?: string; style?: Record<string, unknown>; options?: string[]; selectedIndex?: number; tabs?: string[] }> = [];

    // Tab bar
    specs.push({
      type: 'tabBar',
      windowId: this.dialogWindowId,
      tabs: ['Create Workspace', 'Join Workspace'],
      selectedIndex: isCreate ? 0 : 1,
    });

    if (isCreate) {
      // Labels and Inputs
      specs.push({ type: 'label', windowId: this.dialogWindowId, text: 'Workspace Name', style: labelStyle });
      specs.push({ type: 'textInput', windowId: this.dialogWindowId, text: this.formNameValue, placeholder: 'e.g. Project Apollo', style: inputStyle });

      specs.push({ type: 'label', windowId: this.dialogWindowId, text: 'Description', style: labelStyle });
      specs.push({ type: 'textInput', windowId: this.dialogWindowId, text: this.formDescValue, placeholder: 'Workspace purpose and notes', style: inputStyle });

      specs.push({ type: 'label', windowId: this.dialogWindowId, text: 'Tags (comma-separated)', style: labelStyle });
      specs.push({ type: 'textInput', windowId: this.dialogWindowId, text: this.formTagsValue, placeholder: 'e.g. dev, rust, ml', style: inputStyle });

      specs.push({ type: 'label', windowId: this.dialogWindowId, text: 'Access Level', style: labelStyle });

      // Access Level options as dropdown select
      const accessOptions = ['Local', 'Shared', 'Public'];
      const accessModeLabel = this.createAccessMode === 'public' ? 'Public' : this.createAccessMode === 'shared' ? 'Shared' : 'Local';
      const accessModeIndex = Math.max(0, accessOptions.indexOf(accessModeLabel));
      specs.push({
        type: 'select',
        windowId: this.dialogWindowId,
        options: accessOptions,
        selectedIndex: accessModeIndex,
      });
    } else {
      // Join Workspace UI
      specs.push({ type: 'label', windowId: this.dialogWindowId, text: 'Invite URL', style: labelStyle });
      specs.push({ type: 'textInput', windowId: this.dialogWindowId, text: this.formJoinUrlValue, placeholder: 'abject://<ownerPeerId>/<workspaceId>', style: inputStyle });
    }

    if (this.dialogStatusText) {
      specs.push({ type: 'label', windowId: this.dialogWindowId, text: this.dialogStatusText, style: statusStyle });
    }

    // Submit & Cancel Buttons
    specs.push({ type: 'button', windowId: this.dialogWindowId, text: isCreate ? 'Create Workspace' : 'Join Workspace', style: primaryBtnStyle });
    specs.push({ type: 'button', windowId: this.dialogWindowId, text: 'Cancel', style: cancelBtnStyle });

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs })
    );

    this.dialogTabBarId = widgetIds[0];

    let curIdx = 1;
    if (isCreate) {
      curIdx++; // label
      this.createNameInputId = widgetIds[curIdx++];
      curIdx++; // label
      this.createDescInputId = widgetIds[curIdx++];
      curIdx++; // label
      this.createTagsInputId = widgetIds[curIdx++];
      curIdx++; // label
      this.accessModeSelectId = widgetIds[curIdx++];
    } else {
      curIdx++; // label
      this.joinUrlInputId = widgetIds[curIdx++];
      this.createNameInputId = undefined;
      this.createDescInputId = undefined;
      this.createTagsInputId = undefined;
      this.accessModeSelectId = undefined;
    }

    if (this.dialogStatusText) {
      this.statusLabelId = widgetIds[curIdx++];
    } else {
      this.statusLabelId = undefined;
    }

    this.submitBtnId = widgetIds[curIdx++];
    this.cancelBtnId = widgetIds[curIdx++];

    // Layout hierarchy
    const layoutChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize?: Record<string, number> }> = [];
    for (const wId of widgetIds) {
      layoutChildren.push({ widgetId: wId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 32 } });
      this.send(request(this.id, wId, 'addDependent', {}));
    }

    await this.request(request(this.id, this.dialogLayoutId, 'addLayoutChildren', {
      children: layoutChildren,
    }));
  }

  private async handleCreateSubmit(): Promise<void> {
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    }

    if (!this.workspaceManagerId) {
      this.dialogStatusText = 'Error: WorkspaceManager not available';
      await this.renderDialogContent();
      return;
    }

    try {
      // Live query input widgets with cached fallback
      let name = this.formNameValue;
      if (this.createNameInputId) {
        try {
          const liveName = await this.request<string>(
            request(this.id, this.createNameInputId, 'getValue', {})
          );
          if (liveName !== undefined && liveName !== null) {
            name = liveName;
          }
        } catch {
          // fallback to cached
        }
      }
      name = (name ?? '').trim();
      if (!name) {
        name = `Workspace ${this.cachedWorkspaces.length + 1}`;
      }

      let description = this.formDescValue;
      if (this.createDescInputId) {
        try {
          const liveDesc = await this.request<string>(
            request(this.id, this.createDescInputId, 'getValue', {})
          );
          if (liveDesc !== undefined && liveDesc !== null) {
            description = liveDesc;
          }
        } catch {
          // fallback to cached
        }
      }
      description = (description ?? '').trim();

      let tagsStr = this.formTagsValue;
      if (this.createTagsInputId) {
        try {
          const liveTags = await this.request<string>(
            request(this.id, this.createTagsInputId, 'getValue', {})
          );
          if (liveTags !== undefined && liveTags !== null) {
            tagsStr = liveTags;
          }
        } catch {
          // fallback to cached
        }
      }
      const tags = (tagsStr ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      if (this.accessModeSelectId) {
        try {
          const selectedValue = await this.request<string>(
            request(this.id, this.accessModeSelectId, 'getValue', {})
          );
          const modeMap: Record<string, WorkspaceAccessMode> = { 'Local': 'local', 'Shared': 'shared', 'Public': 'public' };
          if (selectedValue && modeMap[selectedValue]) {
            this.createAccessMode = modeMap[selectedValue];
          }
        } catch {
          // fallback to cached this.createAccessMode
        }
      }

      const { workspaceId } = await this.request<{ workspaceId: string }>(
        request(this.id, this.workspaceManagerId, 'createWorkspace', { name })
      );

      // Set Description
      if (description) {
        try {
          await this.request(
            request(this.id, this.workspaceManagerId, 'setDescription', {
              workspaceId,
              description,
            })
          );
        } catch (err) {
          log.warn('Could not set workspace description:', err);
        }
      }

      // Set Tags
      if (tags.length > 0) {
        try {
          await this.request(
            request(this.id, this.workspaceManagerId, 'setTags', {
              workspaceId,
              tags,
            })
          );
        } catch (err) {
          log.warn('Could not set workspace tags:', err);
        }
      }

      // Set Access Mode
      if (this.createAccessMode && this.createAccessMode !== 'local') {
        try {
          await this.request(request(this.id, this.workspaceManagerId, 'setAccessMode', {
            workspaceId,
            accessMode: this.createAccessMode,
          }));
        } catch (err) {
          log.warn('Could not set workspace access mode:', err);
        }
      }

      // Refresh cached workspace list
      this.cachedWorkspaces = await this.request<Array<{ id: string; name: string; accessMode: string; joined?: boolean }>>(
        request(this.id, this.workspaceManagerId, 'listWorkspaces', {})
      );

      // Refresh taskbar and switcher
      this.send(request(this.id, this.workspaceManagerId, 'refreshTaskbar', {}));
      await this.closeAddWorkspaceDialog();
      await this.notify(`Workspace "${name}" created`, 'success');
    } catch (err) {
      log.warn('Failed to create workspace:', err);
      this.dialogStatusText = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.renderDialogContent();
    }
  }

  private async handleJoinSubmit(): Promise<void> {
    let url = this.formJoinUrlValue;
    if (this.joinUrlInputId) {
      try {
        const liveUrl = await this.request<string>(
          request(this.id, this.joinUrlInputId, 'getValue', {})
        );
        if (liveUrl !== undefined && liveUrl !== null) {
          url = liveUrl;
        }
      } catch {
        // fallback to cached
      }
    }
    url = (url ?? '').trim();
    if (!url) {
      this.dialogStatusText = 'Error: Invite URL cannot be empty';
      await this.renderDialogContent();
      return;
    }

    const route = parseInviteLink(url);
    if (!route) {
      this.dialogStatusText = 'Error: Expected abject://<ownerPeerId>/<workspaceId> or abject://join?peer=…&ws=…';
      await this.renderDialogContent();
      return;
    }

    const { ownerPeerId, workspaceId } = route;

    if (!this.workspaceShareRegistryId) {
      this.workspaceShareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }

    if (!this.workspaceShareRegistryId) {
      this.dialogStatusText = 'Error: WorkspaceShareRegistry not available';
      await this.renderDialogContent();
      return;
    }

    // A full-form link carries the route itself; register it so the join does
    // not have to wait for discovery to learn the owner's registry.
    if (route.registryId) {
      try {
        await this.request(request(this.id, this.workspaceShareRegistryId, 'addWorkspaceFromRoute', {
          ownerPeerId,
          workspaceId,
          accessMode: route.accessMode,
          registryId: route.registryId,
          hops: 0,
        }));
      } catch { /* route may already be known via discovery */ }
    }

    try {
      const ack = await this.request<{ accepted: boolean; workspaceId: string; ownerPeerId: string; reason?: string }>(
        request(this.id, this.workspaceShareRegistryId, 'joinWorkspace', {
          peerId: ownerPeerId,
          workspaceId,
        })
      );

      if (ack.accepted) {
        if (this.workspaceManagerId) {
          this.cachedWorkspaces = await this.request<Array<{ id: string; name: string; accessMode: string; joined?: boolean }>>(
            request(this.id, this.workspaceManagerId, 'listWorkspaces', {})
          );
          if (!this.cachedWorkspaces.some(w => w.id === workspaceId)) {
            // Placeholder row for a workspace we just joined, in case the
            // manager's list has not caught up yet. It is joined by
            // construction, so mark it as such for the row glyph.
            this.cachedWorkspaces.push({
              id: workspaceId,
              name: `Remote: ${workspaceId}`,
              accessMode: 'shared',
              joined: true,
            });
          }
          this.send(request(this.id, this.workspaceManagerId, 'refreshTaskbar', {}));
        }
        await this.closeAddWorkspaceDialog();
        await this.notify(`Successfully joined workspace ${workspaceId}`, 'success');
      } else {
        this.dialogStatusText = `Join rejected: ${ack.reason || 'Whitelist rejection or host denied connection'}`;
        await this.renderDialogContent();
      }
    } catch (err) {
      log.warn('Join workspace failed:', err);
      this.dialogStatusText = `Join failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.renderDialogContent();
    }
  }

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
      // Keep cached theme
    }
  }

  async show(): Promise<boolean> {
    if (this.buildingUI) return true;
    if (!this.windowId || !this.sectionLayoutId) return false;
    this.buildingUI = true;
    try {
      if (this.pushedTheme) {
        this.pushedTheme = false;
      } else {
        await this.refreshActiveTheme();
      }

      await this.request(request(this.id, this.sectionLayoutId!, 'clearLayoutChildren', {}));

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

        const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];
        specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\u25C8' : `${chevron} Spaces`, style: compact ? { ...headerStyle, tooltip: 'Spaces' } : headerStyle });
        if (!compact) {
          specs.push({ type: 'button', windowId: this.windowId!, text: '+', style: { ...gearStyle, tooltip: 'Add Workspace' } });
          specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699', style: { ...gearStyle, tooltip: 'Settings' } });
        }
        const rowStartIdx = specs.length;
        if (showRows) {
          for (const ws of workspaces) {
            const isActive = ws.id === this.cachedActiveWorkspaceId;
            // A joined workspace mirrors one a peer hosts and keeps
            // `accessMode: 'local'` by invariant, so `joined` must be checked
            // BEFORE the mode — a mode-first test falls through to the
            // local-only lock and hides that the space is shared.
            const accessIcon = ws.joined
              ? '\uD83D\uDC65'
              : ws.accessMode === 'public' ? '\uD83C\uDF0D' : ws.accessMode === 'shared' ? '\uD83D\uDC65' : '\uD83D\uDD12';
            const baseStyle = isActive ? wsActiveStyle : appStyle;
            const wsTooltip = ws.joined ? `${ws.name} (joined)` : ws.name;
            specs.push({ type: 'button', windowId: this.windowId!, text: compact ? accessIcon : `${accessIcon} ${ws.name}`, style: compact ? { ...baseStyle, tooltip: wsTooltip } : baseStyle });
          }
          specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\uD83D\uDD0E' : '\uD83D\uDD0E Browse', style: compact ? { ...appStyle, tooltip: 'Browse' } : appStyle });
        }

        const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs })
        );

        this.headerBtnId = widgetIds[0];
        this.workspaceCreateBtnId = compact ? undefined : widgetIds[1];
        this.settingsBtnId = compact ? undefined : widgetIds[2];

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
      try {
        await this.request(request(this.id, this.sectionLayoutId, 'clearLayoutChildren', {}));
      } catch { /* section gone */ }
    }
    await this.closeAddWorkspaceDialog();
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
