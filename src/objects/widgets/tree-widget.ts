/**
 * TreeWidget -- a scrollable, hierarchical tree view.
 *
 * Items are provided as a flat array in display order. Each item has a depth
 * for indentation, optional expand/collapse arrow, icon, and secondary text.
 * The owner manages tree state (expand/collapse) and provides the flattened
 * visible items; this widget just renders and emits events.
 *
 * Events:
 *   selectionChanged — { id, label }
 *   toggle           — { id } (expand/collapse requested)
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { lightenColor } from './widget-types.js';
import { iconCommands, IconName } from '../../ui/icons.js';

export interface TreeItem {
  id: string;
  label: string;
  /** Legacy text glyph rendered as a single character. Prefer `iconName`. */
  icon?: string;
  /**
   * Vector icon drawn at the item's leading edge. Takes precedence over
   * `icon` when both are present so a row that opted in to vector glyphs
   * can drop the legacy field at its leisure.
   */
  iconName?: IconName;
  iconColor?: string;
  secondary?: string;
  depth: number;
  expanded?: boolean;
  hasChildren?: boolean;
}

export interface TreeWidgetConfig extends WidgetConfig {
  items?: TreeItem[];
  selectedId?: string;
  itemHeight?: number;
}

const DEFAULT_ITEM_HEIGHT = 24;
const INDENT_PX = 18;
const ARROW_WIDTH = 16;
const ICON_WIDTH = 16;
const SCROLLBAR_WIDTH = 8;
const SCROLL_STEP = 30;
const LEFT_PAD = 6;

export class TreeWidget extends WidgetAbject {
  private items: TreeItem[] = [];
  private selectedId = '';
  private hoveredIndex = -1;
  private scrollTop = 0;
  private itemHeight: number;

  constructor(config: TreeWidgetConfig) {
    super(config);
    this.items = config.items ?? [];
    this.selectedId = config.selectedId ?? '';
    this.itemHeight = config.itemHeight ?? DEFAULT_ITEM_HEIGHT;
  }

  // -- Scroll helpers --

  private get listHeight(): number {
    return this.rect.height;
  }

  private get totalContentHeight(): number {
    return this.items.length * this.itemHeight;
  }

  private get maxScroll(): number {
    return Math.max(0, this.totalContentHeight - this.listHeight);
  }

