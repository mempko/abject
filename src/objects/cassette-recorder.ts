/**
 * CassetteRecorder - accumulates objects' HTTP traffic as replayable evidence.
 *
 * Receives HttpClient's `httpExchange` events and persists each exchange as
 * a cassette under the caller's durable typeId (`cassettes:<typeId>` in
 * Storage). A live AbjectId dies with its object; the typeId survives
 * restarts, so the evidence does too.
 *
 * The link is HttpClient's to make, not this object's: HttpClient discovers
 * the recorder through the registry and sends each exchange to that one id
 * (re-resolving on recipientGone), so exchanges are never broadcast to
 * whoever asks via addDependent - a generated object cannot subscribe to
 * other objects' traffic. Everything still crosses the bus as messages
 * (exchanges as events, persistence as Storage requests): HttpClient and
 * this recorder may be hosted on different worker threads, so no in-process
 * seam would work - see mempko/abject#11.
 *
 * Caller attribution comes from `resolveCallerIdentity`, which resolves the
 * exchange's caller id against the registry rather than trusting anything in
 * the payload. Exchanges whose caller has no durable typeId (unregistered or
 * anonymous callers) are not recorded: a cassette that cannot be tied to a
 * type is evidence about nothing.
 *
 * Failure independence: recording proceeds in memory while Storage is
 * missing, with persistence catching up - and merging what the store already
 * held - once Storage appears. A recorder restart is HttpClient's problem to
 * notice (recipientGone) and it does.
 *
 * This object only records. Judging the evidence is a separate concern (and a
 * separate PR in the #11 series).
 */

