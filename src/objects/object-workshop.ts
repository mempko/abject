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

const WIN_W = 500;
const WIN_H = 350;
const PAD = 16;

export class ObjectWorkshop extends Abject {
  private widgetManagerId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private windowId?: AbjectId;
  private lastCreatedObjectId?: AbjectId;

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

  setDependencies(widgetManagerId: AbjectId, objectCreatorId: AbjectId): void {
    this.widgetManagerId = widgetManagerId;
    this.objectCreatorId = objectCreatorId;
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

    let y = 8;
    const inputW = WIN_W - PAD * 2;

    // Prompt label
    this.promptLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: 'Describe the object you want to create:',
      })
    );
    y += 28;

    // Text input
    this.promptInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: inputW, height: 36 },
        placeholder: 'e.g., A counter that tracks page views...',
      })
    );
    y += 48;

    // Create button
    const btnW = 100;
    this.createBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: WIN_W - PAD - btnW, y, width: btnW, height: 36 },
        text: 'Create',
      })
    );
    y += 52;

    // Status label
    this.statusLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: '',
      })
    );
    y += 28;

    // Result labels (hidden until creation succeeds)
    this.resultNameId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: '',
      })
    );
    y += 24;

    this.resultDescId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: '',
      })
    );

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
        await this.updateStatus(`Error: ${result.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    if (!this.windowId) return;
    const btnW = 100;
    this.modifyBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: PAD, y: WIN_H - 30 - 36 - 8, width: btnW, height: 36 },
        text: 'Modify',
      })
    );

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
