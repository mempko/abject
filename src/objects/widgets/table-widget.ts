/**
 * TableWidget — a sortable, selectable columnar data grid.
 *
 * Columns are declared with a key, header label, optional fixed width, and
 * optional alignment; columns without a width share the remaining width
 * equally. Rows are plain records keyed by column key. Clicking a header
 * sorts by that column (asc → desc → asc, stable, numeric when both values
 * are numbers); the sort happens on a copy so the caller's row order is
 * never mutated. Binds naturally to SQL query results: map each result
 * column to a column spec and pass the row objects straight through.
 *
 * Events (via changed()):
 *   rowSelected — JSON { index, row }  index into the CURRENT sorted view,
 *                 row included so owners never re-derive the sort
 *   cellEdited  — JSON { index, row, key, value }  after an inline edit
 *                 commits (only when editable: true; double-click a cell,
 *                 type, Enter commits, Escape cancels)
 *
 * Keyboard: ArrowUp/Down move selection, Enter re-emits rowSelected.
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { BODY_FONT_STACK, lightenColor } from './widget-types.js';

export interface TableColumnSpec {
  key: string;
  label: string;
  /** Fixed pixel width; columns without one share the remaining width. */
  width?: number;
  align?: 'left' | 'center' | 'right';
}

export interface TableWidgetConfig extends WidgetConfig {
  columns?: TableColumnSpec[];
  rowsData?: Record<string, unknown>[];
  /** Header-click sorting; default true. */
  sortable?: boolean;
  /** Double-click inline cell editing; default false. */
  editable?: boolean;
  rowHeight?: number;
}

const HEADER_HEIGHT = 28;
const DEFAULT_ROW_HEIGHT = 26;
const SCROLLBAR_WIDTH = 8;
const SCROLL_STEP = 30;
const CELL_PAD = 8;
const BODY_FONT = `13px ${BODY_FONT_STACK}`;
const HEADER_FONT = `600 12px ${BODY_FONT_STACK}`;
const DOUBLE_CLICK_MS = 400;

export class TableWidget extends WidgetAbject {
  private columns: TableColumnSpec[] = [];
  private rowsData: Record<string, unknown>[] = [];
  private sortable: boolean;
  private editable: boolean;
  private rowHeight: number;

  /** Indices into rowsData in display order (identity when unsorted). */
  private view: number[] = [];
  private sortKey: string | null = null;
  private sortDir: 1 | -1 = 1;

  private selectedIndex = -1; // index into view
  private hoveredIndex = -1;
  private scrollTop = 0;

  // Inline cell editing
  private editIndex = -1; // view index of the cell being edited
  private editKey: string | null = null;
  private editText = '';

  // Double-click detection
  private lastClickTime = 0;
  private lastClickIndex = -1;
  private lastClickKey: string | null = null;

  constructor(config: TableWidgetConfig) {
    super(config);
    this.columns = config.columns ?? [];
    this.rowsData = config.rowsData ?? [];
    this.sortable = config.sortable ?? true;
    this.editable = config.editable ?? false;
    this.rowHeight = config.rowHeight ?? DEFAULT_ROW_HEIGHT;
    this.rebuildView();
  }

  // ── Sorting / view ────────────────────────────────────────────────

  private rebuildView(): void {
    this.view = this.rowsData.map((_, i) => i);
    if (this.sortKey !== null) this.applySort();
  }

  /** Stable sort of the view by sortKey/sortDir; numbers compare numerically. */
  private applySort(): void {
    const key = this.sortKey;
    if (key === null) return;
    const dir = this.sortDir;
    const decorated = this.view.map((rowIdx, pos) => ({ rowIdx, pos }));
    decorated.sort((a, b) => {
      const av = this.rowsData[a.rowIdx]?.[key];
      const bv = this.rowsData[b.rowIdx]?.[key];
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else if (av === undefined || av === null) {
        cmp = bv === undefined || bv === null ? 0 : -1;
      } else if (bv === undefined || bv === null) {
        cmp = 1;
      } else {
        cmp = String(av).localeCompare(String(bv));
      }
      if (cmp !== 0) return cmp * dir;
      return a.pos - b.pos; // stable
    });
    this.view = decorated.map((d) => d.rowIdx);
  }

  private rowAt(viewIndex: number): Record<string, unknown> | undefined {
    const rowIdx = this.view[viewIndex];
    return rowIdx === undefined ? undefined : this.rowsData[rowIdx];
  }

  // ── Geometry ──────────────────────────────────────────────────────

