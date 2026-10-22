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
import { request, event } from '../core/message.js';
import type { ThemeData } from '../core/theme-data.js';
import { DEFAULT_THEME, shapeOf } from '../core/theme-data.js';
import { hatch, withAlpha, TITLE_BAR_HEIGHT } from './widgets/widget-types.js';

/**
 * Full-screen backdrop behind a modal: an ink wash with faint diagonal
 * hatching.
 */
function scrimCommands(theme: ThemeData, width: number, height: number): unknown[] {
  const rect = { x: 0, y: 0, width, height };
  return [
    { type: 'rect', surfaceId: 'c', params: { ...rect, fill: withAlpha(theme.canvasBg, 0.14) } },
    ...hatch('c', rect, withAlpha(theme.textPrimary, 0.05), 14, 2),
  ];
}

const MODAL_DIALOG_INTERFACE: InterfaceId = 'abjects:modal-dialog' as InterfaceId;

/**
 * How long the dialog holds after a confirm so its flash reads before the
 * slab folds away (the close transition carries no effects of its own).
 */
const CONFIRM_FLASH_HOLD_MS = 140;

export class ModalDialog extends Abject {
  private widgetManagerId?: AbjectId;
  private backdropWindowId?: AbjectId;
  private dialogWindowId?: AbjectId;
  private confirmBtnId?: AbjectId;
  private cancelBtnId?: AbjectId;
  private inputWidgetId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private messageAreaId?: AbjectId;
  private messageBlockId?: AbjectId;
  /** The dialog window's rect, kept to refit it as the message measures itself. */
  private dialogRect?: { x: number; y: number; width: number; height: number };
  private displaySize = { width: 0, height: 0 };
  /** The message's height: a guess until it measures itself. */
  private messageHeight = 0;
  /** A card shown with the question, and its measured height. */
  private cardSlotId?: AbjectId;
  private cardHeight = 0;
  /** Fits run one at a time, each with the latest message height. */
  private fitting: Promise<void> = Promise.resolve();
  private promptMode = false;
  private pendingResolve?: (result: boolean | string | null) => void;
  private dialogTheme: ThemeData = DEFAULT_THEME;

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
            {
              name: 'showPrompt',
              description: 'Show a dialog with a text input and return the entered string, or null if cancelled.',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Dialog title' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Dialog message' },
                { name: 'defaultValue', type: { kind: 'primitive', primitive: 'string' }, description: 'Initial input value', optional: true },
                { name: 'placeholder', type: { kind: 'primitive', primitive: 'string' }, description: 'Input placeholder', optional: true },
                { name: 'confirmLabel', type: { kind: 'primitive', primitive: 'string' }, description: 'Confirm button label', optional: true },
                { name: 'cancelLabel', type: { kind: 'primitive', primitive: 'string' }, description: 'Cancel button label', optional: true },
                { name: 'theme', type: { kind: 'reference', reference: 'ThemeData' }, description: 'Theme data for styling', optional: true },
              ],
              returns: { kind: 'union', variants: [{ kind: 'primitive', primitive: 'string' }, { kind: 'primitive', primitive: 'null' }] },
            },
            {
              name: 'respond',
              description: 'Resolve the dialog on behalf of the user (e.g. from a remote surface like a terminal). Confirmed prompts use the given value.',
              parameters: [
                { name: 'confirmed', type: { kind: 'primitive', primitive: 'boolean' }, description: 'True to confirm, false to cancel' },
                { name: 'value', type: { kind: 'primitive', primitive: 'string' }, description: 'Entered text for prompt dialogs', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
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
      // The caller waits as long as the person does: beat while the dialog is up.
      const stopBeating = this.awaitingHuman('confirm dialog');
      this.handleShow(msg).finally(stopBeating).then(
        async (confirmed) => {
          if (confirmed === true) await this.confirmFlash();
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

    this.on('showPrompt', (msg: AbjectMessage) => {
      this.promptMode = true;
      const stopBeating = this.awaitingHuman('prompt dialog');
      this.handleShow(msg).finally(stopBeating).then(
        async (result) => {
          if (typeof result === 'string') await this.confirmFlash();
          await this.destroyWindows();
          this.sendDeferredReply(msg, result);
          this.stop().catch(() => {});
        },
        async () => {
          await this.destroyWindows();
          this.sendDeferredReply(msg, null);
          this.stop().catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // The card drew itself: give it its height and refit the window.
      if (fromId === this.cardSlotId && aspect === 'contentHeight') {
        const height = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(height) && height > 0 && Math.abs(height - this.cardHeight) >= 1 && this.rootLayoutId) {
          this.cardHeight = Math.ceil(height);
          try {
            await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
              widgetId: this.cardSlotId, preferredSize: { height: this.cardHeight },
            }));
          } catch { /* dialog closed meanwhile */ }
          await this.fitWindow();
        }
        return;
      }

      // The message wrapped and measured itself: fit the window to it.
      if (fromId === this.messageBlockId && aspect === 'contentHeight') {
        const height = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(height) && height > 0) {
          this.messageHeight = Math.ceil(height);
          await this.fitWindow();
        }
        return;
      }

      // Confirm: in prompt mode resolve with the input's current value.
      if ((fromId === this.confirmBtnId && aspect === 'click') ||
          (fromId === this.inputWidgetId && aspect === 'submit')) {
        await this.resolveConfirm();
        return;
      }
      if (fromId === this.cancelBtnId && aspect === 'click') {
        this.pendingResolve?.(this.cancelResult());
        return;
      }
      if (fromId === this.dialogWindowId && aspect === 'windowCloseRequested') {
        this.pendingResolve?.(this.cancelResult());
        return;
      }
    });

    this.on('windowCloseRequested', async () => {
      this.pendingResolve?.(this.cancelResult());
    });

    // Closing on WidgetManager's word: the question was answered elsewhere
    // (DialogBroker took a terminal's answer), so the window goes away.
    // Anything else sending respond is refused: only the object that drew
    // this dialog may close it.
    this.on('respond', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.widgetManagerId) return false;
      const { confirmed, value } = msg.payload as { confirmed: boolean; value?: string };
      if (!this.pendingResolve) return false;
      if (!confirmed) {
        this.pendingResolve(this.cancelResult());
        return true;
      }
      if (this.promptMode && typeof value === 'string') {
        this.pendingResolve(value);
        return true;
      }
      await this.resolveConfirm();
      return true;
    });

    // Backdrop click dismisses the dialog (like cancel)
    this.on('input', async (msg: AbjectMessage) => {
      const input = msg.payload as { type?: string };
      if (input.type === 'mousedown') {
        this.pendingResolve?.(this.cancelResult());
      }
    });
  }

  /** Cancel resolves to null in prompt mode, false for confirm dialogs. */
  private cancelResult(): boolean | null {
    return this.promptMode ? null : false;
  }

  /** Confirm resolves to the input string in prompt mode, true otherwise. */
  private async resolveConfirm(): Promise<void> {
    if (this.promptMode && this.inputWidgetId) {
      let value = '';
      try {
        value = await this.request<string>(request(this.id, this.inputWidgetId, 'getValue', {}));
      } catch { /* input gone */ }
      this.pendingResolve?.(value ?? '');
    } else {
      this.pendingResolve?.(true);
    }
  }

  /**
   * Mark (or unmark) the dialog and its backdrop modal: every other window
   * recedes and dims while the dialog shows. The backdrop is modal too so the
   * full-screen scrim stays flush with the display instead of receding.
   */
  private async setModal(modal: boolean): Promise<void> {
    const ids = [this.backdropWindowId, this.dialogWindowId].filter((id): id is AbjectId => !!id);
    await Promise.all(ids.map(async (windowId) => {
      try {
        await this.setWindowModal(windowId, modal);
      } catch { /* window gone; closing it clears the flag anyway */ }
    }));
  }

  /**
   * A confirm lands: flash the dialog in the hand's colour, then hold briefly
   * so the flash reads before the dialog folds away.
   */
  private async confirmFlash(): Promise<void> {
    if (!this.dialogWindowId) return;
    try {
      this.playWindowEffect(this.dialogWindowId, 'flash', '$accent');
    } catch { return; /* window gone */ }
    await new Promise<void>((resolve) => { this.setTimer(() => resolve(), CONFIRM_FLASH_HOLD_MS); });
  }

  /**
   * Destroy dialog and backdrop windows. Awaited so the backdrop is visually
   * removed from the compositor BEFORE the deferred reply delivers the result.
   * Every close path (confirm, cancel, escape, backdrop click, remote answer)
   * comes through here, so the modal depth always lifts with the dialog.
   */
  private async destroyWindows(): Promise<void> {
    const wmId = this.widgetManagerId;
    if (!wmId) return;
    await this.setModal(false);
    if (this.dialogWindowId) {
      try { this.send(request(this.id, wmId, 'destroyWindowAbject',
        { windowId: this.dialogWindowId })); } catch { /* gone */ }
    }
    if (this.backdropWindowId) {
      try { this.send(request(this.id, wmId, 'destroyWindowAbject',
        { windowId: this.backdropWindowId })); } catch { /* gone */ }
    }
  }

  private async handleShow(msg: AbjectMessage): Promise<boolean | string | null> {
    const {
      title,
      message: dialogMessage,
      confirmLabel,
      cancelLabel,
      destructive,
      theme,
      defaultValue,
      placeholder,
      card,
    } = msg.payload as {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      destructive?: boolean;
      theme?: ThemeData;
      defaultValue?: string;
      placeholder?: string;
      card?: { typeId: string; storeId: string; text: string };
    };

    // Without an explicit theme, wear the workspace's active theme so the
    // dialog matches the windows around it.
    if (theme) this.dialogTheme = theme;
    else this.dialogTheme = await this.fetchTheme();
    const wmId = this.widgetManagerId!;

    // Get display dimensions for centering
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, wmId, 'getDisplayInfo', {})
    );
    this.displaySize = { width: displayInfo.width, height: displayInfo.height };

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
      commands: scrimCommands(this.dialogTheme, displayInfo.width, displayInfo.height),
    }));

    // 2. Create dialog window at z=5001, centered. A long message (a sign-in
    // address, say) gets a wider window. The height starts from a guess at
    // the wrapped message and is fitted once the message measures itself.
    const dialogW = dialogWidth(dialogMessage, displayInfo.width);
    const messageGuess = estimateMessageHeight(dialogMessage, dialogW);
    this.messageHeight = messageGuess;
    this.dialogRect = this.centered(dialogW,
      TITLE_BAR_HEIGHT + DIALOG_CHROME_GUESS + (this.promptMode ? INPUT_HEIGHT + SPACING : 0) + messageGuess);

    this.dialogWindowId = await this.request<AbjectId>(
      request(this.id, wmId, 'createWindowAbject', {
        title,
        rect: this.dialogRect,
        zIndex: 5001,
      })
    );
    // Modal (dialog and scrim) for the dialog's whole lifetime; the desktop
    // recedes behind the scrim. destroyWindows lifts it on every close path.
    await this.setModal(true);

    // 3. Build dialog content via WidgetManager
    const rootLayoutId = await this.request<AbjectId>(
      request(this.id, wmId, 'createVBox', {
        windowId: this.dialogWindowId,
        margins: { top: 16, right: 20, bottom: 16, left: 20 },
        spacing: SPACING,
      })
    );
    this.rootLayoutId = rootLayoutId;

    // The message sits in a scroll area that takes the room above the
    // buttons. The window grows to show all of it; the area scrolls only when
    // the message is taller than the display allows.
    const messageAreaId = await this.request<AbjectId>(
      request(this.id, wmId, 'createNestedScrollableVBox', {
        parentLayoutId: rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 0,
      })
    );
    this.messageAreaId = messageAreaId;
    await this.request(request(this.id, rootLayoutId, 'updateLayoutChild', {
      widgetId: messageAreaId,
      preferredSize: { height: messageGuess },
    }));

    // Message + confirm/cancel buttons via batch create. The message wraps,
    // can be selected and copied, and reports its own height.
    const th = this.dialogTheme;
    const confirmStyle = destructive
      ? { background: th.destructiveBg, color: th.destructiveText, borderColor: th.destructiveBorder, fontWeight: 'bold' }
      : { background: th.actionBg, color: th.actionText, borderColor: th.actionBorder, fontWeight: 'bold' };

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wmId, 'create', {
        specs: [
          { type: 'contentBlock', windowId: this.dialogWindowId, text: dialogMessage, style: { color: th.textPrimary, fontSize: 14, markdown: false } },
          { type: 'button', windowId: this.dialogWindowId, text: cancelLabel ?? 'Cancel', style: { color: th.textPrimary } },
          { type: 'button', windowId: this.dialogWindowId, text: confirmLabel ?? 'Confirm', style: confirmStyle },
        ],
      })
    );

    const [messageBlockId, cancelBtnId, confirmBtnId] = widgetIds;
    this.messageBlockId = messageBlockId;
    this.cancelBtnId = cancelBtnId;
    this.confirmBtnId = confirmBtnId;

    // Subscribed before it is laid out, so its first measurement is heard.
    await this.request(request(this.id, messageBlockId, 'addDependent', {}));
    await this.request(request(this.id, messageAreaId, 'addLayoutChild', {
      widgetId: messageBlockId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: messageGuess },
    }));

    // A card shown with the question: its own object, in a slot. Only the
    // dialog's buttons below answer the question; the card's taps do not.
    if (card) {
      const { widgetIds: [slotId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, wmId, 'create', {
          specs: [{ type: 'slot', windowId: this.dialogWindowId, target: card.typeId, storeId: card.storeId, height: CARD_START_HEIGHT }],
        })
      );
      this.cardSlotId = slotId;
      this.cardHeight = CARD_START_HEIGHT;
      await this.request(request(this.id, slotId, 'addDependent', {}));
      await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
        widgetId: slotId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: CARD_START_HEIGHT },
      }));
    }

    // Prompt mode: insert a text input below the message.
    if (this.promptMode) {
      const { widgetIds: [inputId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, wmId, 'create', {
          specs: [{
            type: 'textInput', windowId: this.dialogWindowId,
            text: defaultValue ?? '', placeholder: placeholder ?? '',
          }],
        })
      );
      this.inputWidgetId = inputId;
      await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
        widgetId: inputId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: INPUT_HEIGHT },
      }));
      await this.request(request(this.id, inputId, 'addDependent', {}));
      try {
        await this.request(request(this.id, this.dialogWindowId, 'focusChild', {
          widgetId: inputId, parentChildId: rootLayoutId,
        }));
      } catch { /* best effort focus */ }
    }

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
      preferredSize: { height: BUTTON_ROW_HEIGHT },
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
        { widgetId: confirmBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: 36 } },
      ],
    }));

    // Every control is in place: fit the window to the message, measured or
    // still guessed (its measurement refits it when it arrives).
    await this.fitWindow();

    // Wait for user response
    return new Promise<boolean | string | null>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /**
   * Fit the window to its content. The layout says how tall the controls and
   * the message measure together (spacing and margins included); the window
   * takes that height, at least the standard size and at most what the
   * display holds. A message taller than that scrolls in its area.
   */
  private fitWindow(): Promise<void> {
    this.fitting = this.fitting.then(() => this.fitWindowNow());
    return this.fitting;
  }

  private async fitWindowNow(): Promise<void> {
    const { rootLayoutId, messageAreaId, messageBlockId, dialogWindowId, dialogRect } = this;
    if (!rootLayoutId || !messageAreaId || !messageBlockId || !dialogWindowId || !dialogRect) return;
    const height = this.messageHeight;
    try {
      await this.request(request(this.id, messageAreaId, 'updateLayoutChild', {
        widgetId: messageBlockId, preferredSize: { height },
      }));
      await this.request(request(this.id, rootLayoutId, 'updateLayoutChild', {
        widgetId: messageAreaId, preferredSize: { height },
      }));
      const content = await this.request<number>(request(this.id, rootLayoutId, 'getPreferredHeight', {}));
      if (typeof content !== 'number' || content <= 0) return;
      const most = Math.max(MIN_DIALOG_HEIGHT, this.displaySize.height - DISPLAY_INSET);
      const windowHeight = Math.min(most, Math.max(MIN_DIALOG_HEIGHT, TITLE_BAR_HEIGHT + Math.ceil(content)));
      if (windowHeight === dialogRect.height) return;
      this.dialogRect = this.centered(dialogRect.width, windowHeight);
      await this.request(request(this.id, dialogWindowId, 'windowRect', this.dialogRect));
    } catch { /* dialog closed meanwhile */ }
  }

  /** A rect of this size centred on the display, kept within it. */
  private centered(width: number, height: number): { x: number; y: number; width: number; height: number } {
    const h = Math.min(height, Math.max(MIN_DIALOG_HEIGHT, this.displaySize.height - DISPLAY_INSET));
    return {
      x: Math.max(0, Math.floor((this.displaySize.width - width) / 2)),
      y: Math.max(0, Math.floor((this.displaySize.height - h) / 2)),
      width,
      height: h,
    };
  }
}

