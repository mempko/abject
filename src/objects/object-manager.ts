/**
 * ObjectManager — process/task manager for Abjects.
 *
 * Shows a scrollable table of all running objects with name, ID, state,
 * worker placement, and stop/restart actions. Per-workspace UI object
 * (follows RegistryBrowser/JobBrowser pattern).
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const OBJECT_MANAGER_INTERFACE: InterfaceId = 'abjects:object-manager';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const WINDOW_INTERFACE: InterfaceId = 'abjects:window';
const REGISTRY_INTERFACE: InterfaceId = 'abjects:registry';
const FACTORY_INTERFACE: InterfaceId = 'abjects:factory';
const SUPERVISOR_INTERFACE: InterfaceId = 'abjects:supervisor';

const WIN_W = 650;
const WIN_H = 500;

/** Names of protected objects that cannot be stopped or restarted. */
const PROTECTED_NAMES = new Set([
  'Registry', 'Factory', 'Supervisor', 'WidgetManager', 'WindowManager',
  'WorkspaceManager', 'WorkspaceRegistry', 'WorkspaceSwitcher', 'UIServer',
  'ObjectManager',
]);

/** State → color mapping for the state label. */
const STATE_COLORS: Record<string, string> = {
  ready: '#a8cc8c',
  error: '#e85b6e',
  initializing: '#e8a84c',
  busy: '#e8a84c',
  stopped: '#6b7084',
};

interface ObjectRow {
  id: AbjectId;
  name: string;
  state: string;
  isWorker: boolean;
  workerIndex?: number;
  constructorName?: string;
  isProtected: boolean;
}

