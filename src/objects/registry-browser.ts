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
import { CreationResult } from './object-creator.js';
import { EDITABLE_INTERFACE_ID } from './scriptable-abject.js';
import { LLMMessage, LLMCompletionResult } from '../llm/provider.js';

const REGISTRY_BROWSER_INTERFACE: InterfaceId = 'abjects:registry-browser';
const UI_INTERFACE: InterfaceId = 'abjects:ui';

const PAGE_SIZE = 8;
const WIN_W = 500;
const WIN_H = 400;
const PAD = 16;

export class RegistryBrowser extends Abject {
  private uiServer?: UIServer;
  private registryId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private llmId?: AbjectId;
  private windowId?: string;
  private currentPage = 0;
  private cachedObjects: ObjectRegistration[] = [];
  private editingObjectId?: AbjectId;
  private detailIndex?: number;
  private selectedMethod?: { interfaceId: InterfaceId; method: string };
  private detailObjectId?: AbjectId;

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

  setDependencies(uiServer: UIServer, registryId: AbjectId, objectCreatorId?: AbjectId, llmId?: AbjectId): void {
    this.uiServer = uiServer;
    this.registryId = registryId;
    this.objectCreatorId = objectCreatorId;
    this.llmId = llmId;
  }

  /**
   * List objects from registry via message passing.
   */
  private async registryList(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'list', {})
    );
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
    this.cachedObjects = await this.registryList();
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
        resizable: true,
      })
    );

    let y = 8;

    // LLM command bar (only when LLM is available)
    if (this.llmId) {
      const cmdInputW = WIN_W - PAD * 2 - 70;
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'cmd-input',
          type: 'textInput',
          rect: { x: PAD, y, width: cmdInputW, height: 30 },
          placeholder: 'Type a command...',
        })
      );
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'cmd-run-btn',
          type: 'button',
          rect: { x: PAD + cmdInputW + 8, y, width: 60, height: 30 },
          text: 'Run',
        })
      );
      y += 34;

      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'cmd-status',
          type: 'label',
          rect: { x: PAD, y, width: WIN_W - PAD * 2, height: 20 },
          text: '',
        })
      );
      y += 24;
    }

    const totalPages = Math.max(1, Math.ceil(this.cachedObjects.length / PAGE_SIZE));
    const start = this.currentPage * PAGE_SIZE;
    const pageItems = this.cachedObjects.slice(start, start + PAGE_SIZE);

    const itemW = WIN_W - PAD * 2;
    const itemH = 32;
    const gap = 4;

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

    // Store for message sending
    this.detailObjectId = obj.id;
    this.selectedMethod = undefined;

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

    const detailH = 600;
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - detailH) / 2));

    this.windowId = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'createWindow', {
        title: obj.manifest.name,
        rect: { x: winX, y: winY, width: WIN_W, height: detailH },
        zIndex: 200,
        resizable: true,
      })
    );

    let y = 8;
    const labelH = 20;
    const lineGap = 4;
    let labelIdx = 0;

    const addLabel = async (text: string) => {
      const id = `detail-lbl-${labelIdx++}`;
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

    y += 8;

    // ── Send Message section ──
    await addLabel('Send Message:');

    // Method buttons (compact, 2 per row)
    const methodBtnW = Math.floor((WIN_W - PAD * 2 - 8) / 2);
    const methodBtnH = 26;
    let col = 0;
    for (const iface of obj.manifest.interfaces) {
      for (const method of iface.methods) {
        const bx = PAD + col * (methodBtnW + 8);
        await this.request(
          request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
            windowId: this.windowId,
            id: `method-btn::${iface.id}::${method.name}`,
            type: 'button',
            rect: { x: bx, y, width: methodBtnW, height: methodBtnH },
            text: method.name,
          })
        );
        col++;
        if (col >= 2) {
          col = 0;
          y += methodBtnH + 4;
        }
      }
    }
    if (col !== 0) {
      y += methodBtnH + 4;
    }
    y += 4;

    // Payload input
    const payloadInputW = WIN_W - PAD * 2 - 70;
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'msg-payload',
        type: 'textInput',
        rect: { x: PAD, y, width: payloadInputW, height: 30 },
        placeholder: 'JSON payload (optional)',
      })
    );
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'msg-send-btn',
        type: 'button',
        rect: { x: PAD + payloadInputW + 8, y, width: 60, height: 30 },
        text: 'Send',
      })
    );
    y += 38;

    // Response label
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'msg-response',
        type: 'label',
        rect: { x: PAD, y, width: WIN_W - PAD * 2, height: labelH },
        text: '',
      })
    );
    y += labelH + 8;

    // ── Bottom buttons ──
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

    // Show "Edit Source" button if the object is scriptable
    const isEditable = obj.source !== undefined;
    if (isEditable) {
      this.detailIndex = index;
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
          windowId: this.windowId,
          id: 'edit-source-btn',
          type: 'button',
          rect: { x: PAD + 90, y: btnY, width: 110, height: 32 },
          text: 'Edit Source',
        })
      );
    }
  }

  private async showEditView(obj: ObjectRegistration): Promise<void> {
    // Destroy existing window
    if (this.windowId) {
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'destroyWindow', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    this.editingObjectId = obj.id;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getDisplayInfo', {})
    );

    const editW = 600;
    const editH = 500;
    const winX = Math.max(20, Math.floor((displayInfo.width - editW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - editH) / 2));

    this.windowId = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'createWindow', {
        title: `Edit: ${obj.manifest.name}`,
        rect: { x: winX, y: winY, width: editW, height: editH },
        zIndex: 200,
        resizable: true,
      })
    );

    const innerW = editW - PAD * 2;
    let y = 8;

    // Object name label
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'edit-name-label',
        type: 'label',
        rect: { x: PAD, y, width: innerW, height: 20 },
        text: `Source: ${obj.manifest.name}`,
      })
    );
    y += 28;

    // textArea with source code
    const textAreaH = editH - 30 - y - 80; // room for buttons + status
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'source-editor',
        type: 'textArea',
        rect: { x: PAD, y, width: innerW, height: textAreaH },
        text: obj.source ?? '',
        monospace: true,
      })
    );
    y += textAreaH + 8;

    // Button row
    const btnW = 80;
    const btnH = 32;
    const btnGap = 8;

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'save-btn',
        type: 'button',
        rect: { x: PAD, y, width: btnW, height: btnH },
        text: 'Save',
      })
    );

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'cancel-btn',
        type: 'button',
        rect: { x: PAD + btnW + btnGap, y, width: btnW, height: btnH },
        text: 'Cancel',
      })
    );

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'ai-edit-btn',
        type: 'button',
        rect: { x: PAD + (btnW + btnGap) * 2, y, width: btnW, height: btnH },
        text: 'AI Edit',
      })
    );

    y += btnH + 8;

    // AI edit prompt input (hidden until AI Edit is clicked, but always present)
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'ai-prompt-input',
        type: 'textInput',
        rect: { x: PAD, y, width: innerW - btnW - btnGap, height: 30 },
        placeholder: 'Describe what to change...',
      })
    );

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'ai-go-btn',
        type: 'button',
        rect: { x: PAD + innerW - btnW, y, width: btnW, height: 30 },
        text: 'Go',
      })
    );

    y += 38;

    // Status label
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'edit-status',
        type: 'label',
        rect: { x: PAD, y, width: innerW, height: 20 },
        text: '',
      })
    );
  }

  private async updateEditStatus(text: string): Promise<void> {
    if (!this.windowId) return;
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
        widgetId: 'edit-status',
        text,
      })
    );
  }

  private async handleWidgetEvent(payload: WidgetEventPayload): Promise<void> {
    if (payload.type !== 'click' && payload.type !== 'submit') return;

    if (payload.widgetId === 'back-btn') {
      this.cachedObjects = await this.registryList();
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

    // Edit Source button in detail view
    if (payload.widgetId === 'edit-source-btn' && this.detailIndex !== undefined) {
      const absIndex = this.currentPage * PAGE_SIZE + this.detailIndex;
      const obj = this.cachedObjects[absIndex];
      if (obj) {
        await this.showEditView(obj);
      }
      return;
    }

    // Save button in edit view
    if (payload.widgetId === 'save-btn' && this.editingObjectId) {
      const source = await this.request<string>(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'getWidgetValue', {
          widgetId: 'source-editor',
        })
      );

      try {
        // Send updateSource to the ScriptableAbject
        const result = await this.request<{ success: boolean; error?: string }>(
          request(this.id, this.editingObjectId, EDITABLE_INTERFACE_ID, 'updateSource', {
            source,
          })
        );

        if (result.success) {
          // Also update registry source via message passing
          if (this.registryId) {
            await this.request(
              request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'updateSource', {
                objectId: this.editingObjectId, source,
              })
            );
          }
          await this.updateEditStatus('Saved successfully');
        } else {
          await this.updateEditStatus(`Error: ${result.error ?? 'Unknown'}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.updateEditStatus(`Error: ${msg}`);
      }
      return;
    }

    // Cancel button in edit view
    if (payload.widgetId === 'cancel-btn') {
      if (this.detailIndex !== undefined) {
        this.editingObjectId = undefined;
        await this.showDetailView(this.detailIndex);
      } else {
        this.editingObjectId = undefined;
        this.cachedObjects = await this.registryList();
        await this.showListView();
      }
      return;
    }

    // AI Edit: Go button or submit from prompt input
    if ((payload.widgetId === 'ai-go-btn' || (payload.widgetId === 'ai-prompt-input' && payload.type === 'submit'))
        && this.editingObjectId && this.objectCreatorId) {
      const prompt = await this.request<string>(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'getWidgetValue', {
          widgetId: 'ai-prompt-input',
        })
      );

      if (!prompt.trim()) {
        await this.updateEditStatus('Enter a description of changes');
        return;
      }

      await this.updateEditStatus('AI editing...');

      try {
        const result = await this.request<CreationResult>(
          request(
            this.id,
            this.objectCreatorId!,
            'abjects:object-creator' as InterfaceId,
            'modify',
            { objectId: this.editingObjectId, prompt }
          )
        );

        if (result.success && result.code) {
          // Update the textArea with new source
          await this.request(
            request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
              widgetId: 'source-editor',
              text: result.code,
            })
          );
          await this.updateEditStatus('AI edit applied (review and Save)');
        } else {
          await this.updateEditStatus(`AI error: ${result.error ?? 'Unknown'}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.updateEditStatus(`AI error: ${msg}`);
      }
      return;
    }

    // Method button in detail view (for message sending)
    if (payload.widgetId.startsWith('method-btn::')) {
      const parts = payload.widgetId.split('::');
      this.selectedMethod = { interfaceId: parts[1] as InterfaceId, method: parts[2] };
      // Update response label to show selection
      if (this.windowId) {
        await this.request(
          request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
            widgetId: 'msg-response',
            text: `Selected: ${parts[2]}`,
          })
        );
      }
      return;
    }

    // Send button in detail view
    if (payload.widgetId === 'msg-send-btn' && this.selectedMethod && this.detailObjectId) {
      await this.handleSendMessage();
      return;
    }

    // LLM command bar: Run button or submit from input
    if ((payload.widgetId === 'cmd-run-btn' ||
         (payload.widgetId === 'cmd-input' && payload.type === 'submit'))
        && this.llmId) {
      await this.handleLLMCommand();
      return;
    }

    // Object button: obj-0, obj-1, ...
    const match = payload.widgetId.match(/^obj-(\d+)$/);
    if (match) {
      const index = parseInt(match[1], 10);
      await this.showDetailView(index);
    }
  }

  /**
   * Send a message to the selected method on the detail object.
   */
  private async handleSendMessage(): Promise<void> {
    if (!this.selectedMethod || !this.detailObjectId || !this.windowId) return;

    const payloadText = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getWidgetValue', {
        widgetId: 'msg-payload',
      })
    );

    let msgPayload: unknown = {};
    if (payloadText.trim()) {
      try {
        msgPayload = JSON.parse(payloadText);
      } catch {
        await this.request(
          request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
            widgetId: 'msg-response',
            text: 'Error: Invalid JSON payload',
          })
        );
        return;
      }
    }

    try {
      const result = await this.request<unknown>(request(
        this.id, this.detailObjectId,
        this.selectedMethod.interfaceId, this.selectedMethod.method, msgPayload
      ));
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const display = resultStr.length > 60 ? resultStr.slice(0, 60) + '...' : resultStr;
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
          widgetId: 'msg-response',
          text: `Result: ${display}`,
        })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
          widgetId: 'msg-response',
          text: `Error: ${msg.slice(0, 60)}`,
        })
      );
    }
  }

  /**
   * Handle LLM command bar: parse natural language and dispatch message.
   */
  private async handleLLMCommand(): Promise<void> {
    if (!this.llmId || !this.windowId) return;

    const commandText = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getWidgetValue', {
        widgetId: 'cmd-input',
      })
    );

    if (!commandText.trim()) {
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
          widgetId: 'cmd-status', text: 'Enter a command',
        })
      );
      return;
    }

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
        widgetId: 'cmd-status', text: 'Thinking...',
      })
    );

    try {
      // Build object context for the LLM
      const objects = await this.registryList();
      const objectContext = objects.map((o) => {
        const methods = o.manifest.interfaces.flatMap((iface) =>
          iface.methods.map((m) => ({
            interface: iface.id,
            method: m.name,
            params: m.parameters.map((p) => p.name),
            description: m.description,
          }))
        );
        return { id: o.id, name: o.manifest.name, description: o.manifest.description, methods };
      });

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `You are a command interpreter for the Abjects system.
Available objects:
${JSON.stringify(objectContext, null, 2)}

The user will give you a natural language command. Figure out which object and method to call.
Respond with ONLY valid JSON (no markdown fences, no explanation):
{"objectId": "...", "interface": "...", "method": "...", "payload": {}}`,
        },
        { role: 'user', content: commandText },
      ];

      const llmResult = await this.request<LLMCompletionResult>(
        request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'complete', { messages })
      );

      // Parse LLM response (strip markdown fences if present)
      let responseText = llmResult.content.trim();
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) {
        responseText = fenceMatch[1];
      }

      const parsed = JSON.parse(responseText) as {
        objectId: string;
        interface: string;
        method: string;
        payload: unknown;
      };

      // Dispatch the message
      const result = await this.request<unknown>(request(
        this.id,
        parsed.objectId as AbjectId,
        parsed.interface as InterfaceId,
        parsed.method,
        parsed.payload ?? {}
      ));

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const display = resultStr.length > 50 ? resultStr.slice(0, 50) + '...' : resultStr;
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
          widgetId: 'cmd-status',
          text: `${parsed.method} → ${display}`,
        })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.request(
        request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
          widgetId: 'cmd-status',
          text: `Error: ${msg.slice(0, 60)}`,
        })
      );
    }
  }
}

export const REGISTRY_BROWSER_ID = 'abjects:registry-browser' as AbjectId;
