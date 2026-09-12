import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { withKeyedLock } from '../core/keyed-lock.js';
import { Log } from '../core/timed-log.js';

const log = new Log('TaskSession');

export interface SessionRecord {
  id: string; agentName: string; agentId?: AbjectId; goalId?: string; parentId?: string;
  intent: string; revision: number; attempt: number;
  status: 'running' | 'paused' | 'partial' | 'accepted' | 'cancelled';
  snapshot?: unknown; outstandingOperation?: unknown;
  outcome?: unknown; updatedAt: number;
  outbox: Array<{ id: string; destination: string; destinationName?: string; payload: unknown; delivered: boolean }>;
  usage: { tokens: number; cost: number; elapsedMs: number; unpricedCalls?:number; unreportedCalls?:number };
}

/**
 * Marker for a field that held a copy of `outcome.result`. A finished task's
 * result used to be written into the record four times over (the snapshot's
 * state, the outcome, the delivery payload, and the delivery's evidence); a
 * ten-megabyte review result made a forty-megabyte record, and a workspace
 * that kept a few hundred of those in memory ran its worker out of heap.
 * Stored and held once, expanded on the way out.
 */
const SAME_AS_RESULT = '$sameAsOutcomeResult';
/** Below this size a duplicate is not worth the indirection. */
const DEDUPE_MIN_CHARS = 1024;
/** A settled session: nothing more will happen to it, and nothing waits on it. */
const TERMINAL = new Set<SessionRecord['status']>(['accepted', 'cancelled']);
/** Settled sessions older than this leave the store. */
const RETENTION_MS = 48 * 60 * 60 * 1000;
/** And no more than this many settled sessions stay, newest first. */
const MAX_SETTLED_SESSIONS = 150;

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The record as stored and held: duplicates of the result replaced by the marker. */
function compact(rec: SessionRecord): SessionRecord {
  const outcome = isRecordObject(rec.outcome) ? rec.outcome : undefined;
  if (!outcome || outcome.result === undefined) return rec;
  const canonical = JSON.stringify(outcome.result);
  if (canonical.length < DEDUPE_MIN_CHARS) return rec;
  const same = (v: unknown) => v !== undefined && JSON.stringify(v) === canonical;
  const marker = { [SAME_AS_RESULT]: true };
  const next: SessionRecord = { ...rec, outbox: rec.outbox.map(o => {
    if (!isRecordObject(o.payload)) return o;
    const payload = { ...o.payload };
    for (const field of ['result', 'evidence']) if (same(payload[field])) payload[field] = marker;
    return { ...o, payload };
  }) };
  if (isRecordObject(rec.snapshot) && isRecordObject(rec.snapshot.state) && same(rec.snapshot.state.result)) {
    next.snapshot = { ...rec.snapshot, state: { ...rec.snapshot.state, result: marker } };
  }
  return next;
}

/** The record as callers see it: every marker replaced by a copy of the result. */
function expand(rec: SessionRecord): SessionRecord {
  const outcome = isRecordObject(rec.outcome) ? rec.outcome : undefined;
  const isMarker = (v: unknown) => isRecordObject(v) && v[SAME_AS_RESULT] === true;
  const copy = () => structuredClone(outcome?.result);
  const next: SessionRecord = { ...rec, outbox: rec.outbox.map(o => {
    if (!isRecordObject(o.payload)) return o;
    const payload = { ...o.payload };
    for (const field of ['result', 'evidence']) if (isMarker(payload[field])) payload[field] = copy();
    return { ...o, payload };
  }) };
  if (isRecordObject(rec.snapshot) && isRecordObject(rec.snapshot.state) && isMarker(rec.snapshot.state.result)) {
    next.snapshot = { ...rec.snapshot, state: { ...rec.snapshot.state, result: copy() } };
  }
  return next;
}

function settled(rec: SessionRecord): boolean {
  return TERMINAL.has(rec.status) && rec.outbox.every(o => o.delivered);
}

/**
 * What stays in memory for a settled session: everything a listing or a
 * continuation reads, minus the snapshot (the bulk of the record) and the
 * bodies of deliveries already made. The full record is one Storage read
 * away when someone asks for it by id.
 */
