/**
 * SharedState capability — CRDT-backed distributed state for abjects.
 *
 * Provides a simple get/set/subscribe API backed by Last-Writer-Wins (LWW)
 * registers. Connected peers sync mutations automatically via workspace-scoped
 * discovery: SharedState instances find each other through the
 * WorkspaceShareRegistry + remote workspace registries, then sync directly.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { require as precondition } from '../../core/contracts.js';
import { request as createRequest, event as createEvent } from '../../core/message.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('SharedState');


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

const DISCOVERY_DEBOUNCE_MS = 2000;
const GOSSIP_FANOUT_BASE = 4; // Base gossip fanout
const ANTI_ENTROPY_INTERVAL = 30_000; // 30s anti-entropy cycle
const PROPAGATION_EXPIRY = 15_000; // 15s dedup window

export class SharedState extends Abject {
  private peerRegistryId?: AbjectId;
  private wsrId?: AbjectId;
  private storageId?: AbjectId;
  private localPeerId = '';

  // Named state maps — each subscriber group gets its own CRDT map
  private stateMaps: Map<string, LWWMap> = new Map();
  // Track subscribers per state name
  private subscribers: Map<string, Set<AbjectId>> = new Map();
  // Track which keys are persisted — maps state name → set of persisted key names
  private persistedKeys: Map<string, Set<string>> = new Map();

  // Remote SharedState instances discovered via WSR + remote registries
  // Key: remote SharedState AbjectId string, Value: AbjectId
  private remotePeers: Map<string, AbjectId> = new Map();

  // Discovery debounce
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  private discoveryDone = false;
  // When true, next discovery will prune peers not found (triggered by disconnect events)
  private pruneOnNextDiscovery = false;

  // Names requested by peers that we don't locally subscribe to.
  // Used to bridge data between workspaces: if a peer asks for names
  // this SharedState doesn't have, we include them in anti-entropy requests
  // so data can flow through this SharedState as a relay.
  private bridgedNames: Set<string> = new Set();

  // Phase 4: Gossip propagation state
  private seenPropagations: Map<string, number> = new Map(); // propagationId → expiry
  private antiEntropyTimer?: ReturnType<typeof setInterval>;

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
              description: 'Set a value in a shared state instance (syncs to peers). Optionally persist to survive restarts.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'State instance name' },
                { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Key to set' },
                { name: 'value', type: { kind: 'reference', reference: 'any' }, description: 'Value to set' },
                { name: 'persist', type: { kind: 'primitive', primitive: 'boolean' }, description: 'If true, persist this key to storage so it survives restarts (optional, default false)' },
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
      const { name, key, value, persist } = msg.payload as { name: string; key: string; value: unknown; persist?: boolean };
      log.info(`[${this.id.slice(0, 8)}] set name='${name}' key='${key}' persist=${persist ?? false} remotePeers=${this.remotePeers.size}`);
      if (persist) {
        if (!this.persistedKeys.has(name)) this.persistedKeys.set(name, new Set());
        this.persistedKeys.get(name)!.add(key);
        await this.saveManifest();
      }
      return this.setValueLocal(name, key, value);
    });

    this.on('delete', async (msg: AbjectMessage) => {
      const { name, key } = msg.payload as { name: string; key: string };
      const result = this.deleteValueLocal(name, key);
      // Clean up persistence tracking for deleted keys
      const persisted = this.persistedKeys.get(name);
      if (persisted?.has(key)) {
        persisted.delete(key);
        if (persisted.size === 0) this.persistedKeys.delete(name);
        await this.saveManifest();
      }
      await this.persistEntry(name, key, undefined);
      return result;
    });

    this.on('subscribe', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      log.info(`[${this.id.slice(0, 8)}] subscribe '${name}' from=${msg.routing.from.slice(0, 8)}`);
      const isNewName = !this.stateMaps.has(name);
      // Auto-create state map if it doesn't exist
      if (isNewName) {
        this.stateMaps.set(name, new LWWMap());
        this.subscribers.set(name, new Set());
      }
      const subs = this.subscribers.get(name)!;
      subs.add(msg.routing.from);

      // Trigger discovery on first subscription if not done yet
      if (!this.discoveryDone) {
        log.info(`[${this.id.slice(0, 8)}] first subscribe — scheduling discovery`);
        this.scheduleDiscovery();
      } else if (isNewName && this.remotePeers.size > 0) {
        // Discovery already ran — request sync from known remote peers for the new name.
        // This handles the case where Chat subscribes after discovery already completed.
        log.info(`[${this.id.slice(0, 8)}] new name '${name}' after discovery — requesting sync from ${this.remotePeers.size} known peers`);
        for (const remoteSSId of this.remotePeers.values()) {
          this.send(createEvent(this.id, remoteSSId, '_requestSync', {
            names: [name],
          }));
        }
      }
      return true;
    });

    this.on('unsubscribe', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const subs = this.subscribers.get(name);
      if (!subs) return false;
      subs.delete(msg.routing.from);
      return true;
    });

    this.on('removeNamespace', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      // Delete all persisted entries from storage
      const persisted = this.persistedKeys.get(name);
      if (persisted && this.storageId) {
        for (const key of persisted) {
          try {
            await this.request(createRequest(this.id, this.storageId, 'delete', { key: `shared-state:${name}:${key}` }));
          } catch { /* best effort */ }
        }
      }
      // Remove all in-memory state
      this.persistedKeys.delete(name);
      this.stateMaps.delete(name);
      this.subscribers.delete(name);
      await this.saveManifest();
      return true;
    });

    // Handle sync messages from remote SharedState instances
    this.on('_syncEntry', async (msg: AbjectMessage) => {
      const { name, key, entry, propagationId, hopsRemaining } = msg.payload as {
        name: string; key: string; entry: LWWEntry;
        propagationId?: string; hopsRemaining?: number;
      };
      const fromId = msg.routing.from;
      log.info(`[${this.id.slice(0, 8)}] _syncEntry from=${fromId.slice(0, 8)} name='${name}' key='${key}'`);

      // Add the sender as a known remote peer (bidirectional link)
      if (fromId !== this.id && !this.remotePeers.has(fromId)) {
        this.remotePeers.set(fromId, fromId as AbjectId);
        log.info(`[${this.id.slice(0, 8)}] added remote peer ${fromId.slice(0, 8)} from _syncEntry`);
      }

      // Phase 4: Dedup propagation
      if (propagationId) {
        if (this.seenPropagations.has(propagationId)) {
          return; // Already processed
        }
        this.seenPropagations.set(propagationId, Date.now() + PROPAGATION_EXPIRY);
      }

      const updated = this.handleRemoteSync(name, key, entry);

      // Phase 4: Re-gossip if merge updated local state and hops remaining
      if (updated && propagationId && (hopsRemaining ?? 0) > 0) {
        const fanout = Math.min(
          GOSSIP_FANOUT_BASE,
          Math.max(1, Math.ceil(Math.log2(this.remotePeers.size + 1))),
          this.remotePeers.size,
        );
        const allPeers = Array.from(this.remotePeers.values()).filter(id => id !== fromId);
        const selected = this.selectRandom(allPeers, fanout);
        for (const remoteSSId of selected) {
          this.send(createEvent(this.id, remoteSSId, '_syncEntry', {
            name, key, entry, propagationId, hopsRemaining: (hopsRemaining ?? 0) - 1,
          }));
        }
      }
    });

    this.on('_syncFull', async (msg: AbjectMessage) => {
      const { name, entries } = msg.payload as {
        name: string; entries: Array<{ key: string; entry: LWWEntry }>;
      };
      const fromId = msg.routing.from;
      log.info(`[${this.id.slice(0, 8)}] _syncFull from=${fromId.slice(0, 8)} name='${name}' entries=${entries.length}`);

      // Add the sender as a known remote peer (bidirectional link)
      if (fromId !== this.id && !this.remotePeers.has(fromId)) {
        this.remotePeers.set(fromId, fromId as AbjectId);
        log.info(`[${this.id.slice(0, 8)}] added remote peer ${fromId.slice(0, 8)} from _syncFull`);
      }

      this.handleFullSync(name, entries);
    });

    this.on('_requestSync', async (msg: AbjectMessage) => {
      const { names } = msg.payload as { names: string[] };
      const fromId = msg.routing.from;
      log.info(`[${this.id.slice(0, 8)}] _requestSync from=${fromId.slice(0, 8)} names=${JSON.stringify(names)}`);

      // Add the requester as a known remote peer (bidirectional link)
      if (fromId !== this.id && !this.remotePeers.has(fromId)) {
        this.remotePeers.set(fromId, fromId as AbjectId);
        log.info(`[${this.id.slice(0, 8)}] added remote peer ${fromId.slice(0, 8)} from _requestSync`);
      }

      // Send full state back to the requesting SharedState for each name
      for (const name of names) {
        const map = this.stateMaps.get(name);
        if (!map) {
          log.info(`[${this.id.slice(0, 8)}] _requestSync: no map for '${name}'`);
          this.bridgedNames.add(name);
          continue;
        }
        const entries = map.exportEntries();
        log.info(`[${this.id.slice(0, 8)}] _requestSync: sending _syncFull for '${name}' with ${entries.length} entries to ${fromId.slice(0, 8)}`);
        if (entries.length === 0) continue;
        this.send(createEvent(this.id, fromId, '_syncFull', {
          name, entries,
        }));
      }
    });

    // Re-discover when WSR reports workspace changes
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      log.info(`[${this.id.slice(0, 8)}] changed event: aspect='${aspect}' from=${msg.routing.from.slice(0, 8)}`);

      if (aspect === 'workspacesDiscovered' || aspect === 'workspaceRemoved') {
        log.info(`[${this.id.slice(0, 8)}] WSR event '${aspect}' — scheduling discovery`);
        this.scheduleDiscovery();
        return;
      }

      if (aspect === 'contactConnected' || aspect === 'networkPeerConnected') {
        log.info(`[${this.id.slice(0, 8)}] peer connect event — scheduling discovery`);
        this.scheduleDiscovery();
        return;
      }

      if (aspect === 'contactDisconnected' || aspect === 'networkPeerDisconnected') {
        log.info(`[${this.id.slice(0, 8)}] peer disconnect event — scheduling pruning discovery`);
        this.pruneOnNextDiscovery = true;
        this.scheduleDiscovery();
        return;
      }
    });
  }

  protected override async onInit(): Promise<void> {
    log.info(`[${this.id.slice(0, 8)}] onInit starting`);
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    log.info(`[${this.id.slice(0, 8)}] peerRegistryId=${this.peerRegistryId?.slice(0, 8) ?? 'NONE'}`);
    // Discover Storage for optional key persistence
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    log.info(`[${this.id.slice(0, 8)}] storageId=${this.storageId?.slice(0, 8) ?? 'NONE'}`);

    // Get local peer ID for CRDT ordering
    const identityId = await this.discoverDep('Identity');
    if (identityId) {
      try {
        const identity = await this.request<{ peerId: string }>(
          createRequest(this.id, identityId, 'exportPublicKeys', {}),
        );
        this.localPeerId = identity.peerId;
        log.info(`[${this.id.slice(0, 8)}] localPeerId=${this.localPeerId.slice(0, 16)}`);
      } catch { /* no identity yet */ }
    }

    // Load persisted entries from Storage
    await this.loadPersistedEntries();

    // WSR is spawned after workspace boot, so discover lazily (not here)
    // Try now, but don't worry if it fails — we'll retry in discoverRemoteSharedStates
    this.wsrId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    log.info(`[${this.id.slice(0, 8)}] wsrId=${this.wsrId?.slice(0, 8) ?? 'NONE (will retry lazily)'}`);

    // Subscribe to PeerRegistry for connect/disconnect events
    if (this.peerRegistryId) {
      await this.request(createRequest(this.id, this.peerRegistryId, 'addDependent', {}));
      log.info(`[${this.id.slice(0, 8)}] subscribed to PeerRegistry events`);
    }

    // Subscribe to WSR events if found; otherwise will subscribe on first lazy discovery
    if (this.wsrId) {
      await this.subscribeToWsr();
    }

    // Phase 4: Anti-entropy — every 30s, pick one random remote peer and exchange state digests
    this.antiEntropyTimer = setInterval(() => {
      this.antiEntropyExchange();
    }, ANTI_ENTROPY_INTERVAL);

    log.info(`[${this.id.slice(0, 8)}] onInit complete`);
  }

  // ==========================================================================
  // Discovery — find remote SharedState instances via WSR
  // ==========================================================================

  private async subscribeToWsr(): Promise<void> {
    if (!this.wsrId) return;
    try {
      await this.request(createRequest(this.id, this.wsrId, 'addDependent', {}));
      log.info(`[${this.id.slice(0, 8)}] subscribed to WSR events`);
    } catch (err) {
      log.warn(`[${this.id.slice(0, 8)}] failed to subscribe to WSR:`, err);
    }
  }

  private async ensureWsr(): Promise<boolean> {
    if (this.wsrId) return true;
    this.wsrId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    if (this.wsrId) {
      log.info(`[${this.id.slice(0, 8)}] lazily discovered wsrId=${this.wsrId.slice(0, 8)}`);
      await this.subscribeToWsr();
      return true;
    }
    log.info(`[${this.id.slice(0, 8)}] WSR still not available`);
    return false;
  }

  private scheduleDiscovery(): void {
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      this.discoverRemoteSharedStates().catch(err => {
        log.warn('discovery failed:', err);
      });
    }, DISCOVERY_DEBOUNCE_MS);
  }

  private async discoverRemoteSharedStates(): Promise<void> {
    log.info(`[${this.id.slice(0, 8)}] discoverRemoteSharedStates starting`);

    // Get all subscribed state names (only sync what we care about)
    const subscribedNames = this.getSubscribedStateNames();
    log.info(`[${this.id.slice(0, 8)}] subscribedNames=${JSON.stringify(subscribedNames)}`);
    if (subscribedNames.length === 0) {
      log.info(`[${this.id.slice(0, 8)}] no subscribed names — aborting discovery`);
      return;
    }

    this.discoveryDone = true;

    // Lazy WSR discovery — it may not have existed at init time
    if (!await this.ensureWsr()) {
      log.info(`[${this.id.slice(0, 8)}] no WSR available — aborting discovery`);
      return;
    }
    const wsrId = this.wsrId!;

    // Trigger WSR discovery to refresh cached workspaces
    try {
      await this.request(createRequest(this.id, wsrId, 'discoverWorkspaces', { hops: 1 }));
    } catch {
      // WSR discovery may fail — proceed with cached results
    }

    // Get discovered remote workspaces
    let discovered: Array<{ registryId: string; ownerPeerId: string; workspaceId: string; name?: string }> = [];
    try {
      discovered = await this.request<Array<{ registryId: string; ownerPeerId: string; workspaceId: string; name?: string }>>(
        createRequest(this.id, wsrId, 'getDiscoveredWorkspaces', {}),
      );
    } catch {
      // No discovered workspaces
    }

    // Also get locally shared workspaces (cross-workspace on same peer)
    let localShared: Array<{ registryId?: string; name?: string }> = [];
    try {
      localShared = await this.request<Array<{ registryId?: string; name?: string }>>(
        createRequest(this.id, wsrId, 'getSharedWorkspaces', {}),
      );
    } catch {
      // No local shared workspaces
    }

    log.info(`[${this.id.slice(0, 8)}] discovery: ${discovered.length} remote, ${localShared.length} local shared`);

    const newRemotePeers = new Map<string, AbjectId>();

    // Discover SharedState in each remote workspace via its registry
    for (const ws of discovered) {
      const registryId = ws.registryId as AbjectId;
      if (!registryId) continue;

      try {
        const queryResults = await this.request<Array<{ id: AbjectId }>>(
          createRequest(this.id, registryId, 'discover', { name: 'SharedState' }),
        );
        if (queryResults.length > 0) {
          const remoteSSId = queryResults[0].id;
          if (remoteSSId !== this.id) {
            newRemotePeers.set(remoteSSId, remoteSSId);
          }
        }
      } catch {
        // Remote registry not reachable — skip
      }
    }

    // Discover SharedState in locally shared workspaces
    for (const ws of localShared) {
      const registryId = ws.registryId as AbjectId | undefined;
      if (!registryId) continue;

      try {
        const queryResults = await this.request<Array<{ id: AbjectId }>>(
          createRequest(this.id, registryId, 'discover', { name: 'SharedState' }),
        );
        if (queryResults.length > 0) {
          const remoteSSId = queryResults[0].id;
          if (remoteSSId !== this.id) {
            newRemotePeers.set(remoteSSId, remoteSSId);
          }
        }
      } catch {
        // Registry not reachable — skip
      }
    }

    // Find newly discovered remote SharedState instances
    const newlyDiscovered: AbjectId[] = [];
    for (const [key, ssId] of newRemotePeers) {
      if (!this.remotePeers.has(key)) {
        newlyDiscovered.push(ssId);
      }
    }

    if (this.pruneOnNextDiscovery) {
      // Disconnect event: replace remotePeers with fresh discovery results
      // to remove peers that are no longer reachable
      this.remotePeers = newRemotePeers;
      this.pruneOnNextDiscovery = false;
      log.info(`[${this.id.slice(0, 8)}] pruned stale peers — now ${this.remotePeers.size} remote instances`);
    } else {
      // Normal discovery: merge — add newly discovered peers without removing existing ones.
      // Existing peers (including those added via bidirectional _syncEntry/_requestSync
      // links) are kept even if discovery couldn't re-resolve them this cycle.
      for (const [key, ssId] of newRemotePeers) {
        this.remotePeers.set(key, ssId);
      }
    }

    log.info(`[${this.id.slice(0, 8)}] Discovery complete: ${this.remotePeers.size} remote instances, ${newlyDiscovered.length} new`);

    // Request full sync from newly discovered remote SharedState instances
    for (const remoteSSId of newlyDiscovered) {
      log.info(`[${this.id.slice(0, 8)}] sending _requestSync to ${remoteSSId.slice(0, 8)} for names=${JSON.stringify(subscribedNames)}`);
      this.send(createEvent(this.id, remoteSSId, '_requestSync', {
        names: subscribedNames,
      }));
    }
  }

  private getSubscribedStateNames(): string[] {
    const names: string[] = [];
    for (const [name, subs] of this.subscribers) {
      if (subs.size > 0 || this.stateMaps.has(name)) {
        names.push(name);
      }
    }
    // Include bridged names so data from other peers can relay through us
    for (const name of this.bridgedNames) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    return names;
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
      this.persistEntry(name, key, { value, timestamp, peerId: this.localPeerId });
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
      this.persistEntry(name, key, undefined);
      this.notifySubscribers(name, key, undefined);
      this.broadcastEntry(name, key, { value: undefined, timestamp, peerId: this.localPeerId });
    }
    return updated;
  }

  // ==========================================================================
  // Remote sync
  // ==========================================================================

  private handleRemoteSync(name: string, key: string, entry: LWWEntry): boolean {
    let map = this.stateMaps.get(name);
    if (!map) {
      map = new LWWMap();
      this.stateMaps.set(name, map);
      this.subscribers.set(name, new Set());
    }

    const updated = map.merge(key, entry);
    if (updated) {
      this.persistEntry(name, key, entry);
      this.notifySubscribers(name, key, entry.value);
    }
    return updated;
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
        this.persistEntry(name, key, entry);
        this.notifySubscribers(name, key, entry.value);
      }
    }
  }

  // ==========================================================================
  // Broadcasting
  // ==========================================================================

  private notifySubscribers(name: string, key: string, value: unknown): void {
    const subs = this.subscribers.get(name);
    if (!subs || subs.size === 0) return;
    for (const subId of subs) {
      this.send(createEvent(this.id, subId, 'changed', {
        aspect: 'stateChanged',
        value: { name, key, value },
      }));
    }
  }

  private broadcastEntry(name: string, key: string, entry: LWWEntry): void {
    if (this.remotePeers.size === 0) return;

    const propagationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.seenPropagations.set(propagationId, Date.now() + PROPAGATION_EXPIRY);

    // Gossip: pick ceil(log2(n)) random peers instead of all
    const fanout = Math.min(
      GOSSIP_FANOUT_BASE,
      Math.max(1, Math.ceil(Math.log2(this.remotePeers.size + 1))),
      this.remotePeers.size,
    );

    const allPeers = Array.from(this.remotePeers.values());
    const selected = this.selectRandom(allPeers, fanout);

    log.info(`[${this.id.slice(0, 8)}] gossipBroadcast name='${name}' key='${key}' to ${selected.length}/${this.remotePeers.size} peers`);
    for (const remoteSSId of selected) {
      this.send(createEvent(this.id, remoteSSId, '_syncEntry', {
        name, key, entry, propagationId, hopsRemaining: 3,
      }));
    }
  }

  // ==========================================================================
  // Persistence — optional per-key storage
  // ==========================================================================

  private async persistEntry(name: string, key: string, entry: LWWEntry | undefined): Promise<void> {
    if (!this.storageId) return;
    const persisted = this.persistedKeys.get(name);
    if (!persisted?.has(key)) return;
    const storageKey = `shared-state:${name}:${key}`;
    try {
      if (entry === undefined || entry.value === undefined) {
        await this.request(createRequest(this.id, this.storageId, 'delete', { key: storageKey }));
      } else {
        await this.request(createRequest(this.id, this.storageId, 'set', { key: storageKey, value: entry }));
      }
    } catch { /* best-effort */ }
  }

  private async saveManifest(): Promise<void> {
    if (!this.storageId) return;
    const manifest: Record<string, string[]> = {};
    for (const [name, keys] of this.persistedKeys) {
      manifest[name] = [...keys];
    }
    try {
      await this.request(createRequest(this.id, this.storageId, 'set', {
        key: 'shared-state:_manifest', value: manifest,
      }));
    } catch { /* best-effort */ }
  }

  private async loadPersistedEntries(): Promise<void> {
    if (!this.storageId) return;
    try {
      const manifest = await this.request<Record<string, string[]> | null>(
        createRequest(this.id, this.storageId, 'get', { key: 'shared-state:_manifest' }),
      );
      if (!manifest) return;
      log.info(`[${this.id.slice(0, 8)}] loading persisted manifest:`, manifest);

      for (const [name, keys] of Object.entries(manifest)) {
        this.persistedKeys.set(name, new Set(keys));
        let map = this.stateMaps.get(name);
        if (!map) {
          map = new LWWMap();
          this.stateMaps.set(name, map);
          this.subscribers.set(name, new Set());
        }

        for (const key of keys) {
          const storageKey = `shared-state:${name}:${key}`;
          try {
            const entry = await this.request<LWWEntry | null>(
              createRequest(this.id, this.storageId!, 'get', { key: storageKey }),
            );
            if (entry && entry.value !== undefined) {
              map.merge(key, entry);
              log.info(`[${this.id.slice(0, 8)}] restored '${name}':'${key}'`);
            }
          } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      log.warn(`[${this.id.slice(0, 8)}] failed to load persisted entries:`, err);
    }
  }

  // ==========================================================================
  // Phase 4: Anti-entropy & gossip helpers
  // ==========================================================================

  private async antiEntropyExchange(): Promise<void> {
    if (this.remotePeers.size === 0) return;

    // Clean up expired propagation IDs
    const now = Date.now();
    for (const [id, expiry] of this.seenPropagations) {
      if (now > expiry) this.seenPropagations.delete(id);
    }

    // Pick one random remote peer
    const allPeers = Array.from(this.remotePeers.values());
    const targetPeer = allPeers[Math.floor(Math.random() * allPeers.length)];

    // Send digest of all our state maps
    const subscribedNames = this.getSubscribedStateNames();
    if (subscribedNames.length === 0) return;

    // Build digest: [{name, key, timestamp}]
    const digest: Array<{ name: string; key: string; timestamp: number }> = [];
    for (const name of subscribedNames) {
      const map = this.stateMaps.get(name);
      if (!map) continue;
      for (const { key, entry } of map.exportEntries()) {
        digest.push({ name, key, timestamp: entry.timestamp });
      }
    }

    // Request sync for names where we may have gaps
    this.send(createEvent(this.id, targetPeer, '_requestSync', {
      names: subscribedNames,
    }));
  }

  private selectRandom<T>(arr: T[], n: number): T[] {
    if (n >= arr.length) return [...arr];
    const copy = [...arr];
    const result: T[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * copy.length);
      result.push(copy[idx]);
      copy[idx] = copy[copy.length - 1];
      copy.pop();
    }
    return result;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## SharedState Usage Guide

### Create a shared state instance

  const ssId = await dep('SharedState');
  await call(ssId, 'create', { name: 'my-state' });

### Set a value (syncs to connected peers)

  await call(ssId, 'set', { name: 'my-state', key: 'count', value: 42 });

### Set a value with persistence (survives restarts)

  await call(ssId, 'set', { name: 'my-state', key: 'count', value: 42, persist: true });

### Get a value

  const val = await call(ssId, 'get', { name: 'my-state', key: 'count' });

### Get all values

  const all = await call(ssId, 'getAll', { name: 'my-state' });

### Subscribe to changes and receive events

  // 1. Subscribe to a named state (scoped — only changes to 'my-state' are sent)
  await call(ssId, 'subscribe', { name: 'my-state' });

  // 2. Define a 'changed' handler in your source to receive events:
  //
  //   changed(msg) {
  //     const { aspect, value } = msg.payload;
  //     if (aspect === 'stateChanged') {
  //       const { name, key, value: newVal } = value;
  //       // React to the change...
  //     }
  //   }
  //
  // The event payload shape is:
  //   { aspect: 'stateChanged', value: { name: string, key: string, value: any } }

### Send events to other objects

  await this.emit(targetId, 'myEvent', { data: 123 });

### Observe another object (receive its 'changed' events)

  await this.observe(ssId);
  // Now your 'changed' handler will receive events from that object

### Delete a key

  await call(ssId, 'delete', { name: 'my-state', key: 'count' });

### Remove an entire namespace (all keys, persistence, and subscribers)

  await call(ssId, 'removeNamespace', { name: 'my-state' });

### IMPORTANT
- State syncs automatically to connected peers via workspace-scoped discovery
- When a new peer connects, subscribed state is automatically synced
- Conflicts resolved by Last-Writer-Wins (highest timestamp, then highest peerId)
- Create the state instance on both peers before they connect
- Use persist: true on set() to survive restarts — only needs to be set once per key, then that key is always persisted
- Deleting a persisted key removes it from storage as well`;
  }
}
