/**
 * HeapMonitor — watches every isolate's heap usage.
 *
 * Each pool worker measures its own V8 isolate (only code inside an isolate
 * can read its heap) and reports a sample every 30s through its bridge; the
 * WorkerPool keeps the latest reading per slot and this abject holds the
 * policy: what counts as elevated, what counts as critical, and what gets
 * logged when an isolate moves between those regimes.
 *
 * The main thread is watched too, and it is not an afterthought: its ceiling
 * is roughly half a worker's (~4.2GB against ~8.4GB), so it has the least
 * headroom in the system despite hosting the least. Running here is what
 * makes reading it free.
 *
 * Main-thread only, and absent from workerEligible on purpose: it reads the
 * pool's heap reports, and an object watching for a worker to die cannot
 * live inside one.
 */

import { AbjectId, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import type { WorkerPool } from '../runtime/worker-pool.js';
import type { WorkerHeapSample } from '../runtime/worker-bridge.js';

const log = new Log('HeapMonitor');

export const HEAP_MONITOR_ID = 'abjects:heap-monitor' as AbjectId;

const HEAP_MONITOR_INTERFACE: InterfaceId = 'abjects:heap-monitor';

/** How often the monitor looks at the pool's latest readings. */
const POLL_MS = 15_000;

/** Fraction of the isolate's ceiling at which usage is logged as elevated. */
const ELEVATED_FRACTION = 0.75;

/** Fraction of the ceiling at which usage is logged as critical. */
const CRITICAL_FRACTION = 0.9;

type Regime = 'nominal' | 'elevated' | 'critical';

/** Watch key for the main thread; pool workers use `worker-<index>`. */
const MAIN_SOURCE = 'main';

/** One isolate's latest reading plus the regime the monitor assigned to it. */
export interface HeapWatch {
  /** 'main', or 'worker-<index>' for a pool worker. */
  source: string;
  /** Pool slot. Absent for the main thread, which has no slot. */
  workerIndex?: number;
  sample: WorkerHeapSample;
  /** usedBytes / limitBytes, in [0, 1+]. Values above 1 should not happen. */
  fraction: number;
  regime: Regime;
}

/** The slice of node:v8 this needs, so the import can stay dynamic. */
interface HeapStatsSource {
  getHeapStatistics(): { used_heap_size: number; total_heap_size: number; heap_size_limit: number };
}

export interface HeapMonitorOptions {
  /** The pool to watch. Optional because workers can be disabled. */
  pool?: WorkerPool;
}

function regimeFor(fraction: number): Regime {
  if (fraction >= CRITICAL_FRACTION) return 'critical';
  if (fraction >= ELEVATED_FRACTION) return 'elevated';
  return 'nominal';
}

export class HeapMonitor extends Abject {
  private pool?: WorkerPool;
  /** Latest reading per source ('main', 'worker-<n>'), refreshed on each poll. */
  private watches: Map<string, HeapWatch> = new Map();
  private pollTimer?: ReturnType<typeof setInterval>;
  /**
   * node:v8, when running on Node. Held rather than imported at the top
   * because this module is re-exported from the browser barrel, where a
   * static 'node:v8' import breaks the bundle.
   */
  private heapStats?: HeapStatsSource;

  constructor(options: HeapMonitorOptions = {}) {
    super({
      manifest: {
        name: 'HeapMonitor',
        description:
          'Watches worker heap usage. Workers sample their own V8 isolate and report through the pool; this object holds the thresholds and reports the readings.',
        version: '1.0.0',
        interface: {
          id: HEAP_MONITOR_INTERFACE,
          name: 'HeapMonitor',
          description: 'Worker heap usage monitor',
          methods: [
            {
              name: 'sampleNow',
              description: 'Read every isolate now and return the latest watch for the main thread and each pool worker',
              parameters: [],
              returns: { kind: 'object', properties: {
                watches: { kind: 'array', elementType: { kind: 'object', properties: {} } },
              }},
            },
            {
              name: 'getState',
              description: 'Return current watches and thresholds',
              parameters: [],
              returns: { kind: 'object', properties: {
                watches: { kind: 'array', elementType: { kind: 'object', properties: {} } },
                elevatedFraction: { kind: 'primitive', primitive: 'number' },
                criticalFraction: { kind: 'primitive', primitive: 'number' },
                poolAttached: { kind: 'primitive', primitive: 'boolean' },
              }},
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'monitoring'],
      },
    });

    this.pool = options.pool;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('sampleNow', async () => {
      const watches = this.readSamples();
      return { watches };
    });

    this.on('getState', async () => {
      this.checkInvariants();
      return {
        watches: [...this.watches.values()],
        elevatedFraction: ELEVATED_FRACTION,
        criticalFraction: CRITICAL_FRACTION,
        poolAttached: this.pool !== undefined,
      };
    });
  }

  protected override async onInit(): Promise<void> {
    try {
      this.heapStats = await import('node:v8') as HeapStatsSource;
    } catch {
      // Not on Node — the pool's worker reports still arrive.
    }
    // Take a first reading right away so nothing is unobserved for its first
    // poll interval, then keep polling. Guarded like the poll itself: a
    // monitor that cannot take a reading must still come up, or the one
    // object meant to explain a memory problem is the one that fails to
    // start because of it. The unref keeps an idle runtime able to exit.
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_MS);
    this.pollTimer.unref?.();
  }

  /** One sweep, with any failure contained to this tick. */
  private pollOnce(): void {
    try {
      this.readSamples();
    } catch (err) {
      log.warn(`Heap poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  protected override async onStop(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watches.clear();
  }

  /**
   * Read the pool's latest per-worker samples and update the watches.
   *
   * A slot that stops reporting (worker died and its replacement has not
   * sampled yet) drops out of the watches rather than lingering with a stale
   * reading — absence of data is reported as absence.
   */
  private readSamples(): HeapWatch[] {
    const readings: Array<{ source: string; workerIndex?: number; sample: WorkerHeapSample }> = [];

    const local = this.localSample();
    if (local) readings.push({ source: MAIN_SOURCE, sample: local });

    if (this.pool !== undefined) {
      for (const [index, sample] of this.pool.heapSamples()) {
        readings.push({ source: `worker-${index}`, workerIndex: index, sample });
      }
    }

    const reporting = new Set(readings.map((r) => r.source));
    for (const source of [...this.watches.keys()]) {
      if (!reporting.has(source)) this.watches.delete(source);
    }

    const result: HeapWatch[] = [];
    for (const { source, workerIndex, sample } of readings) {
      // A malformed reading is skipped, never thrown on. These numbers cross
      // a thread boundary, so they are input rather than our own state, and
      // a contract violation here would abandon the rest of the sweep and
      // leave every later isolate unread — a monitor that stops monitoring
      // precisely when something has gone wrong.
      if (!(sample.limitBytes > 0) || !(sample.usedBytes >= 0)) {
        log.warn(`${source} reported an unusable heap sample ` +
          `(used=${sample.usedBytes}, limit=${sample.limitBytes}); skipping it this poll`);
        this.watches.delete(source);
        continue;
      }

      const fraction = sample.usedBytes / sample.limitBytes;
      const regime = regimeFor(fraction);
      const previous = this.watches.get(source);
      const watch: HeapWatch = { source, workerIndex, sample, fraction, regime };
      this.watches.set(source, watch);

      // Log on regime change only: an isolate sitting at 80% for an hour is
      // one log entry, not one every poll.
      if (previous === undefined || previous.regime !== regime) {
        this.announce(watch, previous !== undefined);
      }
      result.push(watch);
    }

    this.checkInvariants();
    return result;
  }

  /**
   * The main thread's own reading. Absent off Node, and absent before init,
   * since the object count comes from the bus.
   */
  private localSample(): WorkerHeapSample | undefined {
    if (this.heapStats === undefined) return undefined;
    const stats = this.heapStats.getHeapStatistics();
    return {
      usedBytes: stats.used_heap_size,
      totalBytes: stats.total_heap_size,
      limitBytes: stats.heap_size_limit,
      objectCount: (this.bus as unknown as { objectCount?: number }).objectCount ?? 0,
      at: Date.now(),
    };
  }

  /** Say that an isolate changed regime, at the volume the new regime warrants. */
  private announce(watch: HeapWatch, hadPrevious: boolean): void {
    const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`;
    const usage = `${mb(watch.sample.usedBytes)} / ${mb(watch.sample.limitBytes)}`;
    const pct = `${(watch.fraction * 100).toFixed(0)}%`;
    if (watch.regime === 'critical') {
      log.error(`${watch.source} heap CRITICAL: ${usage} (${pct}), ${watch.sample.objectCount} objects. ` +
        `At the ceiling the thread is terminated and every object on it is lost.`);
    } else if (watch.regime === 'elevated') {
      log.warn(`${watch.source} heap elevated: ${usage} (${pct}), ${watch.sample.objectCount} objects`);
    } else if (hadPrevious) {
      log.info(`${watch.source} heap back to nominal: ${usage} (${pct})`);
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const watch of this.watches.values()) {
      invariant(watch.fraction >= 0, `${watch.source} heap fraction is negative`);
      invariant(watch.sample.at > 0, `${watch.source} sample has no timestamp`);
    }
  }
}