function trim(rec: SessionRecord): SessionRecord {
  const { snapshot: _snapshot, ...rest } = rec;
  return { ...rest, outbox: rec.outbox.map(o => o.delivered ? { ...o, payload: { stored: true } } : o) };
}

/** Workspace-owned durable task records. All mutation and recovery is through messages. */
export class TaskSession extends Abject {
  private storageId?: AbjectId;
  private sessions = new Map<string, SessionRecord>();
  /** Ids whose in-memory record is trimmed; the full record lives in Storage. */
  private trimmed = new Set<string>();
  private retentionTimer?: ReturnType<typeof setTimeout>;
  constructor() {
    super({ manifest: { name: 'TaskSession', version: '1.1.0', description: 'Durable task conversations, hypotheses, operation state, outcomes and result delivery. Ask how to inspect, resume or fork a session.', interface: {
      id: 'abjects:task-session', name: 'TaskSession', description: 'Task continuity', methods: [
        { name: 'get', description: 'Get a session by id, including revision and unresolved operation', parameters: [{ name: 'id', description: 'Session id', type: { kind: 'primitive', primitive: 'string' } }], returns: { kind: 'object', properties: {} } },
        { name: 'list', description: 'List sessions and their progress', parameters: [], returns: { kind: 'array', elementType: { kind: 'object', properties: {} } } },
        { name: 'checkpoint', description: 'Runtime checkpoint: id, expectedRevision, agentName, intent, snapshot, outstandingOperation, status. Revision conflict changes nothing.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'resume', description: 'Prepare a new attempt by id and expectedRevision. Unknown operation effects must be reconciled first. AgentAbject.resumeTask performs execution.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'fork', description: 'Fork dialogue and evidence using id and newId. Does not undo external changes or inherit accepted completion.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'reconcile', description: 'Record an evidence-backed outcome for an outstanding operation before resuming: id, expectedRevision, evidence, outcome.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'retainPayload', description: 'AgentAbject-only: retain a received payload body by sessionId and payload.id before removing it from active memory.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'readPayload', description: 'AgentAbject-only: retrieve retained evidence by sessionId and id. Agents use runtime read_chunk or readPayload messages.', parameters: [], returns: { kind: 'object', properties: {} } },
      ] }, requiredCapabilities: [], providedCapabilities: [], tags: ['system', 'agent', 'sessions'] } });
    this.on('get', async msg => {
      const rec = await this.full((msg.payload as { id: string }).id);
      return rec ? expand(rec) : null;
    });
    // Bulk evidence lives with the session owner, not in a specialist's context.
    this.on('retainPayload', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const { sessionId, payload } = msg.payload as { sessionId: string; payload: { id: string; text: string; kind: string; storedAt: number } };
      if (!sessionId || !payload?.id || typeof payload.text !== 'string') throw new Error('Session and payload required');
      if (!this.storageId) throw new Error('Storage unavailable');
      await this.request(request(this.id, this.storageId, 'set', { key: this.payloadKey(sessionId, payload.id), value: structuredClone(payload) }));
      return { success: true };
    });
    this.on('readPayload', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const { sessionId, id } = msg.payload as { sessionId: string; id: string };
      if (!sessionId || !id || !this.storageId) throw new Error('Payload storage unavailable');
      return structuredClone(await this.request(request(this.id, this.storageId, 'get', { key: this.payloadKey(sessionId, id) })));
    });
    this.on('list', () => [...this.sessions.values()].map(r => { const { snapshot: _snapshot, ...rest } = expand(r); return structuredClone(rest); }));
    this.on('checkpoint', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const p = msg.payload as Partial<SessionRecord> & { id: string; expectedRevision?: number };
      return this.mutate(p.id, p.expectedRevision, old => {
        if (!old && (!p.agentName || !p.intent)) throw new Error('New sessions require agentName and intent');
        return { id: p.id, agentName: p.agentName ?? old!.agentName, agentId: p.agentId ?? old?.agentId, intent: p.intent ?? old!.intent,
          goalId: p.goalId ?? old?.goalId, parentId: p.parentId ?? old?.parentId,
          revision: (old?.revision ?? 0) + 1, attempt: old?.attempt ?? 1,
          status: p.status ?? old?.status ?? 'running', snapshot: p.snapshot ?? old?.snapshot,
          outstandingOperation: p.outstandingOperation, outcome: p.outcome ?? old?.outcome,
          outbox: p.outbox ?? old?.outbox ?? [], usage: p.usage ?? old?.usage ?? { tokens: 0, cost: 0, elapsedMs: 0 }, updatedAt: Date.now() };
      });
    });
    this.on('pendingDeliveries', async msg => {
      await this.runtimeOnly(msg.routing.from);
      // A session with an undelivered item is never trimmed, so the payloads are here.
      return [...this.sessions.values()].filter(s => !this.trimmed.has(s.id)).flatMap(s =>
        expand(s).outbox.filter(o => !o.delivered).map(o => ({ sessionId: s.id, ...structuredClone(o) })));
    });
    this.on('ackDelivery', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const p = msg.payload as { sessionId: string; deliveryId: string };
      return this.mutate(p.sessionId, undefined, old => {
        if (!old) throw new Error('Unknown session');
        const delivery = old.outbox.find(o => o.id === p.deliveryId);
        if (!delivery) throw new Error('Unknown delivery');
        delivery.delivered = true;
        return { ...old, revision: old.revision + 1, updatedAt: Date.now() };
      });
    });
    this.on('resume', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const p = msg.payload as { id: string; expectedRevision: number };
      return this.mutate(p.id, p.expectedRevision, old => {
        if (!old) throw new Error('Unknown session');
        if (old.status === 'accepted') throw new Error('Accepted sessions may be forked, not resumed');
        if (old.status === 'running') throw new Error('Session already running');
        if (old.outstandingOperation) throw new Error('Operation outcome unknown; inspect its receiver and reconcile before resuming');
        return { ...old, attempt: old.attempt + 1, revision: old.revision + 1, status: 'running', updatedAt: Date.now() };
      });
    });
    this.on('fork', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const { id, newId } = msg.payload as { id: string; newId: string };
      const old = await this.full(id);
      if (!old || !newId || this.sessions.has(newId)) throw new Error('Unknown source or duplicate fork id');
      const source = expand(old);
      return this.mutate(newId, 0, () => ({ ...structuredClone(source), id: newId, parentId: id, revision: 1, attempt: 1, status: 'paused', outcome: undefined, outbox: [], updatedAt: Date.now() }));
    });
    this.on('reconcile', async msg => {
      await this.runtimeOnly(msg.routing.from);
      const p = msg.payload as { id: string; expectedRevision: number; evidence: string; outcome: unknown };
      if (!p.evidence?.trim()) throw new Error('Reconciliation requires receiver evidence');
      return this.mutate(p.id, p.expectedRevision, old => {
        if (!old || !old.outstandingOperation) throw new Error('No outstanding operation');
        return { ...old, status: 'paused', outstandingOperation: undefined, outcome: { evidence: p.evidence, result: p.outcome }, revision: old.revision + 1, updatedAt: Date.now() };
      });
    });
  }
  private payloadKey(sessionId: string, id: string): string {
    return `agent:payload:${encodeURIComponent(sessionId)}:${encodeURIComponent(id)}`;
  }
  private async runtimeOnly(sender: AbjectId): Promise<void> {
    if (sender !== await this.discoverDep('AgentAbject')) throw new Error('Session mutation belongs to AgentAbject');
  }
  /** The stored (compact) record, read back from Storage when only a trimmed copy is held. */
  private async full(id: string): Promise<SessionRecord | undefined> {
    const held = this.sessions.get(id);
    if (!held) return undefined;
    if (!this.trimmed.has(id) || !this.storageId) return held;
    const stored = await this.request<SessionRecord | null>(request(this.id, this.storageId, 'get', { key: `agent:session:${id}` }));
    return stored ?? held;
  }
  /** Keep a record in memory in the form its state warrants. */
  private hold(rec: SessionRecord): void {
    if (settled(rec)) { this.sessions.set(rec.id, trim(rec)); this.trimmed.add(rec.id); }
    else { this.sessions.set(rec.id, rec); this.trimmed.delete(rec.id); }
  }
  private async mutate(id: string, expected: number | undefined, change: (old?: SessionRecord) => SessionRecord): Promise<{ success: boolean; session?: SessionRecord; conflict?: boolean; revision?: number }> {
    if (!id) throw new Error('Session id required');
    return withKeyedLock(`${this.id}:sessions`, async () => {
      const held = this.sessions.get(id);
      if (expected !== undefined && expected !== (held?.revision ?? 0)) return { success: false, conflict: true, revision: held?.revision ?? 0 };
      const old = held ? expand((await this.full(id)) ?? held) : undefined;
      const next = change(old && structuredClone(old));
      if (!this.storageId) throw new Error('Storage unavailable; cannot acknowledge a durable session checkpoint');
      const stored = compact(next);
      // Index first: a crash can leave a missing record, but never an undiscoverable acknowledged record.
      if (!held) await this.request(request(this.id, this.storageId, 'set', { key: 'agent:session-index', value: [...this.sessions.keys(), id] }));
      await this.request(request(this.id, this.storageId, 'set', { key: `agent:session:${id}`, value: stored }));
      this.hold(stored);
      if (settled(stored)) this.scheduleRetention();
      this.changed('sessionUpdated', { id, status: next.status, revision: next.revision });
      return { success: true, session: structuredClone(next) };
    });
  }
  private scheduleRetention(): void {
    if (this.retentionTimer) return;
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = undefined;
      void this.enforceRetention().catch(err => log.warn(`retention sweep failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 5_000);
  }
  /**
   * Settled sessions are history, and history is bounded: older than the
   * retention window, or past the cap newest-first, they leave the store
   * along with the payloads retained for them.
   */
  private async enforceRetention(): Promise<void> {
    if (!this.storageId) return;
    const now = Date.now();
    const settledIds = [...this.sessions.values()].filter(settled).sort((a, b) => b.updatedAt - a.updatedAt);
    const evict = settledIds.filter((s, i) => i >= MAX_SETTLED_SESSIONS || now - s.updatedAt > RETENTION_MS);
    if (evict.length === 0) return;
    let payloadKeys: string[] = [];
    try { payloadKeys = (await this.request<string[]>(request(this.id, this.storageId, 'keys', {}))) ?? []; } catch { /* payload sweep is best effort */ }
    for (const s of evict) {
      await withKeyedLock(`${this.id}:sessions`, async () => {
        this.sessions.delete(s.id); this.trimmed.delete(s.id);
        await this.request(request(this.id, this.storageId!, 'delete', { key: `agent:session:${s.id}` }));
        const prefix = `agent:payload:${encodeURIComponent(s.id)}:`;
        for (const key of payloadKeys) if (key.startsWith(prefix)) {
          try { await this.request(request(this.id, this.storageId!, 'delete', { key })); } catch { /* best effort */ }
        }
      });
    }
    await this.request(request(this.id, this.storageId, 'set', { key: 'agent:session-index', value: [...this.sessions.keys()] }));
    log.info(`retention: removed ${evict.length} settled session(s); ${this.sessions.size} remain`);
  }
  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    if (!this.storageId) return;
    const index = await this.request<string[] | null>(request(this.id, this.storageId, 'get', { key: 'agent:session-index' }));
    const stored = index ? (await Promise.all(index.map(id => this.request<SessionRecord | null>(request(this.id, this.storageId!, 'get', { key: `agent:session:${id}` }))))).filter((s): s is SessionRecord => !!s) : await this.request<SessionRecord[] | null>(request(this.id, this.storageId, 'get', { key: 'agent:sessions' }));
    let compacted = 0;
    for (const s of stored ?? []) {
      const before = JSON.stringify(s);
      if (s.status === 'running') s.status = 'partial'; // No claim that interrupted effects did or did not happen.
      const rec = compact(s);
      // Records written before results were stored once are rewritten in
      // the compact form the first time they are seen; a status change is
      // written back as before.
      const after = JSON.stringify(rec);
      if (after !== before) {
        await this.request(request(this.id, this.storageId, 'set', { key: `agent:session:${s.id}`, value: rec }));
        if (after.length < before.length) compacted++;
      }
      this.hold(rec);
    }
    await this.request(request(this.id, this.storageId, 'set', { key: 'agent:session-index', value: [...this.sessions.keys()] }));
    if (compacted > 0) log.info(`compacted ${compacted} stored session(s)`);
    log.info(`${this.sessions.size} session(s) loaded, ${this.trimmed.size} settled and trimmed`);
    await this.enforceRetention();
  }
}
