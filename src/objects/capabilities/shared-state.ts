/**
 * SharedState capability — CRDT-backed distributed state for abjects.
 *
 * Provides a simple get/set/subscribe API backed by Last-Writer-Wins (LWW)
 * registers. Connected peers sync mutations automatically via PeerTransport
 * DataChannels. Each peer maintains its own replica; CRDTs handle conflict-free
 * merging by comparing (timestamp, peerId) tuples.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { require as precondition } from '../../core/contracts.js';
import { request as createRequest, event as createEvent } from '../../core/message.js';
import type { PeerId } from '../../core/identity.js';

const SHARED_STATE_INTERFACE: InterfaceId = 'abjects:shared-state';

export const SHARED_STATE_ID = 'abjects:shared-state' as AbjectId;

// ==========================================================================
// CRDT: LWW-Register Map
// ==========================================================================

interface LWWEntry {
  value: unknown;
  timestamp: number;
  peerId: string;
}

/**
 * A map of LWW-Registers. Each key has a value, timestamp, and peerId.
 * Conflict resolution: highest timestamp wins; on tie, highest peerId wins.
 */
class LWWMap {
  private entries: Map<string, LWWEntry> = new Map();

  get(key: string): unknown {
    return this.entries.get(key)?.value ?? null;
  }

  getAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      result[key] = entry.value;
    }
    return result;
  }

  /**
   * Set a value locally. Returns true if the value was updated.
   */
  set(key: string, value: unknown, timestamp: number, peerId: string): boolean {
    const existing = this.entries.get(key);
    if (existing && !this.isNewer(timestamp, peerId, existing)) {
      return false;
    }
    this.entries.set(key, { value, timestamp, peerId });
    return true;
  }

  delete(key: string, timestamp: number, peerId: string): boolean {
    const existing = this.entries.get(key);
    if (existing && !this.isNewer(timestamp, peerId, existing)) {
      return false;
    }
    this.entries.set(key, { value: undefined, timestamp, peerId });
    return true;
  }

  /**
   * Merge a remote entry. Returns true if local state was updated.
   */
  merge(key: string, entry: LWWEntry): boolean {
    return this.set(key, entry.value, entry.timestamp, entry.peerId);
  }

  /**
   * Export all entries for full-state sync.
   */
  exportEntries(): Array<{ key: string; entry: LWWEntry }> {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({ key, entry }));
  }

  private isNewer(timestamp: number, peerId: string, existing: LWWEntry): boolean {
    if (timestamp > existing.timestamp) return true;
    if (timestamp === existing.timestamp && peerId > existing.peerId) return true;
    return false;
  }
}

// ==========================================================================
// SharedState Abject
// ==========================================================================

export class SharedState extends Abject {
  private peerRegistryId?: AbjectId;
  private localPeerId = '';

  // Named state maps — each subscriber group gets its own CRDT map
  private stateMaps: Map<string, LWWMap> = new Map();
  // Track subscribers per state name
  private subscribers: Map<string, Set<AbjectId>> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'SharedState',
        description:
          'CRDT-backed distributed state. Any abject can create/subscribe to named shared state instances that sync across connected peers automatically.',
        version: '1.0.0',
        interface: {
          id: SHARED_STATE_INTERFACE,
          name: 'SharedState',
          description: 'Distributed shared state operations',
          methods: [
            {
              name: 'create',
              description: 'Create a named shared state instance',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'get',
              description: 'Get a value from a shared state instance',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
                { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Key to get' },
              ],
              returns: { kind: 'reference', reference: 'any' },
            },
            {
              name: 'getAll',
              description: 'Get all key-value pairs from a shared state instance',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
              ],
              returns: { kind: 'reference', reference: 'Record<string, any>' },
            },
            {
              name: 'set',
              description: 'Set a value in a shared state instance (syncs to peers)',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
                { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Key to set' },
                { name: 'value', type: { kind: 'reference', reference: 'any' }, description: 'Value to set' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'delete',
              description: 'Delete a key from a shared state instance (syncs to peers)',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
                { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Key to delete' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'subscribe',
              description: 'Subscribe to changes on a shared state instance',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'unsubscribe',
              description: 'Unsubscribe from a shared state instance',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
          events: [
            {
              name: 'stateChanged',
              description: 'A value changed in a shared state instance',
              payload: { kind: 'object', properties: {
                name: { kind: 'primitive', primitive: 'string' },
                key: { kind: 'primitive', primitive: 'string' },
                value: { kind: 'reference', reference: 'any' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.SHARED_STATE,
        ],
        tags: ['system', 'capability', 'shared-state'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('create', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      precondition(name !== '', 'State name must not be empty');
      if (!this.stateMaps.has(name)) {
        this.stateMaps.set(name, new LWWMap());
        this.subscribers.set(name, new Set());
      }
      return true;
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { name, key } = msg.payload as { name: string; key: string };
      const map = this.stateMaps.get(name);
      return map?.get(key) ?? null;
    });

    this.on('getAll', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const map = this.stateMaps.get(name);
      return map?.getAll() ?? {};
    });

    this.on('set', async (msg: AbjectMessage) => {
      const { name, key, value } = msg.payload as { name: string; key: string; value: unknown };
      return this.setValueLocal(name, key, value);
    });

    this.on('delete', async (msg: AbjectMessage) => {
      const { name, key } = msg.payload as { name: string; key: string };
      return this.deleteValueLocal(name, key);
    });

    this.on('subscribe', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const subs = this.subscribers.get(name);
      if (!subs) return false;
      subs.add(msg.routing.from);
      return true;
    });

    this.on('unsubscribe', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const subs = this.subscribers.get(name);
      if (!subs) return false;
      subs.delete(msg.routing.from);
      return true;
    });

    // Handle sync messages from remote peers
    this.on('_syncEntry', async (msg: AbjectMessage) => {
      const { name, key, entry } = msg.payload as {
        name: string; key: string; entry: LWWEntry;
      };
      this.handleRemoteSync(name, key, entry);
    });

    this.on('_syncFull', async (msg: AbjectMessage) => {
      const { name, entries } = msg.payload as {
        name: string; entries: Array<{ key: string; entry: LWWEntry }>;
      };
      this.handleFullSync(name, entries);
    });

    this.on('_requestSync', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const map = this.stateMaps.get(name);
      if (!map) return;
      // Send full state back to the requesting peer
      const fromPeerId = (msg.payload as any).fromPeerId as string;
      if (fromPeerId) {
        this.sendFullSyncToPeer(name, map, fromPeerId);
      }
    });
  }

  protected override async onInit(): Promise<void> {
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;

    // Get local peer ID for CRDT ordering
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          createRequest(this.id, identityId, 'exportPublicKeys', {}),
        );
        this.localPeerId = identity.peerId;
      } catch { /* no identity yet */ }
    }

    // Subscribe to PeerRegistry for new connections (to sync state)
    if (this.peerRegistryId) {
      await this.request(createRequest(this.id, this.peerRegistryId, 'addDependent', {}));
    }
  }

