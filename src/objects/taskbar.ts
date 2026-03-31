/**
 * Taskbar -- persistent vertical bar with launch buttons for workspace apps.
 *
 * Uses the standard show/hide pattern: destroys and rebuilds the window on
 * each show(). On data changes (registry events, minimize/restore), rebuilds
 * the content by clearing the root layout and repopulating it.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { event, request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Taskbar');

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';

const BTN_W = 120;
const BTN_H = 30;
const LABEL_H = 20;
const PADDING = 16;
const SPACING = 6;

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private appExplorerId?: AbjectId;
  private chatId?: AbjectId;
  private jobBrowserId?: AbjectId;
  private webBrowserViewerId?: AbjectId;
  private goalBrowserId?: AbjectId;
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

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.appExplorerId = await this.requireDep('AppExplorer');
    this.chatId = await this.requireDep('Chat');
    this.jobBrowserId = await this.requireDep('JobBrowser');
    this.webBrowserViewerId = await this.discoverDep('WebBrowserViewer') ?? undefined;
    this.goalBrowserId = await this.discoverDep('GoalBrowser') ?? undefined;
    this.registryId = await this.requireDep('Registry');
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;

    if (this.registryId) {
      await this.request(request(this.id, this.registryId, 'subscribe', {}));
    }
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as { yOffset?: number } | undefined;
      if (payload?.yOffset !== undefined) {
        this.yOffset = payload.yOffset;
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
        rect: { x: 8, y: this.yOffset, width: BTN_W + PADDING * 2, height: barHeight },
        zIndex: 999,
        chromeless: true,
        draggable: true,
      })
    );

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: PADDING, right: PADDING, bottom: PADDING, left: PADDING },
        spacing: SPACING,
      })
    );

    await this.populateContent();
  }

  private async populateContent(): Promise<void> {
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

    // [0] Header label
    specs.push({ type: 'label', windowId: this.windowId!, text: '\u25A0 Abjects',
      style: { color: this.theme.accent, fontSize: 11, fontWeight: 'bold' } });
    // [1] Gear button (AppExplorer)
    specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699',
      style: { fontSize: 13 } });
    // [2] Chat
    specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83D\uDCAC Chat' });
    // [3?] Goals (optional)
    if (this.goalBrowserId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83C\uDFAF Goals' });
    }
    // [4] Jobs
    specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83D\uDCCB Jobs' });
    // [5?] Web (optional)
    if (this.webBrowserViewerId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: '\uD83C\uDF10 Web' });
    }

    // User object buttons
    const userObjStartIdx = specs.length;
    for (const obj of showableObjects) {
      specs.push({ type: 'button', windowId: this.windowId!, text: obj.manifest.name });
    }

    // Minimized window section
    const minimizedStartIdx = specs.length;
    const minimizedCount = this.minimizedWindows.size;
    if (minimizedCount > 0) {
      specs.push({ type: 'label', windowId: this.windowId!, text: '\u25A1 Windows',
        style: { color: this.theme.accent, fontSize: 11, fontWeight: 'bold' } });
      for (const [, { title }] of this.minimizedWindows) {
        specs.push({ type: 'button', windowId: this.windowId!, text: title });
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
    this.systemButtons.set(widgetIds[idx++], this.chatId!);
    if (this.goalBrowserId) this.systemButtons.set(widgetIds[idx++], this.goalBrowserId);
    this.systemButtons.set(widgetIds[idx++], this.jobBrowserId!);
    if (this.webBrowserViewerId) this.systemButtons.set(widgetIds[idx++], this.webBrowserViewerId);

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

    // System buttons (skip gear, it's in the header row)
    for (const [btnId] of this.systemButtons) {
      if (btnId === gearBtnId) continue;
      rootChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
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
    const depIds = [this.appExplorerId!, this.chatId!, this.jobBrowserId!];
    if (this.webBrowserViewerId) depIds.push(this.webBrowserViewerId);
    if (this.goalBrowserId) depIds.push(this.goalBrowserId);
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
    const systemBtnCount = 2 + (this.webBrowserViewerId ? 1 : 0) + (this.goalBrowserId ? 1 : 0);
    const minimizedCount = this.minimizedWindows.size;
    const totalBtnCount = systemBtnCount + userObjectCount + minimizedCount;
    const extraHeight = (LABEL_H + SPACING)
      + (minimizedCount > 0 ? (LABEL_H + SPACING) : 0);
    return PADDING + extraHeight + totalBtnCount * (BTN_H + SPACING) - SPACING + PADDING;
  }

  private async resizeWindow(): Promise<void> {
    if (!this.windowId) return;
    const showableObjects = await this.discoverShowableObjects();
    const barHeight = this.computeHeight(showableObjects.length);
    await this.request(request(this.id, this.windowId, 'windowRect', {
      x: 8, y: this.yOffset, width: BTN_W + PADDING * 2, height: barHeight,
    }));
  }

  /**
   * Update a single button's active/inactive style by target object ID.
   * Cheap: one message to one button widget, no layout rebuild.
   */
  private async updateButtonStyle(targetId: AbjectId, visible: boolean): Promise<void> {
    if (!this.windowId) return;
    const activeStyle = { background: this.theme.activeItemBg, borderColor: this.theme.activeItemBorder };
    const inactiveStyle = { background: undefined, borderColor: undefined };
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
