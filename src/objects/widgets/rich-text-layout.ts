/**
 * Rich text layout engine for markdown-parsed content.
 *
 * Takes parsed markdown blocks and performs multi-font word wrapping,
 * producing positioned styled runs ready for Canvas draw commands.
 */

import type { ParsedMarkdown, MarkdownBlock, TextSpan, SpanStyle, BlockType } from './markdown.js';
import { parseInline } from './markdown.js';
import type { ThemeData } from './widget-types.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface StyledRun {
  text: string;
  font: string;
  fill: string;
  href?: string;
  /** Measured pixel width (cached during layout). */
  width: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface LayoutLine {
  runs: StyledRun[];
  /** Y position (top of line). */
  y: number;
  /** Line height in pixels. */
  height: number;
  /** Left indent in pixels (for bullets, blockquotes). */
  indent: number;
  blockType: BlockType;
  /** True for the first line of a block. */
  blockStart: boolean;
  /** True for code-block lines that need a background rect. */
  codeBackground?: boolean;
  /** True for blockquote lines that need a left border. */
  quoteBorder?: boolean;
  /** Image data for image lines (drawn instead of `runs`). */
  image?: {
    url: string;
    alt: string;
    width: number;
    height: number;
    sourceStart: number;
    sourceEnd: number;
  };
}

export interface RichTextLayout {
  lines: LayoutLine[];
  totalHeight: number;
}

export type MeasureFn = (text: string, font: string) => Promise<number>;

/**
 * Resolve the natural pixel dimensions of an image URL, or null if unknown
 * (e.g., still loading). Implementations typically cache results and trigger
 * a relayout when a probe completes.
 */
export type ImageResolver = (url: string) => { width: number; height: number } | null;

// ── Font / Color Mapping ───────────────────────────────────────────────

function buildFontForStyle(
  style: SpanStyle,
  baseFontSize: number,
  headingScale: number,
  isBold: boolean,
): string {
  const family = style === 'code'
    ? '"JetBrains Mono", "Fira Code", monospace'
    : '"Inter", system-ui, sans-serif';
  const size = style === 'code' ? baseFontSize - 1 : Math.round(baseFontSize * headingScale);
  const weight = (style === 'bold' || style === 'bold-italic' || isBold) ? 'bold' : 'normal';
  const italic = (style === 'italic' || style === 'bold-italic') ? 'italic ' : '';
  return `${italic}${weight} ${size}px ${family}`;
}

function fillForStyle(
  style: SpanStyle,
  baseFill: string,
  theme: ThemeData,
): string {
  if (style === 'code') return theme.accent;
  if (style === 'link') return theme.linkColor;
  return baseFill;
}

// ── Word Segment ───────────────────────────────────────────────────────

interface WordSegment {
  text: string;
  font: string;
  fill: string;
  href?: string;
  sourceStart: number;
  sourceEnd: number;
  isWhitespace: boolean;
}

/**
 * Split a span's text into word segments at whitespace boundaries.
 */
function splitIntoSegments(
  text: string,
  font: string,
  fill: string,
  href: string | undefined,
  sourceStart: number,
  sourceEnd: number,
): WordSegment[] {
  const segments: WordSegment[] = [];
  // Split preserving whitespace as separate tokens
  const parts = text.split(/(\s+)/);
  let pos = 0;

  for (const part of parts) {
    if (part === '') continue;
    const isWs = /^\s+$/.test(part);
    // Map position within display text back to source position
    // This is approximate for styled spans where source includes delimiters
    const segSourceStart = sourceStart + Math.min(pos, sourceEnd - sourceStart);
    const segSourceEnd = sourceStart + Math.min(pos + part.length, sourceEnd - sourceStart);
    segments.push({
      text: part,
      font,
      fill,
      href,
      sourceStart: segSourceStart,
      sourceEnd: segSourceEnd,
      isWhitespace: isWs,
    });
    pos += part.length;
  }
  return segments;
}

// ── Layout Engine ──────────────────────────────────────────────────────

/**
 * Layout parsed markdown into positioned styled runs.
 */
