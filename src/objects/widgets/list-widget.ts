/**
 * ListWidget — a scrollable, selectable list with optional built-in search.
 *
 * Items have a label, value, and optional secondary text. Clicking an item
 * highlights it (stays selected). Emits 'selectionChanged' when selection
 * changes. Supports ArrowUp/Down navigation and mouse wheel scrolling.
 * Optional search filtering via `searchable: true`.
 *
 * Rich rows can be grouped (an item's `section` heads a run of rows), carry a
 * leading icon and a coloured note, and offer icon actions shown only on the
 * selected or hovered row (`actionsOn: 'active'`), which `keyActions` can fire
 * from the keyboard. A selection follows its item when the items change.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { fontStacks, withAlpha, inkFrame } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';
import { iconCommands, IconName } from '../../ui/icons.js';

/** A right-aligned inline action button on a rich list row. */
export interface ListActionSpec {
  id: string;
  label: string;
  /** Button fill color; defaults to theme.buttonBg. */
  color?: string;
  /** Button label color; defaults to theme.buttonText. */
  textColor?: string;
  /** Draw a square icon button in place of the label (the label stays its name). */
  iconName?: IconName;
  /** Frame color of an icon button; defaults to theme.inputBorder. */
  borderColor?: string;
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
  /** Group heading: a row whose section differs from the row above starts a group headed by it. */
  section?: string;
  /** A short coloured note after `detail` on a rich row's second line (a status). */
  note?: { text: string; color?: string };
}

export interface ListWidgetConfig extends WidgetConfig {
  items?: ListItem[];
  selectedIndex?: number;
  searchable?: boolean;
  itemHeight?: number;
  /** 'active': a rich row's actions show, and take clicks, only on the selected or hovered row. */
  actionsOn?: 'always' | 'active';
  /** Most title lines a rich row wraps to; a cut last line ends in an ellipsis. Default 4. */
  maxTitleLines?: number;
  /** 'flat': rows without frames, the selected one outlined in the accent. Default 'card'. */
  rowStyle?: 'card' | 'flat';
  /** The search box's empty text, drawn after a search icon. */
  searchPlaceholder?: string;
  /** Keys that fire an action of the selected row while the list (not its search) has focus: { key: actionId }. */
  keyActions?: Record<string, string>;
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
/** Height of a group heading above the first row of a section. */
const SECTION_H = 30;
/** Leading icon size in a rich row. */
const LEAD_ICON = 14;
/** Side of a square icon action button. */
const ICON_ACTION = 28;

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
  /** Per filtered row: the height of the group heading above it (0 for none), and the group's size. */
  private _headH: number[] = [];
  private _groupSize: number[] = [];
  private actionsOn: 'always' | 'active';
  private maxTitleLines: number;
  private rowStyle: 'card' | 'flat';
  private searchPlaceholder?: string;
  private keyActions: Record<string, string>;

