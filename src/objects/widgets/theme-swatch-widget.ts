/**
 * ThemeSwatchWidget — a clickable mini-window preview of a theme preset.
 *
 * Unlike other widgets, the swatch renders using a *passed-in* ThemeData
 * (the preview theme), not the active theme. The active theme is still
 * tracked on `this.theme` so the selection ring can use the active accent
 * (so it stands out regardless of what the preview's accent looks like).
 *
 * Emits a `click` change with `{ themeId }` when pressed.
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { ThemeData } from './widget-types.js';

export interface ThemeSwatchWidgetConfig extends WidgetConfig {
  themeId: string;
  themeName: string;
  previewTheme: ThemeData;
  selected?: boolean;
}

export class ThemeSwatchWidget extends WidgetAbject {
  private themeId: string;
  private themeName: string;
  private previewTheme: ThemeData;
  private selected: boolean;
  private hovered = false;

  constructor(config: ThemeSwatchWidgetConfig) {
    super(config);
    this.themeId = config.themeId;
    this.themeName = config.themeName;
    this.previewTheme = config.previewTheme;
    this.selected = config.selected ?? false;
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const cmds: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const pt = this.previewTheme;

    // ── Selection ring (uses active theme accent so it pops on any preview) ──
    if (this.selected) {
      cmds.push({ type: 'save', surfaceId, params: {} });
      cmds.push({
        type: 'shadow',
        surfaceId,
        params: { color: this.theme.tokens.glow.accent.color, blur: 8, offsetY: 0 },
      });
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox,
          y: oy,
          width: w,
          height: h,
          stroke: this.theme.accent,
          lineWidth: 2,
          radius: pt.windowRadius + 3,
        },
      });
      cmds.push({ type: 'restore', surfaceId, params: {} });
    } else if (this.hovered) {
      cmds.push({
        type: 'rect',
        surfaceId,
        params: {
          x: ox,
          y: oy,
          width: w,
          height: h,
          stroke: this.theme.tokens.elevation.level1.color,
          lineWidth: 1,
          radius: pt.windowRadius + 3,
        },
      });
    }

    // ── Mini window body ──
    const inset = 5;
    const winX = ox + inset;
    const winY = oy + inset;
    const winW = w - inset * 2;
    const winH = h - inset * 2;
    const tbH = 14;

    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: winX,
        y: winY,
        width: winW,
        height: winH,
        fill: pt.windowBg,
        stroke: pt.windowBorder,
        lineWidth: 1,
        radius: pt.windowRadius,
      },
    });

    // ── Title bar ──
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: winX,
        y: winY,
        width: winW,
        height: tbH,
        fill: pt.titleBarBg,
        radius: pt.windowRadius,
      },
    });
    // Cover the bottom corners of the title-bar rounded rect so it joins the body cleanly.
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: winX,
        y: winY + tbH - 2,
        width: winW,
        height: 2,
        fill: pt.titleBarBg,
      },
    });

    // Title text (theme name), truncated visually by clipping width
    cmds.push({
      type: 'text',
      surfaceId,
      params: {
        x: winX + 6,
        y: winY + tbH / 2,
        text: this.themeName,
        font: '600 9px "Spectral", Georgia, "Times New Roman", serif',
        fill: pt.textPrimary,
        baseline: 'middle',
        align: 'left',
        maxWidth: winW - 22,
      },
    });

    // Tiny close glyph
    cmds.push({
      type: 'text',
      surfaceId,
      params: {
        x: winX + winW - 6,
        y: winY + tbH / 2,
        text: '✕',
        font: '8px "Spectral", Georgia, "Times New Roman", serif',
        fill: pt.textSecondary,
        baseline: 'middle',
        align: 'right',
      },
    });

    // ── Accent line under the title bar ──
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: winX,
        y: winY + tbH,
        width: winW,
        height: 1,
        fill: pt.accent,
      },
    });

    // ── Sample content ──
    const contentY = winY + tbH + 6;
    const contentX = winX + 8;
    const contentW = winW - 16;

    // Heading
    cmds.push({
      type: 'text',
      surfaceId,
      params: {
        x: contentX,
        y: contentY,
        text: 'Aa',
        font: '700 12px "Spectral", Georgia, "Times New Roman", serif',
        fill: pt.textHeading,
        baseline: 'top',
        align: 'left',
      },
    });

    // Two faux body lines
    const lineY1 = contentY + 18;
    const lineY2 = lineY1 + 7;
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: contentX,
        y: lineY1,
        width: contentW * 0.85,
        height: 3,
        fill: pt.textDescription,
        radius: 1.5,
      },
    });
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: contentX,
        y: lineY2,
        width: contentW * 0.6,
        height: 3,
        fill: pt.textDescription,
        radius: 1.5,
      },
    });

    // Sample action button (bottom-right)
    const btnW = 30;
    const btnH = 14;
    const btnX = winX + winW - btnW - 6;
    const btnY = winY + winH - btnH - 6;
    cmds.push({
      type: 'rect',
      surfaceId,
      params: {
        x: btnX,
        y: btnY,
        width: btnW,
        height: btnH,
        fill: pt.actionBg,
        stroke: pt.actionBorder,
        lineWidth: 1,
        radius: pt.widgetRadius,
      },
    });
    cmds.push({
      type: 'text',
      surfaceId,
      params: {
        x: btnX + btnW / 2,
        y: btnY + btnH / 2,
        text: 'Go',
        font: '700 8px "Spectral", Georgia, "Times New Roman", serif',
        fill: pt.actionText,
        baseline: 'middle',
        align: 'center',
      },
    });

    return cmds;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const t = input.type;
    if (t === 'mousedown') {
      this.changed('click', { themeId: this.themeId });
      return { consumed: true };
    }
    if (t === 'mousemove') {
      if (!this.hovered) {
        this.hovered = true;
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (t === 'mouseleave') {
      if (this.hovered) {
        this.hovered = false;
        await this.requestRedraw();
      }
      return { consumed: true };
    }
    if (t === 'keydown' && this.focused) {
      const k = input.key as string;
      if (k === 'Enter' || k === ' ') {
        this.changed('click', { themeId: this.themeId });
        return { consumed: true };
      }
    }
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return this.themeId;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (typeof updates.selected === 'boolean') {
      this.selected = updates.selected;
    }
    if (typeof updates.themeName === 'string') {
      this.themeName = updates.themeName;
    }
    if (updates.previewTheme && typeof updates.previewTheme === 'object') {
      this.previewTheme = updates.previewTheme as ThemeData;
    }
  }
}
