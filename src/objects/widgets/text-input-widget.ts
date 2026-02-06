/**
 * TextInputWidget -- single-line text input with cursor, placeholder, and masking.
 *
 * Renders a bordered input field with clipped text content. Supports cursor
 * positioning via click, keyboard navigation (Home/End/ArrowLeft/ArrowRight),
 * character insertion and deletion, masked display (bullets), placeholder text,
 * Enter-to-submit, and Tab-to-advance-focus (unconsumed, bubbles to Window).
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { WidgetStyle, Rect, WIDGET_FONT, CODE_FONT, DEFAULT_LINE_HEIGHT } from './widget-types.js';

export interface TextInputWidgetConfig extends WidgetConfig {
  placeholder?: string;
  masked?: boolean;
}

export class TextInputWidget extends WidgetAbject {
  private cursorPos = 0;
  private placeholder?: string;
  private masked: boolean;

  constructor(config: TextInputWidgetConfig) {
    super(config);
    this.placeholder = config.placeholder;
    this.masked = config.masked ?? false;
    this.cursorPos = (config.text ?? '').length;
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? 4;
    const focused = this.focused;

    // Border rect
    const borderColor = style.borderColor ?? (focused ? '#6a6aff' : '#555');
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox, y: oy, width: w, height: h,
        fill: style.background ?? '#151520',
        stroke: borderColor,
        radius,
      },
    });

    // Clip to prevent text overflow
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
    });

    const displayText = this.text
      ? (this.masked ? '\u2022'.repeat(this.text.length) : this.text)
      : '';
    const textPadding = 8;
    const textFont = style.fontSize ? font : WIDGET_FONT;

    if (displayText) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: oy + h / 2,
          text: displayText,
          font: textFont,
          fill: style.color ?? '#ddd',
          baseline: 'middle',
        },
      });
    } else if (this.placeholder && !focused) {
      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: ox + textPadding,
          y: oy + h / 2,
          text: this.placeholder,
          font: textFont,
          fill: '#555',
          baseline: 'middle',
        },
      });
    }

    // Cursor line when focused
    if (focused) {
      const cursorPos = this.cursorPos;
      const beforeCursor = this.masked
        ? '\u2022'.repeat(cursorPos)
        : this.text.substring(0, cursorPos);
      const cursorFont = style.fontSize ? font : WIDGET_FONT;
      const measuredWidth = beforeCursor.length > 0
        ? await this.measureText(surfaceId, beforeCursor, cursorFont)
        : 0;
      const cursorX = ox + textPadding + measuredWidth;
      commands.push({
        type: 'line',
        surfaceId,
        params: {
          x1: cursorX, y1: oy + 4,
          x2: cursorX, y2: oy + h - 4,
          stroke: '#8888ff',
        },
      });
    }

    commands.push({ type: 'restore', surfaceId, params: {} });
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    if (type === 'mousedown') {
      return this.handleMouseDown(input);
    }

    if (type === 'keydown') {
      return this.handleKeyDown(input);
    }

    if (type === 'paste') {
      return this.handlePaste(input);
    }

    return { consumed: false };
  }

  private async handleMouseDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const clickX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
    const textPadding = 8;
    const clickOffset = clickX - textPadding;

    if (this.text.length > 0 && clickOffset > 0) {
      const displayText = this.masked ? '\u2022'.repeat(this.text.length) : this.text;
      const surfaceId = input.surfaceId as string | undefined;
      const cursorFont = this.style.fontSize ? buildFont(this.style) : WIDGET_FONT;
      if (surfaceId) {
        const totalWidth = await this.measureText(surfaceId, displayText, cursorFont);
        const avgCharWidth = totalWidth / this.text.length;
        this.cursorPos = Math.max(0, Math.min(
          Math.round(clickOffset / avgCharWidth),
          this.text.length,
        ));
      } else {
        this.cursorPos = this.text.length;
      }
    } else {
      this.cursorPos = clickOffset <= 0 ? 0 : this.text.length;
    }

    await this.requestRedraw();
    return { consumed: true };
  }

  private async handleKeyDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const key = (input.key as string) ?? '';
    const modifiers = input.modifiers as { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | undefined;
    const pos = this.cursorPos;

    if (key === 'Backspace') {
      if (pos > 0) {
        this.text = this.text.substring(0, pos - 1) + this.text.substring(pos);
        this.cursorPos = pos - 1;
        this.changed('change', this.text);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Delete') {
      if (pos < this.text.length) {
        this.text = this.text.substring(0, pos) + this.text.substring(pos + 1);
        this.changed('change', this.text);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'ArrowLeft') {
      if (pos > 0) {
        this.cursorPos = pos - 1;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'ArrowRight') {
      if (pos < this.text.length) {
        this.cursorPos = pos + 1;
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    if (key === 'Home') {
      this.cursorPos = 0;
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'End') {
      this.cursorPos = this.text.length;
      await this.requestRedraw();
      return { consumed: true };
    }

    if (key === 'Enter') {
      this.changed('submit', this.text);
      return { consumed: true };
    }

    if (key === 'Tab') {
      // Not consumed -- bubbles to Window for focus advance
      return { consumed: false };
    }

    // Printable character
    if (key.length === 1 && !modifiers?.ctrl && !modifiers?.meta) {
      this.text = this.text.substring(0, pos) + key + this.text.substring(pos);
      this.cursorPos = pos + 1;
      this.changed('change', this.text);
      await this.requestRedraw();
      return { consumed: true };
    }

    return { consumed: true };
  }

  private async handlePaste(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const pasteText = (input.pasteText as string) ?? '';
    if (!pasteText) return { consumed: true };

    const pos = this.cursorPos;
    this.text = this.text.substring(0, pos) + pasteText + this.text.substring(pos);
    this.cursorPos = pos + pasteText.length;
    this.changed('change', this.text);
    await this.requestRedraw();
    return { consumed: true };
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.masked !== undefined) this.masked = updates.masked as boolean;
    if (updates.placeholder !== undefined) this.placeholder = updates.placeholder as string;
    // When text is set externally, reset cursor to end
    if (updates.text !== undefined) this.cursorPos = this.text.length;
  }
}
