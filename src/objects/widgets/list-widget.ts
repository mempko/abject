/**
 * ListWidget — a scrollable, selectable list with optional built-in search.
 *
 * Items have a label, value, and optional secondary text. Clicking an item
 * highlights it (stays selected). Emits 'selectionChanged' when selection
 * changes. Supports ArrowUp/Down navigation and mouse wheel scrolling.
 * Optional search filtering via `searchable: true`.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WIDGET_FONT, lightenColor } from './widget-types.js';

export interface ListItem {
  label: string;
  value: string;
  secondary?: string;
}

export interface ListWidgetConfig extends WidgetConfig {
  items?: ListItem[];
  selectedIndex?: number;
  searchable?: boolean;
  itemHeight?: number;
}

const DEFAULT_ITEM_HEIGHT = 26;
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
  private itemHeight: number;

  constructor(config: ListWidgetConfig) {
    super(config);
    this.items = config.items ?? [];
    this.filteredItems = [...this.items];
    this.selectedIndex = config.selectedIndex ?? -1;
    this.searchable = config.searchable ?? false;
    this.itemHeight = config.itemHeight ?? DEFAULT_ITEM_HEIGHT;
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
  }

  private get listTop(): number {
    return this.searchable ? SEARCH_HEIGHT + SEARCH_PADDING : 0;
  }

  private get listHeight(): number {
    return Math.max(0, this.rect.height - this.listTop);
  }

  private get totalContentHeight(): number {
    return this.filteredItems.length * this.itemHeight;
  }

  private get maxScroll(): number {
    return Math.max(0, this.totalContentHeight - this.listHeight);
  }

  private clampScrollTop(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll));
  }

  private ensureSelectedVisible(): void {
    if (this.selectedIndex < 0) return;
    const itemTop = this.selectedIndex * this.itemHeight;
    const itemBottom = itemTop + this.itemHeight;
    if (itemTop < this.scrollTop) {
      this.scrollTop = itemTop;
    } else if (itemBottom > this.scrollTop + this.listHeight) {
      this.scrollTop = itemBottom - this.listHeight;
    }
    this.clampScrollTop();
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
            font: '12px "Inter", system-ui, sans-serif',
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
            font: '12px "Inter", system-ui, sans-serif',
            fill: this.theme.textPlaceholder,
            baseline: 'middle',
          },
        });
      }

      // Cursor
      if (this.searchFocused) {
        const beforeCursor = this.searchText.substring(0, this.searchCursorPos);
        const cursorX = sx + 6 + (beforeCursor.length > 0
          ? await this.measureText(surfaceId, beforeCursor, '12px "Inter", system-ui, sans-serif')
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

    // Render visible items
    const firstVisible = Math.floor(this.scrollTop / this.itemHeight);
    const lastVisible = Math.min(
      this.filteredItems.length - 1,
      Math.floor((this.scrollTop + listH) / this.itemHeight)
    );

    const font = '13px "Inter", system-ui, sans-serif';
    const secondaryFont = '11px "Inter", system-ui, sans-serif';

    for (let i = firstVisible; i <= lastVisible; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;

      const itemY = listY + i * this.itemHeight - this.scrollTop;
      const isSelected = i === this.selectedIndex;
      const isHovered = i === this.hoveredIndex && !isSelected;

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

      // Label
      const labelColor = isSelected ? this.theme.accent : this.theme.textPrimary;
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + 10, y: itemY + this.itemHeight / 2,
          text: item.label,
          font,
          fill: labelColor,
          baseline: 'middle',
        },
      });

      // Secondary text (right-aligned)
      if (item.secondary) {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + w - 14, y: itemY + this.itemHeight / 2,
            text: item.secondary,
            font: secondaryFont,
            fill: this.theme.textTertiary,
            align: 'right',
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
      const listLocalY = my - this.listTop + this.scrollTop;
      const clickedIndex = Math.floor(listLocalY / this.itemHeight);

      if (clickedIndex >= 0 && clickedIndex < this.filteredItems.length) {
        this.selectedIndex = clickedIndex;
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

    if (type === 'mousemove') {
      const my = input.y as number;
      if (my >= this.listTop) {
        const listLocalY = my - this.listTop + this.scrollTop;
        const hoverIdx = Math.floor(listLocalY / this.itemHeight);
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
      this.applyFilter();
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
      this.itemHeight = updates.itemHeight as number;
    }
  }
}
