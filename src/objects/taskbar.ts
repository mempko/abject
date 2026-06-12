/**
 * Taskbar -- persistent vertical bar with launch buttons for workspace apps.
 *
 * Uses the standard show/hide pattern: destroys and rebuilds the window on
 * each show(). On data changes (registry events, minimize/restore), rebuilds
 * the content by clearing the root layout and repopulating it.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import type { ThemeData } from '../core/theme-data.js';
import { event, request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { lightenColor } from './widgets/widget-types.js';

const log = new Log('Taskbar');

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';

const BTN_W = 120;
const BTN_H = 30;
const LABEL_H = 20;
/** Fallback glyph for user objects whose manifest declares no icon. */
const DEFAULT_OBJECT_ICON = '◆';

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private appExplorerId?: AbjectId;
  private chatBrowserId?: AbjectId;
  private jobBrowserId?: AbjectId;
  private webBrowserViewerId?: AbjectId;
  private goalBrowserId?: AbjectId;
  private knowledgeBrowserId?: AbjectId;
  private agentBrowserId?: AbjectId;
  private schedulerBrowserId?: AbjectId;
  private fileManagerId?: AbjectId;
  private registryId?: AbjectId;
  private windowManagerId?: AbjectId;

  /** Sidebar dock window + this rail's section layout (pushed via show()). */
  private windowId?: AbjectId;
  private sectionLayoutId?: AbjectId;
  /** Single-flight guard for clear+repopulate of the section. */
  private buildingUI = false;
  /** Accordion state: collapsed sections show only their header row. */
  private collapsed = false;
  /** Horizontal dock collapse (pushed via show()): render icon-only rows. */
  private compact = false;
  private headerBtnId?: AbjectId;

  // Button -> target maps for click dispatch
  private systemButtons: Map<AbjectId, AbjectId> = new Map();
  private userObjButtons: Map<AbjectId, AbjectId> = new Map();
  private restoreButtons: Map<AbjectId, string> = new Map();

  // Minimized window state (survives rebuilds)
  private minimizedWindows: Map<string, { windowId: AbjectId; title: string }> = new Map();

  // Debounce timer for registry events
  private updateTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super({
      manifest: {
        name: 'Taskbar',
        description:
          'Persistent vertical toolbar with launch buttons for workspace apps.',
        version: '1.0.0',
        interface: {
            id: TASKBAR_INTERFACE,
            name: 'Taskbar',
            description: 'System taskbar',
            methods: [
              {
                name: 'show',
                description: 'Show the taskbar',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the taskbar',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getState',
                description: 'Return current state',
                parameters: [],
                returns: { kind: 'object', properties: {
                  visible: { kind: 'primitive', primitive: 'boolean' },
                }},
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display taskbar', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Taskbar Usage Guide

### Overview
Provider of the Abjects section of the sidebar dock. Displays launch rows for
core workspace apps (Chat, Goals, Jobs, Web) and any user-created objects that
expose show/hide methods. Also shows a "minimized windows" list so the user
can restore windows from the sidebar.

### Methods
- \`show({ windowId?, sectionLayoutId?, theme? })\` -- Rebuild the section rows
  inside the sidebar section. IDs are cached, so a bare \`show()\` rebuilds in
  place.
- \`hide()\` -- Clear the section and all button state.
- \`getState()\` -- Returns \`{ visible: boolean }\`.

### Behavior
- Subscribes to the Registry for objectRegistered/objectUnregistered events
  and automatically rebuilds when user objects appear or disappear.
- Listens for windowMinimized/windowRestored events from WindowManager.
- Click events on buttons send \`show\` to the corresponding target object.
- Button styles update in real-time to reflect whether a target is visible.

### Interface ID
\`abjects:taskbar\``;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.appExplorerId = await this.requireDep('AppExplorer');
    this.chatBrowserId = await this.requireDep('ChatBrowser');
    this.jobBrowserId = await this.requireDep('JobBrowser');
    this.webBrowserViewerId = await this.discoverDep('WebBrowserViewer') ?? undefined;
    this.goalBrowserId = await this.discoverDep('GoalBrowser') ?? undefined;
    this.knowledgeBrowserId = await this.discoverDep('KnowledgeBrowser') ?? undefined;
    this.agentBrowserId = await this.discoverDep('AgentBrowser') ?? undefined;
    this.schedulerBrowserId = await this.discoverDep('SchedulerBrowser') ?? undefined;
    this.fileManagerId = await this.discoverDep('FileManager') ?? undefined;
    this.registryId = await this.requireDep('Registry');
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;

    if (this.registryId) {
      await this.request(request(this.id, this.registryId, 'subscribe', {}));
    }
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        theme?: ThemeData; windowId?: AbjectId; sectionLayoutId?: AbjectId; compact?: boolean;
      } | undefined;
      if (payload?.theme && typeof payload.theme === 'object' && 'canvasBg' in payload.theme) {
        this.theme = payload.theme;
      }
      // WorkspaceManager pushes fresh sidebar section IDs after each sidebar
      // rebuild; a bare show() rebuilds into the cached section.
      if (payload?.windowId && payload?.sectionLayoutId) {
        this.windowId = payload.windowId;
        this.sectionLayoutId = payload.sectionLayoutId;
        this.compact = payload.compact ?? false;
      }
      return this.show();
    });

    this.on('hide', async () => this.hide());

    this.on('getState', async () => ({ visible: !!this.windowId }));

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect === 'visibility') {
        // Update single button style in-place (no rebuild)
        const fromId = msg.routing.from;
        await this.updateButtonStyle(fromId, !!value);
        return;
      }
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      // Section header — accordion toggle
      if (fromId === this.headerBtnId) {
        this.collapsed = !this.collapsed;
        await this.rebuild();
        return;
      }

      // Launch button clicked
      const targetId = this.systemButtons.get(fromId) ?? this.userObjButtons.get(fromId);
      if (targetId) {
        this.send(event(this.id, targetId, 'show', {}));
        return;
      }

      // Restore button clicked
      if (this.restoreButtons.has(fromId)) {
        const surfaceId = this.restoreButtons.get(fromId)!;
        if (this.windowManagerId) {
          this.send(event(this.id, this.windowManagerId, 'restoreWindow', { surfaceId }));
        }
      }
    });

    this.on('windowMinimized', async (msg: AbjectMessage) => {
      const { surfaceId, windowId, title } = msg.payload as {
        surfaceId: string; windowId: AbjectId; title: string;
      };
      this.minimizedWindows.set(surfaceId, { windowId, title });
      if (this.windowId) await this.rebuild();
    });

    this.on('windowRestored', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      this.minimizedWindows.delete(surfaceId);
      if (this.windowId) await this.rebuild();
    });

    this.on('objectRegistered', async () => this.scheduleRebuild());
    this.on('objectUnregistered', async () => this.scheduleRebuild());
  }

  // ---- Show / Hide / Rebuild ----

  async show(): Promise<boolean> {
    if (this.buildingUI) return true;
    if (!this.windowId || !this.sectionLayoutId) return false;
    this.buildingUI = true;
    try {
      await this.rebuildSection();
    } finally {
      this.buildingUI = false;
    }
    this.changed('visibility', true);
    return true;
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
    this.systemButtons.clear();
    this.userObjButtons.clear();
    this.restoreButtons.clear();
    this.changed('visibility', false);
    return true;
  }

  private scheduleRebuild(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = undefined;
      if (this.windowId) await this.rebuild();
    }, 100);
  }

  /**
   * Rebuild content inside the existing sidebar section. Clears the section
   * layout and repopulates.
   */
  private async rebuild(): Promise<void> {
    if (this.buildingUI) return;
    if (!this.windowId || !this.sectionLayoutId) return;
    this.buildingUI = true;
    try {
      await this.rebuildSection();
    } finally {
      this.buildingUI = false;
    }
  }

  // ---- UI Construction ----

  private async rebuildSection(): Promise<void> {
    await this.request(request(this.id, this.sectionLayoutId!, 'clearLayoutChildren', {}));
    this.headerBtnId = undefined;
    this.systemButtons.clear();
    this.userObjButtons.clear();
    this.restoreButtons.clear();
    await this.populateContent();
  }

  private async populateContent(): Promise<void> {
    const collapsed = this.collapsed;
    const showableObjects = collapsed ? [] : await this.discoverShowableObjects();

    // No blocking getState queries. Buttons render unstyled immediately.
    // Visibility events from system objects update styles via updateButtonStyle().

    // ---- Header row: collapse-toggle header button + gear button ----
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.sectionLayoutId!,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.sectionLayoutId!, 'updateLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: LABEL_H },
    }));

    // ---- Batch create all widgets ----
    const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];

    // "Grimoire index" styling: flat, borderless, left-aligned rows rather than
    // boxed pills. Apps render in primary ink; user objects are demoted to
    // secondary so the eye lands on the built-in apps and the active entry.
    const compact = this.compact;
    const sectionLabelStyle = { color: this.theme.accent, fontSize: 12, fontWeight: 'bold', fontFamily: 'display', align: compact ? 'center' : 'left' };
    const ghostBg = lightenColor(this.theme.windowBg, 5);
    const appStyle = {
      background: ghostBg, flat: true,
      color: this.theme.textPrimary, radius: this.theme.tokens.radius.sm,
      align: compact ? 'center' : 'left', fontSize: compact ? 14 : 12,
    };
    // User objects use the same font/size/ink as the apps; their icon (declared
    // emoji or the default glyph) is the only distinction, so the rail is uniform.
    const objStyle = appStyle;
    const gearStyle = { background: ghostBg, flat: true, color: this.theme.textSecondary, radius: this.theme.tokens.radius.sm, fontSize: 13 };

    const headerStyle = { background: this.theme.windowBg, flat: true, color: this.theme.accent, fontSize: 12, fontWeight: 'bold', fontFamily: 'display', align: compact ? 'center' : 'left' };
    const chevron = collapsed ? '\u25B8' : '\u25BE';
    const row = (icon: string, label: string) => (compact ? icon : `${icon} ${label}`);
    // Compact rows are icon-only, so the label moves into a hover tooltip.
    const rowStyle = (label: string) => (compact ? { ...appStyle, tooltip: label } : appStyle);

    // [0] Header collapse-toggle button. Compact mode drops the gear from the
    // header (no horizontal room).
    specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\u25A0' : `${chevron} \u25A0 Abjects`, style: compact ? { ...headerStyle, tooltip: 'Abjects' } : headerStyle });
    if (!compact) {
      // [1] Gear button (AppExplorer)
      specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699', style: gearStyle });
    }
    const sysRowStartIdx = specs.length;
    if (!collapsed) {
      // Chat (opens ChatBrowser overview)
      specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83D\uDCAC', 'Chat'), style: rowStyle('Chat') });
      // Goals (optional)
      if (this.goalBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83C\uDFAF', 'Goals'), style: rowStyle('Goals') });
      }
      // Jobs
      specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83D\uDCCB', 'Jobs'), style: rowStyle('Jobs') });
      // Knowledge (optional)
      if (this.knowledgeBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83E\uDDE0', 'Knowledge'), style: rowStyle('Knowledge') });
      }
      // Agents (optional)
      if (this.agentBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83E\uDD16', 'Agents'), style: rowStyle('Agents') });
      }
      // Schedules (optional)
      if (this.schedulerBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('\u23F0', 'Schedules'), style: rowStyle('Schedules') });
      }
      // Web (optional)
      if (this.webBrowserViewerId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83C\uDF10', 'Web'), style: rowStyle('Web') });
      }
      // Files (optional)
      if (this.fileManagerId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('\uD83D\uDCC1', 'Files'), style: rowStyle('Files') });
      }
    }

    // User object buttons. Use the manifest icon when present, else a neutral
    // default so older objects (created before icons) still render an icon.
    // (showableObjects is empty when collapsed.)
    const userObjStartIdx = specs.length;
    for (const obj of showableObjects) {
      const icon = obj.manifest.icon?.trim() || DEFAULT_OBJECT_ICON;
      specs.push({ type: 'button', windowId: this.windowId!, text: compact ? icon : `${icon}  ${obj.manifest.name}`, style: compact ? { ...objStyle, tooltip: obj.manifest.name } : objStyle });
    }

    // Minimized window section (hidden while collapsed)
    const minimizedStartIdx = specs.length;
    const minimizedCount = collapsed ? 0 : this.minimizedWindows.size;
    if (minimizedCount > 0) {
      specs.push({ type: 'label', windowId: this.windowId!, text: compact ? '\u25A1' : '\u25A1 Windows', style: sectionLabelStyle });
      for (const [, { title }] of this.minimizedWindows) {
        specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\u25A1' : title, style: compact ? { ...objStyle, tooltip: title } : objStyle });
      }
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    // ---- Map button IDs to targets ----
    this.headerBtnId = widgetIds[0];
    const gearBtnId = compact ? undefined : widgetIds[1];
    if (gearBtnId) {
      this.systemButtons.set(gearBtnId, this.appExplorerId!);
    }

    if (!collapsed) {
      let idx = sysRowStartIdx;
      this.systemButtons.set(widgetIds[idx++], this.chatBrowserId!);
      if (this.goalBrowserId) this.systemButtons.set(widgetIds[idx++], this.goalBrowserId);
      this.systemButtons.set(widgetIds[idx++], this.jobBrowserId!);
      if (this.knowledgeBrowserId) this.systemButtons.set(widgetIds[idx++], this.knowledgeBrowserId);
      if (this.agentBrowserId) this.systemButtons.set(widgetIds[idx++], this.agentBrowserId);
      if (this.schedulerBrowserId) this.systemButtons.set(widgetIds[idx++], this.schedulerBrowserId);
      if (this.webBrowserViewerId) this.systemButtons.set(widgetIds[idx++], this.webBrowserViewerId);
      if (this.fileManagerId) this.systemButtons.set(widgetIds[idx++], this.fileManagerId);
    }

    for (let i = 0; i < showableObjects.length; i++) {
      this.userObjButtons.set(widgetIds[userObjStartIdx + i], showableObjects[i].id);
    }

    // ---- Add header row children ----
    const headerChildren: Array<Record<string, unknown>> = [
      { widgetId: this.headerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: LABEL_H } },
    ];
    if (gearBtnId) {
      headerChildren.push({ widgetId: gearBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: LABEL_H } });
    }
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', { children: headerChildren }));
    this.send(request(this.id, this.headerBtnId, 'addDependent', {}));

    // ---- Add section layout children ----
    const sectionChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];

    // System buttons in declaration order (skip the header-row widgets).
    for (let i = sysRowStartIdx; i < userObjStartIdx; i++) {
      sectionChildren.push({ widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }

    // User object buttons
    for (let i = 0; i < showableObjects.length; i++) {
      sectionChildren.push({ widgetId: widgetIds[userObjStartIdx + i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }

    // Minimized window section
    if (minimizedCount > 0) {
      let mIdx = minimizedStartIdx;
      sectionChildren.push({ widgetId: widgetIds[mIdx++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: LABEL_H } });
      let surfaceIdx = 0;
      for (const [surfaceId] of this.minimizedWindows) {
        const btnId = widgetIds[mIdx + surfaceIdx];
        this.restoreButtons.set(btnId, surfaceId);
        sectionChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
        surfaceIdx++;
      }
    }

    if (sectionChildren.length > 0) {
      await this.request(request(this.id, this.sectionLayoutId!, 'addLayoutChildren', {
        children: sectionChildren,
      }));
    }

    // Register as dependent of all buttons (for click events)
    for (const [btnId] of this.systemButtons) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }
    for (let i = 0; i < showableObjects.length; i++) {
      this.send(request(this.id, widgetIds[userObjStartIdx + i], 'addDependent', {}));
    }
    for (const [btnId] of this.restoreButtons) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }

    // Subscribe as dependent of system objects for visibility change events
    const depIds = [this.appExplorerId!, this.chatBrowserId!, this.jobBrowserId!];
    if (this.webBrowserViewerId) depIds.push(this.webBrowserViewerId);
    if (this.fileManagerId) depIds.push(this.fileManagerId);
    if (this.goalBrowserId) depIds.push(this.goalBrowserId);
    if (this.knowledgeBrowserId) depIds.push(this.knowledgeBrowserId);
    if (this.agentBrowserId) depIds.push(this.agentBrowserId);
    if (this.schedulerBrowserId) depIds.push(this.schedulerBrowserId);
    for (const depId of depIds) {
      this.send(request(this.id, depId, 'addDependent', {}));
    }

    // Fire-and-forget: query visibility and update button styles asynchronously.
    // This doesn't block rendering; buttons appear immediately, styles follow.
    void this.refreshButtonStyles();
  }

  private async refreshButtonStyles(): Promise<void> {
    const allButtons = [...this.systemButtons, ...this.userObjButtons];
    for (const [, targetId] of allButtons) {
      try {
        const state = await this.request<{ visible?: boolean }>(
          request(this.id, targetId, 'getState', {}), 2000
        );
        if (state?.visible) {
          await this.updateButtonStyle(targetId, true);
        }
      } catch { /* object unavailable */ }
    }
  }

  // ---- Helpers ----

  private async discoverShowableObjects(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    const allObjects = await this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'list', {})
    );
    return allObjects.filter((obj) => {
      if ((obj.manifest.tags ?? []).includes('system')) return false;
      if (!obj.manifest.interface) return false;
      const names = obj.manifest.interface.methods.map((m) => m.name);
      return names.includes('show') && names.includes('hide');
    });
  }

  /**
   * Update a single button's active/inactive style by target object ID.
   * Cheap: one message to one button widget, no layout rebuild.
   */
  private async updateButtonStyle(targetId: AbjectId, visible: boolean): Promise<void> {
    if (!this.windowId) return;
    // Toggle only bg/border (style updates merge), so each button keeps its
    // creation-time ink (primary for apps, secondary for objects). Active gets
    // the accent highlight; inactive restores the flat ghost row.
    const activeStyle = { background: this.theme.activeItemBg, borderColor: this.theme.activeItemBorder };
    const inactiveStyle = { background: lightenColor(this.theme.windowBg, 5), borderColor: this.theme.windowBg };
    const style = visible ? activeStyle : inactiveStyle;

    for (const [btnId, tid] of this.systemButtons) {
      if (tid === targetId) {
        this.send(request(this.id, btnId, 'update', { style }));
        return;
      }
    }
    for (const [btnId, tid] of this.userObjButtons) {
      if (tid === targetId) {
        this.send(request(this.id, btnId, 'update', { style }));
        return;
      }
    }
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
