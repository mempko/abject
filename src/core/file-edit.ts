/**
 * Exact-text file editing: a whole change-set applied as one transaction.
 *
 * Every `oldText` is matched against the ORIGINAL content, never against the
 * result of an earlier edit in the same set. That makes an edit set order-free
 * and lets the whole set be validated before anything is written: if any edit
 * fails to find a unique, non-overlapping home, nothing is applied and every
 * failure is reported together. A half-applied edit set is the one outcome
 * worth ruling out entirely, because it leaves a file no one authored.
 *
 * The returned diff is the evidence the caller should read. Re-reading the file
 * to see what happened costs a step and teaches less than the hunks do.
 */

import { require as contractRequire, ensure } from './contracts.js';

export interface FileEdit {
  /** Exact text to replace. Must occur exactly once in the original. */
  oldText: string;
  /** What to put there. */
  newText: string;
}

export interface EditFailure {
  index: number;
  oldText: string;
  reason: 'not-found' | 'not-unique' | 'overlap';
  message: string;
  /** For `not-found`, the closest thing in the file, to localize the miss. */
  hint?: string;
}

export interface ApplyEditsResult {
  ok: boolean;
  /** The new content. Only meaningful when `ok`. */
  content: string;
  /** Unified-style hunks for the applied edits. Only meaningful when `ok`. */
  diff: string;
  failures: EditFailure[];
  /** Number of edits applied (all of them, or none). */
  applied: number;
  /** 1-based line numbers touched, for a caller that wants to name them. */
  changedLines: number[];
}

/** 1-based line number of a character offset. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * The closest single line to a failed search, so "not found" points somewhere
 * instead of just saying no. Cheap heuristic: the line sharing the longest
 * common prefix with the search text's first line.
 */
function closestLineHint(content: string, oldText: string): string | undefined {
  const needle = oldText.split('\n')[0].trim();
  if (needle.length < 4) return undefined;
  const lines = content.split('\n');
  let bestScore = 0;
  let bestLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i].trim();
    let score = 0;
    while (score < needle.length && score < candidate.length && needle[score] === candidate[score]) score++;
    if (score > bestScore) { bestScore = score; bestLine = i; }
  }
  // Require a real prefix overlap before claiming a hint.
  if (bestLine < 0 || bestScore < Math.max(6, needle.length / 3)) return undefined;
  return `closest line is ${bestLine + 1}: ${lines[bestLine].trim().slice(0, 120)}`;
}

/** Render one replacement as a diff hunk with a little context. */
function renderHunk(
  original: string,
  start: number,
  oldText: string,
  newText: string,
  contextLines = 2,
): string {
  const startLine = lineOf(original, start);
  const before = original.split('\n');
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const ctxStart = Math.max(0, startLine - 1 - contextLines);
  const ctxEndExclusive = Math.min(before.length, startLine - 1 + oldLines.length + contextLines);

  const out: string[] = [`@@ line ${startLine} @@`];
  for (let i = ctxStart; i < startLine - 1; i++) out.push(`  ${before[i]}`);
  for (const l of oldLines) out.push(`- ${l}`);
  for (const l of newLines) out.push(`+ ${l}`);
  for (let i = startLine - 1 + oldLines.length; i < ctxEndExclusive; i++) out.push(`  ${before[i]}`);
  return out.join('\n');
}

/**
 * Validate and apply a whole edit set. Nothing is written here — the caller
 * decides what to do with `content`, which keeps this pure and testable by
 * inspection.
 */
export function applyEdits(original: string, edits: readonly FileEdit[]): ApplyEditsResult {
  contractRequire(typeof original === 'string', 'original must be a string');
  contractRequire(Array.isArray(edits), 'edits must be an array');

  const failures: EditFailure[] = [];
  const spans: Array<{ index: number; start: number; end: number; edit: FileEdit }> = [];

  edits.forEach((edit, index) => {
    if (typeof edit?.oldText !== 'string' || edit.oldText.length === 0) {
      failures.push({
        index, oldText: String(edit?.oldText ?? ''), reason: 'not-found',
        message: `edits[${index}].oldText must be a non-empty string`,
      });
      return;
    }
    if (typeof edit.newText !== 'string') {
      failures.push({
        index, oldText: edit.oldText, reason: 'not-found',
        message: `edits[${index}].newText must be a string`,
      });
      return;
    }

    const first = original.indexOf(edit.oldText);
    if (first === -1) {
      failures.push({
        index, oldText: edit.oldText, reason: 'not-found',
        message: `edits[${index}].oldText was not found in the file`,
        hint: closestLineHint(original, edit.oldText),
      });
      return;
    }
    const last = original.lastIndexOf(edit.oldText);
    if (last !== first) {
      let count = 0;
      let at = first;
      while (at !== -1) { count++; at = original.indexOf(edit.oldText, at + 1); }
      failures.push({
        index, oldText: edit.oldText, reason: 'not-unique',
        message:
          `edits[${index}].oldText matches ${count} places (first at line ${lineOf(original, first)}, ` +
          `last at line ${lineOf(original, last)}). Add just enough surrounding context to make it unique.`,
      });
      return;
    }
    spans.push({ index, start: first, end: first + edit.oldText.length, edit });
  });

  // Overlap is checked across the whole set, since every edit addresses the
  // original: two edits over the same region would each look fine alone.
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.start < prev.end) {
      failures.push({
        index: cur.index, oldText: cur.edit.oldText, reason: 'overlap',
        message:
          `edits[${cur.index}] overlaps edits[${prev.index}] (both cover line ` +
          `${lineOf(original, cur.start)}). Merge them into one edit.`,
      });
    }
  }

  if (failures.length > 0) {
    return { ok: false, content: original, diff: '', failures, applied: 0, changedLines: [] };
  }

  // Apply back-to-front so earlier offsets stay valid.
  let content = original;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i];
    content = content.slice(0, s.start) + s.edit.newText + content.slice(s.end);
  }

  const hunks = ordered.map(s => renderHunk(original, s.start, s.edit.oldText, s.edit.newText));
  const changedLines = ordered.map(s => lineOf(original, s.start));

  ensure(failures.length === 0, 'a successful apply reports no failures');
  return {
    ok: true,
    content,
    diff: hunks.join('\n\n'),
    failures: [],
    applied: ordered.length,
    changedLines,
  };
}

/** One-line-per-failure rendering, for handing straight back to an agent. */
export function formatEditFailures(failures: readonly EditFailure[]): string {
  return failures
    .map(f => (f.hint ? `${f.message} (${f.hint})` : f.message))
    .join('\n');
}
