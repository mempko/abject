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

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private yOffset = 8;

  // Button -> target maps for click dispatch
  private systemButtons: Map<AbjectId, AbjectId> = new Map();
  private userObjButtons: Map<AbjectId, AbjectId> = new Map();
  private restoreButtons: Map<AbjectId, string> = new Map();

  // Minimized window state (survives rebuilds)
  private minimizedWindows: Map<string, { windowId: AbjectId; title: string }> = new Map();

  // Accent the current UI was built with, so we know when a theme change needs a
  // rebuild to re-bake baked label colors (this.theme updates silently via the
  // theme-dependent protocol, so it can't be the comparison point).
  private lastBuiltAccent?: string;

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
Persistent vertical toolbar pinned to the left edge of the screen. Displays
launch buttons for core workspace apps (Chat, Goals, Jobs, Web) and any
user-created objects that expose show/hide methods. Also shows a "minimized
windows" section so the user can restore windows from the taskbar.

### Methods
- \`show()\` -- Show the taskbar. Accepts optional \`{ yOffset }\` to position vertically.
- \`hide()\` -- Destroy the taskbar window and clear all button state.
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
      const payload = msg.payload as { yOffset?: number; theme?: ThemeData } | undefined;
      if (payload?.yOffset !== undefined) {
        this.yOffset = payload.yOffset;
      }
      if (payload?.theme && typeof payload.theme === 'object' && 'canvasBg' in payload.theme) {
        this.theme = payload.theme;
      }
      // Rebuild if the accent differs from what the UI was actually built with
      // (this.theme updates silently via the theme-dependent protocol, so the
      // baked "Abjects"/"Windows" label colors only refresh on a rebuild —
      // show() alone just repositions an already-visible taskbar).
      if (this.windowId && this.lastBuiltAccent !== undefined && this.theme.accent !== this.lastBuiltAccent) {
        await this.rebuild();
        return true;
      }
      return this.show();
    });

    this.on('hide', async () => this.hide());

    this.on('getState', async () => ({ visible: !!this.windowId }));

    this.on('windowCloseRequested', async () => { await this.hide(); });

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
    if (this.windowId) {
      // Already visible, just reposition
      await this.resizeWindow();
      return true;
    }
    await this.buildUI();
    this.changed('visibility', true);
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
   * Rebuild content inside the existing window. Clears root layout and repopulates.
   */
  private async rebuild(): Promise<void> {
    if (!this.windowId || !this.rootLayoutId) return;

    // Clear all children from root layout
    await this.request(request(this.id, this.rootLayoutId, 'clearLayoutChildren', {}));
    this.systemButtons.clear();
    this.userObjButtons.clear();
    this.restoreButtons.clear();

    await this.populateContent();
    await this.resizeWindow();
  }

  // ---- UI Construction ----

  private async buildUI(): Promise<void> {
    const showableObjects = await this.discoverShowableObjects();
    const barHeight = this.computeHeight(showableObjects.length);

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\u25A0 Abjects',
        rect: { x: 8, y: this.yOffset, width: BTN_W + this.theme.tokens.space.xl * 2, height: barHeight },
        zIndex: 999,
        chromeless: true,
        draggable: true,
      })
    );

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: this.theme.tokens.space.xl, right: this.theme.tokens.space.xl, bottom: this.theme.tokens.space.xl, left: this.theme.tokens.space.xl },
        spacing: this.theme.tokens.space.sm,
      })
    );

    await this.populateContent();
  }

  private async populateContent(): Promise<void> {
    // Record the accent the labels are being baked with (used to decide when a
    // theme change needs a rebuild).
    this.lastBuiltAccent = this.theme.accent;
    const showableObjects = await this.discoverShowableObjects();

    // No blocking getState queries. Buttons render unstyled immediately.
    // Visibility events from system objects update styles via updateButtonStyle().

    // ---- Header row: "Abjects" label + gear button ----
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId!,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: LABEL_H },
    }));

    // ---- Batch create all widgets ----
    const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];

    // "Grimoire index" styling: flat, borderless, left-aligned rows rather than
    // boxed pills. Apps render in primary ink; user objects are demoted to
    // secondary so the eye lands on the built-in apps and the active entry.
    const sectionLabelStyle = { color: this.theme.accent, fontSize: 12, fontWeight: 'bold', fontFamily: 'display' };
    const ghostBg = lightenColor(this.theme.windowBg, 5);
    const appStyle = {
      background: ghostBg, borderColor: this.theme.windowBg,
      color: this.theme.textPrimary, radius: this.theme.tokens.radius.sm,
      align: 'left', fontSize: 12,
    };
    // User objects use the same font/size/ink as the apps; their icon (declared
    // emoji or the default glyph) is the only distinction, so the rail is uniform.
    const objStyle = appStyle;
    const gearStyle = { background: ghostBg, borderColor: this.theme.windowBg, color: this.theme.textSecondary, radius: this.theme.tokens.radius.sm, fontSize: 13 };

    // [0] Header label
    specs.push({ type: 'label', windowId: this.windowId!, text: '\u25A0 Abjects', style: sectionLabelStyle });
    // [1] Gear button (AppExplorer)
    specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699', style: gearStyle });
    // [2] Chat (opens ChatBrowser overview)
    specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83D\uDCAC Chat', style: appStyle });
    // [3?] Goals (optional)
    if (this.goalBrowserId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83C\uDFAF Goals', style: appStyle });
    }
    // [4] Jobs
    specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83D\uDCCB Jobs', style: appStyle });
    // [5?] Knowledge (optional)
    if (this.knowledgeBrowserId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83E\uDDE0 Knowledge', style: appStyle });
    }
    // [6?] Agents (optional)
    if (this.agentBrowserId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83E\uDD16 Agents', style: appStyle });
    }
    // [7?] Schedules (optional)
    if (this.schedulerBrowserId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\u23F0 Schedules', style: appStyle });
    }
    // [8?] Web (optional)
    if (this.webBrowserViewerId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83C\uDF10 Web', style: appStyle });
    }
    // [9?] Files (optional)
    if (this.fileManagerId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83D\uDCC1 Files', style: appStyle });
    }

    // User object buttons. Use the manifest icon when present, else a neutral
    // default so older objects (created before icons) still render an icon.
    const userObjStartIdx = specs.length;
    for (const obj of showableObjects) {
      const icon = obj.manifest.icon?.trim() || DEFAULT_OBJECT_ICON;
      specs.push({ type: 'button', windowId: this.windowId!, text: `${icon}  ${obj.manifest.name}`, style: objStyle });
    }

    // Minimized window section
    const minimizedStartIdx = specs.length;
    const minimizedCount = this.minimizedWindows.size;
    if (minimizedCount > 0) {
      specs.push({ type: 'label', windowId: this.windowId!, text: '\u25A1 Windows', style: sectionLabelStyle });
      for (const [, { title }] of this.minimizedWindows) {
        specs.push({ type: 'button', windowId: this.windowId!, text: title, style: objStyle });
      }
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    // ---- Map button IDs to targets ----
    const headerLabelId = widgetIds[0];
    const gearBtnId = widgetIds[1];
    this.systemButtons.set(gearBtnId, this.appExplorerId!);

    let idx = 2;
    this.systemButtons.set(widgetIds[idx++], this.chatBrowserId!);
    if (this.goalBrowserId) this.systemButtons.set(widgetIds[idx++], this.goalBrowserId);
    this.systemButtons.set(widgetIds[idx++], this.jobBrowserId!);
    if (this.knowledgeBrowserId) this.systemButtons.set(widgetIds[idx++], this.knowledgeBrowserId);
    if (this.agentBrowserId) this.systemButtons.set(widgetIds[idx++], this.agentBrowserId);
    if (this.schedulerBrowserId) this.systemButtons.set(widgetIds[idx++], this.schedulerBrowserId);
    if (this.webBrowserViewerId) this.systemButtons.set(widgetIds[idx++], this.webBrowserViewerId);
    if (this.fileManagerId) this.systemButtons.set(widgetIds[idx++], this.fileManagerId);

    for (let i = 0; i < showableObjects.length; i++) {
      this.userObjButtons.set(widgetIds[userObjStartIdx + i], showableObjects[i].id);
    }

    // ---- Add header row children ----
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: headerLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: LABEL_H } },
        { widgetId: gearBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: LABEL_H } },
      ],
    }));

    // ---- Add root layout children ----
    const rootChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];

    // System buttons in declaration order (skip header label + gear at indices 0–1).
    for (let i = 2; i < userObjStartIdx; i++) {
      rootChildren.push({ widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }

    // User object buttons
    for (let i = 0; i < showableObjects.length; i++) {
      rootChildren.push({ widgetId: widgetIds[userObjStartIdx + i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }

    // Minimized window section
    if (minimizedCount > 0) {
      let mIdx = minimizedStartIdx;
      rootChildren.push({ widgetId: widgetIds[mIdx++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: LABEL_H } });
      let surfaceIdx = 0;
      for (const [surfaceId] of this.minimizedWindows) {
        const btnId = widgetIds[mIdx + surfaceIdx];
        this.restoreButtons.set(btnId, surfaceId);
        rootChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
        surfaceIdx++;
      }
    }

    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChildren', {
      children: rootChildren,
    }));

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

  private computeHeight(userObjectCount: number): number {
    // Always-present row buttons: Chat + Jobs (gear sits in header row, not counted).
    const systemBtnCount = 2 + (this.webBrowserViewerId ? 1 : 0) + (this.fileManagerId ? 1 : 0) + (this.goalBrowserId ? 1 : 0) + (this.knowledgeBrowserId ? 1 : 0) + (this.agentBrowserId ? 1 : 0) + (this.schedulerBrowserId ? 1 : 0);
    const minimizedCount = this.minimizedWindows.size;
    const totalBtnCount = systemBtnCount + userObjectCount + minimizedCount;
    const extraHeight = (LABEL_H + this.theme.tokens.space.sm)
      + (minimizedCount > 0 ? (LABEL_H + this.theme.tokens.space.sm) : 0);
    return this.theme.tokens.space.xl + extraHeight + totalBtnCount * (BTN_H + this.theme.tokens.space.sm) - this.theme.tokens.space.sm + this.theme.tokens.space.xl;
  }

  private async resizeWindow(): Promise<void> {
    if (!this.windowId) return;
    const showableObjects = await this.discoverShowableObjects();
    const barHeight = this.computeHeight(showableObjects.length);
    await this.request(request(this.id, this.windowId, 'windowRect', {
      x: 8, y: this.yOffset, width: BTN_W + this.theme.tokens.space.xl * 2, height: barHeight,
    }));
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
