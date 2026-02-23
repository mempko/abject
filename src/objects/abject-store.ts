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
const STORAGE_INTERFACE = 'abjects:storage' as InterfaceId;
const FACTORY_INTERFACE = 'abjects:factory' as InterfaceId;

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
  private snapshots: Map<string, AbjectSnapshot> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'AbjectStore',
        description:
          'Persists user-created scriptable abject snapshots to Storage and restores them on startup.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
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

    // Load existing snapshots from Storage
    await this.loadFromStorage();
  }

  /**
   * Load snapshots from Storage into the in-memory map.
   */
  private async loadFromStorage(): Promise<void> {
    try {
      const stored = await this.request<AbjectSnapshot[] | null>(
        request(this.id, this.storageId!, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY })
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
        request(this.id, this.storageId!, STORAGE_INTERFACE, 'set', {
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

    // Clear old snapshots — we'll rebuild with new IDs
    this.snapshots.clear();

    for (const snap of snapshotList) {
      try {
        const spawnResult = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, FACTORY_INTERFACE, 'spawn', {
            manifest: snap.manifest,
            source: snap.source,
            owner: snap.owner,
            parentId: this.id,
          })
        );

        if (spawnResult.objectId) {
          // Store with new ID
          this.snapshots.set(spawnResult.objectId as string, {
            ...snap,
            objectId: spawnResult.objectId as string,
            savedAt: Date.now(),
          });
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
}

// Well-known AbjectStore ID
export const ABJECT_STORE_ID = 'abjects:abject-store' as AbjectId;
