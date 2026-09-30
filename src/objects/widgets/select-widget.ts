/**
 * SelectWidget -- dropdown selection widget with expandable option list.
 *
 * Renders a collapsed button-like element showing the selected option with a
 * down-arrow indicator. When clicked, the option list opens as a pop-out
 * (popout.ts): a 2D layer the select hangs off its window, so the list can
 * reach past the window's edge, and it opens upward when the screen has more
 * room above the field than below. Hover highlights options; selecting one
 * closes the list and fires a 'change' notification. Clicking outside the
 * list closes it without consuming the event (the click still reaches what
 * it hit); so do Escape and the window losing focus.
 *
 * Options can be plain strings or { label, value } objects. When using objects,
 * the label is displayed and the value is emitted on change. Plain strings are
 * used as both label and value.
 *
 * Long option lists scroll: the list shows at most MAX_VISIBLE_OPTIONS rows
 * (fewer when the screen has less room), scrollable via mouse wheel, and
 * keyboard navigation keeps the highlighted option in view. Lists longer than
 * one page also get a filter box at the top of the list (like ListWidget's
 * built-in search): typing while the list is open narrows the options, Enter
 * picks the highlighted match, Escape clears the filter before closing.
 * Override with the `searchable` config flag.
 *
 * When the widget's host cannot take a pop-out (it is not a window), the list
 * is painted into the window texture below the field instead.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { Rect, ThemeData, fontStacks, inkFrame, squareMark } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';
import { placePopout, type PopoutScreen, type PopoutSurface } from './popout.js';

export type SelectOption = string | { label: string; value: string };

export interface SelectWidgetConfig extends WidgetConfig {
  options?: SelectOption[];
  selectedIndex?: number;
  /** Filter box atop the dropdown. Defaults to on when options overflow one page. */
  searchable?: boolean;
}

