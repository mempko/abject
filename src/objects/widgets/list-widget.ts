/**
 * ListWidget — a scrollable, selectable list with optional built-in search.
 *
 * Items have a label, value, and optional secondary text. Clicking an item
 * highlights it (stays selected). Emits 'selectionChanged' when selection
 * changes. Supports ArrowUp/Down navigation and mouse wheel scrolling.
 * Optional search filtering via `searchable: true`.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WIDGET_FONT, BODY_FONT_STACK, lightenColor } from './widget-types.js';
import { iconCommands, IconName } from '../../ui/icons.js';

/** A right-aligned inline action button on a rich list row. */
export interface ListActionSpec {
  id: string;
  label: string;
  /** Button fill color; defaults to theme.buttonBg. */
  color?: string;
  /** Button label color; defaults to theme.buttonText. */
  textColor?: string;
}

export interface ListItem {
  label: string;
  value: string;
  secondary?: string;
  /**
   * Optional vector icon drawn at the row's leading edge — used by
   * status-style lists (jobs, agents, schedules) to replace ASCII glyphs.
   */
  iconName?: IconName;
  /** Override icon color; defaults to theme.textSecondary. */
  iconColor?: string;
  /**
   * Leading colored chip (e.g. "80%" or a status word). Presence of any of
   * `badge`/`detail`/`actions` turns the row into a rich two-line card row.
   */
  badge?: { text: string; color?: string; textColor?: string };
  /** Second line rendered under `label`, muted. Makes the row a rich card row. */
  detail?: string;
  /** Right-aligned inline buttons; clicking one fires an 'action' event. Makes the row a rich card row. */
  actions?: ListActionSpec[];
}

export interface ListWidgetConfig extends WidgetConfig {
  items?: ListItem[];
  selectedIndex?: number;
  searchable?: boolean;
  itemHeight?: number;
}

const DEFAULT_ITEM_HEIGHT = 26;
/** Minimum row height for rich (card) rows so badges/buttons are not squished. */
const RICH_MIN_ITEM_HEIGHT = 54;
/** Leading badge chip height in a rich row. */
const BADGE_HEIGHT = 22;
/** Inline action button height in a rich row. */
const ACTION_HEIGHT = 24;
/** Title line height (word-wrapped) in a rich row. */
const TITLE_LINE_H = 18;
/** Muted detail line height in a rich row. */
const DETAIL_LINE_H = 15;
/** Cap title wrapping so one giant entry cannot create a huge row. */
const MAX_TITLE_LINES = 4;
/** Inner vertical padding (top + bottom) inside a rich card. */
const CARD_PAD_V = 16;
/** Gap above + below each rich card (between cards). */
const CARD_GAP_V = 8;
const SCROLLBAR_WIDTH = 8;
const SCROLL_STEP = 30;
const SEARCH_HEIGHT = 30;
const SEARCH_PADDING = 4;

export class ListWidget extends WidgetAbject {
  private items: ListItem[] = [];
  private filteredItems: ListItem[] = [];
  private selectedIndex = -1;
  private hoveredIndex = -1;
  private searchable: boolean;
  private searchText = '';
  private searchFocused = false;
  private searchCursorPos = 0;
  private scrollTop = 0;
  private _itemHeight: number;
  // Variable-height layout: cumulative row tops (length n+1) and total height,
  // recomputed when items, filter, or width change. Rich rows wrap their title
  // and grow; plain rows stay at the configured itemHeight.
  private _rowTops: number[] = [0];
  private _contentHeight = 0;
  private _layoutWidth = -1;
  private _layoutDirty = true;

  constructor(config: ListWidgetConfig) {
    super(config);
    this.items = config.items ?? [];
    this.filteredItems = [...this.items];
    this.selectedIndex = config.selectedIndex ?? -1;
    this.searchable = config.searchable ?? false;
    this._itemHeight = config.itemHeight ?? DEFAULT_ITEM_HEIGHT;
  }

  /** Plain (non-rich) row height. Rich rows compute their own height. */
  private get itemHeight(): number {
    return this._itemHeight;
  }

  private invalidateLayout(): void {
    this._layoutDirty = true;
  }

