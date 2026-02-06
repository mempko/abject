/**
 * Taskbar — persistent bottom bar with launch buttons for system UI.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private settingsId?: AbjectId;
  private registryBrowserId?: AbjectId;
  private objectWorkshopId?: AbjectId;
  private registryId?: AbjectId;
  private windowId?: string;

  constructor() {
    super({
      manifest: {
        name: 'Taskbar',
        description:
          'Persistent bottom bar with launch buttons for Settings, Registry Browser, and Object Workshop.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display taskbar', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  setDependencies(
    widgetManagerId: AbjectId,
    settingsId: AbjectId,
    registryBrowserId: AbjectId,
    objectWorkshopId: AbjectId,
    registryId: AbjectId
  ): void {
    this.widgetManagerId = widgetManagerId;
    this.settingsId = settingsId;
    this.registryBrowserId = registryBrowserId;
    this.objectWorkshopId = objectWorkshopId;
    this.registryId = registryId;
  }

  protected async onInit(): Promise<void> {
    // Subscribe to registry for auto-refresh when new objects are registered
    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        'abjects:registry' as InterfaceId, 'subscribe', {}));
    }
    await this.show();
  }

  /**
   * Look up an object in the registry via message passing.
   */
  private async registryLookup(objectId: AbjectId): Promise<ObjectRegistration | null> {
    if (!this.registryId) return null;
    return this.request<ObjectRegistration | null>(
      request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'lookup', { objectId })
    );
  }

  /**
   * Discover registered objects that have both show and hide methods (non-system).
   */
  private async discoverShowableObjects(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    const allObjects = await this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'list', {})
    );
    return allObjects.filter((obj) => {
      if ((obj.manifest.tags ?? []).includes('system')) return false;
      return obj.manifest.interfaces.some((iface) => {
        const names = iface.methods.map((m) => m.name);
        return names.includes('show') && names.includes('hide');
      });
    });
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('widgetEvent', async (msg: AbjectMessage) => {
      const payload = msg.payload as { windowId: string; widgetId: string; type: string; value?: string };
      await this.handleWidgetEvent(payload);
    });

    // Auto-refresh taskbar when new objects are registered
    this.on('objectRegistered', async () => {
      await this.show();
    });
  }

  async show(): Promise<boolean> {
    // Always destroy and rebuild to pick up new objects
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindow', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const barHeight = 40;
    const displayW = displayInfo.width;
    const displayH = displayInfo.height;

    this.windowId = await this.request<string>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindow', {
        title: '',
        rect: { x: 0, y: displayH - barHeight, width: displayW, height: barHeight },
        zIndex: 999,
        chromeless: true,
      })
    );

    const btnW = 100;
    const btnH = 30;
    const btnY = 5;
    const gap = 10;

    // System buttons start centered for 3 buttons; dynamic ones extend to the right
    const systemBtnCount = 3;
    const showableObjects = await this.discoverShowableObjects();
    const totalBtnCount = systemBtnCount + showableObjects.length;
    const totalW = btnW * totalBtnCount + gap * (totalBtnCount - 1);
    let btnX = Math.max(10, Math.floor((displayW - totalW) / 2));

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'settings-btn',
        type: 'button',
        rect: { x: btnX, y: btnY, width: btnW, height: btnH },
        text: 'Settings',
      })
    );
    btnX += btnW + gap;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'registry-btn',
        type: 'button',
        rect: { x: btnX, y: btnY, width: btnW, height: btnH },
        text: 'Registry',
      })
    );
    btnX += btnW + gap;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'workshop-btn',
        type: 'button',
        rect: { x: btnX, y: btnY, width: btnW, height: btnH },
        text: 'Workshop',
      })
    );

    // Dynamic buttons for user-created objects with show/hide
    for (const obj of showableObjects) {
      btnX += btnW + gap;
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: `user-obj::${obj.id}`,
          type: 'button',
          rect: { x: btnX, y: btnY, width: btnW, height: btnH },
          text: obj.manifest.name,
        })
      );
    }

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindow', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    return true;
  }

  private async handleWidgetEvent(payload: { windowId: string; widgetId: string; type: string; value?: string }): Promise<void> {
    if (payload.type !== 'click') return;

    if (payload.widgetId === 'settings-btn') {
      await this.request(
        request(this.id, this.settingsId!, 'abjects:settings' as InterfaceId, 'show', {})
      );
    } else if (payload.widgetId === 'registry-btn') {
      await this.request(
        request(this.id, this.registryBrowserId!, 'abjects:registry-browser' as InterfaceId, 'show', {})
      );
    } else if (payload.widgetId === 'workshop-btn') {
      await this.request(
        request(this.id, this.objectWorkshopId!, 'abjects:object-workshop' as InterfaceId, 'show', {})
      );
    } else if (payload.widgetId.startsWith('user-obj::')) {
      // Dynamic user object button — send 'show' to the object
      const objId = payload.widgetId.slice('user-obj::'.length) as AbjectId;
      const reg = await this.registryLookup(objId);
      if (reg) {
        const iface = reg.manifest.interfaces.find((i) =>
          i.methods.some((m) => m.name === 'show'));
        if (iface) {
          try {
            await this.request(request(this.id, objId, iface.id, 'show', {}));
          } catch (err) {
            console.warn(`[Taskbar] Failed to show ${reg.manifest.name}:`, err);
          }
        }
      }
    }
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