const MIN_DIALOG_HEIGHT = 220;
/** A card's height before it measures itself. */
const CARD_START_HEIGHT = 140;
/** Room left between the dialog and the display's edges. */
const DISPLAY_INSET = 40;
const SPACING = 12;
const INPUT_HEIGHT = 32;
const BUTTON_ROW_HEIGHT = 36;
/** Margins, the button row and the gap above it: the first guess only. */
const DIALOG_CHROME_GUESS = 32 + SPACING + BUTTON_ROW_HEIGHT;
/** Average glyph width of the 14px message font, for the first guess. */
const MESSAGE_CHAR_WIDTH = 7.5;
/** The message font's line height (font size + 4) and text padding. */
const MESSAGE_LINE_HEIGHT = 18;
const MESSAGE_PADDING = 8;

/** A short question keeps the standard width; a long one gets a wider window. */
function dialogWidth(message: string, displayW: number): number {
  return Math.min(message.length > 280 ? 560 : 400, Math.max(320, displayW - DISPLAY_INSET));
}

/**
 * A first guess at the wrapped message's height, so the window opens near
 * its final size; the message measures itself and the window is refitted.
 */
function estimateMessageHeight(message: string, dialogW: number): number {
  const perLine = Math.max(20, Math.floor((dialogW - 40 - MESSAGE_PADDING) / MESSAGE_CHAR_WIDTH));
  const lines = message.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return lines * MESSAGE_LINE_HEIGHT + MESSAGE_PADDING;
}