  private clampScrollTop(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll));
  }

  private ensureIdVisible(id: string): void {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) return;
    const itemTop = idx * this.itemHeight;
    const itemBottom = itemTop + this.itemHeight;
    if (itemTop < this.scrollTop) {
      this.scrollTop = itemTop;
    } else if (itemBottom > this.scrollTop + this.listHeight) {
      this.scrollTop = itemBottom - this.listHeight;
    }
    this.clampScrollTop();
  }

  // -- Rendering --

  protected async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;

    // Background
    commands.push({
      type: 'rect', surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: this.theme.inputBg,
        stroke: this.theme.inputBorder,
        radius: this.style.radius ?? this.theme.widgetRadius,
      },
    });

    // Clip
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip', surfaceId,
      params: { x: ox, y: oy, width: w, height: h },
    });

    // Visible range
    const firstVisible = Math.floor(this.scrollTop / this.itemHeight);
    const lastVisible = Math.min(
      this.items.length - 1,
      Math.floor((this.scrollTop + h) / this.itemHeight),
    );

    const font = '13px "Inter", system-ui, sans-serif';
    const secondaryFont = '11px "Inter", system-ui, sans-serif';

    for (let i = firstVisible; i <= lastVisible; i++) {
      const item = this.items[i];
      if (!item) continue;

      const itemY = oy + i * this.itemHeight - this.scrollTop;
      const isSelected = item.id === this.selectedId;
      const isHovered = i === this.hoveredIndex && !isSelected;
      const indent = LEFT_PAD + item.depth * INDENT_PX;

      // Selection / hover background
      if (isSelected) {
        commands.push({
          type: 'rect', surfaceId,
          params: {
            x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight,
            fill: this.theme.selectionBg, radius: 3,
          },
        });
      } else if (isHovered) {
        commands.push({
          type: 'rect', surfaceId,
          params: {
            x: ox + 2, y: itemY, width: w - 4, height: this.itemHeight,
            fill: lightenColor(this.theme.inputBg, 8), radius: 3,
          },
        });
      }

      let textX = ox + indent;

      // Expand/collapse arrow
      if (item.hasChildren) {
        const arrow = item.expanded ? '\u25BE' : '\u25B8'; // ▾ or ▸
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: textX, y: itemY + this.itemHeight / 2,
            text: arrow,
            font: '11px "Inter", system-ui, sans-serif',
            fill: this.theme.textSecondary,
            baseline: 'middle',
          },
        });
      }
      textX += ARROW_WIDTH;

      // Icon — vector iconName takes precedence; falls back to text glyph
      // when only the legacy `icon` field is set.
      const iconColor = item.iconColor ?? (isSelected ? this.theme.accent : this.theme.textSecondary);
      if (item.iconName) {
        const iconSize = Math.min(14, this.itemHeight - 6);
        commands.push(...iconCommands(item.iconName, {
          surfaceId,
          x: textX,
          y: itemY + (this.itemHeight - iconSize) / 2,
          size: iconSize,
          color: iconColor,
        }));
      } else if (item.icon) {
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: textX, y: itemY + this.itemHeight / 2,
            text: item.icon,
            font: '12px "Inter", system-ui, sans-serif',
            fill: iconColor,
            baseline: 'middle',
          },
        });
      }
      textX += ICON_WIDTH;

      // Label
      const labelColor = isSelected ? this.theme.accent : this.theme.textPrimary;
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: textX, y: itemY + this.itemHeight / 2,
          text: item.label,
          font,
          fill: labelColor,
          baseline: 'middle',
        },
      });

      // Secondary text (right-aligned)
      if (item.secondary) {
        commands.push({
          type: 'text', surfaceId,
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
    if (this.totalContentHeight > h) {
      const trackX = ox + w - SCROLLBAR_WIDTH;
      commands.push({
        type: 'rect', surfaceId,
        params: { x: trackX, y: oy, width: SCROLLBAR_WIDTH, height: h, fill: this.theme.scrollbarTrack },
      });
      const thumbRatio = h / this.totalContentHeight;
      const thumbHeight = Math.max(20, h * thumbRatio);
      const scrollRatio = this.maxScroll > 0 ? this.scrollTop / this.maxScroll : 0;
      const thumbY = oy + scrollRatio * (h - thumbHeight);
      commands.push({
        type: 'rect', surfaceId,
        params: {
          x: trackX + 1, y: thumbY, width: SCROLLBAR_WIDTH - 2, height: thumbHeight,
          radius: 3, fill: this.theme.scrollbarThumb,
        },
      });
    }

    return commands;
  }

  // -- Input handling --

  protected async processInput(
    input: Record<string, unknown>,
  ): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'wheel') {
      const delta = input.deltaY as number;
      const oldScroll = this.scrollTop;
      this.scrollTop += delta > 0 ? SCROLL_STEP : -SCROLL_STEP;
      this.clampScrollTop();
      if (this.scrollTop !== oldScroll) await this.requestRedraw();
      return { consumed: true };
    }

    if (type === 'mousedown') {
      const my = input.y as number;
      const localY = my + this.scrollTop;
      const clickedIndex = Math.floor(localY / this.itemHeight);
      const item = this.items[clickedIndex];
      if (!item) return { consumed: true };

      // Check if click is on the arrow area
      const mx = input.x as number;
      const arrowStart = LEFT_PAD + item.depth * INDENT_PX;
      const arrowEnd = arrowStart + ARROW_WIDTH;

      if (item.hasChildren && mx >= arrowStart && mx < arrowEnd) {
        // Toggle expand/collapse
        this.changed('toggle', JSON.stringify({ id: item.id }));
      } else {
        // Select
        this.selectedId = item.id;
        this.changed('selectionChanged', JSON.stringify({ id: item.id, label: item.label }));
      }
      await this.requestRedraw();
      return { consumed: true };
    }

    if (type === 'mousemove') {
      const my = input.y as number;
      const localY = my + this.scrollTop;
      const hoverIdx = Math.floor(localY / this.itemHeight);
      if (hoverIdx !== this.hoveredIndex && hoverIdx >= 0 && hoverIdx < this.items.length) {
        this.hoveredIndex = hoverIdx;
        await this.requestRedraw();
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
      const key = (input.key as string) ?? '';
      const selectedIdx = this.items.findIndex(i => i.id === this.selectedId);

      if (key === 'ArrowUp' && selectedIdx > 0) {
        const prev = this.items[selectedIdx - 1];
        if (prev) {
          this.selectedId = prev.id;
          this.ensureIdVisible(prev.id);
          this.changed('selectionChanged', JSON.stringify({ id: prev.id, label: prev.label }));
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if (key === 'ArrowDown' && selectedIdx < this.items.length - 1) {
        const next = this.items[selectedIdx + 1];
        if (next) {
          this.selectedId = next.id;
          this.ensureIdVisible(next.id);
          this.changed('selectionChanged', JSON.stringify({ id: next.id, label: next.label }));
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if ((key === 'ArrowRight' || key === 'Enter') && selectedIdx >= 0) {
        const item = this.items[selectedIdx];
        if (item?.hasChildren) {
          this.changed('toggle', JSON.stringify({ id: item.id }));
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      if (key === 'ArrowLeft' && selectedIdx >= 0) {
        const item = this.items[selectedIdx];
        if (item?.hasChildren && item.expanded) {
          this.changed('toggle', JSON.stringify({ id: item.id }));
          await this.requestRedraw();
        }
        return { consumed: true };
      }
    }

    return { consumed: false };
  }

  // -- Value and update --

  protected getWidgetValue(): string {
    return this.selectedId;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.items !== undefined && Array.isArray(updates.items)) {
      this.items = updates.items as TreeItem[];
      this.clampScrollTop();
    }
    if (updates.selectedId !== undefined) {
      this.selectedId = updates.selectedId as string;
      this.ensureIdVisible(this.selectedId);
    }
    if (updates.itemHeight !== undefined) {
      this.itemHeight = updates.itemHeight as number;
    }
  }
}
