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
  TypeId,
  AbjectMessage,
  InterfaceId,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';

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
const APP_EXPLORER_INTERFACE = 'abjects:app-explorer' as InterfaceId;
const JOB_BROWSER_INTERFACE = 'abjects:job-browser' as InterfaceId;
const WORKSPACE_SWITCHER_INTERFACE = 'abjects:workspace-switcher' as InterfaceId;
const GLOBAL_TOOLBAR_INTERFACE = 'abjects:global-toolbar' as InterfaceId;

const STORAGE_KEY_LIST = 'workspaces:list';
const STORAGE_KEY_ACTIVE = 'workspaces:active';

const wsLog = new Log('WORKSPACE-MANAGER');

/** Infrastructure objects — always spawned for every workspace (no UI). */
const INFRA_OBJECTS = [
  'AbjectStore', 'SharedState', 'FileTransfer', 'MediaStream', 'Theme',
  'JobManager', 'AgentAbject', 'WebAgent',
] as const;

/** UI objects — deferred for inactive workspaces, spawned on first switch. */
const UI_OBJECTS = [
  'Settings', 'AppExplorer', 'JobBrowser',
  'WebBrowserViewer', 'Chat', 'ObjectCreator', 'AbjectEditor', 'Taskbar',
] as const;

/** All per-workspace objects in dependency order. */
const PER_WORKSPACE_OBJECTS = [...INFRA_OBJECTS, ...UI_OBJECTS];

export type WorkspaceAccessMode = 'local' | 'private' | 'public';

export interface WorkspaceInfo {
  id: string;
  name: string;
  description: string;
  tags: string[];
  accessMode: WorkspaceAccessMode;
  whitelist: string[];
  exposedObjectIds: AbjectId[];
  exposedTypeIds: TypeId[];
  childIds: AbjectId[];
  registryId: AbjectId;
  storageId: AbjectId;
  taskbarId: AbjectId;
  uiObjects: Array<{ id: AbjectId; iface: InterfaceId }>;
  childTypeIds: Map<AbjectId, TypeId>;
  uiSpawned: boolean;
}

export interface SharedWorkspaceInfo {
  workspaceId: string;
  name: string;
  description?: string;
  tags?: string[];
  ownerPeerId?: string;
  ownerName?: string;
  accessMode: WorkspaceAccessMode;
  whitelist?: string[];
  exposedObjectIds?: string[];
  registryId?: string;
}

interface PersistedWorkspace {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  accessMode?: WorkspaceAccessMode;
  whitelist?: string[];
  exposedObjectIds?: string[];
  exposedTypeIds?: string[];
  createdAt: number;
}