  /** Recompute per-row heights and cumulative tops when stale or width changed. */
  private ensureLayout(): void {
    const w = this.rect.width;
    if (!this._layoutDirty && this._layoutWidth === w) return;
    const tops = [0];
    for (let i = 0; i < this.filteredItems.length; i++) {
      tops.push(tops[i] + this.rowHeightFor(this.filteredItems[i], w));
    }
    this._rowTops = tops;
    this._contentHeight = tops[tops.length - 1];
    this._layoutWidth = w;
    this._layoutDirty = false;
  }

  private rowHeightFor(item: ListItem, w: number): number {
    if (!this.isRichItem(item)) return this._itemHeight;
    return this.richRowMetrics(item, w).height;
  }

  /** Index of the row containing local y (list-relative, scroll already applied). */
  private rowIndexAt(localContentY: number): number {
    const tops = this._rowTops;
    if (localContentY < 0 || tops.length < 2) return -1;
    for (let i = 0; i < tops.length - 1; i++) {
      if (localContentY < tops[i + 1]) return i;
    }
    return -1;
  }

  // ── Filtering ────────────────────────────────────────────────────

  private applyFilter(): void {
    if (!this.searchText) {
      this.filteredItems = [...this.items];
    } else {
      const lower = this.searchText.toLowerCase();
      this.filteredItems = this.items.filter(
        (item) =>
          item.label.toLowerCase().includes(lower) ||
          (item.secondary?.toLowerCase().includes(lower) ?? false)
      );
    }
    this.invalidateLayout();
  }

  private get listTop(): number {
    return this.searchable ? SEARCH_HEIGHT + SEARCH_PADDING : 0;
  }

  private get listHeight(): number {
    return Math.max(0, this.rect.height - this.listTop);
  }

  private get totalContentHeight(): number {
    this.ensureLayout();
    return this._contentHeight;
  }

  private get maxScroll(): number {
    return Math.max(0, this.totalContentHeight - this.listHeight);
  }