export async function layoutRichText(
  parsed: ParsedMarkdown,
  maxWidth: number,
  measureFn: MeasureFn,
  theme: ThemeData,
  baseFontSize: number,
  baseFill: string,
  imageResolver?: ImageResolver,
): Promise<RichTextLayout> {
  const lines: LayoutLine[] = [];
  let y = 0;

  for (let bi = 0; bi < parsed.blocks.length; bi++) {
    const block = parsed.blocks[bi];

    // Inter-block spacing
    if (bi > 0) {
      if (block.type === 'heading') {
        y += 8;
      } else {
        y += 4;
      }
    }

    if (block.type === 'code-block') {
      y += 4; // top padding
      await layoutCodeBlock(block, lines, y, maxWidth, baseFontSize, theme, measureFn);
      y = lines.length > 0 ? lines[lines.length - 1].y + lines[lines.length - 1].height : y;
      y += 4; // bottom padding
      continue;
    }

    if (block.type === 'table' && block.cells) {
      y += 4; // top padding
      await layoutTable(block, lines, y, maxWidth, baseFontSize, theme, measureFn);
      y = lines.length > 0 ? lines[lines.length - 1].y + lines[lines.length - 1].height : y;
      y += 4; // bottom padding
      continue;
    }

    if (block.type === 'image' && block.imageUrl) {
      y += 4; // top padding
      const dims = computeImageDims(block, maxWidth, imageResolver);
      lines.push({
        runs: [],
        y,
        height: dims.height,
        indent: 0,
        blockType: 'image',
        blockStart: true,
        image: {
          url: block.imageUrl,
          alt: block.imageAlt ?? '',
          width: dims.width,
          height: dims.height,
          sourceStart: block.sourceStart,
          sourceEnd: block.sourceEnd,
        },
      });
      y += dims.height + 4; // include bottom padding
      continue;
    }

    const headingScale = block.type === 'heading'
      ? (block.level === 1 ? 1.4 : block.level === 2 ? 1.25 : 1.1)
      : 1;
    const isHeadingBold = block.type === 'heading';
    const indent = block.type === 'bullet' ? 16 : block.type === 'blockquote' ? 12 : 0;
    const blockFill = block.type === 'blockquote' ? theme.textSecondary : baseFill;
    const availWidth = maxWidth - indent;
    const lineHeight = Math.round(baseFontSize * headingScale) + 4;

    // Build word segments from all spans in this block
    const segments: WordSegment[] = [];

    // Prepend bullet character
    if (block.type === 'bullet') {
      const bulletFont = buildFontForStyle('normal', baseFontSize, 1, false);
      segments.push({
        text: '\u2022 ',
        font: bulletFont,
        fill: blockFill,
        sourceStart: block.sourceStart,
        sourceEnd: block.sourceStart,
        isWhitespace: false,
      });
    }

    for (const span of block.spans) {
      const font = buildFontForStyle(span.style, baseFontSize, headingScale, isHeadingBold);
      const fill = fillForStyle(span.style, blockFill, theme);
      const segs = splitIntoSegments(span.text, font, fill, span.href, span.sourceStart, span.sourceEnd);
      segments.push(...segs);
    }

    // Word-wrap segments into lines
    await wrapSegments(segments, availWidth, indent, lineHeight, block.type, block.type === 'blockquote', measureFn, lines, y);

    if (lines.length > 0) {
      y = lines[lines.length - 1].y + lines[lines.length - 1].height;
    }
  }

  return { lines, totalHeight: y };
}

function computeImageDims(
  block: MarkdownBlock,
  maxWidth: number,
  imageResolver: ImageResolver | undefined,
): { width: number; height: number } {
  // Explicit `|WxH` hint wins; fit to maxWidth if larger.
  if (block.imageWidth && block.imageHeight) {
    if (block.imageWidth > maxWidth) {
      const scale = maxWidth / block.imageWidth;
      return { width: maxWidth, height: Math.round(block.imageHeight * scale) };
    }
    return { width: block.imageWidth, height: block.imageHeight };
  }
  // Probed natural dimensions (resolver returns null while loading).
  if (imageResolver && block.imageUrl) {
    const probed = imageResolver(block.imageUrl);
    if (probed && probed.width > 0 && probed.height > 0) {
      const w = Math.min(probed.width, maxWidth);
      const h = Math.round(probed.height * (w / probed.width));
      return { width: w, height: h };
    }
  }
  // Placeholder: full width at 16:9 until natural dims are known.
  return { width: maxWidth, height: Math.round(maxWidth * 9 / 16) };
}

async function layoutCodeBlock(
  block: MarkdownBlock,
  lines: LayoutLine[],
  startY: number,
  maxWidth: number,
  baseFontSize: number,
  theme: ThemeData,
  measureFn: MeasureFn,
): Promise<void> {
  const codeFontSize = baseFontSize - 1;
  const lineHeight = codeFontSize + 4;
  const font = `${codeFontSize}px "JetBrains Mono", "Fira Code", monospace`;
  const fill = theme.textPrimary;
  const codeText = block.spans[0]?.text ?? '';
  const codeLines = codeText.split('\n');
  let y = startY;

  for (let i = 0; i < codeLines.length; i++) {
    const text = codeLines[i];
    const width = text.length > 0 ? await measureFn(text, font) : 0;
    lines.push({
      runs: [{
        text,
        font,
        fill,
        width,
        sourceStart: block.sourceStart,
        sourceEnd: block.sourceEnd,
      }],
      y,
      height: lineHeight,
      indent: 8, // code left padding
      blockType: 'code-block',
      blockStart: i === 0,
      codeBackground: true,
    });
    y += lineHeight;
  }
}

