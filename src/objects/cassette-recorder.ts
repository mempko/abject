/**
 * CassetteRecorder - accumulates objects' traffic as replayable evidence.
 *
 * Two kinds of recording, both keyed by the caller's durable typeId in
 * Storage. A live AbjectId dies with its object; the typeId survives
 * restarts, so the evidence does too.
 *
 *   `cassettes:<typeId>`   - HttpClient's `httpExchange` events: the HTTP
 *                            the object's requests turned into, at the
 *                            transport level.
 *   `invocations:<typeId>` - ScriptableAbject's `invocation` events: which
 *                            handler ran, with what, every outbound `call()`
 *                            it made and the reply, and what it returned.
 *                            This is what the FitnessJudge replays.
 *
 * The link is the emitter's to make, not this object's: HttpClient and each
 * ScriptableAbject discover the recorder through the registry and send to
 * that one id (re-resolving on recipientGone), so nothing is broadcast to
 * whoever asks via addDependent - a generated object cannot subscribe to
 * other objects' traffic. Everything still crosses the bus as messages
 * (recordings as events, persistence as Storage requests): emitters and
 * this recorder may be hosted on different worker threads, so no in-process
 * seam would work - see mempko/abject#11.
 *
 * Caller attribution comes from `resolveCallerIdentity`, which resolves an
 * id against the registry rather than trusting anything in the payload.
 * Recordings whose caller has no durable typeId, or whose outbound calls
 * name an object the registry cannot identify, are not kept: evidence that
 * cannot be tied to a type, or replayed against a name, is evidence about
 * nothing.
 *
 * Failure independence: recording proceeds in memory while Storage is
 * missing, with persistence catching up - and merging what the store already
 * held - once Storage appears. A recorder restart is the emitter's problem
 * to notice (recipientGone) and it does.
 *
 * This object only records. Judging the evidence is FitnessJudge's job.
 */

