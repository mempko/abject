/**
 * TupleSpace — coordination primitive for cross-agent task distribution.
 *
 * Backed by SharedState (LWW CRDT), so tuples sync across connected peers
 * automatically. Agents put tasks, claim them optimistically, and post results.
 * Claim conflicts are resolved by LWW (highest timestamp wins, ties by peerId).
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
const STATE_NAME = 'tuple-space';
const CLAIM_TTL_MS = 5 * 60 * 1000; // 5 minutes — stale claims become reclaimable

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
  private localPeerId = '';

  constructor() {
    super({
      manifest: {
        name: 'TupleSpace',
        description:
          'Coordination primitive for cross-agent task distribution. Tuples are named records that agents can put, scan, claim, and update. Backed by SharedState CRDT for peer sync.',
        version: '1.0.0',
        interface: {
          id: TUPLE_SPACE_INTERFACE,
          name: 'TupleSpace',
          description: 'Distributed tuple coordination space',
          methods: [
            {
              name: 'put',
              description: 'Insert a new tuple into the space',
              parameters: [
                { name: 'fields', type: { kind: 'object', properties: {} }, description: 'Named fields for the tuple (goalId, type, status, description, data, etc.)' },
              ],
              returns: { kind: 'object', properties: { tupleId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'read',
              description: 'Find the first tuple matching all pattern fields (exact match)',
              parameters: [
                { name: 'pattern', type: { kind: 'object', properties: {} }, description: 'Fields to match (exact ===)' },
              ],
              returns: { kind: 'reference', reference: 'TupleEntry' },
            },
            {
              name: 'scan',
              description: 'Find all tuples matching the pattern',
              parameters: [
                { name: 'pattern', type: { kind: 'object', properties: {} }, description: 'Fields to match' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'TupleEntry' } },
            },
            {
              name: 'claim',
              description: 'Find and claim the first unclaimed tuple matching the pattern',
              parameters: [
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
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tuple ID to release' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'remove',
              description: 'Remove a tuple from the space',
              parameters: [
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tuple ID to remove' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'update',
              description: 'Merge new fields into an existing tuple',
              parameters: [
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tuple ID' },
                { name: 'fields', type: { kind: 'object', properties: {} }, description: 'Fields to merge' },
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

    // Create and subscribe to the shared state name
    if (this.sharedStateId) {
      await this.request(request(this.id, this.sharedStateId, 'create', { name: STATE_NAME }));
      await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: STATE_NAME }));
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## TupleSpace Usage Guide

### Put a tuple (task, data, etc.)

  const { tupleId } = await call(await dep('TupleSpace'), 'put', {
    fields: { goalId: 'goal-1', type: 'task', status: 'pending', description: 'Build a counter widget' },
  });

### Scan for matching tuples

  const tasks = await call(await dep('TupleSpace'), 'scan', {
    pattern: { goalId: 'goal-1', type: 'task', status: 'pending' },
  });

### Claim an unclaimed tuple (optimistic, LWW conflict resolution)

  const result = await call(await dep('TupleSpace'), 'claim', {
    pattern: { goalId: 'goal-1', type: 'task', status: 'pending' },
  });
  if (result) {
    // result.tuple is the claimed TupleEntry
    // result.claimed is true
  }

### Update a tuple (e.g., mark as done)

  await call(await dep('TupleSpace'), 'update', {
    tupleId: 'some-id',
    fields: { status: 'done', result: 'Created successfully' },
  });

### Release a claim

  await call(await dep('TupleSpace'), 'release', { tupleId: 'some-id' });

### Remove a tuple

  await call(await dep('TupleSpace'), 'remove', { tupleId: 'some-id' });

### IMPORTANT
- Tuples sync across peers via SharedState (LWW CRDT).
- Claims are optimistic — two peers can claim the same tuple, LWW picks the winner.
- Stale claims (>5 min with no update) are treated as unclaimed.
- Use GoalManager convenience methods (addTask, claimTask, completeTask) for goal-scoped task coordination.`;
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async getAllTuples(): Promise<Map<string, TupleEntry>> {
    if (!this.sharedStateId) return new Map();
    const all = await this.request<Record<string, unknown>>(
      request(this.id, this.sharedStateId, 'getAll', { name: STATE_NAME })
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

  private async writeTuple(tuple: TupleEntry): Promise<void> {
    if (!this.sharedStateId) return;
    await this.request(request(this.id, this.sharedStateId, 'set', {
      name: STATE_NAME,
      key: tuple.id,
      value: tuple,
      persist: true,
    }));
  }

  // ─── Handlers ───────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('put', async (msg: AbjectMessage) => {
      const { fields } = msg.payload as { fields: Record<string, unknown> };
      precondition(fields && typeof fields === 'object', 'fields must be an object');

      const tuple: TupleEntry = {
        id: uuidv4(),
        fields,
        createdAt: Date.now(),
        createdBy: this.localPeerId || this.id,
      };

      await this.writeTuple(tuple);
      const tupleCount = (await this.getAllTuples()).size;
      log.info(`PUT ${tuple.id} type=${fields.type ?? '?'} status=${fields.status ?? '?'} goalId=${(fields.goalId as string)?.slice(0, 8) ?? '?'} (${tupleCount} total)`);
      this.changed('tuplePut', tuple);

      return { tupleId: tuple.id };
    });

    this.on('read', async (msg: AbjectMessage) => {
      const { pattern } = msg.payload as { pattern: TuplePattern };
      const tuples = await this.getAllTuples();
      for (const tuple of tuples.values()) {
        if (this.matchesPattern(tuple, pattern)) return tuple;
      }
      return null;
    });

    this.on('scan', async (msg: AbjectMessage) => {
      const { pattern, limit } = msg.payload as { pattern: TuplePattern; limit?: number };
      const tuples = await this.getAllTuples();
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
      const { pattern } = msg.payload as { pattern: TuplePattern };
      const tuples = await this.getAllTuples();
      log.info(`CLAIM scanning ${tuples.size} tuples, pattern=${JSON.stringify(pattern)}`);

      for (const tuple of tuples.values()) {
        if (this.matchesPattern(tuple, pattern) && this.isUnclaimed(tuple)) {
          // Optimistic claim via LWW
          tuple.claimedBy = this.localPeerId || this.id;
          tuple.claimedAt = Date.now();
          await this.writeTuple(tuple);
          log.info(`CLAIMED ${tuple.id} type=${tuple.fields.type ?? '?'} attempts=${tuple.fields.attempts ?? 0}`);
          this.changed('tupleClaimed', tuple);
          return { tuple, claimed: true };
        }
      }
      log.info(`CLAIM no match found`);
      return null;
    });

    this.on('release', async (msg: AbjectMessage) => {
      const { tupleId } = msg.payload as { tupleId: string };
      requireNonEmpty(tupleId, 'tupleId');

      const tuples = await this.getAllTuples();
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
      await this.writeTuple(tuple);
      log.info(`RELEASED ${tupleId} status=${tuple.fields.status ?? '?'} attempts=${tuple.fields.attempts ?? 0}`);
      // Emit tupleUpdated so watchers (AgentAbject) can re-dispatch retried tasks
      this.changed('tupleUpdated', tuple);
      return true;
    });

    this.on('remove', async (msg: AbjectMessage) => {
      const { tupleId } = msg.payload as { tupleId: string };
      requireNonEmpty(tupleId, 'tupleId');

      if (!this.sharedStateId) return false;
      await this.request(request(this.id, this.sharedStateId, 'delete', {
        name: STATE_NAME, key: tupleId,
      }));
      const tupleCount = (await this.getAllTuples()).size;
      log.info(`REMOVED ${tupleId} (${tupleCount} remaining)`);
      this.changed('tupleRemoved', { tupleId });
      return true;
    });

    this.on('update', async (msg: AbjectMessage) => {
      const { tupleId, fields } = msg.payload as { tupleId: string; fields: Record<string, unknown> };
      requireNonEmpty(tupleId, 'tupleId');
      precondition(fields && typeof fields === 'object', 'fields must be an object');

      const tuples = await this.getAllTuples();
      const tuple = tuples.get(tupleId);
      if (!tuple) {
        log.info(`UPDATE ${tupleId} — not found`);
        return false;
      }

      Object.assign(tuple.fields, fields);
      await this.writeTuple(tuple);
      log.info(`UPDATED ${tupleId} status=${tuple.fields.status ?? '?'} attempts=${tuple.fields.attempts ?? 0} claimedBy=${tuple.claimedBy ?? 'none'}`);
      this.changed('tupleUpdated', tuple);
      return true;
    });

    // Forward SharedState change events as typed tuple events
    this.on('changed', async (msg: AbjectMessage) => {
      if (msg.routing.from === this.sharedStateId) {
        const { aspect, value } = msg.payload as { aspect: string; value: { name?: string; key?: string; value?: unknown } };
        if (aspect === 'stateChanged' && value?.name === STATE_NAME) {
          const entry = value.value as TupleEntry | undefined;
          log.info(`SHARED-STATE-CHANGE key=${value.key ?? '?'} status=${entry?.fields?.status ?? '?'} claimedBy=${entry?.claimedBy ?? 'none'}`);
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
