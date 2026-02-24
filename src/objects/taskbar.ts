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
  private chatId?: AbjectId;
  private jobBrowserId?: AbjectId;
  private objectManagerId?: AbjectId;
  private registryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Y-offset for positioning below WorkspaceSwitcher
  private yOffset = 8;

  // Button AbjectIds for system buttons
  private settingsBtnId?: AbjectId;
  private registryBtnId?: AbjectId;
  private chatBtnId?: AbjectId;
  private jobsBtnId?: AbjectId;
  private objectManagerBtnId?: AbjectId;

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
    this.chatId = await this.requireDep('Chat');
    this.jobBrowserId = await this.requireDep('JobBrowser');
    this.objectManagerId = await this.requireDep('ObjectManager');
    this.registryId = await this.requireDep('Registry');
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;

    // Subscribe to registry for auto-refresh when new objects are registered
    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        'abjects:registry' as InterfaceId, 'subscribe', {}));
    }

    // Subscribe as dependent of each system object to receive visibility changes
    for (const depId of [this.settingsId!, this.registryBrowserId!, this.chatId!, this.jobBrowserId!, this.objectManagerId!]) {
      await this.request(request(this.id, depId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    }

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

      if (fromId === this.settingsBtnId) {
        await this.request(
          request(this.id, this.settingsId!, 'abjects:settings' as InterfaceId, 'show', {})
        );
      } else if (fromId === this.registryBtnId) {
        await this.request(
          request(this.id, this.registryBrowserId!, 'abjects:registry-browser' as InterfaceId, 'show', {})
        );
      } else if (fromId === this.chatBtnId) {
        await this.request(
          request(this.id, this.chatId!, 'abjects:chat' as InterfaceId, 'show', {})
        );
      } else if (fromId === this.jobsBtnId) {
        await this.request(
          request(this.id, this.jobBrowserId!, 'abjects:job-browser' as InterfaceId, 'show', {})
        );
      } else if (fromId === this.objectManagerBtnId) {
        await this.request(
          request(this.id, this.objectManagerId!, 'abjects:object-manager' as InterfaceId, 'show', {})
        );
      } else if (this.restoreButtons.has(fromId)) {
        // Restore a minimized window
        const surfaceId = this.restoreButtons.get(fromId)!;
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId,
              'abjects:window-manager' as InterfaceId, 'restoreWindow', { surfaceId }));
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
  }

  async show(): Promise<boolean> {
    // Always destroy and rebuild to pick up new objects
    if (this.windowId) {
      console.debug(`[Taskbar] show() — destroying old window ${this.windowId}`);
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      console.debug('[Taskbar] show() — old window destroyed');
      this.windowId = undefined;
    }

    // Reset all button tracking since window is destroyed and rebuilt
    this.settingsBtnId = undefined;
    this.registryBtnId = undefined;
    this.chatBtnId = undefined;
    this.jobsBtnId = undefined;
    this.objectManagerBtnId = undefined;
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
    const systemBtnCount = 4;
    const minimizedCount = this.minimizedWindows.size;
    const totalBtnCount = systemBtnCount + showableObjects.length + minimizedCount;
    const extraHeight = (labelH + spacing) // "Apps" label
      + (minimizedCount > 0 ? (dividerH + spacing) + (labelH + spacing) : 0);
    const barWidth = btnW + padding * 2;
    const barHeight = padding + extraHeight + totalBtnCount * (btnH + spacing) - spacing + padding;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
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
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: padding, right: padding, bottom: padding, left: padding },
        spacing,
      })
    );

    // Helper to query visibility of a system object
    const isVisible = async (objectId: AbjectId): Promise<boolean> => {
      try {
        const state = await this.request<{ visible?: boolean }>(
          request(this.id, objectId, INTROSPECT_INTERFACE_ID, 'getState', {})
        );
        return !!state?.visible;
      } catch { return false; }
    };

    const activeStyle = { background: '#2d3154', borderColor: '#e8a84c' };

    // Helper to add a fixed-size button to the layout
    const addBtn = async (text: string, active = false, style?: Record<string, unknown>): Promise<AbjectId> => {
      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text,
          ...(style ? { style } : active ? { style: activeStyle } : {}),
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

    // Helper to add a section label to the layout
    const addSectionLabel = async (text: string): Promise<void> => {
      const labelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text,
          style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: labelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: labelH },
      }));
    };

    // Helper to add a divider to the layout
    const addDivider = async (): Promise<void> => {
      const divId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createDivider', {
          windowId: this.windowId, rect: r0,
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: divId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: btnW, height: dividerH },
      }));
    };

    // ── Apps section header row: "◼ Apps" label + gear button ──
    const appsHeaderRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: appsHeaderRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: labelH },
    }));

    const appsHeaderLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: '\u25A0 Apps',
        style: { color: '#6b7084', fontSize: 11, fontWeight: 'bold' },
      })
    );
    await this.request(request(this.id, appsHeaderRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: appsHeaderLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: labelH },
    }));

    this.settingsBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: '\u2699',
        style: { fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.settingsBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, appsHeaderRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.settingsBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 24, height: labelH },
    }));

    // Query visibility of system objects
    const [registryVis, chatVis, jobsVis, objectManagerVis] = await Promise.all([
      isVisible(this.registryBrowserId!),
      isVisible(this.chatId!),
      isVisible(this.jobBrowserId!),
      isVisible(this.objectManagerId!),
    ]);

    console.debug(`[Taskbar] visibility: registry=${registryVis} chat=${chatVis} jobs=${jobsVis} processes=${objectManagerVis}`);

    // System buttons
    this.registryBtnId = await addBtn('Registry', registryVis);
    this.chatBtnId = await addBtn('Chat', chatVis);
    this.jobsBtnId = await addBtn('Jobs', jobsVis);
    this.objectManagerBtnId = await addBtn('Processes', objectManagerVis);

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
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.settingsBtnId = undefined;
    this.registryBtnId = undefined;
    this.chatBtnId = undefined;
    this.jobsBtnId = undefined;
    this.objectManagerBtnId = undefined;
    this.userObjButtons.clear();
    return true;
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
