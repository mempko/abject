/**
 * GoalProgressWidget — draws the rows `goal-tree.ts` builds: one goal as a
 * card (state, question, planner line, tasks with a step trail under running
 * work) or the Goals window's list.
 *
 * Every row wraps its full text to the available width and grows as tall as
 * it needs, with optional pieces around the text: a name chip before it, a
 * short right-aligned meta (a step count, a time), smaller detail lines under
 * it, a line of monospace (a command), a thin progress bar, a background band,
 * and a trail line down the gutter beside step rows. The widget reports its
 * natural content height via a `contentHeight` event so its owner can size
 * the layout child; scrolling is delegated to the container (a ScrollableVBox
 * in the Goals window, the message log in Chat).
 *
 * Events:
 *   toggle        — { id }           a row marked click: 'toggle' was clicked
 *   select        — { id }           a row marked click: 'select' was clicked
 *   goalAction    — { id, action }   a per-row control was clicked (pause/resume/stop)
 *   contentHeight — number           the natural height needed to show all rows
 */

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { iconCommands } from '../../ui/icons.js';
import { wrapText } from './word-wrap.js';
import { fontStacks, squareMark, withAlpha } from './widget-types.js';
import type { GoalRow, ColorRole, BandRole, GoalRowAction } from '../goal-tree.js';

export interface GoalProgressWidgetConfig extends WidgetConfig {
  rows?: GoalRow[];
}

const LINE_HEIGHT = 18;
const TITLE_LINE_HEIGHT = 21;
const HEADLINE_LINE_HEIGHT = 25;
const DETAIL_LINE_HEIGHT = 16;
const CODE_HEIGHT = 18;
const BAR_HEIGHT = 3;
const BAR_GAP = 5;
const INDENT_PX = 18;
const ICON_WIDTH = 20;
const ICON_SIZE = 13;
const LEFT_PAD = 8;
const RIGHT_PAD = 10;
const PAD_TOP = 6;
const PAD_BOTTOM = 6;
const ROW_GAP = 6;
const SECTION_GAP = 8;
const BAND_PAD = 7;
const META_GAP = 10;
const BADGE_PAD_X = 5;
const BADGE_GAP = 8;
const BADGE_HEIGHT = 15;

// Per-row action buttons (pause/resume/stop), right-aligned on the first line
// of live goal rows. ASCII '||' for pause — see Chat's PAUSE_GLYPH note: the
// canvas font draws U+2016 as a single stroke.
const ACTION_BTN_SIZE = 16;
const ACTION_BTN_GAP = 6;
const ACTION_GLYPHS: Record<GoalRowAction, string> = {
  pause: '||',
  resume: '▶',
  stop: '■',
};

/** A row's vertical bounds from the last draw, for hit-testing (widget-local). */
interface RowBound {
  top: number;
  height: number;
  id: string;
  click?: 'toggle' | 'select';
}

/** Hit rect for a per-row action button, in widget-local coordinates. */
interface ActionBound {
  left: number;
  top: number;
  size: number;
  id: string;
  action: GoalRowAction;
}

export class GoalProgressWidget extends WidgetAbject {
  private rows: GoalRow[] = [];
  private wrapCache = new Map<string, string[]>();
  private widthCache = new Map<string, number>();
  private rowBounds: RowBound[] = [];
  private actionBounds: ActionBound[] = [];
  private lastReportedHeight = -1;

  constructor(config: GoalProgressWidgetConfig) {
    super(config);
    this.rows = config.rows ?? [];
  }

  private fontFor(row: GoalRow): string {
    const f = fontStacks(this.theme);
    if (row.display) return `600 11px ${f.display}`;
    if (row.kind === 'title') return `600 15px ${f.body}`;
    if (row.kind === 'headline') return `17px ${f.body}`;
    return row.bold ? `600 13px ${f.body}` : `13px ${f.body}`;
  }
  private get metaFont(): string { return `12px ${fontStacks(this.theme).body}`; }
  private get detailFont(): string { return `12px ${fontStacks(this.theme).body}`; }
  private get codeFont(): string { return `11px ${fontStacks(this.theme).mono}`; }
  private get badgeFont(): string { return `600 10px ${fontStacks(this.theme).body}`; }
  private get actionFont(): string { return `9px ${fontStacks(this.theme).body}`; }

