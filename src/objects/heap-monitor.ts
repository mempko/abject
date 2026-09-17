/**
 * HeapMonitor — watches the worker pool's heap usage.
 *
 * Each pool worker measures its own V8 isolate (only code inside an isolate
 * can read its heap) and reports a sample every 30s through its bridge; the
 * WorkerPool keeps the latest reading per slot and this abject holds the
 * policy: what counts as elevated, what counts as critical, and what gets
 * logged when a worker moves between those regimes.
 *
 * Main-thread only, and absent from workerEligible on purpose: it reads the
 * pool's heap reports, and an object watching for a worker to die cannot
 * live inside one.
 */

import { AbjectId, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
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

/** One worker's latest reading plus the regime the monitor assigned to it. */
export interface HeapWatch {
  workerIndex: number;
  sample: WorkerHeapSample;
  /** usedBytes / limitBytes, in [0, 1+]. Values above 1 should not happen. */
  fraction: number;
  regime: Regime;
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
  /** Latest reading per worker index, refreshed on each poll. */
  private watches: Map<number, HeapWatch> = new Map();
  private pollTimer?: ReturnType<typeof setInterval>;

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
              description: 'Read the pool now and return the latest sample per worker',
              parameters: [],
              returns: { kind: 'object', properties: {
                workers: { kind: 'array', elementType: { kind: 'object', properties: {} } },
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
    // Take a first reading right away so a worker is never unobserved for
    // its first poll interval, then keep polling. The unref keeps an idle
    // runtime able to exit.
    this.readSamples();
    this.pollTimer = setInterval(() => {
      try {
        this.readSamples();
      } catch (err) {
        log.warn(`Heap poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, POLL_MS);
    this.pollTimer.unref?.();
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
    if (this.pool === undefined) return [];

    const samples = this.pool.heapSamples();
    const stale = [...this.watches.keys()].filter((i) => !samples.has(i));
    for (const i of stale) this.watches.delete(i);

    const result: HeapWatch[] = [];
    for (const [index, sample] of samples) {
      require(sample.limitBytes > 0, `worker ${index} reported a zero heap limit`);
      const fraction = sample.usedBytes / sample.limitBytes;
      const regime = regimeFor(fraction);
      const previous = this.watches.get(index);
      this.watches.set(index, { workerIndex: index, sample, fraction, regime });

      // Log on regime change only: a worker sitting at 80% for an hour is
      // one log entry, not one every poll.
      if (previous === undefined || previous.regime !== regime) {
        const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`;
        if (regime === 'critical') {
          log.error(
            `worker ${index} heap CRITICAL: ${mb(sample.usedBytes)} / ${mb(sample.limitBytes)} ` +
            `(${(fraction * 100).toFixed(0)}%), ${sample.objectCount} objects`);
        } else if (regime === 'elevated') {
          log.warn(
            `worker ${index} heap elevated: ${mb(sample.usedBytes)} / ${mb(sample.limitBytes)} ` +
            `(${(fraction * 100).toFixed(0)}%), ${sample.objectCount} objects`);
        } else if (previous !== undefined) {
          log.info(
            `worker ${index} heap back to nominal: ${mb(sample.usedBytes)} / ${mb(sample.limitBytes)}`);
        }
      }
      result.push(this.watches.get(index)!);
    }

    this.checkInvariants();
    return result;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const watch of this.watches.values()) {
      require(watch.fraction >= 0, `worker ${watch.workerIndex} heap fraction is negative`);
      require(watch.sample.at > 0, `worker ${watch.workerIndex} sample has no timestamp`);
    }
  }
}
