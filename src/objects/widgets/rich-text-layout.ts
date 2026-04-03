/**
 * Rich text layout engine for markdown-parsed content.
 *
 * Takes parsed markdown blocks and performs multi-font word wrapping,
 * producing positioned styled runs ready for Canvas draw commands.
 */

import type { ParsedMarkdown, MarkdownBlock, TextSpan, SpanStyle, BlockType } from './markdown.js';
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
}

export interface RichTextLayout {
  lines: LayoutLine[];
  totalHeight: number;
}

export type MeasureFn = (text: string, font: string) => Promise<number>;

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

async function layoutTable(
  block: MarkdownBlock,
  lines: LayoutLine[],
  startY: number,
  _maxWidth: number,
  baseFontSize: number,
  theme: ThemeData,
  measureFn: MeasureFn,
): Promise<void> {
  const rows = block.cells ?? [];
  if (rows.length === 0) return;

  const codeFontSize = baseFontSize - 1;
  const lineHeight = codeFontSize + 4;
  const font = `${codeFontSize}px "JetBrains Mono", "Fira Code", monospace`;
  const headerFont = `bold ${codeFontSize}px "JetBrains Mono", "Fira Code", monospace`;
  const fill = theme.textPrimary;
  const headerFill = theme.accent;

  // Compute max column count and widths (in characters)
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], row[c].length);
    }
  }

  // Format each row as a padded string and create layout lines
  let y = startY;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const isHeader = ri === 0;
    const padded = row.map((cell, c) => cell.padEnd(colWidths[c] ?? cell.length)).join('  ');
    const rowFont = isHeader ? headerFont : font;
    const rowFill = isHeader ? headerFill : fill;
    const width = padded.length > 0 ? await measureFn(padded, rowFont) : 0;

    lines.push({
      runs: [{
        text: padded,
        font: rowFont,
        fill: rowFill,
        width,
        sourceStart: block.sourceStart,
        sourceEnd: block.sourceEnd,
      }],
      y,
      height: lineHeight,
      indent: 8,
      blockType: 'table',
      blockStart: ri === 0,
    });
    y += lineHeight;
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