  /** Role to colour. Work in motion is the living light (accentSecondary). */
  private roleColor(role: ColorRole | undefined): string {
    switch (role) {
      case 'primary':   return this.theme.textPrimary;
      case 'secondary': return this.theme.textSecondary;
      case 'tertiary':  return this.theme.textTertiary;
      case 'live':      return this.theme.accentSecondary;
      case 'caution':   return this.theme.statusWarning;
      case 'success':   return this.theme.statusSuccess;
      case 'error':     return this.theme.statusError;
      case 'neutral':   return this.theme.textMeta;
      default:          return this.theme.textPrimary;
    }
  }

  private bandColor(band: BandRole): string {
    switch (band) {
      case 'selected': return this.theme.activeItemBg;
      case 'caution':  return withAlpha(this.theme.statusWarning, 0.12);
      default:         return withAlpha(this.theme.textPrimary, 0.04);
    }
  }

  private async width(surfaceId: string, text: string, font: string): Promise<number> {
    const key = `${font} ${text}`;
    const cached = this.widthCache.get(key);
    if (cached !== undefined) return cached;
    const w = await this.measureText(surfaceId, text, font);
    this.widthCache.set(key, w);
    return w;
  }

  private async wrap(surfaceId: string, text: string, maxWidth: number, font: string): Promise<string[]> {
    if (!text) return [];
    if (maxWidth <= 0) return [text];
    const key = `${maxWidth} ${font} ${text}`;
    const cached = this.wrapCache.get(key);
    if (cached) return cached;
    const lines = await wrapText(text, maxWidth, (t: string) => this.measureText(surfaceId, t, font));
    this.wrapCache.set(key, lines);
    return lines;
  }

  protected async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number,
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;

    // Optional chrome. GoalBrowser gets an input-style panel; Chat passes
    // `background: 'transparent'` so the rows blend into the activity bubble.
    const bg = this.style.background;
    if (bg !== 'transparent') {
      commands.push({
        type: 'rect', surfaceId,
        params: {
          x: ox, y: oy, width: w, height: h,
          fill: bg ?? this.theme.inputBg,
          stroke: this.theme.inputBorder,
          radius: this.style.radius ?? this.theme.widgetRadius,
        },
      });
    }

    const bounds: RowBound[] = [];
    const actionBounds: ActionBound[] = [];
    let localY = PAD_TOP; // widget-local y; add `oy` to draw, keep raw for hit-test