export class WorkspaceManager extends Abject {
  private workspaces: Map<string, WorkspaceInfo> = new Map();
  private activeWorkspaceId?: string;
  private peerId?: string;
  private globalStorageId?: AbjectId;
  private globalRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private supervisorId?: AbjectId;
  private workspaceSwitcherId?: AbjectId;
  private globalToolbarId?: AbjectId;
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
        interface: {
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
                  registryId: { kind: 'primitive', primitive: 'string' },
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
              {
                name: 'getAccessMode',
                description: 'Get the access mode of a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'setAccessMode',
                description: 'Set the access mode of a workspace (local, private, public)',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                  {
                    name: 'accessMode',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Access mode: local, private, or public',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getWhitelist',
                description: 'Get the whitelist of allowed peer IDs for a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                ],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'setWhitelist',
                description: 'Set the whitelist of allowed peer IDs for a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                  {
                    name: 'whitelist',
                    type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                    description: 'Array of peer IDs',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listSharedWorkspaces',
                description: 'List workspaces that are shared (not local)',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SharedWorkspaceInfo' } },
              },
              {
                name: 'findWorkspaceForObject',
                description: 'Find which workspace contains a given object and return its access info',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object ID to look up',
                  },
                ],
                returns: { kind: 'object', properties: {
                  workspaceId: { kind: 'primitive', primitive: 'string' },
                  name: { kind: 'primitive', primitive: 'string' },
                  accessMode: { kind: 'primitive', primitive: 'string' },
                  whitelist: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                } },
              },
              {
                name: 'getWorkspaceForObject',
                description: 'Fast lookup: find which workspace contains a given object by ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object ID to look up',
                  },
                ],
                returns: { kind: 'object', properties: {
                  workspaceId: { kind: 'primitive', primitive: 'string' },
                  workspaceName: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'listWorkspacesDetailed',
                description: 'List all workspaces with full details including child IDs and access mode',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'WorkspaceDetailedInfo' } },
              },
              {
                name: 'getExposedObjects',
                description: 'Get the list of exposed object IDs for a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'setExposedObjects',
                description: 'Set the list of exposed object IDs for a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                  { name: 'objectIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Array of object IDs to expose' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getDescription',
                description: 'Get the description of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'setDescription',
                description: 'Set the description of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                  { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace description' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getTags',
                description: 'Get the tags of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'setTags',
                description: 'Set the tags of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                  { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Array of tags' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
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

    this.on('getAccessMode', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getAccessMode(workspaceId);
    });

    this.on('setAccessMode', async (msg: AbjectMessage) => {
      const { workspaceId, accessMode } = msg.payload as { workspaceId: string; accessMode: string };
      return this.setAccessMode(workspaceId, accessMode as WorkspaceAccessMode);
    });

    this.on('getWhitelist', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getWhitelist(workspaceId);
    });

    this.on('setWhitelist', async (msg: AbjectMessage) => {
      const { workspaceId, whitelist } = msg.payload as { workspaceId: string; whitelist: string[] };
      return this.setWhitelist(workspaceId, whitelist);
    });

    this.on('listSharedWorkspaces', async () => {
      return this.listSharedWorkspaces();
    });

    this.on('findWorkspaceForObject', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.findWorkspaceForObject(objectId as AbjectId);
    });

    this.on('getWorkspaceForObject', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.getWorkspaceForObject(objectId as AbjectId);
    });

    this.on('listWorkspacesDetailed', async () => {
      return this.listWorkspacesDetailed();
    });

    this.on('getExposedObjects', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getExposedObjects(workspaceId);
    });

    this.on('setExposedObjects', async (msg: AbjectMessage) => {
      const { workspaceId, objectIds } = msg.payload as { workspaceId: string; objectIds: string[] };
      return this.setExposedObjects(workspaceId, objectIds as AbjectId[]);
    });

    this.on('getDescription', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getDescription(workspaceId);
    });

    this.on('setDescription', async (msg: AbjectMessage) => {
      const { workspaceId, description } = msg.payload as { workspaceId: string; description: string };
      return this.setDescription(workspaceId, description);
    });

    this.on('getTags', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getTags(workspaceId);
    });

    this.on('setTags', async (msg: AbjectMessage) => {
      const { workspaceId, tags } = msg.payload as { workspaceId: string; tags: string[] };
      return this.setTags(workspaceId, tags);
    });

    this.on('refreshTaskbar', async () => {
      return this.refreshTaskbar();
    });

    // Handle objectRegistered events from workspace registries
    this.on('objectRegistered', async (msg: AbjectMessage) => {
      const registryId = msg.routing.from;
      const { id: objectId, typeId } = msg.payload as { id: string; typeId?: string };
      for (const ws of this.workspaces.values()) {
        if (ws.registryId === registryId) {
          if (!ws.childIds.includes(objectId as AbjectId)) {
            ws.childIds.push(objectId as AbjectId);
            if (typeId) {
              ws.childTypeIds.set(objectId as AbjectId, typeId as TypeId);
            }
            if (ws.accessMode !== 'local') {
              await this.changed('workspaceObjectsChanged', {
                workspaceId: ws.id, objectId,
              });
            }
          }
          break;
        }
      }
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
    this.globalToolbarId = await this.discoverDep('GlobalToolbar') ?? undefined;
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;
  }

  /**
   * Boot workspaces — must be called after spawn completes.
   * This cannot run during onInit because Factory would deadlock.
   */
  private async boot(): Promise<boolean> {
    const log = new Log('WORKSPACE-BOOT');

    // Discover peerId from IdentityObject for scoped TypeIds
    try {
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.peerId = identity.peerId;
      }
    } catch {
      wsLog.warn('Could not discover peerId from IdentityObject');
    }
    log.timed('identity resolved');

    const persisted = await this.loadWorkspaceList();
    log.timed(`workspace list loaded (${persisted.length} workspaces)`);

    if (persisted.length === 0) {
      // First boot — create "Default" workspace and migrate existing data
      const { workspaceId } = await this.createWorkspace('Default');
      log.timed('created Default workspace');
      await this.migrateExistingData(workspaceId);
      log.timed('migrated existing data');
      await this.switchWorkspace(workspaceId);
      log.timed('switched to Default workspace');
    } else {
      // Load active workspace ID BEFORE restoring so we know which one to fully spawn
      const activeId = await this.loadActiveWorkspaceId();
      const targetId = activeId && persisted.some(ws => ws.id === activeId) ? activeId : persisted[0].id;

      // Restore active workspace first with FULL spawn (infra + UI)
      const activeWs = persisted.find(ws => ws.id === targetId)!;
      await this.restoreWorkspace(activeWs.id, activeWs.name, activeWs.accessMode ?? 'local',
        activeWs.whitelist ?? [], activeWs.exposedTypeIds ?? [], activeWs.description ?? '',
        activeWs.tags ?? [], true);
      log.timed(`active workspace '${activeWs.name}' restored`);

      // Switch to active workspace immediately — UI is ready
      await this.switchWorkspace(targetId);
      log.timed('switchWorkspace done');

      // Restore remaining workspaces in the background — don't block boot.
      // This lets the server start accepting connections immediately.
      const remaining = persisted.filter(ws => ws.id !== targetId);
      if (remaining.length > 0) {
        void this.restoreRemainingWorkspaces(remaining);
      }
    }

    log.summary();
    return true;
  }

  /**
   * Restore inactive workspaces in the background after boot completes.
   */
  private async restoreRemainingWorkspaces(workspaces: PersistedWorkspace[]): Promise<void> {
    for (const ws of workspaces) {
      try {
        await this.restoreWorkspace(ws.id, ws.name, ws.accessMode ?? 'local', ws.whitelist ?? [],
          ws.exposedTypeIds ?? [], ws.description ?? '', ws.tags ?? [], false);
      } catch (err) {
        wsLog.warn(`Failed to restore workspace '${ws.name}':`, err);
      }
    }
    // Refresh the switcher now that all workspaces are available
    await this.refreshTaskbar();
  }

  // ── Workspace Lifecycle ──

  async createWorkspace(name: string): Promise<{ workspaceId: string }> {
    precondition(name !== '', 'workspace name must not be empty');

    const workspaceId = uuidv4();
    const info = await this.spawnWorkspaceObjects(workspaceId, name);
    this.workspaces.set(workspaceId, info);

    await this.persistWorkspaceList();

    wsLog.info(`Created workspace '${name}' (${workspaceId})`);
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
          'unregisterTaskbar', { workspaceId }));
      } catch { /* WindowManager may be gone */ }
    }

    // Hide workspace taskbar
    try {
      await this.request(request(this.id, ws.taskbarId, 'hide', {}));
    } catch { /* may already be hidden */ }

    // Kill all per-workspace objects (in reverse order)
    for (const childId of [...ws.childIds].reverse()) {
      try {
        await this.request(
          request(this.id, this.factoryId!, 'kill', { objectId: childId })
        );
      } catch { /* may already be dead */ }
    }

    // Unregister workspace registry from global registry
    try {
      await this.request(
        request(this.id, this.globalRegistryId!, 'unregister', { objectId: ws.registryId })
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

    wsLog.info(`Deleted workspace '${ws.name}' (${workspaceId})`);
    return true;
  }

  async switchWorkspace(workspaceId: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;

    // Lazy-spawn UI objects on first switch to a deferred workspace
    if (!ws.uiSpawned) {
      await this.spawnUIObjects(workspaceId);
    }

    this.activeWorkspaceId = workspaceId;

    // Instant switch: change the compositor filter (no hide/show messages needed)
    if (this.uiServerId) {
      await this.request(request(this.id, this.uiServerId, 'setActiveWorkspace', { workspaceId }));
    }

    await this.persistActiveWorkspaceId();

    // Reposition all panels (GlobalToolbar → WorkspaceSwitcher → Taskbar)
    // This also refreshes WorkspaceSwitcher with current workspace data.
    await this.refreshTaskbar();

    wsLog.info(`Switched to workspace '${ws.name}' (${workspaceId})`);
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

    // Stack order: GlobalToolbar → WorkspaceSwitcher → Taskbar
    let yOffset = 8;

    if (this.globalToolbarId) {
      try {
        await this.request(request(this.id, this.globalToolbarId, 'show', { yOffset }));
        const toolbarHeight = await this.request<number>(
          request(this.id, this.globalToolbarId, 'getHeight', {}));
        yOffset = yOffset + toolbarHeight + 8;
      } catch { /* toolbar not ready */ }
    }

    if (this.workspaceSwitcherId) {
      try {
        // Find the active workspace's Settings ID for the gear button
        const settingsEntry = ws.uiObjects.find(o => o.iface === SETTINGS_INTERFACE);
        await this.request(request(this.id, this.workspaceSwitcherId,
          'show', {
            workspaces: this.listWorkspaces(),
            activeWorkspaceId: this.activeWorkspaceId,
            settingsId: settingsEntry?.id,
            yOffset,
          }));
        const switcherHeight = await this.request<number>(
          request(this.id, this.workspaceSwitcherId, 'getHeight', {}));
        yOffset = yOffset + switcherHeight + 8;
      } catch { /* use default */ }
    }

    try {
      await this.request(request(this.id, ws.taskbarId, 'show', {
        yOffset,
      }));
    } catch (err) {
      wsLog.warn('Failed to refresh taskbar:', err);
    }

    return true;
  }

  listWorkspaces(): Array<{ id: string; name: string; accessMode: WorkspaceAccessMode }> {
    return [...this.workspaces.entries()].map(([id, ws]) => ({
      id,
      name: ws.name,
      accessMode: ws.accessMode,
    }));
  }

  getActiveWorkspace(): { id: string; name: string; registryId: string } | null {
    if (!this.activeWorkspaceId) return null;
    const ws = this.workspaces.get(this.activeWorkspaceId);
    if (!ws) return null;
    return { id: this.activeWorkspaceId, name: ws.name, registryId: ws.registryId };
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
    precondition(name !== '', 'name must not be empty');
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.name = name;
    await this.persistWorkspaceList();
    return true;
  }

  getAccessMode(workspaceId: string): WorkspaceAccessMode {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return 'local';
    return ws.accessMode;
  }

  async setAccessMode(workspaceId: string, accessMode: WorkspaceAccessMode): Promise<boolean> {
    precondition(
      accessMode === 'local' || accessMode === 'private' || accessMode === 'public',
      'accessMode must be local, private, or public',
    );
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    const prevMode = ws.accessMode;
    ws.accessMode = accessMode;

    // Ensure registry and SharedState are always exposed when workspace is shared
    if (accessMode !== 'local' && ws.exposedObjectIds.length === 0) {
      ws.exposedObjectIds = [ws.registryId];
      const regTypeId = ws.childTypeIds.get(ws.registryId);
      ws.exposedTypeIds = regTypeId ? [regTypeId] : [];
    }
    if (accessMode !== 'local') {
      await this.ensureSharedStateExposed(ws);
    }

    await this.syncExposedToRegistry(ws);
    await this.persistWorkspaceList();

    // Emit access change event for PeerRouter cache invalidation
    await this.changed('workspaceAccessChanged', {
      workspaceId, accessMode, whitelist: ws.whitelist,
      exposedObjectIds: ws.exposedObjectIds,
    });

    // Emit sharing events for dependents
    if (accessMode !== 'local' && prevMode === 'local') {
      await this.changed('workspaceShared', {
        workspaceId, name: ws.name, description: ws.description, tags: ws.tags,
        accessMode, whitelist: ws.whitelist, exposedObjectIds: ws.exposedObjectIds,
        registryId: ws.registryId,
      });
    } else if (accessMode === 'local' && prevMode !== 'local') {
      await this.changed('workspaceUnshared', { workspaceId, name: ws.name });
    } else if (accessMode !== 'local') {
      // Mode changed between private/public
      await this.changed('workspaceShared', {
        workspaceId, name: ws.name, description: ws.description, tags: ws.tags,
        accessMode, whitelist: ws.whitelist, exposedObjectIds: ws.exposedObjectIds,
        registryId: ws.registryId,
      });
    }

    return true;
  }

  getWhitelist(workspaceId: string): string[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.whitelist];
  }

  async setWhitelist(workspaceId: string, whitelist: string[]): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.whitelist = [...whitelist];
    await this.persistWorkspaceList();

    // Emit access change event for PeerRouter cache invalidation
    await this.changed('workspaceAccessChanged', {
      workspaceId, accessMode: ws.accessMode, whitelist: ws.whitelist,
      exposedObjectIds: ws.exposedObjectIds,
    });

    return true;
  }

  getExposedObjects(workspaceId: string): AbjectId[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.exposedObjectIds];
  }

  async setExposedObjects(workspaceId: string, objectIds: AbjectId[]): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    // Always include workspace registry when workspace is shared
    if (ws.accessMode !== 'local' && !objectIds.includes(ws.registryId)) {
      objectIds = [ws.registryId, ...objectIds];
    }
    ws.exposedObjectIds = [...objectIds];
    // Compute corresponding typeIds for durable persistence
    ws.exposedTypeIds = objectIds
      .map(id => ws.childTypeIds.get(id))
      .filter((t): t is TypeId => t !== undefined);
    await this.syncExposedToRegistry(ws);
    await this.persistWorkspaceList();

    await this.changed('workspaceAccessChanged', {
      workspaceId, accessMode: ws.accessMode, whitelist: ws.whitelist,
      exposedObjectIds: ws.exposedObjectIds,
    });

    return true;
  }

  getDescription(workspaceId: string): string {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return '';
    return ws.description;
  }

  async setDescription(workspaceId: string, description: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.description = description;
    await this.persistWorkspaceList();
    await this.changed('workspaceMetadataChanged', { workspaceId, description, tags: ws.tags });
    return true;
  }

  getTags(workspaceId: string): string[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.tags];
  }

  async setTags(workspaceId: string, tags: string[]): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.tags = [...tags];
    await this.persistWorkspaceList();
    await this.changed('workspaceMetadataChanged', { workspaceId, description: ws.description, tags: ws.tags });
    return true;
  }

  listSharedWorkspaces(): SharedWorkspaceInfo[] {
    const result: SharedWorkspaceInfo[] = [];
    for (const [, ws] of this.workspaces) {
      if (ws.accessMode !== 'local') {
        result.push({
          workspaceId: ws.id,
          name: ws.name,
          description: ws.description,
          tags: [...ws.tags],
          accessMode: ws.accessMode,
          whitelist: ws.accessMode === 'private' ? [...ws.whitelist] : undefined,
          exposedObjectIds: [...ws.exposedObjectIds],
          registryId: ws.registryId,
        });
      }
    }
    return result;
  }

  /**
   * Find the workspace that contains a given object and return its access info.
   */
  findWorkspaceForObject(objectId: AbjectId): {
    workspaceId: string;
    name: string;
    accessMode: WorkspaceAccessMode;
    whitelist: string[];
    exposedObjectIds: AbjectId[];
  } | null {
    for (const [, ws] of this.workspaces) {
      if (ws.registryId === objectId || ws.childIds.includes(objectId)) {
        const exposed = [...ws.exposedObjectIds];
        if (!exposed.includes(ws.registryId)) {
          exposed.push(ws.registryId);
        }
        return {
          workspaceId: ws.id,
          name: ws.name,
          accessMode: ws.accessMode,
          whitelist: [...ws.whitelist],
          exposedObjectIds: exposed,
        };
      }
    }
    return null;
  }

  /**
   * Fast lookup: find which workspace contains a given object by ID.
   * Returns workspaceId and workspaceName, or null if not found.
   */
  getWorkspaceForObject(objectId: AbjectId): { workspaceId: string; workspaceName: string } | null {
    for (const [, ws] of this.workspaces) {
      if (ws.registryId === objectId || ws.childIds.includes(objectId)) {
        return { workspaceId: ws.id, workspaceName: ws.name };
      }
    }
    return null;
  }

  /**
   * List all workspaces with full details including child IDs and access mode.
   * Used by PeerRouter for route propagation.
   */
  listWorkspacesDetailed(): Array<{
    workspaceId: string;
    name: string;
    accessMode: WorkspaceAccessMode;
    whitelist: string[];
    exposedObjectIds: AbjectId[];
    childIds: AbjectId[];
    registryId: AbjectId;
  }> {
    return [...this.workspaces.entries()].map(([, ws]) => ({
      workspaceId: ws.id,
      name: ws.name,
      accessMode: ws.accessMode,
      whitelist: [...ws.whitelist],
      exposedObjectIds: [...ws.exposedObjectIds],
      childIds: [...ws.childIds],
      registryId: ws.registryId,
    }));
  }

  // ── Internal Helpers ──

  /**
   * Spawn only UI objects into an existing workspace that was initially
   * created with infra-only objects. Reuses the same per-object post-spawn
   * setup (Taskbar registration, Theme registration, uiObjects tracking).
   */
  private async spawnUIObjects(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.uiSpawned) return;

    const uiIfaceMap: Record<string, InterfaceId> = {
      Settings: SETTINGS_INTERFACE,
      AppExplorer: APP_EXPLORER_INTERFACE,
      JobBrowser: JOB_BROWSER_INTERFACE,
      Chat: CHAT_INTERFACE,
    };

    for (const objName of UI_OBJECTS) {
      const typeId = this.computeTypeId(workspaceId, objName);
      let result: SpawnResult;
      try {
        result = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, 'spawn', {
            manifest: { name: objName, description: '', version: '1.0.0',
              requiredCapabilities: [], tags: ['system'] },
            registryHint: ws.registryId,
            typeId,
          })
        );
      } catch {
        continue;
      }

      const objId = result.objectId;
      ws.childIds.push(objId);
      if (typeId) ws.childTypeIds.set(objId, typeId);

      if (objName === 'Taskbar') {
        ws.taskbarId = objId;
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId,
              'registerTaskbar', { taskbarId: objId, workspaceId }));
          } catch { /* WindowManager may not be ready */ }
        }
      }

      if (uiIfaceMap[objName]) {
        ws.uiObjects.push({ id: objId, iface: uiIfaceMap[objName] });
      }

      if (this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
            objectId: objId, workspaceId,
          }));
        } catch { /* WidgetManager may not be ready */ }
      }
    }

    ws.uiSpawned = true;
    wsLog.info(`Spawned deferred UI objects for workspace '${ws.name}' (${workspaceId})`);
  }

  /**
   * Compute a scoped TypeId: {peerId}/{workspaceId}/{objectName}
   * Returns undefined if peerId is not yet known.
   */
  private computeTypeId(workspaceId: string, objectName: string): TypeId | undefined {
    if (!this.peerId) return undefined;
    return `${this.peerId}/${workspaceId}/${objectName}` as TypeId;
  }

  /**
   * Spawn all objects for a workspace: WorkspaceRegistry, Storage, and per-ws objects.
   */
  private async spawnWorkspaceObjects(
    workspaceId: string, name: string,
    objectsToSpawn: readonly string[] = PER_WORKSPACE_OBJECTS,
  ): Promise<WorkspaceInfo> {
    const log = new Log(`WS-SPAWN:${name}`);
    // 1. Spawn WorkspaceRegistry (skip all registries — we register manually)
    const wsRegistryTypeId = this.computeTypeId(workspaceId, 'WorkspaceRegistry');
    const wsRegResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', {
        manifest: { name: 'WorkspaceRegistry', description: `Workspace registry for '${name}'`,
          version: '1.0.0', requiredCapabilities: [], tags: ['system'] },
        skipGlobalRegistry: true,
        typeId: wsRegistryTypeId,
      })
    );
    const wsRegistryId = wsRegResult.objectId;

    // Subscribe to workspace registry for object registration events
    await this.request(
      request(this.id, wsRegistryId, 'subscribe', {})
    );

    // Configure fallback to global registry
    await this.request(
      request(this.id, wsRegistryId, 'setFallback', {
        registryId: this.globalRegistryId!,
      })
    );

    // Register workspace registry in itself (so workspace objects find "Registry")
    await this.request(
      request(this.id, wsRegistryId, 'register', {
        objectId: wsRegistryId,
        typeId: wsRegistryTypeId,
        manifest: { name: 'Registry', description: `Workspace registry for '${name}'`,
          version: '1.0.0', interface: { id: 'abjects:registry', name: 'Registry',
          description: 'Object registration and discovery', methods: [] },
          requiredCapabilities: [], tags: ['system', 'core'] },
      })
    );

    // Register the global registry in the workspace registry as "SystemRegistry"
    // so workspace objects (e.g. AppExplorer) can discover and query it
    await this.request(
      request(this.id, wsRegistryId, 'register', {
        objectId: this.globalRegistryId!,
        manifest: {
          name: 'SystemRegistry',
          description: 'System-wide registry for core objects shared across workspaces',
          version: '1.0.0',
          interface: { id: 'abjects:registry' as InterfaceId, name: 'Registry',
            description: 'Object registration and discovery', methods: [] },
          requiredCapabilities: [], tags: ['system', 'core'],
        },
      })
    );

    // Register workspace registry in the global registry so it's discoverable
    await this.request(
      request(this.id, this.globalRegistryId!, 'register', {
        objectId: wsRegistryId,
        typeId: wsRegistryTypeId,
        manifest: { name: `WorkspaceRegistry:${name}`, description: `Workspace registry for '${name}'`,
          version: '1.0.0', interface: { id: 'abjects:registry', name: 'Registry',
          description: 'Object registration and discovery', methods: [] },
          requiredCapabilities: [], tags: ['system', 'workspace'] },
      })
    );

    // 2. Spawn workspace-scoped Storage (registryHint → workspace registry, Factory auto-registers)
    const wsStorageTypeId = this.computeTypeId(workspaceId, 'Storage');
    const wsStorageResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', {
        manifest: { name: 'Storage', description: `Workspace storage for '${name}'`,
          version: '1.0.0', requiredCapabilities: [], tags: ['system'] },
        registryHint: wsRegistryId,
        constructorArgs: { dbName: `abjects-storage-${workspaceId}` },
        typeId: wsStorageTypeId,
      })
    );
    const wsStorageId = wsStorageResult.objectId;
    log.timed('registry + storage ready');

    // 3. Spawn per-workspace objects (in dependency order)
    // Factory auto-registers each in the workspace registry via registryHint
    const childIds: AbjectId[] = [wsRegistryId, wsStorageId];
    let taskbarId: AbjectId = '' as AbjectId;
    const uiObjects: Array<{ id: AbjectId; iface: InterfaceId }> = [];
    const childTypeIds = new Map<AbjectId, TypeId>();

    // Compute typeIds for infrastructure objects
    const regTypeId = this.computeTypeId(workspaceId, 'WorkspaceRegistry');
    const storTypeId = this.computeTypeId(workspaceId, 'Storage');
    if (regTypeId) childTypeIds.set(wsRegistryId, regTypeId);
    if (storTypeId) childTypeIds.set(wsStorageId, storTypeId);

    // Map object names to their interface IDs for UI object tracking
    const uiIfaceMap: Record<string, InterfaceId> = {
      Settings: SETTINGS_INTERFACE,
      AppExplorer: APP_EXPLORER_INTERFACE,
      JobBrowser: JOB_BROWSER_INTERFACE,
      Chat: CHAT_INTERFACE,
    };

    for (const objName of objectsToSpawn) {
      const typeId = this.computeTypeId(workspaceId, objName);
      let result: SpawnResult;
      try {
        result = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, 'spawn', {
            manifest: { name: objName, description: '', version: '1.0.0',
              requiredCapabilities: [], tags: ['system'] },
            registryHint: wsRegistryId,
            typeId,
          })
        );
      } catch {
        // Constructor not registered (e.g. server-only objects in browser mode) — skip
        continue;
      }
      log.timed(`spawn ${objName}`);

      const objId = result.objectId;
      childIds.push(objId);
      if (typeId) childTypeIds.set(objId, typeId);

      if (objName === 'Taskbar') {
        taskbarId = objId;
        // Register this workspace's Taskbar with WindowManager so it can
        // route minimize/restore events based on the window's workspace tag
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId,
              'registerTaskbar', { taskbarId: objId, workspaceId }));
          } catch { /* WindowManager may not be ready */ }
        }
      }

      // Register per-workspace Theme with WidgetManager for per-workspace theming
      if (objName === 'Theme' && this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId,
            'registerWorkspaceTheme', { workspaceId, themeId: objId }));
        } catch { /* WidgetManager may not be ready */ }
      }

      // Track UI objects for reference
      if (uiIfaceMap[objName]) {
        uiObjects.push({ id: objId, iface: uiIfaceMap[objName] });
      }

      // Tag this object with its workspace so WidgetManager can
      // assign the workspace ID to any surfaces it creates
      if (this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
            objectId: objId, workspaceId,
          }));
        } catch { /* WidgetManager may not be ready */ }
      }
    }

    log.timed(`all ${objectsToSpawn.length} objects spawned`);

    // 4. Restore persisted user-created abjects for this workspace
    // AbjectStore is at index 0 in PER_WORKSPACE_OBJECTS, so childIds[2]
    const abjectStoreId = childIds[2];
    if (abjectStoreId) {
      try {
        await this.request(
          request(this.id, abjectStoreId, 'restoreAll', {})
        );
        log.timed('restoreAll complete');
      } catch (err) {
        wsLog.warn(`Failed to restore abjects for workspace '${name}':`, err);
      }
    }

    // 5. Sync childIds with actual registry contents (picks up restored user objects)
    try {
      const registered = await this.request<Array<{ id: string; typeId?: string }>>(
        request(this.id, wsRegistryId, 'list', {})
      );
      for (const entry of registered) {
        const eid = entry.id as AbjectId;
        if (!childIds.includes(eid)) {
          childIds.push(eid);
        }
        if (entry.typeId && !childTypeIds.has(eid)) {
          childTypeIds.set(eid, entry.typeId as TypeId);
        }
      }
    } catch { /* registry not ready */ }

    log.summary();
    return {
      id: workspaceId,
      name,
      description: '',
      tags: [],
      accessMode: 'local',
      whitelist: [],
      exposedObjectIds: [],
      exposedTypeIds: [],
      childIds,
      registryId: wsRegistryId,
      storageId: wsStorageId,
      taskbarId,
      uiObjects,
      childTypeIds,
      uiSpawned: objectsToSpawn.includes('Taskbar'),
    };
  }

  /**
   * Restore a previously persisted workspace by re-spawning its objects.
   */
  private async restoreWorkspace(
    workspaceId: string, name: string,
    accessMode: WorkspaceAccessMode = 'local', whitelist: string[] = [],
    exposedTypeIds: string[] = [], description: string = '', tags: string[] = [],
    isActive: boolean = true,
  ): Promise<void> {
    const objectsToSpawn = isActive ? PER_WORKSPACE_OBJECTS : INFRA_OBJECTS;
    const info = await this.spawnWorkspaceObjects(workspaceId, name, objectsToSpawn);
    info.accessMode = accessMode;
    info.whitelist = whitelist;
    info.description = description;
    info.tags = tags;
    info.exposedTypeIds = exposedTypeIds as TypeId[];

    // Resolve persisted typeIds to current runtime AbjectIds via Registry
    const resolvedIds: AbjectId[] = [];
    for (const typeId of exposedTypeIds) {
      try {
        const abjectId = await this.request<AbjectId | null>(
          request(this.id, info.registryId, 'resolveType', { typeId })
        );
        if (abjectId) resolvedIds.push(abjectId);
      } catch { /* type not found — may have been removed */ }
    }
    info.exposedObjectIds = resolvedIds;

    this.workspaces.set(workspaceId, info);
    if (info.accessMode !== 'local') {
      await this.ensureSharedStateExposed(info);
      await this.syncExposedToRegistry(info);
    }
    wsLog.info(`Restored workspace '${name}' (${workspaceId})`);
  }

  /**
   * Migrate existing data from the global storage to the default workspace storage.
   */
  private async migrateExistingData(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;

    try {
      const keys = await this.request<string[]>(
        request(this.id, this.globalStorageId!, 'keys', {})
      );

      // Keys that belong to per-workspace objects
      // settings: keys are now managed by GlobalSettings in global storage
      const migrateKeys = keys.filter((key) =>
        key.startsWith('theme:') ||
        key.startsWith('abject-store:') ||
        key.startsWith('chat:')
      );

      for (const key of migrateKeys) {
        try {
          const value = await this.request<unknown>(
            request(this.id, this.globalStorageId!, 'get', { key })
          );
          if (value !== null) {
            await this.request(
              request(this.id, ws.storageId, 'set', { key, value })
            );
          }
        } catch { /* skip individual key errors */ }
      }

      if (migrateKeys.length > 0) {
        wsLog.info(`Migrated ${migrateKeys.length} keys to default workspace`);
      }
    } catch (err) {
      wsLog.warn('Data migration failed:', err);
    }
  }

  // ── Persistence ──

  private async loadWorkspaceList(): Promise<PersistedWorkspace[]> {
    try {
      const stored = await this.request<PersistedWorkspace[] | null>(
        request(this.id, this.globalStorageId!, 'get', { key: STORAGE_KEY_LIST })
      );
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  private async loadActiveWorkspaceId(): Promise<string | null> {
    try {
      const stored = await this.request<string | null>(
        request(this.id, this.globalStorageId!, 'get', { key: STORAGE_KEY_ACTIVE })
      );
      return stored;
    } catch {
      return null;
    }
  }

  /**
   * Ensure SharedState is in the workspace's exposed objects when shared.
   * Discovers SharedState via the workspace registry and adds it if missing.
   */
  private async ensureSharedStateExposed(ws: WorkspaceInfo): Promise<void> {
    // Check if SharedState is already exposed
    const alreadyExposed = ws.exposedObjectIds.some(id => {
      const typeId = ws.childTypeIds.get(id);
      return typeId?.endsWith('/SharedState');
    });
    if (alreadyExposed) return;

    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, ws.registryId, 'discover', { name: 'SharedState' })
      );
      if (results.length > 0) {
        const ssId = results[0].id;
        if (!ws.exposedObjectIds.includes(ssId)) {
          ws.exposedObjectIds.push(ssId);
          const ssTypeId = ws.childTypeIds.get(ssId);
          if (ssTypeId && !ws.exposedTypeIds.includes(ssTypeId)) {
            ws.exposedTypeIds.push(ssTypeId);
          }
        }
      }
    } catch { /* SharedState not spawned yet */ }
  }

  private async syncExposedToRegistry(ws: WorkspaceInfo): Promise<void> {
    try {
      await this.send(
        request(this.id, ws.registryId, 'setExposedObjectIds', {
          ids: ws.exposedObjectIds,
        })
      );
    } catch (err) {
      wsLog.warn('Failed to sync exposed objects to registry:', err);
    }
  }

  private async persistWorkspaceList(): Promise<void> {
    const list: PersistedWorkspace[] = [...this.workspaces.entries()].map(([id, ws]) => {
      return {
        id,
        name: ws.name,
        description: ws.description,
        tags: ws.tags,
        accessMode: ws.accessMode,
        whitelist: ws.whitelist,
        exposedObjectIds: ws.exposedObjectIds,
        exposedTypeIds: ws.exposedTypeIds,
        createdAt: Date.now(),
      };
    });
    try {
      await this.request(
        request(this.id, this.globalStorageId!, 'set', {
          key: STORAGE_KEY_LIST,
          value: list,
        })
      );
    } catch (err) {
      wsLog.warn('Failed to persist workspace list:', err);
    }
  }

  private async persistActiveWorkspaceId(): Promise<void> {
    if (!this.activeWorkspaceId) return;
    try {
      await this.request(
        request(this.id, this.globalStorageId!, 'set', {
          key: STORAGE_KEY_ACTIVE,
          value: this.activeWorkspaceId,
        })
      );
    } catch (err) {
      wsLog.warn('Failed to persist active workspace:', err);
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
- \`getAccessMode({ workspaceId })\` — Get workspace access mode (local, private, public).
- \`setAccessMode({ workspaceId, accessMode })\` — Set workspace access mode.

### Whitelist Management
- \`getWhitelist({ workspaceId })\` — Get the peer whitelist for a workspace. Returns string[].
- \`setWhitelist({ workspaceId, whitelist })\` — Set the peer whitelist (array of peer IDs).

### Discovery & Inspection
- \`listSharedWorkspaces({})\` — List workspaces with non-local access mode. Returns [{ id, name, accessMode }].
- \`findWorkspaceForObject({ objectId })\` — Find which workspace owns an object. Returns { workspaceId } or undefined.
- \`listWorkspacesDetailed({})\` — Full workspace details including access mode, whitelist, and child objects.

### Interface ID
\`abjects:workspace-manager\``;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.workspaces.size >= 0, 'workspace count must be non-negative');
  }
}

export const WORKSPACE_MANAGER_ID = 'abjects:workspace-manager' as AbjectId;
