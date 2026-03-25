/**
 * TupleSpace — coordination primitive for cross-agent task distribution.
 *
 * Backed by SharedState (LWW CRDT), so tuples sync across connected peers
 * automatically. Agents put tasks, claim them optimistically, and post results.
 * Claim conflicts are resolved by LWW (highest timestamp wins, ties by peerId).
 *
 * Each namespace maps to a separate SharedState namespace (`ts-{namespace}`).
 * Top-level goals get their own namespace; sub-goals reuse the parent's.
 * The active namespace list is persisted to Storage so it survives restarts.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as precondition, requireNonEmpty } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { v4 as uuidv4 } from 'uuid';

const log = new Log('TupleSpace');

const TUPLE_SPACE_INTERFACE: InterfaceId = 'abjects:tuple-space';
const CLAIM_TTL_MS = 5 * 60 * 1000; // 5 minutes — stale claims become reclaimable
const STORAGE_KEY = 'tuple-space:namespaces';

function stateName(namespace: string): string {
  return `ts-${namespace}`;
}

// ─── Data Model ──────────────────────────────────────────────────────

export interface TupleEntry {
  id: string;
  fields: Record<string, unknown>;
  createdAt: number;
  createdBy: string;
  claimedBy?: string;
  claimedAt?: number;
}

export interface TuplePattern {
  [field: string]: unknown;
}

// ─── TupleSpace ─────────────────────────────────────────────────────

export class TupleSpace extends Abject {
  private sharedStateId?: AbjectId;
  private storageId?: AbjectId;
  private localPeerId = '';
  private activeNamespaces = new Set<string>();

  constructor() {
    super({
      manifest: {
        name: 'TupleSpace',
        description:
          'Coordination primitive for cross-agent task distribution. Tuples are named records that agents can put, scan, claim, and update. Each namespace maps to a separate SharedState CRDT for peer-scoped sync.',
        version: '1.0.0',
        interface: {
          id: TUPLE_SPACE_INTERFACE,
          name: 'TupleSpace',
          description: 'Distributed tuple coordination space with per-goal namespaces',
          methods: [
            {
              name: 'put',
              description: 'Insert a new tuple into the space',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'fields', type: { kind: 'object', properties: {} }, description: 'Named fields for the tuple (goalId, type, status, description, data, etc.)' },
              ],
              returns: { kind: 'object', properties: { tupleId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'read',
              description: 'Find the first tuple matching all pattern fields (exact match)',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'pattern', type: { kind: 'object', properties: {} }, description: 'Fields to match (exact ===)' },
              ],
              returns: { kind: 'reference', reference: 'TupleEntry' },
            },
            {
              name: 'scan',
              description: 'Find all tuples matching the pattern',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'pattern', type: { kind: 'object', properties: {} }, description: 'Fields to match' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'TupleEntry' } },
            },
            {
              name: 'claim',
              description: 'Find and claim the first unclaimed tuple matching the pattern',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'pattern', type: { kind: 'object', properties: {} }, description: 'Fields to match' },
              ],
              returns: { kind: 'object', properties: {
                tuple: { kind: 'reference', reference: 'TupleEntry' },
                claimed: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
            {
              name: 'release',
              description: 'Release a claimed tuple (only if claimed by this peer)',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tuple ID to release' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'remove',
              description: 'Remove a tuple from the space',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tuple ID to remove' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'update',
              description: 'Merge new fields into an existing tuple',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace (top-level goal ID)' },
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tuple ID' },
                { name: 'fields', type: { kind: 'object', properties: {} }, description: 'Fields to merge' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'ensureNamespace',
              description: 'Create and subscribe to a namespace if not already active',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace to ensure (top-level goal ID)' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'removeNamespace',
              description: 'Remove a namespace and stop tracking it',
              parameters: [
                { name: 'namespace', type: { kind: 'primitive', primitive: 'string' }, description: 'Namespace to remove' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
          events: [
            { name: 'tuplePut', description: 'A new tuple was inserted', payload: { kind: 'reference', reference: 'TupleEntry' } },
            { name: 'tupleUpdated', description: 'A tuple was updated', payload: { kind: 'reference', reference: 'TupleEntry' } },
            { name: 'tupleRemoved', description: 'A tuple was removed', payload: { kind: 'object', properties: { tupleId: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'tupleClaimed', description: 'A tuple was claimed', payload: { kind: 'reference', reference: 'TupleEntry' } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.TUPLE_SPACE],
        tags: ['system', 'capability', 'coordination'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.sharedStateId = await this.discoverDep('SharedState') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    // Get local peerId from Identity
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.localPeerId = identity.peerId;
      } catch { /* Identity may not be ready */ }
    }

    // Load persisted namespaces and re-subscribe
    if (this.storageId && this.sharedStateId) {
      try {
        const stored = await this.request<string[] | null>(
          request(this.id, this.storageId, 'get', { key: STORAGE_KEY })
        );
        if (Array.isArray(stored)) {
          for (const ns of stored) {
            try {
              await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
              await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));
              this.activeNamespaces.add(ns);
            } catch { /* namespace may be gone */ }
          }
          if (this.activeNamespaces.size > 0) {
            log.info(`Loaded ${this.activeNamespaces.size} persisted namespaces`);
          }
        }
      } catch { /* No index yet */ }
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## TupleSpace Usage Guide