  private clampScrollTop(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll));
  }

  private ensureSelectedVisible(): void {
    if (this.selectedIndex < 0) return;
    this.ensureLayout();
    const itemTop = this._rowTops[this.selectedIndex] ?? 0;
    const itemBottom = this._rowTops[this.selectedIndex + 1] ?? itemTop;
    if (itemTop < this.scrollTop) {
      this.scrollTop = itemTop;
    } else if (itemBottom > this.scrollTop + this.listHeight) {
      this.scrollTop = itemBottom - this.listHeight;
    }
    this.clampScrollTop();
  }

  // ── Rich (card) rows ──────────────────────────────────────────────

  private isRichItem(item: ListItem): boolean {
    return !!(item.badge || item.detail || (item.actions && item.actions.length > 0));
  }

  /**
   * Greedy word-wrap using a character-width heuristic (sync, no async text
   * measurement) so render and hit-testing compute identical layouts. Slightly
   * conservative; any minor overflow is hidden by the per-row text clip.
   */
  private wrapText(text: string, maxWidthPx: number, fontSizePx: number): string[] {
    const avgCharW = fontSizePx * 0.52;
    const maxChars = Math.max(4, Math.floor(maxWidthPx / avgCharW));
    const lines: string[] = [];
    let cur = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (candidate.length <= maxChars) {
        cur = candidate;
        continue;
      }
      if (cur) lines.push(cur);
      if (word.length > maxChars) {
        let rest = word;
        while (rest.length > maxChars) {
          lines.push(rest.slice(0, maxChars));
          rest = rest.slice(maxChars);
        }
        cur = rest;
      } else {
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /**
   * Horizontal geometry + wrapped title lines + total row height for a rich
   * (card) row. Independent of the row's vertical position, so it can be used
   * both to lay out the list (heights) and to render/hit-test a row. Always
   * reserves the scrollbar gutter to avoid a circular height/scrollbar
   * dependency.
   */
  private richRowMetrics(item: ListItem, w: number): {
    cardW: number;
    badgeW: number;
    textX: number;
    textW: number;
    actionWidths: number[];
    lines: string[];
    hasDetail: boolean;
    height: number;
  } {
    const PAD = 10;
    const gutter = SCROLLBAR_WIDTH + 2;
    const cardX = 4;
    const cardW = Math.max(10, w - 8 - gutter);

    let leftX = cardX + PAD;
    let badgeW = 0;
    if (item.badge) {
      badgeW = Math.max(34, item.badge.text.length * 7 + 14);
      leftX += badgeW + PAD;
    }

    const specs = item.actions ?? [];
    const actionWidths = specs.map((s) => Math.max(52, s.label.length * 6.5 + 20));
    const actionsTotal = actionWidths.reduce((a, b) => a + b + 6, 0);
    const textX = leftX;
    const textRight = specs.length ? cardX + cardW - PAD - actionsTotal - 2 : cardX + cardW - PAD;
    const textW = Math.max(10, textRight - textX);

    const lines = this.wrapText(item.label, textW, 13).slice(0, MAX_TITLE_LINES);
    const hasDetail = (item.detail ?? item.secondary ?? '') !== '';
    const contentH = lines.length * TITLE_LINE_H + (hasDetail ? DETAIL_LINE_H : 0);
    const cardH = Math.max(contentH + CARD_PAD_V, BADGE_HEIGHT + CARD_PAD_V, ACTION_HEIGHT + CARD_PAD_V);
    const height = Math.max(cardH + CARD_GAP_V, RICH_MIN_ITEM_HEIGHT);

    return { cardW, badgeW, textX, textW, actionWidths, lines, hasDetail, height };
  }

  /**
   * Absolute geometry for a rich row at a known top and height. originX is the
   * surface x for render, or 0 for local hit-testing.
   */
  private richRowGeometry(
    originX: number,
    rowTopY: number,
    rowHeight: number,
    w: number,
    item: ListItem
  ): {
    card: { x: number; y: number; w: number; h: number };
    badge: { x: number; y: number; w: number; h: number } | null;
    textX: number;
    textW: number;
    lines: string[];
    hasDetail: boolean;
    actions: Array<{ spec: ListActionSpec; x: number; y: number; w: number; h: number }>;
  } {
    const PAD = 10;
    const m = this.richRowMetrics(item, w);
    const cardX = originX + 4;
    const card = { x: cardX, y: rowTopY + CARD_GAP_V / 2, w: m.cardW, h: rowHeight - CARD_GAP_V };

    let badge: { x: number; y: number; w: number; h: number } | null = null;
    if (item.badge) {
      // Align the badge to the first title line so multi-line rows look right.
      const badgeY = card.y + CARD_PAD_V / 2 + (TITLE_LINE_H - BADGE_HEIGHT) / 2;
      badge = { x: cardX + PAD, y: badgeY, w: m.badgeW, h: BADGE_HEIGHT };
    }

    const actions: Array<{ spec: ListActionSpec; x: number; y: number; w: number; h: number }> = [];
    const specs = item.actions ?? [];
    const by = card.y + (card.h - ACTION_HEIGHT) / 2;
    let rightX = cardX + m.cardW - PAD;
    for (let k = specs.length - 1; k >= 0; k--) {
      const bw = m.actionWidths[k];
      rightX -= bw;
      actions.unshift({ spec: specs[k], x: rightX, y: by, w: bw, h: ACTION_HEIGHT });
      rightX -= 6;
    }

    return { card, badge, textX: originX + m.textX, textW: m.textW, lines: m.lines, hasDetail: m.hasDetail, actions };
  }

  private buildRichRow(
    surfaceId: string,
    ox: number,
    itemY: number,
    rowHeight: number,
    w: number,
    item: ListItem,
    isSelected: boolean,
    isHovered: boolean
  ): unknown[] {
    const cmds: unknown[] = [];
    const g = this.richRowGeometry(ox, itemY, rowHeight, w, item);

    // Card surface
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: g.card.x, y: g.card.y, width: g.card.w, height: g.card.h,
        fill: isSelected
          ? this.theme.selectionBg
          : isHovered
            ? lightenColor(this.theme.inputBg, 6)
            : this.theme.inputBg,
        stroke: isSelected ? this.theme.accent : this.theme.inputBorder,
        radius: this.style.radius ?? this.theme.widgetRadius,
      },
    });

    // Leading badge chip
    if (item.badge && g.badge) {
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          x: g.badge.x, y: g.badge.y, width: g.badge.w, height: g.badge.h,
          fill: item.badge.color ?? this.theme.accent,
          radius: 5,
        },
      });
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: g.badge.x + g.badge.w / 2, y: g.badge.y + g.badge.h / 2,
          text: item.badge.text,
          font: `600 11px ${BODY_FONT_STACK}`,
          fill: item.badge.textColor ?? this.theme.windowBg,
          align: 'center', baseline: 'middle',
        },
      });
    }

    // Word-wrapped title lines, then an optional muted detail line below.
    // `detail` is the explicit field; fall back to `secondary` so a caller that
    // reused the plain-row field still gets a second line. Clip the text column
    // (rather than passing maxWidth, which horizontally squishes overflow) so
    // any minor over-fill is cut off cleanly.
    const detailText = item.detail ?? item.secondary;
    const titleTop = g.card.y + CARD_PAD_V / 2;
    cmds.push({ type: 'save', surfaceId, params: {} });
    cmds.push({ type: 'clip', surfaceId, params: { x: g.textX, y: g.card.y, width: g.textW, height: g.card.h } });
    g.lines.forEach((line, i) => {
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: g.textX, y: titleTop + i * TITLE_LINE_H + TITLE_LINE_H / 2, text: line,
          font: `13px ${BODY_FONT_STACK}`,
          fill: isSelected ? this.theme.accent : this.theme.textPrimary,
          baseline: 'middle',
        },
      });
    });
    if (g.hasDetail && detailText) {
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: g.textX, y: titleTop + g.lines.length * TITLE_LINE_H + DETAIL_LINE_H / 2, text: detailText,
          font: `11px ${BODY_FONT_STACK}`,
          fill: this.theme.textTertiary,
          baseline: 'middle',
        },
      });
    }
    cmds.push({ type: 'restore', surfaceId, params: {} });

    // Right-aligned action buttons
    for (const a of g.actions) {
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          x: a.x, y: a.y, width: a.w, height: a.h,
          fill: a.spec.color ?? this.theme.buttonBg,
          stroke: a.spec.color ? lightenColor(a.spec.color, 24) : this.theme.inputBorder,
          radius: 5,
        },
      });
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: a.x + a.w / 2, y: a.y + a.h / 2,
          text: a.spec.label,
          font: `12px ${BODY_FONT_STACK}`,
          fill: a.spec.textColor ?? this.theme.buttonText,
          align: 'center', baseline: 'middle',
        },
      });
    }

    return cmds;
  }

  // ── Rendering ────────────────────────────────────────────────────

  protected async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;

    // Background
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: this.theme.inputBg,
        stroke: this.theme.inputBorder,
        radius: this.style.radius ?? this.theme.widgetRadius,
      },
    });

    // Search box
    if (this.searchable) {
      const sx = ox + 4;
      const sy = oy + 4;
      const sw = w - 8;
      const sh = SEARCH_HEIGHT - 4;
      const borderColor = this.searchFocused
        ? this.theme.inputBorderFocus
        : this.theme.inputBorder;

      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: sx, y: sy, width: sw, height: sh,
          fill: this.theme.windowBg,
          stroke: borderColor,
          radius: 4,
        },
      });

      if (this.searchText) {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: sx + 6, y: sy + sh / 2,
            text: this.searchText,
            font: '12px "Spectral", Georgia, "Times New Roman", serif',
            fill: this.theme.textPrimary,
            baseline: 'middle',
          },
        });
      } else {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: sx + 6, y: sy + sh / 2,
            text: '\u{1F50D} Search...',
            font: '12px "Spectral", Georgia, "Times New Roman", serif',
            fill: this.theme.textPlaceholder,
            baseline: 'middle',
          },
        });
      }

      // Cursor
      if (this.searchFocused) {
        const beforeCursor = this.searchText.substring(0, this.searchCursorPos);
        const cursorX = sx + 6 + (beforeCursor.length > 0
          ? await this.measureText(surfaceId, beforeCursor, '12px "Spectral", Georgia, "Times New Roman", serif')
          : 0);
        commands.push({
          type: 'line',
          surfaceId,
          params: {
            x1: cursorX, y1: sy + 4,
            x2: cursorX, y2: sy + sh - 4,
            stroke: this.theme.cursor,
          },
        });
      }
    }

    // Clip for item list
    const listY = oy + this.listTop;
    const listH = this.listHeight;

    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: { x: ox, y: listY, width: w, height: listH },
    });

    // Render visible items using the variable-height layout (cumulative tops).
    this.ensureLayout();
    const tops = this._rowTops;
    const viewTop = this.scrollTop;
    const viewBottom = this.scrollTop + listH;

    const font = '13px "Spectral", Georgia, "Times New Roman", serif';
    const secondaryFont = '11px "Spectral", Georgia, "Times New Roman", serif';

    for (let i = 0; i < this.filteredItems.length; i++) {
      const rowTop = tops[i];
      const rowH = tops[i + 1] - rowTop;
      // Cull rows fully outside the viewport.
      if (rowTop + rowH < viewTop || rowTop > viewBottom) continue;

      const item = this.filteredItems[i];
      if (!item) continue;

      const itemY = listY + rowTop - this.scrollTop;
      const isSelected = i === this.selectedIndex;
      const isHovered = i === this.hoveredIndex && !isSelected;

      // Rich (card) rows draw their own surface, badge, text, and buttons.
      if (this.isRichItem(item)) {
        commands.push(...this.buildRichRow(surfaceId, ox, itemY, rowH, w, item, isSelected, isHovered));
        continue;
      }

      // Selection/hover background
      if (isSelected) {
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight,
            fill: this.theme.selectionBg,
            radius: 3,
          },
        });
      } else if (isHovered) {
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight,
            fill: lightenColor(this.theme.inputBg, 8),
            radius: 3,
          },
        });
      }

      // Optional leading icon (status indicator). Drawn before the label so
      // we can shift the text origin right by iconSize+pad.
      const iconSize = item.iconName ? Math.min(14, this.itemHeight - 8) : 0;
      const iconPad = item.iconName ? 8 : 0;
      const textX = ox + 10 + iconSize + iconPad;
      if (item.iconName) {
        const iconColor = item.iconColor ?? (isSelected ? this.theme.accent : this.theme.textSecondary);
        commands.push(...iconCommands(item.iconName, {
          surfaceId,
          x: ox + 10,
          y: itemY + (this.itemHeight - iconSize) / 2,
          size: iconSize,
          color: iconColor,
        }));
      }

      // Label + secondary as a single truncated line
      const labelColor = isSelected ? this.theme.accent : this.theme.textPrimary;
      const maxTextWidth = w - (textX - ox) - 14;
      const secondary = item.secondary ?? '';
      const fullText = secondary ? `${item.label}  ${secondary}` : item.label;
      const displayText = await this.truncateWithEllipsis(surfaceId, fullText, maxTextWidth, font);

      // If both parts fit (or partially), render label portion in label color
      // and secondary portion in tertiary color
      const labelPrefix = item.label;
      const separator = '  ';
      if (secondary && displayText.length > labelPrefix.length + separator.length) {
        // Label part is fully visible; render it, then the secondary remainder
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: textX, y: itemY + this.itemHeight / 2,
            text: labelPrefix + separator,
            font,
            fill: labelColor,
            baseline: 'middle',
          },
        });
        const labelPartWidth = await this.measureText(surfaceId, labelPrefix + separator, font);
        const secondaryPart = displayText.slice(labelPrefix.length + separator.length);
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: textX + labelPartWidth, y: itemY + this.itemHeight / 2,
            text: secondaryPart,
            font: secondaryFont,
            fill: this.theme.textTertiary,
            baseline: 'middle',
          },
        });
      } else {
        // Everything in label color (secondary didn't fit or doesn't exist)
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: textX, y: itemY + this.itemHeight / 2,
            text: displayText,
            font,
            fill: labelColor,
            baseline: 'middle',
          },
        });
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    // Scrollbar
    if (this.totalContentHeight > listH) {
      const trackX = ox + w - SCROLLBAR_WIDTH;
      const trackH = listH;

      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: trackX, y: listY, width: SCROLLBAR_WIDTH, height: trackH,
          fill: this.theme.scrollbarTrack,
        },
      });

      const thumbRatio = listH / this.totalContentHeight;
      const thumbHeight = Math.max(20, trackH * thumbRatio);
      const scrollRatio = this.maxScroll > 0 ? this.scrollTop / this.maxScroll : 0;
      const thumbY = listY + scrollRatio * (trackH - thumbHeight);

      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: trackX + 1, y: thumbY, width: SCROLLBAR_WIDTH - 2, height: thumbHeight,
          radius: 3,
          fill: this.theme.scrollbarThumb,
        },
      });
    }

    return commands;
  }

  // ── Input handling ────────────────────────────────────────────────

  protected async processInput(
    input: Record<string, unknown>
  ): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'wheel') {
      const delta = input.deltaY as number;
      const oldScroll = this.scrollTop;
      this.scrollTop += delta > 0 ? SCROLL_STEP : -SCROLL_STEP;
      this.clampScrollTop();
      if (this.scrollTop !== oldScroll) {
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (type === 'mousedown') {
      const my = input.y as number;
      const mx = input.x as number;

      // Click in search area?
      if (this.searchable && my < this.listTop) {
        this.searchFocused = true;
        await this.requestRedraw();
        return { consumed: true };
      }

      // Click in list area
      this.searchFocused = false;
      this.ensureLayout();
      const listLocalY = my - this.listTop + this.scrollTop;
      const clickedIndex = this.rowIndexAt(listLocalY);

      // Rich-row action buttons take priority over row selection. Geometry is
      // computed in local widget coords (matching mx/my) so it lines up with
      // what buildRichRow drew in absolute coords.
      const clickedItem =
        clickedIndex >= 0 && clickedIndex < this.filteredItems.length
          ? this.filteredItems[clickedIndex]
          : undefined;
      if (clickedItem && this.isRichItem(clickedItem) && clickedItem.actions?.length) {
        const rowTopY = this.listTop + this._rowTops[clickedIndex] - this.scrollTop;
        const rowH = this._rowTops[clickedIndex + 1] - this._rowTops[clickedIndex];
        const g = this.richRowGeometry(0, rowTopY, rowH, this.rect.width, clickedItem);
        for (const a of g.actions) {
          if (mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.y + a.h) {
            this.changed('action', JSON.stringify({
              index: clickedIndex,
              value: clickedItem.value,
              actionId: a.spec.id,
            }));
            return { consumed: true };
          }
        }
      }

      if (clickedIndex >= 0 && clickedIndex < this.filteredItems.length) {
        this.selectedIndex = clickedIndex;
        await this.requestRedraw();
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
          this.changed('selectionChanged', JSON.stringify({
            index: this.selectedIndex,
            value: item.value,
            label: item.label,
            via: 'click',
          }));
        }
      }
      return { consumed: true };
    }

    if (type === 'mousemove') {
      const my = input.y as number;
      if (my >= this.listTop) {
        this.ensureLayout();
        const listLocalY = my - this.listTop + this.scrollTop;
        const hoverIdx = this.rowIndexAt(listLocalY);
        if (hoverIdx !== this.hoveredIndex && hoverIdx >= 0 && hoverIdx < this.filteredItems.length) {
          this.hoveredIndex = hoverIdx;
          await this.requestRedraw();
        }
      }
      return { consumed: true };
    }

    if (type === 'mouseleave') {
      if (this.hoveredIndex !== -1) {
        this.hoveredIndex = -1;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (type === 'keydown') {
      return this.handleKeyDown(input);
    }

    if (type === 'paste' && this.searchFocused && this.searchable) {
      const pasteText = (input.pasteText as string) ?? '';
      if (pasteText) {
        this.searchText =
          this.searchText.substring(0, this.searchCursorPos) +
          pasteText +
          this.searchText.substring(this.searchCursorPos);
        this.searchCursorPos += pasteText.length;
        this.applyFilter();
        this.selectedIndex = -1;
        this.scrollTop = 0;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  private async handleKeyDown(
    input: Record<string, unknown>
  ): Promise<{ consumed: boolean }> {
    const key = (input.key as string) ?? '';
    const modifiers = input.modifiers as
      | { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
      | undefined;
    const ctrl = modifiers?.ctrl ?? false;
    const meta = modifiers?.meta ?? false;

    // Search input handling
    if (this.searchFocused && this.searchable) {
      if (key === 'Escape') {
        this.searchFocused = false;
        await this.requestRedraw();
        return { consumed: true };
      }
      if (key === 'ArrowDown') {
        // Transfer focus to list
        this.searchFocused = false;
        if (this.filteredItems.length > 0 && this.selectedIndex < 0) {
          this.selectedIndex = 0;
          this.ensureSelectedVisible();
          const item = this.filteredItems[0];
          if (item) {
            this.changed('selectionChanged', JSON.stringify({
              index: 0,
              value: item.value,
              label: item.label,
            }));
          }
        }
        await this.requestRedraw();
        return { consumed: true };
      }
      if (key === 'Backspace') {
        if (this.searchCursorPos > 0) {
          this.searchText =
            this.searchText.substring(0, this.searchCursorPos - 1) +
            this.searchText.substring(this.searchCursorPos);
          this.searchCursorPos--;
          this.applyFilter();
          this.selectedIndex = -1;
          this.scrollTop = 0;
          await this.requestRedraw();
        }
        return { consumed: true };
      }
      if (key === 'Delete') {
        if (this.searchCursorPos < this.searchText.length) {
          this.searchText =
            this.searchText.substring(0, this.searchCursorPos) +
            this.searchText.substring(this.searchCursorPos + 1);
          this.applyFilter();
          this.selectedIndex = -1;
          this.scrollTop = 0;
          await this.requestRedraw();
        }
        return { consumed: true };
      }
      if (key === 'ArrowLeft' && this.searchCursorPos > 0) {
        this.searchCursorPos--;
        await this.requestRedraw();
        return { consumed: true };
      }
      if (key === 'ArrowRight' && this.searchCursorPos < this.searchText.length) {
        this.searchCursorPos++;
        await this.requestRedraw();
        return { consumed: true };
      }
      if (key === 'Home') {
        this.searchCursorPos = 0;
        await this.requestRedraw();
        return { consumed: true };
      }
      if (key === 'End') {
        this.searchCursorPos = this.searchText.length;
        await this.requestRedraw();
        return { consumed: true };
      }
      if (key.length === 1 && !ctrl && !meta) {
        this.searchText =
          this.searchText.substring(0, this.searchCursorPos) +
          key +
          this.searchText.substring(this.searchCursorPos);
        this.searchCursorPos++;
        this.applyFilter();
        this.selectedIndex = -1;
        this.scrollTop = 0;
        await this.requestRedraw();
        return { consumed: true };
      }
      return { consumed: true };
    }

    // List navigation
    if (key === 'ArrowUp') {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.ensureSelectedVisible();
        await this.requestRedraw();
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
          this.changed('selectionChanged', JSON.stringify({
            index: this.selectedIndex,
            value: item.value,
            label: item.label,
          }));
        }
      } else if (this.searchable) {
        // Move focus to search
        this.searchFocused = true;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'ArrowDown') {
      if (this.selectedIndex < this.filteredItems.length - 1) {
        this.selectedIndex++;
        this.ensureSelectedVisible();
        await this.requestRedraw();
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
          this.changed('selectionChanged', JSON.stringify({
            index: this.selectedIndex,
            value: item.value,
            label: item.label,
          }));
        }
      }
      return { consumed: true };
    }

    if (key === 'Enter' && this.selectedIndex >= 0) {
      const item = this.filteredItems[this.selectedIndex];
      if (item) {
        this.changed('confirm', JSON.stringify({
          index: this.selectedIndex,
          value: item.value,
          label: item.label,
        }));
      }
      return { consumed: true };
    }

    // Type-ahead: if a printable key is pressed while list is focused and searchable
    if (this.searchable && key.length === 1 && !ctrl && !meta) {
      this.searchFocused = true;
      this.searchText += key;
      this.searchCursorPos = this.searchText.length;
      this.applyFilter();
      this.selectedIndex = -1;
      this.scrollTop = 0;
      await this.requestRedraw();
      return { consumed: true };
    }

    return { consumed: false };
  }

  // ── Value and update ──────────────────────────────────────────────

  protected getWidgetValue(): string {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredItems.length) {
      return this.filteredItems[this.selectedIndex].value;
    }
    return '';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.items !== undefined && Array.isArray(updates.items)) {
      this.items = updates.items as ListItem[];
      this.applyFilter(); // also invalidates layout
      // Reset selection if out of range
      if (this.selectedIndex >= this.filteredItems.length) {
        this.selectedIndex = -1;
      }
      this.clampScrollTop();
    }
    if (updates.selectedIndex !== undefined) {
      this.selectedIndex = updates.selectedIndex as number;
      this.ensureSelectedVisible();
    }
    if (updates.searchText !== undefined) {
      this.searchText = updates.searchText as string;
      this.searchCursorPos = this.searchText.length;
      this.applyFilter();
      this.clampScrollTop();
    }
    if (updates.itemHeight !== undefined) {
      this._itemHeight = updates.itemHeight as number;
      this.invalidateLayout();
    }
  }
}
