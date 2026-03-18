/**
 * TextAreaWidget -- multi-line text editor with scrolling, cursor navigation, selection, and paste.
 *
 * Renders a bordered text area with line-by-line display, vertical scrolling,
 * and a blinking cursor. Supports multi-line editing with Enter to split lines,
 * Backspace/Delete across line boundaries, arrow-key navigation between lines,
 * Tab-to-indent (consumed, does NOT bubble), mouse wheel scrolling, multi-line paste,
 * text selection (Shift+Arrows, Shift+Home/End, Shift+Click, Ctrl+A), and copy/cut.
 */


import { event } from '../../core/message.js';
import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';

export interface TextAreaWidgetConfig extends WidgetConfig {
  monospace?: boolean;
}

export class TextAreaWidget extends WidgetAbject {
  private cursorLine = 0;
  private cursorCol = 0;
  private scrollTop = 0;
  private lineHeight: number;
  private monospace: boolean;
  private selAnchorLine: number | null = null;
  private selAnchorCol: number | null = null;
  private dragging = false;
  private lastClickTime = 0;
  private lastClickLine = 0;
  private lastClickCol = 0;
  private lastSurfaceId = '';

  constructor(config: TextAreaWidgetConfig) {
    super(config);
    this.monospace = config.monospace ?? false;
    this.lineHeight = DEFAULT_LINE_HEIGHT;
  }

  protected override acceptsInputWhenDisabled(): boolean {
    return true;
  }

  // ── Selection helpers ──────────────────────────────────────────────

