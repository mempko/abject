/**
 * ButtonWidget — a clickable button with centered text.
 *
 * Renders a flat print block with centered label text.
 * Consumes mousedown events and fires a 'click' change notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { darkenColor, fontStacks, gradientRect, raisedBlock, withAlpha } from './widget-types.js';
import {
  TOOLTIP_NODE_ID, TOOLTIP_DELAY_MS, TOOLTIP_AUTO_HIDE_MS, showTooltip, type PopoutSurface,
} from './popout.js';
import { shapeOf } from '../../core/theme-data.js';
import { iconCommands, isIconName, type IconName } from '../../ui/icons.js';

export class ButtonWidget extends WidgetAbject {
  private hovered = false;
  private pressed = false;
  /** The pointer is over style.accessory (its tooltip shows, its press is its own). */
  private overAccessory = false;

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
  /** The last draw cut the label short; with no style.tooltip, the full text is the tooltip. */
  private labelCut = false;

  /** Width of the accessory's hit area at the right end, when the row has one. */
  private static readonly ACCESSORY_W = 26;

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

    // The ring marks keyboard focus only; a click leaves no ring behind.
    if (this.focusVisible && live) {
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

    // The accessory takes room from the label only while it shows.
    const accessory = this.accessory();
    const showAccessory = !!accessory && (hovered || pressed || !!accessory.atRest);
    const labelArea = showAccessory
      ? { ...face, width: Math.max(0, face.width - ButtonWidget.ACCESSORY_W + 6) }
      : face;
    // A flat left-aligned row fades a long label into its own fill instead of
    // cutting it with an ellipsis.
    const rowFill = style.flat ? (hovered || pressed ? theme.textPrimary : style.background) : undefined;
    const fadeTo = style.flat && (style.align ?? 'center') === 'left' && rowFill?.startsWith('#') ? rowFill : undefined;
    commands.push(...(style.caption
      ? await this.tileCommands(surfaceId, labelArea, textColor, hovered)
      : await this.labelCommands(surfaceId, labelArea, font, textColor, style.align ?? 'center', hasMarker ? 4 : 0, fadeTo)));
    if (accessory && showAccessory) {
      commands.push(...this.accessoryCommands(surfaceId, face, accessory, hovered || pressed ? textColor : undefined));
    }

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  /** style.accessory, when it names a known icon. */
  private accessory(): { icon: IconName; tooltip?: string; atRest?: boolean; color?: string } | undefined {
    const a = this.style.accessory;
    if (!a || typeof a.icon !== 'string' || !isIconName(a.icon)) return undefined;
    return { ...a, icon: a.icon };
  }

  /** Whether a local x falls on the accessory's hit area. */
  private onAccessory(localX: number | undefined): boolean {
    return !!this.accessory() && typeof localX === 'number'
      && localX >= this.rect.width - ButtonWidget.ACCESSORY_W;
  }

  /**
   * The accessory icon at the right end. Over the row it takes the row's
   * hover ink (`rowInk`), and the accent with a soft chip behind it while the
   * pointer is on the accessory itself; at rest it wears its own color.
   */
  private accessoryCommands(
    surfaceId: string,
    face: { x: number; y: number; width: number; height: number },
    accessory: { icon: IconName; color?: string },
    rowInk: string | undefined,
  ): unknown[] {
    const commands: unknown[] = [];
    const size = Math.max(10, Math.min(14, face.height - 12));
    const slot = ButtonWidget.ACCESSORY_W;
    const x = face.x + face.width - slot + (slot - size) / 2 - 2;
    const y = face.y + (face.height - size) / 2;
    const hot = this.overAccessory && !this.disabled;
    if (hot) {
      const pad = 4;
      commands.push({
        type: 'rect', surfaceId,
        params: {
          x: Math.round(x - pad), y: Math.round(y - pad), width: size + pad * 2, height: size + pad * 2,
          fill: this.theme.windowBg, radius: this.theme.tokens.radius.sm,
        },
      });
    }
    const color = hot ? this.theme.accent : rowInk ?? accessory.color ?? this.theme.accent;
    commands.push(...iconCommands(accessory.icon, {
      surfaceId, x: Math.round(x), y: Math.round(y), size, color, caps: shapeOf(this.theme).iconCaps,
    }));
    return commands;
  }

  /**
   * A tile (style.caption): the icon at the top left, the text in bold under
   * it and the caption in a smaller, quieter line below, all left-aligned.
   */
  private async tileCommands(
    surfaceId: string,
    area: { x: number; y: number; width: number; height: number },
    color: string,
    hovered: boolean,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const pad = 14;
    const stacks = fontStacks(this.theme);
    const titleFont = `700 ${this.style.fontSize ?? 15}px ${stacks.body}`;
    const captionFont = `13px ${stacks.body}`;
    const icon = this.style.icon && isIconName(this.style.icon) ? this.style.icon : undefined;
    const iconSize = 18;
    const textWidth = area.width - pad * 2;
    // Title and caption sit together at the bottom; the icon keeps the top.
    const captionY = area.y + area.height - pad - 8;
    const titleY = captionY - 19;
    if (icon) {
      commands.push(...iconCommands(icon, {
        surfaceId, x: Math.round(area.x + pad), y: Math.round(area.y + pad), size: iconSize,
        color: hovered ? color : this.theme.accentSecondary, caps: shapeOf(this.theme).iconCaps,
      }));
    }
    if (this.text) {
      commands.push({
        type: 'text', surfaceId,
        params: {
          x: area.x + pad, y: titleY, font: titleFont, fill: color, align: 'left', baseline: 'middle',
          text: await this.truncateWithEllipsis(surfaceId, this.text, textWidth, titleFont),
        },
      });
    }
    commands.push({
      type: 'text', surfaceId,
      params: {
        x: area.x + pad, y: captionY, font: captionFont, fill: hovered ? color : this.theme.textMeta, align: 'left', baseline: 'middle',
        text: await this.truncateWithEllipsis(surfaceId, this.style.caption ?? '', textWidth, captionFont),
      },
    });
    return commands;
  }

  /**
   * The button's label inside `area`: optional vector icon (style.icon) then
   * the text, truncated with an ellipsis to fit, or faded into `fadeTo` (the
   * row's fill) when given. With no text the icon is centered. `leftPad`
   * reserves room for a leading marker.
   */
  private async labelCommands(
    surfaceId: string,
    area: { x: number; y: number; width: number; height: number },
    font: string,
    color: string,
    align: 'left' | 'center' | 'right',
    leftPad: number,
    fadeTo?: string,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const padding = 8;
    const cy = area.y + area.height / 2;
    const icon = this.style.icon && isIconName(this.style.icon) ? this.style.icon : undefined;
    const iconSize = icon ? Math.max(10, Math.min(16, area.height - 10)) : 0;
    const iconGap = icon && this.text ? 7 : 0;
    const iconSpan = iconSize + iconGap;

    const maxTextWidth = area.width - padding * 2 - leftPad - iconSpan;
    const fullWidth = this.text && fadeTo && align === 'left'
      ? await this.measureText(surfaceId, this.text, font)
      : 0;
    const fade = fullWidth > maxTextWidth;
    // A measured label either fits as it is or fades; only the rest need truncating.
    const displayText = !this.text ? ''
      : fullWidth > 0 ? this.text
      : await this.truncateWithEllipsis(surfaceId, this.text, maxTextWidth, font);
    this.labelCut = fade || displayText !== this.text;
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
      const text = {
        type: 'text', surfaceId,
        params: {
          x: textX, y: cy, text: displayText, font, fill: color,
          align: icon ? 'left' : align, baseline: 'middle',
        },
      };
      if (fade && fadeTo) {
        // Clip the text at the label's end and fade its last stretch into the row.
        const end = textX + maxTextWidth;
        const fadeW = Math.min(22, maxTextWidth);
        commands.push(
          { type: 'save', surfaceId, params: {} },
          { type: 'clip', surfaceId, params: { x: area.x, y: area.y, width: Math.max(0, end - area.x), height: area.height } },
          text,
          { type: 'restore', surfaceId, params: {} },
          ...gradientRect(surfaceId, {
            x: end - fadeW, y: area.y, width: fadeW, height: area.height,
            gradient: { x0: end - fadeW, y0: 0, x1: end, y1: 0, stops: [
              { offset: 0, color: withAlpha(fadeTo, 0) }, { offset: 1, color: fadeTo },
            ] },
          }),
        );
      } else {
        commands.push(text);
      }
    }
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
      this.hideTooltip();
      // A press on the accessory is the accessory's own action, not the row's,
      // when it can be seen: a touch with no hover first lands on the row.
      if (this.onAccessory(input.x as number | undefined) && (this.hovered || this.accessory()?.atRest)) {
        this.changed('accessory', this.text);
        await this.requestRedraw();
        return { consumed: true };
      }
      this.pressed = true;
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
      const overAccessory = this.onAccessory(input.x as number | undefined);
      if (!this.hovered || overAccessory !== this.overAccessory) {
        // Entering the accessory swaps the tooltip for the accessory's own.
        if (this.hovered) this.hideTooltip();
        this.hovered = true;
        this.overAccessory = overAccessory;
        this.scheduleTooltip();
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (input.type === 'mouseleave') {
      const wasInteracting = this.hovered || this.pressed;
      this.hovered = false;
      this.pressed = false;
      this.overAccessory = false;
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

  /**
   * The tooltip for where the pointer is: the accessory's on it, else
   * style.tooltip, else the full label when the last draw cut it short.
   */
  private tooltipText(): string | undefined {
    if (this.overAccessory) return this.accessory()?.tooltip;
    return this.style.tooltip ?? (this.labelCut && this.text ? this.text : undefined);
  }

  /**
   * Show the tooltip after a hover dwell. Whether a label is cut can change
   * with the hover itself (the accessory takes room), so a button with text
   * waits and asks again when the dwell ends.
   */
  private scheduleTooltip(): void {
    if (this.disabled || (!this.tooltipText() && !this.text)) return;
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
    const text = this.tooltipText();
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
