/**
 * Shared markdown → draw-commands renderer.
 *
 * Turns a laid-out `RichTextLayout` (from layoutRichText) into the primitive
 * draw commands (imageUrl / rect / line / text) that paint it. This is the one
 * place that decides how parsed markdown becomes pixels, used by every markdown
 * surface: MarkdownWidget, LabelWidget (markdown mode), TextInputWidget
 * (markdown preview), and the canvas `markdown` draw command.
 *
 * It does NOT run parse/layout (callers do that, because interactive widgets
 * need the layout object for selection/cursor/hit-testing) and does NOT push
 * its own save/clip/restore (callers wrap as they see fit). It only emits the
 * per-line content, so a caller can layer selection highlights (passed in) and
 * its own cursor around the returned commands.
 */

import type { RichTextLayout } from './rich-text-layout.js';
import { HEADING_RULE_PAD } from './rich-text-layout.js';
import type { ThemeData } from '../../core/theme-data.js';
import { shapeOf } from '../../core/theme-data.js';
import { withAlpha, hatch } from './widget-types.js';

export interface RichTextRenderOptions {
  surfaceId: string;
  /** Origin of the text block (top-left), in the coordinate space of the emitted commands. */
  ox: number;
  oy: number;
  /** Block width (used for code-block backgrounds) and height (bottom-edge culling). */
  width: number;
  height: number;
  theme: ThemeData;
  /** Per-widget image resolver: a data: URI to paint, or null if not yet resolved. */
  drawableUrl: (url: string) => string | null;
  /** Vertical offset applied to every line (vertical centering, or a top pad). */
  yShift?: number;
  /** Left padding before each line's content. Default 4. */
  textPadding?: number;
  /** Absolute surface viewport for scroll culling (skip lines fully outside it). */
  viewportClip?: { top: number; bottom: number } | null;
  /** Source-offset selection range to highlight (requires `measure`). */
  selection?: { start: number; end: number } | null;
  /** Async text measurement, needed only when `selection` is set. */
  measure?: (text: string, font: string) => Promise<number>;
  /** Draw an inline-code background chip behind monospace accent runs. Default true. */
  inlineCodeBg?: boolean;
  /** Draw a placeholder frame for images that haven't resolved yet. Default false. */
  imagePlaceholder?: boolean;
}

/**
 * Emit the draw commands for a laid-out markdown block. Async because the
 * optional selection pass measures sub-run text widths.
 */