/** Most option rows visible at once before the dropdown scrolls. */
const MAX_VISIBLE_OPTIONS = 8;
/** Fewest rows a pop-out shrinks to when the screen is short on room. */
const MIN_FIT_ROWS = 3;
const SCROLLBAR_WIDTH = 6;
const SEARCH_HEIGHT = 30;
/** The list's hard print shadow, offset down and right. */
const SHADOW = 4;
/** A pop-out list grows past a narrow field to fit its labels, up to this width. */
const MAX_LIST_WIDTH = 420;

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

  /** The open list as a pop-out layer on the window (created on first open). */
  private popout?: PopoutSurface;
  /** The list paints into the window texture (its host would not take a pop-out). */
  private inline = false;
  /** Where the field last rendered, in window px. */
  private fieldAt?: Rect;
  /** Side of the field the list opened on (kept while it stays open). */
  private openSide: 'below' | 'above' = 'below';
  /** Rows visible at once in this open (fewer when the screen is short on room). */
  private maxRows = MAX_VISIBLE_OPTIONS;
  /** List row pressed on the pop-out; the option is picked on release. */
  private pressedRow?: number;
  /** Theme the pop-out was last painted with. */
  private popoutTheme?: ThemeData;
  /** Screen geometry for this open (keeps a widened list on screen). */
  private popoutGeo: PopoutScreen | null = null;
  /** Width of the open pop-out list (at least the field's width). */
  private listWidth = 0;
  private popoutDirty = false;
  private popoutPainting = false;

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
    return Math.min(rowCount, this.maxRows);
  }

  /** Pixel height of the option-list viewport (excludes the filter box). */
  private listHeight(rowCount: number): number {
    // An empty filter result still shows one row for the "No matches" notice
    return Math.max(1, this.visibleCount(rowCount)) * this.rect.height;
  }

  /** Pixel height of the whole open list: filter box plus option rows. */
  private dropdownHeight(): number {
    return this.searchHeight() + this.listHeight(this.filteredRows().length);
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
    this.maxRows = MAX_VISIBLE_OPTIONS;
    this.openSide = 'below';
    this.inline = false;
    this.pressedRow = undefined;
    // With an empty filter, row index === option index
    this.hoveredRow = this.selectedIndex >= 0 && this.selectedIndex < this.labels.length
      ? this.selectedIndex
      : undefined;
    if (this.hoveredRow !== undefined) {
      this.scrollRowIntoView(this.hoveredRow, this.labels.length);
    }
    this.changed('expanded', true);
    void this.openPopout();
  }

  private closeDropdown(): void {
    this.expanded = false;
    this.hoveredRow = undefined;
    this.filterText = '';
    this.filterCursor = 0;
    this.scrollOffset = 0;
    this.pressedRow = undefined;
    this.inline = false;
    this.maxRows = MAX_VISIBLE_OPTIONS;
    this.listWidth = 0;
    this.popoutGeo = null;
    void this.popout?.hide();
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

  // ── The pop-out ───────────────────────────────────────────────────

  /**
   * Open the list as a pop-out below the field, or above it when the screen
   * has more room there, with as many rows as fit (MIN_FIT_ROWS at least).
   * Falls back to painting the list into the window when the host refuses.
   */
  private async openPopout(): Promise<void> {
    const field = this.fieldAt;
    if (!field) {
      await this.fallBackInline();
      return;
    }
    const surface = this.popout ??= this.createPopout(`select-popout-${this.id}`);
    try {
      const rowH = this.rect.height;
      const naturalRows = Math.max(1, Math.min(this.labels.length, MAX_VISIBLE_OPTIONS));
      const [geo, listWidth] = await Promise.all([surface.screen(), this.measureListWidth()]);
      this.popoutGeo = geo;
      this.listWidth = listWidth;
      const placed = placePopout({
        anchor: field,
        width: listWidth + SHADOW,
        height: this.searchHeight() + naturalRows * rowH + SHADOW,
        side: 'below',
      }, geo);
      if (!this.expanded || this.inline) return;
      this.openSide = placed.side === 'above' ? 'above' : 'below';
      if (Number.isFinite(placed.room) && rowH > 0) {
        const fit = Math.floor((placed.room - SHADOW - this.searchHeight()) / rowH);
        this.maxRows = Math.max(MIN_FIT_ROWS, Math.min(MAX_VISIBLE_OPTIONS, fit));
      }
      if (this.hoveredRow !== undefined) this.scrollRowIntoView(this.hoveredRow, this.filteredRows().length);
      await this.refreshPopout();
    } catch {
      await this.fallBackInline();
    }
  }

  /**
   * The list's layer in window px: under the field, or above it with its
   * shadow touching the field, shifted left when a widened list would run
   * off the screen.
   */
  private popoutRect(): Rect {
    return placePopout({
      anchor: this.fieldAt!,
      width: this.panelWidth() + SHADOW,
      height: this.dropdownHeight() + SHADOW,
      side: this.openSide,
      flip: false,
    }, this.popoutGeo).rect;
  }

  /** Width of the open list's panel: the field's, or wider on a pop-out to fit the labels. */
  private panelWidth(): number {
    return this.inline ? this.rect.width : Math.max(this.rect.width, this.listWidth);
  }

  /**
   * The width that fits the longest labels (measured on the longest few by
   * character count), never narrower than the field.
   */
  private async measureListWidth(): Promise<number> {
    const font = buildFont(this.style, this.theme);
    const longest = [...this.labels].sort((a, b) => b.length - a.length).slice(0, 12);
    let widest = 0;
    for (const label of longest) {
      widest = Math.max(widest, await this.measureText('', label, font).catch(() => label.length * 7));
    }
    const scrollbar = this.labels.length > MAX_VISIBLE_OPTIONS ? SCROLLBAR_WIDTH + 4 : 0;
    const fit = Math.ceil(widest) + 18 + 12 + scrollbar;
    return Math.max(this.rect.width, Math.min(MAX_LIST_WIDTH, fit));
  }

  /** Paint (and move or resize) the open pop-out; the latest state wins. */
  private async refreshPopout(): Promise<void> {
    this.popoutDirty = true;
    if (this.popoutPainting) return;
    this.popoutPainting = true;
    try {
      while (this.popoutDirty) {
        this.popoutDirty = false;
        const surface = this.popout;
        if (!this.expanded || this.inline || !surface || !this.fieldAt) break;
        const commands = await this.buildDropdownCommands('', 0, 0);
        if (!this.expanded || this.inline) break;
        this.popoutTheme = this.theme;
        await surface.show(this.popoutRect(), commands);
      }
    } finally {
      this.popoutPainting = false;
    }
  }

  private repaintPopout(): void {
    this.refreshPopout().catch(() => { void this.fallBackInline(); });
  }

  /** Paint the open list into the window texture instead of a pop-out. */
  private async fallBackInline(): Promise<void> {
    if (!this.expanded || this.inline) return;
    this.inline = true;
    this.maxRows = MAX_VISIBLE_OPTIONS;
    void this.popout?.hide();
    await this.requestRedraw();
  }

  /** The list's content changed (hover, scroll, filter): repaint whichever surface shows it. */
  private async listChanged(): Promise<void> {
    if (this.inline) await this.requestRedraw();
    else this.repaintPopout();
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /**
   * A square paper field in an ink rule with a solid
   * triangle in a ruled arrow cell (inverted while open). The open list is a
   * pop-out (see buildDropdownCommands) that follows the field when it moves.
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

    // Track the field in window px; an open pop-out follows it (scrolling
    // containers, relayout) and repaints on a theme change.
    const prev = this.fieldAt;
    this.fieldAt = { x: ox, y: oy, width: w, height: h };
    const moved = !prev || prev.x !== ox || prev.y !== oy || prev.width !== w || prev.height !== h;
    if (this.expanded && !this.inline && this.popout?.isOpen && (moved || this.popoutTheme !== theme)) {
      this.repaintPopout();
    }

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

    if (this.expanded && this.inline) {
      commands.push(...await this.buildDropdownCommands(surfaceId, ox, oy + h));
    }

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  /**
   * The open list with its top-left at (x, y): a square print block with a
   * hard offset shadow (SHADOW px down-right, so it needs that much room
   * past the list); the hovered option is an ink band with inverse text, and
   * the chosen option carries a red square. Drawn at (0, 0) on the pop-out
   * layer, or under the field in the window texture when inline.
   */
  private async buildDropdownCommands(surfaceId: string, x: number, y: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.panelWidth();
    const optionHeight = this.rect.height;
    const style = this.style;
    const theme = this.theme;
    const shape = shapeOf(theme);
    const font = buildFont(style, theme);
    const rule = shape.ruleWidth;
    const fieldBg = style.background ?? theme.selectBg;
    const frameColor = style.borderColor ?? theme.buttonBorder;
    const labels = this.labels;
    const selectedIndex = this.selectedIndex;

    const rows = this.filteredRows();
    const searchH = this.searchHeight();
    const listH = this.listHeight(rows.length);
    const dropdownH = searchH + listH;
    const listTop = y + searchH;
    const drop = { x, y, width: w, height: dropdownH };

    // Hard print shadow, then the face and its ink rule.
    commands.push({
      type: 'rect', surfaceId,
      params: { x: x + SHADOW, y: y + SHADOW, width: w, height: dropdownH, fill: shape.blockShadowColor },
    });
    commands.push({ type: 'rect', surfaceId, params: { ...drop, fill: fieldBg } });

    if (searchH > 0) {
      const sx = x + 4;
      const sy = y + 3;
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
    commands.push({ type: 'clip', surfaceId, params: { x, y: listTop, width: w, height: listH } });

    if (rows.length === 0) {
      commands.push({
        type: 'text', surfaceId,
        params: { x: x + 8, y: listTop + optionHeight / 2, text: 'No matches', font, fill: theme.textPlaceholder, baseline: 'middle' },
      });
    }

    for (let r = 0; r < rows.length; r++) {
      const optY = listTop + r * optionHeight - this.scrollOffset;
      if (optY + optionHeight <= listTop || optY >= listTop + listH) continue;
      const optionIndex = rows[r];
      const isHovered = this.hoveredRow === r;
      const isSelected = optionIndex === selectedIndex;

      if (isHovered) {
        commands.push({ type: 'rect', surfaceId, params: { x, y: optY, width: w, height: optionHeight, fill: theme.textPrimary } });
      }
      if (isSelected) {
        commands.push(...squareMark(surfaceId, x + 9, optY + optionHeight / 2, 6, theme.accent));
      }
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: x + 18, y: optY + optionHeight / 2,
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
      const trackX = x + w - SCROLLBAR_WIDTH - 2;
      commands.push({ type: 'rect', surfaceId, params: { x: trackX, y: listTop, width: SCROLLBAR_WIDTH, height: listH, fill: theme.scrollbarTrack } });
      const thumbH = Math.max(20, (listH / contentH) * listH);
      const thumbY = listTop + (this.scrollOffset / maxScroll) * (listH - thumbH);
      commands.push({ type: 'rect', surfaceId, params: { x: trackX, y: thumbY, width: SCROLLBAR_WIDTH, height: thumbH, fill: theme.scrollbarThumb } });
    }

    commands.push(...inkFrame(surfaceId, drop, frameColor, rule));
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
        await this.listChanged();
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  /** Widget-local point of a window-routed event. */
  private localPoint(input: Record<string, unknown>): { x: number; y: number } {
    return {
      x: (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0,
      y: (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0,
    };
  }

  private onField(x: number, y: number): boolean {
    return x >= 0 && x < this.rect.width && y >= 0 && y < this.rect.height;
  }

  /** Whether a widget-local point lies on the open pop-out. */
  private onPopout(x: number, y: number): boolean {
    const f = this.fieldAt;
    return !!f && !!this.popout && this.popout.contains(f.x + x, f.y + y);
  }

  /** Scroll the list one row per wheel notch; true when it moved. */
  private scrollBy(deltaY: number): boolean {
    const rows = this.filteredRows();
    const oldOffset = this.scrollOffset;
    this.scrollOffset += deltaY > 0 ? this.rect.height : -this.rect.height;
    this.clampScroll(rows.length);
    return this.scrollOffset !== oldOffset;
  }

  private async handleWheel(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.expanded) return { consumed: false };

    const { x, y } = this.localPoint(input);
    const delta = (input.deltaY as number | undefined) ?? 0;

    if (!this.inline) {
      // The pop-out hears its own wheel; over it, keep the panel behind still.
      if (this.onPopout(x, y)) return { consumed: true };
      if (!this.onField(x, y)) return { consumed: false };
      if (delta !== 0 && this.scrollBy(delta)) this.repaintPopout();
      return { consumed: true };
    }

    const wr = this.rect;
    const optionHeight = wr.height;
    const rows = this.filteredRows();
    const listTop = wr.height + this.searchHeight();
    const listH = this.listHeight(rows.length);

    // Only react to wheel over the widget or its open dropdown
    if (x < 0 || x >= wr.width || y < 0 || y >= listTop + listH) {
      return { consumed: false };
    }

    if (delta !== 0 && this.scrollBy(delta)) {
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
        await this.listChanged();
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
        await this.listChanged();
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
        await this.listChanged();
      } else {
        this.closeDropdown();
        await this.requestRedraw();
      }
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
          await this.listChanged();
        }
        return { consumed: true };
      }

      if (key === 'Delete') {
        if (this.filterCursor < this.filterText.length) {
          this.filterText =
            this.filterText.substring(0, this.filterCursor) +
            this.filterText.substring(this.filterCursor + 1);
          this.onFilterChanged();
          await this.listChanged();
        }
        return { consumed: true };
      }

      if (key === 'ArrowLeft') {
        if (this.filterCursor > 0) {
          this.filterCursor--;
          await this.listChanged();
        }
        return { consumed: true };
      }

      if (key === 'ArrowRight') {
        if (this.filterCursor < this.filterText.length) {
          this.filterCursor++;
          await this.listChanged();
        }
        return { consumed: true };
      }

      if (key === 'Home' || key === 'End') {
        this.filterCursor = key === 'Home' ? 0 : this.filterText.length;
        await this.listChanged();
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
        await this.listChanged();
        return { consumed: true };
      }
    } else if (key === 'Home' || key === 'End') {
      if (rows.length > 0) {
        const next = key === 'Home' ? 0 : rows.length - 1;
        this.hoveredRow = next;
        this.scrollRowIntoView(next, rows.length);
        await this.listChanged();
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const { x: clickX, y: clickY } = this.localPoint(input);
    const wr = this.rect;
    const optionHeight = wr.height;

    if (!this.expanded) {
      this.openDropdown();
      await this.requestRedraw();
      return { consumed: true };
    }

    if (!this.inline) {
      // The pop-out takes its own clicks, so a click that reaches the
      // window missed the list. On the field it closes the list (a toggle);
      // anywhere else it closes it and carries on to what it hit.
      const onField = this.onField(clickX, clickY);
      this.closeDropdown();
      await this.requestRedraw();
      return { consumed: onField };
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
    // With a pop-out the list hears its own hover; the window only sees the
    // pointer elsewhere.
    if (!this.expanded || !this.inline) return { consumed: false };

    const { x: mx, y: my } = this.localPoint(input);
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

  /**
   * Input on the pop-out itself (x/y in window px): hover highlights, a
   * press on an option picks it on release, the wheel scrolls. Keys still
   * arrive through the window, since the select keeps keyboard focus.
   */
  protected override async handlePopoutInput(input: Record<string, unknown>): Promise<void> {
    const surface = this.popout;
    if (!surface || input.nodeId !== surface.nodeId || !this.expanded || this.inline) return;
    const at = surface.toLocal(input);
    if (!at) return;
    const type = input.type as string;
    const rows = this.filteredRows();
    const searchH = this.searchHeight();
    const listH = this.listHeight(rows.length);
    const inList = at.x >= 0 && at.x < this.panelWidth() && at.y >= searchH && at.y < searchH + listH;
    const rowAt = (): number => Math.floor((at.y - searchH + this.scrollOffset) / this.rect.height);

    if (type === 'mousemove' || type === 'mouseenter') {
      if (!inList) return;
      const row = rowAt();
      if (row >= 0 && row < rows.length && row !== this.hoveredRow) {
        this.hoveredRow = row;
        this.repaintPopout();
      }
      return;
    }

    if (type === 'mousedown') {
      if (((input.button as number | undefined) ?? 0) !== 0) return;
      const row = inList ? rowAt() : -1;
      this.pressedRow = row >= 0 && row < rows.length ? row : undefined;
      if (this.pressedRow !== undefined && this.pressedRow !== this.hoveredRow) {
        this.hoveredRow = this.pressedRow;
        this.repaintPopout();
      }
      return;
    }

    if (type === 'mouseup') {
      const pressed = this.pressedRow;
      this.pressedRow = undefined;
      if (pressed === undefined || !inList) return;
      const row = rowAt();
      if (row >= 0 && row < rows.length) {
        this.selectOption(rows[row]);
        await this.requestRedraw();
      }
      return;
    }

    if (type === 'wheel') {
      const delta = (input.deltaY as number | undefined) ?? 0;
      if (delta === 0 || !this.scrollBy(delta)) return;
      // Content moved under the pointer: re-derive the hovered row
      if (inList) {
        const row = rowAt();
        this.hoveredRow = row >= 0 && row < rows.length ? row : this.hoveredRow;
      }
      this.repaintPopout();
    }
  }

  /** The window lost focus: close like an outside click. */
  protected override async handlePopoutWindowFocus(focused: boolean): Promise<void> {
    if (focused || !this.expanded) return;
    this.closeDropdown();
    await this.requestRedraw();
  }

  protected override async onStop(): Promise<void> {
    void this.popout?.hide();
    await super.onStop();
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
    if (!this.expanded) return;
    // A hidden or disabled select cannot keep its list open.
    if (!this.visible || this.disabled) {
      this.closeDropdown();
    } else if (!this.inline && updates.options !== undefined) {
      void this.measureListWidth().then((width) => {
        this.listWidth = width;
        this.repaintPopout();
      });
    } else if (!this.inline && updates.selectedIndex !== undefined) {
      this.repaintPopout();
    }
  }
}
