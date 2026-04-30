/**
 * AbjectEditor -- Smalltalk-style code browser for ScriptableAbjects.
 *
 * Split-pane layout: handler list on the left, syntax-highlighted code
 * editor on the right. Handlers are grouped by type (properties, message
 * handlers, private helpers). Supports add/delete handlers, live save
 * with error display, and per-handler editing.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import {
  parseHandlerMap,
  reassembleHandlerMap,
  type HandlerEntry,
  type EntryType,
} from './widgets/handler-parser.js';
import type { ListItem } from './widgets/list-widget.js';
import type { IconName } from '../ui/icons.js';

const ABJECT_EDITOR_INTERFACE: InterfaceId = 'abjects:abject-editor' as InterfaceId;

// Vector icons for entry types in the handler list. ListWidget renders
// these via ListItem.iconName so they re-tint with the active theme.
const ICON_NAMES: Record<EntryType, IconName> = {
  property: 'chevronRight',
  handler:  'dot',
  helper:   'plus',
};

export class AbjectEditor extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;

  // Window and layout
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Widget tracking
  private splitPaneId?: AbjectId;
  private handlerListId?: AbjectId;
  private sourceEditorId?: AbjectId;
  private testBtnId?: AbjectId;
  private saveBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private addBtnId?: AbjectId;
  private editStatusId?: AbjectId;
  private addInputId?: AbjectId;
  private addConfirmBtnId?: AbjectId;
  private addRowId?: AbjectId;

  // State
  private editingObjectId?: AbjectId;
  private abjectStoreId?: AbjectId;
  private entries: HandlerEntry[] = [];
  private selectedIndex = -1;
  private addMode = false;

  constructor() {
    super({
      manifest: {
        name: 'AbjectEditor',
        description:
          'Smalltalk-style code browser for ScriptableAbjects. Split-pane with handler list and syntax-highlighted editor.',
        version: '2.0.0',
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
    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;
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
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });
  }

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  private clearViewTracking(): void {
    this.rootLayoutId = undefined;
    this.splitPaneId = undefined;
    this.handlerListId = undefined;
    this.sourceEditorId = undefined;
    this.testBtnId = undefined;
    this.saveBtnId = undefined;
    this.cancelBtnId = undefined;
    this.addBtnId = undefined;
    this.editStatusId = undefined;
    this.addInputId = undefined;
    this.addConfirmBtnId = undefined;
    this.addRowId = undefined;
    this.entries = [];
    this.selectedIndex = -1;
    this.addMode = false;
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

  // ── Show Editor ──────────────────────────────────────────────────────

  private async showEditor(objectId: AbjectId): Promise<boolean> {
    if (!objectId) return false;

    // Fetch source
    let source: string;
    try {
      source = await this.request<string>(request(this.id, objectId, 'getSource', {}));
    } catch { return false; }

    // Look up name — try registry first, then ask the object directly
    let objectName = 'Unknown';
    if (this.registryId) {
      try {
        const reg = await this.request<{ name: string; manifest: { name: string } } | null>(
          request(this.id, this.registryId, 'lookup', { objectId })
        );
        if (reg) objectName = reg.name || reg.manifest.name;
      } catch { /* registry lookup failed */ }
    }
    if (objectName === 'Unknown') {
      try {
        const desc = await this.request<{ manifest?: { name?: string } }>(
          request(this.id, objectId, 'describe', {})
        );
        if (desc?.manifest?.name) objectName = desc.manifest.name;
      } catch { /* fallback to Unknown */ }
    }

    // Destroy existing window
    if (this.windowId) {
      await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId: this.windowId }));
      this.windowId = undefined;
    }
    this.clearViewTracking();
    this.editingObjectId = objectId;

    // Parse handler map into entries
    this.entries = parseHandlerMap(source);

    // Window sizing
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const editW = 750;
    const editH = 550;
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

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 8, bottom: 4, left: 8 },
        spacing: 4,
      })
    );

    // Create all widgets in a batch
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // 0: split pane
          { type: 'splitPane', windowId: this.windowId, orientation: 'horizontal', dividerPosition: 0.25, minSize: 100 },
          // 1: handler list (left)
          { type: 'list', windowId: this.windowId, items: this.buildListItems(), selectedIndex: -1, itemHeight: 24 },
          // 2: source editor (right)
          { type: 'textArea', windowId: this.windowId, text: '', monospace: true,
            style: { syntaxHighlight: true } },
          // 3: test button (apply live without persisting)
          { type: 'button', windowId: this.windowId, text: 'Test',
            style: { background: this.theme.statusWarning, color: this.theme.actionText, borderColor: this.theme.statusWarning } },
          // 4: save button (apply live + persist)
          { type: 'button', windowId: this.windowId, text: 'Save',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
          // 5: cancel button
          { type: 'button', windowId: this.windowId, text: 'Cancel' },
          // 6: add handler button
          { type: 'button', windowId: this.windowId, text: '+ Add' },
          // 7: status label
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 12, wordWrap: true, markdown: true } },
          // 8: add handler text input (hidden initially)
          { type: 'textInput', windowId: this.windowId, placeholder: 'handler name...',
            style: { visible: false } },
          // 9: add confirm button (hidden initially)
          { type: 'button', windowId: this.windowId, text: 'OK',
            style: { visible: false, background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        ],
      })
    );

    const [splitPaneId, handlerListId, sourceEditorId,
      testBtnId, saveBtnId, cancelBtnId, addBtnId, editStatusId,
      addInputId, addConfirmBtnId] = widgetIds;

    this.splitPaneId = splitPaneId;
    this.handlerListId = handlerListId;
    this.sourceEditorId = sourceEditorId;
    this.testBtnId = testBtnId;
    this.saveBtnId = saveBtnId;
    this.cancelBtnId = cancelBtnId;
    this.addBtnId = addBtnId;
    this.editStatusId = editStatusId;
    this.addInputId = addInputId;
    this.addConfirmBtnId = addConfirmBtnId;

    // Set up split pane children
    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.handlerListId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.sourceEditorId }));

    // Add splitPane to root (expanding, takes most space)
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.splitPaneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      stretch: 1,
    }));

    // Add handler name input row (hidden initially)
    this.addRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: this.addRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 0 }, // hidden
    }));
    await this.request(request(this.id, this.addRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.addInputId, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 28 } },
        { widgetId: this.addConfirmBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 50, height: 28 } },
      ],
    }));

    // Button row
    const btnRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: btnRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    await this.request(request(this.id, btnRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.testBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 60, height: 28 } },
        { widgetId: this.saveBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 60, height: 28 } },
        { widgetId: this.cancelBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 65, height: 28 } },
        { widgetId: this.addBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 55, height: 28 } },
      ],
    }));
    await this.request(request(this.id, btnRowId, 'addLayoutSpacer', {}));

    // Status label
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.editStatusId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Register dependencies
    await this.addDep(this.handlerListId);
    await this.addDep(this.testBtnId);
    await this.addDep(this.saveBtnId);
    await this.addDep(this.cancelBtnId);
    await this.addDep(this.addBtnId);
    await this.addDep(this.addConfirmBtnId);
    await this.addDep(this.addInputId);

    // Select first handler if any exist
    if (this.entries.length > 0) {
      await this.selectEntry(0);
    }

    return true;
  }

  // ── List Items ───────────────────────────────────────────────────────

  private buildListItems(): ListItem[] {
    return this.entries.map((entry, i) => ({
      label: entry.name,
      value: String(i),
      secondary: entry.type === 'property' ? 'prop' : entry.type === 'helper' ? 'fn' : 'msg',
      iconName: ICON_NAMES[entry.type],
    }));
  }

  private async refreshList(): Promise<void> {
    if (!this.handlerListId) return;
    await this.request(request(this.id, this.handlerListId, 'update', {
      items: this.buildListItems(),
      selectedIndex: this.selectedIndex,
    }));
  }

  // ── Entry Selection ──────────────────────────────────────────────────

  private async storeCurrentEditorText(): Promise<void> {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.entries.length) return;
    if (!this.sourceEditorId) return;

    const currentText = await this.request<string>(
      request(this.id, this.sourceEditorId, 'getValue', {})
    );

    const entry = this.entries[this.selectedIndex];
    if (entry.type === 'property') {
      // For properties, the body is "name: value"
      entry.body = `${entry.name}: ${currentText}`;
    } else {
      entry.body = currentText;
    }
  }

  private async selectEntry(index: number): Promise<void> {
    // Save current editor text before switching
    if (this.selectedIndex >= 0) {
      await this.storeCurrentEditorText();
    }

    this.selectedIndex = index;

    if (index < 0 || index >= this.entries.length) {
      if (this.sourceEditorId) {
        await this.request(request(this.id, this.sourceEditorId, 'update', { text: '' }));
      }
      return;
    }

    const entry = this.entries[index];
    let displayText: string;

    if (entry.type === 'property') {
      // Show just the value part (after "name: ")
      const colonIdx = entry.body.indexOf(':');
      displayText = colonIdx >= 0 ? entry.body.slice(colonIdx + 1).trim() : entry.body;
    } else {
      displayText = entry.body;
    }

    if (this.sourceEditorId) {
      await this.request(request(this.id, this.sourceEditorId, 'update', { text: displayText }));
    }
    if (this.handlerListId) {
      await this.request(request(this.id, this.handlerListId, 'update', { selectedIndex: index }));
    }
  }

  // ── Event Handling ───────────────────────────────────────────────────

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Handler list selection
    if (fromId === this.handlerListId && aspect === 'selectionChanged') {
      // ListWidget emits value as JSON string: { index, value, label }
      // The value field contains the entry index as a string
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      const entryIndex = parseInt(parsed.value, 10);
      if (!isNaN(entryIndex) && entryIndex >= 0 && entryIndex < this.entries.length) {
        await this.selectEntry(entryIndex);
      }
      return;
    }

    // Test (apply live, no persist)
    if (fromId === this.testBtnId && aspect === 'click') {
      await this.handleApply(false);
      return;
    }

    // Save (apply live + persist)
    if (fromId === this.saveBtnId && aspect === 'click') {
      await this.handleApply(true);
      return;
    }

    // Cancel
    if (fromId === this.cancelBtnId && aspect === 'click') {
      await this.hide();
      return;
    }

    // Add handler
    if (fromId === this.addBtnId && aspect === 'click') {
      await this.showAddInput();
      return;
    }

    // Confirm add
    if (fromId === this.addConfirmBtnId && aspect === 'click') {
      await this.confirmAdd();
      return;
    }

    // Add input submit (Enter key)
    if (fromId === this.addInputId && aspect === 'submit') {
      await this.confirmAdd();
      return;
    }

  }

  // ── Apply / Save ──────────────────────────────────────────────────────

  private async handleApply(persist: boolean): Promise<void> {
    if (!this.editingObjectId) return;

    // Clear any previous error highlight
    if (this.sourceEditorId) {
      await this.request(request(this.id, this.sourceEditorId, 'update', { errorLine: -1 }));
    }

    // Store current editor text
    await this.storeCurrentEditorText();

    // Reassemble full source
    const source = reassembleHandlerMap(this.entries);

    await this.setControlsDisabled(true);
    try {
      const result = await this.request<{ success: boolean; error?: string; errorLine?: number }>(
        request(this.id, this.editingObjectId, 'updateSource', { source })
      );

      if (result.success) {
        // Sync to registry
        if (this.registryId) {
          try {
            await this.request(request(this.id, this.registryId, 'updateSource', {
              objectId: this.editingObjectId, source,
            }));
          } catch { /* registry sync not critical */ }
        }

        // Persist to AbjectStore if requested
        if (persist && this.abjectStoreId) {
          try {
            // Get manifest and owner from registry
            const reg = await this.request<{ manifest: unknown; owner?: string } | null>(
              request(this.id, this.registryId!, 'lookup', { objectId: this.editingObjectId })
            );
            if (reg) {
              await this.request(request(this.id, this.abjectStoreId, 'save', {
                objectId: this.editingObjectId,
                manifest: reg.manifest,
                source,
                owner: reg.owner ?? this.id,
              }));
            }
          } catch { /* persist not critical for apply */ }
          await this.updateStatus('Saved and persisted', this.theme.statusSuccess);
          await this.notify('Source saved and persisted', 'success');
        } else {
          const msg = persist ? 'Applied (store unavailable)' : 'Applied (not persisted)';
          await this.updateStatus(msg, this.theme.statusSuccess);
          await this.notify(msg, persist ? 'warning' : 'success');
        }
      } else {
        await this.updateStatus(`**Error:** ${result.error ?? 'Unknown'}`, this.theme.statusError);
        await this.highlightErrorLine(source, result.errorLine, result.error);
        await this.notify(`Compile error: ${(result.error ?? 'Unknown').slice(0, 80)}`, 'error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateStatus(`**Error:** ${msg}`, this.theme.statusError);
      await this.notify(`Save failed: ${msg.slice(0, 80)}`, 'error');
    }
    await this.setControlsDisabled(false);
  }

  /**
   * Map an error line from the full reassembled source to a handler entry
   * and highlight the corresponding line in the editor.
   *
   * Mirrors the reassembleHandlerMap format exactly:
   *   Line 1: "({"
   *   Then for each entry: "  " + body (multi-line), joined by ",\n\n"
   *   Last line: "})"
   */
  private async highlightErrorLine(_fullSource: string, errorLine: number | undefined, errorMsg: string | undefined): Promise<void> {
    // Strategy 1: Extract a token from the error message and search for it in handler bodies.
    // Error messages often mention the problematic token, e.g. "Unexpected token ';'" or
    // "Private field '#foo' must be declared". This is more reliable than V8's line numbers
    // which can point to the enclosing function rather than the exact error location.
    const tokenMatch = errorMsg?.match(/['`]([^'`]+)['`]/) ?? errorMsg?.match(/token\s+(\S+)/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      for (let i = 0; i < this.entries.length; i++) {
        const entry = this.entries[i];
        const displayText = entry.type === 'property'
          ? (entry.body.indexOf(':') >= 0 ? entry.body.slice(entry.body.indexOf(':') + 1).trim() : entry.body)
          : entry.body;
        const displayLines = displayText.split('\n');
        for (let li = 0; li < displayLines.length; li++) {
          if (displayLines[li].includes(token)) {
            await this.selectEntry(i);
            if (this.sourceEditorId) {
              await this.request(request(this.id, this.sourceEditorId, 'update', { errorLine: li }));
            }
            return;
          }
        }
      }
    }

    // Strategy 2: Fall back to line-number mapping from the reassembled source.
    if (errorLine === undefined || errorLine < 1) return;

    let line = 2; // line 1 is "({", first entry body starts at line 2
    for (let i = 0; i < this.entries.length; i++) {
      const bodyLineCount = this.entries[i].body.split('\n').length;
      const entryStart = line;
      const entryEnd = line + bodyLineCount - 1;

      if (errorLine >= entryStart && errorLine <= entryEnd) {
        await this.selectEntry(i);
        const lineInBody = errorLine - entryStart;
        const entry = this.entries[i];
        const displayLineIdx = entry.type === 'property' ? 0 : lineInBody;
        if (this.sourceEditorId) {
          await this.request(request(this.id, this.sourceEditorId, 'update', { errorLine: displayLineIdx }));
        }
        return;
      }

      line = entryEnd + 1;
      if (i < this.entries.length - 1) line += 1;
    }
  }

  // ── Add Handler ──────────────────────────────────────────────────────

  private async showAddInput(): Promise<void> {
    if (!this.addInputId || !this.addConfirmBtnId || !this.addRowId) return;
    this.addMode = true;
    // Show the add row
    await this.request(request(this.id, this.addInputId, 'update', { style: { visible: true }, text: '' }));
    await this.request(request(this.id, this.addConfirmBtnId, 'update', { style: { visible: true } }));
    await this.request(request(this.id, this.rootLayoutId!, 'updateLayoutChild', {
      widgetId: this.addRowId,
      preferredSize: { height: 32 },
    }));
  }

  private async hideAddInput(): Promise<void> {
    if (!this.addInputId || !this.addConfirmBtnId || !this.addRowId) return;
    this.addMode = false;
    await this.request(request(this.id, this.addInputId, 'update', { style: { visible: false } }));
    await this.request(request(this.id, this.addConfirmBtnId, 'update', { style: { visible: false } }));
    await this.request(request(this.id, this.rootLayoutId!, 'updateLayoutChild', {
      widgetId: this.addRowId,
      preferredSize: { height: 0 },
    }));
  }

  private async confirmAdd(): Promise<void> {
    if (!this.addInputId) return;
    const name = (await this.request<string>(
      request(this.id, this.addInputId, 'getValue', {})
    )).trim();

    if (!name) {
      await this.hideAddInput();
      return;
    }

    // Determine type from name
    const isPrivate = name.startsWith('_');
    const type: EntryType = isPrivate ? 'helper' : 'handler';
    const body = `async ${name}(msg) {\n  \n}`;

    // Store current editor before adding
    await this.storeCurrentEditorText();

    this.entries.push({ name, type, body });
    await this.refreshList();
    await this.hideAddInput();

    // Select the new entry
    await this.selectEntry(this.entries.length - 1);
    await this.updateStatus(`Added ${name}`, this.theme.statusNeutral);
  }

  // ── Delete Handler ───────────────────────────────────────────────────

  // ── Helpers ──────────────────────────────────────────────────────────

  private async updateStatus(text: string, color: string): Promise<void> {
    if (!this.editStatusId) return;
    await this.request(request(this.id, this.editStatusId, 'update', {
      text,
      style: { color, fontSize: 12, wordWrap: true, markdown: true },
    }));
  }

  private async setControlsDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    const ids = [this.testBtnId, this.saveBtnId, this.cancelBtnId, this.addBtnId, this.sourceEditorId];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AbjectEditor Usage Guide

### Open the editor for a ScriptableAbject

  await call(await dep('AbjectEditor'), 'show', { objectId: 'the-object-id' });
  // Opens a Smalltalk-style code browser with handler list and syntax-highlighted editor

### Hide the editor

  await call(await dep('AbjectEditor'), 'hide', {});

### IMPORTANT
- The interface ID is 'abjects:abject-editor'.
- The editor only works with ScriptableAbject instances (objects that have source code).
- Changes are applied live — the object is recompiled and re-initialized when saved.
- Handlers are shown individually in a list — click to view/edit each one.
- Syntax highlighting is enabled for JavaScript code.`;
  }
}

export const ABJECT_EDITOR_ID = 'abjects:abject-editor' as AbjectId;