    for (let index = 0; index < this.rows.length; index++) {
      const row = this.rows[index];
      if (row.kind === 'section' && index > 0) localY += SECTION_GAP;
      const font = this.fontFor(row);
      const lineHeight = row.kind === 'headline' ? HEADLINE_LINE_HEIGHT : row.kind === 'title' ? TITLE_LINE_HEIGHT : LINE_HEIGHT;
      const pad = row.band ? BAND_PAD : 0;
      const x0 = LEFT_PAD + row.depth * INDENT_PX;
      const textX = x0 + (row.iconName || row.iconSpace ? ICON_WIDTH : 0);

      const actions = row.actions ?? [];
      const actionsWidth = actions.length > 0
        ? actions.length * ACTION_BTN_SIZE + (actions.length - 1) * ACTION_BTN_GAP + ACTION_BTN_GAP
        : 0;
      const metaWidth = row.meta ? await this.width(surfaceId, row.meta, this.metaFont) : 0;
      const badgeText = row.badge?.toUpperCase();
      const badgeWidth = badgeText ? await this.width(surfaceId, badgeText, this.badgeFont) + BADGE_PAD_X * 2 : 0;
      const rightEdge = w - RIGHT_PAD - actionsWidth;
      const textStart = textX + (badgeWidth > 0 ? badgeWidth + BADGE_GAP : 0);
      // With a bar, the meta sits at the bar's end and the text gets the whole line.
      const metaOnBar = !!row.bar && metaWidth > 0;
      const textAvail = rightEdge - textStart - (metaWidth > 0 && !metaOnBar ? metaWidth + META_GAP : 0);
      const text = row.display ? row.text.toUpperCase() : row.text;
      const lines = await this.wrap(surfaceId, text, textAvail, font);
      const detailLines = row.detail ? await this.wrap(surfaceId, row.detail, rightEdge - textX, this.detailFont) : [];

      const textHeight = Math.max(1, lines.length) * lineHeight;
      const contentHeight = textHeight
        + detailLines.length * DETAIL_LINE_HEIGHT
        + (row.code ? CODE_HEIGHT + 3 : 0)
        + (row.bar ? BAR_GAP + Math.max(BAR_HEIGHT, metaOnBar ? DETAIL_LINE_HEIGHT - BAR_GAP : 0) : 0);
      const rowHeight = contentHeight + pad * 2;
      const top = oy + localY;
      const contentTop = top + pad;

      if (row.band) {
        commands.push({
          type: 'rect', surfaceId,
          params: { x: ox, y: top, width: w, height: rowHeight, fill: this.bandColor(row.band) },
        });
      }

      // The trail: a line down the gutter of the row above this one's icon.
      if (row.rail && row.depth > 0) {
        const railX = ox + LEFT_PAD + (row.depth - 1) * INDENT_PX + ICON_SIZE / 2;
        commands.push({
          type: 'rect', surfaceId,
          params: { x: Math.round(railX), y: top - ROW_GAP, width: 1, height: rowHeight + ROW_GAP, fill: this.theme.divider },
        });
      }

      // Status icon.
      if (row.iconName) {
        const iconY = contentTop + (lineHeight - ICON_SIZE) / 2;
        const color = this.roleColor(row.iconColorRole);
        if (row.iconName === 'dot') {
          commands.push(...squareMark(surfaceId, ox + x0 + ICON_SIZE / 2, contentTop + lineHeight / 2, row.kind === 'header' || row.kind === 'headline' ? 8 : 6, color));
        } else {
          commands.push(...iconCommands(row.iconName, { surfaceId, x: ox + x0, y: iconY, size: ICON_SIZE, color }));
        }
      }

      // Name chip.
      if (badgeText) {
        const by = contentTop + (lineHeight - BADGE_HEIGHT) / 2;
        commands.push({
          type: 'rect', surfaceId,
          params: { x: ox + textX, y: by, width: badgeWidth, height: BADGE_HEIGHT, fill: this.roleColor(row.iconColorRole === 'live' ? 'live' : 'neutral') },
        });
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + textX + badgeWidth / 2, y: by + BADGE_HEIGHT / 2 + 0.5,
            text: badgeText, font: this.badgeFont, fill: this.theme.windowBg, baseline: 'middle', align: 'center',
          },
        });
      }

      // Text.
      const textColor = this.roleColor(row.textColorRole);
      for (let i = 0; i < lines.length; i++) {
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + textStart, y: contentTop + i * lineHeight + lineHeight / 2,
            text: lines[i], font, fill: textColor, baseline: 'middle',
          },
        });
      }

      // Meta, right-aligned on the first line.
      if (row.meta && !metaOnBar) {
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + rightEdge, y: contentTop + lineHeight / 2,
            text: row.meta, font: this.metaFont, fill: this.roleColor(row.metaColorRole ?? 'tertiary'),
            baseline: 'middle', align: 'right',
          },
        });
      }

      let y = contentTop + textHeight;
      for (const line of detailLines) {
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + textX, y: y + DETAIL_LINE_HEIGHT / 2,
            text: line, font: this.detailFont, fill: this.roleColor(row.detailColorRole ?? 'tertiary'), baseline: 'middle',
          },
        });
        y += DETAIL_LINE_HEIGHT;
      }

      if (row.code) {
        const shown = await this.truncateWithEllipsis(surfaceId, row.code, rightEdge - textX - 12, this.codeFont);
        const codeWidth = Math.min(rightEdge - textX, await this.width(surfaceId, shown, this.codeFont) + 12);
        commands.push({
          type: 'rect', surfaceId,
          params: { x: ox + textX, y: y + 2, width: codeWidth, height: CODE_HEIGHT, fill: this.theme.inputBg },
        });
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: ox + textX + 6, y: y + 2 + CODE_HEIGHT / 2,
            text: shown, font: this.codeFont, fill: this.theme.textSecondary, baseline: 'middle',
          },
        });
        y += CODE_HEIGHT + 3;
      }

      if (row.bar) {
        const barWidth = Math.max(0, rightEdge - textX - (metaOnBar ? metaWidth + META_GAP : 0));
        if (metaOnBar) {
          commands.push({
            type: 'text', surfaceId,
            params: {
              x: ox + rightEdge, y: y + BAR_GAP + BAR_HEIGHT / 2,
              text: row.meta, font: this.metaFont, fill: this.roleColor(row.metaColorRole ?? 'tertiary'),
              baseline: 'middle', align: 'right',
            },
          });
        }
        const fraction = Math.max(0, Math.min(1, row.bar.fraction));
        commands.push({
          type: 'rect', surfaceId,
          params: { x: ox + textX, y: y + BAR_GAP, width: barWidth, height: BAR_HEIGHT, fill: this.theme.progressTrack },
        });
        if (fraction > 0) {
          commands.push({
            type: 'rect', surfaceId,
            params: { x: ox + textX, y: y + BAR_GAP, width: Math.max(2, barWidth * fraction), height: BAR_HEIGHT, fill: this.roleColor(row.bar.role) },
          });
        }
      }

      // Per-row action buttons (pause/resume/stop), right-aligned on the first line.
      if (actions.length > 0) {
        let btnX = ox + w - RIGHT_PAD - actions.length * ACTION_BTN_SIZE - (actions.length - 1) * ACTION_BTN_GAP;
        const btnY = contentTop + (lineHeight - ACTION_BTN_SIZE) / 2;
        for (const action of actions) {
          // Square block buttons: stop is a solid red block, the others
          // are ink-ruled paper squares.
          const stop = action === 'stop';
          commands.push({
            type: 'rect', surfaceId,
            params: { x: btnX, y: btnY, width: ACTION_BTN_SIZE, height: ACTION_BTN_SIZE, fill: stop ? this.theme.statusError : this.theme.inputBg },
          });
          if (!stop) {
            commands.push({
              type: 'rect', surfaceId,
              params: { x: btnX + 0.5, y: btnY + 0.5, width: ACTION_BTN_SIZE - 1, height: ACTION_BTN_SIZE - 1, stroke: this.theme.inputBorder },
            });
          }
          commands.push({
            type: 'text', surfaceId,
            params: {
              x: btnX + ACTION_BTN_SIZE / 2, y: btnY + ACTION_BTN_SIZE / 2 + 0.5,
              text: ACTION_GLYPHS[action], font: this.actionFont,
              fill: stop ? this.theme.actionText : this.theme.textPrimary,
              baseline: 'middle', align: 'center',
            },
          });
          actionBounds.push({ left: btnX - ox, top: btnY - oy, size: ACTION_BTN_SIZE, id: row.id, action });
          btnX += ACTION_BTN_SIZE + ACTION_BTN_GAP;
        }
      }

      bounds.push({ top: localY, height: rowHeight, id: row.id, click: row.click });
      localY += rowHeight + ROW_GAP;
    }

    this.rowBounds = bounds;
    this.actionBounds = actionBounds;

    // Report natural height so the owner can resize us. Converges in a frame or
    // two as the layout settles (mirrors Chat's activity-bubble reflow).
    const total = this.rows.length === 0 ? 0 : localY - ROW_GAP + PAD_BOTTOM;
    if (w > 0 && Math.abs(total - this.lastReportedHeight) >= 1) {
      this.lastReportedHeight = total;
      this.changed('contentHeight', total);
    }

    return commands;
  }

  protected async processInput(
    input: Record<string, unknown>,
  ): Promise<{ consumed: boolean }> {
    const type = input.type as string;

    // Let the scroll container handle the wheel.
    if (type === 'wheel') return { consumed: false };

    if (type === 'mousedown') {
      const mx = input.x as number; // widget-local coordinates
      const my = input.y as number;

      // Action buttons win over the row (slightly padded hit area).
      const actionHit = this.actionBounds.find(b =>
        mx >= b.left - 2 && mx < b.left + b.size + 2 &&
        my >= b.top - 2 && my < b.top + b.size + 2);
      if (actionHit) {
        this.changed('goalAction', JSON.stringify({ id: actionHit.id, action: actionHit.action }));
        return { consumed: true };
      }

      const hit = this.rowBounds.find(b => my >= b.top && my < b.top + b.height);
      if (hit?.click) {
        this.changed(hit.click, JSON.stringify({ id: hit.id }));
        return { consumed: true };
      }
      return { consumed: false };
    }

    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return '';
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.rows !== undefined && Array.isArray(updates.rows)) {
      this.rows = updates.rows as GoalRow[];
      // Bound cache growth: row texts change over a run, so drop stale entries.
      if (this.wrapCache.size > 2000) this.wrapCache.clear();
      if (this.widthCache.size > 4000) this.widthCache.clear();
    }
  }
}
