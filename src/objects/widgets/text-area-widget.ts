/**
 * TextAreaWidget -- multi-line text editor with scrolling, cursor navigation, and paste.
 *
 * Renders a bordered text area with line-by-line display, vertical scrolling,
 * and a blinking cursor. Supports multi-line editing with Enter to split lines,
 * Backspace/Delete across line boundaries, arrow-key navigation between lines,
 * Tab-to-indent (consumed, does NOT bubble), mouse wheel scrolling, and
 * multi-line paste.
 */

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

  constructor(config: TextAreaWidgetConfig) {
    super(config);
    this.monospace = config.monospace ?? false;
    this.lineHeight = DEFAULT_LINE_HEIGHT;
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? 4;
    const focused = this.focused;
    const lineHeight = this.lineHeight;
    const taFont = this.monospace ? CODE_FONT : (style.fontSize ? font : WIDGET_FONT);

    // Border rect
    const borderColor = style.borderColor ?? (focused ? '#6a6aff' : '#555');
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: style.background ?? '#151520',
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

    // Render visible lines
    for (let i = scrollTop; i < Math.min(lines.length, scrollTop + visibleLines); i++) {
      const lineY = oy + (i - scrollTop) * lineHeight + lineHeight * 0.7;
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: lineY,
          text: lines[i],
          font: taFont,
          fill: style.color ?? '#ddd',
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
            stroke: '#8888ff',
          },
        });
      }
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

    if (type === 'wheel') {
      return this.handleWheel(input);
    }

    if (type === 'paste') {
      return this.handlePaste(input);
    }

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const surfaceId = input.surfaceId as string | undefined;
    const textPadding = 8;
    const lineHeight = this.lineHeight;
    const scrollTop = this.scrollTop;
    const lines = this.text.split('\n');

    // Determine clicked line
    const clickLine = Math.min(
      scrollTop + Math.floor(clickY / lineHeight),
      lines.length - 1,
    );
    const lineText = lines[clickLine] ?? '';
    const clickOffset = clickX - textPadding;

    // Determine clicked column
    let clickCol = 0;
    if (lineText.length > 0 && clickOffset > 0 && surfaceId) {
      const taFont = this.monospace
        ? CODE_FONT
        : (this.style.fontSize ? buildFont(this.style) : WIDGET_FONT);
      const lineWidth = await this.measureText(surfaceId, lineText, taFont);
      const avgCharWidth = lineWidth / lineText.length;
      clickCol = Math.min(
        Math.round(clickOffset / avgCharWidth),
        lineText.length,
      );
    }

    this.cursorLine = Math.max(0, clickLine);
    this.cursorCol = Math.max(0, clickCol);

    await this.requestRedraw();
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

    const autoScroll = () => {
      let scrollTop = this.scrollTop;
      if (line < scrollTop) scrollTop = line;
      if (line >= scrollTop + visibleLines) scrollTop = line - visibleLines + 1;
      this.scrollTop = scrollTop;
    };

    if (key === 'Backspace') {
      if (col > 0) {
        lines[line] = lines[line].substring(0, col - 1) + lines[line].substring(col);
        col--;
      } else if (line > 0) {
        col = lines[line - 1].length;
        lines[line - 1] += lines[line];
        lines.splice(line, 1);
        line--;
      }
      this.text = lines.join('\n');
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      this.changed('change', this.text);
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Delete') {
      if (col < lines[line].length) {
        lines[line] = lines[line].substring(0, col) + lines[line].substring(col + 1);
      } else if (line < lines.length - 1) {
        lines[line] += lines[line + 1];
        lines.splice(line + 1, 1);
      }
      this.text = lines.join('\n');
      this.cursorLine = line;
      this.cursorCol = col;
      this.changed('change', this.text);
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Enter') {
      const before = lines[line].substring(0, col);
      const after = lines[line].substring(col);
      lines[line] = before;
      lines.splice(line + 1, 0, after);
      line++;
      col = 0;
      this.text = lines.join('\n');
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      this.changed('change', this.text);
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Tab') {
      // Insert 2-space indent -- consumed (does NOT bubble for focus advance)
      const indent = '  ';
      lines[line] = lines[line].substring(0, col) + indent + lines[line].substring(col);
      col += indent.length;
      this.text = lines.join('\n');
      this.cursorCol = col;
      this.changed('change', this.text);
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowLeft') {
      if (col > 0) {
        col--;
      } else if (line > 0) {
        line--;
        col = lines[line].length;
      }
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowRight') {
      if (col < lines[line].length) {
        col++;
      } else if (line < lines.length - 1) {
        line++;
        col = 0;
      }
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowUp') {
      if (line > 0) {
        line--;
        col = Math.min(col, lines[line].length);
      }
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowDown') {
      if (line < lines.length - 1) {
        line++;
        col = Math.min(col, lines[line].length);
      }
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Home') {
      this.cursorCol = 0;
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'End') {
      this.cursorCol = lines[line].length;
      await this.requestRedraw();
      return { consumed: true };
    }

    // Printable character
    if (key.length === 1 && !modifiers?.ctrl && !modifiers?.meta) {
      lines[line] = lines[line].substring(0, col) + key + lines[line].substring(col);
      col++;
      this.text = lines.join('\n');
      this.cursorLine = line;
      this.cursorCol = col;
      autoScroll();
      this.changed('change', this.text);
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
    const pasteText = (input.pasteText as string) ?? '';
    if (!pasteText) return { consumed: true };

    const lines = this.text.split('\n');
    let line = this.cursorLine;
    let col = this.cursorCol;
    const lineHeight = this.lineHeight;
    const visibleLines = Math.floor(this.rect.height / lineHeight);

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

    let scrollTop = this.scrollTop;
    if (line >= scrollTop + visibleLines) scrollTop = line - visibleLines + 1;
    this.scrollTop = scrollTop;

    this.changed('change', this.text);
    await this.requestRedraw();
    return { consumed: true };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.monospace !== undefined) this.monospace = updates.monospace as boolean;
    // When text is set externally, reset cursor to start
    if (updates.text !== undefined) {
      this.cursorLine = 0;
      this.cursorCol = 0;
    }
  }
}
