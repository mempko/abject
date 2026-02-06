/**
 * SelectWidget -- dropdown selection widget with expandable option list.
 *
 * Renders a collapsed button-like element showing the selected option with a
 * down-arrow indicator. When clicked, expands to show a dropdown list of options
 * with hover highlighting. Selecting an option closes the dropdown and fires a
 * 'change' notification. Clicking outside the dropdown closes it without
 * consuming the event (allowing the click to propagate).
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';

export interface SelectWidgetConfig extends WidgetConfig {
  options?: string[];
  selectedIndex?: number;
}

export class SelectWidget extends WidgetAbject {
  private options: string[];
  private selectedIndex: number;
  private expanded = false;
  private hoveredOption?: number;

  constructor(config: SelectWidgetConfig) {
    super(config);
    this.options = config.options ?? [];
    this.selectedIndex = config.selectedIndex ?? 0;
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? 4;
    const options = this.options;
    const selectedIndex = this.selectedIndex;
    const selectedText = options[selectedIndex] ?? '';

    // Collapsed: button-like appearance
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: style.background ?? '#2a2a3e',
        stroke: style.borderColor ?? '#555',
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
        fill: style.color ?? '#ddd',
        baseline: 'middle',
      },
    });

    // Down arrow
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: ox + w - 20,
        y: oy + h / 2,
        text: '\u25be',
        font,
        fill: style.color ?? '#888',
        baseline: 'middle',
      },
    });

    // Expanded dropdown
    if (this.expanded) {
      const optionHeight = h;
      const dropdownH = options.length * optionHeight;

      // Dropdown background
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox, y: oy + h, width: w, height: dropdownH,
          fill: style.background ?? '#2a2a3e',
          stroke: style.borderColor ?? '#555',
          radius: 2,
        },
      });

      for (let i = 0; i < options.length; i++) {
        const optY = oy + h + i * optionHeight;
        const isHovered = this.hoveredOption === i;

        if (isHovered) {
          commands.push({
            type: 'rect',
            surfaceId,
            params: {
              x: ox + 1, y: optY, width: w - 2, height: optionHeight,
              fill: '#4a4a6e',
            },
          });
        }

        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + 8,
            y: optY + optionHeight / 2,
            text: options[i],
            font,
            fill: style.color ?? '#ddd',
            baseline: 'middle',
          },
        });
      }
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

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const clickY = (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0;
    const wr = this.rect;
    const options = this.options;
    const optionHeight = wr.height;

    if (!this.expanded) {
      // Toggle expanded
      this.expanded = !this.expanded;
      this.changed('expanded', this.expanded);
      await this.requestRedraw();
      return { consumed: true };
    }

    // Expanded: check if click is in dropdown area
    if (clickY >= wr.height && clickY < wr.height + options.length * optionHeight &&
        clickX >= 0 && clickX < wr.width) {
      const clickedIndex = Math.floor((clickY - wr.height) / optionHeight);
      if (clickedIndex >= 0 && clickedIndex < options.length) {
        this.selectedIndex = clickedIndex;
        this.expanded = false;
        this.hoveredOption = undefined;
        this.changed('change', options[clickedIndex]);
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
    const options = this.options;
    const optionHeight = wr.height;

    // Check if mouse is in dropdown area
    if (clickX >= 0 && clickX < wr.width &&
        clickY >= wr.height && clickY < wr.height + options.length * optionHeight) {
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
    return this.options[this.selectedIndex] ?? '';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.options !== undefined) this.options = updates.options as string[];
    if (updates.selectedIndex !== undefined) this.selectedIndex = updates.selectedIndex as number;
  }
}