import { AbjectId, AbjectMessage, TypeId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { ensure, invariant, requirePositive } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import type { HttpExchangeEvent } from './capabilities/http-client.js';
import type { InvocationEvent } from './scriptable-abject.js';

const log = new Log('CASSETTE-RECORDER');

const CASSETTE_RECORDER_INTERFACE = 'abjects:cassette-recorder';
export const CASSETTE_RECORDER_ID = 'abjects:cassette-recorder' as AbjectId;

/**
 * User-created objects have a 4-segment TypeId: `{peer}/{workspace}/user/{Name}`.
 * System and built-in objects are `{peer}/system/{Name}` or `{peer}/{workspace}/{Name}` (3 segments).
 * Cassettes only record user objects to maintain workspace privacy boundaries and prevent
 * large system prompts and conversation history from flooding storage.
 */
export function isUserTypeId(typeId: TypeId): boolean {
  const segs = String(typeId).split('/');
  return segs.length === 4 && segs[2] === 'user';
}

/** What Storage holds under `cassettes:<typeId>`: one recorded exchange,
 *  request/response exactly as emitted (see HttpExchangeEvent - already
 *  redacted and capped at the emission boundary). `method: '_http'` marks
 *  raw transport-level evidence, as opposed to a manifest-method invocation. */
export interface Cassette {
  method: '_http';
  request: HttpExchangeEvent['request'];
  response: HttpExchangeEvent['response'];
  durationMs?: number;
  at: number;
}

/** What Storage holds under `invocations:<typeId>`: one handler invocation
 *  as emitted (see InvocationEvent), with each outbound call's live target
 *  id replaced by the registered NAME the registry gave for it - the shape
 *  `protocol/fitness.ts` replays. */
export interface InvocationCassette {
  method: string;
  argsText: string;
  calls: Array<{ target: string; method: string; payloadText: string; replyText?: string; errorText?: string }>;
  resultText?: string;
  errorText?: string;
  truncated?: boolean;
  durationMs?: number;
  at: number;
}

/** Per-bucket retention: a hot parameterized endpoint (or a chatty handler)
 *  must not evict the one recording of a rarely-hit one, so the per-bucket
 *  cap trims hot buckets, and global overflow always comes out of the
 *  LARGEST bucket. */
const PER_BUCKET_CAP = 5;
const PER_TYPE_CAP = 50;

/** One Storage row's worth of recordings, with its persistence state. */
interface Tracked<T> {
  key: string;
  list: T[];
  bucketKey: (item: T) => string;
  /** Whether the in-memory list has been merged with what Storage held. */
  merged: boolean;
  merging?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** When the oldest unwritten recording arrived. Bounds how long steady traffic can hold a flush back. */
  unflushedSince?: number;
}

export class CassetteRecorder extends Abject {
  private storageId?: AbjectId;
  private rows = new Map<string, Tracked<unknown>>();
  /** Single FIFO pump: recordings append in arrival order regardless of how
   *  long identity resolution or the initial Storage load takes. */
  private pump: Promise<void> = Promise.resolve();
  /** A flush waits for this much quiet after the latest recording... */
  private readonly flushMs: number;
  /** ...but never longer than this after the oldest unwritten one, so an
   *  object polling faster than flushMs is still persisted, and a busy one
   *  rewrites its row at most once per interval. */
  private readonly flushMaxWaitMs: number;
  private storageRetryDelay: number;

  constructor(options: { flushMs?: number } = {}) {
    super({
      manifest: {
        name: 'CassetteRecorder',
        description:
          'Records objects\' traffic as evidence in Storage, keyed by the caller\'s durable typeId: HttpClient httpExchange events as cassettes, ScriptableAbject invocation events as replayable invocations. Evidence for judging generated objects accumulates here.',
        version: '1.1.0',
        interface: {
          id: CASSETTE_RECORDER_INTERFACE,
          name: 'CassetteRecorder',
          description: 'Traffic recording',
          methods: [],
        },
        tags: ['system', 'recording', 'evidence'],
      },
    });
    this.flushMs = options.flushMs ?? 500;
    requirePositive(this.flushMs, 'flushMs');
    this.flushMaxWaitMs = this.flushMs * 10;
    this.storageRetryDelay = this.flushMs;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const row of this.rows.values()) {
      invariant(row.list.length <= PER_TYPE_CAP, `recordings under ${row.key} must stay within the per-type cap`);
      invariant(!row.flushTimer || row.list.length > 0, `a flush is only scheduled for a row with recordings (${row.key})`);
    }
  }

  protected override async onInit(): Promise<void> {
    this.on('httpExchange', (msg: AbjectMessage) => {
      const exchange = msg.payload as HttpExchangeEvent;
      this.enqueue(() => this.recordExchange(exchange));
      return true;
    });
    // The sender IS the invoked object, so its identity is the message's
    // origin - the payload's `caller` is informational.
    this.on('invocation', (msg: AbjectMessage) => {
      const ev = msg.payload as InvocationEvent;
      this.enqueue(() => this.recordInvocation(msg.routing.from, ev));
      return true;
    });
  }

  protected override async onStop(): Promise<void> {
    for (const row of this.rows.values()) {
      this.cancelTimer(row.flushTimer);
      row.flushTimer = undefined;
    }
  }

  private enqueue(job: () => Promise<void>): void {
    this.pump = this.pump.then(job).catch((err) => log.error('record failed', err));
  }

  private async userTypeIdOf(objectId: AbjectId): Promise<TypeId | undefined> {
    const identity = await this.resolveCallerIdentity(objectId);
    const typeId = identity?.typeId;
    return typeId && isUserTypeId(typeId) ? typeId : undefined;
  }

  private async recordExchange(exchange: HttpExchangeEvent): Promise<void> {
    const typeId = await this.userTypeIdOf(exchange.caller);
    if (!typeId) return;
    await this.append<Cassette>(`cassettes:${typeId}`, httpBucketKey, {
      method: '_http',
      request: exchange.request,
      response: exchange.response,
      durationMs: exchange.durationMs,
      at: exchange.at,
    });
  }

  private async recordInvocation(from: AbjectId, ev: InvocationEvent): Promise<void> {
    const typeId = await this.userTypeIdOf(from);
    if (!typeId) return;
    // Each outbound target becomes the name the registry knows it by. Replay
    // keys on that name; a target nobody can identify makes the recording
    // unreplayable, so it is dropped rather than kept as a half-truth.
    const calls: InvocationCassette['calls'] = [];
    for (const c of ev.calls ?? []) {
      const target = (await this.resolveCallerIdentity(c.targetId))?.name;
      if (!target) {
        log.info(`invocation of ${typeId}.${ev.method} dropped: outbound target ${c.targetId} is not registered`);
        return;
      }
      calls.push({ target, method: c.method, payloadText: c.payloadText,
        ...(c.replyText !== undefined ? { replyText: c.replyText } : {}),
        ...(c.errorText !== undefined ? { errorText: c.errorText } : {}) });
    }
    await this.append<InvocationCassette>(`invocations:${typeId}`, invocationBucketKey, {
      method: ev.method,
      argsText: ev.argsText,
      calls,
      ...(ev.resultText !== undefined ? { resultText: ev.resultText } : {}),
      ...(ev.errorText !== undefined ? { errorText: ev.errorText } : {}),
      ...(ev.truncated ? { truncated: true } : {}),
      durationMs: ev.durationMs,
      at: ev.at,
    });
  }

  private row<T>(key: string, bucketKey: (item: T) => string): Tracked<T> {
    let row = this.rows.get(key) as Tracked<T> | undefined;
    if (!row) {
      row = { key, list: [], bucketKey, merged: false };
      this.rows.set(key, row as Tracked<unknown>);
    }
    return row;
  }

  private async append<T>(key: string, bucketKey: (item: T) => string, item: T): Promise<void> {
    const row = this.row<T>(key, bucketKey);
    await this.mergeFromStore(row);
    row.list.push(item);
    evict(row.list, row.bucketKey);
    this.scheduleFlush(row);
    this.checkInvariants();
  }

  /** The first contact with Storage for a row merges what the store already
   *  holds ahead of this session's recordings - a recorder restart must never
   *  clobber accumulated evidence. While Storage is missing this stays
   *  pending and recording continues in memory; the merge happens at
   *  whichever comes first, the next record or the flush that finds Storage. */
  private async mergeFromStore<T>(row: Tracked<T>): Promise<void> {
    if (row.merged) return;
    if (row.merging) return row.merging;
    this.storageId ??= (await this.discoverDep('Storage')) ?? undefined;
    if (!this.storageId) return;
    const storageId = this.storageId;
    this.storageRetryDelay = this.flushMs;
    row.merging = (async () => {
      let existing: T[] = [];
      try {
        const raw = await this.request<unknown>(
          request(this.id, storageId, 'get', { key: row.key }), 5000);
        existing = Array.isArray(raw) ? (raw as T[]) : [];
      } catch (err) {
        log.warn(`existing recordings unreadable for ${row.key}`, err);
        return; // try again next time rather than risk clobbering
      } finally {
        row.merging = undefined;
      }
      if (!row.merged) {
        row.list = [...existing, ...row.list];
        evict(row.list, row.bucketKey);
        row.merged = true;
        this.checkInvariants();
      }
    })();
    return row.merging;
  }

  /** New recordings debounce the flush, up to flushMaxWaitMs after the oldest
   *  unwritten one. Until the store has been merged (Storage unknown, or its
   *  read failed) a backoff retry is already pending, and new recordings
   *  leave its delay alone rather than cut the backoff short. */
  private scheduleFlush<T>(row: Tracked<T>): void {
    const now = Date.now();
    row.unflushedSince ??= now;
    if (!row.merged && row.flushTimer) return;
    const deadline = row.unflushedSince + this.flushMaxWaitMs;
    this.armFlush(row, Math.max(0, Math.min(this.flushMs, deadline - now)));
  }

  private armFlush<T>(row: Tracked<T>, delayMs: number): void {
    this.cancelTimer(row.flushTimer);
    row.flushTimer = undefined;
    // A flush that fails with "Object stopped" after stop() must not re-arm.
    if (this._status === 'stopped') return;
    row.flushTimer = this.setTimer(() => {
      row.flushTimer = undefined;
      void this.flush(row);
    }, delayMs);
  }

  private async flush<T>(row: Tracked<T>): Promise<void> {
    // Storage may have appeared since recording started; the merge guard
    // inside mergeFromStore keeps this idempotent.
    await this.mergeFromStore(row);
    if (!this.storageId) {
      // Nowhere to persist yet: keep the data in memory and back off
      // polling discoverDep('Storage') instead of spinning every 500ms.
      this.armFlush(row, this.storageRetryDelay);
      this.storageRetryDelay = Math.min(this.storageRetryDelay * 2, 5000);
      return;
    }
    if (!row.merged) {
      // Still waiting to merge existing store data
      this.armFlush(row, this.storageRetryDelay);
      return;
    }
    // Everything recorded so far rides this write; later recordings start a
    // fresh max-wait window.
    row.unflushedSince = undefined;
    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: row.key, value: row.list }), 5000);
    } catch (err) {
      log.warn(`flush failed for ${row.key}`, err);
      this.armFlush(row, this.flushMs);
    }
  }
}

