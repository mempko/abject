/**
 * ObjectCatalog -- background service that maintains a continuously-fresh
 * snapshot of all ObjectRegistration entries across every registry source
 * (system, local workspaces, remote workspaces).
 *
 * Consumers (ObjectBrowser, AppExplorer, agents) read the in-memory cache
 * via getSnapshot/getSourcesSnapshot/getObjectsForSource -- zero network I/O.
 * The catalog refreshes independently on two timers (local 15 s, remote 45 s)
 * and pushes `catalogUpdated` / `sourcesChanged` events to dependents.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, ensure, invariant } from '../core/contracts.js';
import { request as createRequest } from '../core/message.js';
import { Log } from '../core/timed-log.js';

import type { DiscoveredWorkspace } from './workspace-share-registry.js';

const log = new Log('ObjectCatalog');

const OBJECT_CATALOG_INTERFACE: InterfaceId = 'abjects:object-catalog' as InterfaceId;
export const OBJECT_CATALOG_ID = 'abjects:object-catalog' as AbjectId;

const LOCAL_REFRESH_MS = 15_000;
const REMOTE_REFRESH_MS = 45_000;
const REMOTE_TIMEOUT_MS = 8_000;
const LOCAL_TIMEOUT_MS = 30_000;
const DEBOUNCE_MS = 500;

// ── Data Model ─────────────────────────────────────────────────────

export interface CatalogRegistrySource {
  id: AbjectId;
  label: string;
  kind: 'system' | 'local-workspace' | 'remote-workspace';
  workspaceId?: string;
  peerId?: string;
  isRemote: boolean;
}

export interface CatalogSnapshot {
  sources: Array<[string, CatalogRegistrySource]>;
  objects: Array<[string, ObjectRegistration[]]>;
}

// ── ObjectCatalog Abject ───────────────────────────────────────────

export class ObjectCatalog extends Abject {
  // ── Dependencies (lazily discovered) ──
  private workspaceManagerId?: AbjectId;
  private shareRegistryId?: AbjectId;
  private systemRegistryId?: AbjectId;

  // ── Cached catalog state ──
  private registrySources: Map<string, CatalogRegistrySource> = new Map();
  private registryObjects: Map<string, ObjectRegistration[]> = new Map();
  private lastRefreshedAt: Map<string, number> = new Map();

  // ── Timers ──
  private localRefreshTimer?: ReturnType<typeof setInterval>;
  private remoteRefreshTimer?: ReturnType<typeof setInterval>;
  private debouncedLocalTimer?: ReturnType<typeof setTimeout>;
  private localRefreshInProgress = false;
  private remoteRefreshInProgress = false;

  constructor() {
    super({
      manifest: {
        name: 'ObjectCatalog',
        description:
          'Background service maintaining a live cache of all ObjectRegistration entries ' +
          'across system, local-workspace, and remote-workspace registries. ' +
          'Consumers read the cache instantly with zero network I/O.',
        version: '1.0.0',
        interface: {
          id: OBJECT_CATALOG_INTERFACE as string,
          name: 'ObjectCatalog',
          description: 'Cached catalog of all known objects across all registries',
          methods: [
            {
              name: 'getSnapshot',
              description: 'Returns the full catalog snapshot from memory. Zero network I/O.',
              parameters: [],
              returns: { kind: 'reference', reference: 'CatalogSnapshot' },
            },
            {
              name: 'getSourcesSnapshot',
              description: 'Returns just the list of registry sources.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'CatalogRegistrySource' } },
            },
            {
              name: 'getObjectsForSource',
              description: 'Returns cached ObjectRegistration[] for a single source key.',
              parameters: [
                {
                  name: 'key',
                  type: { kind: 'primitive', primitive: 'string' },
                  description: 'The registry source key (e.g. "system", "ws:<id>", "remote:<peer>/<ws>")',
                },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ObjectRegistration' } },
            },
            {
              name: 'forceRefresh',
              description: 'Triggers an immediate background refresh cycle. Returns immediately.',
              parameters: [
                {
                  name: 'filter',
                  type: { kind: 'primitive', primitive: 'string' },
                  description: 'Optional: "local" or "remote" to refresh only one tier',
                  optional: true,
                },
              ],
              returns: { kind: 'primitive', primitive: 'undefined' },
            },
          ],
          events: [
            {
              name: 'catalogUpdated',
              description: 'Fires when cached object data changes. Payload includes updated source keys.',
              payload: { kind: 'reference', reference: 'CatalogUpdateEvent' },
            },
            {
              name: 'sourcesChanged',
              description: 'Fires when the set of registry sources changes (workspace created/deleted/discovered).',
              payload: { kind: 'primitive', primitive: 'undefined' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'core'],
      },
    });
    this.setupHandlers();
  }

  // ── Invariants ───────────────────────────────────────────────────

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.registrySources instanceof Map, 'registrySources must be a Map');
    invariant(this.registryObjects instanceof Map, 'registryObjects must be a Map');
  }

  // ── Ask protocol ─────────────────────────────────────────────────

  protected override getSourceForAsk(): string | undefined {
    const metaMethods = new Set([
      'describe', 'ask', 'getRegistry', 'ping',
      'addDependent', 'removeDependent',
      'getSource', 'updateSource', 'probe',
    ]);

    let source = `## ObjectCatalog Usage Guide

### Purpose
ObjectCatalog is a background service that maintains a live, continuously-refreshed cache
of all ObjectRegistration entries across every registry in the system: the system registry,
all local workspace registries, and all discovered remote workspace registries.

Consumers read the cache instantly (zero network I/O). The catalog refreshes independently:
local registries every ${LOCAL_REFRESH_MS / 1000}s, remote registries every ${REMOTE_REFRESH_MS / 1000}s.

### Methods
- \`getSnapshot()\` -- Returns the full catalog: all sources and all cached objects. Instant.
- \`getSourcesSnapshot()\` -- Returns just the list of registry sources with their labels and kinds.
- \`getObjectsForSource({ key })\` -- Returns cached objects for one source key.
- \`forceRefresh({ filter? })\` -- Triggers an immediate background refresh ("local", "remote", or both). Returns immediately; fires \`catalogUpdated\` when done.

### Events
- \`catalogUpdated\` -- Fires when any cached object data changes.
- \`sourcesChanged\` -- Fires when the set of registry sources changes.

### Interface ID
\`abjects:object-catalog\`

## Cataloged Objects

`;

    for (const [sourceKey, source_] of this.registrySources) {
      const objects = this.registryObjects.get(sourceKey) ?? [];
      if (objects.length === 0) continue;
      source += `### ${source_.label} (${source_.kind})\n`;
      for (const reg of objects) {
        const m = reg.manifest;
        const methods = m.interface.methods
          .filter(method => !metaMethods.has(method.name))
          .map(method => method.name)
          .join(', ');
        source += `- **${reg.name ?? m.name}**: ${m.description}`;
        if (methods) source += ` Methods: ${methods}`;
        source += '\n';
      }
      source += '\n';
    }

    return source;
  }

  // ── Handlers ─────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('getSnapshot', async () => {
      return this.getSnapshotImpl();
    });

    this.on('getSourcesSnapshot', async () => {
      return this.getSourcesSnapshotImpl();
    });

    this.on('getObjectsForSource', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      precondition(typeof key === 'string', 'key must be a string');
      return this.registryObjects.get(key) ?? [];
    });

    this.on('forceRefresh', async (msg: AbjectMessage) => {
      const { filter } = msg.payload as { filter?: 'local' | 'remote' };
      this.triggerRefresh(filter);
      return true;
    });

    // React to workspace lifecycle events
    this.on('workspaceCreated', async () => { this.scheduleLocalRefresh(); });
    this.on('workspaceDeleted', async () => { this.scheduleLocalRefresh(); });
    this.on('workspacesDiscovered', async () => { this.scheduleLocalRefresh(); });

    // React to registry update notifications
    this.on('objectRegistered', async () => { this.scheduleLocalRefresh(); });
    this.on('objectUnregistered', async () => { this.scheduleLocalRefresh(); });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    await super.onInit();

    // Initial local population (non-blocking)
    this.refreshLocal().catch((e) => log.warn('initial local refresh failed:', e));

    // Stagger remote discovery
    setTimeout(() => {
      this.refreshRemote().catch((e) => log.warn('initial remote refresh failed:', e));
    }, 5000);

    // Independent timers
    this.localRefreshTimer = setInterval(() => {
      this.refreshLocal().catch((e) => log.warn('local refresh failed:', e));
    }, LOCAL_REFRESH_MS);

    this.remoteRefreshTimer = setInterval(() => {
      this.refreshRemote().catch((e) => log.warn('remote refresh failed:', e));
    }, REMOTE_REFRESH_MS);
  }

  protected override async onStop(): Promise<void> {
    if (this.localRefreshTimer) clearInterval(this.localRefreshTimer);
    if (this.remoteRefreshTimer) clearInterval(this.remoteRefreshTimer);
    if (this.debouncedLocalTimer) clearTimeout(this.debouncedLocalTimer);
    this.localRefreshTimer = undefined;
    this.remoteRefreshTimer = undefined;
    this.debouncedLocalTimer = undefined;
    await super.onStop();
  }

  // ── Snapshot accessors (pure reads, zero I/O) ────────────────────

  private getSnapshotImpl(): CatalogSnapshot {
    const result: CatalogSnapshot = {
      sources: Array.from(this.registrySources.entries()),
      objects: Array.from(this.registryObjects.entries()),
    };
    ensure(result.sources != null && result.objects != null, 'snapshot must have sources and objects');
    return result;
  }

  private getSourcesSnapshotImpl(): Array<[string, CatalogRegistrySource]> {
    return Array.from(this.registrySources.entries());
  }

  // ── Refresh triggers ─────────────────────────────────────────────

  private triggerRefresh(filter?: 'local' | 'remote'): void {
    if (!filter || filter === 'local') {
      this.refreshLocal().catch((e) => log.warn('forced local refresh failed:', e));
    }
    if (!filter || filter === 'remote') {
      this.refreshRemote().catch((e) => log.warn('forced remote refresh failed:', e));
    }
  }

  /** Debounced local refresh -- coalesces rapid events (e.g. multiple objectRegistered). */
  private scheduleLocalRefresh(): void {
    if (this.debouncedLocalTimer) clearTimeout(this.debouncedLocalTimer);
    this.debouncedLocalTimer = setTimeout(() => {
      this.debouncedLocalTimer = undefined;
      this.refreshLocal().catch((e) => log.warn('scheduled local refresh failed:', e));
    }, DEBOUNCE_MS);
  }

  // ── Local refresh ────────────────────────────────────────────────

  private async refreshLocal(): Promise<void> {
    if (this.localRefreshInProgress) return;
    this.localRefreshInProgress = true;
    try {
      const sourcesChanged = await this.discoverSources();
      const updatedKeys = await this.fetchRegistryObjects('local');

      if (sourcesChanged) {
        this.changed('sourcesChanged', undefined);
      }
      if (updatedKeys.length > 0 || sourcesChanged) {
        this.changed('catalogUpdated', { updatedKeys });
      }
    } finally {
      this.localRefreshInProgress = false;
    }
  }

  // ── Remote refresh ───────────────────────────────────────────────

  private async refreshRemote(): Promise<void> {
    if (this.remoteRefreshInProgress) return;
    this.remoteRefreshInProgress = true;
    try {
      // Re-discover sources first (picks up newly discovered remote workspaces)
      const sourcesChanged = await this.discoverSources();
      const updatedKeys = await this.fetchRegistryObjects('remote');

      if (sourcesChanged) {
        this.changed('sourcesChanged', undefined);
      }
      if (updatedKeys.length > 0 || sourcesChanged) {
        this.changed('catalogUpdated', { updatedKeys });
      }
    } finally {
      this.remoteRefreshInProgress = false;
    }
  }

  // ── Source discovery ──────────────────────────────────────────────

  /** Discover all registry sources. Returns true if the source set changed. */
  private async discoverSources(): Promise<boolean> {
    // Lazy-discover dependencies
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
    }
    if (!this.shareRegistryId) {
      this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }
    if (!this.systemRegistryId) {
      this.systemRegistryId = await this.discoverDep('Registry') ?? undefined;
    }

    const oldKeys = new Set(this.registrySources.keys());
    const newKeys = new Set<string>();

    // System registry
    if (this.systemRegistryId) {
      const key = 'system';
      this.registrySources.set(key, {
        id: this.systemRegistryId,
        label: 'System',
        kind: 'system',
        isRemote: false,
      });
      newKeys.add(key);
      oldKeys.delete(key);
    }

    // Local workspaces via WorkspaceManager
    if (this.workspaceManagerId) {
      try {
        const detailed = await this.request<Array<{
          workspaceId: string;
          name: string;
          registryId: AbjectId;
        }>>(createRequest(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {}));

        for (const ws of detailed) {
          const key = `ws:${ws.workspaceId}`;
          this.registrySources.set(key, {
            id: ws.registryId,
            label: ws.name,
            kind: 'local-workspace',
            workspaceId: ws.workspaceId,
            isRemote: false,
          });
          newKeys.add(key);
          oldKeys.delete(key);

          // Subscribe to each workspace registry for live updates
          try {
            await this.request(createRequest(this.id, ws.registryId, 'subscribe', {}));
          } catch { /* may not support subscribe */ }
        }
      } catch {
        log.warn('Failed to list workspaces');
      }
    }

    // Remote workspaces via WorkspaceShareRegistry
    if (this.shareRegistryId) {
      try {
        const discovered = await this.request<DiscoveredWorkspace[]>(
          createRequest(this.id, this.shareRegistryId, 'getDiscoveredWorkspaces', {})
        );

        for (const dw of discovered) {
          if (!dw.registryId) continue;
          const key = `remote:${dw.ownerPeerId}/${dw.workspaceId}`;
          const ownerLabel = dw.ownerName || dw.ownerPeerId.slice(0, 8);
          this.registrySources.set(key, {
            id: dw.registryId as AbjectId,
            label: `${ownerLabel} / ${dw.name}`,
            kind: 'remote-workspace',
            workspaceId: dw.workspaceId,
            peerId: dw.ownerPeerId,
            isRemote: true,
          });
          newKeys.add(key);
          oldKeys.delete(key);
        }
      } catch {
        log.warn('Failed to get discovered workspaces');
      }
    }

    // Clean up stale entries
    let changed = false;
    for (const staleKey of oldKeys) {
      if (staleKey === 'system') continue;
      this.registrySources.delete(staleKey);
      this.registryObjects.delete(staleKey);
      this.lastRefreshedAt.delete(staleKey);
      changed = true;
    }

    // Check if any new sources appeared
    for (const key of newKeys) {
      if (!oldKeys.has(key) && !this.lastRefreshedAt.has(key)) {
        changed = true;
      }
    }

    this.checkInvariants();
    return changed;
  }

  // ── Registry object fetching ──────────────────────────────────────

  /** Fetch objects from registries matching the filter. Returns keys that were updated. */
  private async fetchRegistryObjects(filter: 'local' | 'remote'): Promise<string[]> {
    const entries = [...this.registrySources.entries()]
      .filter(([, source]) => {
        if (filter === 'local') return !source.isRemote;
        if (filter === 'remote') return source.isRemote;
        return true;
      });

    const results = await Promise.allSettled(
      entries.map(async ([key, source]) => {
        const timeoutMs = source.isRemote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
        const objects = await this.request<ObjectRegistration[]>(
          createRequest(this.id, source.id, 'list', {}),
          timeoutMs,
        );
        return { key, objects };
      })
    );

    const updatedKeys: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.registryObjects.set(result.value.key, result.value.objects);
        this.lastRefreshedAt.set(result.value.key, Date.now());
        updatedKeys.push(result.value.key);
      }
    }

    this.checkInvariants();
    return updatedKeys;
  }
}
