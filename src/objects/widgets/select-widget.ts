/**
 * SelectWidget -- dropdown selection widget with expandable option list.
 *
 * Renders a collapsed button-like element showing the selected option with a
 * down-arrow indicator. When clicked, expands to show a dropdown list of options
 * with hover highlighting. Selecting an option closes the dropdown and fires a
 * 'change' notification. Clicking outside the dropdown closes it without
 * consuming the event (allowing the click to propagate).
 *
 * Options can be plain strings or { label, value } objects. When using objects,
 * the label is displayed and the value is emitted on change. Plain strings are
 * used as both label and value.
 *
 * Long option lists scroll: the dropdown shows at most MAX_VISIBLE_OPTIONS
 * rows, scrollable via mouse wheel, and keyboard navigation keeps the
 * highlighted option in view. Lists longer than one page also get a filter
 * box at the top of the dropdown (like ListWidget's built-in search): typing
 * while the dropdown is open narrows the options, Enter picks the highlighted
 * match, Escape clears the filter before closing. Override with the
 * `searchable` config flag.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { fontStacks, inkFrame, squareMark } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';

export type SelectOption = string | { label: string; value: string };

export interface SelectWidgetConfig extends WidgetConfig {
  options?: SelectOption[];
  selectedIndex?: number;
  /** Filter box atop the dropdown. Defaults to on when options overflow one page. */
  searchable?: boolean;
}

/** Most option rows visible at once before the dropdown scrolls. */
const MAX_VISIBLE_OPTIONS = 8;
const SCROLLBAR_WIDTH = 6;
const SEARCH_HEIGHT = 30;

export class SelectWidget extends WidgetAbject {
  private labels: string[];
  private values: string[];
  private selectedIndex: number;
  private expanded = false;
  /** Index into filteredRows() of the highlighted option. */
  private hoveredRow?: number;
  /** Vertical scroll of the expanded dropdown's option list, in pixels. */
  private scrollOffset = 0;
  /** Explicit searchable override from config; undefined = auto by list length. */
  private searchableConfig?: boolean;
  private filterText = '';
  private filterCursor = 0;

  constructor(config: SelectWidgetConfig) {
    super(config);
    const { labels, values } = SelectWidget.normalizeOptions(config.options ?? []);
    this.labels = labels;
    this.values = values;
    this.selectedIndex = config.selectedIndex ?? 0;
    this.searchableConfig = config.searchable;
  }

  private static normalizeOptions(options: SelectOption[]): { labels: string[]; values: string[] } {
    const labels: string[] = [];
    const values: string[] = [];
    for (const opt of options) {
      if (typeof opt === 'string') {
        labels.push(opt);
        values.push(opt);
      } else {
        labels.push(opt.label);
        values.push(opt.value);
      }
    }
    return { labels, values };
  }

  // ── Dropdown geometry & filtering ─────────────────────────────────

  private isSearchable(): boolean {
    return this.searchableConfig ?? this.labels.length > MAX_VISIBLE_OPTIONS;
  }

  private searchHeight(): number {
    return this.isSearchable() ? SEARCH_HEIGHT : 0;
  }

  /** Original option indices matching the current filter, in display order. */
  private filteredRows(): number[] {
    if (!this.filterText) return this.labels.map((_, i) => i);
    const lower = this.filterText.toLowerCase();
    const rows: number[] = [];
    for (let i = 0; i < this.labels.length; i++) {
      if (this.labels[i].toLowerCase().includes(lower) ||
          this.values[i].toLowerCase().includes(lower)) {
        rows.push(i);
      }
    }
    return rows;
  }

  private visibleCount(rowCount: number): number {
    return Math.min(rowCount, MAX_VISIBLE_OPTIONS);
  }

  /** Pixel height of the option-list viewport (excludes the filter box). */
  private listHeight(rowCount: number): number {
    // An empty filter result still shows one row for the "No matches" notice
    return Math.max(1, this.visibleCount(rowCount)) * this.rect.height;
  }

