/**
 * A small .gitignore matcher, so directory walks stop wading through
 * `node_modules`, `dist`, and `.git`.
 *
 * This is not a complete gitignore implementation and does not try to be: it
 * covers comments, blank lines, negation, anchoring, directory-only rules, and
 * the `*` / `?` / `**` wildcards, which is what real ignore files use. Anything
 * it fails to understand is treated as "does not match", so an unsupported rule
 * makes the walk broader rather than silently hiding files.
 *
 * Rules are collected per directory as the walk descends, matching git's own
 * semantics closely enough that a walk of a real repo returns what a developer
 * would expect to see.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { require as contractRequire } from './contracts.js';

/**
 * Always skipped, whether or not an ignore file mentions them. `.git` is never
 * interesting to read and is enormous; the rest are the near-universal build
 * and dependency directories that would otherwise dominate every result set.
 */
export const ALWAYS_IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.venv', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.turbo', '.cache',
  'target', 'vendor',
]);

interface IgnoreRule {
  /** Compiled matcher against a path relative to the rule's base directory. */
  regex: RegExp;
  /** A `!` rule un-ignores what an earlier rule ignored. */
  negated: boolean;
  /** A trailing `/` means the rule only matches directories. */
  dirOnly: boolean;
  /** Directory the rule was declared in; matches are relative to it. */
  base: string;
}

/** Translate one gitignore pattern into a regex over a relative path. */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` crosses directory boundaries; `**/` may also match nothing.
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  // An unanchored pattern matches at any depth, exactly as git treats a
  // pattern with no interior slash.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // Matching a directory implicitly matches everything beneath it.
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

function parseIgnoreFile(content: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split('\n')) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);

    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);

    // A leading slash anchors to the ignore file's own directory; so does any
    // interior slash, per gitignore's rules.
    let anchored = false;
    if (line.startsWith('/')) { anchored = true; line = line.slice(1); }
    else if (line.includes('/')) anchored = true;

    if (line.length === 0) continue;
    rules.push({ regex: patternToRegex(line, anchored), negated, dirOnly, base });
  }
  return rules;
}

/**
 * The accumulated ignore rules in force at some point in a walk. Immutable:
 * descending into a directory produces a new set rather than mutating the
 * parent's, so sibling branches never see each other's rules.
 */
export class IgnoreSet {
  private constructor(private readonly rules: readonly IgnoreRule[]) {}

  static empty(): IgnoreSet {
    return new IgnoreSet([]);
  }

  /** Read `dir/.gitignore` (when present) and return the extended set. */
  async extend(dir: string): Promise<IgnoreSet> {
    contractRequire(typeof dir === 'string' && dir.length > 0, 'dir must be a non-empty string');
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8');
    } catch {
      return this;
    }
    const added = parseIgnoreFile(content, dir);
    return added.length > 0 ? new IgnoreSet([...this.rules, ...added]) : this;
  }

  /**
   * Whether an absolute path is ignored. Later rules win, which is how a
   * negation placed below a broad ignore re-includes a file.
   */
  ignores(absolutePath: string, isDirectory: boolean): boolean {
    const name = path.basename(absolutePath);
    if (isDirectory && ALWAYS_IGNORED_DIRS.has(name)) return true;

    let ignored = false;
    for (const rule of this.rules) {
      const rel = path.relative(rule.base, absolutePath);
      // Outside this rule's directory entirely.
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

      // A `dir/` rule excludes the directory, and everything under it comes
      // along. Asked about a file directly, test its parent: that both keeps
      // `dist/` from matching a *file* named `dist` and still excludes
      // `dist/bundle.js` for a caller that did not walk down to it.
      const subject = rule.dirOnly && !isDirectory ? path.dirname(rel) : rel;
      if (subject === '.' || subject === '') continue;

      if (rule.regex.test(subject.split(path.sep).join('/'))) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
