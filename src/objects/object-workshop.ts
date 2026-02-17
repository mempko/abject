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

const WORKSHOP_INTERFACE: InterfaceId = 'abjects:object-workshop';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const WIN_W = 520;
const WIN_H = 420;

type WorkshopPhase = 'closed' | 'input' | 'creating' | 'success' | 'error';

export class ObjectWorkshop extends Abject {
  private widgetManagerId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private consoleId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Input phase widgets
  private promptLabelId?: AbjectId;
  private subtitleId?: AbjectId;
  private promptInputId?: AbjectId;
  private createRowId?: AbjectId;
  private createBtnId?: AbjectId;

  // Creating phase widgets
  private creatingLabelId?: AbjectId;
  private resetRowId?: AbjectId;
  private resetBtnId?: AbjectId;

  // Progress log state
  private progressLogId?: AbjectId;
  private progressLabelIds: AbjectId[] = [];
  private activeProgressLabelId?: AbjectId;

  // State machine
  private phase: WorkshopPhase = 'closed';
  private lastPrompt = '';

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
      if (this.phase !== 'creating') return;
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

  async show(prefill?: string): Promise<boolean> {
    if (this.windowId) {
      // Window exists — raise it to the front
      try {
        await this.request(request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

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

    await this.buildInputPhase(prefill);
    this.phase = 'input';

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
    this.subtitleId = undefined;
    this.promptInputId = undefined;
    this.createRowId = undefined;
    this.createBtnId = undefined;
    this.creatingLabelId = undefined;
    this.resetRowId = undefined;
    this.resetBtnId = undefined;
    this.progressLogId = undefined;
    this.progressLabelIds = [];
    this.activeProgressLabelId = undefined;
    this.phase = 'closed';
    return true;
  }

  /** Build the input-phase widgets: prompt label, subtitle, text area, create button, progress log. */
  private async buildInputPhase(prefill?: string): Promise<void> {
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
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.promptLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Subtitle
    this.subtitleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: 'Use natural language to describe any object.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.subtitleId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // TextArea for prompt (expanding to fill available space)
    this.promptInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextArea', {
        windowId: this.windowId,
        rect: r0,
        text: prefill ?? '',
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.promptInputId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      stretch: 1,
    }));

    // HBox for Create button (spacer pushes it right)
    this.createRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.createRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Spacer pushes button right
    await this.request(request(this.id, this.createRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Create button (accent styling)
    this.createBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: r0,
        text: 'Create',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.createRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
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
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
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
  }

  /** Stop a widget on the bus. Does NOT remove from any layout or window. */
  private async stopWidget(widgetId: AbjectId): Promise<void> {
    try {
      await this.request(request(this.id, widgetId, WIDGET_INTERFACE, 'destroy', {}));
    } catch { /* widget may already be gone */ }
  }

  /** Remove a widget from the root layout and stop it. */
  private async removeAndDestroy(widgetId: AbjectId): Promise<void> {
    try {
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'removeLayoutChild', { widgetId }));
    } catch { /* layout may already be gone */ }
    await this.stopWidget(widgetId);
  }

  /** Remove all progress labels from the progressLog layout and stop them. */
  private async destroyProgressLabels(): Promise<void> {
    // Remove from progressLog layout first so renders don't hit stopped widgets
    for (const labelId of this.progressLabelIds) {
      try {
        if (this.progressLogId) {
          await this.request(request(this.id, this.progressLogId, LAYOUT_INTERFACE, 'removeLayoutChild', { widgetId: labelId }));
        }
      } catch { /* layout may already be gone */ }
    }
    // Now safe to stop them — no layout references remain
    for (const labelId of this.progressLabelIds) {
      await this.stopWidget(labelId);
    }
    this.progressLabelIds = [];
    this.activeProgressLabelId = undefined;
  }

  /** Tear down all input-phase widgets from the root layout. */
  private async destroyInputPhase(): Promise<void> {
    await this.destroyProgressLabels();

    for (const wid of [this.promptLabelId, this.subtitleId, this.promptInputId, this.createRowId, this.progressLogId]) {
      if (wid) await this.removeAndDestroy(wid);
    }
    if (this.createBtnId) await this.stopWidget(this.createBtnId);

    this.promptLabelId = undefined;
    this.subtitleId = undefined;
    this.promptInputId = undefined;
    this.createRowId = undefined;
    this.createBtnId = undefined;
    this.progressLogId = undefined;
  }

