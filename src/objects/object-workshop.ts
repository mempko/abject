/**
 * Object Workshop — create new objects via LLM natural language prompts.
 *
 * Uses direct widget Abject interaction (AbjectId-based) instead of string-based
 * widget ID shims.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import { CreationResult } from './object-creator.js';
import { EDITABLE_INTERFACE_ID } from './scriptable-abject.js';

const WORKSHOP_INTERFACE: InterfaceId = 'abjects:object-workshop';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const WIN_W = 500;
const WIN_H = 350;

export class ObjectWorkshop extends Abject {
  private widgetManagerId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private consoleId?: AbjectId;
  private windowId?: AbjectId;
  private lastCreatedObjectId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Widget AbjectIds
  private promptLabelId?: AbjectId;
  private promptInputId?: AbjectId;
  private createBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private resultNameId?: AbjectId;
  private resultDescId?: AbjectId;
  private modifyBtnId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'ObjectWorkshop',
        description:
          'Create new objects by describing them in natural language. Uses the LLM to generate object code.',
        version: '1.0.0',
        interfaces: [
          {
            id: WORKSHOP_INTERFACE,
            name: 'ObjectWorkshop',
            description: 'Object creation UI',
            methods: [
              {
                name: 'show',
                description: 'Show the object workshop',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the object workshop',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display workshop window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'creation'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.objectCreatorId = await this.requireDep('ObjectCreator');
    this.consoleId = await this.discoverDep('Console') ?? undefined;
  }

  private async log(level: string, message: string, data?: unknown): Promise<void> {
    if (!this.consoleId) return;
    try {
      await this.send(
        request(this.id, this.consoleId, 'abjects:console' as InterfaceId, level, { message, data })
      );
    } catch { /* logging should never break the caller */ }
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
      const fromId = msg.routing.from;
      await this.handleChanged(fromId, aspect, value);
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Object Workshop',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 8,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Prompt label
    this.promptLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: 'Describe the object you want to create:',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.promptLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Text input (expanding horizontally, fixed height)
    this.promptInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: r0,
        placeholder: 'e.g., A counter that tracks page views...',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.promptInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // HBox for Create button (spacer pushes it right)
    const createRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: createRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Spacer pushes button right
    await this.request(request(this.id, createRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Create button
    this.createBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: r0,
        text: 'Create',
      })
    );
    await this.request(request(this.id, createRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.createBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));

    // Status label
    this.statusLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: '',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Result name label
    this.resultNameId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: '',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.resultNameId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Result description label
    this.resultDescId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: '',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.resultDescId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Spacer pushes modify button to bottom
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Register as dependent of interactive widgets to receive 'changed' events
    await this.request(
      request(this.id, this.createBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
    );
    await this.request(
      request(this.id, this.promptInputId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
    );

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
    this.promptLabelId = undefined;
    this.promptInputId = undefined;
    this.createBtnId = undefined;
    this.statusLabelId = undefined;
    this.resultNameId = undefined;
    this.resultDescId = undefined;
    this.modifyBtnId = undefined;
    return true;
  }

  private async handleChanged(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    // Handle modify button click
    if (fromId === this.modifyBtnId && aspect === 'click' && this.lastCreatedObjectId) {
      await this.handleModify();
      return;
    }

    const isCreate =
      (fromId === this.createBtnId && aspect === 'click') ||
      (fromId === this.promptInputId && aspect === 'submit');

    if (!isCreate || !this.windowId) return;

    // Read prompt text
    const prompt = await this.request<string>(
      request(this.id, this.promptInputId!, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!prompt.trim()) {
      await this.updateStatus('Please enter a description.');
      return;
    }

    // Show creating status
    await this.log('info', 'ObjectWorkshop: creating object', { prompt });
    await this.updateStatus('Creating...');
    await this.updateResult('', '');

    try {
      const result = await this.request<CreationResult>(
        request(
          this.id,
          this.objectCreatorId!,
          'abjects:object-creator' as InterfaceId,
          'create',
          { prompt }
        ),
        120000
      );

      if (result.success && result.manifest) {
        this.lastCreatedObjectId = result.objectId;
        await this.log('info', 'ObjectWorkshop: object created', { name: result.manifest.name, objectId: result.objectId });
        await this.updateStatus(`Created: ${result.manifest.name}`);
        await this.updateResult(
          `Name: ${result.manifest.name}`,
          `Description: ${result.manifest.description}`
        );
        // Show Modify button if object was spawned
        if (result.objectId) {
          await this.showModifyButton();
        }
      } else {
        await this.log('error', 'ObjectWorkshop: creation failed', { error: result.error });
        await this.updateStatus(`Error: ${result.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.log('error', 'ObjectWorkshop: creation error', { error: msg });
      await this.updateStatus(`Error: ${msg}`);
    }
  }

  private async updateStatus(text: string): Promise<void> {
    if (!this.windowId || !this.statusLabelId) return;
    await this.request(
      request(this.id, this.statusLabelId, WIDGET_INTERFACE, 'update', { text })
    );
  }

  private async showModifyButton(): Promise<void> {
    if (!this.windowId || !this.rootLayoutId) return;
    this.modifyBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        text: 'Modify',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.modifyBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));

    // Register as dependent to receive click events
    await this.request(
      request(this.id, this.modifyBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
    );
  }

  private async handleModify(): Promise<void> {
    if (!this.windowId || !this.lastCreatedObjectId || !this.objectCreatorId) return;

    const prompt = await this.request<string>(
      request(this.id, this.promptInputId!, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!prompt.trim()) {
      await this.updateStatus('Enter a modification description.');
      return;
    }

    await this.log('info', 'ObjectWorkshop: modifying object', { objectId: this.lastCreatedObjectId, prompt });
    await this.updateStatus('Modifying...');

    try {
      const result = await this.request<CreationResult>(
        request(
          this.id,
          this.objectCreatorId!,
          'abjects:object-creator' as InterfaceId,
          'modify',
          { objectId: this.lastCreatedObjectId, prompt }
        ),
        120000
      );

      if (result.success && result.code) {
        // Send updateSource to the ScriptableAbject
        const updateResult = await this.request<{ success: boolean; error?: string }>(
          request(this.id, this.lastCreatedObjectId, EDITABLE_INTERFACE_ID, 'updateSource', {
            source: result.code,
          })
        );

        if (updateResult.success) {
          await this.updateStatus('Modified successfully');
        } else {
          await this.updateStatus(`Compile error: ${updateResult.error ?? 'Unknown'}`);
        }
      } else {
        await this.updateStatus(`Error: ${result.error ?? 'Unknown'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStatus(`Error: ${msg}`);
    }
  }

  private async updateResult(name: string, desc: string): Promise<void> {
    if (!this.windowId) return;
    if (this.resultNameId) {
      await this.request(
        request(this.id, this.resultNameId, WIDGET_INTERFACE, 'update', { text: name })
      );
    }
    if (this.resultDescId) {
      await this.request(
        request(this.id, this.resultDescId, WIDGET_INTERFACE, 'update', { text: desc })
      );
    }
  }
}

export const OBJECT_WORKSHOP_ID = 'abjects:object-workshop' as AbjectId;
