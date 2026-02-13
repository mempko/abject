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

const WIN_W = 520;
const WIN_H = 420;

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
  private modifyBtnId?: AbjectId;

  // Progress log state
  private progressLogId?: AbjectId;
  private progressLabelIds: AbjectId[] = [];
  private activeProgressLabelId?: AbjectId;

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

    this.on('progress', async (msg: AbjectMessage) => {
      const { message } = msg.payload as { phase: string; message: string };
      if (msg.routing.from === this.objectCreatorId) {
        // Mark previous active step as completed
        await this.markActiveCompleted();
        // Append new active step
        const labelId = await this.appendLogEntry(`▸ ${message}`, { color: '#e8a84c' });
        this.activeProgressLabelId = labelId;
      }
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
        margins: { top: 16, right: 20, bottom: 16, left: 20 },
        spacing: 8,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Prompt label (styled as section header)
    this.promptLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: 'Describe the object you want to create:',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 14 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.promptLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Subtitle
    const subtitleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: 'Use natural language to describe any object.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: subtitleId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // TextArea for prompt (expanding to fill available space)
    this.promptInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextArea', {
        windowId: this.windowId,
        rect: r0,
        text: '',
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.promptInputId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      stretch: 1,
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

    // Create button (accent styling)
    this.createBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: r0,
        text: 'Create',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, createRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.createBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));

    // Progress log container (nested VBox, expanding to fill available space)
    this.progressLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 2,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.progressLogId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      stretch: 1,
    }));

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
    this.modifyBtnId = undefined;
    this.progressLogId = undefined;
    this.progressLabelIds = [];
    this.activeProgressLabelId = undefined;
    return true;
  }

  private async handleChanged(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    // Handle modify button click
    if (fromId === this.modifyBtnId && aspect === 'click' && this.lastCreatedObjectId) {
      await this.handleModify();
      return;
    }

    const isCreate =
      (fromId === this.createBtnId && aspect === 'click');

    if (!isCreate || !this.windowId) return;

    // Read prompt text
    const prompt = await this.request<string>(
      request(this.id, this.promptInputId!, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!prompt.trim()) {
      await this.clearProgressLog();
      await this.appendLogEntry('Please enter a description.', { color: '#b4b8c8' });
      return;
    }

    // Clear previous log and start fresh
    await this.clearProgressLog();
    await this.log('info', 'ObjectWorkshop: creating object', { prompt });

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
        // Mark last active step as completed
        await this.markActiveCompleted();
        // Append success entries
        await this.appendLogEntry(`✓ Created: ${result.manifest.name}`, { color: '#a8cc8c' });
        await this.appendLogEntry(`  ${result.manifest.description}`, { color: '#6b7084', fontSize: 12 });
        // Show Modify button if object was spawned
        if (result.objectId) {
          await this.showModifyButton();
        }
      } else {
        await this.log('error', 'ObjectWorkshop: creation failed', { error: result.error });
        await this.markActiveError();
        await this.appendLogEntry(`✗ ${result.error ?? 'Unknown error'}`, { color: '#e05561' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.log('error', 'ObjectWorkshop: creation error', { error: msg });
      await this.markActiveError();
      await this.appendLogEntry(`✗ ${msg}`, { color: '#e05561' });
    }
  }

  /** Append a styled label to the progress log VBox. Returns the label's AbjectId. */
  private async appendLogEntry(
    text: string,
    style: { color?: string; fontSize?: number; fontWeight?: string } = {},
  ): Promise<AbjectId> {
    const labelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        text,
        style: { color: style.color ?? '#b4b8c8', fontSize: style.fontSize ?? 13, fontWeight: style.fontWeight },
      })
    );
    await this.request(request(this.id, this.progressLogId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));
    this.progressLabelIds.push(labelId);
    return labelId;
  }

  /** Clear all labels from the progress log. */
  private async clearProgressLog(): Promise<void> {
    if (!this.progressLogId) return;
    for (const labelId of this.progressLabelIds) {
      try {
        await this.request(request(this.id, this.progressLogId, LAYOUT_INTERFACE, 'removeLayoutChild', {
          widgetId: labelId,
        }));
        await this.request(request(this.id, labelId, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* widget may already be gone */ }
    }
    this.progressLabelIds = [];
    this.activeProgressLabelId = undefined;
  }

  /** Mark the current active progress step as completed (checkmark, dim). */
  private async markActiveCompleted(): Promise<void> {
    if (!this.activeProgressLabelId) return;
    const labelId = this.activeProgressLabelId;
    this.activeProgressLabelId = undefined;
    try {
      const currentText = await this.request<string>(
        request(this.id, labelId, WIDGET_INTERFACE, 'getValue', {})
      );
      const stepText = currentText.replace(/^▸\s*/, '');
      await this.request(
        request(this.id, labelId, WIDGET_INTERFACE, 'update', {
          text: `✓ ${stepText}`,
          style: { color: '#6b7084', fontSize: 13 },
        })
      );
    } catch { /* label may be gone */ }
  }

  /** Mark the current active progress step as errored (✗, red). */
  private async markActiveError(): Promise<void> {
    if (!this.activeProgressLabelId) return;
    const labelId = this.activeProgressLabelId;
    this.activeProgressLabelId = undefined;
    try {
      const currentText = await this.request<string>(
        request(this.id, labelId, WIDGET_INTERFACE, 'getValue', {})
      );
      const stepText = currentText.replace(/^▸\s*/, '');
      await this.request(
        request(this.id, labelId, WIDGET_INTERFACE, 'update', {
          text: `✗ ${stepText}`,
          style: { color: '#e05561', fontSize: 13 },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async showModifyButton(): Promise<void> {
    if (!this.windowId || !this.rootLayoutId) return;
    this.modifyBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        text: 'Modify',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
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
      await this.clearProgressLog();
      await this.appendLogEntry('Enter a modification description.', { color: '#b4b8c8' });
      return;
    }

    await this.clearProgressLog();
    await this.log('info', 'ObjectWorkshop: modifying object', { objectId: this.lastCreatedObjectId, prompt });

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
          await this.markActiveCompleted();
          await this.appendLogEntry('✓ Modified successfully', { color: '#a8cc8c' });
        } else {
          await this.markActiveError();
          await this.appendLogEntry(`✗ Compile error: ${updateResult.error ?? 'Unknown'}`, { color: '#e05561' });
        }
      } else {
        await this.markActiveError();
        await this.appendLogEntry(`✗ ${result.error ?? 'Unknown'}`, { color: '#e05561' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markActiveError();
      await this.appendLogEntry(`✗ ${msg}`, { color: '#e05561' });
    }
  }

}

export const OBJECT_WORKSHOP_ID = 'abjects:object-workshop' as AbjectId;
