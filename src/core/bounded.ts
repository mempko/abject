/**
 * Run `fn(0..count-1)` with at most `limit` calls in flight. For boot-time
 * restores that would otherwise await one round trip per item, while keeping
 * a large store from being read all at once.
 */

import { require } from './contracts.js';

export async function runBounded(count: number, limit: number, fn: (index: number) => Promise<void>): Promise<void> {
  require(Number.isInteger(count) && count >= 0, 'runBounded: count must be a non-negative integer');
  require(Number.isInteger(limit) && limit > 0, 'runBounded: limit must be a positive integer');
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) await fn(next++);
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}
