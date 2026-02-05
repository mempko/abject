/**
 * Registry Browser — browse all registered objects, view interfaces and methods.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { UIServer, WidgetEventPayload } from './ui-server.js';
import { Registry } from './registry.js';

const REGISTRY_BROWSER_INTERFACE: InterfaceId = 'abjects:registry-browser';
const UI_INTERFACE: InterfaceId = 'abjects:ui';

const PAGE_SIZE = 8;
const WIN_W = 500;
const WIN_H = 400;
const PAD = 16;

export class RegistryBrowser extends Abject {
  private uiServer?: UIServer;
  private registry?: Registry;
  private windowId?: string;
  private currentPage = 0;
  private cachedObjects: ObjectRegistration[] = [];

  constructor() {
    super({
      manifest: {
        name: 'RegistryBrowser',
        description:
          'Browse all registered objects in the system. View interfaces, methods, and capabilities.',
        version: '1.0.0',
        interfaces: [
          {
            id: REGISTRY_BROWSER_INTERFACE,
            name: 'RegistryBrowser',
            description: 'System object browser',
            methods: [
              {
                name: 'show',
                description: 'Show the registry browser',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the registry browser',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  setDependencies(uiServer: UIServer, registry: Registry): void {
    this.uiServer = uiServer;
    this.registry = registry;
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

    this.currentPage = 0;
    this.cachedObjects = this.registry?.listObjects() ?? [];
    await this.showListView();
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

  private async showListView(): Promise<void> {
    // Destroy existing window if any
    if (this.windowId) {
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'destroyWindow', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'createWindow', {
        title: 'Registry Browser',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
      })
    );

    const totalPages = Math.max(1, Math.ceil(this.cachedObjects.length / PAGE_SIZE));
    const start = this.currentPage * PAGE_SIZE;
    const pageItems = this.cachedObjects.slice(start, start + PAGE_SIZE);

    const itemW = WIN_W - PAD * 2;
    const itemH = 32;
    const gap = 4;
    let y = 8;

    for (let i = 0; i < pageItems.length; i++) {
      const obj = pageItems[i];
      const desc = obj.manifest.description;
      const label = `${obj.manifest.name} — ${desc.length > 40 ? desc.slice(0, 40) + '...' : desc}`;

      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: `obj-${i}`,
          type: 'button',
          rect: { x: PAD, y, width: itemW, height: itemH },
          text: label,
        })
      );
      y += itemH + gap;
    }

    // Navigation row
    y = WIN_H - 30 - 36 - 8; // account for title bar
    const navBtnW = 70;

    if (totalPages > 1) {
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'prev-page',
          type: 'button',
          rect: { x: PAD, y, width: navBtnW, height: 30 },
          text: 'Prev',
        })
      );

      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'page-label',
          type: 'label',
          rect: { x: PAD + navBtnW + 10, y, width: 200, height: 30 },
          text: `Page ${this.currentPage + 1} of ${totalPages}`,
        })
      );

      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'next-page',
          type: 'button',
          rect: { x: WIN_W - PAD - navBtnW, y, width: navBtnW, height: 30 },
          text: 'Next',
        })
      );
    }
  }

  private async showDetailView(index: number): Promise<void> {
    const absIndex = this.currentPage * PAGE_SIZE + index;
    const obj = this.cachedObjects[absIndex];
    if (!obj) return;

    // Destroy list window
    if (this.windowId) {
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'destroyWindow', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getDisplayInfo', {})
    );

    const detailH = 450;
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - detailH) / 2));

    this.windowId = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'createWindow', {
        title: obj.manifest.name,
        rect: { x: winX, y: winY, width: WIN_W, height: detailH },
        zIndex: 200,
      })
    );

    let y = 8;
    const labelH = 20;
    const lineGap = 4;

    const addLabel = async (text: string) => {
      const id = `detail-${y}`;
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id,
          type: 'label',
          rect: { x: PAD, y, width: WIN_W - PAD * 2, height: labelH },
          text,
        })
      );
      y += labelH + lineGap;
    };

    await addLabel(`Name: ${obj.manifest.name}`);
    await addLabel(`Version: ${obj.manifest.version}`);

    // Description (may be long, truncate)
    const desc = obj.manifest.description;
    await addLabel(`Description: ${desc.length > 60 ? desc.slice(0, 60) + '...' : desc}`);

    y += 4;

    // Interfaces
    for (const iface of obj.manifest.interfaces) {
      await addLabel(`Interface: ${iface.name} (${iface.id})`);
      for (const method of iface.methods) {
        const params = method.parameters.map((p) => p.name).join(', ');
        await addLabel(`  ${method.name}(${params}) — ${method.description.slice(0, 40)}`);
      }
    }

    y += 4;

    // Tags
    const tags = obj.manifest.tags ?? [];
    if (tags.length > 0) {
      await addLabel(`Tags: ${tags.join(', ')}`);
    }

    // Capabilities
    const provided = obj.manifest.providedCapabilities ?? [];
    if (provided.length > 0) {
      await addLabel(`Provides: ${provided.join(', ')}`);
    }

    const required = obj.manifest.requiredCapabilities ?? [];
    if (required.length > 0) {
      const reqNames = required.map((r) =>
        typeof r === 'string' ? r : r.capability
      );
      await addLabel(`Requires: ${reqNames.join(', ')}`);
    }

    // Back button at bottom
    const btnY = detailH - 30 - 36 - 8;
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'back-btn',
        type: 'button',
        rect: { x: PAD, y: btnY, width: 80, height: 32 },
        text: 'Back',
      })
    );
  }

  private async handleWidgetEvent(payload: WidgetEventPayload): Promise<void> {
    if (payload.type !== 'click') return;

    if (payload.widgetId === 'back-btn') {
      this.cachedObjects = this.registry?.listObjects() ?? [];
      await this.showListView();
      return;
    }

    if (payload.widgetId === 'prev-page') {
      if (this.currentPage > 0) {
        this.currentPage--;
        await this.showListView();
      }
      return;
    }

    if (payload.widgetId === 'next-page') {
      const totalPages = Math.ceil(this.cachedObjects.length / PAGE_SIZE);
      if (this.currentPage < totalPages - 1) {
        this.currentPage++;
        await this.showListView();
      }
      return;
    }

    // Object button: obj-0, obj-1, ...
    const match = payload.widgetId.match(/^obj-(\d+)$/);
    if (match) {
      const index = parseInt(match[1], 10);
      await this.showDetailView(index);
    }
  }
}

export const REGISTRY_BROWSER_ID = 'abjects:registry-browser' as AbjectId;
