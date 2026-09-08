import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { withKeyedLock } from '../core/keyed-lock.js';

export interface SessionRecord {
  id: string; agentName: string; agentId?: AbjectId; goalId?: string; parentId?: string;
  intent: string; revision: number; attempt: number;
  status: 'running' | 'paused' | 'partial' | 'accepted' | 'cancelled';
  snapshot?: unknown; outstandingOperation?: unknown;
  outcome?: unknown; updatedAt: number;
  outbox: Array<{ id: string; destination: string; destinationName?: string; payload: unknown; delivered: boolean }>;
  usage: { tokens: number; cost: number; elapsedMs: number; unpricedCalls?:number; unreportedCalls?:number };
}

/** Workspace-owned durable task records. All mutation and recovery is through messages. */
export class TaskSession extends Abject {
  private storageId?: AbjectId;
  private sessions = new Map<string, SessionRecord>();
  constructor() {
    super({ manifest: { name: 'TaskSession', version: '1.0.0', description: 'Durable task conversations, hypotheses, operation state, outcomes and result delivery. Ask how to inspect, resume or fork a session.', interface: {
      id: 'abjects:task-session', name: 'TaskSession', description: 'Task continuity', methods: [
        { name: 'get', description: 'Get a session by id, including revision and unresolved operation', parameters: [{ name: 'id', description: 'Session id', type: { kind: 'primitive', primitive: 'string' } }], returns: { kind: 'object', properties: {} } },
        { name: 'list', description: 'List sessions and their progress', parameters: [], returns: { kind: 'array', elementType: { kind: 'object', properties: {} } } },
        { name: 'checkpoint', description: 'Runtime checkpoint: id, expectedRevision, agentName, intent, snapshot, outstandingOperation, status. Revision conflict changes nothing.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'resume', description: 'Prepare a new attempt by id and expectedRevision. Unknown operation effects must be reconciled first. AgentAbject.resumeTask performs execution.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'fork', description: 'Fork dialogue and evidence using id and newId. Does not undo external changes or inherit accepted completion.', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'reconcile', description: 'Record an evidence-backed outcome for an outstanding operation before resuming: id, expectedRevision, evidence, outcome.', parameters: [], returns: { kind: 'object', properties: {} } },
      ] }, requiredCapabilities: [], providedCapabilities: [], tags: ['system', 'agent', 'sessions'] } });
    this.on('get', msg => structuredClone(this.sessions.get((msg.payload as { id: string }).id) ?? null));
    this.on('list', () => [...this.sessions.values()].map(({ snapshot: _snapshot, ...r }) => structuredClone(r)));
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
      return [...this.sessions.values()].flatMap(s => s.outbox.filter(o => !o.delivered).map(o => ({ sessionId: s.id, ...structuredClone(o) })));
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
      const old = this.sessions.get(id);
      if (!old || !newId || this.sessions.has(newId)) throw new Error('Unknown source or duplicate fork id');
      return this.mutate(newId, 0, () => ({ ...structuredClone(old), id: newId, parentId: id, revision: 1, attempt: 1, status: 'paused', outcome: undefined, outbox: [], updatedAt: Date.now() }));
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
  private async runtimeOnly(sender: AbjectId): Promise<void> {
    if (sender !== await this.discoverDep('AgentAbject')) throw new Error('Session mutation belongs to AgentAbject');
  }
  private async mutate(id: string, expected: number | undefined, change: (old?: SessionRecord) => SessionRecord): Promise<{ success: boolean; session?: SessionRecord; conflict?: boolean; revision?: number }> {
    if (!id) throw new Error('Session id required');
    return withKeyedLock(`${this.id}:sessions`, async () => {
      const old = this.sessions.get(id);
      if (expected !== undefined && expected !== (old?.revision ?? 0)) return { success: false, conflict: true, revision: old?.revision ?? 0 };
      const next = change(old && structuredClone(old));
      if (!this.storageId) throw new Error('Storage unavailable; cannot acknowledge a durable session checkpoint');
      // Index first: a crash can leave a missing record, but never an undiscoverable acknowledged record.
      if (!old) await this.request(request(this.id, this.storageId, 'set', { key: 'agent:session-index', value: [...this.sessions.keys(), id] }));
      await this.request(request(this.id, this.storageId, 'set', { key: `agent:session:${id}`, value: next }));
      this.sessions.set(id, next);
      this.changed('sessionUpdated', { id, status: next.status, revision: next.revision });
      return { success: true, session: structuredClone(next) };
    });
  }
  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    if (!this.storageId) return;
    const index = await this.request<string[] | null>(request(this.id, this.storageId, 'get', { key: 'agent:session-index' }));
    const stored = index ? (await Promise.all(index.map(id => this.request<SessionRecord | null>(request(this.id, this.storageId!, 'get', { key: `agent:session:${id}` }))))).filter((s): s is SessionRecord => !!s) : await this.request<SessionRecord[] | null>(request(this.id, this.storageId, 'get', { key: 'agent:sessions' }));
    for (const s of stored ?? []) {
      if (s.status === 'running') s.status = 'partial'; // No claim that interrupted effects did or did not happen.
      this.sessions.set(s.id, s);
      await this.request(request(this.id,this.storageId,'set',{key:`agent:session:${s.id}`,value:s}));
    }
    await this.request(request(this.id,this.storageId,'set',{key:'agent:session-index',value:[...this.sessions.keys()]}));
  }
}
