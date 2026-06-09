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
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ABJECT-STORE');

const ABJECT_STORE_INTERFACE = 'abjects:abject-store' as InterfaceId;

const STORAGE_KEY = 'abject-store:snapshots';

export interface AbjectSnapshot {
  typeId: string;
  objectId: string;
  manifest: AbjectManifest;
  source: string;
  owner: string;
  savedAt: number;
  data?: Record<string, unknown>;
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

    const typeId = this.computeTypeId(manifest.name) ?? objectId;

    // Preserve existing data if the caller didn't supply one (e.g. an
    // ObjectCreator-driven save after a source edit shouldn't wipe data).
    const existing = this.snapshots.get(typeId);
    const finalData = data !== undefined ? data : existing?.data;

    const snapshot: AbjectSnapshot = {
      typeId,
      objectId,
      manifest,
      source,
      owner,
      savedAt: Date.now(),
      ...(finalData !== undefined ? { data: finalData } : {}),
    };

    // Key by typeId for durable identity (survives restart with new objectId)
    this.snapshots.set(typeId, snapshot);
    await this.persistToStorage();

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
    const wsId = await this.ensureWorkspaceId();
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
      await this.persistToStorage();
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

### IMPORTANT
- The interface ID is 'abjects:abject-store'.
- save() snapshots the current state — call it after the object is fully configured.
- restoreAll() is typically called at boot time to bring back user-created objects.`;
  }
}

// Well-known AbjectStore ID
export const ABJECT_STORE_ID = 'abjects:abject-store' as AbjectId;
