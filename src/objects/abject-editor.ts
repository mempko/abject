/**
 * AbjectEditor — standalone source editor for ScriptableAbjects.
 *
 * Provides a window with a source code textarea, Save/Cancel buttons,
 * and status label. Can be opened by any abject to edit the source of
 * a given ScriptableAbject.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';

const ABJECT_EDITOR_INTERFACE: InterfaceId = 'abjects:abject-editor' as InterfaceId;

export class AbjectEditor extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;


  // Window and layout
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Widget tracking
  private sourceEditorId?: AbjectId;
  private saveBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private editStatusId?: AbjectId;

  // State
  private editingObjectId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'AbjectEditor',
        description:
          'Standalone source editor for ScriptableAbjects. Opens a window with source editing and save/cancel.',
        version: '1.0.0',
        interface: {
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
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');

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
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  private clearViewTracking(): void {
    this.rootLayoutId = undefined;
    this.sourceEditorId = undefined;
    this.saveBtnId = undefined;
    this.cancelBtnId = undefined;
    this.editStatusId = undefined;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
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
        request(this.id, objectId, 'getSource', {})
      );
    } catch {
      return false;
    }

    // Look up name from registry
    let objectName = 'Unknown';
    if (this.registryId) {
      try {
        const reg = await this.request<{ manifest: { name: string } } | null>(
          request(this.id, this.registryId, 'lookup', { objectId })
        );
        if (reg) objectName = reg.manifest.name;
      } catch { /* use default name */ }
    }

    // Destroy existing window if open
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    this.clearViewTracking();
    this.editingObjectId = objectId;

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const editW = 600;
    const editH = 500;
    const winX = Math.max(20, Math.floor((displayInfo.width - editW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - editH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: `Edit: ${objectName}`,
        rect: { x: winX, y: winY, width: editW, height: editH },
        zIndex: 200,
        resizable: true,
      })
    );

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 8,
      })
    );

    // Batch create all widgets
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: `Source: ${objectName}` },
          { type: 'textArea', windowId: this.windowId, text: source, monospace: true },
          { type: 'button', windowId: this.windowId, text: 'Save',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
          { type: 'button', windowId: this.windowId, text: 'Cancel' },
          { type: 'label', windowId: this.windowId, text: '' },
        ],
      })
    );
    const [nameLabelId, sourceEditorId, saveBtnId, cancelBtnId, editStatusId] = widgetIds;
    this.sourceEditorId = sourceEditorId;
    this.saveBtnId = saveBtnId;
    this.cancelBtnId = cancelBtnId;
    this.editStatusId = editStatusId;

    // Add nameLabel and sourceEditor to root layout first
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: nameLabelId, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 20 } },
        { widgetId: this.sourceEditorId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' }, stretch: 1 },
      ],
    }));

    // Create button row AFTER the above children so it auto-appends in the correct position
    const btnRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    // Update btnRowId's layout properties (auto-added with expanding defaults)
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: btnRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Add editStatus after btnRow
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.editStatusId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Add buttons to button row
    await this.request(request(this.id, btnRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.saveBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 32 } },
        { widgetId: this.cancelBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 32 } },
      ],
    }));
    await this.request(request(this.id, btnRowId, 'addLayoutSpacer', {}));

    // Register as dependent for interactive widgets
    await this.addDep(this.saveBtnId);
    await this.addDep(this.cancelBtnId);

    return true;
  }

  private async updateEditStatus(text: string): Promise<void> {
    if (!this.editStatusId) return;
    await this.request(
      request(this.id, this.editStatusId, 'update', { text })
    );
  }

  private async setAllControlsDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    const ids = [this.saveBtnId, this.cancelBtnId, this.sourceEditorId];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    // ── Save button ──
    if (fromId === this.saveBtnId && this.editingObjectId) {
      await this.setAllControlsDisabled(true);
      const source = await this.request<string>(
        request(this.id, this.sourceEditorId!, 'getValue', {})
      );

      try {
        const result = await this.request<{ success: boolean; error?: string }>(
          request(this.id, this.editingObjectId, 'updateSource', {
            source,
          })
        );

        if (result.success) {
          if (this.registryId) {
            await this.request(
              request(this.id, this.registryId, 'updateSource', {
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
      await this.setAllControlsDisabled(false);
      return;
    }

    // ── Cancel button ──
    if (fromId === this.cancelBtnId) {
      await this.hide();
      return;
    }

  }

  protected override getSourceForAsk(): string | undefined {
    return `## AbjectEditor Usage Guide

### Open the editor for a ScriptableAbject

  await call(await dep('AbjectEditor'), 'show', { objectId: 'the-object-id' });
  // Opens a window with the object's source code for editing

### Hide the editor

  await call(await dep('AbjectEditor'), 'hide', {});

### IMPORTANT
- The interface ID is 'abjects:abject-editor'.
- The editor only works with ScriptableAbject instances (objects that have source code).
- Changes are applied live — the object is recompiled and re-initialized when saved.`;
  }
}

export const ABJECT_EDITOR_ID = 'abjects:abject-editor' as AbjectId;
