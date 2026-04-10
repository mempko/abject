/**
 * ModalDialog — ephemeral Abject that builds and manages a modal confirmation dialog.
 *
 * Spawned on demand by WidgetManager. Builds its own UI via WidgetManager requests
 * (no deadlock since it's a separate Abject on the bus), listens for button clicks,
 * and returns the result. Windows are destroyed BEFORE the deferred reply is sent
 * so the backdrop is gone before the caller starts processing the result.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request } from '../core/message.js';
import type { ThemeData } from '../core/theme-data.js';
import { MIDNIGHT_BLOOM } from '../core/theme-data.js';

const MODAL_DIALOG_INTERFACE: InterfaceId = 'abjects:modal-dialog' as InterfaceId;

export class ModalDialog extends Abject {
  private widgetManagerId?: AbjectId;
  private backdropWindowId?: AbjectId;
  private dialogWindowId?: AbjectId;
  private confirmBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private pendingResolve?: (confirmed: boolean) => void;
  private dialogTheme: ThemeData = MIDNIGHT_BLOOM;

  constructor() {
    super({
      manifest: {
        name: 'ModalDialog',
        description: 'Ephemeral modal confirmation dialog with backdrop overlay.',
        version: '1.0.0',
        interface: {
          id: MODAL_DIALOG_INTERFACE,
          name: 'ModalDialog',
          description: 'Show a modal confirmation dialog and return the result.',
          methods: [
            {
              name: 'show',
              description: 'Show the dialog and return true (confirmed) or false (cancelled).',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Dialog title' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Dialog message' },
                { name: 'confirmLabel', type: { kind: 'primitive', primitive: 'string' }, description: 'Confirm button label', optional: true },
                { name: 'cancelLabel', type: { kind: 'primitive', primitive: 'string' }, description: 'Cancel button label', optional: true },
                { name: 'destructive', type: { kind: 'primitive', primitive: 'boolean' }, description: 'If true, confirm button uses destructive styling', optional: true },
                { name: 'theme', type: { kind: 'reference', reference: 'ThemeData' }, description: 'Theme data for styling', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'ephemeral'],
      },
    });
    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ModalDialog Usage Guide

ModalDialog is an ephemeral confirmation dialog with a backdrop overlay.
It is spawned on demand, shows a modal prompt, and returns the user's choice.

### Show a confirmation dialog

  const confirmed = await call(await dep('ModalDialog'), 'show', {
    title: 'Delete item?',
    message: 'This action cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Keep',
    destructive: true
  });
  / confirmed: true if user clicked confirm, false if cancelled

### Parameters
- title (string) — dialog title
- message (string) — dialog body text
- confirmLabel (string, optional) — confirm button text (default: "Confirm")
- cancelLabel (string, optional) — cancel button text (default: "Cancel")
- destructive (boolean, optional) — if true, confirm button uses destructive styling
- theme (ThemeData, optional) — custom theme for styling

### Notes
- Clicking the backdrop dismisses the dialog (returns false).
- The dialog window is destroyed before the reply is delivered.

Interface: abjects:modal-dialog`;
  }

  setWidgetManagerId(id: AbjectId): void {
    this.widgetManagerId = id;
  }

  private setupHandlers(): void {
    this.on('show', (msg: AbjectMessage) => {
      this.handleShow(msg).then(
        async (confirmed) => {
          await this.destroyWindows();
          this.sendDeferredReply(msg, confirmed);
          this.stop().catch(() => {});
        },
        async () => {
          await this.destroyWindows();
          this.sendDeferredReply(msg, false);
          this.stop().catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.confirmBtnId && aspect === 'click') {
        this.pendingResolve?.(true);
        return;
      }
      if (fromId === this.cancelBtnId && aspect === 'click') {
        this.pendingResolve?.(false);
        return;
      }
      if (fromId === this.dialogWindowId && aspect === 'windowCloseRequested') {
        this.pendingResolve?.(false);
        return;
      }
    });

    this.on('windowCloseRequested', async () => {
      this.pendingResolve?.(false);
    });

    // Backdrop click dismisses the dialog (like cancel)
    this.on('input', async (msg: AbjectMessage) => {
      const input = msg.payload as { type?: string };
      if (input.type === 'mousedown') {
        this.pendingResolve?.(false);
      }
    });
  }

  /**
   * Destroy dialog and backdrop windows. Awaited so the backdrop is visually
   * removed from the compositor BEFORE the deferred reply delivers the result.
   */
  private async destroyWindows(): Promise<void> {
    const wmId = this.widgetManagerId;
    if (!wmId) return;
    if (this.dialogWindowId) {
      try { this.send(request(this.id, wmId, 'destroyWindowAbject',
        { windowId: this.dialogWindowId })); } catch { /* gone */ }
    }
    if (this.backdropWindowId) {
      try { this.send(request(this.id, wmId, 'destroyWindowAbject',
        { windowId: this.backdropWindowId })); } catch { /* gone */ }
    }
  }

  private async handleShow(msg: AbjectMessage): Promise<boolean> {
    const {
      title,
      message: dialogMessage,
      confirmLabel,
      cancelLabel,
      destructive,
      theme,
    } = msg.payload as {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      destructive?: boolean;
      theme?: ThemeData;
    };

    if (theme) this.dialogTheme = theme;
    const wmId = this.widgetManagerId!;

    // Get display dimensions for centering
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, wmId, 'getDisplayInfo', {})
    );

    // 1. Create full-screen chromeless transparent backdrop at z=5000
    this.backdropWindowId = await this.request<AbjectId>(
      request(this.id, wmId, 'createWindowAbject', {
        title: '',
        rect: { x: 0, y: 0, width: displayInfo.width, height: displayInfo.height },
        chromeless: true,
        transparent: true,
        zIndex: 5000,
      })
    );

    // Draw semi-transparent overlay via a canvas widget
    const canvasId = await this.request<AbjectId>(
      request(this.id, wmId, 'createCanvas', {
        windowId: this.backdropWindowId,
        inputTargetId: this.id,
      })
    );
    await this.request(request(this.id, canvasId, 'draw', {
      commands: [
        { type: 'rect', surfaceId: 'c', params: { x: 0, y: 0, width: displayInfo.width, height: displayInfo.height, fill: 'rgba(0,0,0,0.5)' } },
      ],
    }));

    // 2. Create dialog window at z=5001, centered
    const dialogW = 400;
    const dialogH = 220;
    const dialogX = Math.max(0, Math.floor((displayInfo.width - dialogW) / 2));
    const dialogY = Math.max(0, Math.floor((displayInfo.height - dialogH) / 2));

    this.dialogWindowId = await this.request<AbjectId>(
      request(this.id, wmId, 'createWindowAbject', {
        title,
        rect: { x: dialogX, y: dialogY, width: dialogW, height: dialogH },
        zIndex: 5001,
      })
    );

    // 3. Build dialog content via WidgetManager
    const rootLayoutId = await this.request<AbjectId>(
      request(this.id, wmId, 'createVBox', {
        windowId: this.dialogWindowId,
        margins: { top: 16, right: 20, bottom: 16, left: 20 },
        spacing: 12,
      })
    );

    // Message label + confirm/cancel buttons via batch create
    const th = this.dialogTheme;
    const confirmStyle = destructive
      ? { background: th.destructiveBg, color: th.destructiveText, borderColor: th.destructiveBorder }
      : { background: th.actionBg, color: th.actionText, borderColor: th.actionBorder };

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wmId, 'create', {
        specs: [
          { type: 'label', windowId: this.dialogWindowId, text: dialogMessage, style: { color: th.textPrimary, fontSize: 13, wordWrap: true } },
          { type: 'button', windowId: this.dialogWindowId, text: cancelLabel ?? 'Cancel' },
          { type: 'button', windowId: this.dialogWindowId, text: confirmLabel ?? 'Confirm', style: confirmStyle },
        ],
      })
    );

    const [messageLabelId, cancelBtnId, confirmBtnId] = widgetIds;
    this.cancelBtnId = cancelBtnId;
    this.confirmBtnId = confirmBtnId;

    // Add message label to layout
    await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
      widgetId: messageLabelId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Spacer
    await this.request(request(this.id, rootLayoutId, 'addLayoutSpacer', {}));

    // Button row
    const buttonRowId = await this.request<AbjectId>(
      request(this.id, wmId, 'createNestedHBox', {
        parentLayoutId: rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
      widgetId: buttonRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Push buttons to the right
    await this.request(request(this.id, buttonRowId, 'addLayoutSpacer', {}));

    // Subscribe as dependent on buttons and dialog window
    await this.request(request(this.id, cancelBtnId, 'addDependent', {}));
    await this.request(request(this.id, confirmBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.dialogWindowId, 'addDependent', {}));

    // Add buttons to row
    await this.request(request(this.id, buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: cancelBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: 36 } },
        { widgetId: confirmBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: 36 } },
      ],
    }));

    // Wait for user response
    return new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
    });
  }
}
