/**
 * Lightweight markdown parser for Canvas-based text rendering.
 *
 * Parses markdown into blocks (paragraphs, headings, bullets, code blocks,
 * blockquotes) containing inline spans (normal, bold, italic, code, links).
 * Tracks source offsets for each span so selection can map back to the
 * original text.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type SpanStyle = 'normal' | 'bold' | 'italic' | 'bold-italic' | 'code' | 'link';

export interface TextSpan {
  text: string;
  style: SpanStyle;
  href?: string;
  /** Start offset in the original markdown source. */
  sourceStart: number;
  /** End offset in the original markdown source. */
  sourceEnd: number;
}

export type BlockType = 'paragraph' | 'heading' | 'bullet' | 'code-block' | 'blockquote';

export interface MarkdownBlock {
  type: BlockType;
  /** Heading level (1-3) or bullet nesting (always 1). */
  level?: number;
  spans: TextSpan[];
  /** Optional language hint for code blocks. */
  language?: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface ParsedMarkdown {
  blocks: MarkdownBlock[];
  sourceText: string;
}

// ── Inline Parser ──────────────────────────────────────────────────────

/**
 * Parse inline markdown (bold, italic, code, links) within a block's text.
 * `baseOffset` is the source offset where `text` starts in the original string.
 */
function parseInline(text: string, baseOffset: number): TextSpan[] {
  const spans: TextSpan[] = [];
  let i = 0;
  let normalStart = 0;

  const flush = (end: number) => {
    if (end > normalStart) {
      spans.push({
        text: text.slice(normalStart, end),
        style: 'normal',
        sourceStart: baseOffset + normalStart,
        sourceEnd: baseOffset + end,
      });
    }
  };

  while (i < text.length) {
    // Inline code: `text`
    if (text[i] === '`') {
      const closeIdx = text.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        flush(i);
        spans.push({
          text: text.slice(i + 1, closeIdx),
          style: 'code',
          sourceStart: baseOffset + i,
          sourceEnd: baseOffset + closeIdx + 1,
        });
        i = closeIdx + 1;
        normalStart = i;
        continue;
      }
    }

    // Link: [text](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flush(i);
          const linkText = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          spans.push({
            text: linkText,
            style: 'link',
            href,
            sourceStart: baseOffset + i,
            sourceEnd: baseOffset + closeParen + 1,
          });
          i = closeParen + 1;
          normalStart = i;
          continue;
        }
      }
    }

    // Bold-italic: ***text***
    if (text[i] === '*' && text[i + 1] === '*' && text[i + 2] === '*') {
      const closeIdx = text.indexOf('***', i + 3);
      if (closeIdx !== -1) {
        flush(i);
        spans.push({
          text: text.slice(i + 3, closeIdx),
          style: 'bold-italic',
          sourceStart: baseOffset + i,
          sourceEnd: baseOffset + closeIdx + 3,
        });
        i = closeIdx + 3;
        normalStart = i;
        continue;
      }
    }

    // Bold: **text**
    if (text[i] === '*' && text[i + 1] === '*') {
      const closeIdx = text.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        flush(i);
        spans.push({
          text: text.slice(i + 2, closeIdx),
          style: 'bold',
          sourceStart: baseOffset + i,
          sourceEnd: baseOffset + closeIdx + 2,
        });
        i = closeIdx + 2;
        normalStart = i;
        continue;
      }
    }

    // Italic: *text* (but not mid-word like my_var)
    if (text[i] === '*' && text[i + 1] !== '*') {
      // Avoid matching mid-word asterisks
      const isWordBefore = i > 0 && /\w/.test(text[i - 1]);
      if (!isWordBefore) {
        const closeIdx = findClosingDelimiter(text, '*', i + 1);
        if (closeIdx !== -1) {
          flush(i);
          spans.push({
            text: text.slice(i + 1, closeIdx),
            style: 'italic',
            sourceStart: baseOffset + i,
            sourceEnd: baseOffset + closeIdx + 1,
          });
          i = closeIdx + 1;
          normalStart = i;
          continue;
        }
      }
    }

    i++;
  }

  flush(text.length);
  return spans;
}

/**
 * Find the closing single delimiter, avoiding double-delimiter matches.
 */
function findClosingDelimiter(text: string, delim: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === delim && (delim !== '*' || text[i + 1] !== '*')) {
      return i;
    }
  }
  return -1;
}

// ── Block Parser ───────────────────────────────────────────────────────

/**
 * Parse markdown text into blocks with inline spans.
 */
