/**
 * Handler-level diff format for efficient ScriptableAbject modifications.
 *
 * Instead of rewriting the entire handler map, the LLM outputs only the
 * handlers that changed (MODIFY, ADD, REMOVE). This module parses that
 * format and applies it to existing source using the handler-parser
 * infrastructure.
 */

import { parseHandlerMap, reassembleHandlerMap, type HandlerEntry, type EntryType } from './widgets/handler-parser.js';

// ── Types ──────────────────────────────────────────────────────────────

export type HandlerDiffOp =
  | { action: 'modify'; name: string; body: string }
  | { action: 'add'; name: string; body: string }
  | { action: 'remove'; name: string };

export interface HandlerDiff {
  operations: HandlerDiffOp[];
}

// ── Parser ─────────────────────────────────────────────────────────────

const ACTION_RE = /^(MODIFY|ADD|REMOVE)\s+(\S+?):\s*$/;
const REMOVE_RE = /^REMOVE\s+(\S+)\s*$/;

/**
 * Parse a handler-diff block (the content inside ```handler-diff ... ```)
 * into structured operations. Returns null if the format is invalid.
 */
export function parseHandlerDiff(text: string): HandlerDiff | null {
  const lines = text.split('\n');
  const operations: HandlerDiffOp[] = [];
  let i = 0;

  while (i < lines.length) {
    // Skip blank lines
    if (lines[i].trim() === '') { i++; continue; }

    // Try REMOVE (single-line, no body)
    const removeMatch = lines[i].match(REMOVE_RE);
    if (removeMatch) {
      operations.push({ action: 'remove', name: removeMatch[1] });
      i++;
      continue;
    }

    // Try MODIFY or ADD (action + body)
    const actionMatch = lines[i].match(ACTION_RE);
    if (!actionMatch) {
      // Unknown line - skip (lenient parsing)
      i++;
      continue;
    }

    const action = actionMatch[1].toLowerCase() as 'modify' | 'add';
    const name = actionMatch[2];
    i++;

    // Collect the handler body: everything until the next action keyword or end
    const bodyLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      // Check if this line starts a new action
      if (ACTION_RE.test(line) || REMOVE_RE.test(line)) break;
      bodyLines.push(line);
      i++;
    }

    // Trim trailing blank lines from body
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
      bodyLines.pop();
    }

    const body = bodyLines.join('\n').trim();
    if (!body) return null; // MODIFY/ADD without a body is invalid

    operations.push({ action, name, body });
  }

  if (operations.length === 0) return null;
  return { operations };
}

// ── Validator ──────────────────────────────────────────────────────────

/**
 * Validate a diff against current source. Returns a list of error strings.
 */
export function validateDiff(currentSource: string, diff: HandlerDiff): string[] {
  const entries = parseHandlerMap(currentSource);
  const nameSet = new Set(entries.map(e => e.name));
  const errors: string[] = [];

  for (const op of diff.operations) {
    if (op.action === 'modify' && !nameSet.has(op.name)) {
      errors.push(`MODIFY references nonexistent handler '${op.name}'`);
    }
    if (op.action === 'remove' && !nameSet.has(op.name)) {
      errors.push(`REMOVE references nonexistent handler '${op.name}'`);
    }
    if (op.action === 'add' && nameSet.has(op.name)) {
      // Treat ADD of existing name as MODIFY (lenient)
    }
  }

  return errors;
}

// ── Applicator ─────────────────────────────────────────────────────────

/**
 * Apply a handler diff to existing source code.
 * Returns the new source string or an error.
 */
export function applyHandlerDiff(
  currentSource: string,
  diff: HandlerDiff,
): { success: boolean; source?: string; error?: string } {
  const entries = parseHandlerMap(currentSource);
  const byName = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    byName.set(entries[i].name, i);
  }

  // Apply operations in order
  for (const op of diff.operations) {
    switch (op.action) {
      case 'modify': {
        const idx = byName.get(op.name);
        if (idx === undefined) {
          // Lenient: treat as ADD if name doesn't exist
          const type = classifyEntry(op.name, op.body);
          entries.push({ name: op.name, type, body: op.body });
          byName.set(op.name, entries.length - 1);
        } else {
          entries[idx] = { name: op.name, type: classifyEntry(op.name, op.body), body: op.body };
        }
        break;
      }
      case 'add': {
        const existingIdx = byName.get(op.name);
        if (existingIdx !== undefined) {
          // Already exists: treat as modify (lenient)
          entries[existingIdx] = { name: op.name, type: classifyEntry(op.name, op.body), body: op.body };
        } else {
          const type = classifyEntry(op.name, op.body);
          entries.push({ name: op.name, type, body: op.body });
          byName.set(op.name, entries.length - 1);
        }
        break;
      }
      case 'remove': {
        const idx = byName.get(op.name);
        if (idx === undefined) {
          // Already absent: silently skip (lenient)
        } else {
          entries.splice(idx, 1);
          // Rebuild index after splice
          byName.clear();
          for (let i = 0; i < entries.length; i++) byName.set(entries[i].name, i);
        }
        break;
      }
    }
  }

  // Filter out any empty entries
  const filtered = entries.filter(e => e.body.trim() !== '');
  if (filtered.length === 0) {
    return { success: false, error: 'All handlers removed - result would be empty' };
  }

  const source = reassembleHandlerMap(filtered);
  return { success: true, source };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Classify an entry by its name and body content.
 */
function classifyEntry(name: string, body: string): EntryType {
  // Properties: `name: value` form without function body
  if (body.match(/^\w+\s*:/) && !body.match(/^\w+\s*:\s*(async\s+)?function/)) {
    // Check if it looks like a property assignment (no parens for method shorthand)
    const afterColon = body.slice(body.indexOf(':') + 1).trim();
    if (!afterColon.startsWith('function') && !afterColon.startsWith('async function')) {
      // Could be property if there's no `(` before `{`
      const parenIdx = afterColon.indexOf('(');
      const braceIdx = afterColon.indexOf('{');
      if (parenIdx === -1 || (braceIdx !== -1 && braceIdx < parenIdx)) {
        return 'property';
      }
    }
  }
  return name.startsWith('_') ? 'helper' : 'handler';
}

// ── Response Parser ────────────────────────────────────────────────────

/**
 * Extract a handler-diff or full-rewrite response from LLM output.
 *
 * Returns:
 *   { type: 'diff', diff }          if a ```handler-diff block was found
 *   { type: 'full-rewrite', code }  if FULL_REWRITE + ```javascript was found
 *   null                            if neither format was found
 */
export function parseDiffResponse(content: string): {
  type: 'diff'; diff: HandlerDiff;
} | {
  type: 'full-rewrite'; code: string;
} | null {
  // Check for handler-diff block
  const diffMatch = content.match(/```handler-diff\s*([\s\S]*?)\s*```/);
  if (diffMatch) {
    const diff = parseHandlerDiff(diffMatch[1]);
    if (diff) return { type: 'diff', diff };
  }

  // Check for FULL_REWRITE with javascript block
  if (content.includes('FULL_REWRITE')) {
    const codeMatch = content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
    if (codeMatch) return { type: 'full-rewrite', code: codeMatch[1] };
  }

  // Fallback: try javascript block even without FULL_REWRITE marker
  // (LLM might just output a code block)
  const jsMatch = content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
  if (jsMatch) return { type: 'full-rewrite', code: jsMatch[1] };

  return null;
}
