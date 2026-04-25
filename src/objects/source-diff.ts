/**
 * SEARCH/REPLACE block diff format for source modifications.
 *
 * The LLM emits one or more blocks of the form:
 *
 *   <<<<<<< SEARCH
 *   ...lines to find...
 *   =======
 *   ...replacement lines...
 *   >>>>>>> REPLACE
 *
 * Blocks are applied sequentially — each block sees the result of the prior
 * one. The matcher chain (ported from sst/opencode's edit tool) is tolerant
 * of common LLM mistakes: whitespace normalization, indentation drift,
 * escape-sequence rewriting, and anchor-based fuzzy matching for long blocks.
 *
 * Strategy precedence (first match wins):
 *   1. exact         — substring match
 *   2. line-trimmed  — same lines, ignoring per-line leading/trailing space
 *   3. block-anchor  — first + last line anchor with Levenshtein middle
 *   4. ws-normalized — collapse all whitespace runs to a single space
 *   5. indent-flex   — strip common minimum leading whitespace
 *   6. escape-norm   — interpret \n, \t, \r, etc.
 *   7. trim-bound    — leading/trailing whitespace tolerance
 *   8. context-aware — first/last line anchors with 50%-middle heuristic
 *   9. multi-occur   — for replaceAll fallback path
 *
 * Each block requires its match to be UNIQUE. If a candidate appears more
 * than once after a strategy succeeds, the matcher tries the next strategy
 * to find a more specific candidate. If no unique match is ever found, the
 * block fails with "ambiguous" so the LLM can supply more surrounding context.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

export interface BlockError {
  blockIndex: number;
  reason: 'not_found' | 'ambiguous' | 'identical';
  message: string;
  search: string;
}

export interface ApplyDiffResult {
  ok: boolean;
  source?: string;
  applied: number;
  errors: BlockError[];
}

export interface ParseDiffResult {
  blocks: SearchReplaceBlock[];
  parseErrors: string[];
}

// ── Parser ─────────────────────────────────────────────────────────────

const MARKER_SEARCH = /^<{5,}\s*SEARCH\s*$/;
const MARKER_DIVIDER = /^={5,}\s*$/;
const MARKER_REPLACE = /^>{5,}\s*REPLACE\s*$/;

/**
 * Parse SEARCH/REPLACE blocks from raw text. Tolerant of:
 * - Surrounding markdown code fences (```, ```diff, etc.)
 * - Extra blank lines between blocks
 * - Marker length variation (>=5 of the marker char)
 *
 * Returns parsed blocks and any structural errors encountered (mismatched
 * markers, missing dividers). Partial parses are still returned so the
 * caller can use what worked.
 */
export function parseSearchReplaceBlocks(text: string): ParseDiffResult {
  const blocks: SearchReplaceBlock[] = [];
  const parseErrors: string[] = [];

  // Strip outer fence if the entire response is wrapped in one
  let body = text.trim();
  const fenceMatch = body.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) body = fenceMatch[1];

  const lines = body.split('\n');
  let i = 0;
  let blockNum = 0;

  while (i < lines.length) {
    if (!MARKER_SEARCH.test(lines[i])) { i++; continue; }
    blockNum++;
    const startLine = i + 1;
    i++; // skip SEARCH marker

    const searchLines: string[] = [];
    while (i < lines.length && !MARKER_DIVIDER.test(lines[i])) {
      if (MARKER_SEARCH.test(lines[i]) || MARKER_REPLACE.test(lines[i])) {
        parseErrors.push(`block ${blockNum} (line ${startLine}): unexpected marker '${lines[i]}' inside SEARCH section — missing '======='`);
        break;
      }
      searchLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length || !MARKER_DIVIDER.test(lines[i])) {
      parseErrors.push(`block ${blockNum} (line ${startLine}): no '=======' divider before end of input`);
      continue;
    }
    i++; // skip divider

    const replaceLines: string[] = [];
    while (i < lines.length && !MARKER_REPLACE.test(lines[i])) {
      if (MARKER_SEARCH.test(lines[i]) || MARKER_DIVIDER.test(lines[i])) {
        parseErrors.push(`block ${blockNum} (line ${startLine}): unexpected marker '${lines[i]}' inside REPLACE section — missing '>>>>>>> REPLACE'`);
        break;
      }
      replaceLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length || !MARKER_REPLACE.test(lines[i])) {
      parseErrors.push(`block ${blockNum} (line ${startLine}): no '>>>>>>> REPLACE' marker before end of input`);
      continue;
    }
    i++; // skip REPLACE marker

    blocks.push({
      search: searchLines.join('\n'),
      replace: replaceLines.join('\n'),
    });
  }

  return { blocks, parseErrors };
}