function tableFontForSpan(style: SpanStyle, size: number, isHeader: boolean): string {
  const italic = (style === 'italic' || style === 'bold-italic') ? 'italic ' : '';
  const weight = (isHeader || style === 'bold' || style === 'bold-italic') ? 'bold' : 'normal';
  // Use monospace for the whole table so fixed-width column padding still aligns.
  return `${italic}${weight} ${size}px "JetBrains Mono", "Fira Code", monospace`;
}

/** Word-wrap plain text into monospace lines of at most `maxChars`. */
function wrapCellByChars(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const out: string[] = [];
  let current = '';
  const parts = text.split(/(\s+)/);

  for (const part of parts) {
    if (part === '') continue;

    if ((current + part).length <= maxChars) {
      current += part;
      continue;
    }

    // Flush whatever we had before this too-long part.
    if (current.length > 0) {
      out.push(current);
      current = '';
    }

    if (part.length <= maxChars) {
      current = part.trimStart();
    } else {
      // Part alone is wider than the column — break at char boundaries.
      for (let i = 0; i < part.length; i += maxChars) {
        const chunk = part.slice(i, i + maxChars);
        if (i + maxChars >= part.length) {
          current = chunk;
        } else {
          out.push(chunk);
        }
      }
    }
  }

  if (current.length > 0) out.push(current);
  return out.length > 0 ? out : [''];
}

