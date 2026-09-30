/**
 * ButtonWidget — a clickable button with centered text.
 *
 * Renders a flat print block with centered label text.
 * Consumes mousedown events and fires a 'click' change notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { darkenColor, fontStacks, raisedBlock } from './widget-types.js';
import {
  TOOLTIP_NODE_ID, TOOLTIP_DELAY_MS, TOOLTIP_AUTO_HIDE_MS, showTooltip, type PopoutSurface,
} from './popout.js';
import { shapeOf } from '../../core/theme-data.js';
import { iconCommands, isIconName } from '../../ui/icons.js';

export class ButtonWidget extends WidgetAbject {
  private hovered = false;
  private pressed = false;

  // style.tooltip: a pop-out beside the button (popout.ts) after a hover
  // dwell, so it may cross the window edge. One per window: every tooltip
  // in a window shares TOOLTIP_NODE_ID.
  private tip?: PopoutSurface;
  private tipTimer?: ReturnType<typeof setTimeout>;
  private tipHideTimer?: ReturnType<typeof setTimeout>;
  /** Pointer in workspace px while hovered (globalX/globalY). */
  private tipPointer?: { x: number; y: number };
  /** Where the button last drew, in window px. */
  private drawnAt?: { x: number; y: number };

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
    this.drawnAt = { x: ox, y: oy };
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
      this.hideTooltip();
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
      const gx = input.globalX as number | undefined;
      const gy = input.globalY as number | undefined;
      if (gx !== undefined && gy !== undefined) this.tipPointer = { x: gx, y: gy };
      if (!this.hovered) {
        this.hovered = true;
        this.scheduleTooltip();
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (input.type === 'mouseleave') {
      const wasInteracting = this.hovered || this.pressed;
      this.hovered = false;
      this.pressed = false;
      this.hideTooltip();
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

  /** Show style.tooltip after a hover dwell. */
  private scheduleTooltip(): void {
    if (!this.style.tooltip || this.disabled) return;
    this.cancelTimer(this.tipTimer);
    this.tipTimer = this.setTimer(() => this.showTooltipNow(), TOOLTIP_DELAY_MS);
  }

  /**
   * The tooltip as a pop-out beside the button (below the pointer on a wide
   * button), flipping to the side of the screen with room; it leaves on
   * mouseleave, on press, or by itself after TOOLTIP_AUTO_HIDE_MS.
   */
  private async showTooltipNow(): Promise<void> {
    this.tipTimer = undefined;
    const text = this.style.tooltip;
    const at = this.drawnAt;
    if (!text || !at || !this.hovered || this.disabled) return;
    const tip = this.tip ??= this.createPopout(TOOLTIP_NODE_ID, { interactive: false });
    try {
      await showTooltip(tip, {
        text,
        anchor: { x: at.x, y: at.y, width: this.rect.width, height: this.rect.height },
        pointer: this.tipPointer,
        theme: this.theme,
        measure: (t, font) => this.measureText('', t, font),
      });
    } catch {
      return; // no window to hang it on
    }
    if (!this.hovered) {
      void tip.hide();
      return;
    }
    this.cancelTimer(this.tipHideTimer);
    this.tipHideTimer = this.setTimer(() => this.hideTooltip(), TOOLTIP_AUTO_HIDE_MS);
  }

  private hideTooltip(): void {
    this.cancelTimer(this.tipTimer);
    this.tipTimer = undefined;
    this.cancelTimer(this.tipHideTimer);
    this.tipHideTimer = undefined;
    if (this.tip?.isOpen) void this.tip.hide();
  }

  protected override async onStop(): Promise<void> {
    this.hideTooltip();
    await super.onStop();
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
