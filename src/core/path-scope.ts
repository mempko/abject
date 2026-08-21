/**
 * Whether one path is inside another, decided on path boundaries.
 *
 * The obvious version of this test is `candidate.startsWith(root)`, and it is
 * wrong in a way that only shows up when it matters: granting
 * `/home/me/project` also grants `/home/me/project-secrets`, because the second
 * string does start with the first. A single separator check closes it.
 *
 * Everything here is pure string and path arithmetic. Nothing touches the disk,
 * so a path that does not exist is answered on its spelling alone, which is
 * what a permission gate wants: the decision must not depend on whether the
 * attacker has created the file yet.
 */

import * as path from 'path';
import * as os from 'os';

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(p: string): string {
  if (p === '~') return path.resolve(os.homedir());
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.resolve(path.join(os.homedir(), p.slice(2)));
  }
  return path.resolve(p);
}

/**
 * Whether `candidate` is `root` itself or lives beneath it.
 *
 * Both sides are expanded and resolved first, so `..` segments are collapsed
 * before the comparison rather than being compared as text.
 */
export function isInside(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const r = expandHome(root);
  const c = expandHome(candidate);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Whether `candidate` is inside any of `roots`. */
export function isInsideAny(roots: readonly string[] | undefined, candidate: string): boolean {
  if (!roots || roots.length === 0) return false;
  return roots.some(r => isInside(r, candidate));
}

/**
 * The deepest root containing `candidate`, or undefined.
 *
 * Deepest wins so a project nested inside another resolves to the inner one,
 * which is the same rule ExternalProjectRegistry uses to pick a project.
 */
export function deepestContaining(
  roots: readonly string[] | undefined,
  candidate: string,
): string | undefined {
  if (!roots) return undefined;
  let best: string | undefined;
  for (const r of roots) {
    if (isInside(r, candidate) && (!best || expandHome(r).length > expandHome(best).length)) {
      best = r;
    }
  }
  return best;
}