async function layoutTable(
  block: MarkdownBlock,
  lines: LayoutLine[],
  startY: number,
  maxWidth: number,
  baseFontSize: number,
  theme: ThemeData,
  measureFn: MeasureFn,
): Promise<void> {
  const rows = block.cells ?? [];
  if (rows.length === 0) return;

  const codeFontSize = baseFontSize - 1;
  const lineHeight = codeFontSize + 4;
  const defaultFill = theme.textPrimary;
  const headerFill = theme.accent;
  const COL_SEPARATOR = '  ';
  const SEPARATOR_CHARS = COL_SEPARATOR.length;
  const INDENT_PX = 8;
  const MIN_COL_CHARS = 8;

  // Parse each cell's inline markdown so **text** becomes a bold span etc.
  const rowsSpans: TextSpan[][][] = rows.map(row =>
    row.map(cell => parseInline(cell, 0)),
  );
  const plainCellText = (cellSpans: TextSpan[]): string =>
    cellSpans.map(s => s.text).join('');

  const colCount = Math.max(...rowsSpans.map(r => r.length));

  // Measure a single monospace char so we can budget the available width
  // in character columns.
  const probeFont = tableFontForSpan('normal', codeFontSize, false);
  const charPixelWidth = Math.max(1, await measureFn('M', probeFont));
  const budgetChars = Math.max(
    MIN_COL_CHARS * colCount + SEPARATOR_CHARS * (colCount - 1),
    Math.floor((maxWidth - INDENT_PX) / charPixelWidth),
  );

  // Natural (widest) column widths in chars.
  const naturalWidths: number[] = new Array(colCount).fill(0);
  for (const rowSpans of rowsSpans) {
    for (let c = 0; c < rowSpans.length; c++) {
      naturalWidths[c] = Math.max(naturalWidths[c], plainCellText(rowSpans[c]).length);
    }
  }

  // Shrink columns proportionally to fit the character budget. Keep a
  // minimum width per column so no column collapses.
  const usableChars = budgetChars - SEPARATOR_CHARS * Math.max(0, colCount - 1);
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
  let colWidths: number[];
  if (totalNatural <= usableChars) {
    colWidths = naturalWidths.slice();
  } else {
    const minTotal = MIN_COL_CHARS * colCount;
    const elastic = Math.max(1, usableChars - minTotal);
    const extraPool = Math.max(1, totalNatural - minTotal);
    colWidths = naturalWidths.map(w => {
      const above = Math.max(0, w - MIN_COL_CHARS);
      return MIN_COL_CHARS + Math.floor((above / extraPool) * elastic);
    });
    // Re-absorb rounding drift into the widest column.
    const drift = usableChars - colWidths.reduce((a, b) => a + b, 0);
    if (drift !== 0) {
      let widestIdx = 0;
      for (let c = 1; c < colWidths.length; c++) {
        if (colWidths[c] > colWidths[widestIdx]) widestIdx = c;
      }
      colWidths[widestIdx] = Math.max(MIN_COL_CHARS, colWidths[widestIdx] + drift);
    }
  }

  // Fast lookup: which cells fit on one line and can use per-span styling.
  const fitsOnOneLine = (cellSpans: TextSpan[], cIdx: number): boolean =>
    plainCellText(cellSpans).length <= (colWidths[cIdx] ?? 0);

  let y = startY;
  for (let ri = 0; ri < rowsSpans.length; ri++) {
    const rowSpans = rowsSpans[ri];
    const isHeader = ri === 0;
    const baseFill = isHeader ? headerFill : defaultFill;

    // Pre-wrap each cell to its column's char width. One-line cells
    // retain styled runs; multi-line cells fall back to plain wrapped text.
    const cellWraps: { kind: 'styled'; runs: StyledRun[]; plainLen: number }[]
      | { kind: 'plain'; lines: string[] }[] = [] as never;
    type WrapResult = { styled: StyledRun[]; plainLen: number } | { plain: string[] };
    const wraps: WrapResult[] = [];

    for (let c = 0; c < rowSpans.length; c++) {
      const cellSpans = rowSpans[c];
      const colW = colWidths[c] ?? 0;

      if (fitsOnOneLine(cellSpans, c)) {
        const runs: StyledRun[] = [];
        for (const span of cellSpans) {
          if (span.text.length === 0) continue;
          const font = tableFontForSpan(span.style, codeFontSize, isHeader);
          const fill = span.style === 'link'
            ? theme.linkColor
            : span.style === 'code'
              ? theme.accent
              : baseFill;
          const width = await measureFn(span.text, font);
          runs.push({
            text: span.text,
            font,
            fill,
            href: span.href,
            width,
            sourceStart: block.sourceStart,
            sourceEnd: block.sourceEnd,
          });
        }
        wraps.push({ styled: runs, plainLen: plainCellText(cellSpans).length });
      } else {
        wraps.push({ plain: wrapCellByChars(plainCellText(cellSpans), colW) });
      }
    }

    // Row height = tallest wrapped cell.
    const rowLineCount = Math.max(
      1,
      ...wraps.map(w => 'plain' in w ? w.plain.length : 1),
    );

    for (let li = 0; li < rowLineCount; li++) {
      const lineRuns: StyledRun[] = [];

      for (let c = 0; c < wraps.length; c++) {
        const wrap = wraps[c];
        const colW = colWidths[c] ?? 0;
        const isLastCol = c === wraps.length - 1;

        let visibleLen = 0;

        if ('styled' in wrap) {
          // One-line styled cell: emit runs only on the first line;
          // subsequent wrap lines (from other cells) just see padding.
          if (li === 0) {
            for (const run of wrap.styled) lineRuns.push(run);
            visibleLen = wrap.plainLen;
          }
        } else {
          // Multi-line plain cell: pick the wrapped line for this index.
          const lineText = wrap.plain[li] ?? '';
          if (lineText.length > 0) {
            const font = tableFontForSpan('normal', codeFontSize, isHeader);
            const width = await measureFn(lineText, font);
            lineRuns.push({
              text: lineText,
              font,
              fill: baseFill,
              width,
              sourceStart: block.sourceStart,
              sourceEnd: block.sourceEnd,
            });
          }
          visibleLen = lineText.length;
        }

        // Pad to column width and append the separator (unless last column).
        const padChars = Math.max(0, colW - visibleLen);
        const trailing = ' '.repeat(padChars) + (isLastCol ? '' : COL_SEPARATOR);
        if (trailing.length > 0) {
          const font = tableFontForSpan('normal', codeFontSize, isHeader);
          const width = await measureFn(trailing, font);
          lineRuns.push({
            text: trailing,
            font,
            fill: baseFill,
            width,
            sourceStart: block.sourceStart,
            sourceEnd: block.sourceEnd,
          });
        }
      }

      lines.push({
        runs: lineRuns,
        y,
        height: lineHeight,
        indent: INDENT_PX,
        blockType: 'table',
        blockStart: li === 0 && ri === 0,
      });
      y += lineHeight;
    }
  }
}

