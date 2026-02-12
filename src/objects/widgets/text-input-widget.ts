/**
 * TextInputWidget -- single-line text input with cursor, selection, placeholder, and masking.
 *
 * Renders a bordered input field with clipped text content. Supports cursor
 * positioning via click, keyboard navigation (Home/End/ArrowLeft/ArrowRight),
 * character insertion and deletion, masked display (bullets), placeholder text,
 * Enter-to-submit, Tab-to-advance-focus (unconsumed, bubbles to Window),
 * text selection (Shift+Arrow/Home/End, Shift+Click, Ctrl+A), and copy/cut.
 */

import { InterfaceId } from '../../core/types.js';
import { event } from '../../core/message.js';
import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';

export interface TextInputWidgetConfig extends WidgetConfig {
  placeholder?: string;
  masked?: boolean;
}

export class TextInputWidget extends WidgetAbject {
  private cursorPos = 0;
  private placeholder?: string;
  private masked: boolean;
  private selAnchor: number | null = null;

  constructor(config: TextInputWidgetConfig) {
    super(config);
    this.placeholder = config.placeholder;
    this.masked = config.masked ?? false;
    this.cursorPos = (config.text ?? '').length;
  }

  // ── Selection helpers ──────────────────────────────────────────────

  private getSelection(): { start: number; end: number } | null {
    if (this.selAnchor === null) return null;
    const a = this.selAnchor;
    const b = this.cursorPos;
    if (a === b) return null;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  private getSelectedText(): string {
    const sel = this.getSelection();
    if (!sel) return '';
    return this.text.substring(sel.start, sel.end);
  }

  private deleteSelection(): void {
    const sel = this.getSelection();
    if (!sel) return;
    this.text = this.text.substring(0, sel.start) + this.text.substring(sel.end);
    this.cursorPos = sel.start;
    this.selAnchor = null;
  }

  private replaceSelection(text: string): void {
    const sel = this.getSelection();
    if (sel) {
      this.text = this.text.substring(0, sel.start) + text + this.text.substring(sel.end);
      this.cursorPos = sel.start + text.length;
      this.selAnchor = null;
    } else {
      this.text = this.text.substring(0, this.cursorPos) + text + this.text.substring(this.cursorPos);
      this.cursorPos += text.length;
    }
  }

  private clearSelection(): void {
    this.selAnchor = null;
  }

  private async notifySelectionChanged(): Promise<void> {
    const selectedText = this.getSelectedText();
    await this.send(event(
      this.id, this.uiServerId,
      'abjects:ui' as InterfaceId, 'selectionChanged',
      { selectedText },
    ));
  }

  // ── Rendering ──────────────────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;
    const focused = this.focused;

    // Border rect
    const borderColor = style.borderColor ?? (focused ? this.theme.inputBorderFocus : this.theme.inputBorder);
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: style.background ?? this.theme.inputBg,
        stroke: borderColor,
        radius,
      },
    });

    // Clip to prevent text overflow
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
    });

    const displayText = this.text
      ? (this.masked ? '\u2022'.repeat(this.text.length) : this.text)
      : '';
    const textPadding = 8;
    const textFont = style.fontSize ? font : WIDGET_FONT;

    // Selection highlight
    const sel = this.getSelection();
    if (sel && focused) {
      const beforeStart = this.masked
        ? '\u2022'.repeat(sel.start)
        : this.text.substring(0, sel.start);
      const beforeEnd = this.masked
        ? '\u2022'.repeat(sel.end)
        : this.text.substring(0, sel.end);
      const startX = ox + textPadding + (beforeStart.length > 0
        ? await this.measureText(surfaceId, beforeStart, textFont)
        : 0);
      const endX = ox + textPadding + (beforeEnd.length > 0
        ? await this.measureText(surfaceId, beforeEnd, textFont)
        : 0);
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: startX, y: oy + 2,
          width: endX - startX, height: h - 4,
          fill: this.theme.selectionBg,
        },
      });
    }

    if (displayText) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: oy + h / 2,
          text: displayText,
          font: textFont,
          fill: style.color ?? this.theme.textSecondary,
          baseline: 'middle',
        },
      });
    } else if (this.placeholder && !focused) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: oy + h / 2,
          text: this.placeholder,
          font: textFont,
          fill: this.theme.textPlaceholder,
          baseline: 'middle',
        },
      });
    }

    // Cursor line when focused
    if (focused) {
      const cursorPos = this.cursorPos;
      const beforeCursor = this.masked
        ? '\u2022'.repeat(cursorPos)
        : this.text.substring(0, cursorPos);
      const cursorFont = style.fontSize ? font : WIDGET_FONT;
      const measuredWidth = beforeCursor.length > 0
        ? await this.measureText(surfaceId, beforeCursor, cursorFont)
        : 0;
      const cursorX = ox + textPadding + measuredWidth;
      commands.push({
        type: 'line',
        surfaceId,
        params: {
          x1: cursorX, y1: oy + 4,
          x2: cursorX, y2: oy + h - 4,
          stroke: this.theme.cursor,
        },
      });
    }

    commands.push({ type: 'restore', surfaceId, params: {} });
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'mousedown') {
      return this.handleMouseDown(input);
    }

    if (type === 'keydown') {
      return this.handleKeyDown(input);
    }

    if (type === 'paste') {
      return this.handlePaste(input);
    }

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;
    const textPadding = 8;
    const clickOffset = clickX - textPadding;

    // Calculate click position
    let clickPos: number;
    if (this.text.length > 0 && clickOffset > 0) {
      const displayText = this.masked ? '\u2022'.repeat(this.text.length) : this.text;
      const surfaceId = input.surfaceId as string | undefined;
      const cursorFont = this.style.fontSize ? buildFont(this.style) : WIDGET_FONT;
      if (surfaceId) {
        const totalWidth = await this.measureText(surfaceId, displayText, cursorFont);
        const avgCharWidth = totalWidth / this.text.length;
        clickPos = Math.max(0, Math.min(
          Math.round(clickOffset / avgCharWidth),
          this.text.length,
        ));
      } else {
        clickPos = this.text.length;
      }
    } else {
      clickPos = clickOffset <= 0 ? 0 : this.text.length;
    }

    if (modifiers?.shift) {
      // Shift+click: extend selection
      if (this.selAnchor === null) {
        this.selAnchor = this.cursorPos;
      }
      this.cursorPos = clickPos;
      await this.notifySelectionChanged();
    } else {
      // Normal click: clear selection, position cursor
      this.clearSelection();
      this.cursorPos = clickPos;
      await this.notifySelectionChanged();
    }

    await this.requestRedraw();
    return { consumed: true };
  }

  private async handleKeyDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const key = (input.key as string) ?? '';
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;
    const pos = this.cursorPos;
    const shift = modifiers?.shift ?? false;
    const ctrl = modifiers?.ctrl ?? false;
    const meta = modifiers?.meta ?? false;

    // Ctrl+A / Meta+A: select all
    if (key === 'a' && (ctrl || meta)) {
      this.selAnchor = 0;
      this.cursorPos = this.text.length;
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    // Ctrl+C / Meta+C: copy (handled by UIServer's copy event listener)
    if (key === 'c' && (ctrl || meta)) {
      return { consumed: true };
    }

    // Ctrl+X / Meta+X: cut
    if (key === 'x' && (ctrl || meta)) {
      if (this.getSelection()) {
        this.deleteSelection();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Backspace') {
      if (this.getSelection()) {
        this.deleteSelection();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      } else if (pos > 0) {
        this.text = this.text.substring(0, pos - 1) + this.text.substring(pos);
        this.cursorPos = pos - 1;
        this.changed('change', this.text);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Delete') {
      if (this.getSelection()) {
        this.deleteSelection();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      } else if (pos < this.text.length) {
        this.text = this.text.substring(0, pos) + this.text.substring(pos + 1);
        this.changed('change', this.text);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'ArrowLeft') {
      if (shift) {
        if (this.selAnchor === null) this.selAnchor = pos;
        if (this.cursorPos > 0) this.cursorPos--;
        await this.notifySelectionChanged();
      } else if (this.getSelection()) {
        this.cursorPos = this.getSelection()!.start;
        this.clearSelection();
        await this.notifySelectionChanged();
      } else if (pos > 0) {
        this.cursorPos = pos - 1;
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowRight') {
      if (shift) {
        if (this.selAnchor === null) this.selAnchor = pos;
        if (this.cursorPos < this.text.length) this.cursorPos++;
        await this.notifySelectionChanged();
      } else if (this.getSelection()) {
        this.cursorPos = this.getSelection()!.end;
        this.clearSelection();
        await this.notifySelectionChanged();
      } else if (pos < this.text.length) {
        this.cursorPos = pos + 1;
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Home') {
      if (shift) {
        if (this.selAnchor === null) this.selAnchor = pos;
        this.cursorPos = 0;
        await this.notifySelectionChanged();
      } else {
        this.clearSelection();
        this.cursorPos = 0;
        await this.notifySelectionChanged();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'End') {
      if (shift) {
        if (this.selAnchor === null) this.selAnchor = pos;
        this.cursorPos = this.text.length;
        await this.notifySelectionChanged();
      } else {
        this.clearSelection();
        this.cursorPos = this.text.length;
        await this.notifySelectionChanged();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Enter') {
      this.changed('submit', this.text);
      return { consumed: true };
    }

    if (key === 'Tab') {
      // Not consumed -- bubbles to Window for focus advance
      return { consumed: false };
    }

    // Printable character
    if (key.length === 1 && !ctrl && !meta) {
      if (this.getSelection()) {
        this.replaceSelection(key);
      } else {
        this.text = this.text.substring(0, pos) + key + this.text.substring(pos);
        this.cursorPos = pos + 1;
      }
      this.selAnchor = null;
      this.changed('change', this.text);
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    return { consumed: true };
  }

  private async handlePaste(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const pasteText = (input.pasteText as string) ?? '';
    if (!pasteText) return { consumed: true };

    if (this.getSelection()) {
      this.replaceSelection(pasteText);
    } else {
      const pos = this.cursorPos;
      this.text = this.text.substring(0, pos) + pasteText + this.text.substring(pos);
      this.cursorPos = pos + pasteText.length;
    }
    this.selAnchor = null;
    this.changed('change', this.text);
    await this.notifySelectionChanged();
    await this.requestRedraw();
    return { consumed: true };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.masked !== undefined) this.masked = updates.masked as boolean;
    if (updates.placeholder !== undefined) this.placeholder = updates.placeholder as string;
    // When text is set externally, reset cursor to end and clear selection
    if (updates.text !== undefined) {
      this.cursorPos = this.text.length;
      this.selAnchor = null;
    }
  }
}