  /** Switch UI to creating phase: show prompt summary and fresh progress log. */
  private async switchToCreatingPhase(prompt: string): Promise<void> {
    this.phase = 'creating';
    await this.destroyInputPhase();

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const truncated = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;

    // "Creating: <prompt>" header
    this.creatingLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: `Creating: ${truncated}`,
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 14 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.creatingLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Progress log container
    this.progressLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 2,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.progressLogId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      stretch: 1,
    }));
  }

  /** Show the reset button ("Create Another" on success, "Try Again" on error). */
  private async showResetButton(isError: boolean): Promise<void> {
    if (!this.windowId || !this.rootLayoutId) return;

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    this.resetRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.resetRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Spacer pushes button right
    await this.request(request(this.id, this.resetRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    const label = isError ? 'Try Again' : 'Create Another';
    this.resetBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: r0,
        text: label,
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.resetRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.resetBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 140, height: 36 },
    }));

    await this.request(
      request(this.id, this.resetBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
    );
  }

  /** Destroy creating-phase widgets and rebuild the input phase. */
  private async resetToInputPhase(): Promise<void> {
    const prefill = this.phase === 'error' ? this.lastPrompt : undefined;
    await this.hide();
    await this.show(prefill);
  }

  private async handleChanged(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    if (aspect !== 'click') return;

    if (fromId === this.resetBtnId && (this.phase === 'success' || this.phase === 'error')) {
      await this.resetToInputPhase();
      return;
    }

    if (fromId === this.createBtnId && this.phase === 'input') {
      await this.handleCreate();
      return;
    }
  }

  /** Read the prompt, validate, switch to creating phase, and invoke ObjectCreator. */
  private async handleCreate(): Promise<void> {
    // Read prompt text
    const prompt = await this.request<string>(
      request(this.id, this.promptInputId!, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!prompt.trim()) {
      await this.clearProgressLog();
      await this.appendLogEntry('Please enter a description.', { color: '#b4b8c8' });
      return;
    }

    // Save prompt for potential "Try Again"
    this.lastPrompt = prompt;

    // Switch to creating phase UI
    await this.switchToCreatingPhase(prompt);

    await this.log('info', 'ObjectWorkshop: creating object', { prompt });

    // Run creation in background — do NOT await here so the processing loop
    // stays free to handle incoming progress events from ObjectCreator.
    this.runCreation(prompt);
  }

  /**
   * Run the ObjectCreator pipeline in the background.
   * Not awaited by handleCreate() so the processing loop can continue
   * delivering progress events while we wait for the LLM pipeline.
   */
  private async runCreation(prompt: string): Promise<void> {
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

      // Window may have been closed while we were waiting
      if (this.phase !== 'creating') return;

      if (result.success && result.manifest) {
        this.phase = 'success';
        await this.log('info', 'ObjectWorkshop: object created', { name: result.manifest.name, objectId: result.objectId });
        // Mark last active step as completed
        await this.markActiveCompleted();
        // Append success entries
        await this.appendLogEntry(`✓ Created: ${result.manifest.name}`, { color: '#a8cc8c' });
        await this.appendLogEntry(`  ${result.manifest.description}`, { color: '#6b7084', fontSize: 12 });
        await this.showResetButton(false);
        // Auto-show the new object if it has a show method.
        // Fire-and-forget — don't delay the "Create Another" button.
        if (result.objectId) {
          const showIface = result.manifest.interfaces.find(
            i => i.methods.some(m => m.name === 'show')
          );
          if (showIface) {
            this.request(
              request(this.id, result.objectId, showIface.id, 'show', {})
            ).catch(() => { /* object may not be ready yet */ });
          }
        }
      } else {
        this.phase = 'error';
        await this.log('error', 'ObjectWorkshop: creation failed', { error: result.error });
        await this.markActiveError();
        await this.appendLogEntry(`✗ ${result.error ?? 'Unknown error'}`, { color: '#e05561' });
        await this.showResetButton(true);
      }
    } catch (err) {
      // Window may have been closed or object stopped while we were waiting
      if (this.phase === 'closed') return;

      this.phase = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await this.log('error', 'ObjectWorkshop: creation error', { error: msg });
        await this.markActiveError();
        await this.appendLogEntry(`✗ ${msg}`, { color: '#e05561' });
        await this.showResetButton(true);
      } catch { /* object may be stopped — UI updates are best-effort */ }
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
    await this.destroyProgressLabels();
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

}

export const OBJECT_WORKSHOP_ID = 'abjects:object-workshop' as AbjectId;
