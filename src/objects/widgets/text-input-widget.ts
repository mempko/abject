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
import type { AbjectMessage } from '../../core/types.js';
import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';
import { wrapText, estimateWrappedLineCount } from './word-wrap.js';
import { wordBoundaryLeft, wordBoundaryRight, EditHistory, type EditKind } from './text-edit-helpers.js';
import { parseMarkdown } from './markdown.js';
import { layoutRichText, type RichTextLayout } from './rich-text-layout.js';
import { renderRichTextCommands } from './markdown-render.js';

interface InputSnapshot {
  text: string;
  cursorPos: number;
  selAnchor: number | null;
}

export interface TextInputWidgetConfig extends WidgetConfig {
  placeholder?: string;
  masked?: boolean;
  wordWrap?: boolean;
  minLines?: number;
  maxLines?: number;
  /** Minimum height (px) the input reports in markdown auto-grow mode. */
  minHeight?: number;
}

export class TextInputWidget extends WidgetAbject {
  private cursorPos = 0;
  private placeholder?: string;
  private masked: boolean;
  private selAnchor: number | null = null;
  private dragging = false;
  private lastClickTime = 0;
  private lastClickPos = 0;
  private lastClickCount = 0; // 1=single, 2=double, 3=triple
  private lastSurfaceId = '';

  /** Undo/redo stack. Snapshots the entire visible state pre-edit. */
  private history = new EditHistory<InputSnapshot>();

  // Word-wrap fields
  private wordWrap: boolean;
  private minLines: number;
  private maxLines: number | undefined;
  /** Floor for markdown auto-grow, so the composer never shrinks below it. */
  private mdMinHeight: number;
  private cachedWrappedLines: string[] | null = null;
  private cachedWrapText = '';
  private cachedWrapWidth = 0;
  private cachedWrapFontSize: number | undefined;
  private lastEmittedLineCount = 1;
  private scrollOffset = 0;

  // ── Markdown mode (opt-in via style.markdown) ──────────────────────────
  // When on, the input renders its raw text as markdown (inline images +
  // formatting) while editing stays a 1D-cursor edit over the source string.
  // Image references (`![](abject://…)`) are treated as atomic cursor tokens.
  private cachedMdLayout: RichTextLayout | null = null;
  private cachedMdText = '';
  private cachedMdWidth = 0;
  private cachedMdFontSize: number | undefined;
  /** Source ranges of block image references, from the last layout pass. */
  private imageSpans: Array<{ start: number; end: number }> = [];
  private lastEmittedMdHeight = 0;

  constructor(config: TextInputWidgetConfig) {
    super(config);
    this.placeholder = config.placeholder;
    this.masked = config.masked ?? false;
    this.wordWrap = config.wordWrap ?? false;
    this.minLines = config.minLines ?? 1;
    this.maxLines = config.maxLines;
    this.mdMinHeight = config.minHeight ?? (this.minLines * DEFAULT_LINE_HEIGHT + 16);
    this.cursorPos = (config.text ?? '').length;

    // Generic image-accept seam: an image pasted/dropped while this input is
    // focused arrives here (the focused window forwards it). We store it in the
    // workspace FileSystem and insert a markdown reference at the cursor, then
    // notify the owner via an `attach` event so it can track the attachment.
    this.on('fileUploaded', async (msg: AbjectMessage) => {
      const { name, mimeType, base64 } = msg.payload as { name: string; mimeType: string; base64: string };
      await this.handleImageAttachment(name, mimeType ?? '', base64 ?? '');
      return true;
    });
  }

