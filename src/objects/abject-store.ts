/**
 * AbjectStore - persists user-created scriptable abject snapshots to Storage
 * and restores them on startup.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';

const ABJECT_STORE_INTERFACE = 'abjects:abject-store' as InterfaceId;

const STORAGE_KEY = 'abject-store:snapshots';

export interface AbjectSnapshot {
  objectId: string;
  manifest: AbjectManifest;
  source: string;
  owner: string;
  savedAt: number;
}

export interface RestoreResult {
  restored: number;
  failed: number;
  errors: string[];
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
      const { objectId, manifest, source, owner } = msg.payload as {
        objectId: string;
        manifest: AbjectManifest;
        source: string;
        owner: string;
      };
      return this.saveSnapshot(objectId, manifest, source, owner);
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
        console.log(`[ABJECT-STORE] Loaded ${this.snapshots.size} snapshots from storage`);
      }
    } catch (err) {
      console.warn('[ABJECT-STORE] Failed to load from storage:', err);
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
      console.warn('[ABJECT-STORE] Failed to persist to storage:', err);
    }
  }

  /**
   * Save (upsert) a snapshot.
   */
  async saveSnapshot(
    objectId: string,
    manifest: AbjectManifest,
    source: string,
    owner: string
  ): Promise<boolean> {
    precondition(objectId !== '', 'objectId must not be empty');
    precondition(source !== '', 'source must not be empty');

    const snapshot: AbjectSnapshot = {
      objectId,
      manifest,
      source,
      owner,
      savedAt: Date.now(),
    };

    this.snapshots.set(objectId, snapshot);
    await this.persistToStorage();

    // Register the object in the workspace registry so it appears in RegistryBrowser/Taskbar
    if (this.registryId) {
      try {
        await this.request(request(this.id, this.registryId,
          'register', {
            objectId, manifest, owner, source,
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

    console.log(`[ABJECT-STORE] Saved snapshot for '${manifest.name}' (${objectId})`);
    return true;
  }

  /**
   * Remove a snapshot by objectId.
   */
  async removeSnapshot(objectId: string): Promise<boolean> {
    const existed = this.snapshots.delete(objectId);
    if (existed) {
      await this.persistToStorage();
      console.log(`[ABJECT-STORE] Removed snapshot for ${objectId}`);
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
      console.log('[ABJECT-STORE] No snapshots to restore');
      return result;
    }

    console.log(`[ABJECT-STORE] Restoring ${snapshotList.length} abjects...`);

    // Discover our workspace now (after WorkspaceManager has tagged us)
    const wsId = await this.ensureWorkspaceId();

    // Clear old snapshots — we'll rebuild with new IDs
    this.snapshots.clear();

    for (const snap of snapshotList) {
      try {
        const spawnResult = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, 'spawn', {
            manifest: snap.manifest,
            source: snap.source,
            owner: snap.owner,
            parentId: this.id,
            registryHint: this.registryId,
          })
        );

        if (spawnResult.objectId) {
          // Store with new ID
          this.snapshots.set(spawnResult.objectId as string, {
            ...snap,
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
          console.log(`[ABJECT-STORE] Restored '${snap.manifest.name}' as ${spawnResult.objectId}`);
        }
      } catch (err) {
        result.failed++;
        const errMsg = `Failed to restore '${snap.manifest.name}': ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(errMsg);
        console.warn(`[ABJECT-STORE] ${errMsg}`);

        // Keep the old snapshot so the user can debug via list()
        this.snapshots.set(snap.objectId, snap);
      }
    }

    // Persist updated snapshots (with new IDs for restored ones)
    await this.persistToStorage();

    console.log(`[ABJECT-STORE] Restore complete: ${result.restored} restored, ${result.failed} failed`);
    return result;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.snapshots.size >= 0, 'snapshot count must be non-negative');
  }

  protected override getSourceForAsk(): string | undefined {
    return `## AbjectStore Usage Guide

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