import { AbjectId, AbjectMessage, TypeId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import type { HttpExchangeEvent } from './capabilities/http-client.js';

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

/** Per-endpoint retention: a hot parameterized endpoint must not evict the
 *  one recording of a rarely-hit endpoint, so the per-bucket cap trims hot
 *  buckets, and global overflow always comes out of the LARGEST bucket. */
const PER_BUCKET_CAP = 5;
const PER_TYPE_CAP = 50;

export class CassetteRecorder extends Abject {
  private storageId?: AbjectId;
  private byType = new Map<TypeId, Cassette[]>();
  /** typeIds whose in-memory list has been merged with what Storage held. */
  private merged = new Set<TypeId>();
  private flushTimers = new Map<TypeId, ReturnType<typeof setTimeout>>();
  /** Single FIFO pump: exchanges append in arrival order regardless of how
   *  long identity resolution or the initial Storage load takes. */
  private pump: Promise<void> = Promise.resolve();
  private readonly flushMs: number;
  private storageRetryDelay: number;

  constructor(options: { flushMs?: number } = {}) {
    super({
      manifest: {
        name: 'CassetteRecorder',
        description:
          'Records objects\' HTTP traffic as cassettes in Storage, keyed by the caller\'s durable typeId. Receives HttpClient httpExchange events; evidence for judging generated objects accumulates here.',
        version: '1.0.0',
        interface: {
          id: CASSETTE_RECORDER_INTERFACE,
          name: 'CassetteRecorder',
          description: 'HTTP traffic recording',
          methods: [],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'recording', 'evidence'],
      },
    });
    this.flushMs = options.flushMs ?? 500;
    this.storageRetryDelay = this.flushMs;
  }

  protected override async onInit(): Promise<void> {
    this.on('httpExchange', (msg: AbjectMessage) => {
      const exchange = msg.payload as HttpExchangeEvent;
      this.pump = this.pump
        .then(() => this.record(exchange))
        .catch((err) => log.error('record failed', err));
      return true;
    });
  }

  private async record(exchange: HttpExchangeEvent): Promise<void> {
    const identity = await this.resolveCallerIdentity(exchange.caller);
    const typeId = identity?.typeId;
    if (!typeId || !isUserTypeId(typeId)) return;

    await this.mergeFromStore(typeId);
    const list = this.byType.get(typeId) ?? [];
    this.byType.set(typeId, list);
    list.push({
      method: '_http',
      request: exchange.request,
      response: exchange.response,
      durationMs: exchange.durationMs,
      at: exchange.at,
    });
    this.evict(list);
    this.scheduleFlush(typeId);
  }

  /** The first contact with Storage for a typeId merges what the store
   *  already holds ahead of this session's recordings - a recorder restart
   *  must never clobber accumulated evidence. While Storage is missing this
   *  stays pending and recording continues in memory; the merge happens at
   *  whichever comes first, the next record or the flush that finds Storage. */
  private async mergeFromStore(typeId: TypeId): Promise<void> {
    if (this.merged.has(typeId)) return;
    this.storageId ??= (await this.discoverDep('Storage')) ?? undefined;
    if (!this.storageId) return;
    this.storageRetryDelay = this.flushMs;
    let existing: Cassette[] = [];
    try {
      const raw = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: `cassettes:${typeId}` }), 5000);
      existing = Array.isArray(raw) ? (raw as Cassette[]) : [];
    } catch (err) {
      log.warn(`existing cassettes unreadable for ${typeId}`, err);
      return; // try again next time rather than risk clobbering
    }
    const current = this.byType.get(typeId) ?? [];
    const list = [...existing, ...current];
    this.evict(list);
    this.byType.set(typeId, list);
    this.merged.add(typeId);
  }

  /** Endpoint bucket: method + URL with the query stripped, so parameterized
   *  hits on one route churn their own bucket only. */
  private bucketKey(c: Cassette): string {
    let path = c.request.url;
    try {
      const u = new URL(c.request.url);
      path = u.origin + u.pathname;
    } catch {
      path = c.request.url.split('?')[0];
    }
    return `${c.request.method} ${path}`;
  }

  /** FIFO within each over-cap bucket first; then global overflow comes out
   *  of the LARGEST bucket's oldest entry, so a rare endpoint's only
   *  recording survives no matter how old it is. In place: the array
   *  instance is the store. */
  private evict(list: Cassette[]): void {
    const counts = new Map<string, number>();
    for (const c of list) {
      const key = this.bucketKey(c);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (let i = 0; i < list.length;) {
      const key = this.bucketKey(list[i]);
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
      const victim = list.findIndex(c => this.bucketKey(c) === maxKey);
      if (victim < 0) break; // counts out of sync - never loop forever
      counts.set(maxKey, maxN - 1);
      list.splice(victim, 1);
    }
  }

  private scheduleFlush(typeId: TypeId, delayMs?: number): void {
    const existing = this.flushTimers.get(typeId);
    if (existing) clearTimeout(existing);
    this.flushTimers.set(typeId, setTimeout(() => {
      this.flushTimers.delete(typeId);
      void this.flush(typeId);
    }, delayMs ?? this.flushMs));
  }

  private async flush(typeId: TypeId): Promise<void> {
    // Storage may have appeared since recording started; the merge guard
    // inside mergeFromStore keeps this idempotent.
    await this.mergeFromStore(typeId);
    const list = this.byType.get(typeId);
    if (!list) return;
    if (!this.storageId) {
      // Nowhere to persist yet: keep the data in memory and back off
      // polling discoverDep('Storage') instead of spinning every 500ms.
      this.scheduleFlush(typeId, this.storageRetryDelay);
      this.storageRetryDelay = Math.min(this.storageRetryDelay * 2, 5000);
      return;
    }
    if (!this.merged.has(typeId)) {
      // Still waiting to merge existing store data
      this.scheduleFlush(typeId, this.storageRetryDelay);
      return;
    }
    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: `cassettes:${typeId}`, value: list }), 5000);
    } catch (err) {
      log.warn(`cassette flush failed for ${typeId}`, err);
      this.scheduleFlush(typeId, this.flushMs);
    }
  }
}