/** Endpoint bucket: method + URL with the query stripped, so parameterized
 *  hits on one route churn their own bucket only. */
function httpBucketKey(c: Cassette): string {
  let path = c.request.url;
  try {
    const u = new URL(c.request.url);
    path = u.origin + u.pathname;
  } catch {
    path = c.request.url.split('?')[0];
  }
  return `${c.request.method} ${path}`;
}

/** Handler bucket: one per method, so a chatty handler cannot evict the
 *  only recording of a quiet one. */
function invocationBucketKey(c: InvocationCassette): string {
  return c.method;
}

/** FIFO within each over-cap bucket first; then global overflow comes out
 *  of the LARGEST bucket's oldest entry, so a rare bucket's only recording
 *  survives no matter how old it is. In place: the array instance is the row. */
function evict<T>(list: T[], bucketKey: (item: T) => string): void {
  const counts = new Map<string, number>();
  for (const c of list) {
    const key = bucketKey(c);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (let i = 0; i < list.length;) {
    const key = bucketKey(list[i]);
    const n = counts.get(key)!;
    if (n > PER_BUCKET_CAP) {
      counts.set(key, n - 1);
      list.splice(i, 1);
    } else {
      i++;
    }
  }
  while (list.length > PER_TYPE_CAP) {
    let maxKey = '';
    let maxN = 0;
    for (const [key, n] of counts) {
      if (n > maxN) { maxN = n; maxKey = key; }
    }
    const victim = list.findIndex(c => bucketKey(c) === maxKey);
    ensure(victim >= 0, 'the largest bucket must have an entry in the list');
    counts.set(maxKey, maxN - 1);
    list.splice(victim, 1);
  }
  ensure(list.length <= PER_TYPE_CAP, 'eviction must bring the list within the per-type cap');
}