All methods require a \`namespace\` parameter (the top-level goal ID).

### Put a tuple (task, data, etc.)

  const { tupleId } = await call(await dep('TupleSpace'), 'put', {
    namespace: goalId,
    fields: { goalId: 'goal-1', type: 'task', status: 'pending', description: 'Build a counter widget' },
  });

### Scan for matching tuples

  const tasks = await call(await dep('TupleSpace'), 'scan', {
    namespace: goalId,
    pattern: { goalId: 'goal-1', type: 'task', status: 'pending' },
  });

### Claim an unclaimed tuple (optimistic, LWW conflict resolution)

  const result = await call(await dep('TupleSpace'), 'claim', {
    namespace: goalId,
    pattern: { goalId: 'goal-1', type: 'task', status: 'pending' },
  });
  if (result) {
    // result.tuple is the claimed TupleEntry
    // result.claimed is true
  }

### Update a tuple (e.g., mark as done)

  await call(await dep('TupleSpace'), 'update', {
    namespace: goalId,
    tupleId: 'some-id',
    fields: { status: 'done', result: 'Created successfully' },
  });

### Release a claim

  await call(await dep('TupleSpace'), 'release', { namespace: goalId, tupleId: 'some-id' });

### Remove a tuple

  await call(await dep('TupleSpace'), 'remove', { namespace: goalId, tupleId: 'some-id' });

### IMPORTANT
- Each namespace maps to a separate SharedState CRDT (\`ts-{namespace}\`).
- Top-level goals get their own namespace; sub-goals reuse the parent's.
- Remote peers only see tasks in namespaces they have subscribed to.
- Claims are optimistic -- two peers can claim the same tuple, LWW picks the winner.
- Stale claims (>5 min with no update) are treated as unclaimed.
- Use GoalManager convenience methods (addTask, claimTask, completeTask) for goal-scoped task coordination.`;
  }

  // ─── Namespace Helpers ─────────────────────────────────────────────

  private async doEnsureNamespace(namespace: string): Promise<void> {
    const ns = stateName(namespace);
    if (this.activeNamespaces.has(ns)) return;
    if (!this.sharedStateId) return;
    await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
    await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));
    this.activeNamespaces.add(ns);
    await this.saveNamespaceIndex();
    log.info(`Namespace created: ${ns}`);
  }

  private async saveNamespaceIndex(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: STORAGE_KEY,
        value: [...this.activeNamespaces],
      }));
    } catch { /* best effort */ }
  }

  // ─── Tuple Helpers ─────────────────────────────────────────────────

  private async getAllTuples(namespace: string): Promise<Map<string, TupleEntry>> {
    if (!this.sharedStateId) return new Map();
    const ns = stateName(namespace);
    // Ensure namespace exists before reading
    await this.doEnsureNamespace(namespace);
    const all = await this.request<Record<string, unknown>>(
      request(this.id, this.sharedStateId, 'getAll', { name: ns })
    );
    const result = new Map<string, TupleEntry>();
    for (const [key, value] of Object.entries(all)) {
      if (value && typeof value === 'object' && 'id' in (value as object)) {
        result.set(key, value as TupleEntry);
      }
    }
    return result;
  }

  private matchesPattern(entry: TupleEntry, pattern: TuplePattern): boolean {
    for (const [key, value] of Object.entries(pattern)) {
      if (entry.fields[key] !== value) return false;
    }
    return true;
  }

  private isClaimStale(entry: TupleEntry): boolean {
    if (!entry.claimedBy || !entry.claimedAt) return true;
    return entry.claimedAt + CLAIM_TTL_MS < Date.now();
  }

  private isUnclaimed(entry: TupleEntry): boolean {
    return !entry.claimedBy || this.isClaimStale(entry);
  }

  private async writeTuple(tuple: TupleEntry, namespace: string): Promise<void> {
    if (!this.sharedStateId) return;
    const ns = stateName(namespace);
    await this.doEnsureNamespace(namespace);
    await this.request(request(this.id, this.sharedStateId, 'set', {
      name: ns,
      key: tuple.id,
      value: tuple,
      persist: true,
    }));
  }

  // ─── Handlers ───────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('put', async (msg: AbjectMessage) => {
      const { namespace, fields } = msg.payload as { namespace: string; fields: Record<string, unknown> };
      requireNonEmpty(namespace, 'namespace');
      precondition(fields && typeof fields === 'object', 'fields must be an object');

      const tuple: TupleEntry = {
        id: uuidv4(),
        fields,
        createdAt: Date.now(),
        createdBy: this.localPeerId || this.id,
      };

      await this.writeTuple(tuple, namespace);
      const tupleCount = (await this.getAllTuples(namespace)).size;
      log.info(`PUT ${tuple.id} ns=${namespace.slice(0, 8)} type=${fields.type ?? '?'} status=${fields.status ?? '?'} goalId=${(fields.goalId as string)?.slice(0, 8) ?? '?'} (${tupleCount} total)`);
      this.changed('tuplePut', tuple);

      return { tupleId: tuple.id };
    });

    this.on('read', async (msg: AbjectMessage) => {
      const { namespace, pattern } = msg.payload as { namespace: string; pattern: TuplePattern };
      requireNonEmpty(namespace, 'namespace');
      const tuples = await this.getAllTuples(namespace);
      for (const tuple of tuples.values()) {
        if (this.matchesPattern(tuple, pattern)) return tuple;
      }
      return null;
    });

    this.on('scan', async (msg: AbjectMessage) => {
      const { namespace, pattern, limit } = msg.payload as { namespace: string; pattern: TuplePattern; limit?: number };
      requireNonEmpty(namespace, 'namespace');
      const tuples = await this.getAllTuples(namespace);
      const results: TupleEntry[] = [];
      for (const tuple of tuples.values()) {
        if (this.matchesPattern(tuple, pattern)) {
          results.push(tuple);
          if (limit && results.length >= limit) break;
        }
      }
      return results;
    });

    this.on('claim', async (msg: AbjectMessage) => {
      const { namespace, pattern } = msg.payload as { namespace: string; pattern: TuplePattern };
      requireNonEmpty(namespace, 'namespace');
      const tuples = await this.getAllTuples(namespace);
      log.info(`CLAIM scanning ${tuples.size} tuples in ns=${namespace.slice(0, 8)}, pattern=${JSON.stringify(pattern)}`);

      for (const tuple of tuples.values()) {
        if (this.matchesPattern(tuple, pattern) && this.isUnclaimed(tuple)) {
          // Optimistic claim via LWW
          tuple.claimedBy = this.localPeerId || this.id;
          tuple.claimedAt = Date.now();
          await this.writeTuple(tuple, namespace);
          log.info(`CLAIMED ${tuple.id} type=${tuple.fields.type ?? '?'} attempts=${tuple.fields.attempts ?? 0}`);
          this.changed('tupleClaimed', tuple);
          return { tuple, claimed: true };
        }
      }
      log.info(`CLAIM no match found`);
      return null;
    });

    this.on('release', async (msg: AbjectMessage) => {
      const { namespace, tupleId } = msg.payload as { namespace: string; tupleId: string };
      requireNonEmpty(namespace, 'namespace');
      requireNonEmpty(tupleId, 'tupleId');

      const tuples = await this.getAllTuples(namespace);
      const tuple = tuples.get(tupleId);
      if (!tuple) {
        log.info(`RELEASE ${tupleId} — not found`);
        return false;
      }

      const myId = this.localPeerId || this.id;
      if (tuple.claimedBy !== myId) {
        log.info(`RELEASE ${tupleId} — not claimed by us (claimedBy=${tuple.claimedBy}, us=${myId})`);
        return false;
      }

      tuple.claimedBy = undefined;
      tuple.claimedAt = undefined;
      await this.writeTuple(tuple, namespace);
      log.info(`RELEASED ${tupleId} status=${tuple.fields.status ?? '?'} attempts=${tuple.fields.attempts ?? 0}`);
      // Emit tupleUpdated so watchers (AgentAbject) can re-dispatch retried tasks
      this.changed('tupleUpdated', tuple);
      return true;
    });

    this.on('remove', async (msg: AbjectMessage) => {
      const { namespace, tupleId } = msg.payload as { namespace: string; tupleId: string };
      requireNonEmpty(namespace, 'namespace');
      requireNonEmpty(tupleId, 'tupleId');

      if (!this.sharedStateId) return false;
      const ns = stateName(namespace);
      await this.request(request(this.id, this.sharedStateId, 'delete', {
        name: ns, key: tupleId,
      }));
      const tupleCount = (await this.getAllTuples(namespace)).size;
      log.info(`REMOVED ${tupleId} (${tupleCount} remaining in ns=${namespace.slice(0, 8)})`);
      this.changed('tupleRemoved', { tupleId });
      return true;
    });

    this.on('update', async (msg: AbjectMessage) => {
      const { namespace, tupleId, fields } = msg.payload as { namespace: string; tupleId: string; fields: Record<string, unknown> };
      requireNonEmpty(namespace, 'namespace');
      requireNonEmpty(tupleId, 'tupleId');
      precondition(fields && typeof fields === 'object', 'fields must be an object');

      const tuples = await this.getAllTuples(namespace);
      const tuple = tuples.get(tupleId);
      if (!tuple) {
        log.info(`UPDATE ${tupleId} — not found`);
        return false;
      }

      Object.assign(tuple.fields, fields);
      await this.writeTuple(tuple, namespace);
      log.info(`UPDATED ${tupleId} status=${tuple.fields.status ?? '?'} attempts=${tuple.fields.attempts ?? 0} claimedBy=${tuple.claimedBy ?? 'none'}`);
      this.changed('tupleUpdated', tuple);
      return true;
    });

    this.on('ensureNamespace', async (msg: AbjectMessage) => {
      const { namespace } = msg.payload as { namespace: string };
      requireNonEmpty(namespace, 'namespace');
      await this.doEnsureNamespace(namespace);
      return true;
    });

    this.on('removeNamespace', async (msg: AbjectMessage) => {
      const { namespace } = msg.payload as { namespace: string };
      requireNonEmpty(namespace, 'namespace');
      const ns = stateName(namespace);
      this.activeNamespaces.delete(ns);
      await this.saveNamespaceIndex();
      log.info(`Namespace removed: ${ns}`);
      return true;
    });

    // Forward SharedState change events as typed tuple events
    this.on('changed', async (msg: AbjectMessage) => {
      if (msg.routing.from === this.sharedStateId) {
        const { aspect, value } = msg.payload as { aspect: string; value: { name?: string; key?: string; value?: unknown } };
        if (aspect === 'stateChanged' && value?.name && (value.name as string).startsWith('ts-')) {
          const entry = value.value as TupleEntry | undefined;
          log.info(`SHARED-STATE-CHANGE ns=${value.name} key=${value.key ?? '?'} status=${entry?.fields?.status ?? '?'} claimedBy=${entry?.claimedBy ?? 'none'}`);
          // Emit tupleUpdated so dependents (GoalManager) can react to remote status changes
          if (entry) {
            this.changed('tupleUpdated', entry);
          }
        }
      }
    });
  }
}

export const TUPLE_SPACE_ID = 'abjects:tuple-space' as AbjectId;
