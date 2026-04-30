/**
 * ButtonWidget — a clickable button with centered text.
 *
 * Renders a rounded rectangle with centered label text.
 * Consumes mousedown events and fires a 'click' change notification.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { lightenColor, darkenColor } from './widget-types.js';

export class ButtonWidget extends WidgetAbject {
  private hovered = false;
  private pressed = false;

  constructor(config: WidgetConfig) {
    super(config);
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const font = buildFont(style);
    const radius = style.radius ?? this.theme.widgetRadius;
    const tokens = this.theme.tokens;

    // A button is treated as "primary" when its caller assigned the action
    // color as the background — used for Save/Send/Apply etc. Primary buttons
    // get an accent glow on hover; secondary buttons just lighten.
    const baseFill = style.background ?? this.theme.buttonBg;
    const isPrimary = baseFill === this.theme.actionBg || baseFill === this.theme.accent;

    let fill = baseFill;
    if (this.hovered && !this.disabled) {
      fill = isPrimary ? lightenColor(fill, 12) : lightenColor(fill, 25);
    }
    if (this.pressed && !this.disabled) {
      // Press = quick darken; the scale wrap below adds a tactile shrink.
      fill = darkenColor(fill, 12);
    }

    // Reduce opacity when disabled
    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    // Press scale: shrink to 0.96 around the button's center for tactile feedback (Doherty).
    if (this.pressed && !this.disabled) {
      const cx = ox + w / 2;
      const cy = oy + h / 2;
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'translate', surfaceId, params: { x: cx, y: cy } });
      commands.push({ type: 'scale', surfaceId, params: { x: 0.96, y: 0.96 } });
      commands.push({ type: 'translate', surfaceId, params: { x: -cx, y: -cy } });
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
        params: { x: ox, y: oy, width: w, height: h, fill, stroke: this.theme.inputBorderFocus, radius },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Hover glow for primary buttons — accent halo (Von Restorff).
    if (isPrimary && this.hovered && !this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId,
        params: { color: tokens.glow.accent.color, blur: tokens.glow.accent.blur },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: { x: ox, y: oy, width: w, height: h, fill, radius },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Subtle top-to-bottom gradient for depth
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'linearGradient',
      surfaceId,
      params: { x0: 0, y0: oy, x1: 0, y1: oy + h, stops: [
        { offset: 0, color: fill },
        { offset: 1, color: darkenColor(fill, 15) },
      ] },
    });
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: ox,
        y: oy,
        width: w,
        height: h,
        fill,
        stroke: style.borderColor ?? this.theme.buttonBorder,
        radius,
      },
    });
    commands.push({ type: 'restore', surfaceId, params: {} });

    // Truncate text with ellipsis if it exceeds button width (with padding)
    const padding = 8;
    const maxTextWidth = w - padding * 2;
    const displayText = await this.truncateWithEllipsis(surfaceId, this.text, maxTextWidth, font);

    const align = style.align ?? 'center';
    const textX = align === 'center' ? ox + w / 2
      : align === 'right' ? ox + w - padding
      : ox + padding;
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: textX,
        y: oy + h / 2,
        text: displayText,
        font,
        fill: style.color ?? this.theme.buttonText,
        align,
        baseline: 'middle',
      },
    });

    // Close press-scale wrapper (must close *before* any disabled-alpha restore).
    if (this.pressed && !this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    // Close disabled alpha save
    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    if (input.type === 'mousedown') {
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
      if (!this.hovered) {
        this.hovered = true;
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (input.type === 'mouseleave') {
      const wasInteracting = this.hovered || this.pressed;
      this.hovered = false;
      this.pressed = false;
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
