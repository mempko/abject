/**
 * One truncation contract for every capability that hands bulk text back to an
 * agent.
 *
 * Two independent limits, whichever is hit first wins: a line count and a byte
 * count. A file read truncates from the HEAD (you want the top of the file and
 * a way to continue); a command's output truncates from the TAIL (the error is
 * at the end). Neither ever returns a partial line, except where a single line
 * is itself larger than the whole byte budget.
 *
 * Callers that genuinely need everything pass `maxLines: 0` / `maxBytes: 0`,
 * which disables that limit. Anything oversized should ride back through the
 * agent runtime's payload handle (see `bulkAwareResult` in agent-abject.ts) so
 * the agent can grep it rather than re-read it.
 */

import { require as contractRequire, ensure } from './contracts.js';

/** Line budget: enough to read a whole ordinary source file in one call. */
export const DEFAULT_MAX_LINES = 2000;
/** Byte budget: roughly 12k tokens of source, which is a fair single bite. */
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationOptions {
  /** Maximum lines to return; 0 disables the line limit. */
  maxLines?: number;
  /** Maximum bytes to return; 0 disables the byte limit. */
  maxBytes?: number;
}

export interface TruncationResult {
  /** The kept text. */
  content: string;
  /** Whether anything was dropped. */
  truncated: boolean;
  /** Which budget ran out first. */
  truncatedBy: 'lines' | 'bytes' | null;
  /** Lines in the original text. */
  totalLines: number;
  /** Bytes in the original text. */
  totalBytes: number;
  /** Lines in `content`. */
  outputLines: number;
  /**
   * Set when the very first kept line alone blows the byte budget, so the
   * caller can say "use a different tool" instead of returning half a line.
   */
  firstLineExceedsLimit: boolean;
}

/** Human-readable byte size, for notices the agent reads. */
export function formatSize(bytes: number): string {
  contractRequire(Number.isFinite(bytes) && bytes >= 0, 'bytes must be a non-negative number');
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Split into lines without inventing a trailing empty one. */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function resolveLimits(opts?: TruncationOptions): { maxLines: number; maxBytes: number } {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  contractRequire(maxLines >= 0, 'maxLines must be non-negative (0 disables the limit)');
  contractRequire(maxBytes >= 0, 'maxBytes must be non-negative (0 disables the limit)');
  return { maxLines, maxBytes };
}

function baseResult(content: string, lines: string[]): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines: lines.length,
    totalBytes: byteLen(content),
    outputLines: lines.length,
    firstLineExceedsLimit: false,
  };
}

/** Keep the beginning. Used for file reads, where you continue with an offset. */
export function truncateHead(content: string, opts?: TruncationOptions): TruncationResult {
  contractRequire(typeof content === 'string', 'content must be a string');
  const { maxLines, maxBytes } = resolveLimits(opts);
  const lines = splitLines(content);
  const result = baseResult(content, lines);

  if (lines.length === 0) return result;

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' | null = null;

  for (const line of lines) {
    if (maxLines > 0 && kept.length >= maxLines) { truncatedBy = 'lines'; break; }
    // +1 for the newline that will rejoin this line to the previous one.
    const cost = byteLen(line) + (kept.length > 0 ? 1 : 0);
    if (maxBytes > 0 && bytes + cost > maxBytes) {
      truncatedBy = 'bytes';
      if (kept.length === 0) result.firstLineExceedsLimit = true;
      break;
    }
    kept.push(line);
    bytes += cost;
  }

  if (truncatedBy === null) return result;

  result.content = kept.join('\n');
  result.truncated = true;
  result.truncatedBy = truncatedBy;
  result.outputLines = kept.length;
  ensure(result.outputLines <= lines.length, 'truncation cannot invent lines');
  return result;
}

/** Keep the end. Used for command output, where the failure is at the bottom. */
export function truncateTail(content: string, opts?: TruncationOptions): TruncationResult {
  contractRequire(typeof content === 'string', 'content must be a string');
  const { maxLines, maxBytes } = resolveLimits(opts);
  const lines = splitLines(content);
  const result = baseResult(content, lines);

  if (lines.length === 0) return result;

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (maxLines > 0 && kept.length >= maxLines) { truncatedBy = 'lines'; break; }
    const cost = byteLen(lines[i]) + (kept.length > 0 ? 1 : 0);
    if (maxBytes > 0 && bytes + cost > maxBytes) {
      truncatedBy = 'bytes';
      if (kept.length === 0) result.firstLineExceedsLimit = true;
      break;
    }
    kept.push(lines[i]);
    bytes += cost;
  }

  if (truncatedBy === null) return result;

  kept.reverse();
  result.content = kept.join('\n');
  result.truncated = true;
  result.truncatedBy = truncatedBy;
  result.outputLines = kept.length;
  return result;
}

/**
 * The notice that turns a truncated read into an actionable one: it says where
 * the window sits and exactly what to pass to continue. Without this an agent
 * either assumes it saw the whole file or re-reads it from the top.
 */
export function continuationNotice(
  t: TruncationResult,
  startLine: number,
  totalLines: number,
): string {
  const endLine = startLine + t.outputLines - 1;
  const nextOffset = endLine + 1;
  const why = t.truncatedBy === 'bytes' ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : '';
  return `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}${why}. Use offset=${nextOffset} to continue.]`;
}

/** The tail-truncation equivalent: what was dropped off the front. */
export function droppedNotice(t: TruncationResult): string {
  if (!t.truncated) return '';
  const droppedLines = t.totalLines - t.outputLines;
  return `\n[... ${droppedLines} earlier line${droppedLines === 1 ? '' : 's'} dropped; ` +
    `showing the last ${t.outputLines} of ${t.totalLines} lines, ${formatSize(t.totalBytes)} total]\n`;
}
