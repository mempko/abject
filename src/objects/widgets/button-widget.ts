/**
 * ButtonWidget — a clickable button with centered text.
 *
 * Renders a flat print block with centered label text.
 * Consumes mousedown events and fires a 'click' change notification.
 */

import { AbjectId } from '../../core/types.js';
import { request } from '../../core/message.js';
import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { darkenColor, fontStacks, raisedBlock } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';
import { iconCommands, isIconName } from '../../ui/icons.js';

export class ButtonWidget extends WidgetAbject {
  private hovered = false;
  private pressed = false;

  // Tooltip service plumbing (only used when style.tooltip is set)
  private tooltipManagerId?: AbjectId;
  private tooltipActive = false;

  constructor(config: WidgetConfig) {
    super(config);
  }

  /**
   * A flat print block. Secondary buttons are a paper
   * face with an ink rule and a small hard shadow; primary buttons are a red
   * face in the display face. Press sinks the face into its shadow; hover
   * inverts. Flat buttons are bare rows: an ink band on hover and a red
   * block at the left edge when active (borderColor set).
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const theme = this.theme;
    const shape = shapeOf(theme);
    const radius = style.radius ?? 0;
    const baseFill = style.background ?? theme.buttonBg;
    const isPrimary = baseFill === theme.actionBg || baseFill === theme.accent;
    const live = !this.disabled;
    const hovered = this.hovered && live;
    const pressed = this.pressed && live;

    const size = style.fontSize ?? 14;
    const font = isPrimary
      ? `600 ${size}px ${fontStacks(theme).display}`
      : buildFont(style, theme);

    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    let face = { x: ox, y: oy, width: w, height: h };
    let textColor = style.color ?? (isPrimary ? theme.actionText : theme.buttonText);

    // Flat rows show the active marker only when borderColor stands apart
    // from the row's own fill (closed rows set the two equal).
    const hasMarker = !!style.flat && !!style.borderColor && style.borderColor !== baseFill;

    if (style.flat) {
      let fill: string | undefined = style.background;
      if (hovered || pressed) {
        fill = theme.textPrimary;
        textColor = theme.windowBg;
      }
      if (fill) {
        commands.push({ type: 'rect', surfaceId, params: { x: ox, y: oy, width: w, height: h, fill, radius } });
      }
      if (hasMarker) {
        // Active row marker: a solid block flush with the left edge.
        commands.push({ type: 'rect', surfaceId, params: { x: ox, y: oy, width: 4, height: h, fill: style.borderColor } });
      }
    } else {
      const block = raisedBlock(surfaceId, face, shape.blockShadowColor, 3, pressed);
      commands.push(...block.commands);
      face = block.face;
      let fill = baseFill;
      if (hovered) {
        if (isPrimary) {
          fill = darkenColor(baseFill, 36);
        } else if (style.background) {
          fill = darkenColor(baseFill, 18);
        } else {
          fill = theme.textPrimary;
          textColor = theme.windowBg;
        }
      }
      const lw = shape.ruleWidth;
      const stroke = style.borderColor ?? (isPrimary ? theme.actionBorder : theme.buttonBorder);
      commands.push({
        type: 'rect', surfaceId,
        params: { x: face.x, y: face.y, width: face.width, height: face.height, fill, radius },
      });
      commands.push({
        type: 'rect', surfaceId,
        params: {
          x: face.x + lw / 2, y: face.y + lw / 2,
          width: Math.max(0, face.width - lw), height: Math.max(0, face.height - lw),
          stroke, lineWidth: lw, radius,
        },
      });
    }

    if (this.focused && live) {
      const lw = 2;
      commands.push({
        type: 'rect', surfaceId,
        params: {
          x: face.x + lw / 2, y: face.y + lw / 2,
          width: Math.max(0, face.width - lw), height: Math.max(0, face.height - lw),
          stroke: shape.blockFocusColor, lineWidth: lw, radius,
        },
      });
    }

    commands.push(...await this.labelCommands(
      surfaceId, face, font, textColor, style.align ?? 'center', hasMarker ? 4 : 0,
    ));

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  /**
   * The button's label inside `area`: optional vector icon (style.icon) then
   * the text, truncated with an ellipsis to fit. With no text the icon is
   * centered. `leftPad` reserves room for a leading marker.
   */
  private async labelCommands(
    surfaceId: string,
    area: { x: number; y: number; width: number; height: number },
    font: string,
    color: string,
    align: 'left' | 'center' | 'right',
    leftPad: number,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const padding = 8;
    const cy = area.y + area.height / 2;
    const icon = this.style.icon && isIconName(this.style.icon) ? this.style.icon : undefined;
    const iconSize = icon ? Math.max(10, Math.min(16, area.height - 10)) : 0;
    const iconGap = icon && this.text ? 7 : 0;
    const iconSpan = iconSize + iconGap;

    const maxTextWidth = area.width - padding * 2 - leftPad - iconSpan;
    const displayText = this.text
      ? await this.truncateWithEllipsis(surfaceId, this.text, maxTextWidth, font)
      : '';
    const textW = icon && displayText && align !== 'left'
      ? await this.measureText(surfaceId, displayText, font)
      : 0;

    // Left edge of the icon+text group for each alignment.
    let groupX: number;
    if (align === 'left') groupX = area.x + padding + leftPad;
    else if (align === 'right') groupX = area.x + area.width - padding - iconSpan - textW;
    else groupX = area.x + leftPad / 2 + (area.width - leftPad - (iconSpan + textW)) / 2;

    if (icon) {
      commands.push(...iconCommands(icon, {
        surfaceId,
        x: Math.round(groupX), y: Math.round(cy - iconSize / 2), size: iconSize,
        color, caps: shapeOf(this.theme).iconCaps,
      }));
    }
    if (displayText) {
      const textX = icon ? groupX + iconSpan
        : align === 'center' ? area.x + area.width / 2 + leftPad / 2
        : align === 'right' ? area.x + area.width - padding
        : area.x + padding + leftPad;
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: textX, y: cy, text: displayText, font, fill: color,
          align: icon ? 'left' : align, baseline: 'middle',
        },
      });
    }
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
      this.pressed = true;
      this.cancelTooltip();
      // Click fires immediately so call sites don't need to wait for mouseup;
      // the visible press animation runs in parallel and is cleared on
      // mouseup or mouseleave below.
      this.changed('click', this.text);
      await this.requestRedraw();
      return { consumed: true };
    }
    if (input.type === 'mouseup') {
      if (this.pressed) {
        this.pressed = false;
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (input.type === 'mousemove') {
      if (!this.hovered) {
        this.hovered = true;
        this.requestTooltip(input);
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (input.type === 'mouseleave') {
      const wasInteracting = this.hovered || this.pressed;
      this.hovered = false;
      this.pressed = false;
      this.cancelTooltip();
      if (wasInteracting) await this.requestRedraw();
      return { consumed: true };
    }
    if (input.type === 'keydown' && this.focused) {
      const key = input.key as string;
      if (key === 'Enter' || key === ' ') {
        this.changed('click', this.text);
        return { consumed: true };
      }
    }
    return { consumed: false };
  }

  /**
   * Ask the WidgetManager tooltip service to show style.tooltip after a
   * dwell, anchored just right of this button. The widget's screen origin is
   * recovered from the event's global coordinates minus its local ones (the
   * dispatch chain re-localizes x/y at every layer but passes globalX/globalY
   * through untouched).
   */
  private requestTooltip(input: Record<string, unknown>): void {
    const text = this.style.tooltip;
    if (!text || this.disabled) return;
    const globalX = input.globalX as number | undefined;
    const globalY = input.globalY as number | undefined;
    if (globalX === undefined || globalY === undefined) return;
    const localX = (input.x as number | undefined) ?? 0;
    const localY = (input.y as number | undefined) ?? 0;
    const anchorX = globalX - localX + this.rect.width + 8;
    const anchorY = globalY - localY + this.rect.height / 2;
    this.tooltipActive = true;
    void (async () => {
      if (!this.tooltipManagerId) {
        this.tooltipManagerId = await this.discoverDep('WidgetManager') ?? undefined;
      }
      // Re-check: the hover may have ended while we were discovering.
      if (this.tooltipManagerId && this.tooltipActive) {
        this.send(request(this.id, this.tooltipManagerId, 'requestTooltip', { text, x: anchorX, y: anchorY }));
      }
    })();
  }

  private cancelTooltip(): void {
    if (!this.tooltipActive) return;
    this.tooltipActive = false;
    if (this.tooltipManagerId) {
      this.send(request(this.id, this.tooltipManagerId, 'cancelTooltip', {}));
    }
  }

  protected override suppressGenericFocusRing(): boolean {
    return true; // we paint our own focus glow
  }

  protected getWidgetValue(): string {
    return this.text;
  }

  protected applyUpdate(_updates: Record<string, unknown>): void {
    // No type-specific updates for buttons.
  }
}
