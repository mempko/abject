/**
 * TabBarWidget — horizontal tab bar with selectable tabs.
 *
 * Divides its width equally among tabs. The active tab gets an accent-colored
 * bottom border and primary text color. Inactive tabs use secondary text.
 * Clicking a tab switches the selection and emits a 'change' notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { lightenColor } from './widget-types.js';

export interface TabBarConfig extends WidgetConfig {
  tabs?: string[];
  selectedIndex?: number;
}

export class TabBarWidget extends WidgetAbject {
  private tabs: string[];
  private selectedIndex: number;
  private hoveredIndex = -1;

  constructor(config: TabBarConfig) {
    super(config);
    this.tabs = config.tabs ?? [];
    this.selectedIndex = config.selectedIndex ?? 0;
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const tabCount = this.tabs.length;
    if (tabCount === 0) return commands;

    const tabWidth = w / tabCount;

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    for (let i = 0; i < tabCount; i++) {
      const tx = ox + i * tabWidth;
      const isActive = i === this.selectedIndex;
      const isHovered = i === this.hoveredIndex && !isActive;

      // Tab background
      let fill = this.theme.windowBg;
      if (isActive) {
        fill = lightenColor(this.theme.windowBg, 8);
      } else if (isHovered) {
        fill = lightenColor(this.theme.windowBg, 12);
      }

      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: tx, y: oy, width: tabWidth, height: h,
          fill,
        },
      });

      // Tab label
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: tx + tabWidth / 2,
          y: oy + h / 2 - 1,
          text: this.tabs[i],
          font,
          fill: isActive
            ? (style.color ?? this.theme.textPrimary)
            : this.theme.textSecondary,
          align: 'center',
          baseline: 'middle',
        },
      });

      // Active tab bottom accent border
      if (isActive) {
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: tx, y: oy + h - 3, width: tabWidth, height: 3,
            fill: this.theme.accent,
          },
        });
      }
    }

    // Full-width bottom divider line
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy + h - 1, width: w, height: 1,
        fill: this.theme.divider,
      },
    });

    // Close disabled alpha save
    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const tabCount = this.tabs.length;
    if (tabCount === 0) return { consumed: false };

    const tabWidth = this.rect.width / tabCount;

    if (input.type === 'mousedown') {
      const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
      const idx = Math.min(Math.floor(localX / tabWidth), tabCount - 1);
      if (idx >= 0 && idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        await this.requestRedraw();
        this.changed('change', idx);
      }
      return { consumed: true };
    }

    if (input.type === 'mousemove') {
      const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
      const idx = Math.min(Math.floor(localX / tabWidth), tabCount - 1);
      if (idx !== this.hoveredIndex) {
        this.hoveredIndex = idx;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (input.type === 'mouseleave') {
      if (this.hoveredIndex !== -1) {
        this.hoveredIndex = -1;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (input.type === 'keydown' && this.focused) {
      const key = input.key as string;
      if (key === 'ArrowLeft' && this.selectedIndex > 0) {
        this.selectedIndex--;
        await this.requestRedraw();
        this.changed('change', this.selectedIndex);
        return { consumed: true };
      }
      if (key === 'ArrowRight' && this.selectedIndex < tabCount - 1) {
        this.selectedIndex++;
        await this.requestRedraw();
        this.changed('change', this.selectedIndex);
        return { consumed: true };
      }
    }

    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return String(this.selectedIndex);
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.tabs !== undefined && Array.isArray(updates.tabs)) {
      this.tabs = updates.tabs as string[];
    }
    if (updates.selectedIndex !== undefined) {
      this.selectedIndex = updates.selectedIndex as number;
    }
  }
}
