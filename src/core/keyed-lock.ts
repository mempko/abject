/**
 * A queue per key: callers naming the same key run one at a time, callers
 * naming different keys do not wait for each other.
 *
 * This exists because concurrency arrived at the point where two agents can
 * work at once, and the things they work on — a file, an Abject's source —
 * are read-modify-write. Without ordering, two overlapping writers both read
 * the same starting state and the second one's write erases the first's. No
 * error, no corruption, just a change that quietly stopped existing.
 *
 * Scope: in-process and cooperative. It orders callers that go through it and
 * says nothing about another thread, another instance, or a shell command
 * touching the same thing. That is the right scope — the races worth
 * preventing here are the ones we create ourselves — but it does mean a lock
 * is not a substitute for the guarantee a real transaction would give.
 *
 * ## Why the key must be derived synchronously
 *
 * Callers that need to compute a key asynchronously (resolving a symlink,
 * asking another object for an id) must do it BEFORE calling in. Deriving it
 * inside would reintroduce the very race this prevents: two callers would both
 * await the derivation, both resume to find the same tail, and both chain onto
 * it, so both would run. Everything from reading the tail to writing the new
 * tail happens here in one uninterrupted turn of the event loop, which is what
 * makes the ordering sound.
 */

import { require as contractRequire } from './contracts.js';

/** Tail of the pending chain per key. Absent means nothing is in flight. */
const chains = new Map<string, Promise<void>>();

/**
 * Run `fn` with exclusive access to `key` among callers of this function.
 *
 * Reentrancy is NOT supported: calling with a key already held by the same
 * call stack deadlocks, exactly as a plain mutex would. Keep the critical
 * section to the read-modify-write itself.
 */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  contractRequire(typeof key === 'string' && key.length > 0, 'key must be a non-empty string');

  // Synchronous window: an await between reading the tail and writing the new
  // one would let a second caller chain onto the same tail and run alongside.
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  // A link never rejects — `release` is called from a finally — but chaining
  // through the rejection path too means one unexpected rejection cannot wedge
  // every later caller of this key.
  const chained = previous.then(() => mine, () => mine);
  chains.set(key, chained);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry once this link is the tail, so the map does not grow one
    // entry per key for the life of the process. A later caller that already
    // chained on has replaced the tail, and its own finally will clean up.
    if (chains.get(key) === chained) chains.delete(key);
  }
}

/** How many keys currently have a holder. Diagnostics only. */
export function heldLockCount(): number {
  return chains.size;
}

/** Whether a key is currently held or queued. Diagnostics only. */
export function isLockHeld(key: string): boolean {
  return chains.has(key);
}
