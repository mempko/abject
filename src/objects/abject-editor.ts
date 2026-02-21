/**
 * AbjectEditor — standalone source editor for ScriptableAbjects.
 *
 * Provides a window with a source code textarea, Save/Cancel buttons,
 * AI edit prompt, and status label. Can be opened by any abject to edit
 * the source of a given ScriptableAbject.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import { EDITABLE_INTERFACE_ID } from './scriptable-abject.js';
import { CreationResult } from './object-creator.js';

const ABJECT_EDITOR_INTERFACE: InterfaceId = 'abjects:abject-editor' as InterfaceId;
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

export class AbjectEditor extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private objectCreatorId?: AbjectId;

  // Window and layout
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Widget tracking
  private sourceEditorId?: AbjectId;
  private saveBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private aiEditBtnId?: AbjectId;
  private aiPromptInputId?: AbjectId;
  private aiGoBtnId?: AbjectId;
  private editStatusId?: AbjectId;

  // State
  private editingObjectId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'AbjectEditor',
        description:
          'Standalone source editor for ScriptableAbjects. Opens a window with source editing, save/cancel, and AI edit support.',
        version: '1.0.0',
        interfaces: [
          {
            id: ABJECT_EDITOR_INTERFACE,
            name: 'AbjectEditor',
            description: 'Source editor for editable abjects',
            methods: [
              {
                name: 'show',
                description: 'Open editor for a given ScriptableAbject',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of the ScriptableAbject to edit',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Close the editor window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display editor window', required: true },
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
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.showEditor(objectId as AbjectId);
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click' && aspect !== 'submit') return;
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });
  }

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
  }

  private clearViewTracking(): void {
    this.rootLayoutId = undefined;
    this.sourceEditorId = undefined;
    this.saveBtnId = undefined;
    this.cancelBtnId = undefined;
    this.aiEditBtnId = undefined;
    this.aiPromptInputId = undefined;
    this.aiGoBtnId = undefined;
    this.editStatusId = undefined;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.editingObjectId = undefined;
    this.clearViewTracking();
    return true;
  }

  private async showEditor(objectId: AbjectId): Promise<boolean> {
    // Fetch source from the target object
    let source: string;
    try {
      source = await this.request<string>(
        request(this.id, objectId, EDITABLE_INTERFACE_ID, 'getSource', {})
      );
    } catch {
      return false;
    }

    // Look up name from registry
    let objectName = 'Unknown';
    if (this.registryId) {
      try {
        const reg = await this.request<{ manifest: { name: string } } | null>(
          request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'lookup', { objectId })
        );
        if (reg) objectName = reg.manifest.name;
      } catch { /* use default name */ }
    }

    // Destroy existing window if open
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    this.clearViewTracking();
    this.editingObjectId = objectId;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const editW = 600;
    const editH = 500;
    const winX = Math.max(20, Math.floor((displayInfo.width - editW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - editH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: `Edit: ${objectName}`,
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
        windowId: this.windowId, rect: r0, text: `Source: ${objectName}`,
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
        windowId: this.windowId, rect: r0, text: source, monospace: true,
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
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
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
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
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

    return true;
  }

  private async updateEditStatus(text: string): Promise<void> {
    if (!this.editStatusId) return;
    await this.request(
      request(this.id, this.editStatusId, WIDGET_INTERFACE, 'update', { text })
    );
  }

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    // ── Save button ──
    if (fromId === this.saveBtnId && this.editingObjectId) {
      const source = await this.request<string>(
        request(this.id, this.sourceEditorId!, WIDGET_INTERFACE, 'getValue', {})
      );

      try {
        const result = await this.request<{ success: boolean; error?: string }>(
          request(this.id, this.editingObjectId, EDITABLE_INTERFACE_ID, 'updateSource', {
            source,
          })
        );

        if (result.success) {
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

    // ── Cancel button ──
    if (fromId === this.cancelBtnId) {
      await this.hide();
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
  }
}

export const ABJECT_EDITOR_ID = 'abjects:abject-editor' as AbjectId;
