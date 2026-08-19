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
 * ## Why the key is resolved synchronously
 *
 * Two paths can name one file — a symlink, or the `node_modules` link a
 * worktree borrows from its main checkout. They have to share a queue, which
 * means resolving the real path before choosing one.
 *
 * The catch is that resolving it asynchronously reintroduces the very race
 * this module exists to prevent: two callers would both await the lookup, both
 * resume to find the same tail, and both chain onto it, so both would run.
 * Guarding that needs a second queue in front of the first, purely to make the
 * lookup atomic. Resolving synchronously instead means the read of the tail
 * and the write of the new tail happen in one uninterrupted turn of the event
 * loop, and no such race can exist. The cost is one stat-level syscall per
 * mutation, which is nothing next to the write it is about to guard.
 */

import * as fsSync from 'fs';
import * as path from 'path';
import { require as contractRequire } from './contracts.js';

/** Tail of the pending chain per file. Absent means nothing is in flight. */
const queues = new Map<string, Promise<void>>();

/**
 * The identity of a file for queuing purposes: its real path when it exists,
 * and its resolved path when it does not (a file about to be created has no
 * real path yet, and two callers creating it race on the same resolved name).
 */
function keyFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fsSync.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Run `fn` with exclusive access to `filePath` among callers of this function.
 *
 * This is cooperative: it orders callers that go through it, and says nothing
 * about anything else on the machine touching the same file. That is the right
 * scope — the races worth preventing here are the ones we create ourselves.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  contractRequire(typeof filePath === 'string' && filePath.length > 0, 'filePath must be a non-empty string');

  // Everything from here to `queues.set` is synchronous on purpose: an await
  // in this window would let a second caller read the same tail and chain onto
  // it in parallel, which is exactly the race being prevented.
  const key = keyFor(filePath);
  const previous = queues.get(key) ?? Promise.resolve();

  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  // A link never rejects — `release` is called from a finally — but chaining
  // through the rejection path too means one unexpected rejection cannot wedge
  // every later mutation to this file.
  const chained = previous.then(() => mine, () => mine);
  queues.set(key, chained);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry once this link is the tail, so the map does not grow one
    // entry per file for the life of the process. A later caller that already
    // chained on has replaced the tail, and its own finally will clean up.
    if (queues.get(key) === chained) queues.delete(key);
  }
}

/** How many files currently have a mutation in flight. Diagnostics only. */
export function pendingMutationCount(): number {
  return queues.size;
}
