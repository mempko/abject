/**
 * WorkspaceManager — orchestrates workspace lifecycle.
 *
 * Each workspace is an isolated collection of abjects with its own registry,
 * storage, taskbar, chat, settings, theme, and user-created objects.
 * A workspace switcher in the taskbar lets users move between them.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';

const WORKSPACE_MANAGER_INTERFACE = 'abjects:workspace-manager' as InterfaceId;
const STORAGE_INTERFACE = 'abjects:storage' as InterfaceId;
const REGISTRY_INTERFACE = 'abjects:registry' as InterfaceId;
const FACTORY_INTERFACE = 'abjects:factory' as InterfaceId;
const TASKBAR_INTERFACE = 'abjects:taskbar' as InterfaceId;
const WORKSPACE_REGISTRY_INTERFACE = 'abjects:workspace-registry' as InterfaceId;
const ABJECT_STORE_INTERFACE = 'abjects:abject-store' as InterfaceId;
const SUPERVISOR_INTERFACE = 'abjects:supervisor' as InterfaceId;
const UI_INTERFACE = 'abjects:ui' as InterfaceId;
const WIDGETS_INTERFACE = 'abjects:widgets' as InterfaceId;
const WINDOW_MANAGER_INTERFACE = 'abjects:window-manager' as InterfaceId;

const SETTINGS_INTERFACE = 'abjects:settings' as InterfaceId;
const CHAT_INTERFACE = 'abjects:chat' as InterfaceId;
const REGISTRY_BROWSER_INTERFACE = 'abjects:registry-browser' as InterfaceId;
const JOB_BROWSER_INTERFACE = 'abjects:job-browser' as InterfaceId;
const WORKSPACE_SWITCHER_INTERFACE = 'abjects:workspace-switcher' as InterfaceId;

const STORAGE_KEY_LIST = 'workspaces:list';
const STORAGE_KEY_ACTIVE = 'workspaces:active';

/** Per-workspace object names spawned by WorkspaceManager. */
/** Per-workspace objects in dependency order (matches original bootstrap). */
const PER_WORKSPACE_OBJECTS = [
  'AbjectStore', 'Theme', 'Settings', 'RegistryBrowser',
  'JobManager', 'JobBrowser', 'Chat', 'Taskbar',
] as const;

export interface WorkspaceInfo {
  id: string;
  name: string;
  childIds: AbjectId[];
  registryId: AbjectId;
  storageId: AbjectId;
  taskbarId: AbjectId;
  uiObjects: Array<{ id: AbjectId; iface: InterfaceId }>;
}

interface PersistedWorkspace {
  id: string;
  name: string;
  createdAt: number;
}

export class WorkspaceManager extends Abject {
  private workspaces: Map<string, WorkspaceInfo> = new Map();
  private activeWorkspaceId?: string;
  private globalStorageId?: AbjectId;
  private globalRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private supervisorId?: AbjectId;
  private workspaceSwitcherId?: AbjectId;
  private uiServerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowManagerId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceManager',
        description:
          'Manages workspace lifecycle: create, switch, delete, and persist workspaces. Each workspace is an isolated collection of abjects.',
        version: '1.0.0',
        interfaces: [
          {
            id: WORKSPACE_MANAGER_INTERFACE,
            name: 'WorkspaceManager',
            description: 'Workspace lifecycle management',
            methods: [
              {
                name: 'createWorkspace',
                description: 'Create a new workspace',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Workspace name',
                  },
                ],
                returns: { kind: 'object', properties: { workspaceId: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'deleteWorkspace',
                description: 'Delete a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace to delete',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'switchWorkspace',
                description: 'Switch to a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace to switch to',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listWorkspaces',
                description: 'List all workspaces',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'WorkspaceInfo' },
                },
              },
              {
                name: 'getActiveWorkspace',
                description: 'Get the active workspace',
                parameters: [],
                returns: { kind: 'object', properties: {
                  id: { kind: 'primitive', primitive: 'string' },
                  name: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'renameWorkspace',
                description: 'Rename a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace to rename',
                  },
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'New name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('createWorkspace', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.createWorkspace(name);
    });

    this.on('deleteWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.deleteWorkspace(workspaceId);
    });

