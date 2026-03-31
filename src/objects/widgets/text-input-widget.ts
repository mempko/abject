/**
 * TextInputWidget -- text input with cursor, selection, placeholder, and masking.
 *
 * Renders a bordered input field with clipped text content. Supports cursor
 * positioning via click, keyboard navigation (Home/End/ArrowLeft/ArrowRight),
 * character insertion and deletion, masked display (bullets), placeholder text,
 * Enter-to-submit, Tab-to-advance-focus (unconsumed, bubbles to Window),
 * text selection (Shift+Arrow/Home/End, Shift+Click, Ctrl+A), and copy/cut.
 *
 * When wordWrap is enabled, text wraps visually using wrapText() and the widget
 * renders multiple lines, emitting 'resize' events so the owner can update layout.
 * The 1D cursor model is preserved — visual line/column are derived at render time.
 */


import { event } from '../../core/message.js';
import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';
import { wrapText, estimateWrappedLineCount } from './word-wrap.js';

export interface TextInputWidgetConfig extends WidgetConfig {
  placeholder?: string;
  masked?: boolean;
  wordWrap?: boolean;
  minLines?: number;
  maxLines?: number;
}

export class TextInputWidget extends WidgetAbject {
  private cursorPos = 0;
  private placeholder?: string;
  private masked: boolean;
  private selAnchor: number | null = null;
  private dragging = false;
  private lastClickTime = 0;
  private lastClickPos = 0;
  private lastSurfaceId = '';

  // Word-wrap fields
  private wordWrap: boolean;
  private minLines: number;
  private maxLines: number | undefined;
  private cachedWrappedLines: string[] | null = null;
  private cachedWrapText = '';
  private cachedWrapWidth = 0;
  private cachedWrapFontSize: number | undefined;
  private lastEmittedLineCount = 1;
  private scrollOffset = 0;

  constructor(config: TextInputWidgetConfig) {
    super(config);
    this.placeholder = config.placeholder;
    this.masked = config.masked ?? false;
    this.wordWrap = config.wordWrap ?? false;
    this.minLines = config.minLines ?? 1;
    this.maxLines = config.maxLines;
    this.cursorPos = (config.text ?? '').length;
  }

  protected override acceptsInputWhenDisabled(): boolean {
    return true;
  }

  protected override wantsMobileKeyboard(): boolean {
    return true;
  }

  // ── Visual position mapping ────────────────────────────────────────

  private cursorToVisualPos(wrappedLines: string[]): { line: number; col: number } {
    let remaining = this.cursorPos;
    for (let i = 0; i < wrappedLines.length; i++) {
      const lineLen = wrappedLines[i].length;
      if (remaining <= lineLen || i === wrappedLines.length - 1) {
        return { line: i, col: Math.min(remaining, lineLen) };
      }
      remaining -= lineLen;
    }
    return { line: 0, col: 0 };
  }

  private visualPosToCursor(wrappedLines: string[], line: number, col: number): number {
    let offset = 0;
    for (let i = 0; i < line && i < wrappedLines.length; i++) {
      offset += wrappedLines[i].length;
    }
    if (line < wrappedLines.length) {
      offset += Math.min(col, wrappedLines[line].length);
    }
    return Math.min(offset, this.text.length);
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
    this.invalidateWrapCache();
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
    this.invalidateWrapCache();
  }

  private clearSelection(): void {
    this.selAnchor = null;
  }

  private async notifySelectionChanged(): Promise<void> {
    const selectedText = this.getSelectedText();
    this.send(event(
      this.id, this.uiServerId,
      'selectionChanged',
      { selectedText },
    ));
  }

  // ── Wrap cache management ──────────────────────────────────────────

  private invalidateWrapCache(): void {
    this.cachedWrappedLines = null;
  }