  /**
   * Insert a pasted/dropped image at the cursor as an inline `data:` URI
   * reference, and hand the raw bytes to the owner via an `attach` event.
   *
   * The widget renders the image inline with a `data:` URI (which needs no
   * FileSystem access — widgets can't reliably reach one), while the owner
   * stores the bytes and tracks the attachment for the LLM.
   */
  private async handleImageAttachment(name: string, mimeType: string, base64: string): Promise<void> {
    if (this.disabled || !mimeType.startsWith('image/') || !base64) return;

    const safeName = name || 'image';
    const dataUri = `data:${mimeType};base64,${base64}`;

    // Insert on its own line so it parses as a block image: a leading newline
    // when not already at line start, and a trailing newline to terminate it.
    const pos = this.cursorPos;
    const before = this.text.substring(0, pos);
    const after = this.text.substring(pos);
    const needLeadingNl = before.length > 0 && !before.endsWith('\n');
    const ref = `${needLeadingNl ? '\n' : ''}![${safeName}](${dataUri})\n`;

    this.recordEdit('paste');
    this.text = before + ref + after;
    this.cursorPos = (before + ref).length;
    this.selAnchor = null;
    this.invalidateWrapCache();

    // Hand the raw bytes to the owner (it stores them + tracks for the LLM).
    this.changed('attach', { name: safeName, mimeType, base64 });
    this.changed('change', this.text);
    await this.notifySelectionChanged();
    await this.requestRedraw();
  }

  protected override acceptsInputWhenDisabled(): boolean {
    return true;
  }

  /** Capture current state for the undo stack. */
  private snapshot(): InputSnapshot {
    return { text: this.text, cursorPos: this.cursorPos, selAnchor: this.selAnchor };
  }

  /** Apply a stored snapshot (undo/redo path). */
  private restoreSnapshot(s: InputSnapshot): void {
    this.text = s.text;
    this.cursorPos = s.cursorPos;
    this.selAnchor = s.selAnchor;
    this.invalidateWrapCache();
  }

  /** Push a pre-edit snapshot before mutating. Coalesces by `kind` (500 ms burst). */
  private recordEdit(kind: EditKind): void {
    this.history.push(this.snapshot(), kind);
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
    this.cachedMdLayout = null;
  }

  /** Markdown render mode: opt-in, and never for masked (password) inputs. */
  private isMarkdown(): boolean {
    return this.style.markdown === true && !this.masked;
  }

  /** Drop the markdown layout when an image resolves so real dims take effect. */
  protected override onImageResolved(): void {
    this.cachedMdLayout = null;
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
    if (this.isMarkdown()) {
      return this.buildMarkdownDrawCommands(surfaceId, ox, oy);
    }
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

  // ── Markdown rendering ─────────────────────────────────────────────

  private async getMdLayout(
    surfaceId: string, maxWidth: number, fontSize: number, fill: string,
  ): Promise<RichTextLayout> {
    if (
      this.cachedMdLayout === null ||
      this.cachedMdText !== this.text ||
      this.cachedMdWidth !== maxWidth ||
      this.cachedMdFontSize !== fontSize
    ) {
      const parsed = parseMarkdown(this.text);
      const measureFn = (t: string, font: string) => this.measureText(surfaceId, t, font);
      // Cap inline images to a thumbnail height: the composer is for composing,
      // not full-size viewing, and an uncapped image overflows the input.
      this.cachedMdLayout = await layoutRichText(
        parsed, maxWidth, measureFn, this.theme, fontSize, fill, this.imageResolver.resolveDims,
        TextInputWidget.MD_THUMB_HEIGHT,
      );
      this.cachedMdText = this.text;
      this.cachedMdWidth = maxWidth;
      this.cachedMdFontSize = fontSize;
      this.imageSpans = this.cachedMdLayout.lines
        .filter((l) => l.image)
        .map((l) => ({ start: l.image!.sourceStart, end: l.image!.sourceEnd }));
    }
    return this.cachedMdLayout;
  }

  /** Upper bound on composer growth so a tall image/long text can't eat the window. */
  private static readonly MD_MAX_HEIGHT = 360;
  /** Inline images in the composer render as thumbnails capped to this height. */
  private static readonly MD_THUMB_HEIGHT = 120;

  private checkAndEmitMdResize(totalHeight: number): void {
    const preferredHeight = Math.min(
      TextInputWidget.MD_MAX_HEIGHT,
      Math.max(
        this.mdMinHeight, // never shrink below the comfortable empty height
        Math.round(totalHeight) + 12, // top + bottom padding
      ),
    );
    if (Math.abs(preferredHeight - this.lastEmittedMdHeight) > 1) {
      this.lastEmittedMdHeight = preferredHeight;
      this.changed('resize', { preferredHeight });
    }
  }

  private async buildMarkdownDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    this.lastSurfaceId = surfaceId;
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const radius = style.radius ?? this.theme.widgetRadius;
    const focused = this.focused;
    const textPadding = 8;
    const fontSize = style.fontSize ?? 14;
    const fill = style.color ?? this.theme.textSecondary;

    // Border + optional focus glow (mirrors the single-line path).
    const borderColor = style.borderColor ?? (focused && !this.disabled ? this.theme.inputBorderFocus : this.theme.inputBorder);
    if (focused && !this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'shadow', surfaceId, params: { color: this.theme.inputBorderFocus, blur: 6 } });
      commands.push({
        type: 'rect', surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill: style.background ?? this.theme.inputBg, stroke: borderColor, radius },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    commands.push({
      type: 'rect', surfaceId,
      params: { x: ox, y: oy, width: w, height: h, fill: style.background ?? this.theme.inputBg, stroke: borderColor, radius },
    });

    // Clip to the input bounds.
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({ type: 'clip', surfaceId, params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 } });