  private maxScrollOffset(rowCount: number): number {
    return Math.max(0, (rowCount - this.visibleCount(rowCount)) * this.rect.height);
  }

  private clampScroll(rowCount: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset(rowCount)));
  }

  /** Adjust scrollOffset so the given row is fully inside the dropdown viewport. */
  private scrollRowIntoView(row: number, rowCount: number): void {
    const optionHeight = this.rect.height;
    const viewHeight = this.visibleCount(rowCount) * optionHeight;
    const top = row * optionHeight;
    if (top < this.scrollOffset) {
      this.scrollOffset = top;
    } else if (top + optionHeight > this.scrollOffset + viewHeight) {
      this.scrollOffset = top + optionHeight - viewHeight;
    }
    this.clampScroll(rowCount);
  }

  private openDropdown(): void {
    this.expanded = true;
    this.filterText = '';
    this.filterCursor = 0;
    this.scrollOffset = 0;
    // With an empty filter, row index === option index
    this.hoveredRow = this.selectedIndex >= 0 && this.selectedIndex < this.labels.length
      ? this.selectedIndex
      : undefined;
    if (this.hoveredRow !== undefined) {
      this.scrollRowIntoView(this.hoveredRow, this.labels.length);
    }
    this.changed('expanded', true);
  }

  private closeDropdown(): void {
    this.expanded = false;
    this.hoveredRow = undefined;
    this.filterText = '';
    this.filterCursor = 0;
    this.scrollOffset = 0;
    this.changed('expanded', false);
  }

  private selectOption(optionIndex: number): void {
    this.selectedIndex = optionIndex;
    this.changed('change', this.values[optionIndex]);
    this.closeDropdown();
  }

  /** Reset highlight and scroll after the filter text changes. */
  private onFilterChanged(): void {
    this.scrollOffset = 0;
    this.hoveredRow = this.filteredRows().length > 0 ? 0 : undefined;
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /**
   * A square paper field in an ink rule with a solid
   * triangle in a ruled arrow cell (inverted while open). The dropdown is a
   * square print block with a hard offset shadow; the hovered option is an
   * ink band with inverse text, and the chosen option carries a red square.
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const theme = this.theme;
    const shape = shapeOf(theme);
    const font = buildFont(style, theme);
    const radius = style.radius ?? 0;
    const labels = this.labels;
    const selectedIndex = this.selectedIndex;
    const selectedText = labels[selectedIndex] ?? '';
    const rule = shape.ruleWidth;
    const fieldBg = style.background ?? theme.selectBg;
    const frameColor = style.borderColor ?? theme.buttonBorder;
    const arrowW = 26;

    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    const field = { x: ox, y: oy, width: w, height: h };
    commands.push({ type: 'rect', surfaceId, params: { ...field, fill: fieldBg, radius } });

    // Arrow cell: ruled off on the left, inverted to an ink block while open.
    const cellX = ox + w - arrowW;
    if (this.expanded) {
      commands.push({ type: 'rect', surfaceId, params: { x: cellX, y: oy, width: arrowW, height: h, fill: theme.textPrimary } });
    } else {
      commands.push({ type: 'rect', surfaceId, params: { x: cellX, y: oy, width: rule, height: h, fill: frameColor } });
    }
    const acx = cellX + arrowW / 2 + rule / 2;
    const acy = oy + h / 2;
    commands.push({
      type: 'polygon', surfaceId,
      params: {
        points: this.expanded
          ? [{ x: acx - 5, y: acy + 3 }, { x: acx + 5, y: acy + 3 }, { x: acx, y: acy - 4 }]
          : [{ x: acx - 5, y: acy - 3 }, { x: acx + 5, y: acy - 3 }, { x: acx, y: acy + 4 }],
        fill: this.expanded ? theme.windowBg : theme.selectArrow,
        closePath: true,
      },
    });

    const focusFrame = this.focused && !this.disabled;
    commands.push(...inkFrame(surfaceId, field, focusFrame ? shape.blockFocusColor : frameColor, focusFrame ? Math.max(2, rule) : rule));

    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({ type: 'clip', surfaceId, params: { x: ox, y: oy, width: Math.max(0, w - arrowW), height: h } });
    commands.push({
      type: 'text', surfaceId,
      params: { x: ox + 8, y: oy + h / 2, text: selectedText, font, fill: style.color ?? theme.textPrimary, baseline: 'middle' },
    });
    commands.push({ type: 'restore', surfaceId, params: {} });

    if (this.expanded) {
      const optionHeight = h;
      const rows = this.filteredRows();
      const searchH = this.searchHeight();
      const listH = this.listHeight(rows.length);
      const dropdownH = searchH + listH;
      const dropTop = oy + h;
      const listTop = dropTop + searchH;
      const drop = { x: ox, y: dropTop, width: w, height: dropdownH };
      const shadowOffset = 4;

      // Hard print shadow, then the face and its ink rule.
      commands.push({
        type: 'rect', surfaceId,
        params: { x: ox + shadowOffset, y: dropTop + shadowOffset, width: w, height: dropdownH, fill: shape.blockShadowColor },
      });
      commands.push({ type: 'rect', surfaceId, params: { ...drop, fill: fieldBg } });

      if (searchH > 0) {
        const sx = ox + 4;
        const sy = dropTop + 3;
        const sw = w - 8;
        const sh = SEARCH_HEIGHT - 6;
        const filterFont = `12px ${fontStacks(theme).body}`;
        const sr = { x: sx, y: sy, width: sw, height: sh };
        commands.push({ type: 'rect', surfaceId, params: { ...sr, fill: theme.inputBg } });
        commands.push(...inkFrame(surfaceId, sr, theme.inputBorder, 1));
        commands.push({ type: 'rect', surfaceId, params: { x: sx, y: sy, width: 3, height: sh, fill: theme.inputBorderFocus } });
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: sx + 8, y: sy + sh / 2,
            text: this.filterText || '\u{1F50D} Type to filter...',
            font: filterFont,
            fill: this.filterText ? theme.textPrimary : theme.textPlaceholder,
            baseline: 'middle',
          },
        });
        const beforeCursor = this.filterText.substring(0, this.filterCursor);
        const cursorX = sx + 8 + (beforeCursor.length > 0
          ? await this.measureText(surfaceId, beforeCursor, filterFont)
          : 0);
        commands.push({ type: 'rect', surfaceId, params: { x: Math.round(cursorX), y: sy + 4, width: 2, height: sh - 8, fill: theme.cursor } });
      }

      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'clip', surfaceId, params: { x: ox, y: listTop, width: w, height: listH } });

      if (rows.length === 0) {
        commands.push({
          type: 'text', surfaceId,
          params: { x: ox + 8, y: listTop + optionHeight / 2, text: 'No matches', font, fill: theme.textPlaceholder, baseline: 'middle' },
        });
      }

      for (let r = 0; r < rows.length; r++) {
        const optY = listTop + r * optionHeight - this.scrollOffset;
        if (optY + optionHeight <= listTop || optY >= listTop + listH) continue;
        const optionIndex = rows[r];
        const isHovered = this.hoveredRow === r;
        const isSelected = optionIndex === selectedIndex;

        if (isHovered) {
          commands.push({ type: 'rect', surfaceId, params: { x: ox, y: optY, width: w, height: optionHeight, fill: theme.textPrimary } });
        }
        if (isSelected) {
          commands.push(...squareMark(surfaceId, ox + 9, optY + optionHeight / 2, 6, theme.accent));
        }
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + 18, y: optY + optionHeight / 2,
            text: labels[optionIndex], font,
            fill: isHovered ? theme.windowBg : (style.color ?? (isSelected ? theme.textPrimary : theme.textSecondary)),
            baseline: 'middle',
          },
        });
      }

      commands.push({ type: 'restore', surfaceId, params: {} });

      const maxScroll = this.maxScrollOffset(rows.length);
      if (maxScroll > 0) {
        const contentH = rows.length * optionHeight;
        const trackX = ox + w - SCROLLBAR_WIDTH - 2;
        commands.push({ type: 'rect', surfaceId, params: { x: trackX, y: listTop, width: SCROLLBAR_WIDTH, height: listH, fill: theme.scrollbarTrack } });
        const thumbH = Math.max(20, (listH / contentH) * listH);
        const thumbY = listTop + (this.scrollOffset / maxScroll) * (listH - thumbH);
        commands.push({ type: 'rect', surfaceId, params: { x: trackX, y: thumbY, width: SCROLLBAR_WIDTH, height: thumbH, fill: theme.scrollbarThumb } });
      }

      commands.push(...inkFrame(surfaceId, drop, frameColor, rule));
    }

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  // ── Input ─────────────────────────────────────────────────────────

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'mousedown') {
      return this.handleMouseDown(input);
    }

    if (type === 'mousemove') {
      return this.handleMouseMove(input);
    }

    if (type === 'wheel') {
      return this.handleWheel(input);
    }

    if (type === 'keydown' && this.focused) {
      return this.handleKeyDown(input);
    }

    if (type === 'paste' && this.expanded && this.isSearchable()) {
      const pasteText = input.pasteText as string | undefined;
      if (pasteText) {
        this.filterText =
          this.filterText.substring(0, this.filterCursor) +
          pasteText +
          this.filterText.substring(this.filterCursor);
        this.filterCursor += pasteText.length;
        this.onFilterChanged();
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  private async handleWheel(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.expanded) return { consumed: false };

    const x = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const y = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const wr = this.rect;
    const optionHeight = wr.height;
    const rows = this.filteredRows();
    const listTop = wr.height + this.searchHeight();
    const listH = this.listHeight(rows.length);

    // Only react to wheel over the widget or its open dropdown
    if (x < 0 || x >= wr.width || y < 0 || y >= listTop + listH) {
      return { consumed: false };
    }

    const delta = (input.deltaY as number | undefined) ?? 0;
    const oldOffset = this.scrollOffset;
    this.scrollOffset += delta > 0 ? optionHeight : -optionHeight;
    this.clampScroll(rows.length);

    if (this.scrollOffset !== oldOffset) {
      // Content moved under the cursor — re-derive the hovered row
      if (y >= listTop) {
        const row = Math.floor((y - listTop + this.scrollOffset) / optionHeight);
        this.hoveredRow = row >= 0 && row < rows.length ? row : undefined;
      }
      await this.requestRedraw();
    }

    // Consume even at the scroll limit so the panel behind an open dropdown stays put
    return { consumed: true };
  }

  private async handleKeyDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const key = input.key as string;

    if (!this.expanded) {
      // Collapsed: Enter or Space opens the dropdown
      if (key === 'Enter' || key === ' ') {
        this.openDropdown();
        await this.requestRedraw();
        return { consumed: true };
      }
      return { consumed: false };
    }

    const rows = this.filteredRows();

    // Expanded: list navigation over the filtered rows
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (rows.length > 0) {
        const current = this.hoveredRow ?? -1;
        const next = key === 'ArrowDown'
          ? (current + 1) % rows.length
          : (current - 1 + rows.length) % rows.length;
        this.hoveredRow = next;
        this.scrollRowIntoView(next, rows.length);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'PageDown' || key === 'PageUp') {
      if (rows.length > 0) {
        const step = this.visibleCount(rows.length);
        const current = this.hoveredRow ?? 0;
        const next = key === 'PageDown'
          ? Math.min(current + step, rows.length - 1)
          : Math.max(current - step, 0);
        this.hoveredRow = next;
        this.scrollRowIntoView(next, rows.length);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Enter') {
      const row = this.hoveredRow ?? 0;
      if (row >= 0 && row < rows.length) {
        this.selectOption(rows[row]);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Escape') {
      if (this.filterText) {
        // First Escape clears the filter, second closes the dropdown
        this.filterText = '';
        this.filterCursor = 0;
        this.onFilterChanged();
      } else {
        this.closeDropdown();
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    // Filter box editing — typing goes to the filter whenever the dropdown is open
    if (this.isSearchable()) {
      if (key === 'Backspace') {
        if (this.filterCursor > 0) {
          this.filterText =
            this.filterText.substring(0, this.filterCursor - 1) +
            this.filterText.substring(this.filterCursor);
          this.filterCursor--;
          this.onFilterChanged();
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if (key === 'Delete') {
        if (this.filterCursor < this.filterText.length) {
          this.filterText =
            this.filterText.substring(0, this.filterCursor) +
            this.filterText.substring(this.filterCursor + 1);
          this.onFilterChanged();
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if (key === 'ArrowLeft') {
        if (this.filterCursor > 0) {
          this.filterCursor--;
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if (key === 'ArrowRight') {
        if (this.filterCursor < this.filterText.length) {
          this.filterCursor++;
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if (key === 'Home' || key === 'End') {
        this.filterCursor = key === 'Home' ? 0 : this.filterText.length;
        await this.requestRedraw();
        return { consumed: true };
      }

      const mods = input.modifiers as { ctrl?: boolean; meta?: boolean; alt?: boolean } | undefined;
      if (key.length === 1 && !mods?.ctrl && !mods?.meta && !mods?.alt) {
        this.filterText =
          this.filterText.substring(0, this.filterCursor) +
          key +
          this.filterText.substring(this.filterCursor);
        this.filterCursor++;
        this.onFilterChanged();
        await this.requestRedraw();
        return { consumed: true };
      }
    } else if (key === 'Home' || key === 'End') {
      if (rows.length > 0) {
        const next = key === 'Home' ? 0 : rows.length - 1;
        this.hoveredRow = next;
        this.scrollRowIntoView(next, rows.length);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const wr = this.rect;
    const optionHeight = wr.height;

    if (!this.expanded) {
      this.openDropdown();
      await this.requestRedraw();
      return { consumed: true };
    }

    const rows = this.filteredRows();
    const searchH = this.searchHeight();
    const listTop = wr.height + searchH;
    const listH = this.listHeight(rows.length);
    const inDropdownX = clickX >= 0 && clickX < wr.width;

    // Click in the filter box: keep the dropdown open
    if (inDropdownX && searchH > 0 && clickY >= wr.height && clickY < listTop) {
      return { consumed: true };
    }

    // Click on an option row
    if (inDropdownX && clickY >= listTop && clickY < listTop + listH) {
      const row = Math.floor((clickY - listTop + this.scrollOffset) / optionHeight);
      if (row >= 0 && row < rows.length) {
        this.selectOption(rows[row]);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    // Click outside dropdown: close it, do NOT consume (let event bubble)
    this.closeDropdown();
    await this.requestRedraw();
    return { consumed: false };
  }

  private async handleMouseMove(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.expanded) return { consumed: false };

    const mx = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const my = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const wr = this.rect;
    const optionHeight = wr.height;
    const rows = this.filteredRows();
    const listTop = wr.height + this.searchHeight();
    const listH = this.listHeight(rows.length);

    // Check if mouse is in the option-list area
    if (mx >= 0 && mx < wr.width && my >= listTop && my < listTop + listH) {
      const row = Math.floor((my - listTop + this.scrollOffset) / optionHeight);
      if (row < rows.length && this.hoveredRow !== row) {
        this.hoveredRow = row;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    // Over the filter box: consume so hover doesn't fall through to siblings
    if (mx >= 0 && mx < wr.width && my >= wr.height && my < listTop) {
      return { consumed: true };
    }

    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.values[this.selectedIndex] ?? '';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.options !== undefined) {
      const { labels, values } = SelectWidget.normalizeOptions(updates.options as SelectOption[]);
      this.labels = labels;
      this.values = values;
      const rows = this.filteredRows();
      this.clampScroll(rows.length);
      if (this.hoveredRow !== undefined && this.hoveredRow >= rows.length) {
        this.hoveredRow = rows.length > 0 ? rows.length - 1 : undefined;
      }
    }
    if (updates.selectedIndex !== undefined) this.selectedIndex = updates.selectedIndex as number;
  }
}
