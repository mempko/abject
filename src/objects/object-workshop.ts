/**
 * Object Workshop — create new objects via LLM natural language prompts.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { UIServer, WidgetEventPayload } from './ui-server.js';
import { CreationResult } from './object-creator.js';
import { EDITABLE_INTERFACE_ID } from './scriptable-abject.js';

const WORKSHOP_INTERFACE: InterfaceId = 'abjects:object-workshop';
const UI_INTERFACE: InterfaceId = 'abjects:ui';

const WIN_W = 500;
const WIN_H = 350;
const PAD = 16;

export class ObjectWorkshop extends Abject {
  private uiServer?: UIServer;
  private objectCreatorId?: AbjectId;
  private windowId?: string;
  private lastCreatedObjectId?: AbjectId;

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

  setDependencies(uiServer: UIServer, objectCreatorId: AbjectId): void {
    this.uiServer = uiServer;
    this.objectCreatorId = objectCreatorId;
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

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'createWindow', {
        title: 'Object Workshop',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    let y = 8;
    const inputW = WIN_W - PAD * 2;

    // Prompt label
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'prompt-label',
        type: 'label',
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: 'Describe the object you want to create:',
      })
    );
    y += 28;

    // Text input
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'prompt-input',
        type: 'textInput',
        rect: { x: PAD, y, width: inputW, height: 36 },
        placeholder: 'e.g., A counter that tracks page views...',
      })
    );
    y += 48;

    // Create button
    const btnW = 100;
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'create-btn',
        type: 'button',
        rect: { x: WIN_W - PAD - btnW, y, width: btnW, height: 36 },
        text: 'Create',
      })
    );
    y += 52;

    // Status label
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'status-label',
        type: 'label',
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: '',
      })
    );
    y += 28;

    // Result labels (hidden until creation succeeds)
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'result-name',
        type: 'label',
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: '',
      })
    );
    y += 24;

    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'result-desc',
        type: 'label',
        rect: { x: PAD, y, width: inputW, height: 20 },
        text: '',
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
    // Handle modify button
    if (payload.widgetId === 'modify-btn' && payload.type === 'click' && this.lastCreatedObjectId) {
      await this.handleModify();
      return;
    }

    const isCreate =
      (payload.widgetId === 'create-btn' && payload.type === 'click') ||
      (payload.widgetId === 'prompt-input' && payload.type === 'submit');

    if (!isCreate || !this.windowId) return;

    // Read prompt text
    const prompt = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getWidgetValue', {
        widgetId: 'prompt-input',
      })
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
        )
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
    if (!this.windowId) return;
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
        widgetId: 'status-label',
        text,
      })
    );
  }

  private async showModifyButton(): Promise<void> {
    if (!this.windowId) return;
    const btnW = 100;
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'modify-btn',
        type: 'button',
        rect: { x: PAD, y: WIN_H - 30 - 36 - 8, width: btnW, height: 36 },
        text: 'Modify',
      })
    );
  }

  private async handleModify(): Promise<void> {
    if (!this.windowId || !this.lastCreatedObjectId || !this.objectCreatorId) return;

    const prompt = await this.request<string>(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'getWidgetValue', {
        widgetId: 'prompt-input',
      })
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
        )
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
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
        widgetId: 'result-name',
        text: name,
      })
    );
    await this.request(
      request(this.id, this.uiServer!.id, UI_INTERFACE, 'updateWidget', {
        widgetId: 'result-desc',
        text: desc,
      })
    );
  }
}

export const OBJECT_WORKSHOP_ID = 'abjects:object-workshop' as AbjectId;