    // Empty input: placeholder (when unfocused), and a cursor when focused.
    if (!this.text) {
      if (this.placeholder && !focused) {
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + textPadding, y: oy + h / 2, text: this.placeholder,
            font: style.fontSize ? buildFont(style) : WIDGET_FONT,
            fill: this.theme.textPlaceholder, baseline: 'middle',
          },
        });
      }
      if (focused) {
        commands.push({
          type: 'line', surfaceId,
          params: { x1: ox + textPadding, y1: oy + 4, x2: ox + textPadding, y2: oy + h - 4, stroke: this.theme.cursor },
        });
      }
      commands.push({ type: 'restore', surfaceId, params: {} });
      this.checkAndEmitMdResize(fontSize + 8);
      return commands;
    }

    const maxWidth = w - textPadding * 2;
    const layout = await this.getMdLayout(surfaceId, maxWidth, fontSize, fill);
    this.checkAndEmitMdResize(layout.totalHeight);

    const topPad = 6;
    const sel = (focused && !this.masked) ? this.getSelection() : null;

    const lineCommands = await renderRichTextCommands(layout, {
      surfaceId, ox, oy, width: w, height: h,
      theme: this.theme,
      drawableUrl: (u) => this.imageResolver.drawableUrl(u),
      yShift: topPad, textPadding,
      selection: sel,
      measure: (t, font) => this.measureText(surfaceId, t, font),
      inlineCodeBg: false,
      imagePlaceholder: true,
    });
    for (const c of lineCommands) commands.push(c);

    // Cursor.
    if (focused) {
      const cur = await this.cursorXYFromSource(layout, surfaceId, ox, oy, topPad, textPadding, this.cursorPos);
      if (cur) {
        commands.push({
          type: 'line', surfaceId,
          params: { x1: cur.x, y1: cur.top + 2, x2: cur.x, y2: cur.top + cur.height - 2, stroke: this.theme.cursor },
        });
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });
    return commands;
  }

  /** Source offset where the next line's content begins (Infinity if none). */
  private nextLineSourceStart(lines: RichTextLayout['lines'], from: number): number {
    for (let j = from + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.image) return ln.image.sourceStart;
      for (const run of ln.runs) {
        if (run.text.length > 0) return run.sourceStart;
      }
    }
    return Infinity;
  }

  /** Map a source offset to a cursor pixel position within the markdown layout. */
  private async cursorXYFromSource(
    layout: RichTextLayout, surfaceId: string, ox: number, oy: number,
    topPad: number, textPadding: number, pos: number,
  ): Promise<{ x: number; top: number; height: number } | null> {
    const lines = layout.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTop = oy + topPad + line.y;
      if (line.image) {
        if (pos <= line.image.sourceStart) {
          return { x: ox + textPadding + line.indent, top: lineTop, height: line.height };
        }
        if (pos <= line.image.sourceEnd) {
          return { x: ox + textPadding + line.indent + line.image.width, top: lineTop, height: line.height };
        }
        continue;
      }
      let runX = ox + textPadding + line.indent;
      let lastEnd = -1;
      for (const run of line.runs) {
        if (run.text.length === 0) { runX += run.width; continue; }
        if (pos >= run.sourceStart && pos <= run.sourceEnd) {
          const col = Math.min(pos - run.sourceStart, run.text.length);
          const before = col > 0 ? await this.measureText(surfaceId, run.text.substring(0, col), run.font) : 0;
          return { x: runX + before, top: lineTop, height: line.height };
        }
        runX += run.width;
        lastEnd = Math.max(lastEnd, run.sourceEnd);
      }
      // The cursor sits in this line's trailing region — characters the layout
      // trimmed off the visible run (e.g. a just-typed trailing space). Place
      // it at the line end plus the measured width of those trimmed chars so
      // the caret advances even though the space isn't painted.
      if (lastEnd >= 0 && pos > lastEnd && pos <= this.nextLineSourceStart(lines, i)) {
        const tail = this.text.substring(lastEnd, pos).replace(/\n/g, '');
        const font = line.runs.length ? line.runs[line.runs.length - 1].font
          : (this.style.fontSize ? buildFont(this.style) : WIDGET_FONT);
        const tw = tail.length > 0 ? await this.measureText(surfaceId, tail, font) : 0;
        return { x: runX + tw, top: lineTop, height: line.height };
      }
    }
    // Fall back to the end of the last line, plus any trailing trimmed chars.
    const last = lines[lines.length - 1];
    if (last) {
      const lineTop = oy + topPad + last.y;
      let runX = ox + textPadding + last.indent;
      let lastEnd = -1;
      if (last.image) {
        runX += last.image.width;
        lastEnd = last.image.sourceEnd;
      } else {
        for (const run of last.runs) { runX += run.width; lastEnd = Math.max(lastEnd, run.sourceEnd); }
      }
      if (lastEnd >= 0 && pos > lastEnd) {
        const tail = this.text.substring(lastEnd, pos).replace(/\n/g, '');
        const font = last.runs.length ? last.runs[last.runs.length - 1].font
          : (this.style.fontSize ? buildFont(this.style) : WIDGET_FONT);
        if (tail.length > 0) runX += await this.measureText(surfaceId, tail, font);
      }
      return { x: runX, top: lineTop, height: last.height };
    }
    return { x: ox + textPadding, top: oy + topPad, height: (this.style.fontSize ?? 14) + 4 };
  }

  /** Map a click to a source offset within the markdown layout. */
  private async posFromClickMarkdown(clickX: number, clickY: number, surfaceId: string): Promise<number> {
    const layout = this.cachedMdLayout;
    if (!layout) return this.cursorPos;
    const textPadding = 8;
    const topPad = 6;
    const localY = clickY - topPad;

    let targetLine = layout.lines[layout.lines.length - 1];
    for (const line of layout.lines) {
      if (localY < line.y + line.height) { targetLine = line; break; }
    }
    if (!targetLine) return this.text.length;

    if (targetLine.image) {
      // Atomic: snap to the near edge of the image reference.
      const mid = textPadding + targetLine.indent + targetLine.image.width / 2;
      return clickX < mid ? targetLine.image.sourceStart : targetLine.image.sourceEnd;
    }

    let runX = textPadding + targetLine.indent;
    for (const run of targetLine.runs) {
      if (run.text.length === 0) { runX += run.width; continue; }
      const isLast = run === targetLine.runs[targetLine.runs.length - 1];
      if (clickX < runX + run.width || isLast) {
        const localX = Math.max(0, clickX - runX);
        const col = await this.colFromX(localX, run.text, surfaceId, run.font);
        return Math.min(run.sourceStart + col, run.sourceEnd);
      }
      runX += run.width;
    }
    return this.text.length;
  }

  /** Binary-search the character column closest to a pixel X offset within a run. */
  private async colFromX(localX: number, lineText: string, surfaceId: string, font: string): Promise<number> {
    if (localX <= 0 || lineText.length === 0) return 0;
    const fullWidth = await this.measureText(surfaceId, lineText, font);
    if (localX >= fullWidth) return lineText.length;
    let lo = 0, hi = lineText.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const wmid = await this.measureText(surfaceId, lineText.substring(0, mid), font);
      if (wmid < localX) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) {
      const wPrev = await this.measureText(surfaceId, lineText.substring(0, lo - 1), font);
      const wCurr = await this.measureText(surfaceId, lineText.substring(0, lo), font);
      if (Math.abs(localX - wPrev) < Math.abs(localX - wCurr)) return lo - 1;
    }
    return lo;
  }

  // ── Atomic image-token helpers ─────────────────────────────────────────

  /** Snap a candidate offset out of any image reference it landed inside. */
  private adjustForImageSpans(target: number, from: number): number {
    for (const s of this.imageSpans) {
      if (target > s.start && target < s.end) {
        return target < from ? s.start : s.end;
      }
    }
    return target;
  }

  /** Image span the cursor would delete with Backspace at `pos` (start < pos <= end). */
  private imageSpanBefore(pos: number): { start: number; end: number } | null {
    for (const s of this.imageSpans) if (pos > s.start && pos <= s.end) return s;
    return null;
  }

  /** Image span the cursor would delete with Delete at `pos` (start <= pos < end). */
  private imageSpanAfter(pos: number): { start: number; end: number } | null {
    for (const s of this.imageSpans) if (pos >= s.start && pos < s.end) return s;
    return null;
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
    if (this.isMarkdown() && this.cachedMdLayout && surfaceId) {
      return this.posFromClickMarkdown(clickX, clickY, surfaceId);
    }

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

    // Multi-click tracking: same spot within 400 ms increments the count;
    // any other click resets to 1. Triple-click selects all (a single-line
    // input has no concept of "current line").
    const now = Date.now();
    const sameSpot = Math.abs(clickPos - this.lastClickPos) <= 1;
    if (sameSpot && (now - this.lastClickTime) < 400) {
      this.lastClickCount = Math.min(this.lastClickCount + 1, 3);
    } else {
      this.lastClickCount = 1;
    }
    this.lastClickTime = now;
    this.lastClickPos = clickPos;

    if (this.lastClickCount === 3) {
      this.selAnchor = 0;
      this.cursorPos = this.text.length;
      this.dragging = false;
      await this.notifySelectionChanged();
    } else if (this.lastClickCount === 2) {
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

    // Ctrl/Meta+Z = undo; Ctrl/Meta+Shift+Z or Ctrl+Y = redo. Both work
    // even when the widget is disabled because read-only widgets shouldn't
    // generally have anything in their history anyway.
    if ((ctrl || meta) && (key === 'z' || key === 'Z') && !shift) {
      const prev = this.history.undo(this.snapshot());
      if (prev) {
        this.restoreSnapshot(prev);
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if ((ctrl || meta) && ((key === 'z' || key === 'Z') && shift || key === 'y' || key === 'Y')) {
      const next = this.history.redo(this.snapshot());
      if (next) {
        this.restoreSnapshot(next);
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      }
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
        this.recordEdit('edit');
        this.deleteSelection();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Backspace') {
      if (this.getSelection()) {
        this.recordEdit('edit');
        this.deleteSelection();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      } else if (pos > 0) {
        // Markdown mode: Backspace adjacent to an image reference removes the
        // whole atomic token in one stroke.
        const imgSpan = this.isMarkdown() ? this.imageSpanBefore(pos) : null;
        if (imgSpan) {
          this.recordEdit('delete');
          this.text = this.text.substring(0, imgSpan.start) + this.text.substring(imgSpan.end);
          this.cursorPos = imgSpan.start;
          this.invalidateWrapCache();
          this.changed('change', this.text);
          await this.requestRedraw();
          return { consumed: true };
        }
        // Ctrl+Backspace (Alt+Backspace on macOS) deletes a word.
        const wordMod = ctrl || (modifiers?.alt ?? false);
        const target = wordMod ? wordBoundaryLeft(this.text, pos) : pos - 1;
        this.recordEdit('delete');
        this.text = this.text.substring(0, target) + this.text.substring(pos);
        this.cursorPos = target;
        this.invalidateWrapCache();
        this.changed('change', this.text);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Delete') {
      if (this.getSelection()) {
        this.recordEdit('edit');
        this.deleteSelection();
        this.changed('change', this.text);
        await this.notifySelectionChanged();
        await this.requestRedraw();
      } else if (pos < this.text.length) {
        // Markdown mode: Delete in front of an image reference removes the
        // whole atomic token.
        const imgSpan = this.isMarkdown() ? this.imageSpanAfter(pos) : null;
        if (imgSpan) {
          this.recordEdit('delete');
          this.text = this.text.substring(0, imgSpan.start) + this.text.substring(imgSpan.end);
          this.cursorPos = imgSpan.start;
          this.invalidateWrapCache();
          this.changed('change', this.text);
          await this.requestRedraw();
          return { consumed: true };
        }
        // Ctrl+Delete (Alt+Delete on macOS) deletes the next word.
        const wordMod = ctrl || (modifiers?.alt ?? false);
        const target = wordMod ? wordBoundaryRight(this.text, pos) : pos + 1;
        this.recordEdit('delete');
        this.text = this.text.substring(0, pos) + this.text.substring(target);
        this.invalidateWrapCache();
        this.changed('change', this.text);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'ArrowLeft') {
      // Ctrl/Alt+Left jumps a word; otherwise a single char.
      const wordMod = ctrl || (modifiers?.alt ?? false);
      let target = wordMod ? wordBoundaryLeft(this.text, pos) : Math.max(0, pos - 1);
      // Markdown mode: never land inside an image reference token.
      if (this.isMarkdown()) target = this.adjustForImageSpans(target, pos);
      if (shift) {
        if (this.selAnchor === null) this.selAnchor = pos;
        this.cursorPos = target;
        await this.notifySelectionChanged();
      } else if (this.getSelection() && !wordMod) {
        this.cursorPos = this.getSelection()!.start;
        this.clearSelection();
        await this.notifySelectionChanged();
      } else {
        this.cursorPos = target;
        if (this.selAnchor !== null) {
          this.clearSelection();
          await this.notifySelectionChanged();
        }
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowRight') {
      const wordMod = ctrl || (modifiers?.alt ?? false);
      let target = wordMod ? wordBoundaryRight(this.text, pos) : Math.min(this.text.length, pos + 1);
      if (this.isMarkdown()) target = this.adjustForImageSpans(target, pos);
      if (shift) {
        if (this.selAnchor === null) this.selAnchor = pos;
        this.cursorPos = target;
        await this.notifySelectionChanged();
      } else if (this.getSelection() && !wordMod) {
        this.cursorPos = this.getSelection()!.end;
        this.clearSelection();
        await this.notifySelectionChanged();
      } else {
        this.cursorPos = target;
        if (this.selAnchor !== null) {
          this.clearSelection();
          await this.notifySelectionChanged();
        }
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
      // Empty input: nothing to navigate. Let the key bubble so a container
      // (e.g. a chat transcript) can use it to scroll to the top.
      if (this.text.length === 0) return { consumed: false };
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
      // Empty input: nothing to navigate. Let the key bubble so a container
      // (e.g. a chat transcript) can use it to scroll to the bottom.
      if (this.text.length === 0) return { consumed: false };
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
      this.recordEdit('typing');
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

    // Escape: let it bubble so the parent Window (e.g. command palette,
    // notification card) can handle it as "dismiss".
    if (key === 'Escape') {
      return { consumed: false };
    }

    // Vertical arrows are meaningless in a single-line input — let them bubble
    // so a parent (e.g. the command palette) can drive list navigation while
    // the input keeps text focus. (Word-wrap inputs consumed them above.)
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      return { consumed: false };
    }

    return { consumed: true };
  }

  private async handlePaste(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (this.disabled) return { consumed: true };
    const pasteText = (input.pasteText as string) ?? '';
    if (!pasteText) return { consumed: true };

    this.recordEdit('paste');
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

  protected override suppressGenericFocusRing(): boolean {
    return true; // input paints its own focus glow + animated cursor
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
    // When text is set externally, reset cursor to end and clear selection.
    // Also drop the undo history — its snapshots reference the previous text
    // and would surprise the user if they undid into someone else's content.
    if (updates.text !== undefined) {
      this.cursorPos = this.text.length;
      this.selAnchor = null;
      this.invalidateWrapCache();
      this.scrollOffset = 0;
      this.history.clear();
    }
  }
}
