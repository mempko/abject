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
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';

export type SelectOption = string | { label: string; value: string };

export interface SelectWidgetConfig extends WidgetConfig {
  options?: SelectOption[];
  selectedIndex?: number;
}

export class SelectWidget extends WidgetAbject {
  private labels: string[];
  private values: string[];
  private selectedIndex: number;
  private expanded = false;
  private hoveredOption?: number;

  constructor(config: SelectWidgetConfig) {
    super(config);
    const { labels, values } = SelectWidget.normalizeOptions(config.options ?? []);
    this.labels = labels;
    this.values = values;
    this.selectedIndex = config.selectedIndex ?? 0;
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

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;
    const labels = this.labels;
    const selectedIndex = this.selectedIndex;
    const selectedText = labels[selectedIndex] ?? '';

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    // Focus ring glow
    if (this.focused && !this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId,
        params: { color: this.theme.inputBorderFocus, blur: 6 },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill: style.background ?? this.theme.selectBg, stroke: this.theme.inputBorderFocus, radius },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Collapsed: button-like appearance
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: style.background ?? this.theme.selectBg,
        stroke: style.borderColor ?? this.theme.buttonBorder,
        radius,
      },
    });

    // Selected text
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: ox + 8,
        y: oy + h / 2,
        text: selectedText,
        font,
        fill: style.color ?? this.theme.textSecondary,
        baseline: 'middle',
      },
    });

    // Down arrow (polygon triangle)
    commands.push({
      type: 'polygon',
      surfaceId,
      params: {
        points: [
          { x: ox + w - 20, y: oy + h / 2 - 3 },
          { x: ox + w - 10, y: oy + h / 2 - 3 },
          { x: ox + w - 15, y: oy + h / 2 + 3 },
        ],
        fill: this.theme.selectArrow,
      },
    });

    // Expanded dropdown
    if (this.expanded) {
      const optionHeight = h;
      const dropdownH = labels.length * optionHeight;

      // Dropdown shadow
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId,
        params: { color: this.theme.dropdownShadow, blur: 8, offsetY: 2 },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox, y: oy + h, width: w, height: dropdownH,
          fill: style.background ?? this.theme.selectBg,
          radius: 2,
        },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });

      // Dropdown background (without shadow)
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox, y: oy + h, width: w, height: dropdownH,
          fill: style.background ?? this.theme.selectBg,
          stroke: style.borderColor ?? this.theme.buttonBorder,
          radius: 2,
        },
      });

      for (let i = 0; i < labels.length; i++) {
        const optY = oy + h + i * optionHeight;
        const isHovered = this.hoveredOption === i;

        if (isHovered) {
          commands.push({
            type: 'rect',
            surfaceId,
            params: {
              x: ox + 1, y: optY, width: w - 2, height: optionHeight,
              fill: this.theme.selectHover,
            },
          });
        }

        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + 8,
            y: optY + optionHeight / 2,
            text: labels[i],
            font,
            fill: style.color ?? this.theme.textSecondary,
            baseline: 'middle',
          },
        });
      }
    }

    // Close disabled alpha save
    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'mousedown') {
      return this.handleMouseDown(input);
    }

    if (type === 'mousemove') {
      return this.handleMouseMove(input);
    }

    if (type === 'keydown' && this.focused) {
      return this.handleKeyDown(input);
    }

    return { consumed: false };
  }

  private async handleKeyDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const key = input.key as string;
    const labels = this.labels;

    if (!this.expanded) {
      // Collapsed: Enter or Space opens the dropdown
      if (key === 'Enter' || key === ' ') {
        this.expanded = true;
        this.hoveredOption = this.selectedIndex;
        this.changed('expanded', true);
        await this.requestRedraw();
        return { consumed: true };
      }
      return { consumed: false };
    }

    // Expanded: keyboard navigation
    if (key === 'ArrowDown') {
      const next = ((this.hoveredOption ?? this.selectedIndex) + 1) % labels.length;
      this.hoveredOption = next;
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'ArrowUp') {
      const prev = ((this.hoveredOption ?? this.selectedIndex) - 1 + labels.length) % labels.length;
      this.hoveredOption = prev;
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Enter') {
      const idx = this.hoveredOption ?? this.selectedIndex;
      if (idx >= 0 && idx < labels.length) {
        this.selectedIndex = idx;
        this.expanded = false;
        this.hoveredOption = undefined;
        this.changed('change', this.values[idx]);
        this.changed('expanded', false);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Escape') {
      this.expanded = false;
      this.hoveredOption = undefined;
      this.changed('expanded', false);
      await this.requestRedraw();
      return { consumed: true };
    }

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const wr = this.rect;
    const labels = this.labels;
    const optionHeight = wr.height;

    if (!this.expanded) {
      // Toggle expanded
      this.expanded = !this.expanded;
      this.changed('expanded', this.expanded);
      await this.requestRedraw();
      return { consumed: true };
    }

    // Expanded: check if click is in dropdown area
    if (clickY >= wr.height && clickY < wr.height + labels.length * optionHeight &&
        clickX >= 0 && clickX < wr.width) {
      const clickedIndex = Math.floor((clickY - wr.height) / optionHeight);
      if (clickedIndex >= 0 && clickedIndex < labels.length) {
        this.selectedIndex = clickedIndex;
        this.expanded = false;
        this.hoveredOption = undefined;
        this.changed('change', this.values[clickedIndex]);
        this.changed('expanded', false);
        await this.requestRedraw();
        return { consumed: true };
      }
    }

    // Click outside dropdown: close it, do NOT consume (let event bubble)
    this.expanded = false;
    this.hoveredOption = undefined;
    this.changed('expanded', false);
    await this.requestRedraw();
    return { consumed: false };
  }

  private async handleMouseMove(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (!this.expanded) return { consumed: false };

    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const wr = this.rect;
    const labels = this.labels;
    const optionHeight = wr.height;

    // Check if mouse is in dropdown area
    if (clickX >= 0 && clickX < wr.width &&
        clickY >= wr.height && clickY < wr.height + labels.length * optionHeight) {
      const hoveredIndex = Math.floor((clickY - wr.height) / optionHeight);
      if (this.hoveredOption !== hoveredIndex) {
        this.hoveredOption = hoveredIndex;
        await this.requestRedraw();
      }
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
    }
    if (updates.selectedIndex !== undefined) this.selectedIndex = updates.selectedIndex as number;
  }
}
