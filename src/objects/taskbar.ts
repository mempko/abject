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
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private settingsId?: AbjectId;
  private registryBrowserId?: AbjectId;
  private objectWorkshopId?: AbjectId;
  private registryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Button AbjectIds for system buttons
  private settingsBtnId?: AbjectId;
  private registryBtnId?: AbjectId;
  private workshopBtnId?: AbjectId;

  // Dynamic user object buttons: button widget AbjectId → target object AbjectId
  private userObjButtons: Map<AbjectId, AbjectId> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'Taskbar',
        description:
          'Persistent vertical toolbar in the top-left with launch buttons for Settings, Registry Browser, and Object Workshop.',
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

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.settingsId = await this.requireDep('Settings');
    this.registryBrowserId = await this.requireDep('RegistryBrowser');
    this.objectWorkshopId = await this.requireDep('ObjectWorkshop');
    this.registryId = await this.requireDep('Registry');

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

    // Handle 'changed' events from button widget Abjects (dependency protocol)
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      if (fromId === this.settingsBtnId) {
        await this.request(
          request(this.id, this.settingsId!, 'abjects:settings' as InterfaceId, 'show', {})
        );
      } else if (fromId === this.registryBtnId) {
        await this.request(
          request(this.id, this.registryBrowserId!, 'abjects:registry-browser' as InterfaceId, 'show', {})
        );
      } else if (fromId === this.workshopBtnId) {
        await this.request(
          request(this.id, this.objectWorkshopId!, 'abjects:object-workshop' as InterfaceId, 'show', {})
        );
      } else {
        // Check dynamic user object buttons
        const targetId = this.userObjButtons.get(fromId);
        if (targetId) {
          const reg = await this.registryLookup(targetId);
          if (reg) {
            const iface = reg.manifest.interfaces.find((i) =>
              i.methods.some((m) => m.name === 'show'));
            if (iface) {
              try {
                await this.request(request(this.id, targetId, iface.id, 'show', {}));
              } catch (err) {
                console.warn(`[Taskbar] Failed to show ${reg.manifest.name}:`, err);
              }
            } else {
              console.warn(`[Taskbar] No show interface found for ${reg.manifest.name}`);
            }
          } else {
            console.warn(`[Taskbar] Registry lookup failed for ${targetId}`);
          }
        }
      }
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
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    // Reset all button tracking since window is destroyed and rebuilt
    this.settingsBtnId = undefined;
    this.registryBtnId = undefined;
    this.workshopBtnId = undefined;
    this.rootLayoutId = undefined;
    this.userObjButtons.clear();

    const showableObjects = await this.discoverShowableObjects();

    const btnW = 100;
    const btnH = 30;
    const padding = 16;
    const spacing = 6;
    const systemBtnCount = 3;
    const totalBtnCount = systemBtnCount + showableObjects.length;
    const barWidth = btnW + padding * 2;
    const barHeight = padding + totalBtnCount * (btnH + spacing) - spacing + padding;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: '',
        rect: { x: 8, y: 8, width: barWidth, height: barHeight },
        zIndex: 999,
        chromeless: true,
        draggable: true,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout (vertical stack)
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: padding, right: padding, bottom: padding, left: padding },
        spacing,
      })
    );

    // Helper to add a fixed-size button to the layout
    const addBtn = async (text: string): Promise<AbjectId> => {
      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text,
        })
      );
      await this.request(
        request(this.id, btnId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: btnId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: btnH },
      }));
      return btnId;
    };

    // System buttons
    this.settingsBtnId = await addBtn('Settings');
    this.registryBtnId = await addBtn('Registry');
    this.workshopBtnId = await addBtn('Workshop');

    // Dynamic buttons for user-created objects with show/hide
    for (const obj of showableObjects) {
      const btnId = await addBtn(obj.manifest.name);
      this.userObjButtons.set(btnId, obj.id);
    }

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.settingsBtnId = undefined;
    this.registryBtnId = undefined;
    this.workshopBtnId = undefined;
    this.userObjButtons.clear();
    return true;
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