// ── Apply ──────────────────────────────────────────────────────────────

/**
 * Apply SEARCH/REPLACE blocks to source. Each block is applied in order;
 * later blocks see the result of earlier ones. Returns the final source if
 * every block applied; otherwise returns the source as it was at the point
 * of first failure plus a list of per-block errors.
 *
 * Empty SEARCH is rejected (use draft_source for full replacement).
 */
export function applyDiff(source: string, blocks: SearchReplaceBlock[]): ApplyDiffResult {
  const errors: BlockError[] = [];
  let current = source;
  let applied = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.search.length === 0) {
      errors.push({
        blockIndex: i,
        reason: 'not_found',
        message: `block ${i + 1}: SEARCH is empty. Use draft_source for full-file replacement, or anchor your change to a unique snippet.`,
        search: block.search,
      });
      continue;
    }
    if (block.search === block.replace) {
      errors.push({
        blockIndex: i,
        reason: 'identical',
        message: `block ${i + 1}: SEARCH and REPLACE are identical — nothing would change.`,
        search: block.search,
      });
      continue;
    }
    try {
      current = replaceUnique(current, block.search, block.replace);
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason: BlockError['reason'] = msg.includes('multiple') ? 'ambiguous' : 'not_found';
      errors.push({
        blockIndex: i,
        reason,
        message: `block ${i + 1}: ${msg}`,
        search: block.search,
      });
    }
  }

  return {
    ok: errors.length === 0,
    source: errors.length === 0 ? current : undefined,
    applied,
    errors,
  };
}

// ── Replacer chain ─────────────────────────────────────────────────────
//
// Ported from sst/opencode's packages/opencode/src/tool/edit.ts (MIT).
// Each replacer is a generator yielding candidate substrings of `content`
// that the search MAY refer to; the caller then verifies each candidate
// is uniquely present before accepting it.

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

function* simpleReplacer(_content: string, find: string): Generator<string> {
  yield find;
}

function* lineTrimmedReplacer(content: string, find: string): Generator<string> {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  if (searchLines.length === 0) return;

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) { matches = false; break; }
    }
    if (!matches) continue;

    let start = 0;
    for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
    let end = start;
    for (let k = 0; k < searchLines.length; k++) {
      end += originalLines[i + k].length;
      if (k < searchLines.length - 1) end += 1;
    }
    yield content.substring(start, end);
  }
}

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  const m = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

const MULTI_CANDIDATE_THRESHOLD = 0.3;

function* blockAnchorReplacer(content: string, find: string): Generator<string> {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();

  const firstAnchor = searchLines[0].trim();
  const lastAnchor = searchLines[searchLines.length - 1].trim();

  const candidates: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstAnchor) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastAnchor) {
        candidates.push({ start: i, end: j });
        break;
      }
    }
  }
  if (candidates.length === 0) return;

  const yieldRange = (start: number, end: number) => {
    let s = 0;
    for (let k = 0; k < start; k++) s += originalLines[k].length + 1;
    let e = s;
    for (let k = start; k <= end; k++) {
      e += originalLines[k].length;
      if (k < end) e += 1;
    }
    return content.substring(s, e);
  };

  if (candidates.length === 1) {
    // Single-anchor match: anchors alone are enough (threshold 0.0).
    yield yieldRange(candidates[0].start, candidates[0].end);
    return;
  }

  let best: { start: number; end: number } | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const actualSize = c.end - c.start + 1;
    const middle = Math.min(searchLines.length - 2, actualSize - 2);
    let score = 0;
    if (middle > 0) {
      for (let j = 1; j < searchLines.length - 1 && j < actualSize - 1; j++) {
        const orig = originalLines[c.start + j].trim();
        const search = searchLines[j].trim();
        const maxLen = Math.max(orig.length, search.length);
        if (maxLen === 0) continue;
        score += 1 - levenshtein(orig, search) / maxLen;
      }
      score /= middle;
    } else {
      score = 1.0;
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= MULTI_CANDIDATE_THRESHOLD) {
    yield yieldRange(best.start, best.end);
  }
}