export async function renderRichTextCommands(
  layout: RichTextLayout,
  opts: RichTextRenderOptions,
): Promise<unknown[]> {
  const { surfaceId, ox, oy, width, height, theme, drawableUrl } = opts;
  const textPadding = opts.textPadding ?? 4;
  const yShift = opts.yShift ?? 0;
  const clip = opts.viewportClip ?? null;
  const sel = opts.selection ?? null;
  const measure = opts.measure;
  const inlineCodeBg = opts.inlineCodeBg ?? true;
  const imagePlaceholder = opts.imagePlaceholder ?? false;
  const ruleW = shapeOf(theme).ruleWidth;

  const commands: unknown[] = [];

  for (const line of layout.lines) {
    const lineTop = oy + yShift + line.y;
    const lineBottom = lineTop + line.height;
    const textY = lineTop + line.height * 0.7;
    if (lineTop > oy + height) break; // past the bottom edge
    if (clip && (lineBottom < clip.top || lineTop > clip.bottom)) continue;

    // Image line.
    if (line.image) {
      const url = drawableUrl(line.image.url);
      if (url) {
        commands.push({
          type: 'imageUrl', surfaceId,
          params: { x: ox + textPadding + line.indent, y: lineTop, width: line.image.width, height: line.image.height, url },
        });
      } else if (imagePlaceholder) {
        // Square placeholder, hatched like an unprinted plate.
        const r = { x: ox + textPadding + line.indent, y: lineTop, width: line.image.width, height: line.image.height };
        commands.push({ type: 'rect', surfaceId, params: { ...r, fill: theme.inputBg } });
        commands.push(...hatch(surfaceId, r, theme.divider, 10, 1));
        commands.push({ type: 'rect', surfaceId, params: { x: r.x + 0.5, y: r.y + 0.5, width: Math.max(0, r.width - 1), height: Math.max(0, r.height - 1), stroke: theme.inputBorder } });
      }
      continue;
    }

    // Code-block background.
    if (line.codeBackground) {
      commands.push({ type: 'rect', surfaceId, params: { x: ox, y: lineTop, width, height: line.height, fill: theme.inputBg } });
      // Code blocks carry an ink rule down their left edge.
      commands.push({ type: 'rect', surfaceId, params: { x: ox, y: lineTop, width: 3, height: line.height, fill: theme.textPrimary } });
    }
    // Blockquote left border.
    if (line.quoteBorder) {
      // A solid red bar spanning the quote's first line.
      commands.push({ type: 'rect', surfaceId, params: { x: ox + 2, y: lineTop, width: 4, height: line.height, fill: theme.accent } });
    }

    // Selection highlights (behind text). Per-run, mapped from source offsets.
    if (sel && measure) {
      let selRunX = ox + textPadding + line.indent;
      for (const run of line.runs) {
        if (run.text.length === 0) { selRunX += run.width; continue; }
        const overlapStart = Math.max(sel.start, run.sourceStart);
        const overlapEnd = Math.min(sel.end, run.sourceEnd);
        if (overlapStart < overlapEnd) {
          const dispStart = Math.min(overlapStart - run.sourceStart, run.text.length);
          const dispEnd = Math.min(overlapEnd - run.sourceStart, run.text.length);
          let hlX = selRunX;
          let hlW = run.width;
          if (dispStart > 0) hlX = selRunX + await measure(run.text.substring(0, dispStart), run.font);
          if (dispEnd < run.text.length) hlW = await measure(run.text.substring(dispStart, dispEnd), run.font);
          else hlW = (selRunX + run.width) - hlX;
          if (hlW > 0) {
            commands.push({ type: 'rect', surfaceId, params: { x: hlX, y: lineTop, width: hlW, height: line.height, fill: theme.selectionBg } });
          }
        }
        selRunX += run.width;
      }
    }

    // Styled runs.
    let runX = ox + textPadding + line.indent;
    for (const run of line.runs) {
      if (run.text.length === 0) continue;
      if (inlineCodeBg && !line.codeBackground && line.blockType !== 'table' && run.fill === theme.accent && run.font.includes('Mono')) {
        commands.push({ type: 'rect', surfaceId, params: { x: runX - 2, y: lineTop + 1, width: run.width + 4, height: line.height - 2, fill: withAlpha(theme.textPrimary, 0.08) } });
      }
      commands.push({ type: 'text', surfaceId, params: { x: runX, y: textY, text: run.text, font: run.font, fill: run.fill, baseline: 'alphabetic' } });
      if (run.href) {
        commands.push({ type: 'line', surfaceId, params: { x1: runX, y1: textY + 2, x2: runX + run.width, y2: textY + 2, stroke: run.fill, lineWidth: 1 } });
      }
      runX += run.width;
    }

    // Heading rule: heavy ink under h1/h2 with a red block
    // at its head, a hairline under deeper levels. Drawn in the padding the
    // layout reserved below the heading's last line.
    if (line.headingRule) {
      const ry = lineBottom + Math.floor(HEADING_RULE_PAD / 2) - 1;
      const rx = ox + textPadding + line.indent;
      const rw = Math.max(0, width - textPadding * 2 - line.indent);
      if (line.headingRule <= 2) {
        commands.push({ type: 'rect', surfaceId, params: { x: rx, y: ry, width: rw, height: ruleW, fill: theme.textPrimary } });
        commands.push({ type: 'rect', surfaceId, params: { x: rx, y: ry - 1, width: Math.min(rw, 24), height: ruleW + 2, fill: theme.accent } });
      } else {
        commands.push({ type: 'rect', surfaceId, params: { x: rx, y: ry, width: rw, height: 1, fill: theme.divider } });
      }
    }
  }

  return commands;
}