  // ==========================================================================
  // Local mutations
  // ==========================================================================

  private setValueLocal(name: string, key: string, value: unknown): boolean {
    let map = this.stateMaps.get(name);
    if (!map) {
      map = new LWWMap();
      this.stateMaps.set(name, map);
      this.subscribers.set(name, new Set());
    }

    const timestamp = Date.now();
    const updated = map.set(key, value, timestamp, this.localPeerId);
    if (updated) {
      this.notifySubscribers(name, key, value);
      this.broadcastEntry(name, key, { value, timestamp, peerId: this.localPeerId });
    }
    return updated;
  }

  private deleteValueLocal(name: string, key: string): boolean {
    const map = this.stateMaps.get(name);
    if (!map) return false;

    const timestamp = Date.now();
    const updated = map.delete(key, timestamp, this.localPeerId);
    if (updated) {
      this.notifySubscribers(name, key, undefined);
      this.broadcastEntry(name, key, { value: undefined, timestamp, peerId: this.localPeerId });
    }
    return updated;
  }

  // ==========================================================================
  // Remote sync
  // ==========================================================================

  private handleRemoteSync(name: string, key: string, entry: LWWEntry): void {
    let map = this.stateMaps.get(name);
    if (!map) {
      map = new LWWMap();
      this.stateMaps.set(name, map);
      this.subscribers.set(name, new Set());
    }

    const updated = map.merge(key, entry);
    if (updated) {
      this.notifySubscribers(name, key, entry.value);
    }
  }

  private handleFullSync(name: string, entries: Array<{ key: string; entry: LWWEntry }>): void {
    let map = this.stateMaps.get(name);
    if (!map) {
      map = new LWWMap();
      this.stateMaps.set(name, map);
      this.subscribers.set(name, new Set());
    }

    for (const { key, entry } of entries) {
      const updated = map.merge(key, entry);
      if (updated) {
        this.notifySubscribers(name, key, entry.value);
      }
    }
  }

  // ==========================================================================
  // Broadcasting
  // ==========================================================================

  private notifySubscribers(name: string, key: string, value: unknown): void {
    this.changed('stateChanged', { name, key, value });
  }

  private broadcastEntry(name: string, key: string, entry: LWWEntry): void {
    // Route through PeerRouter — send to remote SharedState instances
    // PeerRouter will forward event messages addressed to well-known IDs
    this.send(createEvent(this.id, SHARED_STATE_ID, '_syncEntry', {
      name, key, entry,
    })).catch(() => { /* best-effort */ });
  }

  private sendFullSyncToPeer(name: string, map: LWWMap, _toPeerId: string): void {
    const entries = map.exportEntries();
    this.send(createEvent(this.id, SHARED_STATE_ID, '_syncFull', {
      name, entries,
    })).catch(() => { /* best-effort */ });
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## SharedState Usage Guide

### Create a shared state instance

  const ssId = await dep('SharedState');
  await call(ssId, 'create', { name: 'my-state' });

### Set a value (syncs to connected peers)

  await call(ssId, 'set', { name: 'my-state', key: 'count', value: 42 });

### Get a value

  const val = await call(ssId, 'get', { name: 'my-state', key: 'count' });

### Get all values

  const all = await call(ssId, 'getAll', { name: 'my-state' });

### Subscribe to changes

  await call(ssId, 'subscribe', { name: 'my-state' });
  // Listen for 'stateChanged' events with { name, key, value }

### Delete a key

  await call(ssId, 'delete', { name: 'my-state', key: 'count' });

### IMPORTANT
- State syncs automatically to connected peers via PeerTransport
- Conflicts resolved by Last-Writer-Wins (highest timestamp, then highest peerId)
- Create the state instance on both peers before they connect`;
  }
}
