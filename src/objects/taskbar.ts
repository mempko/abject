/**
 * Taskbar — persistent bottom bar with launch buttons for system UI.
 *
 * Migrated to direct widget Abject interaction: creates windows and buttons
 * via createWindowAbject/createButton factory methods, registers as dependent
 * of each button, and listens for 'changed' events with aspect === 'click'.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Taskbar');

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private appExplorerId?: AbjectId;
  private chatId?: AbjectId;
  private jobBrowserId?: AbjectId;
  private objectManagerId?: AbjectId;
  private webBrowserViewerId?: AbjectId;
  private registryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Y-offset for positioning below WorkspaceSwitcher
  private yOffset = 8;

  // Button AbjectIds for system buttons
  private registryBtnId?: AbjectId;
  private chatBtnId?: AbjectId;
  private jobsBtnId?: AbjectId;
  private objectManagerBtnId?: AbjectId;
  private browserViewerBtnId?: AbjectId;

  // Dynamic user object buttons: button widget AbjectId → target object AbjectId
  private userObjButtons: Map<AbjectId, AbjectId> = new Map();

  // Debounce timer for incremental updates
  private updateTimer?: ReturnType<typeof setTimeout>;

  // Guard against concurrent show() rebuilds (prevents double rendering)
  private showInProgress = false;

  // Minimized window tracking
  private minimizedWindows: Map<string, { windowId: AbjectId; title: string }> = new Map();
  // Button widget AbjectId → surfaceId for restore buttons
  private restoreButtons: Map<AbjectId, string> = new Map();
  private windowManagerId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Taskbar',
        description:
          'Persistent vertical toolbar in the top-left with launch buttons for Settings, Registry Browser, Chat, and Jobs.',
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
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.appExplorerId = await this.requireDep('AppExplorer');
    this.chatId = await this.requireDep('Chat');
    this.jobBrowserId = await this.requireDep('JobBrowser');
    this.objectManagerId = await this.requireDep('ObjectManager');
    this.webBrowserViewerId = await this.discoverDep('WebBrowserViewer') ?? undefined;
    this.registryId = await this.requireDep('Registry');
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;

    // Subscribe to registry for auto-refresh when new objects are registered
    if (this.registryId) {
      await this.request(request(this.id, this.registryId, 'subscribe', {}));
    }

    // Subscribe as dependent of each system object to receive visibility changes
    const depIds = [this.appExplorerId!, this.chatId!, this.jobBrowserId!, this.objectManagerId!];
    if (this.webBrowserViewerId) depIds.push(this.webBrowserViewerId);
    for (const depId of depIds) {
      await this.request(request(this.id, depId, 'addDependent', {}));
    }

  }

  /**
   * Look up an object in the registry via message passing.
   */
  private async registryLookup(objectId: AbjectId): Promise<ObjectRegistration | null> {
    if (!this.registryId) return null;
    return this.request<ObjectRegistration | null>(
      request(this.id, this.registryId, 'lookup', { objectId })
    );
  }

  /**
   * Discover registered objects that have both show and hide methods (non-system).
   */
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

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as { yOffset?: number } | undefined;
      if (payload?.yOffset !== undefined) {
        this.yOffset = payload.yOffset;
      }
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    // Handle 'changed' events from button widget Abjects (dependency protocol)
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };

      if (aspect === 'visibility') {
        await this.updateButtonStates();
        return;
      }

      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      if (fromId === this.registryBtnId) {
        await this.request(
          request(this.id, this.appExplorerId!, 'show', {})
        );
      } else if (fromId === this.chatBtnId) {
        await this.request(
          request(this.id, this.chatId!, 'show', {})
        );
      } else if (fromId === this.jobsBtnId) {
        await this.request(
          request(this.id, this.jobBrowserId!, 'show', {})
        );
      } else if (fromId === this.objectManagerBtnId) {
        await this.request(
          request(this.id, this.objectManagerId!, 'show', {})
        );
      } else if (fromId === this.browserViewerBtnId && this.webBrowserViewerId) {
        await this.request(
          request(this.id, this.webBrowserViewerId, 'show', {})
        );
      } else if (this.restoreButtons.has(fromId)) {
        // Restore a minimized window
        const surfaceId = this.restoreButtons.get(fromId)!;
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId, 'restoreWindow', { surfaceId }));
          } catch (err) {
            log.warn('Failed to restore window:', err);
          }
        }
      } else {
        // Check dynamic user object buttons
        const targetId = this.userObjButtons.get(fromId);
        if (targetId) {
          const reg = await this.registryLookup(targetId);
          if (reg) {
            const iface = reg.manifest.interface;
            const hasShow = iface && iface.methods.some((m) => m.name === 'show');
            if (hasShow) {
              try {
                await this.request(request(this.id, targetId, 'show', {}));
              } catch (err) {
                log.warn(`Failed to show ${reg.manifest.name}:`, err);
              }
            } else {
              log.warn(`No show method found for ${reg.manifest.name}`);
            }
          } else {
            log.warn(`Registry lookup failed for ${targetId}`);
          }
        }
      }
    });

    // Handle windowMinimized event from WindowManager
    this.on('windowMinimized', async (msg: AbjectMessage) => {
      const { surfaceId, windowId, title } = msg.payload as {
        surfaceId: string; windowId: AbjectId; title: string;
      };
      this.minimizedWindows.set(surfaceId, { windowId, title });
      await this.show();
    });

    // Handle windowRestored event from WindowManager
    this.on('windowRestored', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      this.minimizedWindows.delete(surfaceId);
      await this.show();
    });

    // Auto-refresh taskbar when new objects are registered
    this.on('objectRegistered', async () => {
      this.scheduleUpdate();
    });

    // Auto-refresh taskbar when objects are unregistered (killed)
    this.on('objectUnregistered', async () => {
      this.scheduleUpdate();
    });
  }

  /**
   * Schedule a debounced incremental update (coalesces rapid-fire registry events).
   */
  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = undefined;
      await this.update();
    }, 100);
  }

  /**
   * Incremental update: diff current buttons against desired state and patch.
   */
  private async update(): Promise<void> {
    if (this.showInProgress) return;
    if (!this.windowId || !this.rootLayoutId) {
      await this.show();
      return;
    }

    const showableObjects = await this.discoverShowableObjects();
    const desiredIds = new Set(showableObjects.map(o => o.id));

    // Remove buttons for objects no longer showable
    for (const [btnId, targetId] of this.userObjButtons) {
      if (!desiredIds.has(targetId)) {
        await this.request(request(this.id, this.rootLayoutId!, 'removeLayoutChild', { widgetId: btnId }));
        await this.request(request(this.id, btnId, 'destroy', {}));
        this.userObjButtons.delete(btnId);
      }
    }

    // Add buttons for newly showable objects
    const existingTargets = new Set(this.userObjButtons.values());

    const btnW = 100;
    const btnH = 30;
    const activeStyle = { background: '#2d3154', borderColor: '#e8a84c' };

    const newObjects = showableObjects.filter(obj => !existingTargets.has(obj.id));
    if (newObjects.length > 0) {
      // Query visibility in parallel
      const visResults = await Promise.all(
        newObjects.map(async (obj) => {
          try {
            const state = await this.request<{ visible?: boolean }>(
              request(this.id, obj.id, 'getState', {})
            );
            return !!state?.visible;
          } catch { return false; }
        })
      );

      // Batch create buttons
      const specs = newObjects.map((obj, i) => ({
        type: 'button' as const,
        windowId: this.windowId!,
        text: obj.manifest.name,
        ...(visResults[i] ? { style: activeStyle } : {}),
      }));

      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );

      // Batch add to layout
      const children = widgetIds.map(id => ({
        widgetId: id,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: btnH },
      }));
      await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChildren', { children }));

      // Track and fire-and-forget addDep
      for (let i = 0; i < newObjects.length; i++) {
        this.userObjButtons.set(widgetIds[i], newObjects[i].id);
        this.send(request(this.id, widgetIds[i], 'addDependent', {}));
      }
    }

    // Update button active states
    await this.updateButtonStates();

    // Resize window to fit current button count
    await this.resizeWindow();
  }

  /**
   * Update active/inactive style on all buttons without destroying them.
   */
  private async updateButtonStates(): Promise<void> {
    if (!this.windowId) return;

    const activeStyle = { background: '#2d3154', borderColor: '#e8a84c' };
    const inactiveStyle = { background: undefined, borderColor: undefined };

    const isVisible = async (objectId: AbjectId): Promise<boolean> => {
      try {
        const state = await this.request<{ visible?: boolean }>(
          request(this.id, objectId, 'getState', {})
        );
        return !!state?.visible;
      } catch { return false; }
    };

    // System buttons
    const systemPairs: [AbjectId | undefined, AbjectId | undefined][] = [
      [this.registryBtnId, this.appExplorerId],
      [this.chatBtnId, this.chatId],
      [this.jobsBtnId, this.jobBrowserId],
      [this.objectManagerBtnId, this.objectManagerId],
      [this.browserViewerBtnId, this.webBrowserViewerId],
    ];

    const updates = systemPairs
      .filter(([btnId, objId]) => btnId && objId)
      .map(async ([btnId, objId]) => {
        const vis = await isVisible(objId!);
        await this.request(request(this.id, btnId!, 'update', {
          style: vis ? activeStyle : inactiveStyle,
        }));
      });

    // User object buttons
    for (const [btnId, targetId] of this.userObjButtons) {
      updates.push((async () => {
        const vis = await isVisible(targetId);
        await this.request(request(this.id, btnId, 'update', {
          style: vis ? activeStyle : inactiveStyle,
        }));
      })());
    }

    await Promise.all(updates);
  }

  /**
   * Resize the taskbar window to fit the current number of buttons.
   */
  private async resizeWindow(): Promise<void> {
    if (!this.windowId) return;

    const btnH = 30;
    const labelH = 20;
    const dividerH = 8;
    const padding = 16;
    const spacing = 6;
    const btnW = 100;
    const systemBtnCount = 3 + (this.webBrowserViewerId ? 1 : 0);
    const minimizedCount = this.minimizedWindows.size;
    const userBtnCount = this.userObjButtons.size;
    const totalBtnCount = systemBtnCount + userBtnCount + minimizedCount;
    const extraHeight = (labelH + spacing)
      + (minimizedCount > 0 ? (dividerH + spacing) + (labelH + spacing) : 0);
    const barWidth = btnW + padding * 2;
    const barHeight = padding + extraHeight + totalBtnCount * (btnH + spacing) - spacing + padding;

    await this.request(request(this.id, this.windowId, 'windowRect', {
      x: 8, y: this.yOffset, width: barWidth, height: barHeight,
    }));
  }

  async show(): Promise<boolean> {
    if (this.showInProgress) return false; // Skip concurrent rebuild
    this.showInProgress = true;
    try {
    return await this._showImpl();
    } finally {
      this.showInProgress = false;
    }
  }

  private async _showImpl(): Promise<boolean> {
    // Always destroy and rebuild to pick up new objects
    if (this.windowId) {
      log.info(`show() — destroying old window ${this.windowId}`);
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      log.info('show() — old window destroyed');
      this.windowId = undefined;
    }

    // Reset all button tracking since window is destroyed and rebuilt
    this.registryBtnId = undefined;

    this.chatBtnId = undefined;
    this.jobsBtnId = undefined;
    this.objectManagerBtnId = undefined;
    this.browserViewerBtnId = undefined;
    this.rootLayoutId = undefined;
    this.userObjButtons.clear();
    this.restoreButtons.clear();

    const showableObjects = await this.discoverShowableObjects();

    const btnW = 100;
    const btnH = 30;
    const labelH = 20;
    const dividerH = 8;
    const padding = 16;
    const spacing = 6;
    const systemBtnCount = 3 + (this.webBrowserViewerId ? 1 : 0);
    const minimizedCount = this.minimizedWindows.size;
    const totalBtnCount = systemBtnCount + showableObjects.length + minimizedCount;
    const extraHeight = (labelH + spacing) // "Apps" header row
      + (minimizedCount > 0 ? (dividerH + spacing) + (labelH + spacing) : 0);
    const barWidth = btnW + padding * 2;
    const barHeight = padding + extraHeight + totalBtnCount * (btnH + spacing) - spacing + padding;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '',
        rect: { x: 8, y: this.yOffset, width: barWidth, height: barHeight },
        zIndex: 999,
        chromeless: true,
        draggable: true,
      })
    );

    // Create root VBox layout (vertical stack)
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: padding, right: padding, bottom: padding, left: padding },
        spacing,
      })
    );

    // Helper to query visibility of a system object
    const isVisible = async (objectId: AbjectId): Promise<boolean> => {
      try {
        const state = await this.request<{ visible?: boolean }>(
          request(this.id, objectId, 'getState', {})
        );
        return !!state?.visible;
      } catch { return false; }
    };

    const activeStyle = { background: '#2d3154', borderColor: '#e8a84c' };

    // ── Apps section header row: "■ Apps" label + gear button ──
    const appsHeaderRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: appsHeaderRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: labelH },
    }));

    // Query visibility of all system objects in parallel
    const visPromises: Promise<boolean>[] = [
      isVisible(this.appExplorerId!),
      isVisible(this.chatId!),
      isVisible(this.jobBrowserId!),
      isVisible(this.objectManagerId!),
    ];
    if (this.webBrowserViewerId) visPromises.push(isVisible(this.webBrowserViewerId));

    // Query showable object visibility in parallel
    const showableVisPromises = showableObjects.map(obj => isVisible(obj.id));

    const [visResults, showableVisResults] = await Promise.all([
      Promise.all(visPromises),
      Promise.all(showableVisPromises),
    ]);
    const [registryVis, chatVis, jobsVis, objectManagerVis] = visResults;
    const browserViewerVis = this.webBrowserViewerId ? visResults[4] : false;

    log.info(`visibility: registry=${registryVis} chat=${chatVis} jobs=${jobsVis} processes=${objectManagerVis} browser=${browserViewerVis}`);

    // Batch create all widgets: header label, gear button, system buttons, user buttons, minimize section
    const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];

    // 0: Apps header label
    specs.push({ type: 'label', windowId: this.windowId!, text: '\u25A0 Apps', style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' } });
    // 1: Gear button
    specs.push({ type: 'button', windowId: this.windowId!, text: '\u2699', style: { fontSize: 13, ...(registryVis ? activeStyle : {}) } });
    // 2: Chat button
    specs.push({ type: 'button', windowId: this.windowId!, text: 'Chat', ...(chatVis ? { style: activeStyle } : {}) });
    // 3: Jobs button
    specs.push({ type: 'button', windowId: this.windowId!, text: 'Jobs', ...(jobsVis ? { style: activeStyle } : {}) });
    // 4: Processes button
    specs.push({ type: 'button', windowId: this.windowId!, text: 'Processes', ...(objectManagerVis ? { style: activeStyle } : {}) });
    // 5?: Browser button (optional)
    if (this.webBrowserViewerId) {
      specs.push({ type: 'button', windowId: this.windowId!, text: 'Browser', ...(browserViewerVis ? { style: activeStyle } : {}) });
    }
    // User object buttons
    const userObjStartIdx = specs.length;
    for (let i = 0; i < showableObjects.length; i++) {
      const vis = showableVisResults[i];
      specs.push({ type: 'button', windowId: this.windowId!, text: showableObjects[i].manifest.name, ...(vis ? { style: activeStyle } : {}) });
    }
    // Minimized window section
    const minimizedStartIdx = specs.length;
    if (minimizedCount > 0) {
      specs.push({ type: 'divider', windowId: this.windowId!, text: '' });
      specs.push({ type: 'label', windowId: this.windowId!, text: '\u25A1 Windows', style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' } });
      for (const [, { title }] of this.minimizedWindows) {
        specs.push({ type: 'button', windowId: this.windowId!, text: title });
      }
    }

    // One batch create for all widgets
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    // Assign IDs
    const appsLabelId = widgetIds[0];
    this.registryBtnId = widgetIds[1];
    this.chatBtnId = widgetIds[2];
    this.jobsBtnId = widgetIds[3];
    this.objectManagerBtnId = widgetIds[4];
    let nextIdx = 5;
    if (this.webBrowserViewerId) {
      this.browserViewerBtnId = widgetIds[nextIdx++];
    }

    // Map user object buttons
    for (let i = 0; i < showableObjects.length; i++) {
      this.userObjButtons.set(widgetIds[userObjStartIdx + i], showableObjects[i].id);
    }

    // Add header row children
    await this.request(request(this.id, appsHeaderRowId, 'addLayoutChildren', {
      children: [
        { widgetId: appsLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: labelH } },
        { widgetId: this.registryBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } },
      ],
    }));

    // Build root layout children: all system buttons + user buttons
    const rootChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];
    const allButtonIds = [this.chatBtnId, this.jobsBtnId, this.objectManagerBtnId];
    if (this.browserViewerBtnId) allButtonIds.push(this.browserViewerBtnId);
    for (const btnId of allButtonIds) {
      rootChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });
    }
    for (let i = 0; i < showableObjects.length; i++) {
      rootChildren.push({ widgetId: widgetIds[userObjStartIdx + i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });
    }

    // Minimized section
    if (minimizedCount > 0) {
      let mIdx = minimizedStartIdx;
      rootChildren.push({ widgetId: widgetIds[mIdx++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: dividerH } }); // divider
      rootChildren.push({ widgetId: widgetIds[mIdx++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: labelH } }); // label
      let surfaceIdx = 0;
      for (const [surfaceId] of this.minimizedWindows) {
        const btnId = widgetIds[mIdx + surfaceIdx];
        this.restoreButtons.set(btnId, surfaceId);
        rootChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } });
        surfaceIdx++;
      }
    }

    // Batch add all to root layout
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChildren', {
      children: rootChildren,
    }));

    // Fire-and-forget: register as dependent for all interactive buttons
    this.send(request(this.id, this.registryBtnId, 'addDependent', {}));
    for (const btnId of allButtonIds) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }
    for (let i = 0; i < showableObjects.length; i++) {
      this.send(request(this.id, widgetIds[userObjStartIdx + i], 'addDependent', {}));
    }
    if (minimizedCount > 0) {
      for (const [btnId] of this.restoreButtons) {
        this.send(request(this.id, btnId, 'addDependent', {}));
      }
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
    this.registryBtnId = undefined;

    this.chatBtnId = undefined;
    this.jobsBtnId = undefined;
    this.objectManagerBtnId = undefined;
    this.browserViewerBtnId = undefined;
    this.userObjButtons.clear();
    return true;
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
