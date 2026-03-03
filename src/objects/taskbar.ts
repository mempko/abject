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

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private registryBrowserId?: AbjectId;
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
    this.registryBrowserId = await this.requireDep('RegistryBrowser');
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
    const depIds = [this.registryBrowserId!, this.chatId!, this.jobBrowserId!, this.objectManagerId!];
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
        console.debug('[Taskbar] visibility changed — rebuilding');
        await this.show(); // rebuild to reflect new state
        return;
      }

      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      if (fromId === this.registryBtnId) {
        await this.request(
          request(this.id, this.registryBrowserId!, 'show', {})
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
            console.warn('[Taskbar] Failed to restore window:', err);
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
                console.warn(`[Taskbar] Failed to show ${reg.manifest.name}:`, err);
              }
            } else {
              console.warn(`[Taskbar] No show method found for ${reg.manifest.name}`);
            }
          } else {
            console.warn(`[Taskbar] Registry lookup failed for ${targetId}`);
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
      console.debug('[Taskbar] objectRegistered — rebuilding taskbar');
      await this.show();
      console.debug('[Taskbar] objectRegistered — done');
    });

    // Auto-refresh taskbar when objects are unregistered (killed)
    this.on('objectUnregistered', async () => {
      console.debug('[Taskbar] objectUnregistered — rebuilding taskbar');
      await this.show();
      console.debug('[Taskbar] objectUnregistered — done');
    });
  }

  async show(): Promise<boolean> {
    // Always destroy and rebuild to pick up new objects
    if (this.windowId) {
      console.debug(`[Taskbar] show() — destroying old window ${this.windowId}`);
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      console.debug('[Taskbar] show() — old window destroyed');
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
    const systemBtnCount = 4 + (this.webBrowserViewerId ? 1 : 0);
    const minimizedCount = this.minimizedWindows.size;
    const totalBtnCount = systemBtnCount + showableObjects.length + minimizedCount;
    const extraHeight = (labelH + spacing) // "Apps" label
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

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

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

    // Helper to add a fixed-size button to the layout
    const addBtn = async (text: string, active = false, style?: Record<string, unknown>): Promise<AbjectId> => {
      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createButton', {
          windowId: this.windowId, rect: r0, text,
          ...(style ? { style } : active ? { style: activeStyle } : {}),
        })
      );
      await this.request(
        request(this.id, btnId, 'addDependent', {})
      );
      await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
        widgetId: btnId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: btnH },
      }));
      return btnId;
    };

    // Helper to add a section label to the layout
    const addSectionLabel = async (text: string): Promise<void> => {
      const labelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text,
          style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
        widgetId: labelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: labelH },
      }));
    };

    // Helper to add a divider to the layout
    const addDivider = async (): Promise<void> => {
      const divId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createDivider', {
          windowId: this.windowId, rect: r0,
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
        widgetId: divId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: dividerH },
      }));
    };

    await addSectionLabel('\u25A0 Apps');

    // Query visibility of system objects
    const visPromises: Promise<boolean>[] = [
      isVisible(this.registryBrowserId!),
      isVisible(this.chatId!),
      isVisible(this.jobBrowserId!),
      isVisible(this.objectManagerId!),
    ];
    if (this.webBrowserViewerId) visPromises.push(isVisible(this.webBrowserViewerId));
    const visResults = await Promise.all(visPromises);
    const [registryVis, chatVis, jobsVis, objectManagerVis] = visResults;
    const browserViewerVis = this.webBrowserViewerId ? visResults[4] : false;

    console.debug(`[Taskbar] visibility: registry=${registryVis} chat=${chatVis} jobs=${jobsVis} processes=${objectManagerVis} browser=${browserViewerVis}`);

    // System buttons
    this.registryBtnId = await addBtn('Registry', registryVis);
    this.chatBtnId = await addBtn('Chat', chatVis);
    this.jobsBtnId = await addBtn('Jobs', jobsVis);
    this.objectManagerBtnId = await addBtn('Processes', objectManagerVis);
    if (this.webBrowserViewerId) {
      this.browserViewerBtnId = await addBtn('Browser', browserViewerVis);
    }

    // Dynamic buttons for user-created objects with show/hide
    for (const obj of showableObjects) {
      const vis = await isVisible(obj.id);
      const btnId = await addBtn(obj.manifest.name, vis);
      this.userObjButtons.set(btnId, obj.id);
    }

    // ── Windows section (only when there are minimized windows) ──
    if (minimizedCount > 0) {
      await addDivider();
      await addSectionLabel('\u25A1 Windows');
    }

    // Minimized window restore buttons
    for (const [surfaceId, { title }] of this.minimizedWindows) {
      const btnId = await addBtn(title);
      this.restoreButtons.set(btnId, surfaceId);
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
