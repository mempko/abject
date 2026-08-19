/**
 * Serialize mutations that target the same file.
 *
 * Writing a file is atomic here (temp file, then rename), which rules out a
 * reader ever seeing a half-written file. It does not rule out the other
 * failure: `edit` is a read-modify-write, so two edits to one file that
 * overlap in time both read the original, both apply their change to it, and
 * the second rename silently discards the first. No error, no torn file, just
 * a change that quietly stopped existing — the worst shape a bug can take.
 *
 * So mutations queue per file and run one at a time, while mutations to
 * different files stay concurrent. Reads deliberately do not queue: rename is
 * atomic, so a read alongside a write sees either the whole old file or the
 * whole new one, and making readers wait would buy nothing.
 *
 * The ordering itself lives in `keyed-lock.ts`; what belongs here is deciding
 * which files count as the same file.
 *
 * ## Why the key is the real path, resolved synchronously
 *
 * Two paths can name one file — a symlink, or the `node_modules` link a
 * worktree borrows from its main checkout. They have to share a queue, which
 * means resolving the real path before choosing a key.
 *
 * Resolving it asynchronously would reintroduce the race the lock exists to
 * prevent (see keyed-lock.ts), so it is resolved synchronously here, before
 * the lock is taken. The cost is one stat-level syscall per mutation, which is
 * nothing next to the write it is about to guard.
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { require as contractRequire } from './contracts.js';
import { withKeyedLock, heldLockCount } from './keyed-lock.js';

/**
 * The identity of a file for queuing purposes: its real path when it exists,
 * and its resolved path when it does not (a file about to be created has no
 * real path yet, and two callers creating it race on the same resolved name).
 */
function keyFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return `file:${fsSync.realpathSync(resolved)}`;
  } catch {
    return `file:${resolved}`;
  }
}

/**
 * Run `fn` with exclusive access to `filePath` among callers of this function.
 *
 * Cooperative: it orders callers that go through it, and says nothing about
 * anything else on the machine touching the same file — a `bash` action
 * running `sed -i`, or a second Abjects instance, is outside its reach.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  contractRequire(typeof filePath === 'string' && filePath.length > 0, 'filePath must be a non-empty string');
  return withKeyedLock(keyFor(filePath), fn);
}

/** How many keys currently have a holder, files included. Diagnostics only. */
export function pendingMutationCount(): number {
  return heldLockCount();
}
