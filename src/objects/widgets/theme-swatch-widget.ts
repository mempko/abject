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
import { ThemeData, fontStacks, inkFrame, raisedBlock, wedge } from './widget-types.js';
import { shapeOf, chromeCase } from '../../core/theme-data.js';

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

    // ── Selection ring (uses active theme accent so it pops on any preview) ──
    // Square ring, no glow.
    const outer = { x: ox, y: oy, width: w, height: h };
    if (this.selected) cmds.push(...inkFrame(surfaceId, outer, this.theme.accent, 2));
    else if (this.hovered) cmds.push(...inkFrame(surfaceId, outer, this.theme.textPrimary, 1));

    cmds.push(...this.buildPreview(surfaceId, ox, oy));
    return cmds;
  }

  /**
   * Mini window in the preview theme's palette: a square print block
   * with a hard shadow, a solid red title band with a paper wedge and caps,
   * a diagonal red bar, and a red action block.
   */
  private buildPreview(surfaceId: string, ox: number, oy: number): unknown[] {
    const cmds: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const pt = this.previewTheme;
    const inset = 5;
    const win = { x: ox + inset, y: oy + inset, width: w - inset * 2, height: h - inset * 2 };
    const fonts = fontStacks(pt);
    const shape = shapeOf(pt);
    const block = raisedBlock(surfaceId, win, shape.blockShadowColor, 3);
    cmds.push(...block.commands);
    const f = block.face;
    const tbH = 14;
    cmds.push({ type: 'rect', surfaceId, params: { ...f, fill: pt.windowBg } });

    // Title band: solid red with a paper wedge at the left and inverse caps.
    cmds.push({ type: 'rect', surfaceId, params: { x: f.x, y: f.y, width: f.width, height: tbH, fill: pt.accent } });
    cmds.push(...wedge(surfaceId, [
      { x: f.x + 5, y: f.y }, { x: f.x + 9, y: f.y },
      { x: f.x + 4, y: f.y + tbH }, { x: f.x, y: f.y + tbH },
    ], pt.windowBg));
    cmds.push({
      type: 'text', surfaceId,
      params: {
        x: f.x + 13, y: f.y + tbH / 2, text: chromeCase(pt, this.themeName),
        font: `600 8px ${fonts.display}`, fill: pt.actionText, baseline: 'middle', align: 'left', maxWidth: f.width - 26,
      },
    });
    cmds.push({ type: 'rect', surfaceId, params: { x: f.x + f.width - 10, y: f.y + 4, width: 6, height: 6, fill: pt.actionText } });

    // Sample content: a display numeral, a diagonal red bar, square body rules.
    const cy = f.y + tbH + 5;
    const cx = f.x + 7;
    const cw = f.width - 14;
    cmds.push({ type: 'text', surfaceId, params: { x: cx, y: cy, text: 'Aa', font: `700 13px ${fonts.display}`, fill: pt.textHeading, baseline: 'top', align: 'left' } });
    const barX = cx + 24;
    cmds.push(...wedge(surfaceId, [
      { x: barX + 6, y: cy + 1 }, { x: barX + 30, y: cy + 1 },
      { x: barX + 24, y: cy + 11 }, { x: barX, y: cy + 11 },
    ], pt.accent));
    cmds.push({ type: 'rect', surfaceId, params: { x: cx, y: cy + 18, width: cw * 0.85, height: 3, fill: pt.textDescription } });
    cmds.push({ type: 'rect', surfaceId, params: { x: cx, y: cy + 25, width: cw * 0.6, height: 3, fill: pt.textDescription } });

    // Sample action button: red face over a small hard shadow.
    const btn = { x: f.x + f.width - 38, y: f.y + f.height - 21, width: 32, height: 16 };
    const bb = raisedBlock(surfaceId, btn, shape.blockShadowColor, 2);
    cmds.push(...bb.commands);
    cmds.push({ type: 'rect', surfaceId, params: { ...bb.face, fill: pt.actionBg } });
    cmds.push({
      type: 'text', surfaceId,
      params: { x: bb.face.x + bb.face.width / 2, y: bb.face.y + bb.face.height / 2, text: 'GO', font: `600 8px ${fonts.display}`, fill: pt.actionText, baseline: 'middle', align: 'center' },
    });

    cmds.push(...inkFrame(surfaceId, f, pt.windowBorder, 1.5));
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