  constructor(config: ListWidgetConfig) {
    super(config);
    this.items = config.items ?? [];
    this.filteredItems = [...this.items];
    this.selectedIndex = config.selectedIndex ?? -1;
    this.searchable = config.searchable ?? false;
    this._itemHeight = config.itemHeight ?? DEFAULT_ITEM_HEIGHT;
    this.actionsOn = config.actionsOn ?? 'always';
    this.maxTitleLines = Math.max(1, config.maxTitleLines ?? MAX_TITLE_LINES);
    this.rowStyle = config.rowStyle ?? 'card';
    this.searchPlaceholder = config.searchPlaceholder;
    this.keyActions = config.keyActions ?? {};
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
    const rows = this.filteredItems;
    this._headH = [];
    this._groupSize = [];
    for (let i = 0; i < rows.length; i++) {
      const section = rows[i].section;
      const starts = !!section && (i === 0 || rows[i - 1].section !== section);
      let size = 0;
      if (starts) while (i + size < rows.length && rows[i + size].section === section) size++;
      this._headH.push(starts ? SECTION_H : 0);
      this._groupSize.push(size);
      tops.push(tops[i] + this._headH[i] + this.rowHeightFor(rows[i], w));
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

  /** Index of the row containing local y (list-relative, scroll already applied); -1 on a group heading. */
  private rowIndexAt(localContentY: number): number {
    const tops = this._rowTops;
    if (localContentY < 0 || tops.length < 2) return -1;
    for (let i = 0; i < tops.length - 1; i++) {
      if (localContentY < tops[i + 1]) return localContentY < tops[i] + (this._headH[i] ?? 0) ? -1 : i;
    }
    return -1;
  }

  /** Whether row i shows its actions now. */
  private showsActions(i: number): boolean {
    return this.actionsOn === 'always' || i === this.selectedIndex || i === this.hoveredIndex;
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
    // An unsized list (items set before its layout placed it) has nothing to
    // scroll yet; scrolling now would leave the rows scrolled out of view.
    if (this.selectedIndex < 0 || this.listHeight <= 0) return;
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
   * dependency, and always reserves the actions' room, so a row keeps its
   * height when its actions show only on hover.
   */
  private richRowMetrics(item: ListItem, w: number): {
    cardW: number;
    iconX: number;
    badgeX: number;
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
    const iconX = leftX;
    if (item.iconName) leftX += LEAD_ICON + PAD;
    const badgeX = leftX;
    let badgeW = 0;
    if (item.badge) {
      badgeW = Math.max(34, item.badge.text.length * 7 + 14);
      leftX += badgeW + PAD;
    }

    const specs = item.actions ?? [];
    const actionWidths = specs.map((s) => s.iconName ? ICON_ACTION : Math.max(52, s.label.length * 6.5 + 20));
    const actionsTotal = actionWidths.reduce((a, b) => a + b + 6, 0);
    const textX = leftX;
    const textRight = specs.length ? cardX + cardW - PAD - actionsTotal - 2 : cardX + cardW - PAD;
    const textW = Math.max(10, textRight - textX);

    let lines = this.wrapText(item.label, textW, 13);
    if (lines.length > this.maxTitleLines) {
      lines = lines.slice(0, this.maxTitleLines);
      const maxChars = Math.max(4, Math.floor(textW / (13 * 0.52)));
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = `${last.length + 1 > maxChars ? last.slice(0, maxChars - 1).trimEnd() : last}\u2026`;
    }
    const hasDetail = (item.detail ?? item.secondary ?? '') !== '' || !!item.note;
    const contentH = lines.length * TITLE_LINE_H + (hasDetail ? DETAIL_LINE_H : 0);
    const actionH = specs.some((s) => s.iconName) ? ICON_ACTION : specs.length ? ACTION_HEIGHT : 0;
    const cardH = Math.max(contentH + CARD_PAD_V, BADGE_HEIGHT + CARD_PAD_V, actionH + CARD_PAD_V);
    const height = Math.max(cardH + CARD_GAP_V, RICH_MIN_ITEM_HEIGHT);

    return { cardW, iconX, badgeX, badgeW, textX, textW, actionWidths, lines, hasDetail, height };
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
    icon: { x: number; y: number } | null;
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

    // The icon and the badge sit on the first title line, so multi-line rows look right.
    const firstLineMid = card.y + CARD_PAD_V / 2 + TITLE_LINE_H / 2;
    const icon = item.iconName ? { x: originX + m.iconX, y: firstLineMid - LEAD_ICON / 2 } : null;
    let badge: { x: number; y: number; w: number; h: number } | null = null;
    if (item.badge) {
      badge = { x: originX + m.badgeX, y: firstLineMid - BADGE_HEIGHT / 2, w: m.badgeW, h: BADGE_HEIGHT };
    }

    const actions: Array<{ spec: ListActionSpec; x: number; y: number; w: number; h: number }> = [];
    const specs = item.actions ?? [];
    let rightX = cardX + m.cardW - PAD;
    for (let k = specs.length - 1; k >= 0; k--) {
      const bw = m.actionWidths[k];
      const bh = specs[k].iconName ? ICON_ACTION : ACTION_HEIGHT;
      rightX -= bw;
      actions.unshift({ spec: specs[k], x: rightX, y: card.y + (card.h - bh) / 2, w: bw, h: bh });
      rightX -= 6;
    }

    return { card, icon, badge, textX: originX + m.textX, textW: m.textW, lines: m.lines, hasDetail: m.hasDetail, actions };
  }

  private async buildRichRow(
    surfaceId: string,
    ox: number,
    itemY: number,
    rowHeight: number,
    w: number,
    item: ListItem,
    isSelected: boolean,
    isHovered: boolean,
    showActions: boolean
  ): Promise<unknown[]> {
    const cmds: unknown[] = [];
    const g = this.richRowGeometry(ox, itemY, rowHeight, w, item);
    const flat = this.rowStyle === 'flat';
    // The card style inverts the selected row into an ink band; flat keeps its colours.
    const inverted = isSelected && !flat;

    const card = { x: g.card.x, y: g.card.y, width: g.card.w, height: g.card.h };
    if (flat) {
      // Flat: rows sit on the ground; the selected one is outlined in the accent.
      if (isSelected || isHovered) {
        cmds.push({
          type: 'rect',
          surfaceId,
          params: { ...card, fill: isSelected ? this.theme.activeItemBg : withAlpha(this.theme.textPrimary, 0.05), radius: this.style.radius ?? 0 },
        });
      }
      if (isSelected) cmds.push(...inkFrame(surfaceId, card, this.theme.activeItemBorder, 1));
    } else {
      // Card surface: square paper slab with an ink hairline; the
      // selected card becomes an ink band with a red block at its left edge.
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          ...card,
          fill: isSelected
            ? this.theme.textPrimary
            : isHovered
              ? withAlpha(this.theme.textPrimary, 0.07)
              : this.theme.inputBg,
          radius: this.style.radius ?? 0,
        },
      });
      if (isSelected) {
        cmds.push({ type: 'rect', surfaceId, params: { x: card.x, y: card.y, width: 5, height: card.height, fill: this.theme.accent } });
      } else {
        cmds.push(...inkFrame(surfaceId, card, this.theme.inputBorder, 1));
      }
    }

    // Leading icon
    if (item.iconName && g.icon) {
      cmds.push(...iconCommands(item.iconName, {
        surfaceId, x: Math.round(g.icon.x), y: Math.round(g.icon.y), size: LEAD_ICON,
        color: item.iconColor ?? (inverted ? this.theme.windowBg : this.theme.textSecondary),
        caps: shapeOf(this.theme).iconCaps,
      }));
    }

    // Leading badge chip
    if (item.badge && g.badge) {
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          x: g.badge.x, y: g.badge.y, width: g.badge.w, height: g.badge.h,
          fill: item.badge.color ?? this.theme.accent,
          radius: 0,
        },
      });
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: g.badge.x + g.badge.w / 2, y: g.badge.y + g.badge.h / 2,
          text: item.badge.text,
          font: `600 11px ${fontStacks(this.theme).body}`,
          fill: item.badge.textColor ?? (!item.badge.color ? this.theme.actionText : this.theme.windowBg),
          align: 'center', baseline: 'middle',
        },
      });
    }

    // Word-wrapped title lines, then an optional muted detail line below,
    // with the note after it. `detail` is the explicit field; fall back to
    // `secondary` so a caller that reused the plain-row field still gets a
    // second line. Clip the text column (rather than passing maxWidth, which
    // horizontally squishes overflow) so any minor over-fill is cut off cleanly.
    const detailText = item.detail ?? item.secondary;
    const detailFont = `11px ${fontStacks(this.theme).body}`;
    const titleTop = g.card.y + CARD_PAD_V / 2;
    cmds.push({ type: 'save', surfaceId, params: {} });
    cmds.push({ type: 'clip', surfaceId, params: { x: g.textX, y: g.card.y, width: g.textW, height: g.card.h } });
    g.lines.forEach((line, i) => {
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: g.textX, y: titleTop + i * TITLE_LINE_H + TITLE_LINE_H / 2, text: line,
          font: `13px ${fontStacks(this.theme).body}`,
          fill: inverted ? this.theme.windowBg : this.theme.textPrimary,
          baseline: 'middle',
        },
      });
    });
    if (g.hasDetail) {
      const detailY = titleTop + g.lines.length * TITLE_LINE_H + DETAIL_LINE_H / 2;
      let noteX = g.textX;
      if (detailText) {
        cmds.push({
          type: 'text',
          surfaceId,
          params: {
            x: g.textX, y: detailY, text: detailText,
            font: detailFont,
            fill: inverted ? withAlpha(this.theme.windowBg, 0.75) : flat ? this.theme.textMeta : this.theme.textTertiary,
            baseline: 'middle',
          },
        });
        noteX += (await this.measureText(surfaceId, detailText, detailFont)) + 10;
      }
      if (item.note?.text) {
        cmds.push({
          type: 'text',
          surfaceId,
          params: {
            x: noteX, y: detailY, text: item.note.text,
            font: detailFont,
            fill: inverted ? this.theme.windowBg : item.note.color ?? this.theme.textSecondary,
            baseline: 'middle',
          },
        });
      }
    }
    cmds.push({ type: 'restore', surfaceId, params: {} });

    // Right-aligned action buttons
    if (!showActions) return cmds;
    for (const a of g.actions) {
      if (a.spec.iconName) {
        cmds.push({
          type: 'rect',
          surfaceId,
          params: {
            x: a.x, y: a.y, width: a.w, height: a.h,
            ...(a.spec.color ? { fill: a.spec.color } : {}),
            stroke: a.spec.borderColor ?? this.theme.inputBorder,
            radius: 0,
          },
        });
        cmds.push(...iconCommands(a.spec.iconName, {
          surfaceId, x: Math.round(a.x + (a.w - LEAD_ICON) / 2), y: Math.round(a.y + (a.h - LEAD_ICON) / 2), size: LEAD_ICON,
          color: a.spec.textColor ?? this.theme.buttonText, caps: shapeOf(this.theme).iconCaps,
        }));
        continue;
      }
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          x: a.x, y: a.y, width: a.w, height: a.h,
          fill: a.spec.color ?? this.theme.buttonBg,
          stroke: a.spec.color ? this.theme.buttonBorder : this.theme.inputBorder,
          radius: 0,
        },
      });
      cmds.push({
        type: 'text',
        surfaceId,
        params: {
          x: a.x + a.w / 2, y: a.y + a.h / 2,
          text: a.spec.label,
          font: `12px ${fontStacks(this.theme).body}`,
          fill: a.spec.textColor ?? this.theme.buttonText,
          align: 'center', baseline: 'middle',
        },
      });
    }

    return cmds;
  }

  /** A group heading: the section's name, a rule, and how many rows it holds. */
  private async sectionHeading(surfaceId: string, ox: number, y: number, w: number, label: string, count: number): Promise<unknown[]> {
    const stacks = fontStacks(this.theme);
    const labelFont = `500 11px ${stacks.display}`;
    const countFont = `11px ${stacks.mono}`;
    const text = label.toUpperCase();
    const countText = String(count);
    const midY = y + SECTION_H / 2 + 3;
    const left = ox + 8;
    const right = ox + w - SCROLLBAR_WIDTH - 8;
    const labelW = await this.measureText(surfaceId, text, labelFont);
    const countW = await this.measureText(surfaceId, countText, countFont);
    const cmds: unknown[] = [
      { type: 'text', surfaceId, params: { x: left, y: midY, text, font: labelFont, fill: this.theme.textSecondary, baseline: 'middle' } },
      { type: 'text', surfaceId, params: { x: right, y: midY, text: countText, font: countFont, fill: this.theme.textMeta, align: 'right', baseline: 'middle' } },
    ];
    const ruleFrom = left + labelW + 10;
    const ruleTo = right - countW - 10;
    if (ruleTo > ruleFrom) {
      cmds.push({ type: 'line', surfaceId, params: { x1: ruleFrom, y1: midY, x2: ruleTo, y2: midY, stroke: this.theme.divider, lineWidth: 1, lineCap: 'butt' } });
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
    if (this.rowStyle === 'flat') {
      // Flat rows sit on the window's ground, with no well around them.
      commands.push({ type: 'rect', surfaceId, params: { x: ox, y: oy, width: w, height: h, fill: this.theme.windowBg } });
    } else if (!this.style.radius) {
      // Square paper well inside an ink rule.
      commands.push({ type: 'rect', surfaceId, params: { x: ox, y: oy, width: w, height: h, fill: this.theme.inputBg } });
      commands.push(...inkFrame(surfaceId, { x: ox, y: oy, width: w, height: h }, this.theme.inputBorder, shapeOf(this.theme).ruleWidth));
    } else commands.push({
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
          fill: this.rowStyle === 'flat' ? this.theme.inputBg : this.theme.windowBg,
          stroke: borderColor,
          radius: 0,
        },
      });
      if (this.searchFocused) {
        // Focus: red frame plus a red bar on the left edge.
        commands.push(...inkFrame(surfaceId, { x: sx, y: sy, width: sw, height: sh }, this.theme.accent, 2));
        commands.push({ type: 'rect', surfaceId, params: { x: sx, y: sy, width: 4, height: sh, fill: this.theme.accent } });
      }

      // A configured placeholder comes with a search icon, and the text starts after it.
      const textInset = this.searchPlaceholder !== undefined ? 26 : 6;
      if (this.searchPlaceholder !== undefined) {
        commands.push(...iconCommands('search', {
          surfaceId, x: sx + 8, y: Math.round(sy + (sh - 12) / 2), size: 12,
          color: this.theme.textSecondary, caps: shapeOf(this.theme).iconCaps,
        }));
      }
      if (this.searchText) {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: sx + textInset, y: sy + sh / 2,
            text: this.searchText,
            font: `12px ${fontStacks(this.theme).body}`,
            fill: this.theme.textPrimary,
            baseline: 'middle',
          },
        });
      } else {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: sx + textInset, y: sy + sh / 2,
            text: this.searchPlaceholder ?? '\u{1F50D} Search...',
            font: `12px ${fontStacks(this.theme).body}`,
            fill: this.searchPlaceholder !== undefined ? this.theme.textMeta : this.theme.textPlaceholder,
            baseline: 'middle',
          },
        });
      }

      // Cursor
      if (this.searchFocused) {
        const beforeCursor = this.searchText.substring(0, this.searchCursorPos);
        const cursorX = sx + textInset + (beforeCursor.length > 0
          ? await this.measureText(surfaceId, beforeCursor, `12px ${fontStacks(this.theme).body}`)
          : 0);
        commands.push({
          type: 'line',
          surfaceId,
          params: {
            x1: cursorX, y1: sy + 4,
            x2: cursorX, y2: sy + sh - 4,
            stroke: this.theme.accent,
            lineWidth: 2, lineCap: 'square',
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

    const font = `13px ${fontStacks(this.theme).body}`;
    const secondaryFont = `11px ${fontStacks(this.theme).body}`;

    for (let i = 0; i < this.filteredItems.length; i++) {
      const rowTop = tops[i];
      const rowH = tops[i + 1] - rowTop;
      // Cull rows fully outside the viewport.
      if (rowTop + rowH < viewTop || rowTop > viewBottom) continue;

      const item = this.filteredItems[i];
      if (!item) continue;

      // A group heading sits in the top of the first row of its section.
      const headH = this._headH[i] ?? 0;
      if (headH > 0 && item.section) {
        commands.push(...await this.sectionHeading(surfaceId, ox, listY + rowTop - this.scrollTop, w, item.section, this._groupSize[i] ?? 0));
      }
      const itemY = listY + rowTop + headH - this.scrollTop;
      const isSelected = i === this.selectedIndex;
      const isHovered = i === this.hoveredIndex && !isSelected;

      // Rich (card) rows draw their own surface, badge, text, and buttons.
      if (this.isRichItem(item)) {
        commands.push(...await this.buildRichRow(surfaceId, ox, itemY, rowH - headH, w, item, isSelected, isHovered, this.showsActions(i)));
        continue;
      }

      // Selection/hover background
      if (isSelected && this.rowStyle === 'flat') {
        const band = { x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight };
        commands.push({ type: 'rect', surfaceId, params: { ...band, fill: this.theme.activeItemBg } });
        commands.push(...inkFrame(surfaceId, band, this.theme.activeItemBorder, 1));
      } else if (isSelected) {
        // Ink band with inverted text and a red block at the left.
        commands.push({ type: 'rect', surfaceId, params: { x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight, fill: this.theme.textPrimary } });
        commands.push({ type: 'rect', surfaceId, params: { x: ox + 2, y: itemY, width: 5, height: this.itemHeight, fill: this.theme.accent } });
      } else if (isHovered) {
        commands.push({ type: 'rect', surfaceId, params: { x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight, fill: withAlpha(this.theme.textPrimary, 0.07) } });
      }

      // Optional leading icon (status indicator). Drawn before the label so
      // we can shift the text origin right by iconSize+pad.
      const iconSize = item.iconName ? Math.min(14, this.itemHeight - 8) : 0;
      const iconPad = item.iconName ? 8 : 0;
      const textX = ox + 10 + iconSize + iconPad;
      if (item.iconName) {
        const iconColor = item.iconColor ?? (isSelected && this.rowStyle !== 'flat' ? this.theme.windowBg : this.theme.textSecondary);
        commands.push(...iconCommands(item.iconName, {
          surfaceId,
          x: ox + 10,
          y: itemY + (this.itemHeight - iconSize) / 2,
          size: iconSize,
          color: iconColor,
        }));
      }

      // Label + secondary as a single truncated line
      const inverted = isSelected && this.rowStyle !== 'flat';
      const labelColor = inverted ? this.theme.windowBg : this.theme.textPrimary;
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
            fill: inverted ? withAlpha(this.theme.windowBg, 0.75) : this.theme.textTertiary,
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
          radius: 0,
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
      if (clickedItem && this.isRichItem(clickedItem) && clickedItem.actions?.length && this.showsActions(clickedIndex)) {
        const headH = this._headH[clickedIndex] ?? 0;
        const rowTopY = this.listTop + this._rowTops[clickedIndex] + headH - this.scrollTop;
        const rowH = this._rowTops[clickedIndex + 1] - this._rowTops[clickedIndex] - headH;
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
        if (hoverIdx !== this.hoveredIndex && hoverIdx < this.filteredItems.length) {
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
              via: 'key',
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
            via: 'key',
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
            via: 'key',
          }));
        }
      }
      return { consumed: true };
    }

    // A key bound to an action fires it on the selected row, when the row offers it.
    const keyAction = this.keyActions[key];
    if (keyAction && this.selectedIndex >= 0) {
      const item = this.filteredItems[this.selectedIndex];
      if (item?.actions?.some((a) => a.id === keyAction)) {
        this.changed('action', JSON.stringify({
          index: this.selectedIndex,
          value: item.value,
          actionId: keyAction,
          via: 'key',
        }));
        return { consumed: true };
      }
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
      // The selection follows its item: rows that move or go must not leave
      // it on another one (a key action would act on the wrong row).
      const selectedValue = this.filteredItems[this.selectedIndex]?.value;
      this.items = updates.items as ListItem[];
      this.applyFilter(); // also invalidates layout
      this.selectedIndex = selectedValue === undefined ? -1
        : this.filteredItems.findIndex((item) => item.value === selectedValue);
      if (this.hoveredIndex >= this.filteredItems.length) this.hoveredIndex = -1;
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
