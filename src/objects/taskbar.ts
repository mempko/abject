/**
 * Taskbar — persistent bottom bar with launch buttons for system UI.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { UIServer, WidgetEventPayload } from './ui-server.js';
import { Settings } from './settings.js';
import { RegistryBrowser } from './registry-browser.js';
import { ObjectWorkshop } from './object-workshop.js';

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';
const UI_INTERFACE: InterfaceId = 'abjects:ui';

export class Taskbar extends Abject {
  private uiServer?: UIServer;
  private settings?: Settings;
  private registryBrowser?: RegistryBrowser;
  private objectWorkshop?: ObjectWorkshop;
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
    uiServer: UIServer,
    settings: Settings,
    registryBrowser: RegistryBrowser,
    objectWorkshop: ObjectWorkshop
  ): void {
    this.uiServer = uiServer;
    this.settings = settings;
    this.registryBrowser = registryBrowser;
    this.objectWorkshop = objectWorkshop;
  }

  protected async onInit(): Promise<void> {
    await this.show();
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('widgetEvent', async (msg: AbjectMessage) => {
      const payload = msg.payload as WidgetEventPayload;
      await this.handleWidgetEvent(payload);
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getDisplayInfo', {})
    );

    const barHeight = 40;
    const displayW = displayInfo.width;
    const displayH = displayInfo.height;

    this.windowId = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'createWindow', {
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
    const totalW = btnW * 3 + gap * 2;
    let btnX = Math.floor((displayW - totalW) / 2);

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'settings-btn',
        type: 'button',
        rect: { x: btnX, y: btnY, width: btnW, height: btnH },
        text: 'Settings',
      })
    );
    btnX += btnW + gap;

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'registry-btn',
        type: 'button',
        rect: { x: btnX, y: btnY, width: btnW, height: btnH },
        text: 'Registry',
      })
    );
    btnX += btnW + gap;

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'workshop-btn',
        type: 'button',
        rect: { x: btnX, y: btnY, width: btnW, height: btnH },
        text: 'Workshop',
      })
    );

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'destroyWindow', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    return true;
  }

  private async handleWidgetEvent(payload: WidgetEventPayload): Promise<void> {
    if (payload.type !== 'click') return;

    if (payload.widgetId === 'settings-btn') {
      await this.request(
        request(this.id, this.settings!.id, 'abjects:settings' as InterfaceId, 'show', {})
      );
    } else if (payload.widgetId === 'registry-btn') {
      await this.request(
        request(this.id, this.registryBrowser!.id, 'abjects:registry-browser' as InterfaceId, 'show', {})
      );
    } else if (payload.widgetId === 'workshop-btn') {
      await this.request(
        request(this.id, this.objectWorkshop!.id, 'abjects:object-workshop' as InterfaceId, 'show', {})
      );
    }
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