export function parseMarkdown(text: string): ParsedMarkdown {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  let offset = 0; // current position in source text
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = offset + line.length;

    // Fenced code block: ```
    if (line.trimStart().startsWith('```')) {
      const indent = line.length - line.trimStart().length;
      const language = line.trimStart().slice(3).trim() || undefined;
      const codeLines: string[] = [];
      const blockStart = offset;
      i++;
      offset = lineEnd + 1; // skip opening fence + newline

      while (i < lines.length) {
        const codeLine = lines[i];
        const codeLineEnd = offset + codeLine.length;
        if (codeLine.trimStart().startsWith('```')) {
          offset = codeLineEnd + 1;
          i++;
          break;
        }
        codeLines.push(codeLine);
        offset = codeLineEnd + 1;
        i++;
      }

      const codeText = codeLines.join('\n');
      // For code blocks, the source range covers the entire fenced block
      blocks.push({
        type: 'code-block',
        language,
        spans: [{
          text: codeText,
          style: 'code',
          sourceStart: blockStart,
          sourceEnd: offset - 1,
        }],
        sourceStart: blockStart,
        sourceEnd: offset - 1,
      });
      continue;
    }

    // Empty line: skip (adds spacing between blocks)
    if (line.trim() === '') {
      offset = lineEnd + 1;
      i++;
      continue;
    }

    // Heading: # text
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const contentText = headingMatch[2];
      const contentOffset = lineStart + headingMatch[1].length + 1; // after "# "
      blocks.push({
        type: 'heading',
        level,
        spans: parseInline(contentText, contentOffset),
        sourceStart: lineStart,
        sourceEnd: lineEnd,
      });
      offset = lineEnd + 1;
      i++;
      continue;
    }

    // Bullet: - text or * text (at start of line)
    const bulletMatch = line.match(/^(\s*[-*])\s+(.*)$/);
    if (bulletMatch) {
      const contentText = bulletMatch[2];
      const contentOffset = lineStart + bulletMatch[1].length + 1;
      blocks.push({
        type: 'bullet',
        level: 1,
        spans: parseInline(contentText, contentOffset),
        sourceStart: lineStart,
        sourceEnd: lineEnd,
      });
      offset = lineEnd + 1;
      i++;
      continue;
    }

    // Blockquote: > text
    if (line.startsWith('> ')) {
      const contentText = line.slice(2);
      const contentOffset = lineStart + 2;
      blocks.push({
        type: 'blockquote',
        spans: parseInline(contentText, contentOffset),
        sourceStart: lineStart,
        sourceEnd: lineEnd,
      });
      offset = lineEnd + 1;
      i++;
      continue;
    }

    // Paragraph: merge adjacent non-empty, non-special lines
    const paraLines: string[] = [line];
    let paraEnd = lineEnd;
    i++;
    offset = lineEnd + 1;

    while (i < lines.length) {
      const nextLine = lines[i];
      if (
        nextLine.trim() === '' ||
        nextLine.match(/^#{1,3}\s/) ||
        nextLine.match(/^\s*[-*]\s+/) ||
        nextLine.startsWith('> ') ||
        nextLine.trimStart().startsWith('```')
      ) {
        break;
      }
      paraLines.push(nextLine);
      paraEnd = offset + nextLine.length;
      offset = paraEnd + 1;
      i++;
    }

    const paraText = paraLines.join(' ');
    blocks.push({
      type: 'paragraph',
      spans: parseInline(paraText, lineStart),
      sourceStart: lineStart,
      sourceEnd: paraEnd,
    });
  }

  return { blocks, sourceText: text };
}

// ── Height Estimation ──────────────────────────────────────────────────

/**
 * Synchronous heuristic to estimate the rendered height of markdown text.
 * Used by Chat for label sizing before async layout runs.
 */
export function estimateMarkdownHeight(
  text: string,
  maxWidthPx: number,
  baseFontSize: number,
): number {
  if (!text || maxWidthPx <= 0) return 20;

  const lines = text.split('\n');
  let totalHeight = 0;
  let i = 0;
  let prevBlock = false;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      if (prevBlock) totalHeight += 4;
      i++;
      let codeLineCount = 0;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLineCount++;
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      const codeFontSize = baseFontSize - 1;
      totalHeight += codeLineCount * (codeFontSize + 4) + 8; // 4px padding top+bottom
      prevBlock = true;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    if (prevBlock) totalHeight += 4;

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const scale = level === 1 ? 1.4 : level === 2 ? 1.25 : 1.1;
      const headingFontSize = baseFontSize * scale;
      totalHeight += 8; // top margin before heading
      totalHeight += headingFontSize + 4;
      prevBlock = true;
      i++;
      continue;
    }

    // Bullet
    if (line.match(/^\s*[-*]\s+/)) {
      const bulletText = line.replace(/^\s*[-*]\s+/, '');
      const availWidth = maxWidthPx - 16; // indent
      totalHeight += estimateTextHeight(bulletText, availWidth, baseFontSize);
      prevBlock = true;
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteText = line.slice(2);
      const availWidth = maxWidthPx - 12; // indent
      totalHeight += estimateTextHeight(quoteText, availWidth, baseFontSize);
      prevBlock = true;
      i++;
      continue;
    }

    // Paragraph (merge adjacent lines)
    let paraText = line;
    i++;
    while (i < lines.length) {
      const nextLine = lines[i];
      if (
        nextLine.trim() === '' ||
        nextLine.match(/^#{1,3}\s/) ||
        nextLine.match(/^\s*[-*]\s+/) ||
        nextLine.startsWith('> ') ||
        nextLine.trimStart().startsWith('```')
      ) break;
      paraText += ' ' + nextLine;
      i++;
    }
    totalHeight += estimateTextHeight(paraText, maxWidthPx, baseFontSize);
    prevBlock = true;
  }

  return Math.max(20, totalHeight);
}

function estimateTextHeight(text: string, maxWidthPx: number, fontSize: number): number {
  const avgCharWidth = fontSize * 0.55;
  const charsPerLine = Math.max(1, Math.floor(maxWidthPx / avgCharWidth));
  // Strip markdown delimiters for length estimate
  const stripped = text.replace(/\*{1,3}|`|(?:\[([^\]]*)\]\([^)]*\))/g, '$1');
  const lineCount = Math.max(1, Math.ceil(stripped.length / charsPerLine));
  return lineCount * (fontSize + 4);
}