async function wrapSegments(
  segments: WordSegment[],
  maxWidth: number,
  indent: number,
  lineHeight: number,
  blockType: BlockType,
  quoteBorder: boolean,
  measureFn: MeasureFn,
  lines: LayoutLine[],
  startY: number,
): Promise<void> {
  if (maxWidth <= 0 || segments.length === 0) return;

  let currentRuns: StyledRun[] = [];
  let currentWidth = 0;
  let y = startY;
  let isFirstLine = true;

  const emitLine = () => {
    // Trim trailing whitespace runs
    while (currentRuns.length > 0 && currentRuns[currentRuns.length - 1].text.trim() === '') {
      currentRuns.pop();
    }
    if (currentRuns.length > 0) {
      lines.push({
        runs: currentRuns,
        y,
        height: lineHeight,
        indent,
        blockType,
        blockStart: isFirstLine,
        quoteBorder: quoteBorder && isFirstLine,
      });
    }
    currentRuns = [];
    currentWidth = 0;
    y += lineHeight;
    isFirstLine = false;
  };

  for (const seg of segments) {
    if (seg.isWhitespace) {
      // Skip leading whitespace on a new line
      if (currentRuns.length === 0) continue;
      const w = await measureFn(seg.text, seg.font);
      if (currentWidth + w > maxWidth) {
        emitLine();
        continue; // drop whitespace at line break
      }
      currentRuns.push({
        text: seg.text,
        font: seg.font,
        fill: seg.fill,
        href: seg.href,
        width: w,
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
      });
      currentWidth += w;
      continue;
    }

    const w = await measureFn(seg.text, seg.font);

    if (currentWidth + w <= maxWidth) {
      currentRuns.push({
        text: seg.text,
        font: seg.font,
        fill: seg.fill,
        href: seg.href,
        width: w,
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
      });
      currentWidth += w;
    } else if (currentRuns.length === 0) {
      // Single word wider than line: character-level break
      await charBreakRun(seg, maxWidth, measureFn, lines, y, lineHeight, indent, blockType, isFirstLine, quoteBorder);
      y = lines.length > 0 ? lines[lines.length - 1].y + lines[lines.length - 1].height : y;
      isFirstLine = false;
    } else {
      // Line is full: emit and retry this segment
      emitLine();
      // Re-process this segment on the new line
      const w2 = await measureFn(seg.text, seg.font);
      if (w2 <= maxWidth) {
        currentRuns.push({
          text: seg.text,
          font: seg.font,
          fill: seg.fill,
          href: seg.href,
          width: w2,
          sourceStart: seg.sourceStart,
          sourceEnd: seg.sourceEnd,
        });
        currentWidth = w2;
      } else {
        // Still too wide: character-level break
        await charBreakRun(seg, maxWidth, measureFn, lines, y, lineHeight, indent, blockType, isFirstLine, quoteBorder);
        y = lines.length > 0 ? lines[lines.length - 1].y + lines[lines.length - 1].height : y;
        isFirstLine = false;
      }
    }
  }

  // Emit remaining runs
  if (currentRuns.length > 0) {
    emitLine();
  }
}

async function charBreakRun(
  seg: WordSegment,
  maxWidth: number,
  measureFn: MeasureFn,
  lines: LayoutLine[],
  startY: number,
  lineHeight: number,
  indent: number,
  blockType: BlockType,
  isFirstLine: boolean,
  quoteBorder: boolean,
): Promise<void> {
  const chars = Array.from(seg.text);
  let charLine = '';
  let charWidth = 0;
  let y = startY;

  for (const ch of chars) {
    const candidate = charLine + ch;
    const candidateWidth = await measureFn(candidate, seg.font);
    if (candidateWidth > maxWidth && charLine !== '') {
      lines.push({
        runs: [{
          text: charLine,
          font: seg.font,
          fill: seg.fill,
          href: seg.href,
          width: charWidth,
          sourceStart: seg.sourceStart,
          sourceEnd: seg.sourceEnd,
        }],
        y,
        height: lineHeight,
        indent,
        blockType,
        blockStart: isFirstLine && lines.length === 0,
        quoteBorder: quoteBorder && isFirstLine && lines.length === 0,
      });
      y += lineHeight;
      charLine = ch;
      charWidth = await measureFn(ch, seg.font);
      isFirstLine = false;
    } else {
      charLine = candidate;
      charWidth = candidateWidth;
    }
  }

  if (charLine) {
    lines.push({
      runs: [{
        text: charLine,
        font: seg.font,
        fill: seg.fill,
        href: seg.href,
        width: charWidth,
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
      }],
      y,
      height: lineHeight,
      indent,
      blockType,
      blockStart: isFirstLine && lines.length === 0,
      quoteBorder: quoteBorder && isFirstLine && lines.length === 0,
    });
  }
}
