/**
 * Registry Browser — browse all registered objects, view interfaces and methods.
 *
 * Uses direct widget Abject interaction (createWindowAbject, createLabel, etc.)
 * instead of the old string-based widget ID shim.
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
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import { CreationResult } from './object-creator.js';
import { EDITABLE_INTERFACE_ID } from './scriptable-abject.js';
import { LLMMessage, LLMCompletionResult } from '../llm/provider.js';

const REGISTRY_BROWSER_INTERFACE: InterfaceId = 'abjects:registry-browser';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';

const PAGE_SIZE = 8;
const WIN_W = 500;
const WIN_H = 400;
const PAD = 16;

export class RegistryBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private llmId?: AbjectId;
  private windowId?: AbjectId;
  private currentPage = 0;
  private cachedObjects: ObjectRegistration[] = [];
  private editingObjectId?: AbjectId;
  private detailIndex?: number;
  private selectedMethod?: { interfaceId: InterfaceId; method: string };
  private detailObjectId?: AbjectId;

  // ── List View widget tracking ──
  private objButtons: Map<AbjectId, number> = new Map();
  private prevPageBtnId?: AbjectId;
  private nextPageBtnId?: AbjectId;
  private cmdInputId?: AbjectId;
  private cmdRunBtnId?: AbjectId;
  private cmdStatusId?: AbjectId;

  // ── Detail View widget tracking ──
  private backBtnId?: AbjectId;
  private editSourceBtnId?: AbjectId;
  private methodButtons: Map<AbjectId, { interfaceId: InterfaceId; method: string }> = new Map();
  private msgPayloadId?: AbjectId;
  private msgSendBtnId?: AbjectId;
  private msgResponseId?: AbjectId;

  // ── Edit View widget tracking ──
  private sourceEditorId?: AbjectId;
  private saveBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private aiEditBtnId?: AbjectId;
  private aiPromptInputId?: AbjectId;
  private aiGoBtnId?: AbjectId;
  private editStatusId?: AbjectId;

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

  setDependencies(widgetManagerId: AbjectId, registryId: AbjectId, objectCreatorId?: AbjectId, llmId?: AbjectId): void {
    this.widgetManagerId = widgetManagerId;
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

  /**
   * Register this RegistryBrowser as a dependent of a widget Abject,
   * so we receive 'changed' events from it.
   */
  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
  }

  /**
   * Clear all view-specific widget tracking fields.
   * The window destroy takes care of actual widget cleanup.
   */
  private clearViewTracking(): void {
    // List view
    this.objButtons.clear();
    this.prevPageBtnId = undefined;
    this.nextPageBtnId = undefined;
    this.cmdInputId = undefined;
    this.cmdRunBtnId = undefined;
    this.cmdStatusId = undefined;

    // Detail view
    this.backBtnId = undefined;
    this.editSourceBtnId = undefined;
    this.methodButtons.clear();
    this.msgPayloadId = undefined;
    this.msgSendBtnId = undefined;
    this.msgResponseId = undefined;

    // Edit view
    this.sourceEditorId = undefined;
    this.saveBtnId = undefined;
    this.cancelBtnId = undefined;
    this.aiEditBtnId = undefined;
    this.aiPromptInputId = undefined;
    this.aiGoBtnId = undefined;
    this.editStatusId = undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click' && aspect !== 'submit') return;
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
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
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.clearViewTracking();
    return true;
  }

  private async showListView(): Promise<void> {
    // Destroy existing window if any
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    this.clearViewTracking();

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
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
      this.cmdInputId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
          windowId: this.windowId,
          rect: { x: PAD, y, width: cmdInputW, height: 30 },
          placeholder: 'Type a command...',
        })
      );
      await this.addDep(this.cmdInputId);

      this.cmdRunBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId,
          rect: { x: PAD + cmdInputW + 8, y, width: 60, height: 30 },
          text: 'Run',
        })
      );
      await this.addDep(this.cmdRunBtnId);

      y += 34;

      this.cmdStatusId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId,
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

      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId,
          rect: { x: PAD, y, width: itemW, height: itemH },
          text: label,
        })
      );
      await this.addDep(btnId);
      this.objButtons.set(btnId, i);

      y += itemH + gap;
    }

    // Navigation row
    y = WIN_H - 30 - 36 - 8; // account for title bar
    const navBtnW = 70;

    if (totalPages > 1) {
      this.prevPageBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId,
          rect: { x: PAD, y, width: navBtnW, height: 30 },
          text: 'Prev',
        })
      );
      await this.addDep(this.prevPageBtnId);

      await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId,
          rect: { x: PAD + navBtnW + 10, y, width: 200, height: 30 },
          text: `Page ${this.currentPage + 1} of ${totalPages}`,
        })
      );

      this.nextPageBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId,
          rect: { x: WIN_W - PAD - navBtnW, y, width: navBtnW, height: 30 },
          text: 'Next',
        })
      );
      await this.addDep(this.nextPageBtnId);
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
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    this.clearViewTracking();

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const detailH = 600;
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - detailH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: obj.manifest.name,
        rect: { x: winX, y: winY, width: WIN_W, height: detailH },
        zIndex: 200,
        resizable: true,
      })
    );

    let y = 8;
    const labelH = 20;
    const lineGap = 4;

    const addLabel = async (text: string): Promise<AbjectId> => {
      const id = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId,
          rect: { x: PAD, y, width: WIN_W - PAD * 2, height: labelH },
          text,
        })
      );
      y += labelH + lineGap;
      return id;
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
        const btnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId,
            rect: { x: bx, y, width: methodBtnW, height: methodBtnH },
            text: method.name,
          })
        );
        await this.addDep(btnId);
        this.methodButtons.set(btnId, { interfaceId: iface.id, method: method.name });
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
    this.msgPayloadId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: payloadInputW, height: 30 },
        placeholder: 'JSON payload (optional)',
      })
    );
    await this.addDep(this.msgPayloadId);

    this.msgSendBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD + payloadInputW + 8, y, width: 60, height: 30 },
        text: 'Send',
      })
    );
    await this.addDep(this.msgSendBtnId);

    y += 38;

    // Response label
    this.msgResponseId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: WIN_W - PAD * 2, height: labelH },
        text: '',
      })
    );
    y += labelH + 8;

    // ── Bottom buttons ──
    const btnY = detailH - 30 - 36 - 8;
    this.backBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD, y: btnY, width: 80, height: 32 },
        text: 'Back',
      })
    );
    await this.addDep(this.backBtnId);

    // Show "Edit Source" button if the object is scriptable
    const isEditable = obj.source !== undefined;
    if (isEditable) {
      this.detailIndex = index;
      this.editSourceBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId,
          rect: { x: PAD + 90, y: btnY, width: 110, height: 32 },
          text: 'Edit Source',
        })
      );
      await this.addDep(this.editSourceBtnId);
    }
  }

  private async showEditView(obj: ObjectRegistration): Promise<void> {
    // Destroy existing window
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    this.clearViewTracking();
    this.editingObjectId = obj.id;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const editW = 600;
    const editH = 500;
    const winX = Math.max(20, Math.floor((displayInfo.width - editW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - editH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: `Edit: ${obj.manifest.name}`,
        rect: { x: winX, y: winY, width: editW, height: editH },
        zIndex: 200,
        resizable: true,
      })
    );

    const innerW = editW - PAD * 2;
    let y = 8;

    // Object name label
    await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: innerW, height: 20 },
        text: `Source: ${obj.manifest.name}`,
      })
    );
    y += 28;

    // textArea with source code
    const textAreaH = editH - 30 - y - 80; // room for buttons + status
    this.sourceEditorId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextArea', {
        windowId: this.windowId,
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

    this.saveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: btnW, height: btnH },
        text: 'Save',
      })
    );
    await this.addDep(this.saveBtnId);

    this.cancelBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD + btnW + btnGap, y, width: btnW, height: btnH },
        text: 'Cancel',
      })
    );
    await this.addDep(this.cancelBtnId);

    this.aiEditBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD + (btnW + btnGap) * 2, y, width: btnW, height: btnH },
        text: 'AI Edit',
      })
    );
    await this.addDep(this.aiEditBtnId);

    y += btnH + 8;

    // AI edit prompt input (hidden until AI Edit is clicked, but always present)
    this.aiPromptInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: innerW - btnW - btnGap, height: 30 },
        placeholder: 'Describe what to change...',
      })
    );
    await this.addDep(this.aiPromptInputId);

    this.aiGoBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD + innerW - btnW, y, width: btnW, height: 30 },
        text: 'Go',
      })
    );
    await this.addDep(this.aiGoBtnId);

    y += 38;

    // Status label
    this.editStatusId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: innerW, height: 20 },
        text: '',
      })
    );
  }

  private async updateEditStatus(text: string): Promise<void> {
    if (!this.editStatusId) return;
    await this.request(
      request(this.id, this.editStatusId, WIDGET_INTERFACE, 'update', { text })
    );
  }

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    // ── Back button (detail view) ──
    if (fromId === this.backBtnId) {
      this.cachedObjects = await this.registryList();
      await this.showListView();
      return;
    }

    // ── Prev page button ──
    if (fromId === this.prevPageBtnId) {
      if (this.currentPage > 0) {
        this.currentPage--;
        await this.showListView();
      }
      return;
    }

    // ── Next page button ──
    if (fromId === this.nextPageBtnId) {
      const totalPages = Math.ceil(this.cachedObjects.length / PAGE_SIZE);
      if (this.currentPage < totalPages - 1) {
        this.currentPage++;
        await this.showListView();
      }
      return;
    }

    // ── Edit Source button in detail view ──
    if (fromId === this.editSourceBtnId && this.detailIndex !== undefined) {
      const absIndex = this.currentPage * PAGE_SIZE + this.detailIndex;
      const obj = this.cachedObjects[absIndex];
      if (obj) {
        await this.showEditView(obj);
      }
      return;
    }

    // ── Save button in edit view ──
    if (fromId === this.saveBtnId && this.editingObjectId) {
      const source = await this.request<string>(
        request(this.id, this.sourceEditorId!, WIDGET_INTERFACE, 'getValue', {})
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

    // ── Cancel button in edit view ──
    if (fromId === this.cancelBtnId) {
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

    // ── AI Edit: Go button or submit from prompt input ──
    if ((fromId === this.aiGoBtnId || (fromId === this.aiPromptInputId && aspect === 'submit'))
        && this.editingObjectId && this.objectCreatorId) {
      const prompt = await this.request<string>(
        request(this.id, this.aiPromptInputId!, WIDGET_INTERFACE, 'getValue', {})
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
            request(this.id, this.sourceEditorId!, WIDGET_INTERFACE, 'update', {
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

    // ── Method button in detail view (for message sending) ──
    const methodInfo = this.methodButtons.get(fromId);
    if (methodInfo) {
      this.selectedMethod = methodInfo;
      // Update response label to show selection
      if (this.msgResponseId) {
        await this.request(
          request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
            text: `Selected: ${methodInfo.method}`,
          })
        );
      }
      return;
    }

    // ── Send button in detail view ──
    if (fromId === this.msgSendBtnId && this.selectedMethod && this.detailObjectId) {
      await this.handleSendMessage();
      return;
    }

    // ── LLM command bar: Run button or submit from input ──
    if ((fromId === this.cmdRunBtnId ||
         (fromId === this.cmdInputId && aspect === 'submit'))
        && this.llmId) {
      await this.handleLLMCommand();
      return;
    }

    // ── Object button: navigate to detail view ──
    const objIndex = this.objButtons.get(fromId);
    if (objIndex !== undefined) {
      await this.showDetailView(objIndex);
    }
  }

  /**
   * Send a message to the selected method on the detail object.
   */
  private async handleSendMessage(): Promise<void> {
    if (!this.selectedMethod || !this.detailObjectId || !this.msgPayloadId) return;

    const payloadText = await this.request<string>(
      request(this.id, this.msgPayloadId, WIDGET_INTERFACE, 'getValue', {})
    );

    let msgPayload: unknown = {};
    if (payloadText.trim()) {
      try {
        msgPayload = JSON.parse(payloadText);
      } catch {
        if (this.msgResponseId) {
          await this.request(
            request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
              text: 'Error: Invalid JSON payload',
            })
          );
        }
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
      if (this.msgResponseId) {
        await this.request(
          request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
            text: `Result: ${display}`,
          })
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.msgResponseId) {
        await this.request(
          request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
            text: `Error: ${msg.slice(0, 60)}`,
          })
        );
      }
    }
  }

  /**
   * Handle LLM command bar: parse natural language and dispatch message.
   */
  private async handleLLMCommand(): Promise<void> {
    if (!this.llmId || !this.cmdInputId) return;

    const commandText = await this.request<string>(
      request(this.id, this.cmdInputId, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!commandText.trim()) {
      if (this.cmdStatusId) {
        await this.request(
          request(this.id, this.cmdStatusId, WIDGET_INTERFACE, 'update', {
            text: 'Enter a command',
          })
        );
      }
      return;
    }

    if (this.cmdStatusId) {
      await this.request(
        request(this.id, this.cmdStatusId, WIDGET_INTERFACE, 'update', {
          text: 'Thinking...',
        })
      );
    }

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
      if (this.cmdStatusId) {
        await this.request(
          request(this.id, this.cmdStatusId, WIDGET_INTERFACE, 'update', {
            text: `${parsed.method} → ${display}`,
          })
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.cmdStatusId) {
        await this.request(
          request(this.id, this.cmdStatusId, WIDGET_INTERFACE, 'update', {
            text: `Error: ${msg.slice(0, 60)}`,
          })
        );
      }
    }
  }
}

export const REGISTRY_BROWSER_ID = 'abjects:registry-browser' as AbjectId;