export class ObjectManager extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private systemRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private supervisorId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private scrollableListId?: AbjectId;
  private searchInputId?: AbjectId;
  private summaryLabelId?: AbjectId;
  private refreshBtnId?: AbjectId;

  private searchText = '';

  // Button tracking: widget AbjectId → row index in current display
  private stopButtons: Map<AbjectId, number> = new Map();
  private restartButtons: Map<AbjectId, number> = new Map();
  private currentRows: ObjectRow[] = [];

  constructor() {
    super({
      manifest: {
        name: 'ObjectManager',
        description:
          'Process manager for running Abjects. Shows all objects with state, worker placement, and stop/restart actions.',
        version: '1.0.0',
        interfaces: [
          {
            id: OBJECT_MANAGER_INTERFACE,
            name: 'ObjectManager',
            description: 'Object process manager',
            methods: [
              {
                name: 'show',
                description: 'Show the object manager window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the object manager window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getState',
                description: 'Return current state',
                parameters: [],
                returns: { kind: 'object', properties: {
                  visible: { kind: 'primitive', primitive: 'boolean' },
                }},
              },
            ],
          },
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display process manager window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.discoverDep('Factory') ?? undefined;
    this.supervisorId = await this.discoverDep('Supervisor') ?? undefined;
    this.systemRegistryId = await this.discoverDep('SystemRegistry') ?? undefined;

    // Subscribe to registry events for auto-refresh
    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        REGISTRY_INTERFACE, 'subscribe', {}));
    }
    if (this.systemRegistryId) {
      try {
        await this.request(request(this.id, this.systemRegistryId,
          REGISTRY_INTERFACE, 'subscribe', {}));
      } catch { /* may not support subscribe */ }
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('getState', async () => {
      return { visible: !!this.windowId };
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click' && aspect !== 'change') return;
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });

    // Auto-refresh on registry changes
    this.on('objectRegistered', async () => {
      if (this.windowId) {
        await this.rebuildList();
      }
    });

    this.on('objectUnregistered', async () => {
      if (this.windowId) {
        await this.rebuildList();
      }
    });
  }

  // ── Data Fetching ──

  private async registryList(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, REGISTRY_INTERFACE, 'list', {})
    );
  }

  private async systemRegistryList(): Promise<ObjectRegistration[]> {
    if (!this.systemRegistryId) return [];
    try {
      return await this.request<ObjectRegistration[]>(
        request(this.id, this.systemRegistryId, REGISTRY_INTERFACE, 'list', {})
      );
    } catch {
      return [];
    }
  }

  /**
   * Query Factory for worker placement info about an object.
   */
  private async getObjectInfo(objectId: AbjectId): Promise<{
    isWorkerHosted: boolean;
    constructorName?: string;
    workerIndex?: number;
  }> {
    if (!this.factoryId) return { isWorkerHosted: false };
    try {
      return await this.request<{
        isWorkerHosted: boolean;
        constructorName?: string;
        workerIndex?: number;
      }>(request(this.id, this.factoryId, FACTORY_INTERFACE, 'getObjectInfo', { objectId }));
    } catch {
      return { isWorkerHosted: false };
    }
  }

  /**
   * Get supervisor children for constructor name lookup.
   */
  private async getSupervisorChildren(): Promise<Array<{
    id: AbjectId;
    constructorName: string;
  }>> {
    if (!this.supervisorId) return [];
    try {
      return await this.request<Array<{
        id: AbjectId;
        constructorName: string;
      }>>(request(this.id, this.supervisorId, SUPERVISOR_INTERFACE, 'getChildren', {}));
    } catch {
      return [];
    }
  }

  /**
   * Build the full list of ObjectRow data from both registries.
   */
  private async buildRows(): Promise<ObjectRow[]> {
    const [wsObjects, sysObjects, supervisorChildren] = await Promise.all([
      this.registryList(),
      this.systemRegistryList(),
      this.getSupervisorChildren(),
    ]);

    // Merge, deduplicating by ID (workspace objects take precedence)
    const seen = new Set<AbjectId>();
    const allObjects: ObjectRegistration[] = [];
    for (const obj of wsObjects) {
      seen.add(obj.id);
      allObjects.push(obj);
    }
    for (const obj of sysObjects) {
      if (!seen.has(obj.id)) {
        seen.add(obj.id);
        allObjects.push(obj);
      }
    }

    // Build supervisor lookup: objectId → constructorName
    const supervisorMap = new Map<AbjectId, string>();
    for (const child of supervisorChildren) {
      supervisorMap.set(child.id, child.constructorName);
    }

    // Fetch worker info for all objects in parallel
    const infoPromises = allObjects.map((obj) => this.getObjectInfo(obj.id));
    const infos = await Promise.all(infoPromises);

    const rows: ObjectRow[] = [];
    for (let i = 0; i < allObjects.length; i++) {
      const obj = allObjects[i];
      const info = infos[i];
      const name = obj.manifest.name;
      const state = obj.status?.state ?? 'ready';

      // Determine constructor name for restart
      const constructorName = supervisorMap.get(obj.id)
        ?? info.constructorName
        ?? name;

      rows.push({
        id: obj.id,
        name,
        state,
        isWorker: info.isWorkerHosted,
        workerIndex: info.workerIndex,
        constructorName,
        isProtected: PROTECTED_NAMES.has(name),
      });
    }

    // Sort: alphabetically by name
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  // ── Widget Helpers ──

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
  }

  private clearViewTracking(): void {
    this.rootLayoutId = undefined;
    this.scrollableListId = undefined;
    this.searchInputId = undefined;
    this.summaryLabelId = undefined;
    this.refreshBtnId = undefined;
    this.stopButtons.clear();
    this.restartButtons.clear();
    this.currentRows = [];
  }

  // ── Show / Hide ──

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    this.searchText = '';

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Object Manager',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    await this.populateView();
    await this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.clearViewTracking();
    await this.changed('visibility', false);
    return true;
  }

  // ── View Building ──

  /**
   * Build the full view: top bar, summary, header, scrollable list.
   */
  private async populateView(): Promise<void> {
    // Destroy old layout if any
    if (this.rootLayoutId && this.windowId) {
      try {
        await this.request(
          request(this.id, this.windowId, WINDOW_INTERFACE, 'removeChild', {
            widgetId: this.rootLayoutId,
          })
        );
      } catch { /* may be gone */ }
      try {
        await this.request(
          request(this.id, this.rootLayoutId, WIDGET_INTERFACE, 'destroy', {})
        );
      } catch { /* already gone */ }
    }
    this.clearViewTracking();

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId!,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // ── Top bar: Search + Refresh ──
    const topBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: topBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.searchInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId!, rect: r0, placeholder: 'Search objects...',
      })
    );
    await this.addDep(this.searchInputId);
    await this.request(request(this.id, topBarId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.searchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.refreshBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId!, rect: r0, text: 'Refresh',
        style: { fontSize: 12 },
      })
    );
    await this.addDep(this.refreshBtnId);
    await this.request(request(this.id, topBarId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.refreshBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 70, height: 30 },
    }));

    // ── Summary label ──
    this.summaryLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId!, rect: r0, text: '',
        style: { color: '#6b7084', fontSize: 11 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.summaryLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // ── Header row ──
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 20 },
    }));

    const headerStyle = { color: '#6b7084', fontSize: 11, fontWeight: 'bold' };
    const addHeaderLabel = async (text: string, width?: number): Promise<void> => {
      const labelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text, style: headerStyle,
        })
      );
      await this.request(request(this.id, headerRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: labelId,
        sizePolicy: { vertical: 'fixed', horizontal: width ? 'fixed' : 'expanding' },
        preferredSize: width ? { width, height: 20 } : { height: 20 },
      }));
    };

    await addHeaderLabel('Name');
    await addHeaderLabel('ID', 70);
    await addHeaderLabel('State', 70);
    await addHeaderLabel('Location', 80);
    await addHeaderLabel('Actions', 110);

    // ── Scrollable list ──
    this.scrollableListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 2,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.scrollableListId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Build and display rows
    await this.rebuildList();
  }

  /**
   * Rebuild the scrollable list rows from current data.
   */
  private async rebuildList(): Promise<void> {
    if (!this.scrollableListId) return;

    this.stopButtons.clear();
    this.restartButtons.clear();

    // Destroy and recreate the scrollable list to clear all children
    if (this.rootLayoutId) {
      try {
        await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'removeLayoutChild', {
          widgetId: this.scrollableListId,
        }));
      } catch { /* may be gone */ }
      try {
        await this.request(request(this.id, this.scrollableListId!, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* may be gone */ }

      this.scrollableListId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 2,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.scrollableListId,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
    }

    // Fetch fresh data
    const allRows = await this.buildRows();
    const query = this.searchText.toLowerCase();
    const filteredRows = query
      ? allRows.filter((r) => r.name.toLowerCase().includes(query))
      : allRows;

    this.currentRows = filteredRows;

    // Update summary
    const workerCount = allRows.filter((r) => r.isWorker).length;
    const summaryText = query
      ? `${filteredRows.length} of ${allRows.length} objects | ${workerCount} in workers`
      : `${allRows.length} objects | ${workerCount} in workers`;

    if (this.summaryLabelId) {
      try {
        await this.request(request(this.id, this.summaryLabelId, WIDGET_INTERFACE, 'update', {
          text: summaryText,
        }));
      } catch { /* widget gone */ }
    }

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const rowH = 26;

    for (let i = 0; i < filteredRows.length; i++) {
      const row = filteredRows[i];

      const rowLayoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.scrollableListId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 4,
        })
      );
      await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: rowLayoutId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: rowH },
      }));

      // Name (expanding)
      const nameLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text: row.name,
          style: { fontSize: 12, color: '#e2e4e9' },
        })
      );
      await this.request(request(this.id, rowLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: nameLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: rowH },
      }));

      // ID — first 8 chars (fixed 70px)
      const shortId = row.id.slice(0, 8);
      const idLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text: shortId,
          style: { fontSize: 11, color: '#6b7084' },
        })
      );
      await this.request(request(this.id, rowLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: idLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: 70, height: rowH },
      }));

      // State — color-coded (fixed 70px)
      const stateColor = STATE_COLORS[row.state] ?? '#6b7084';
      const stateLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text: row.state,
          style: { fontSize: 11, color: stateColor },
        })
      );
      await this.request(request(this.id, rowLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: stateLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: 70, height: rowH },
      }));

      // Location — "Main" or "Worker N" (fixed 80px)
      const location = row.isWorker
        ? `Worker ${row.workerIndex ?? '?'}`
        : 'Main';
      const locLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text: location,
          style: { fontSize: 11, color: '#8b8fa3' },
        })
      );
      await this.request(request(this.id, rowLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: locLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: 80, height: rowH },
      }));

      // Actions (fixed 110px)
      if (row.isProtected) {
        const protectedLabelId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
            windowId: this.windowId!, rect: r0, text: 'protected',
            style: { fontSize: 10, color: '#6b7084', fontStyle: 'italic' },
          })
        );
        await this.request(request(this.id, rowLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: protectedLabelId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 110, height: rowH },
        }));
      } else {
        // Actions HBox: Stop + Restart
        const actionsRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
            parentLayoutId: rowLayoutId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 4,
          })
        );
        await this.request(request(this.id, rowLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: actionsRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 110, height: rowH },
        }));

        const stopBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId!, rect: r0, text: 'Stop',
            style: { fontSize: 10, background: '#c0392b', color: '#ffffff', borderColor: '#c0392b' },
          })
        );
        await this.addDep(stopBtnId);
        this.stopButtons.set(stopBtnId, i);
        await this.request(request(this.id, actionsRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: stopBtnId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: rowH },
        }));

        const restartBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId!, rect: r0, text: 'Restart',
            style: { fontSize: 10 },
          })
        );
        await this.addDep(restartBtnId);
        this.restartButtons.set(restartBtnId, i);
        await this.request(request(this.id, actionsRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: restartBtnId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: rowH },
        }));
      }
    }
  }

  // ── Event Handling ──

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Search input
    if (fromId === this.searchInputId && aspect === 'change') {
      this.searchText = (value as string) ?? '';
      await this.rebuildList();
      return;
    }

    // Refresh button
    if (fromId === this.refreshBtnId && aspect === 'click') {
      await this.rebuildList();
      return;
    }

    // Stop button
    const stopIdx = this.stopButtons.get(fromId);
    if (stopIdx !== undefined) {
      const row = this.currentRows[stopIdx];
      if (row && this.factoryId) {
        try {
          await this.request(request(this.id, this.factoryId,
            FACTORY_INTERFACE, 'kill', { objectId: row.id }));
        } catch { /* object may already be gone */ }
        await this.rebuildList();
      }
      return;
    }

    // Restart button
    const restartIdx = this.restartButtons.get(fromId);
    if (restartIdx !== undefined) {
      const row = this.currentRows[restartIdx];
      if (row && this.factoryId) {
        const constructorName = row.constructorName ?? row.name;
        try {
          await this.request(request(this.id, this.factoryId,
            FACTORY_INTERFACE, 'respawn', { objectId: row.id, constructorName }));
        } catch (err) {
          console.warn(`[ObjectManager] Failed to restart ${row.name}:`, err);
        }
        await this.rebuildList();
      }
      return;
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## ObjectManager Usage Guide

### Methods
- \`show()\` — Open the object manager window. Shows all running objects.
- \`hide()\` — Close the object manager window.
- \`getState()\` — Returns { visible: boolean }.

### Features
- Scrollable table showing all objects: Name, ID (first 8 chars), State (color-coded), Location (Main/Worker N), and Actions (Stop/Restart).
- Search input filters by object name (case-insensitive).
- Protected system objects (Registry, Factory, Supervisor, etc.) show "protected" instead of action buttons.
- Stop kills the object via Factory. Restart respawns it with same ID.
- Auto-refreshes on registry changes. Manual Refresh button available.

### Interface ID
\`abjects:object-manager\``;
  }
}

export const OBJECT_MANAGER_ID = 'abjects:object-manager' as AbjectId;
