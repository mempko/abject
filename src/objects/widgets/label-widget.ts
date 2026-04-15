/**
 * LabelWidget — a text label with optional read-only text selection.
 *
 * Renders text with optional background and configurable alignment.
 * When style.wordWrap is true, text is wrapped to fit the widget width
 * and rendered as multiple lines. Emits 'click' to dependents on mousedown
 * (useful for clickable lists, cards, and interactive label grids).
 * When href is set, renders with theme link color and underline; clicking
 * opens the URL in the user's browser (via the base class openUrl protocol).
 * When style.selectable is true, additionally enables click-drag, double-click
 * word select, Shift+click, Ctrl+A, and Ctrl+C for read-only selection.
 * When style.markdown is true, parses text as markdown and renders with
 * rich formatting (bold, italic, code, headings, bullets, blockquotes).
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { wrapText } from './word-wrap.js';
import { event } from '../../core/message.js';
import { parseMarkdown } from './markdown.js';
import { layoutRichText, type RichTextLayout, type StyledRun } from './rich-text-layout.js';

export class LabelWidget extends WidgetAbject {
  // Word-wrap cache
  private cachedWrappedLines: string[] | null = null;
  private cachedWrapText: string = '';
  private cachedWrapWidth: number = 0;
  private cachedWrapFontSize: number | undefined = undefined;

  // Markdown layout cache
  private cachedRichLayout: RichTextLayout | null = null;
  private cachedRichText: string = '';
  private cachedRichWidth: number = 0;
  private cachedRichFontSize: number | undefined = undefined;

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
    this.send(event(
      this.id, this.uiServerId,
      'selectionChanged',
      { selectedText },
    ));
  }

  /**
   * Convert a click's pixel coordinates to a character offset in this.text.
   * For word-wrapped text, walks through wrapped lines to find the right position.
   * For markdown text, walks through the rich layout's runs to find the source offset.
   */
  private async posFromClick(clickX: number, clickY: number, surfaceId: string, ox: number, oy: number): Promise<number> {
    const font = buildFont(this.style);
    const textPadding = 4;

    // Markdown mode: use cached rich layout to map click to source offset
    if (this.style.markdown && this.cachedRichLayout) {
      return this.posFromClickMarkdown(clickX, clickY, surfaceId, ox, oy);
    }

    if (this.style.wordWrap && this.rect.width > 0) {
      const fontSize = this.style.fontSize ?? 14;
      const lineHeight = fontSize + 4;
      const lines = await this.getWrappedLines(surfaceId, font, this.text, this.rect.width, fontSize);
      // Mirror the vertical-centering offset applied in buildDrawCommands so
      // clicks land on the right line.
      const totalTextHeight = lines.length * lineHeight;
      const yShift = Math.max(0, Math.floor((this.rect.height - totalTextHeight) / 2));
      const lineIndex = Math.max(0, Math.min(Math.floor((clickY - oy - yShift) / lineHeight), lines.length - 1));

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
   * Map click coordinates to a source text offset using the markdown layout.
   */
  private async posFromClickMarkdown(clickX: number, clickY: number, surfaceId: string, ox: number, oy: number): Promise<number> {
    const layout = this.cachedRichLayout!;
    const textPadding = 4;

    // Mirror the vertical-centering offset applied in buildMarkdownDrawCommands.
    const yShift = Math.max(0, Math.floor((this.rect.height - layout.totalHeight) / 2));
    const localY = clickY - oy - yShift;

    // Find the clicked line
    let targetLine = layout.lines[layout.lines.length - 1]; // default to last
    for (const line of layout.lines) {
      if (localY < line.y + line.height) {
        targetLine = line;
        break;
      }
    }

    // Walk runs to find the clicked run and character offset within it
    let runX = textPadding + targetLine.indent;
    for (const run of targetLine.runs) {
      if (run.text.length === 0) continue;
      if (clickX - ox < runX + run.width || run === targetLine.runs[targetLine.runs.length - 1]) {
        // Click is within this run (or past the last run)
        const localX = clickX - ox - runX;
        const col = await this.colFromX(Math.max(0, localX), run.text, surfaceId, run.font);
        return Math.min(run.sourceStart + col, run.sourceEnd);
      }
      runX += run.width;
    }

    // Fallback: end of text
    return this.text.length;
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

  private async getWrappedLines(surfaceId: string, font: string, text: string, width: number, fontSize: number): Promise<string[]> {
    const textPadding = 4;
    const maxWidth = width - textPadding * 2;

    if (
      this.cachedWrappedLines === null ||
      this.cachedWrapText !== text ||
      this.cachedWrapWidth !== maxWidth ||
      this.cachedWrapFontSize !== fontSize
    ) {
      const measureFn = (t: string) => this.measureText(surfaceId, t, font);
      this.cachedWrappedLines = await wrapText(text, maxWidth, measureFn);
      this.cachedWrapText = text;
      this.cachedWrapWidth = maxWidth;
      this.cachedWrapFontSize = fontSize;
    }
    return this.cachedWrappedLines;
  }

  // ── Markdown layout ─────────────────────────────────────────────────

  private async getRichLayout(surfaceId: string, text: string, width: number, fontSize: number, fill: string): Promise<RichTextLayout> {
    const textPadding = 4;
    const maxWidth = width - textPadding * 2;

    if (
      this.cachedRichLayout === null ||
      this.cachedRichText !== text ||
      this.cachedRichWidth !== maxWidth ||
      this.cachedRichFontSize !== fontSize
    ) {
      const parsed = parseMarkdown(text);
      const measureFn = (t: string, font: string) => this.measureText(surfaceId, t, font);
      this.cachedRichLayout = await layoutRichText(parsed, maxWidth, measureFn, this.theme, fontSize, fill);
      this.cachedRichText = text;
      this.cachedRichWidth = maxWidth;
      this.cachedRichFontSize = fontSize;
    }
    return this.cachedRichLayout;
  }

  /**
   * Build draw commands for markdown-rendered text.
   */
  private async buildMarkdownDrawCommands(
    surfaceId: string, ox: number, oy: number, w: number, h: number, fill: string,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const style = this._renderStyle;
    const text = this._renderText;
    const fontSize = style.fontSize ?? 14;
    const textPadding = 4;

    const layout = await this.getRichLayout(surfaceId, text, w, fontSize, fill);
    const sel = this.style.selectable && this.focused ? this.getSelection() : null;

    // Clip to prevent overflow
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({ type: 'clip', surfaceId, params: { x: ox, y: oy, width: w, height: h } });

    // Vertically center the text block within the label rect when the rect
    // has extra height (e.g., bubble-style labels with surrounding padding).
    const yShift = Math.max(0, Math.floor((h - layout.totalHeight) / 2));

    for (const line of layout.lines) {
      const lineTop = oy + yShift + line.y;
      const textY = lineTop + line.height * 0.7;
      if (lineTop > oy + h) break; // past bottom edge

      // Code block background
      if (line.codeBackground) {
        commands.push({
          type: 'rect', surfaceId,
          params: { x: ox, y: lineTop, width: w, height: line.height, fill: this.theme.inputBg },
        });
      }

      // Blockquote left border
      if (line.quoteBorder) {
        commands.push({
          type: 'line', surfaceId,
          params: {
            x1: ox + 4, y1: lineTop,
            x2: ox + 4, y2: lineTop + line.height,
            stroke: this.theme.accentSecondary, lineWidth: 2,
          },
        });
      }

      // Selection highlights for this line (drawn before text so text renders on top)
      if (sel) {
        let selRunX = ox + textPadding + line.indent;
        for (const run of line.runs) {
          if (run.text.length === 0) continue;
          // Check if this run overlaps the selection (source offsets)
          const overlapStart = Math.max(sel.start, run.sourceStart);
          const overlapEnd = Math.min(sel.end, run.sourceEnd);
          if (overlapStart < overlapEnd) {
            // Partial or full overlap — compute pixel bounds
            const runTextLen = run.sourceEnd - run.sourceStart;
            const charStart = overlapStart - run.sourceStart;
            const charEnd = overlapEnd - run.sourceStart;
            // Map character offsets to display text offsets (clamped to run.text length)
            const dispStart = Math.min(charStart, run.text.length);
            const dispEnd = Math.min(charEnd, run.text.length);

            let hlX = selRunX;
            let hlW = run.width;
            if (dispStart > 0) {
              const beforeW = await this.measureText(surfaceId, run.text.substring(0, dispStart), run.font);
              hlX = selRunX + beforeW;
            }
            if (dispEnd < run.text.length) {
              const selectedW = await this.measureText(surfaceId, run.text.substring(dispStart, dispEnd), run.font);
              hlW = selectedW;
            } else {
              hlW = (selRunX + run.width) - hlX;
            }

            if (hlW > 0) {
              commands.push({
                type: 'rect', surfaceId,
                params: {
                  x: hlX, y: lineTop,
                  width: hlW, height: line.height,
                  fill: this.theme.selectionBg,
                },
              });
            }
          }
          selRunX += run.width;
        }
      }

      // Render each styled run
      let runX = ox + textPadding + line.indent;
      for (const run of line.runs) {
        if (run.text.length === 0) continue;

        // Inline code background (not for code-block/table lines which already have their own styling)
        if (!line.codeBackground && line.blockType !== 'table' && run.fill === this.theme.accent && run.font.includes('Mono')) {
          const codePadH = 2;
          const codePadV = 1;
          commands.push({
            type: 'rect', surfaceId,
            params: {
              x: runX - codePadH, y: lineTop + codePadV,
              width: run.width + codePadH * 2, height: line.height - codePadV * 2,
              fill: this.theme.inputBg, radius: 3,
            },
          });
        }

        commands.push({
          type: 'text', surfaceId,
          params: { x: runX, y: textY, text: run.text, font: run.font, fill: run.fill, baseline: 'alphabetic' },
        });

        // Link underline
        if (run.href) {
          commands.push({
            type: 'line', surfaceId,
            params: { x1: runX, y1: textY + 2, x2: runX + run.width, y2: textY + 2, stroke: run.fill, lineWidth: 1 },
          });
        }

        runX += run.width;
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });
    return commands;
  }

  // ── Draw commands ────────────────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    // Cache surfaceId so processInput can use it for measureText
    this.lastSurfaceId = surfaceId;

    // Use render-time snapshots for consistency across await points
    const text = this._renderText;
    const commands: unknown[] = [];
    const w = this._renderRect.width;
    const h = this._renderRect.height;
    const style = this._renderStyle;
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
    const isLink = !!this.href;
    const fill = isLink ? (style.color ?? this.theme.linkColor) : (style.color ?? this.theme.textPrimary);
    const sel = this.style.selectable ? this.getSelection() : null;

    // Markdown rendering path
    if (style.markdown && w > 0) {
      if (style.background) {
        // background already pushed above
      }
      const mdCommands = await this.buildMarkdownDrawCommands(surfaceId, ox, oy, w, h, fill);
      commands.push(...mdCommands);
      return commands;
    }

    if (style.wordWrap && w > 0) {
      // Multi-line word-wrap rendering
      const fontSize = style.fontSize ?? 14;
      const lineHeight = fontSize + 4;
      const textPadding = 4;

      const lines = await this.getWrappedLines(surfaceId, font, text, w, fontSize);

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

      // Vertically center the text block when the label rect has extra height
      // (so bubble-style labels with surrounding padding look balanced).
      const totalTextHeight = lines.length * lineHeight;
      const yShift = Math.max(0, Math.floor((h - totalTextHeight) / 2));

      for (let i = 0; i < lines.length; i++) {
        const lineY = oy + yShift + i * lineHeight;
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

        // Underline for link labels (word-wrapped)
        if (isLink && lines[i].length > 0) {
          const lineWidth = await this.measureText(surfaceId, lines[i], font);
          let lineX = textX;
          if (align === 'center') lineX -= lineWidth / 2;
          else if (align === 'right') lineX -= lineWidth;
          const underY = textY + 2;
          commands.push({
            type: 'line',
            surfaceId,
            params: { x1: lineX, y1: underY, x2: lineX + lineWidth, y2: underY, stroke: fill, lineWidth: 1 },
          });
        }
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

      // Underline for link labels
      if (isLink && text.length > 0) {
        const textWidth = await this.measureText(surfaceId, text, font);
        let lineX = textX;
        if (align === 'center') lineX -= textWidth / 2;
        else if (align === 'right') lineX -= textWidth;
        const lineY = oy + h / 2 + (style.fontSize ?? 14) * 0.35;
        commands.push({
          type: 'line',
          surfaceId,
          params: { x1: lineX, y1: lineY, x2: lineX + textWidth, y2: lineY, stroke: fill, lineWidth: 1 },
        });
      }
    }

    return commands;
  }

  // ── Markdown hit-testing ────────────────────────────────────────────

  /**
   * Find the styled run at the given click coordinates in the cached markdown layout.
   * Returns the run if found, or null.
   */
  private runAtClick(clickX: number, clickY: number): StyledRun | null {
    const layout = this.cachedRichLayout;
    if (!layout) return null;
    const textPadding = 4;

    // Account for the vertical-centering offset applied in buildMarkdownDrawCommands.
    const yShift = Math.max(0, Math.floor((this.rect.height - layout.totalHeight) / 2));
    const localY = clickY - yShift;

    for (const line of layout.lines) {
      if (localY < line.y || localY >= line.y + line.height) continue;
      let runX = textPadding + line.indent;
      for (const run of line.runs) {
        if (run.text.length === 0) continue;
        if (clickX >= runX && clickX < runX + run.width) {
          return run;
        }
        runX += run.width;
      }
      return null; // clicked on this line but past all runs
    }
    return null;
  }

  // ── Input handling ───────────────────────────────────────────────────

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.style.selectable) {
      // Emit click to dependents so Abjects that called addDependent
      // can react to label clicks (e.g. clickable contact card lists)
      if (input.type === 'mousedown') {
        this.changed('click', this.text);
        // Markdown inline link: open URL on click
        if (this.style.markdown && this.cachedRichLayout) {
          const x = input.x as number ?? 0;
          const y = input.y as number ?? 0;
          const run = this.runAtClick(x, y);
          if (run?.href) {
            this.send(event(this.id, this.uiServerId, 'openUrl', { url: run.href }));
            return { consumed: true };
          }
        }
      }
      return { consumed: false };
    }

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

        // Markdown inline link: open URL on single click
        if (this.style.markdown && this.cachedRichLayout) {
          const run = this.runAtClick(x, y);
          if (run?.href) {
            this.send(event(this.id, this.uiServerId, 'openUrl', { url: run.href }));
          }
        }
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
    // Invalidate wrap caches when text or style changes
    this.cachedWrappedLines = null;
    this.cachedRichLayout = null;
    // Clear selection when text changes
    this.cursorPos = 0;
    this.selAnchor = null;
    this.dragging = false;
  }
}