  /** Per-column pixel widths; unspecified columns share the leftover space. */
  private columnWidths(w: number): number[] {
    const usable = Math.max(10, w - SCROLLBAR_WIDTH - 2);
    let fixedTotal = 0;
    let flexCount = 0;
    for (const c of this.columns) {
      if (c.width !== undefined) fixedTotal += c.width;
      else flexCount++;
    }
    const flexW = flexCount > 0
      ? Math.max(40, (usable - fixedTotal) / flexCount)
      : 0;
    return this.columns.map((c) => c.width ?? flexW);
  }

  private columnAtX(localX: number): { index: number; x: number; w: number } | null {
    const widths = this.columnWidths(this.rect.width);
    let x = 0;
    for (let i = 0; i < widths.length; i++) {
      if (localX >= x && localX < x + widths[i]) return { index: i, x, w: widths[i] };
      x += widths[i];
    }
    return null;
  }

  private get bodyHeight(): number {
    return Math.max(0, this.rect.height - HEADER_HEIGHT);
  }

  private get contentHeight(): number {
    return this.view.length * this.rowHeight;
  }

  private get maxScroll(): number {
    return Math.max(0, this.contentHeight - this.bodyHeight);
  }

  private clampScrollTop(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll));
  }

  private ensureSelectedVisible(): void {
    if (this.selectedIndex < 0) return;
    const top = this.selectedIndex * this.rowHeight;
    const bottom = top + this.rowHeight;
    if (top < this.scrollTop) this.scrollTop = top;
    else if (bottom > this.scrollTop + this.bodyHeight) this.scrollTop = bottom - this.bodyHeight;
    this.clampScrollTop();
  }

  // ── Rendering ─────────────────────────────────────────────────────

  protected async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const widths = this.columnWidths(w);

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

    // Header row
    {
      let cx = ox;
      for (let i = 0; i < this.columns.length; i++) {
        const col = this.columns[i];
        const cw = widths[i];
        const align = col.align ?? 'left';
        let label = col.label;
        if (this.sortKey === col.key) {
          label += this.sortDir === 1 ? ' ▲' : ' ▼';
        }
        const display = await this.truncateWithEllipsis(
          surfaceId, label, Math.max(4, cw - CELL_PAD * 2), HEADER_FONT);
        const tx = align === 'center' ? cx + cw / 2
          : align === 'right' ? cx + cw - CELL_PAD
          : cx + CELL_PAD;
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: tx, y: oy + HEADER_HEIGHT / 2,
            text: display, font: HEADER_FONT,
            fill: this.theme.textSecondary,
            align, baseline: 'middle',
          },
        });
        cx += cw;
      }
      // Accent underline separating header from body
      commands.push({
        type: 'line', surfaceId,
        params: {
          x1: ox + 2, y1: oy + HEADER_HEIGHT,
          x2: ox + w - 2, y2: oy + HEADER_HEIGHT,
          stroke: this.theme.accent, lineWidth: 1,
        },
      });
    }

    // Body rows (clipped, scrolled, culled)
    const bodyY = oy + HEADER_HEIGHT;
    const bodyH = this.bodyHeight;
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip', surfaceId,
      params: { x: ox, y: bodyY, width: w, height: bodyH },
    });

    const firstVisible = Math.max(0, Math.floor(this.scrollTop / this.rowHeight));
    const lastVisible = Math.min(
      this.view.length - 1,
      Math.ceil((this.scrollTop + bodyH) / this.rowHeight));

    for (let vi = firstVisible; vi <= lastVisible; vi++) {
      const row = this.rowAt(vi);
      if (!row) continue;
      const rowY = bodyY + vi * this.rowHeight - this.scrollTop;
      const isSelected = vi === this.selectedIndex;
      const isHovered = vi === this.hoveredIndex && !isSelected;

      // Zebra striping, then selection/hover on top of it
      if (isSelected) {
        commands.push({
          type: 'rect', surfaceId,
          params: {
            x: ox + 2, y: rowY, width: w - 4, height: this.rowHeight,
            fill: this.theme.selectionBg, radius: 3,
          },
        });
      } else if (isHovered) {
        commands.push({
          type: 'rect', surfaceId,
          params: {
            x: ox + 2, y: rowY, width: w - 4, height: this.rowHeight,
            fill: lightenColor(this.theme.inputBg, 8), radius: 3,
          },
        });
      } else if (vi % 2 === 1) {
        commands.push({
          type: 'rect', surfaceId,
          params: {
            x: ox + 2, y: rowY, width: w - 4, height: this.rowHeight,
            fill: lightenColor(this.theme.inputBg, 4),
          },
        });
      }

      let cx = ox;
      for (let i = 0; i < this.columns.length; i++) {
        const col = this.columns[i];
        const cw = widths[i];
        const align = col.align ?? 'left';
        const isEditing = vi === this.editIndex && col.key === this.editKey;
        const raw = isEditing
          ? this.editText + '|'
          : this.cellText(row[col.key]);
        const display = await this.truncateWithEllipsis(
          surfaceId, raw, Math.max(4, cw - CELL_PAD * 2), BODY_FONT);
        const tx = align === 'center' ? cx + cw / 2
          : align === 'right' ? cx + cw - CELL_PAD
          : cx + CELL_PAD;
        if (isEditing) {
          commands.push({
            type: 'rect', surfaceId,
            params: {
              x: cx + 2, y: rowY + 1, width: cw - 4, height: this.rowHeight - 2,
              fill: this.theme.windowBg,
              stroke: this.theme.inputBorderFocus,
              radius: 3,
            },
          });
        }
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: tx, y: rowY + this.rowHeight / 2,
            text: display, font: BODY_FONT,
            fill: isSelected ? this.theme.accent : this.theme.textPrimary,
            align, baseline: 'middle',
          },
        });
        cx += cw;
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    // Scrollbar
    if (this.contentHeight > bodyH) {
      const trackX = ox + w - SCROLLBAR_WIDTH;
      commands.push({
        type: 'rect', surfaceId,
        params: {
          x: trackX, y: bodyY, width: SCROLLBAR_WIDTH, height: bodyH,
          fill: this.theme.scrollbarTrack,
        },
      });
      const thumbRatio = bodyH / this.contentHeight;
      const thumbHeight = Math.max(20, bodyH * thumbRatio);
      const scrollRatio = this.maxScroll > 0 ? this.scrollTop / this.maxScroll : 0;
      const thumbY = bodyY + scrollRatio * (bodyH - thumbHeight);
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

  private cellText(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  }

  // ── Events ────────────────────────────────────────────────────────

  private emitRowSelected(): void {
    const row = this.rowAt(this.selectedIndex);
    if (!row) return;
    this.changed('rowSelected', JSON.stringify({ index: this.selectedIndex, row }));
  }

  private commitEdit(): void {
    if (this.editIndex < 0 || this.editKey === null) return;
    const viewIndex = this.editIndex;
    const key = this.editKey;
    const row = this.rowAt(viewIndex);
    this.editIndex = -1;
    this.editKey = null;
    if (!row) return;
    // Preserve the cell's numeric type when the original value was a number
    // and the edited text parses cleanly.
    const prev = row[key];
    const text = this.editText;
    let value: unknown = text;
    if (typeof prev === 'number' && text.trim() !== '' && !Number.isNaN(Number(text))) {
      value = Number(text);
    } else if (typeof prev === 'boolean' && (text === 'true' || text === 'false')) {
      value = text === 'true';
    }
    row[key] = value;
    this.changed('cellEdited', JSON.stringify({ index: viewIndex, row, key, value }));
  }

  private cancelEdit(): void {
    this.editIndex = -1;
    this.editKey = null;
    this.editText = '';
  }

  // ── Input ─────────────────────────────────────────────────────────

  protected async processInput(
    input: Record<string, unknown>,
  ): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'wheel') {
      const delta = input.deltaY as number;
      const old = this.scrollTop;
      this.scrollTop += delta > 0 ? SCROLL_STEP : -SCROLL_STEP;
      this.clampScrollTop();
      if (this.scrollTop !== old) await this.requestRedraw();
      return { consumed: true };
    }

    if (type === 'mousedown') {
      const mx = input.x as number;
      const my = input.y as number;

      // A click anywhere while editing commits the pending edit first.
      if (this.editIndex >= 0) {
        this.commitEdit();
        await this.requestRedraw();
      }

      // Header click: toggle sort on that column
      if (my < HEADER_HEIGHT) {
        if (!this.sortable) return { consumed: true };
        const hit = this.columnAtX(mx);
        if (hit) {
          const col = this.columns[hit.index];
          if (this.sortKey === col.key) {
            this.sortDir = this.sortDir === 1 ? -1 : 1;
          } else {
            this.sortKey = col.key;
            this.sortDir = 1;
          }
          const selectedRow = this.rowAt(this.selectedIndex);
          this.rebuildView();
          // Keep the same underlying row selected across the re-sort.
          if (selectedRow) {
            const rowIdx = this.rowsData.indexOf(selectedRow);
            this.selectedIndex = this.view.indexOf(rowIdx);
          }
          await this.requestRedraw();
        }
        return { consumed: true };
      }

      // Body click: select row (and maybe start an inline edit on double-click)
      const localY = my - HEADER_HEIGHT + this.scrollTop;
      const vi = Math.floor(localY / this.rowHeight);
      if (vi < 0 || vi >= this.view.length) return { consumed: true };

      const hit = this.columnAtX(mx);
      const key = hit ? this.columns[hit.index].key : null;
      const now = Date.now();
      const isDouble = now - this.lastClickTime < DOUBLE_CLICK_MS
        && this.lastClickIndex === vi && this.lastClickKey === key;
      this.lastClickTime = now;
      this.lastClickIndex = vi;
      this.lastClickKey = key;

      if (isDouble && this.editable && key !== null) {
        const row = this.rowAt(vi);
        if (row) {
          this.editIndex = vi;
          this.editKey = key;
          this.editText = this.cellText(row[key]);
          await this.requestRedraw();
          return { consumed: true };
        }
      }

      if (vi !== this.selectedIndex) {
        this.selectedIndex = vi;
        await this.requestRedraw();
      }
      this.emitRowSelected();
      return { consumed: true };
    }

    if (type === 'mousemove') {
      const my = input.y as number;
      if (my >= HEADER_HEIGHT) {
        const vi = Math.floor((my - HEADER_HEIGHT + this.scrollTop) / this.rowHeight);
        const next = vi >= 0 && vi < this.view.length ? vi : -1;
        if (next !== this.hoveredIndex) {
          this.hoveredIndex = next;
          await this.requestRedraw();
        }
      } else if (this.hoveredIndex !== -1) {
        this.hoveredIndex = -1;
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
      const modifiers = input.modifiers as { ctrl?: boolean; meta?: boolean } | undefined;
      const ctrl = (modifiers?.ctrl ?? false) || (modifiers?.meta ?? false);

      // Inline editor keys take priority
      if (this.editIndex >= 0) {
        if (key === 'Enter') {
          this.commitEdit();
          await this.requestRedraw();
          return { consumed: true };
        }
        if (key === 'Escape') {
          this.cancelEdit();
          await this.requestRedraw();
          return { consumed: true };
        }
        if (key === 'Backspace') {
          this.editText = this.editText.slice(0, -1);
          await this.requestRedraw();
          return { consumed: true };
        }
        if (key.length === 1 && !ctrl) {
          this.editText += key;
          await this.requestRedraw();
          return { consumed: true };
        }
        return { consumed: true };
      }

      if (key === 'ArrowUp') {
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
          this.ensureSelectedVisible();
          await this.requestRedraw();
          this.emitRowSelected();
        }
        return { consumed: true };
      }
      if (key === 'ArrowDown') {
        if (this.selectedIndex < this.view.length - 1) {
          this.selectedIndex++;
          this.ensureSelectedVisible();
          await this.requestRedraw();
          this.emitRowSelected();
        }
        return { consumed: true };
      }
      if (key === 'Enter' && this.selectedIndex >= 0) {
        this.emitRowSelected();
        return { consumed: true };
      }
      return { consumed: false };
    }

    return { consumed: false };
  }

  // ── Value / updates ───────────────────────────────────────────────

  protected getWidgetValue(): string {
    const row = this.rowAt(this.selectedIndex);
    return row ? JSON.stringify(row) : '';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.columns !== undefined && Array.isArray(updates.columns)) {
      this.columns = updates.columns as TableColumnSpec[];
      // New column set invalidates the sort and the selection.
      this.sortKey = null;
      this.sortDir = 1;
      this.selectedIndex = -1;
      this.cancelEdit();
      this.rebuildView();
      this.clampScrollTop();
    }
    if (updates.rowsData !== undefined && Array.isArray(updates.rowsData)) {
      this.rowsData = updates.rowsData as Record<string, unknown>[];
      this.cancelEdit();
      // Keep the sort; selection index cannot survive a data swap.
      this.selectedIndex = -1;
      this.rebuildView();
      this.clampScrollTop();
    }
    if (updates.rowHeight !== undefined && typeof updates.rowHeight === 'number') {
      this.rowHeight = updates.rowHeight;
      this.clampScrollTop();
    }
  }
}
