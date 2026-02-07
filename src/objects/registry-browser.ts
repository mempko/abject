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
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const PAGE_SIZE = 8;
const WIN_W = 500;
const WIN_H = 500;

export class RegistryBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private llmId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
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

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.objectCreatorId = await this.discoverDep('ObjectCreator') ?? undefined;
    this.llmId = await this.discoverDep('LLM') ?? undefined;

    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        'abjects:registry' as InterfaceId, 'subscribe', {}));
    }
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
    this.rootLayoutId = undefined;
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

    this.on('objectRegistered', async () => {
      this.cachedObjects = await this.registryList();
      if (this.windowId) {
        await this.showListView();
      }
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

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 4,
      })
    );

    // LLM command bar (only when LLM is available)
    if (this.llmId) {
      const cmdRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: cmdRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 30 },
      }));

      this.cmdInputId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
          windowId: this.windowId, rect: r0, placeholder: 'Type a command...',
        })
      );
      await this.addDep(this.cmdInputId);
      await this.request(request(this.id, cmdRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.cmdInputId,
        sizePolicy: { horizontal: 'expanding' },
        preferredSize: { height: 30 },
      }));

      this.cmdRunBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: 'Run',
        })
      );
      await this.addDep(this.cmdRunBtnId);
      await this.request(request(this.id, cmdRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.cmdRunBtnId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 60, height: 30 },
      }));

      this.cmdStatusId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text: '',
        })
      );
      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.cmdStatusId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 },
      }));
    }

    const totalPages = Math.max(1, Math.ceil(this.cachedObjects.length / PAGE_SIZE));
    const start = this.currentPage * PAGE_SIZE;
    const pageItems = this.cachedObjects.slice(start, start + PAGE_SIZE);

    // Object buttons (expanding horizontally)
    for (let i = 0; i < pageItems.length; i++) {
      const obj = pageItems[i];
      const desc = obj.manifest.description;
      const label = `${obj.manifest.name} — ${desc.length > 40 ? desc.slice(0, 40) + '...' : desc}`;

      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: label,
        })
      );
      await this.addDep(btnId);
      this.objButtons.set(btnId, i);

      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: btnId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));
    }

    // Spacer pushes nav to bottom
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Navigation row
    if (totalPages > 1) {
      const navRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 10,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: navRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 30 },
      }));

      this.prevPageBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: 'Prev',
        })
      );
      await this.addDep(this.prevPageBtnId);
      await this.request(request(this.id, navRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.prevPageBtnId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 70, height: 30 },
      }));

      const pageLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0,
          text: `Page ${this.currentPage + 1} of ${totalPages}`,
        })
      );
      await this.request(request(this.id, navRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: pageLabelId,
        sizePolicy: { horizontal: 'expanding' },
        preferredSize: { height: 30 },
      }));

      this.nextPageBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: 'Next',
        })
      );
      await this.addDep(this.nextPageBtnId);
      await this.request(request(this.id, navRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.nextPageBtnId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 70, height: 30 },
      }));
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

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 4,
      })
    );

    const addLabel = async (text: string): Promise<AbjectId> => {
      const id = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text,
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: id,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 },
      }));
      return id;
    };

    await addLabel(`Name: ${obj.manifest.name}`);
    await addLabel(`Version: ${obj.manifest.version}`);

    const desc = obj.manifest.description;
    await addLabel(`Description: ${desc.length > 60 ? desc.slice(0, 60) + '...' : desc}`);

    // Interfaces
    for (const iface of obj.manifest.interfaces) {
      await addLabel(`Interface: ${iface.name} (${iface.id})`);
      for (const method of iface.methods) {
        const params = method.parameters.map((p) => p.name).join(', ');
        await addLabel(`  ${method.name}(${params}) — ${method.description.slice(0, 40)}`);
      }
    }

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

    // ── Send Message section ──
    await addLabel('Send Message:');

    // Method buttons in 2-col HBox rows
    const allMethods: { interfaceId: InterfaceId; method: string }[] = [];
    for (const iface of obj.manifest.interfaces) {
      for (const method of iface.methods) {
        allMethods.push({ interfaceId: iface.id, method: method.name });
      }
    }

    for (let i = 0; i < allMethods.length; i += 2) {
      const rowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: rowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 26 },
      }));

      for (let j = i; j < Math.min(i + 2, allMethods.length); j++) {
        const m = allMethods[j];
        const btnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId, rect: r0, text: m.method,
          })
        );
        await this.addDep(btnId);
        this.methodButtons.set(btnId, m);
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: btnId,
          sizePolicy: { horizontal: 'expanding' },
          preferredSize: { height: 26 },
        }));
      }
    }

    // Payload row (HBox: input + Send)
    const payloadRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: payloadRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.msgPayloadId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'JSON payload (optional)',
      })
    );
    await this.addDep(this.msgPayloadId);
    await this.request(request(this.id, payloadRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.msgPayloadId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.msgSendBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Send',
      })
    );
    await this.addDep(this.msgSendBtnId);
    await this.request(request(this.id, payloadRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.msgSendBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 60, height: 30 },
    }));

    // Response label
    this.msgResponseId = await addLabel('');

    // Spacer pushes bottom buttons down
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Bottom buttons row
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 10,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: bottomRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.backBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Back',
      })
    );
    await this.addDep(this.backBtnId);
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.backBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    // Show "Edit Source" button if the object is scriptable
    const isEditable = obj.source !== undefined;
    if (isEditable) {
      this.detailIndex = index;
      this.editSourceBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: 'Edit Source',
        })
      );
      await this.addDep(this.editSourceBtnId);
      await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.editSourceBtnId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 110, height: 32 },
      }));
    }

    // Right spacer in bottom row
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));
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

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 8,
      })
    );

    // Object name label
    const nameLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: `Source: ${obj.manifest.name}`,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // TextArea with source code (expanding both axes)
    this.sourceEditorId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextArea', {
        windowId: this.windowId, rect: r0, text: obj.source ?? '', monospace: true,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.sourceEditorId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      stretch: 1,
    }));

    // Button row (HBox: Save, Cancel, AI Edit)
    const btnRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: btnRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.saveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save',
      })
    );
    await this.addDep(this.saveBtnId);
    await this.request(request(this.id, btnRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.saveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    this.cancelBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Cancel',
      })
    );
    await this.addDep(this.cancelBtnId);
    await this.request(request(this.id, btnRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.cancelBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    this.aiEditBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'AI Edit',
      })
    );
    await this.addDep(this.aiEditBtnId);
    await this.request(request(this.id, btnRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.aiEditBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    await this.request(request(this.id, btnRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // AI edit prompt row (HBox: input + Go)
    const aiRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: aiRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.aiPromptInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Describe what to change...',
      })
    );
    await this.addDep(this.aiPromptInputId);
    await this.request(request(this.id, aiRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.aiPromptInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.aiGoBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Go',
      })
    );
    await this.addDep(this.aiGoBtnId);
    await this.request(request(this.id, aiRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.aiGoBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 30 },
    }));

    // Status label
    this.editStatusId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: '',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.editStatusId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
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