  private getSelection(): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
    if (this.selAnchorLine === null || this.selAnchorCol === null) return null;
    const aLine = this.selAnchorLine;
    const aCol = this.selAnchorCol;
    const bLine = this.cursorLine;
    const bCol = this.cursorCol;
    if (aLine === bLine && aCol === bCol) return null;
    // Normalize: start before end
    if (aLine < bLine || (aLine === bLine && aCol < bCol)) {
      return { startLine: aLine, startCol: aCol, endLine: bLine, endCol: bCol };
    }
    return { startLine: bLine, startCol: bCol, endLine: aLine, endCol: aCol };
  }

  private getSelectedText(): string {
    const sel = this.getSelection();
    if (!sel) return '';
    const lines = this.text.split('\n');
    if (sel.startLine === sel.endLine) {
      return lines[sel.startLine].substring(sel.startCol, sel.endCol);
    }
    const result: string[] = [];
    result.push(lines[sel.startLine].substring(sel.startCol));
    for (let i = sel.startLine + 1; i < sel.endLine; i++) {
      result.push(lines[i]);
    }
    result.push(lines[sel.endLine].substring(0, sel.endCol));
    return result.join('\n');
  }

  private deleteSelection(): void {
    const sel = this.getSelection();
    if (!sel) return;
    const lines = this.text.split('\n');
    if (sel.startLine === sel.endLine) {
      lines[sel.startLine] = lines[sel.startLine].substring(0, sel.startCol) + lines[sel.startLine].substring(sel.endCol);
    } else {
      const before = lines[sel.startLine].substring(0, sel.startCol);
      const after = lines[sel.endLine].substring(sel.endCol);
      lines[sel.startLine] = before + after;
      lines.splice(sel.startLine + 1, sel.endLine - sel.startLine);
    }
    this.text = lines.join('\n');
    this.cursorLine = sel.startLine;
    this.cursorCol = sel.startCol;
    this.selAnchorLine = null;
    this.selAnchorCol = null;
  }

  private replaceSelection(text: string): void {
    const sel = this.getSelection();
    if (sel) {
      this.deleteSelection();
    }
    // Insert text at cursor
    const lines = this.text.split('\n');
    const before = lines[this.cursorLine].substring(0, this.cursorCol);
    const after = lines[this.cursorLine].substring(this.cursorCol);
    const insertLines = text.split('\n');
    if (insertLines.length === 1) {
      lines[this.cursorLine] = before + insertLines[0] + after;
      this.cursorCol += insertLines[0].length;
    } else {
      lines[this.cursorLine] = before + insertLines[0];
      for (let i = 1; i < insertLines.length - 1; i++) {
        lines.splice(this.cursorLine + i, 0, insertLines[i]);
      }
      const lastInsert = insertLines[insertLines.length - 1];
      lines.splice(this.cursorLine + insertLines.length - 1, 0, lastInsert + after);
      this.cursorLine += insertLines.length - 1;
      this.cursorCol = lastInsert.length;
    }
    this.text = lines.join('\n');
    this.selAnchorLine = null;
    this.selAnchorCol = null;
  }

  private clearSelection(): void {
    this.selAnchorLine = null;
    this.selAnchorCol = null;
  }

  private async notifySelectionChanged(): Promise<void> {
    const selectedText = this.getSelectedText();
    this.send(event(
      this.id, this.uiServerId,
      'selectionChanged',
      { selectedText },
    ));
  }

  // ── Rendering ──────────────────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    this.lastSurfaceId = surfaceId;
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;
    const focused = this.focused;
    const lineHeight = this.lineHeight;
    const taFont = this.monospace ? CODE_FONT : (style.fontSize ? font : WIDGET_FONT);

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

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

    // Clip to prevent content overflow
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
    });

    const textPadding = 8;
    const lines = this.text.split('\n');
    const scrollTop = this.scrollTop;
    const visibleLines = Math.floor(h / lineHeight);
    const sel = this.getSelection();

    // Render visible lines (with selection highlight)
    for (let i = scrollTop; i < Math.min(lines.length, scrollTop + visibleLines); i++) {
      const lineY = oy + (i - scrollTop) * lineHeight;
      const lineTextY = lineY + lineHeight * 0.7;

      // Selection highlight for this line
      if (sel && focused && i >= sel.startLine && i <= sel.endLine) {
        let selStartX = ox + textPadding;
        let selEndX = ox + w - textPadding;

        if (i === sel.startLine && i === sel.endLine) {
          // Selection on a single line
          const beforeStart = lines[i].substring(0, sel.startCol);
          const beforeEnd = lines[i].substring(0, sel.endCol);
          selStartX = ox + textPadding + (beforeStart.length > 0
            ? await this.measureText(surfaceId, beforeStart, taFont)
            : 0);
          selEndX = ox + textPadding + (beforeEnd.length > 0
            ? await this.measureText(surfaceId, beforeEnd, taFont)
            : 0);
        } else if (i === sel.startLine) {
          // First line of multi-line selection
          const beforeStart = lines[i].substring(0, sel.startCol);
          selStartX = ox + textPadding + (beforeStart.length > 0
            ? await this.measureText(surfaceId, beforeStart, taFont)
            : 0);
          // selEndX stays at full width
        } else if (i === sel.endLine) {
          // Last line of multi-line selection
          // selStartX stays at textPadding
          const beforeEnd = lines[i].substring(0, sel.endCol);
          selEndX = ox + textPadding + (beforeEnd.length > 0
            ? await this.measureText(surfaceId, beforeEnd, taFont)
            : 0);
        }
        // Middle lines: full width (selStartX and selEndX already set)

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

      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: lineTextY,
          text: lines[i],
          font: taFont,
          fill: style.color ?? this.theme.textSecondary,
          baseline: 'alphabetic',
        },
      });
    }

    // Cursor when focused
    if (focused) {
      const cursorLine = this.cursorLine;
      const cursorCol = this.cursorCol;
      if (cursorLine >= scrollTop && cursorLine < scrollTop + visibleLines) {
        const cursorLineText = lines[cursorLine]?.substring(0, cursorCol) ?? '';
        const cursorX = ox + textPadding + (cursorLineText.length > 0
          ? await this.measureText(surfaceId, cursorLineText, taFont)
          : 0);
        const cursorY = oy + (cursorLine - scrollTop) * lineHeight + 2;
        commands.push({
          type: 'line',
          surfaceId,
          params: {
            x1: cursorX, y1: cursorY,
            x2: cursorX, y2: cursorY + lineHeight - 4,
            stroke: this.theme.cursor,
          },
        });
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    // Close disabled alpha save
    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    return commands;
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

    if (type === 'wheel') {
      return this.handleWheel(input);
    }

    if (type === 'paste') {
      return this.handlePaste(input);
    }

    return { consumed: false };
  }

  private async posFromClick(clickX: number, clickY: number, surfaceId: string | undefined): Promise<{ line: number; col: number }> {
    const textPadding = 8;
    const lineHeight = this.lineHeight;
    const scrollTop = this.scrollTop;
    const lines = this.text.split('\n');

    const clickLine = Math.max(0, Math.min(
      scrollTop + Math.floor(clickY / lineHeight),
      lines.length - 1,
    ));
    const lineText = lines[clickLine] ?? '';
    const clickOffset = clickX - textPadding;

    let clickCol = 0;
    if (lineText.length > 0 && clickOffset > 0 && surfaceId) {
      const taFont = this.monospace
        ? CODE_FONT
        : (this.style.fontSize ? buildFont(this.style) : WIDGET_FONT);
      const lineWidth = await this.measureText(surfaceId, lineText, taFont);
      const avgCharWidth = lineWidth / lineText.length;
      clickCol = Math.min(Math.round(clickOffset / avgCharWidth), lineText.length);
    }

    return { line: clickLine, col: Math.max(0, clickCol) };
  }

  private wordBoundaries(lineText: string, col: number): { start: number; end: number } {
    const isWordChar = (ch: string) => /\w/.test(ch);
    let start = col;
    let end = col;
    if (col < lineText.length && isWordChar(lineText[col])) {
      while (start > 0 && isWordChar(lineText[start - 1])) start--;
      while (end < lineText.length && isWordChar(lineText[end])) end++;
    } else {
      while (start > 0 && !isWordChar(lineText[start - 1]) && lineText[start - 1] !== ' ') start--;
      while (end < lineText.length && !isWordChar(lineText[end]) && lineText[end] !== ' ') end++;
    }
    return { start, end };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const surfaceId = (input.surfaceId as string | undefined) ?? this.lastSurfaceId;
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;

    const { line: targetLine, col: targetCol } = await this.posFromClick(clickX, clickY, surfaceId);

    const now = Date.now();
    const isDoubleClick = (now - this.lastClickTime) < 400
      && targetLine === this.lastClickLine
      && Math.abs(targetCol - this.lastClickCol) <= 1;
    this.lastClickTime = now;
    this.lastClickLine = targetLine;
    this.lastClickCol = targetCol;

    if (isDoubleClick) {
      const lines = this.text.split('\n');
      const lineText = lines[targetLine] ?? '';
      const { start, end } = this.wordBoundaries(lineText, targetCol);
      this.selAnchorLine = targetLine;
      this.selAnchorCol = start;
      this.cursorLine = targetLine;
      this.cursorCol = end;
      this.dragging = false;
      await this.notifySelectionChanged();
    } else if (modifiers?.shift) {
      if (this.selAnchorLine === null) {
        this.selAnchorLine = this.cursorLine;
        this.selAnchorCol = this.cursorCol;
      }
      this.cursorLine = targetLine;
      this.cursorCol = targetCol;
      await this.notifySelectionChanged();
    } else {
      this.clearSelection();
      this.cursorLine = targetLine;
      this.cursorCol = targetCol;
      this.selAnchorLine = targetLine;
      this.selAnchorCol = targetCol;
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

    const { line, col } = await this.posFromClick(clickX, clickY, surfaceId);
    this.cursorLine = line;
    this.cursorCol = col;
    await this.notifySelectionChanged();
    await this.requestRedraw();
    return { consumed: true };
  }

  private async handleMouseUp(): Promise<{ consumed: boolean }> {
    if (this.dragging) {
      this.dragging = false;
      if (this.selAnchorLine === this.cursorLine && this.selAnchorCol === this.cursorCol) {
        this.clearSelection();
        await this.notifySelectionChanged();
      }
    }
    return { consumed: true };
  }

  private async handleKeyDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const key = (input.key as string) ?? '';
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;
    const lines = this.text.split('\n');
    let line = this.cursorLine;
    let col = this.cursorCol;
    const lineHeight = this.lineHeight;
    const h = this.rect.height;
    const visibleLines = Math.floor(h / lineHeight);
    const shift = modifiers?.shift ?? false;
    const ctrl = modifiers?.ctrl ?? false;
    const meta = modifiers?.meta ?? false;

    const autoScroll = () => {
      let scrollTop = this.scrollTop;
      if (line < scrollTop) scrollTop = line;
      if (line >= scrollTop + visibleLines) scrollTop = line - visibleLines + 1;
      this.scrollTop = scrollTop;
    };

    // Ctrl+A / Meta+A: select all
    if (key === 'a' && (ctrl || meta)) {
      this.selAnchorLine = 0;
      this.selAnchorCol = 0;
      this.cursorLine = lines.length - 1;
      this.cursorCol = lines[lines.length - 1].length;
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
        line = this.cursorLine;
        col = this.cursorCol;
        autoScroll();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Backspace') {
      if (this.getSelection()) {
        this.deleteSelection();
        line = this.cursorLine;
        col = this.cursorCol;
      } else if (col > 0) {
        lines[line] = lines[line].substring(0, col - 1) + lines[line].substring(col);
        col--;
        this.text = lines.join('\n');
        this.cursorLine = line;
        this.cursorCol = col;
      } else if (line > 0) {
        col = lines[line - 1].length;
        lines[line - 1] += lines[line];
        lines.splice(line, 1);
        line--;
        this.text = lines.join('\n');
        this.cursorLine = line;
        this.cursorCol = col;
      }
      autoScroll();
      this.changed('change', this.text);
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Delete') {
      if (this.getSelection()) {
        this.deleteSelection();
        line = this.cursorLine;
        col = this.cursorCol;
      } else if (col < lines[line].length) {
        lines[line] = lines[line].substring(0, col) + lines[line].substring(col + 1);
        this.text = lines.join('\n');
        this.cursorLine = line;
        this.cursorCol = col;
      } else if (line < lines.length - 1) {
        lines[line] += lines[line + 1];
        lines.splice(line + 1, 1);
        this.text = lines.join('\n');
        this.cursorLine = line;
        this.cursorCol = col;
      }
      this.changed('change', this.text);
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Enter') {
      if (this.getSelection()) {
        this.deleteSelection();
        // Re-split after deletion
        const newLines = this.text.split('\n');
        line = this.cursorLine;
        col = this.cursorCol;
        const before = newLines[line].substring(0, col);
        const after = newLines[line].substring(col);
        newLines[line] = before;
        newLines.splice(line + 1, 0, after);
        line++;
        col = 0;
        this.text = newLines.join('\n');
      } else {
        const before = lines[line].substring(0, col);
        const after = lines[line].substring(col);
        lines[line] = before;
        lines.splice(line + 1, 0, after);
        line++;
        col = 0;
        this.text = lines.join('\n');
      }
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      this.changed('change', this.text);
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Tab') {
      if (this.getSelection()) {
        this.replaceSelection('  ');
      } else {
        const indent = '  ';
        lines[line] = lines[line].substring(0, col) + indent + lines[line].substring(col);
        col += indent.length;
        this.text = lines.join('\n');
        this.cursorCol = col;
      }
      this.changed('change', this.text);
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowLeft') {
      if (shift) {
        if (this.selAnchorLine === null) {
          this.selAnchorLine = line;
          this.selAnchorCol = col;
        }
        if (col > 0) {
          col--;
        } else if (line > 0) {
          line--;
          col = lines[line].length;
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
        await this.notifySelectionChanged();
      } else if (this.getSelection()) {
        const sel = this.getSelection()!;
        line = sel.startLine;
        col = sel.startCol;
        this.cursorLine = line;
        this.cursorCol = col;
        this.clearSelection();
        autoScroll();
        await this.notifySelectionChanged();
      } else {
        if (col > 0) {
          col--;
        } else if (line > 0) {
          line--;
          col = lines[line].length;
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowRight') {
      if (shift) {
        if (this.selAnchorLine === null) {
          this.selAnchorLine = line;
          this.selAnchorCol = col;
        }
        if (col < lines[line].length) {
          col++;
        } else if (line < lines.length - 1) {
          line++;
          col = 0;
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
        await this.notifySelectionChanged();
      } else if (this.getSelection()) {
        const sel = this.getSelection()!;
        line = sel.endLine;
        col = sel.endCol;
        this.cursorLine = line;
        this.cursorCol = col;
        this.clearSelection();
        autoScroll();
        await this.notifySelectionChanged();
      } else {
        if (col < lines[line].length) {
          col++;
        } else if (line < lines.length - 1) {
          line++;
          col = 0;
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowUp') {
      if (shift) {
        if (this.selAnchorLine === null) {
          this.selAnchorLine = line;
          this.selAnchorCol = col;
        }
        if (line > 0) {
          line--;
          col = Math.min(col, lines[line].length);
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
        await this.notifySelectionChanged();
      } else if (this.getSelection()) {
        const sel = this.getSelection()!;
        line = sel.startLine;
        col = sel.startCol;
        this.cursorLine = line;
        this.cursorCol = col;
        this.clearSelection();
        autoScroll();
        await this.notifySelectionChanged();
      } else {
        if (line > 0) {
          line--;
          col = Math.min(col, lines[line].length);
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowDown') {
      if (shift) {
        if (this.selAnchorLine === null) {
          this.selAnchorLine = line;
          this.selAnchorCol = col;
        }
        if (line < lines.length - 1) {
          line++;
          col = Math.min(col, lines[line].length);
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
        await this.notifySelectionChanged();
      } else if (this.getSelection()) {
        const sel = this.getSelection()!;
        line = sel.endLine;
        col = sel.endCol;
        this.cursorLine = line;
        this.cursorCol = col;
        this.clearSelection();
        autoScroll();
        await this.notifySelectionChanged();
      } else {
        if (line < lines.length - 1) {
          line++;
          col = Math.min(col, lines[line].length);
        }
        this.cursorLine = line;
        this.cursorCol = col;
        autoScroll();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Home') {
      if (shift) {
        if (this.selAnchorLine === null) {
          this.selAnchorLine = line;
          this.selAnchorCol = col;
        }
        this.cursorCol = 0;
        await this.notifySelectionChanged();
      } else {
        this.clearSelection();
        this.cursorCol = 0;
        await this.notifySelectionChanged();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'End') {
      if (shift) {
        if (this.selAnchorLine === null) {
          this.selAnchorLine = line;
          this.selAnchorCol = col;
        }
        this.cursorCol = lines[line].length;
        await this.notifySelectionChanged();
      } else {
        this.clearSelection();
        this.cursorCol = lines[line].length;
        await this.notifySelectionChanged();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    // Printable character
    if (key.length === 1 && !ctrl && !meta) {
      if (this.getSelection()) {
        this.replaceSelection(key);
        line = this.cursorLine;
        col = this.cursorCol;
      } else {
        lines[line] = lines[line].substring(0, col) + key + lines[line].substring(col);
        col++;
        this.text = lines.join('\n');
        this.cursorLine = line;
        this.cursorCol = col;
      }
      autoScroll();
      this.changed('change', this.text);
      await this.notifySelectionChanged();
      await this.requestRedraw();
      return { consumed: true };
    }

    return { consumed: true };
  }

  private async handleWheel(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const deltaY = (input.deltaY as number) ?? 0;
    const lineHeight = this.lineHeight;
    const totalLines = this.text.split('\n').length;
    const visibleLines = Math.floor(this.rect.height / lineHeight);
    const maxScroll = Math.max(0, totalLines - visibleLines);

    let scrollTop = this.scrollTop;
    scrollTop += Math.sign(deltaY);
    scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
    this.scrollTop = scrollTop;

    await this.requestRedraw();
    return { consumed: true };
  }

  private async handlePaste(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (this.disabled) return { consumed: true };
    const pasteText = (input.pasteText as string) ?? '';
    if (!pasteText) return { consumed: true };

    const lineHeight = this.lineHeight;
    const visibleLines = Math.floor(this.rect.height / lineHeight);

    if (this.getSelection()) {
      this.replaceSelection(pasteText);
    } else {
      const lines = this.text.split('\n');
      let line = this.cursorLine;
      let col = this.cursorCol;
      const before = lines[line].substring(0, col);
      const after = lines[line].substring(col);
      const pasteLines = pasteText.split('\n');

      if (pasteLines.length === 1) {
        lines[line] = before + pasteLines[0] + after;
        col += pasteLines[0].length;
      } else {
        lines[line] = before + pasteLines[0];
        for (let i = 1; i < pasteLines.length - 1; i++) {
          lines.splice(line + i, 0, pasteLines[i]);
        }
        const lastPasteLine = pasteLines[pasteLines.length - 1];
        lines.splice(line + pasteLines.length - 1, 0, lastPasteLine + after);
        line += pasteLines.length - 1;
        col = lastPasteLine.length;
      }

      this.text = lines.join('\n');
      this.cursorLine = line;
      this.cursorCol = col;
    }

    const line = this.cursorLine;
    let scrollTop = this.scrollTop;
    if (line >= scrollTop + visibleLines) scrollTop = line - visibleLines + 1;
    this.scrollTop = scrollTop;

    this.changed('change', this.text);
    await this.notifySelectionChanged();
    await this.requestRedraw();
    return { consumed: true };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.monospace !== undefined) this.monospace = updates.monospace as boolean;
    // When text is set externally, reset cursor to start and clear selection
    if (updates.text !== undefined) {
      this.cursorLine = 0;
      this.cursorCol = 0;
      this.selAnchorLine = null;
      this.selAnchorCol = null;
    }
  }
}
