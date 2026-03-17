/**
 * LabelWidget — a text label with optional read-only text selection.
 *
 * Renders text with optional background and configurable alignment.
 * When style.wordWrap is true, text is wrapped to fit the widget width
 * and rendered as multiple lines. Labels do not consume any input events
 * unless style.selectable is true, which enables click-drag, double-click
 * word select, Shift+click, Ctrl+A, and Ctrl+C for read-only selection.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { wrapText } from './word-wrap.js';
import { event } from '../../core/message.js';

export class LabelWidget extends WidgetAbject {
  // Word-wrap cache
  private cachedWrappedLines: string[] | null = null;
  private cachedWrapText: string = '';
  private cachedWrapWidth: number = 0;
  private cachedWrapFontSize: number | undefined = undefined;

  // Selection state (only used when style.selectable is true)
  private cursorPos = 0;
  private selAnchor: number | null = null;
  private dragging = false;
  private lastClickTime = 0;
  private lastClickPos = 0;
  private lastSurfaceId = '';  // cached from render for use in processInput

  constructor(config: WidgetConfig) {
    super(config);
  }

  // ── Selection helpers ────────────────────────────────────────────────

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

  private clearSelection(): void {
    this.selAnchor = null;
  }

  private async notifySelectionChanged(): Promise<void> {
    const selectedText = this.getSelectedText();
    await this.send(event(
      this.id, this.uiServerId,
      'selectionChanged',
      { selectedText },
    ));
  }

  /**
   * Convert a click's pixel coordinates to a character offset in this.text.
   * For word-wrapped text, walks through wrapped lines to find the right position.
   */
  private async posFromClick(clickX: number, clickY: number, surfaceId: string, ox: number, oy: number): Promise<number> {
    const font = buildFont(this.style);
    const textPadding = 4;

    if (this.style.wordWrap && this.rect.width > 0) {
      const fontSize = this.style.fontSize ?? 14;
      const lineHeight = fontSize + 4;
      const lines = await this.getWrappedLines(surfaceId, font);
      const lineIndex = Math.max(0, Math.min(Math.floor((clickY - oy) / lineHeight), lines.length - 1));

      // Find character offset within this line
      const localX = clickX - ox - textPadding;
      const lineText = lines[lineIndex];
      const colPos = await this.colFromX(localX, lineText, surfaceId, font);

      // Convert (lineIndex, colPos) to flat text offset
      let offset = 0;
      for (let i = 0; i < lineIndex; i++) {
        offset += lines[i].length;
        // Account for the space/newline that was consumed by wrapping
        // We need to find where this wrapped line starts in the original text
      }
      // More accurate: find cumulative character lengths of wrapped lines in original text
      return this.wrappedPosToTextPos(lines, lineIndex, colPos);
    } else {
      // Single-line
      const localX = clickX - ox;
      return this.colFromX(localX, this.text, surfaceId, font);
    }
  }

  /**
   * Convert (wrappedLineIndex, col) to a flat offset in this.text.
   * Walks the original text, consuming characters that match each wrapped line.
   */
  private wrappedPosToTextPos(lines: string[], targetLine: number, col: number): number {
    let textPos = 0;
    for (let i = 0; i < targetLine; i++) {
      const lineLen = lines[i].length;
      textPos += lineLen;
      // Skip whitespace between wrapped lines (the wrap boundary)
      if (textPos < this.text.length && this.text[textPos] === ' ') {
        textPos++; // consumed space at wrap boundary
      } else if (textPos < this.text.length && this.text[textPos] === '\n') {
        textPos++; // consumed newline
      }
    }
    return Math.min(textPos + col, this.text.length);
  }

  /**
   * Convert a flat text offset to (wrappedLineIndex, col) for highlight rendering.
   */
  private textPosToWrapped(lines: string[], pos: number): { line: number; col: number } {
    let textPos = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length;
      if (pos <= textPos + lineLen) {
        return { line: i, col: pos - textPos };
      }
      textPos += lineLen;
      // Skip wrap boundary character
      if (textPos < this.text.length && (this.text[textPos] === ' ' || this.text[textPos] === '\n')) {
        textPos++;
      }
    }
    return { line: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 };
  }

  /**
   * Binary search for the character column closest to a given pixel X offset.
   */
  private async colFromX(localX: number, lineText: string, surfaceId: string, font: string): Promise<number> {
    if (localX <= 0 || lineText.length === 0) return 0;

    const fullWidth = await this.measureText(surfaceId, lineText, font);
    if (localX >= fullWidth) return lineText.length;

    // Binary search
    let lo = 0;
    let hi = lineText.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const w = await this.measureText(surfaceId, lineText.substring(0, mid), font);
      if (w < localX) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // Check if closer to lo or lo-1
    if (lo > 0) {
      const wPrev = await this.measureText(surfaceId, lineText.substring(0, lo - 1), font);
      const wCurr = await this.measureText(surfaceId, lineText.substring(0, lo), font);
      if (Math.abs(localX - wPrev) < Math.abs(localX - wCurr)) {
        return lo - 1;
      }
    }
    return lo;
  }

  /**
   * Find word boundaries around a position for double-click word selection.
   */
  private wordBoundaries(pos: number): { start: number; end: number } {
    const isWordChar = (ch: string) => /\w/.test(ch);
    let start = pos;
    let end = pos;
    if (pos < this.text.length && isWordChar(this.text[pos])) {
      while (start > 0 && isWordChar(this.text[start - 1])) start--;
      while (end < this.text.length && isWordChar(this.text[end])) end++;
    } else {
      // Non-word character: select just that char (or adjacent non-word chars)
      while (start > 0 && !isWordChar(this.text[start - 1]) && this.text[start - 1] !== ' ') start--;
      while (end < this.text.length && !isWordChar(this.text[end]) && this.text[end] !== ' ') end++;
    }
    return { start, end };
  }

  private async getWrappedLines(surfaceId: string, font: string): Promise<string[]> {
    const fontSize = this.style.fontSize ?? 14;
    const textPadding = 4;
    const maxWidth = this.rect.width - textPadding * 2;

    if (
      this.cachedWrappedLines === null ||
      this.cachedWrapText !== this.text ||
      this.cachedWrapWidth !== maxWidth ||
      this.cachedWrapFontSize !== fontSize
    ) {
      const measureFn = (t: string) => this.measureText(surfaceId, t, font);
      this.cachedWrappedLines = await wrapText(this.text, maxWidth, measureFn);
      this.cachedWrapText = this.text;
      this.cachedWrapWidth = maxWidth;
      this.cachedWrapFontSize = fontSize;
    }
    return this.cachedWrappedLines;
  }

  // ── Draw commands ────────────────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    // Cache surfaceId so processInput can use it for measureText
    this.lastSurfaceId = surfaceId;

    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;

    if (style.background) {
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill: style.background, radius },
      });
    }

    const align = style.align ?? 'left';
    const fill = style.color ?? this.theme.textPrimary;
    const sel = this.style.selectable ? this.getSelection() : null;

    if (style.wordWrap && w > 0) {
      // Multi-line word-wrap rendering
      const fontSize = style.fontSize ?? 14;
      const lineHeight = fontSize + 4;
      const textPadding = 4;

      const lines = await this.getWrappedLines(surfaceId, font);

      // Clip to prevent overflow
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'clip',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h },
      });

      // Compute selection line/col positions for highlight
      let selStart: { line: number; col: number } | null = null;
      let selEnd: { line: number; col: number } | null = null;
      if (sel && this.focused) {
        selStart = this.textPosToWrapped(lines, sel.start);
        selEnd = this.textPosToWrapped(lines, sel.end);
      }

      for (let i = 0; i < lines.length; i++) {
        const lineY = oy + i * lineHeight;
        const textY = lineY + lineHeight * 0.7;
        if (textY - lineHeight > oy + h) break; // past bottom edge

        // Selection highlight for this line
        if (selStart && selEnd && i >= selStart.line && i <= selEnd.line) {
          let selStartX = ox + textPadding;
          let selEndX = ox + w - textPadding;

          if (i === selStart.line && i === selEnd.line) {
            const beforeStart = lines[i].substring(0, selStart.col);
            const beforeEnd = lines[i].substring(0, selEnd.col);
            selStartX = ox + textPadding + (beforeStart.length > 0
              ? await this.measureText(surfaceId, beforeStart, font) : 0);
            selEndX = ox + textPadding + (beforeEnd.length > 0
              ? await this.measureText(surfaceId, beforeEnd, font) : 0);
          } else if (i === selStart.line) {
            const beforeStart = lines[i].substring(0, selStart.col);
            selStartX = ox + textPadding + (beforeStart.length > 0
              ? await this.measureText(surfaceId, beforeStart, font) : 0);
          } else if (i === selEnd.line) {
            const beforeEnd = lines[i].substring(0, selEnd.col);
            selEndX = ox + textPadding + (beforeEnd.length > 0
              ? await this.measureText(surfaceId, beforeEnd, font) : 0);
          }

          if (selEndX > selStartX) {
            commands.push({
              type: 'rect',
              surfaceId,
              params: {
                x: selStartX, y: lineY,
                width: selEndX - selStartX, height: lineHeight,
                fill: this.theme.selectionBg,
              },
            });
          }
        }

        let textX: number;
        if (align === 'center') {
          textX = ox + w / 2;
        } else if (align === 'right') {
          textX = ox + w - textPadding;
        } else {
          textX = ox + textPadding;
        }

        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: textX,
            y: textY,
            text: lines[i],
            font,
            fill,
            align,
            baseline: 'alphabetic',
          },
        });
      }

      commands.push({ type: 'restore', surfaceId, params: {} });
    } else {
      // Single-line rendering

      // Selection highlight (single-line)
      if (sel && this.focused) {
        const beforeStart = this.text.substring(0, sel.start);
        const beforeEnd = this.text.substring(0, sel.end);
        const startX = ox + (beforeStart.length > 0
          ? await this.measureText(surfaceId, beforeStart, font) : 0);
        const endX = ox + (beforeEnd.length > 0
          ? await this.measureText(surfaceId, beforeEnd, font) : 0);
        if (endX > startX) {
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
      }

      let textX: number;
      if (align === 'center') {
        textX = ox + w / 2;
      } else if (align === 'right') {
        textX = ox + w;
      } else {
        textX = ox;
      }

      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: textX,
          y: oy + h / 2,
          text: this.text,
          font,
          fill,
          align,
          baseline: 'middle',
        },
      });
    }

    return commands;
  }

  // ── Input handling ───────────────────────────────────────────────────

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.style.selectable) return { consumed: false };

    const type = input.type as string;
    const surfaceId = this.lastSurfaceId;
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;

    if (type === 'mousedown') {
      const x = input.x as number ?? 0;
      const y = input.y as number ?? 0;

      // We need ox/oy for posFromClick — use 0,0 since coordinates are already local to widget
      const clickPos = await this.posFromClick(x, y, surfaceId, 0, 0);

      const now = Date.now();
      const isDoubleClick = (now - this.lastClickTime) < 400 && Math.abs(clickPos - this.lastClickPos) <= 1;
      this.lastClickTime = now;
      this.lastClickPos = clickPos;

      if (isDoubleClick) {
        // Double-click: select word
        const { start, end } = this.wordBoundaries(clickPos);
        this.selAnchor = start;
        this.cursorPos = end;
        await this.notifySelectionChanged();
      } else if (modifiers?.shift) {
        // Shift+click: extend selection
        if (this.selAnchor === null) {
          this.selAnchor = this.cursorPos;
        }
        this.cursorPos = clickPos;
        await this.notifySelectionChanged();
      } else {
        // Regular click: set cursor, clear selection
        this.clearSelection();
        this.cursorPos = clickPos;
        this.selAnchor = clickPos; // anchor for drag
        this.dragging = true;
        await this.notifySelectionChanged();
      }

      await this.requestRedraw();
      return { consumed: true };
    }

    if (type === 'mousemove') {
      if (!this.dragging) return { consumed: false };

      const x = input.x as number ?? 0;
      const y = input.y as number ?? 0;
      const clickPos = await this.posFromClick(x, y, surfaceId, 0, 0);
      this.cursorPos = clickPos;
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (type === 'mouseup') {
      if (this.dragging) {
        this.dragging = false;
        // If anchor equals cursor after drag, clear selection (was just a click)
        if (this.selAnchor === this.cursorPos) {
          this.clearSelection();
          await this.notifySelectionChanged();
        }
      }
      return { consumed: true };
    }

    if (type === 'keydown') {
      const key = input.key as string;
      const ctrl = modifiers?.ctrl ?? false;
      const meta = modifiers?.meta ?? false;
      const shift = modifiers?.shift ?? false;

      // Ctrl+A: select all
      if (key === 'a' && (ctrl || meta)) {
        this.selAnchor = 0;
        this.cursorPos = this.text.length;
        await this.notifySelectionChanged();
        await this.requestRedraw();
        return { consumed: true };
      }

      // Ctrl+C: consumed (UIServer handles actual clipboard via selectionChanged)
      if (key === 'c' && (ctrl || meta)) {
        return { consumed: true };
      }

      // Arrow keys with shift: extend selection
      if (key === 'ArrowLeft') {
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = this.cursorPos;
          if (this.cursorPos > 0) this.cursorPos--;
          await this.notifySelectionChanged();
        } else if (this.getSelection()) {
          this.cursorPos = this.getSelection()!.start;
          this.clearSelection();
          await this.notifySelectionChanged();
        }
        await this.requestRedraw();
        return { consumed: true };
      }

      if (key === 'ArrowRight') {
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = this.cursorPos;
          if (this.cursorPos < this.text.length) this.cursorPos++;
          await this.notifySelectionChanged();
        } else if (this.getSelection()) {
          this.cursorPos = this.getSelection()!.end;
          this.clearSelection();
          await this.notifySelectionChanged();
        }
        await this.requestRedraw();
        return { consumed: true };
      }

      // Home/End with shift
      if (key === 'Home') {
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = this.cursorPos;
          this.cursorPos = 0;
          await this.notifySelectionChanged();
        } else {
          this.cursorPos = 0;
          this.clearSelection();
          await this.notifySelectionChanged();
        }
        await this.requestRedraw();
        return { consumed: true };
      }

      if (key === 'End') {
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = this.cursorPos;
          this.cursorPos = this.text.length;
          await this.notifySelectionChanged();
        } else {
          this.cursorPos = this.text.length;
          this.clearSelection();
          await this.notifySelectionChanged();
        }
        await this.requestRedraw();
        return { consumed: true };
      }

      return { consumed: false };
    }

    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(_updates: Record<string, unknown>): void {
    // Invalidate wrap cache when text or style changes
    this.cachedWrappedLines = null;
    // Clear selection when text changes
    this.cursorPos = 0;
    this.selAnchor = null;
    this.dragging = false;
  }
}
