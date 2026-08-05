/**
 * Minimal markdown -> ANSI terminal rendering for chat transcripts.
 *
 * Handles the subset agents actually produce: bold, italic, inline code,
 * links, headings, bullet lists, code fences, blockquotes, and horizontal
 * rules. Inline styling is embedded as SGR escape codes; the Screen wrapper
 * is ANSI-aware so styled text wraps and truncates correctly.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const CYAN = '\x1b[36m';
const INTENSITY_OFF = '\x1b[22m'; // closes both bold and dim
const ITALIC_OFF = '\x1b[23m';
const FG_OFF = '\x1b[39m';

export interface MdLine {
  text: string;
  /** Line is de-emphasized as a whole (code blocks, rules). */
  dim?: boolean;
}

/** Apply inline markdown styling (code spans win over emphasis inside them). */
export function mdInline(source: string): string {
  return source.split(/(`[^`]*`)/).map((part) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      return CYAN + part.slice(1, -1) + FG_OFF;
    }
    return part
      .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${INTENSITY_OFF}`)
      .replace(/__([^_]+)__/g, `${BOLD}$1${INTENSITY_OFF}`)
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, `$1${ITALIC}$2${ITALIC_OFF}`)
      .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 ${DIM}($2)${INTENSITY_OFF}`);
  }).join('');
}

/** Render a markdown message into terminal lines with embedded SGR codes. */
export function renderMarkdown(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push({ text: '  ' + raw, dim: true });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push({ text: BOLD + mdInline(heading[2]) + INTENSITY_OFF });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push({ text: '─'.repeat(36), dim: true });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push({ text: `${DIM}│ ${INTENSITY_OFF}` + mdInline(quote[1]) });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      out.push({ text: `${bullet[1]}• ${mdInline(bullet[2])}` });
      continue;
    }
    out.push({ text: mdInline(raw) });
  }
  return out;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
