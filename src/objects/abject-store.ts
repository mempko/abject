/**
 * AbjectStore - persists user-created scriptable abject snapshots to Storage
 * and restores them on startup.
 */

import {
  AbjectId,
  TypeId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ABJECT-STORE');

const ABJECT_STORE_INTERFACE = 'abjects:abject-store' as InterfaceId;

const STORAGE_KEY = 'abject-store:snapshots';

/**
 * One prior source of an object. Only the source is versioned — manifests
 * rarely change and the current one still parses old sources; `data` is
 * live state, not code, and belongs to exactly one point in time.
 */
export interface AbjectVersion {
  source: string;
  savedAt: number;
}

export interface AbjectSnapshot {
  typeId: string;
  objectId: string;
  manifest: AbjectManifest;
  source: string;
  owner: string;
  savedAt: number;
  data?: Record<string, unknown>;
  /**
   * Prior sources, newest first, pushed only when a save actually CHANGES
   * the source (data-only persistence never creates a version). Bounded at
   * MAX_VERSIONS — old enough history ages out. This is the undo path for
   * "an agent rewrote my object and ruined it".
   */
  versions?: AbjectVersion[];
}

export interface RestoreResult {
  restored: number;
  failed: number;
  errors: string[];
}

/**
 * A manifest is well-formed only if it is a structured object with a non-empty
 * name and an interface carrying a methods array. The known corruption mode is
 * free-form text (an LLM saving a markdown description into the `manifest`
 * field), which leaves name/interface undefined and crashes the
 * ScriptableAbject constructor ("reading 'methods'").
 */
function isValidManifest(m: unknown): m is AbjectManifest {
  if (!m || typeof m !== 'object') return false;
  const manifest = m as Partial<AbjectManifest>;
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return false;
  const iface = manifest.interface as { methods?: unknown } | undefined;
  if (!iface || typeof iface !== 'object' || !Array.isArray(iface.methods)) return false;
  return true;
}

/** A snapshot is restorable only if its manifest is well-formed. */
function isRestorableSnapshot(snap: AbjectSnapshot): boolean {
  return isValidManifest(snap?.manifest);
}

/**
 * Persists and restores user-created scriptable abjects.
 */
export class AbjectStore extends Abject {
  private storageId?: AbjectId;
  private factoryId?: AbjectId;
  private registryId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private workspaceId?: string;
  private peerId?: string;
  private snapshots: Map<string, AbjectSnapshot> = new Map();

  /** Prior sources kept per object; older history ages out. */
  private static readonly MAX_VERSIONS = 10;

  // Debounced Storage write state (see schedulePersist).
  private static readonly PERSIST_DEBOUNCE_MS = 500;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistInFlight?: Promise<void>;
  private persistDirty = false;

  constructor() {
    super({
      manifest: {
        name: 'AbjectStore',
        description:
          'Persists user-created scriptable abject snapshots to Storage and restores them on startup.',
        version: '1.0.0',
        interface: {
            id: ABJECT_STORE_INTERFACE,
            name: 'AbjectStore',
            description: 'Abject persistence and restoration',
            methods: [
              {
                name: 'save',
                description: 'Save a snapshot of a scriptable abject',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to save',
                  },
                  {
                    name: 'manifest',
                    type: { kind: 'reference', reference: 'AbjectManifest' },
                    description: 'The object manifest',
                  },
                  {
                    name: 'source',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Handler source code',
                  },
                  {
                    name: 'owner',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Owner object ID',
                  },
                  {
                    name: 'data',
                    type: { kind: 'object', properties: {} },
                    description: 'Optional internal data record (this.data) to persist with the snapshot',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'remove',
                description: 'Remove a saved snapshot',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the object to remove',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'list',
                description: 'List all saved snapshots',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'AbjectSnapshot' },
                },
              },
              {
                name: 'restoreAll',
                description: 'Restore all saved abjects by spawning them via Factory',
                parameters: [],
                returns: { kind: 'reference', reference: 'RestoreResult' },
              },
              {
                name: 'listVersions',
                description: 'List an object\'s saved source versions (newest first). Every source-changing save keeps the prior source, bounded at 10. Returns { name, typeId, objectId, current: { savedAt, sizeChars }, versions: [{ index, savedAt, sizeChars }] }, or null when the object has no snapshot. Accepts a live objectId, durable typeId, or object name.',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Live objectId, typeId, or object name' },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'getVersion',
                description: 'Fetch one prior version\'s full source. Returns { source, savedAt }.',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Live objectId, typeId, or object name' },
                  { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Version index from listVersions (0 = most recent prior version)' },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'restoreVersion',
                description: 'Make a prior version the live source: applies it to the running object (updateSource), updates the snapshot and registry, and pushes the replaced source onto the version ring so the restore is itself undoable. Returns { success, error? }.',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Live objectId, typeId, or object name' },
                  { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Version index from listVersions' },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'deleteVersion',
                description: 'Permanently remove one prior version from an object\'s history (frees its ring slot; the live source is untouched). Returns { success, error? }.',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Live objectId, typeId, or object name' },
                  { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Version index from listVersions' },
                ],
                returns: { kind: 'object', properties: {} },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'persistence'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('save', async (msg: AbjectMessage) => {
      const { objectId, manifest, source, owner, data } = msg.payload as {
        objectId: string;
        manifest: AbjectManifest;
        source: string;
        owner: string;
        data?: Record<string, unknown>;
      };
      return this.saveSnapshot(objectId, manifest, source, owner, data);
    });

    this.on('remove', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.removeSnapshot(objectId);
    });

    this.on('list', async () => {
      return Array.from(this.snapshots.values());
    });

    this.on('restoreAll', async () => {
      return this.restoreAll();
    });

    this.on('listVersions', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      const snap = this.findSnapshot(objectId);
      if (!snap) return null;
      return {
        name: snap.manifest.name,
        typeId: snap.typeId,
        objectId: snap.objectId,
        current: { savedAt: snap.savedAt, sizeChars: snap.source.length },
        versions: (snap.versions ?? []).map((v, index) => ({
          index,
          savedAt: v.savedAt,
          sizeChars: v.source.length,
        })),
      };
    });

    this.on('getVersion', async (msg: AbjectMessage) => {
      const { objectId, index } = msg.payload as { objectId: string; index: number };
      const snap = this.findSnapshot(objectId);
      precondition(snap !== undefined, `No snapshot found for '${objectId}'`);
      const versions = snap!.versions ?? [];
      precondition(
        Number.isInteger(index) && index >= 0 && index < versions.length,
        `Version index ${index} out of range (object has ${versions.length} prior versions)`,
      );
      const v = versions[index];
      return { source: v.source, savedAt: v.savedAt };
    });

    this.on('restoreVersion', async (msg: AbjectMessage) => {
      const { objectId, index } = msg.payload as { objectId: string; index: number };
      return this.restoreVersion(objectId, index);
    });

    this.on('deleteVersion', async (msg: AbjectMessage) => {
      const { objectId, index } = msg.payload as { objectId: string; index: number };
      const snap = this.findSnapshot(objectId);
      if (!snap) return { success: false, error: `No snapshot found for '${objectId}'` };
      const versions = snap.versions ?? [];
      if (!Number.isInteger(index) || index < 0 || index >= versions.length) {
        return { success: false, error: `Version index ${index} out of range (object has ${versions.length} prior versions)` };
      }
      const removed = versions.splice(index, 1)[0];
      if (versions.length === 0) delete snap.versions;
      this.schedulePersist();
      log.info(`Deleted version of '${snap.manifest.name}' from ${new Date(removed.savedAt).toISOString()} (${removed.source.length} chars, ${versions.length} remain)`);
      this.changed('versionDeleted', { typeId: snap.typeId, objectId: snap.objectId, deletedSavedAt: removed.savedAt });
      return { success: true };
    });
  }

  /**
   * Resolve a snapshot by typeId key, live objectId, or manifest name —
   * callers usually hold the live objectId, which changes across restarts,
   * while the snapshot map is keyed by durable typeId.
   */
  private findSnapshot(ref: string): AbjectSnapshot | undefined {
    const direct = this.snapshots.get(ref);
    if (direct) return direct;
    for (const snap of this.snapshots.values()) {
      if (snap.objectId === ref || snap.manifest.name === ref) return snap;
    }
    return undefined;
  }

  /**
   * Make a prior version the live source: the current source is pushed onto
   * the ring first (a restore is itself undoable), the snapshot updates, the
   * running object gets `updateSource`, and the registry syncs. The version
   * ring keeps its restored entry — restoring is a copy, not a move.
   */
  private async restoreVersion(ref: string, index: number): Promise<{ success: boolean; error?: string }> {
    const snap = this.findSnapshot(ref);
    if (!snap) return { success: false, error: `No snapshot found for '${ref}'` };
    const versions = snap.versions ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= versions.length) {
      return { success: false, error: `Version index ${index} out of range (object has ${versions.length} prior versions)` };
    }
    const chosen = versions[index];

    // Apply to the live object first — if the old source no longer compiles
    // against today's runtime, fail without touching the snapshot.
    try {
      const result = await this.request<{ success: boolean; error?: string }>(
        request(this.id, snap.objectId as AbjectId, 'updateSource', { source: chosen.source })
      );
      if (result && result.success === false) {
        return { success: false, error: result.error ?? 'updateSource failed' };
      }
    } catch (err) {
      return { success: false, error: `Live object rejected the version: ${err instanceof Error ? err.message : String(err)}` };
    }

    const newVersions = [
      { source: snap.source, savedAt: snap.savedAt },
      ...versions,
    ].slice(0, AbjectStore.MAX_VERSIONS);
    snap.source = chosen.source;
    snap.savedAt = Date.now();
    snap.versions = newVersions;
    this.schedulePersist();

    if (this.registryId) {
      try {
        await this.request(request(this.id, this.registryId, 'updateSource', {
          objectId: snap.objectId, source: chosen.source,
        }));
      } catch { /* registry sync is best effort */ }
    }

    log.info(`Restored '${snap.manifest.name}' to version from ${new Date(chosen.savedAt).toISOString()} (${chosen.source.length} chars)`);
    this.changed('versionRestored', { typeId: snap.typeId, objectId: snap.objectId, restoredSavedAt: chosen.savedAt });
    return { success: true };
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.requireDep('Storage');
    this.factoryId = await this.requireDep('Factory');

    // Discover workspace Registry so we can register user objects in it
    this.registryId = await this.discoverDep('Registry') ?? undefined;

    // Discover WidgetManager so we can tag spawned objects with our workspace
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;

    // Load existing snapshots from Storage
    await this.loadFromStorage();
  }

  protected override async onStop(): Promise<void> {
    await super.onStop();
    // Flush a pending debounced write so no snapshot changes are lost at
    // shutdown. Status is already 'stopped' so request() would refuse — post
    // the write as a fire-and-forget event straight to the bus.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.persistDirty && this.storageId) {
      this.persistDirty = false;
      try {
        this.bus.send(event(this.id, this.storageId, 'set', {
          key: STORAGE_KEY,
          value: Array.from(this.snapshots.values()),
        }));
      } catch { /* best effort at shutdown */ }
    }
  }

  /**
   * Lazily discover our workspace ID from WidgetManager.
   * Called at use-time (not init-time) because WorkspaceManager assigns
   * our workspace after our init completes.
   */
  private async ensureWorkspaceId(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    if (!this.widgetManagerId) return undefined;
    try {
      const ws = await this.request<string | null>(
        request(this.id, this.widgetManagerId, 'getObjectWorkspace', {
          objectId: this.id,
        })
      );
      this.workspaceId = ws ?? undefined;
    } catch {
      // WidgetManager may not be ready
    }
    return this.workspaceId;
  }

  /**
   * Load snapshots from Storage into the in-memory map.
   */
  private async loadFromStorage(): Promise<void> {
    try {
      const stored = await this.request<AbjectSnapshot[] | null>(
        request(this.id, this.storageId!, 'get', { key: STORAGE_KEY })
      );
      if (Array.isArray(stored)) {
        for (const snap of stored) {
          this.snapshots.set(snap.objectId, snap);
        }
        log.info(`Loaded ${this.snapshots.size} snapshots from storage`);
      }
    } catch (err) {
      log.warn('Failed to load from storage:', err);
    }
  }

  /**
   * Persist the current snapshots map to Storage.
   */
  private async persistToStorage(): Promise<void> {
    try {
      await this.request(
        request(this.id, this.storageId!, 'set', {
          key: STORAGE_KEY,
          value: Array.from(this.snapshots.values()),
        })
      );
    } catch (err) {
      log.warn('Failed to persist to storage:', err);
    }
  }

  /**
   * Debounced full-store write. Every save/remove rewrites the whole
   * snapshot array (every user object's source + data), so back-to-back
   * saves — e.g. several objects persisting within the same second — must
   * coalesce into one Storage round trip instead of one each.
   */
  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flushPersist();
    }, AbjectStore.PERSIST_DEBOUNCE_MS);
  }

  private async flushPersist(): Promise<void> {
    if (this.persistInFlight) await this.persistInFlight;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    this.persistInFlight = this.persistToStorage();
    try {
      await this.persistInFlight;
    } finally {
      this.persistInFlight = undefined;
    }
  }

  /**
   * Save (upsert) a snapshot.
   */
  /**
   * Compute a scoped TypeId for a user-created object.
   */
  private computeTypeId(manifestName: string): TypeId | undefined {
    const wsId = this.workspaceId;
    if (!this.peerId || !wsId) return undefined;
    return `${this.peerId}/${wsId}/user/${manifestName}` as TypeId;
  }

  async saveSnapshot(
    objectId: string,
    manifest: AbjectManifest,
    source: string,
    owner: string,
    data?: Record<string, unknown>,
  ): Promise<boolean> {
    precondition(objectId !== '', 'objectId must not be empty');
    precondition(source !== '', 'source must not be empty');
    precondition(
      isValidManifest(manifest),
      'manifest must be a structured AbjectManifest with a non-empty name and interface.methods (refusing to persist free-form text)',
    );

    // Discover peerId lazily if not yet known
    if (!this.peerId) {
      try {
        const identityId = await this.discoverDep('Identity');
        if (identityId) {
          const identity = await this.request<{ peerId: string }>(
            request(this.id, identityId, 'getIdentity', {})
          );
          this.peerId = identity.peerId;
        }
      } catch { /* Identity may not be available */ }
    }

    // Resolve the workspace BEFORE computing the snapshot key. Saves that
    // arrive before WorkspaceManager tags us used to fall back to the bare
    // objectId key, and the next save (workspace now known) would start a
    // fresh typeId-keyed entry — a stale duplicate that shadowed the real
    // snapshot in lookups and orphaned its version history.
    const wsId = await this.ensureWorkspaceId();
    const typeId = this.computeTypeId(manifest.name) ?? objectId;

    // Preserve existing data if the caller didn't supply one (e.g. an
    // ObjectCreator-driven save after a source edit shouldn't wipe data).
    let existing = this.snapshots.get(typeId);
    if (!existing && typeId !== objectId) {
      // Adopt a legacy entry saved under the bare objectId before the
      // workspace was known, so its data and history carry forward.
      const legacy = this.snapshots.get(objectId);
      if (legacy) {
        existing = legacy;
        this.snapshots.delete(objectId);
      }
    }
    const finalData = data !== undefined ? data : existing?.data;

    // Version history: a save that CHANGES the source pushes the outgoing
    // source onto the ring first, so it stays restorable. Identical-source
    // saves (data persistence, re-registration) carry history through
    // untouched.
    let versions = existing?.versions;
    if (existing && existing.source !== source) {
      versions = [
        { source: existing.source, savedAt: existing.savedAt },
        ...(existing.versions ?? []),
      ].slice(0, AbjectStore.MAX_VERSIONS);
      log.info(`Source changed for '${manifest.name}' — kept prior version (${existing.source.length} chars, ${versions.length}/${AbjectStore.MAX_VERSIONS} kept)`);
    }

    const snapshot: AbjectSnapshot = {
      typeId,
      objectId,
      manifest,
      source,
      owner,
      savedAt: Date.now(),
      ...(finalData !== undefined ? { data: finalData } : {}),
      ...(versions && versions.length > 0 ? { versions } : {}),
    };

    // Key by typeId for durable identity (survives restart with new objectId)
    this.snapshots.set(typeId, snapshot);
    this.schedulePersist();

    // Register the object in the workspace registry so it appears in AppExplorer/Taskbar
    if (this.registryId) {
      try {
        await this.request(request(this.id, this.registryId,
          'register', {
            objectId, manifest, owner, source, typeId: typeId as TypeId,
            ...(finalData !== undefined ? { data: finalData } : {}),
          }));
      } catch { /* best effort — registry may not be ready */ }
    }

    // Tag the newly-created object with our workspace
    if (this.widgetManagerId && wsId) {
      try {
        await this.request(
          request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
            objectId: objectId as AbjectId,
            workspaceId: wsId,
          })
        );
      } catch {
        // Best effort — WidgetManager may not be ready
      }
    }

    log.info(`Saved snapshot for '${manifest.name}' (${objectId})`);
    return true;
  }

  /**
   * Remove a snapshot by objectId.
   */
  async removeSnapshot(objectId: string): Promise<boolean> {
    // Try direct key (typeId) first, then search by objectId
    let existed = this.snapshots.delete(objectId);
    if (!existed) {
      for (const [key, snap] of this.snapshots) {
        if (snap.objectId === objectId) {
          this.snapshots.delete(key);
          existed = true;
          break;
        }
      }
    }
    if (existed) {
      this.schedulePersist();
      log.info(`Removed snapshot for ${objectId}`);
    }
    return existed;
  }

  /**
   * Restore all saved abjects by spawning them via Factory.
   * Objects get new IDs; snapshots are updated with the new IDs and re-persisted.
   */
  async restoreAll(): Promise<RestoreResult> {
    const result: RestoreResult = { restored: 0, failed: 0, errors: [] };
    const snapshotList = Array.from(this.snapshots.values());

    if (snapshotList.length === 0) {
      log.info('No snapshots to restore');
      return result;
    }

    log.info(`Restoring ${snapshotList.length} abjects...`);

    // Discover peerId lazily if not yet known
    if (!this.peerId) {
      try {
        const identityId = await this.discoverDep('Identity');
        if (identityId) {
          const identity = await this.request<{ peerId: string }>(
            request(this.id, identityId, 'getIdentity', {})
          );
          this.peerId = identity.peerId;
        }
      } catch { /* Identity may not be available */ }
    }

    // Discover our workspace now (after WorkspaceManager has tagged us)
    const wsId = await this.ensureWorkspaceId();

    // Clear old snapshots — we'll rebuild keyed by typeId
    this.snapshots.clear();

    for (const snap of snapshotList) {
      // Guard against corrupted snapshots whose manifest was persisted as
      // free-form text instead of a structured AbjectManifest (e.g. an LLM
      // saving a markdown description into the `manifest`/`source` fields). A
      // missing name or interface would crash the ScriptableAbject constructor
      // in the worker ("reading 'methods'"). Skip and drop them — they can
      // never spawn, so re-persisting without them purges the corruption.
      if (!isRestorableSnapshot(snap)) {
        result.failed++;
        const label = (snap.manifest as { name?: unknown } | undefined)?.name ?? snap.objectId;
        const errMsg = `Dropping unrestorable snapshot '${label}': manifest missing name or interface`;
        result.errors.push(errMsg);
        log.warn(errMsg);
        continue;
      }

      try {
        // Compute typeId for restored object (use saved typeId or compute fresh)
        const typeId = snap.typeId || this.computeTypeId(snap.manifest.name) || snap.objectId;

        const spawnResult = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, 'spawn', {
            manifest: snap.manifest,
            source: snap.source,
            owner: snap.owner,
            parentId: this.id,
            registryHint: this.registryId,
            typeId: typeId as TypeId,
            ...(snap.data !== undefined ? { data: snap.data } : {}),
          })
        );

        if (spawnResult.objectId) {
          // Store keyed by typeId (durable identity)
          this.snapshots.set(typeId, {
            ...snap,
            typeId,
            objectId: spawnResult.objectId as string,
            savedAt: Date.now(),
          });

          // Tag the restored object with our workspace
          if (this.widgetManagerId && wsId) {
            try {
              await this.request(
                request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
                  objectId: spawnResult.objectId,
                  workspaceId: wsId,
                })
              );
            } catch {
              // Best effort
            }
          }

          result.restored++;
          log.info(`Restored '${snap.manifest.name}' as ${spawnResult.objectId}`);

          // Auto-start objects tagged 'autostart' or 'agent' so they can
          // re-register with their dependencies (e.g. AgentAbject) without
          // requiring the user to manually open them.
          const tags = snap.manifest.tags ?? [];
          if (tags.includes('autostart') || tags.includes('agent')) {
            try {
              await this.request(
                request(this.id, spawnResult.objectId, 'startup', {}),
                10000,
              );
              log.info(`Auto-started '${snap.manifest.name}'`);
            } catch {
              // Best effort — handler may not exist yet
            }
          }
        }
      } catch (err) {
        result.failed++;
        const errMsg = `Failed to restore '${snap.manifest.name}': ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(errMsg);
        log.warn(errMsg);

        // Keep the old snapshot so the user can debug via list()
        this.snapshots.set(snap.typeId || snap.objectId, snap);
      }
    }

    // Persist updated snapshots (with new IDs for restored ones)
    await this.persistToStorage();

    log.info(`Restore complete: ${result.restored} restored, ${result.failed} failed`);
    return result;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.snapshots.size >= 0, 'snapshot count must be non-negative');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AbjectStore Usage Guide

### Save an object snapshot

  await call(await dep('AbjectStore'), 'save', { objectId: 'the-object-id' });
  // Persists the object's manifest and source code for later restoration

### Remove a saved snapshot

  await call(await dep('AbjectStore'), 'remove', { objectId: 'the-object-id' });

### List all saved snapshots

  const snapshots = await call(await dep('AbjectStore'), 'list', {});
  // snapshots: [{ objectId, manifest, source, owner, savedAt }]

### Restore all saved objects

  const restored = await call(await dep('AbjectStore'), 'restoreAll', {});
  // restored: [{ originalId, newId, name }]
  // Note: restored objects get NEW IDs — the original IDs are not reused.

### Version history (undo a bad source edit)

  const info = await call(await dep('AbjectStore'), 'listVersions', { objectId });
  // info: { name, current: {savedAt, sizeChars}, versions: [{index, savedAt, sizeChars}] }
  const old = await call(await dep('AbjectStore'), 'getVersion', { objectId, index: 0 });
  const result = await call(await dep('AbjectStore'), 'restoreVersion', { objectId, index: 0 });
  // Applies the prior source to the LIVE object and persists it. The replaced
  // source is kept in the ring, so a restore can itself be undone.
  await call(await dep('AbjectStore'), 'deleteVersion', { objectId, index: 0 });
  // Permanently removes one prior version (live source untouched).

### IMPORTANT
- The interface ID is 'abjects:abject-store'.
- save() snapshots the current state — call it after the object is fully configured.
- restoreAll() is typically called at boot time to bring back user-created objects.`;
  }
}

// Well-known AbjectStore ID
export const ABJECT_STORE_ID = 'abjects:abject-store' as AbjectId;