function* whitespaceNormalizedReplacer(content: string, find: string): Generator<string> {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  const target = norm(find);

  const lines = content.split('\n');
  for (const line of lines) {
    if (norm(line) === target) yield line;
  }

  const findLines = find.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (norm(block) === target) yield block;
    }
  }
}

function* indentationFlexibleReplacer(content: string, find: string): Generator<string> {
  const stripIndent = (text: string): string => {
    const lines = text.split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length === 0) return text;
    const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0));
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join('\n');
  };
  const target = stripIndent(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (stripIndent(block) === target) yield block;
  }
}

function* escapeNormalizedReplacer(content: string, find: string): Generator<string> {
  const unescape = (s: string) =>
    s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, c) => {
      switch (c) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case "'": return "'";
        case '"': return '"';
        case '`': return '`';
        case '\\': return '\\';
        case '\n': return '\n';
        case '$': return '$';
        default: return match;
      }
    });
  const target = unescape(find);
  if (content.includes(target)) yield target;

  const lines = content.split('\n');
  const findLines = target.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (unescape(block) === target) yield block;
  }
}

function* trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
  const trimmed = find.trim();
  if (trimmed === find) return;
  if (content.includes(trimmed)) yield trimmed;
  const lines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmed) yield block;
  }
}

function* contextAwareReplacer(content: string, find: string): Generator<string> {
  const findLines = find.split('\n');
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === '') findLines.pop();
  const contentLines = content.split('\n');
  const firstAnchor = findLines[0].trim();
  const lastAnchor = findLines[findLines.length - 1].trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstAnchor) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastAnchor) continue;
      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length !== findLines.length) { break; }
      let matching = 0;
      let total = 0;
      for (let k = 1; k < blockLines.length - 1; k++) {
        const a = blockLines[k].trim();
        const b = findLines[k].trim();
        if (a.length > 0 || b.length > 0) {
          total++;
          if (a === b) matching++;
        }
      }
      if (total === 0 || matching / total >= 0.5) {
        yield blockLines.join('\n');
      }
      break;
    }
  }
}

const REPLACERS: Replacer[] = [
  simpleReplacer,
  lineTrimmedReplacer,
  blockAnchorReplacer,
  whitespaceNormalizedReplacer,
  indentationFlexibleReplacer,
  escapeNormalizedReplacer,
  trimmedBoundaryReplacer,
  contextAwareReplacer,
];

/**
 * Find a unique occurrence of `search` in `content` using the replacer
 * chain, then replace it with `replacement`. Throws if no candidate is
 * found, or if every candidate appears more than once (caller must add
 * surrounding context to disambiguate).
 */
function replaceUnique(content: string, search: string, replacement: string): string {
  let everFound = false;
  for (const replacer of REPLACERS) {
    for (const candidate of replacer(content, search)) {
      const idx = content.indexOf(candidate);
      if (idx === -1) continue;
      everFound = true;
      const lastIdx = content.lastIndexOf(candidate);
      if (idx !== lastIdx) continue;
      return content.substring(0, idx) + replacement + content.substring(idx + candidate.length);
    }
  }
  if (!everFound) {
    throw new Error('SEARCH text not found in source. Check whitespace, indentation, and that the snippet exists verbatim.');
  }
  throw new Error('SEARCH text matched multiple locations. Add more surrounding context (3+ lines on each side) to make the match unique.');
}