  private checkAndEmitResize(wrappedLineCount: number): void {
    const lineHeight = DEFAULT_LINE_HEIGHT;
    const verticalPadding = 8;
    const maxL = this.maxLines ?? Infinity;
    const clampedLines = Math.max(this.minLines, Math.min(wrappedLineCount, maxL));
    const preferredHeight = clampedLines * lineHeight + verticalPadding;
    if (clampedLines !== this.lastEmittedLineCount) {
      this.lastEmittedLineCount = clampedLines;
      this.changed('resize', { preferredHeight });
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    if (this.wordWrap && !this.masked) {
      return this.buildWrappedDrawCommands(surfaceId, ox, oy);
    }
    return this.buildSingleLineDrawCommands(surfaceId, ox, oy);
  }

  private async buildSingleLineDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    this.lastSurfaceId = surfaceId;
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;
    const focused = this.focused;

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    // Focus glow shadow (skip when disabled)
    const borderColor = style.borderColor ?? (focused && !this.disabled ? this.theme.inputBorderFocus : this.theme.inputBorder);
    if (focused && !this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId,
        params: { color: this.theme.inputBorderFocus, blur: 6 },
      });
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
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Border rect (drawn without shadow)
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

    // Close disabled alpha save
    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    return commands;
  }

  private async buildWrappedDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    this.lastSurfaceId = surfaceId;
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;
    const focused = this.focused;
    const textPadding = 8;
    const lineHeight = DEFAULT_LINE_HEIGHT;
    const textFont = style.fontSize ? font : WIDGET_FONT;
    const maxWidth = w - textPadding * 2;

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    // Focus glow shadow (skip when disabled)
    const borderColor = style.borderColor ?? (focused && !this.disabled ? this.theme.inputBorderFocus : this.theme.inputBorder);
    if (focused && !this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId,
        params: { color: this.theme.inputBorderFocus, blur: 6 },
      });
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
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Border rect
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

    // Clip
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
    });

    // Compute wrapped lines (with cache)
    const fontSize = style.fontSize ?? 14;
    if (
      this.cachedWrappedLines === null ||
      this.cachedWrapText !== this.text ||
      this.cachedWrapWidth !== maxWidth ||
      this.cachedWrapFontSize !== fontSize
    ) {
      if (maxWidth > 0 && this.text) {
        const measureFn = (t: string) => this.measureText(surfaceId, t, textFont);
        this.cachedWrappedLines = await wrapText(this.text, maxWidth, measureFn);
      } else {
        this.cachedWrappedLines = [this.text || ''];
      }
      this.cachedWrapText = this.text;
      this.cachedWrapWidth = maxWidth;
      this.cachedWrapFontSize = fontSize;
    }

    const lines = this.cachedWrappedLines;
    this.checkAndEmitResize(lines.length);

    // Auto-scroll: ensure cursor is visible
    const cursorVisual = this.cursorToVisualPos(lines);
    const maxVisibleLines = Math.floor((h - 8) / lineHeight);
    if (cursorVisual.line < this.scrollOffset) {
      this.scrollOffset = cursorVisual.line;
    } else if (cursorVisual.line >= this.scrollOffset + maxVisibleLines) {
      this.scrollOffset = cursorVisual.line - maxVisibleLines + 1;
    }
    // Clamp scroll offset
    const maxScroll = Math.max(0, lines.length - maxVisibleLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    const topPad = 4;

    // Selection highlight
    const sel = this.getSelection();
    if (sel && focused) {
      const selStartVisual = this.cursorToVisualPosAt(lines, sel.start);
      const selEndVisual = this.cursorToVisualPosAt(lines, sel.end);

      for (let i = Math.max(selStartVisual.line, this.scrollOffset);
           i <= Math.min(selEndVisual.line, this.scrollOffset + maxVisibleLines - 1);
           i++) {
        const visI = i - this.scrollOffset;
        const lineText = lines[i];
        const lineStartCol = (i === selStartVisual.line) ? selStartVisual.col : 0;
        const lineEndCol = (i === selEndVisual.line) ? selEndVisual.col : lineText.length;

        const beforeStartText = lineText.substring(0, lineStartCol);
        const beforeEndText = lineText.substring(0, lineEndCol);
        const startX = ox + textPadding + (beforeStartText.length > 0
          ? await this.measureText(surfaceId, beforeStartText, textFont)
          : 0);
        const endX = ox + textPadding + (beforeEndText.length > 0
          ? await this.measureText(surfaceId, beforeEndText, textFont)
          : 0);

        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: startX,
            y: oy + topPad + visI * lineHeight,
            width: endX - startX,
            height: lineHeight,
            fill: this.theme.selectionBg,
          },
        });
      }
    }

    // Render visible text lines
    for (let i = this.scrollOffset; i < lines.length && i < this.scrollOffset + maxVisibleLines; i++) {
      const visI = i - this.scrollOffset;
      const lineY = oy + topPad + visI * lineHeight + lineHeight * 0.7;

      if (lines[i]) {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + textPadding,
            y: lineY,
            text: lines[i],
            font: textFont,
            fill: style.color ?? this.theme.textSecondary,
            baseline: 'alphabetic',
          },
        });
      }
    }

    // Placeholder
    if (!this.text && this.placeholder && !focused) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: oy + topPad + lineHeight * 0.7,
          text: this.placeholder,
          font: textFont,
          fill: this.theme.textPlaceholder,
          baseline: 'alphabetic',
        },
      });
    }

    // Cursor
    if (focused) {
      const visLine = cursorVisual.line - this.scrollOffset;
      if (visLine >= 0 && visLine < maxVisibleLines) {
        const beforeCursorText = lines[cursorVisual.line].substring(0, cursorVisual.col);
        const cursorX = ox + textPadding + (beforeCursorText.length > 0
          ? await this.measureText(surfaceId, beforeCursorText, textFont)
          : 0);
        const cursorTop = oy + topPad + visLine * lineHeight + 2;
        const cursorBottom = cursorTop + lineHeight - 4;
        commands.push({
          type: 'line',
          surfaceId,
          params: {
            x1: cursorX, y1: cursorTop,
            x2: cursorX, y2: cursorBottom,
            stroke: this.theme.cursor,
          },
        });
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    return commands;
  }

  /** Like cursorToVisualPos but for an arbitrary offset (not this.cursorPos). */
  private cursorToVisualPosAt(wrappedLines: string[], offset: number): { line: number; col: number } {
    let remaining = offset;
    for (let i = 0; i < wrappedLines.length; i++) {
      const lineLen = wrappedLines[i].length;
      if (remaining <= lineLen || i === wrappedLines.length - 1) {
        return { line: i, col: Math.min(remaining, lineLen) };
      }
      remaining -= lineLen;
    }
    return { line: 0, col: 0 };
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'mousedown') {
      return this.handleMouseDown(input);
    }

    if (type === 'mousemove') {
      return this.handleMouseMove(input);
    }

    if (type === 'mouseup') {
      return this.handleMouseUp();
    }

    if (type === 'keydown') {
      return this.handleKeyDown(input);
    }

    if (type === 'paste') {
      return this.handlePaste(input);
    }

    if (type === 'wheel') {
      return this.handleWheel(input);
    }

    return { consumed: false };
  }

  private async posFromClick(clickX: number, clickY: number, surfaceId: string | undefined): Promise<number> {
    const textPadding = 8;
    const cursorFont = this.style.fontSize ? buildFont(this.style) : WIDGET_FONT;

    if (this.wordWrap && !this.masked && this.cachedWrappedLines) {
      const lineHeight = DEFAULT_LINE_HEIGHT;
      const topPad = 4;
      const clickLine = Math.floor((clickY - topPad) / lineHeight) + this.scrollOffset;
      const lines = this.cachedWrappedLines;
      const clampedLine = Math.max(0, Math.min(clickLine, lines.length - 1));
      const lineText = lines[clampedLine];
      const clickOffset = clickX - textPadding;

      if (lineText.length > 0 && clickOffset > 0 && surfaceId) {
        const totalWidth = await this.measureText(surfaceId, lineText, cursorFont);
        const avgCharWidth = totalWidth / lineText.length;
        const col = Math.max(0, Math.min(Math.round(clickOffset / avgCharWidth), lineText.length));
        return this.visualPosToCursor(lines, clampedLine, col);
      }
      return clickOffset <= 0
        ? this.visualPosToCursor(lines, clampedLine, 0)
        : this.visualPosToCursor(lines, clampedLine, lineText.length);
    }

    // Single-line
    const clickOffset = clickX - textPadding;
    if (this.text.length > 0 && clickOffset > 0) {
      const displayText = this.masked ? '\u2022'.repeat(this.text.length) : this.text;
      if (surfaceId) {
        const totalWidth = await this.measureText(surfaceId, displayText, cursorFont);
        const avgCharWidth = totalWidth / this.text.length;
        return Math.max(0, Math.min(Math.round(clickOffset / avgCharWidth), this.text.length));
      }
      return this.text.length;
    }
    return clickOffset <= 0 ? 0 : this.text.length;
  }

  private wordBoundaries(pos: number): { start: number; end: number } {
    const isWordChar = (ch: string) => /\w/.test(ch);
    let start = pos;
    let end = pos;
    if (pos < this.text.length && isWordChar(this.text[pos])) {
      while (start > 0 && isWordChar(this.text[start - 1])) start--;
      while (end < this.text.length && isWordChar(this.text[end])) end++;
    } else {
      while (start > 0 && !isWordChar(this.text[start - 1]) && this.text[start - 1] !== ' ') start--;
      while (end < this.text.length && !isWordChar(this.text[end]) && this.text[end] !== ' ') end++;
    }
    return { start, end };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;
    const surfaceId = (input.surfaceId as string | undefined) ?? this.lastSurfaceId;

    const clickPos = await this.posFromClick(clickX, clickY, surfaceId);

    const now = Date.now();
    const isDoubleClick = (now - this.lastClickTime) < 400 && Math.abs(clickPos - this.lastClickPos) <= 1;
    this.lastClickTime = now;
    this.lastClickPos = clickPos;

    if (isDoubleClick) {
      const { start, end } = this.wordBoundaries(clickPos);
      this.selAnchor = start;
      this.cursorPos = end;
      this.dragging = false;
      await this.notifySelectionChanged();
    } else if (modifiers?.shift) {
      if (this.selAnchor === null) {
        this.selAnchor = this.cursorPos;
      }
      this.cursorPos = clickPos;
      await this.notifySelectionChanged();
    } else {
      this.clearSelection();
      this.cursorPos = clickPos;
      this.selAnchor = clickPos;
      this.dragging = true;
      await this.notifySelectionChanged();
    }

    await this.requestRedraw();
    return { consumed: true };
  }

  private async handleMouseMove(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.dragging) return { consumed: false };

    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const surfaceId = (input.surfaceId as string | undefined) ?? this.lastSurfaceId;

    const clickPos = await this.posFromClick(clickX, clickY, surfaceId);
    this.cursorPos = clickPos;
    await this.notifySelectionChanged();
    await this.requestRedraw();
    return { consumed: true };
  }

  private async handleMouseUp(): Promise<{ consumed: boolean }> {
    if (this.dragging) {
      this.dragging = false;
      if (this.selAnchor === this.cursorPos) {
        this.clearSelection();
        await this.notifySelectionChanged();
      }
    }
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

    // When disabled, block all editing keys but allow navigation/selection above
    if (this.disabled) {
      // Allow navigation keys (arrows, Home, End) to fall through for selection
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
          || key === 'Home' || key === 'End') {
        // fall through to normal handling below
      } else {
        return { consumed: true };
      }
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
        this.invalidateWrapCache();
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
        this.invalidateWrapCache();
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

    // ArrowUp/ArrowDown: navigate visual lines in word-wrap mode
    if (key === 'ArrowUp' && this.wordWrap && this.cachedWrappedLines) {
      const lines = this.cachedWrappedLines;
      const visual = this.cursorToVisualPos(lines);
      if (visual.line > 0) {
        const newLine = visual.line - 1;
        const newCol = Math.min(visual.col, lines[newLine].length);
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = pos;
        } else {
          this.clearSelection();
        }
        this.cursorPos = this.visualPosToCursor(lines, newLine, newCol);
        if (shift) await this.notifySelectionChanged();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowDown' && this.wordWrap && this.cachedWrappedLines) {
      const lines = this.cachedWrappedLines;
      const visual = this.cursorToVisualPos(lines);
      if (visual.line < lines.length - 1) {
        const newLine = visual.line + 1;
        const newCol = Math.min(visual.col, lines[newLine].length);
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = pos;
        } else {
          this.clearSelection();
        }
        this.cursorPos = this.visualPosToCursor(lines, newLine, newCol);
        if (shift) await this.notifySelectionChanged();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Home') {
      if (this.wordWrap && this.cachedWrappedLines && !(ctrl || meta)) {
        // Move to start of current visual line
        const lines = this.cachedWrappedLines;
        const visual = this.cursorToVisualPos(lines);
        const newPos = this.visualPosToCursor(lines, visual.line, 0);
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = pos;
          this.cursorPos = newPos;
          await this.notifySelectionChanged();
        } else {
          this.clearSelection();
          this.cursorPos = newPos;
          await this.notifySelectionChanged();
        }
      } else {
        // Start of all text
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = pos;
          this.cursorPos = 0;
          await this.notifySelectionChanged();
        } else {
          this.clearSelection();
          this.cursorPos = 0;
          await this.notifySelectionChanged();
        }
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'End') {
      if (this.wordWrap && this.cachedWrappedLines && !(ctrl || meta)) {
        // Move to end of current visual line
        const lines = this.cachedWrappedLines;
        const visual = this.cursorToVisualPos(lines);
        const newPos = this.visualPosToCursor(lines, visual.line, lines[visual.line].length);
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = pos;
          this.cursorPos = newPos;
          await this.notifySelectionChanged();
        } else {
          this.clearSelection();
          this.cursorPos = newPos;
          await this.notifySelectionChanged();
        }
      } else {
        // End of all text
        if (shift) {
          if (this.selAnchor === null) this.selAnchor = pos;
          this.cursorPos = this.text.length;
          await this.notifySelectionChanged();
        } else {
          this.clearSelection();
          this.cursorPos = this.text.length;
          await this.notifySelectionChanged();
        }
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
        this.invalidateWrapCache();
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
    if (this.disabled) return { consumed: true };
    const pasteText = (input.pasteText as string) ?? '';
    if (!pasteText) return { consumed: true };

    if (this.getSelection()) {
      this.replaceSelection(pasteText);
    } else {
      const pos = this.cursorPos;
      this.text = this.text.substring(0, pos) + pasteText + this.text.substring(pos);
      this.cursorPos = pos + pasteText.length;
      this.invalidateWrapCache();
    }
    this.selAnchor = null;
    this.changed('change', this.text);
    await this.notifySelectionChanged();
    await this.requestRedraw();
    return { consumed: true };
  }

  private async handleWheel(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.wordWrap || !this.cachedWrappedLines) return { consumed: false };

    const maxLines = this.maxLines;
    if (!maxLines || this.cachedWrappedLines.length <= maxLines) return { consumed: false };

    const deltaY = (input.deltaY as number | undefined) ?? 0;
    const direction = deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0;
    if (direction === 0) return { consumed: false };

    const lineHeight = DEFAULT_LINE_HEIGHT;
    const maxVisibleLines = Math.floor((this.rect.height - 8) / lineHeight);
    const maxScroll = Math.max(0, this.cachedWrappedLines.length - maxVisibleLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + direction, maxScroll));
    await this.requestRedraw();
    return { consumed: true };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.masked !== undefined) this.masked = updates.masked as boolean;
    if (updates.placeholder !== undefined) this.placeholder = updates.placeholder as string;
    if (updates.wordWrap !== undefined) {
      this.wordWrap = updates.wordWrap as boolean;
      this.invalidateWrapCache();
    }
    if (updates.minLines !== undefined) this.minLines = updates.minLines as number;
    if (updates.maxLines !== undefined) this.maxLines = updates.maxLines as number | undefined;
    // When text is set externally, reset cursor to end and clear selection
    if (updates.text !== undefined) {
      this.cursorPos = this.text.length;
      this.selAnchor = null;
      this.invalidateWrapCache();
      this.scrollOffset = 0;
    }
  }
}