    this.on('switchWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.switchWorkspace(workspaceId);
    });

    this.on('listWorkspaces', async () => {
      return this.listWorkspaces();
    });

    this.on('getActiveWorkspace', async () => {
      return this.getActiveWorkspace();
    });

    this.on('renameWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId, name } = msg.payload as { workspaceId: string; name: string };
      return this.renameWorkspace(workspaceId, name);
    });

    this.on('refreshTaskbar', async () => {
      return this.refreshTaskbar();
    });

    // Boot must be called after spawn completes (cannot spawn during onInit
    // because Factory is busy processing our own spawn request).
    this.on('boot', async () => {
      return this.boot();
    });
  }

  protected override async onInit(): Promise<void> {
    this.globalStorageId = await this.requireDep('Storage');
    this.globalRegistryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.supervisorId = await this.discoverDep('Supervisor') ?? undefined;
    this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;
  }

  /**
   * Boot workspaces — must be called after spawn completes.
   * This cannot run during onInit because Factory would deadlock.
   */
  private async boot(): Promise<boolean> {
    const persisted = await this.loadWorkspaceList();

    if (persisted.length === 0) {
      // First boot — create "Default" workspace and migrate existing data
      const { workspaceId } = await this.createWorkspace('Default');
      await this.migrateExistingData(workspaceId);
      await this.switchWorkspace(workspaceId);
    } else {
      // Restore each workspace
      for (const ws of persisted) {
        await this.restoreWorkspace(ws.id, ws.name);
      }

      // Activate the last-active workspace
      const activeId = await this.loadActiveWorkspaceId();
      const targetId = activeId && this.workspaces.has(activeId) ? activeId : persisted[0].id;
      await this.switchWorkspace(targetId);
    }

    // Ensure the active workspace's Taskbar is positioned with the correct y-offset
    await this.refreshTaskbar();

    return true;
  }

  // ── Workspace Lifecycle ──

  async createWorkspace(name: string): Promise<{ workspaceId: string }> {
    precondition(name !== '', 'workspace name must not be empty');

    const workspaceId = uuidv4();
    const info = await this.spawnWorkspaceObjects(workspaceId, name);
    this.workspaces.set(workspaceId, info);

    await this.persistWorkspaceList();

    console.log(`[WORKSPACE-MANAGER] Created workspace '${name}' (${workspaceId})`);
    return { workspaceId };
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    precondition(this.workspaces.size > 1, 'Cannot delete the last workspace');
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;

    // If deleting the active workspace, switch to another first
    if (this.activeWorkspaceId === workspaceId) {
      const otherId = [...this.workspaces.keys()].find((id) => id !== workspaceId);
      if (otherId) await this.switchWorkspace(otherId);
    }

    // Unregister this workspace's Taskbar from WindowManager
    if (this.windowManagerId) {
      try {
        await this.request(request(this.id, this.windowManagerId,
          WINDOW_MANAGER_INTERFACE, 'unregisterTaskbar', { workspaceId }));
      } catch { /* WindowManager may be gone */ }
    }

    // Hide workspace taskbar
    try {
      await this.request(request(this.id, ws.taskbarId, TASKBAR_INTERFACE, 'hide', {}));
    } catch { /* may already be hidden */ }

    // Kill all per-workspace objects (in reverse order)
    for (const childId of [...ws.childIds].reverse()) {
      try {
        await this.request(
          request(this.id, this.factoryId!, FACTORY_INTERFACE, 'kill', { objectId: childId })
        );
      } catch { /* may already be dead */ }
    }

    // Unregister workspace registry from global registry
    try {
      await this.request(
        request(this.id, this.globalRegistryId!, REGISTRY_INTERFACE, 'unregister', { objectId: ws.registryId })
      );
    } catch { /* already gone */ }

    // Delete the workspace's IndexedDB database
    if (typeof indexedDB !== 'undefined') {
      try {
        indexedDB.deleteDatabase(`abjects-storage-${workspaceId}`);
      } catch { /* best effort */ }
    }

    this.workspaces.delete(workspaceId);
    await this.persistWorkspaceList();

    console.log(`[WORKSPACE-MANAGER] Deleted workspace '${ws.name}' (${workspaceId})`);
    return true;
  }

  async switchWorkspace(workspaceId: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;

    this.activeWorkspaceId = workspaceId;

    // Instant switch: change the compositor filter (no hide/show messages needed)
    if (this.uiServerId) {
      await this.request(request(this.id, this.uiServerId, UI_INTERFACE, 'setActiveWorkspace', { workspaceId }));
    }

    // Update WorkspaceSwitcher to reflect the new active workspace
    if (this.workspaceSwitcherId) {
      try {
        await this.request(request(this.id, this.workspaceSwitcherId,
          WORKSPACE_SWITCHER_INTERFACE, 'show', {
            workspaces: this.listWorkspaces(),
            activeWorkspaceId: workspaceId,
          }));
      } catch (err) {
        console.warn('[WORKSPACE-MANAGER] Failed to update workspace switcher:', err);
      }
    }

    await this.persistActiveWorkspaceId();

    // Reposition the active workspace's Taskbar below the WorkspaceSwitcher
    await this.refreshTaskbar();

    console.log(`[WORKSPACE-MANAGER] Switched to workspace '${ws.name}' (${workspaceId})`);
    return true;
  }

  /**
   * Re-show the active workspace's Taskbar with the current y-offset.
   * Called by WorkspaceSwitcher after workspace create changes switcher height.
   */
  private async refreshTaskbar(): Promise<boolean> {
    if (!this.activeWorkspaceId) return false;
    const ws = this.workspaces.get(this.activeWorkspaceId);
    if (!ws) return false;

    let yOffset = 8;
    if (this.workspaceSwitcherId) {
      try {
        const switcherHeight = await this.request<number>(
          request(this.id, this.workspaceSwitcherId, WORKSPACE_SWITCHER_INTERFACE, 'getHeight', {}));
        yOffset = 8 + switcherHeight + 16;
      } catch { /* use default */ }
    }

    try {
      await this.request(request(this.id, ws.taskbarId, TASKBAR_INTERFACE, 'show', {
        yOffset,
      }));
    } catch (err) {
      console.warn('[WORKSPACE-MANAGER] Failed to refresh taskbar:', err);
    }

    return true;
  }

  listWorkspaces(): Array<{ id: string; name: string }> {
    return [...this.workspaces.entries()].map(([id, ws]) => ({
      id,
      name: ws.name,
    }));
  }

  getActiveWorkspace(): { id: string; name: string } | null {
    if (!this.activeWorkspaceId) return null;
    const ws = this.workspaces.get(this.activeWorkspaceId);
    if (!ws) return null;
    return { id: this.activeWorkspaceId, name: ws.name };
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
    precondition(name !== '', 'name must not be empty');
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.name = name;
    await this.persistWorkspaceList();
    return true;
  }

  // ── Internal Helpers ──

  /**
   * Spawn all objects for a workspace: WorkspaceRegistry, Storage, and per-ws objects.
   */
  private async spawnWorkspaceObjects(workspaceId: string, name: string): Promise<WorkspaceInfo> {
    // 1. Spawn WorkspaceRegistry (skip all registries — we register manually)
    const wsRegResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, FACTORY_INTERFACE, 'spawn', {
        manifest: { name: 'WorkspaceRegistry', description: `Workspace registry for '${name}'`,
          version: '1.0.0', interfaces: [], requiredCapabilities: [], tags: ['system'] },
        skipGlobalRegistry: true,
      })
    );
    const wsRegistryId = wsRegResult.objectId;

    // Configure fallback to global registry
    await this.request(
      request(this.id, wsRegistryId, WORKSPACE_REGISTRY_INTERFACE, 'setFallback', {
        registryId: this.globalRegistryId!,
      })
    );

    // Register workspace registry in itself (so workspace objects find "Registry")
    await this.request(
      request(this.id, wsRegistryId, REGISTRY_INTERFACE, 'register', {
        objectId: wsRegistryId,
        manifest: { name: 'Registry', description: `Workspace registry for '${name}'`,
          version: '1.0.0', interfaces: [{ id: 'abjects:registry', name: 'Registry',
          description: 'Object registration and discovery', methods: [] }],
          requiredCapabilities: [], tags: ['system', 'core'] },
      })
    );

    // Register workspace registry in the global registry so it's discoverable
    await this.request(
      request(this.id, this.globalRegistryId!, REGISTRY_INTERFACE, 'register', {
        objectId: wsRegistryId,
        manifest: { name: `WorkspaceRegistry:${name}`, description: `Workspace registry for '${name}'`,
          version: '1.0.0', interfaces: [{ id: 'abjects:registry', name: 'Registry',
          description: 'Object registration and discovery', methods: [] }],
          requiredCapabilities: [], tags: ['system', 'workspace'] },
      })
    );

    // 2. Spawn workspace-scoped Storage (registryHint → workspace registry, Factory auto-registers)
    const wsStorageResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, FACTORY_INTERFACE, 'spawn', {
        manifest: { name: 'Storage', description: `Workspace storage for '${name}'`,
          version: '1.0.0', interfaces: [], requiredCapabilities: [], tags: ['system'] },
        registryHint: wsRegistryId,
        constructorArgs: { dbName: `abjects-storage-${workspaceId}` },
      })
    );
    const wsStorageId = wsStorageResult.objectId;

    // 3. Spawn per-workspace objects (in dependency order)
    // Factory auto-registers each in the workspace registry via registryHint
    const childIds: AbjectId[] = [wsRegistryId, wsStorageId];
    let taskbarId: AbjectId = '' as AbjectId;
    const uiObjects: Array<{ id: AbjectId; iface: InterfaceId }> = [];

    // Map object names to their interface IDs for UI object tracking
    const uiIfaceMap: Record<string, InterfaceId> = {
      Settings: SETTINGS_INTERFACE,
      RegistryBrowser: REGISTRY_BROWSER_INTERFACE,
      JobBrowser: JOB_BROWSER_INTERFACE,
      Chat: CHAT_INTERFACE,
    };

    for (const objName of PER_WORKSPACE_OBJECTS) {
      const result = await this.request<SpawnResult>(
        request(this.id, this.factoryId!, FACTORY_INTERFACE, 'spawn', {
          manifest: { name: objName, description: '', version: '1.0.0',
            interfaces: [], requiredCapabilities: [], tags: ['system'] },
          registryHint: wsRegistryId,
        })
      );

      const objId = result.objectId;
      childIds.push(objId);

      if (objName === 'Taskbar') {
        taskbarId = objId;
        // Register this workspace's Taskbar with WindowManager so it can
        // route minimize/restore events based on the window's workspace tag
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId,
              WINDOW_MANAGER_INTERFACE, 'registerTaskbar', { taskbarId: objId, workspaceId }));
          } catch { /* WindowManager may not be ready */ }
        }
      }

      // Track UI objects for reference
      if (uiIfaceMap[objName]) {
        uiObjects.push({ id: objId, iface: uiIfaceMap[objName] });
      }

      // Tag this object with its workspace so WidgetManager can
      // assign the workspace ID to any surfaces it creates
      if (this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, WIDGETS_INTERFACE, 'setObjectWorkspace', {
            objectId: objId, workspaceId,
          }));
        } catch { /* WidgetManager may not be ready */ }
      }
    }

    // 4. Restore persisted user-created abjects for this workspace
    // AbjectStore is at index 0 in PER_WORKSPACE_OBJECTS, so childIds[2]
    const abjectStoreId = childIds[2];
    if (abjectStoreId) {
      try {
        await this.request(
          request(this.id, abjectStoreId, ABJECT_STORE_INTERFACE, 'restoreAll', {})
        );
      } catch (err) {
        console.warn(`[WORKSPACE-MANAGER] Failed to restore abjects for workspace '${name}':`, err);
      }
    }

    return {
      id: workspaceId,
      name,
      childIds,
      registryId: wsRegistryId,
      storageId: wsStorageId,
      taskbarId,
      uiObjects,
    };
  }

  /**
   * Restore a previously persisted workspace by re-spawning its objects.
   */
  private async restoreWorkspace(workspaceId: string, name: string): Promise<void> {
    const info = await this.spawnWorkspaceObjects(workspaceId, name);
    this.workspaces.set(workspaceId, info);
    console.log(`[WORKSPACE-MANAGER] Restored workspace '${name}' (${workspaceId})`);
  }

  /**
   * Migrate existing data from the global storage to the default workspace storage.
   */
  private async migrateExistingData(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;

    try {
      const keys = await this.request<string[]>(
        request(this.id, this.globalStorageId!, STORAGE_INTERFACE, 'keys', {})
      );

      // Keys that belong to per-workspace objects
      const migrateKeys = keys.filter((key) =>
        key.startsWith('settings:') ||
        key.startsWith('theme:') ||
        key.startsWith('abject-store:') ||
        key.startsWith('chat:')
      );

      for (const key of migrateKeys) {
        try {
          const value = await this.request<unknown>(
            request(this.id, this.globalStorageId!, STORAGE_INTERFACE, 'get', { key })
          );
          if (value !== null) {
            await this.request(
              request(this.id, ws.storageId, STORAGE_INTERFACE, 'set', { key, value })
            );
          }
        } catch { /* skip individual key errors */ }
      }

      if (migrateKeys.length > 0) {
        console.log(`[WORKSPACE-MANAGER] Migrated ${migrateKeys.length} keys to default workspace`);
      }
    } catch (err) {
      console.warn('[WORKSPACE-MANAGER] Data migration failed:', err);
    }
  }

  // ── Persistence ──

  private async loadWorkspaceList(): Promise<PersistedWorkspace[]> {
    try {
      const stored = await this.request<PersistedWorkspace[] | null>(
        request(this.id, this.globalStorageId!, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_LIST })
      );
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  private async loadActiveWorkspaceId(): Promise<string | null> {
    try {
      const stored = await this.request<string | null>(
        request(this.id, this.globalStorageId!, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_ACTIVE })
      );
      return stored;
    } catch {
      return null;
    }
  }

  private async persistWorkspaceList(): Promise<void> {
    const list: PersistedWorkspace[] = [...this.workspaces.entries()].map(([id, ws]) => ({
      id,
      name: ws.name,
      createdAt: Date.now(),
    }));
    try {
      await this.request(
        request(this.id, this.globalStorageId!, STORAGE_INTERFACE, 'set', {
          key: STORAGE_KEY_LIST,
          value: list,
        })
      );
    } catch (err) {
      console.warn('[WORKSPACE-MANAGER] Failed to persist workspace list:', err);
    }
  }

  private async persistActiveWorkspaceId(): Promise<void> {
    if (!this.activeWorkspaceId) return;
    try {
      await this.request(
        request(this.id, this.globalStorageId!, STORAGE_INTERFACE, 'set', {
          key: STORAGE_KEY_ACTIVE,
          value: this.activeWorkspaceId,
        })
      );
    } catch (err) {
      console.warn('[WORKSPACE-MANAGER] Failed to persist active workspace:', err);
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## WorkspaceManager Usage Guide

### Methods
- \`createWorkspace({ name })\` — Create a new workspace. Returns { workspaceId }.
- \`deleteWorkspace({ workspaceId })\` — Delete a workspace. Cannot delete the last one.
- \`switchWorkspace({ workspaceId })\` — Switch to a workspace (compositor-level filtering, instant switch).
- \`listWorkspaces()\` — List all workspaces. Returns [{ id, name }].
- \`getActiveWorkspace()\` — Get the active workspace. Returns { id, name }.
- \`renameWorkspace({ workspaceId, name })\` — Rename a workspace.

### Interface ID
\`abjects:workspace-manager\``;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.workspaces.size >= 0, 'workspace count must be non-negative');
  }
}

export const WORKSPACE_MANAGER_ID = 'abjects:workspace-manager' as AbjectId;
