/**
 * ProcessExplorer — process/task manager for Abjects.
 *
 * Shows a scrollable table of all running objects with name, ID, state,
 * worker placement, and stop/restart actions. System-level UI object
 * discoverable by GlobalToolbar.
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
import { Log } from '../core/timed-log.js';

const log = new Log('ProcessExplorer');

const PROCESS_EXPLORER_INTERFACE: InterfaceId = 'abjects:process-explorer';

const WIN_W = 650;
const WIN_H = 500;

/** Names of protected objects that cannot be stopped or restarted. */
const PROTECTED_NAMES = new Set([
  'Registry', 'Factory', 'Supervisor', 'WidgetManager', 'WindowManager',
  'WorkspaceManager', 'WorkspaceRegistry', 'WorkspaceSwitcher', 'UIServer',
  'ProcessExplorer',
]);

/** Names removed — state colors now come from this.theme via stateColor(). */

interface ObjectRow {
  id: AbjectId;
  name: string;
  state: string;
  isWorker: boolean;
  workerIndex?: number;
  constructorName?: string;
  isProtected: boolean;
}

export class ProcessExplorer extends Abject {
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
        name: 'ProcessExplorer',
        description:
          'Process manager for running Abjects. Shows all objects with state, worker placement, and stop/restart actions.',
        version: '1.0.0',
        interface: {
            id: PROCESS_EXPLORER_INTERFACE,
            name: 'ProcessExplorer',
            description: 'Process explorer',
            methods: [
              {
                name: 'show',
                description: 'Show the process explorer window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the process explorer window',
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
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display process explorer window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  /** Map object state → theme color. */
  private stateColor(state: string): string {
    switch (state) {
      case 'ready': return this.theme.statusSuccess;
      case 'error': return this.theme.statusError;
      case 'initializing':
      case 'busy': return this.theme.statusWarning;
      case 'stopped': return this.theme.statusNeutral;
      default: return this.theme.statusNeutral;
    }
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.discoverDep('Factory') ?? undefined;
    this.supervisorId = await this.discoverDep('Supervisor') ?? undefined;
    this.systemRegistryId = await this.discoverDep('SystemRegistry') ?? undefined;

    // Subscribe to registry events for auto-refresh
    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        'subscribe', {}));
    }
    if (this.systemRegistryId) {
      try {
        await this.request(request(this.id, this.systemRegistryId,
          'subscribe', {}));
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
      request(this.id, this.registryId, 'list', {})
    );
  }

  private async systemRegistryList(): Promise<ObjectRegistration[]> {
    if (!this.systemRegistryId) return [];
    try {
      return await this.request<ObjectRegistration[]>(
        request(this.id, this.systemRegistryId, 'list', {})
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
      }>(request(this.id, this.factoryId, 'getObjectInfo', { objectId }));
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
      }>>(request(this.id, this.supervisorId, 'getChildren', {}));
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
    await this.request(request(this.id, widgetId, 'addDependent', {}));
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
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\u2699\uFE0F Process Explorer',
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
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
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
          request(this.id, this.windowId, 'removeChild', {
            widgetId: this.rootLayoutId,
          })
        );
      } catch { /* may be gone */ }
      try {
        await this.request(
          request(this.id, this.rootLayoutId, 'destroy', {})
        );
      } catch { /* already gone */ }
    }
    this.clearViewTracking();

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId!,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // ── Top bar: Search + Refresh ──
    const topBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: topBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const { widgetIds: [searchId, refreshId, summaryId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId!, placeholder: 'Search objects...' },
          { type: 'button', windowId: this.windowId!, text: 'Refresh', style: { fontSize: 12 } },
          { type: 'label', windowId: this.windowId!, text: '', style: { color: this.theme.sectionLabel, fontSize: 11 } },
        ],
      })
    );
    this.searchInputId = searchId;
    this.refreshBtnId = refreshId;
    this.summaryLabelId = summaryId;

    await this.addDep(this.searchInputId);
    await this.request(request(this.id, topBarId, 'addLayoutChild', {
      widgetId: this.searchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    await this.addDep(this.refreshBtnId);
    await this.request(request(this.id, topBarId, 'addLayoutChild', {
      widgetId: this.refreshBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 70, height: 30 },
    }));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.summaryLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // ── Header row ──
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 20 },
    }));

    const headerStyle = { color: this.theme.sectionLabel, fontSize: 11, fontWeight: 'bold' };
    const headerTexts = ['Name', 'ID', 'State', 'Location', 'Actions'];
    const headerWidths: Array<number | undefined> = [undefined, 70, 70, 80, 110];

    const { widgetIds: headerLabelIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: headerTexts.map((text) => ({
          type: 'label' as const, windowId: this.windowId!, text, style: headerStyle,
        })),
      })
    );

    for (let h = 0; h < headerLabelIds.length; h++) {
      const width = headerWidths[h];
      await this.request(request(this.id, headerRowId, 'addLayoutChild', {
        widgetId: headerLabelIds[h],
        sizePolicy: { vertical: 'fixed', horizontal: width ? 'fixed' : 'expanding' },
        preferredSize: width ? { width, height: 20 } : { height: 20 },
      }));
    }

    // ── Scrollable list ──
    this.scrollableListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 2,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
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
        await this.request(request(this.id, this.rootLayoutId, 'removeLayoutChild', {
          widgetId: this.scrollableListId,
        }));
      } catch { /* may be gone */ }
      try {
        await this.request(request(this.id, this.scrollableListId!, 'destroy', {}));
      } catch { /* may be gone */ }

      this.scrollableListId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 2,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
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
        await this.request(request(this.id, this.summaryLabelId, 'update', {
          text: summaryText,
        }));
      } catch { /* widget gone */ }
    }

    const rowH = 26;

    for (let i = 0; i < filteredRows.length; i++) {
      const row = filteredRows[i];

      const rowLayoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: this.scrollableListId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 4,
        })
      );
      await this.request(request(this.id, this.scrollableListId, 'addLayoutChild', {
        widgetId: rowLayoutId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: rowH },
      }));

      // Batch-create the 4 data labels for each row
      const shortId = row.id.slice(0, 8);
      const stateColor = this.stateColor(row.state);
      const location = row.isWorker
        ? `Worker ${row.workerIndex ?? '?'}`
        : 'Main';

      const { widgetIds: [nameLabelId, idLabelId, stateLabelId, locLabelId] } =
        await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', {
            specs: [
              { type: 'label', windowId: this.windowId!, text: row.name, style: { fontSize: 12, color: this.theme.textHeading } },
              { type: 'label', windowId: this.windowId!, text: shortId, style: { fontSize: 11, color: this.theme.sectionLabel } },
              { type: 'label', windowId: this.windowId!, text: row.state, style: { fontSize: 11, color: stateColor } },
              { type: 'label', windowId: this.windowId!, text: location, style: { fontSize: 11, color: this.theme.textMeta } },
            ],
          })
        );

      // Name (expanding)
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: nameLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: rowH },
      }));

      // ID (fixed 70px)
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: idLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: 70, height: rowH },
      }));

      // State (fixed 70px)
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: stateLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: 70, height: rowH },
      }));

      // Location (fixed 80px)
      await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
        widgetId: locLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: 80, height: rowH },
      }));

      // Actions (fixed 110px)
      if (row.isProtected) {
        const { widgetIds: [protectedLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', {
            specs: [
              { type: 'label', windowId: this.windowId!, text: 'protected', style: { fontSize: 10, color: this.theme.sectionLabel, fontStyle: 'italic' } },
            ],
          })
        );
        await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
          widgetId: protectedLabelId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 110, height: rowH },
        }));
      } else {
        // Actions HBox: Stop + Restart
        const actionsRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: rowLayoutId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 4,
          })
        );
        await this.request(request(this.id, rowLayoutId, 'addLayoutChild', {
          widgetId: actionsRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 110, height: rowH },
        }));

        const { widgetIds: [stopBtnId, restartBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', {
            specs: [
              { type: 'button', windowId: this.windowId!, text: 'Stop', style: { fontSize: 10, background: this.theme.destructiveText, color: '#ffffff', borderColor: this.theme.destructiveText } },
              { type: 'button', windowId: this.windowId!, text: 'Restart', style: { fontSize: 10 } },
            ],
          })
        );

        await this.addDep(stopBtnId);
        this.stopButtons.set(stopBtnId, i);
        await this.request(request(this.id, actionsRowId, 'addLayoutChild', {
          widgetId: stopBtnId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: rowH },
        }));

        await this.addDep(restartBtnId);
        this.restartButtons.set(restartBtnId, i);
        await this.request(request(this.id, actionsRowId, 'addLayoutChild', {
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
        const confirmed = await this.confirm({
          title: 'Stop Object',
          message: `Stop "${row.name}"? This will kill the running object.`,
          confirmLabel: 'Stop',
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await this.request(request(this.id, this.factoryId,
            'kill', { objectId: row.id }));
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
            'respawn', { objectId: row.id, constructorName, registryId: this.registryId }));
        } catch (err) {
          log.warn(`Failed to restart ${row.name}:`, err);
        }
        await this.rebuildList();
      }
      return;
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## ProcessExplorer Usage Guide

### Methods
- \`show()\` — Open the process explorer window. Shows all running objects.
- \`hide()\` — Close the process explorer window.
- \`getState()\` — Returns { visible: boolean }.

### Features
- Scrollable table showing all objects: Name, ID (first 8 chars), State (color-coded), Location (Main/Worker N), and Actions (Stop/Restart).
- Search input filters by object name (case-insensitive).
- Protected system objects (Registry, Factory, Supervisor, etc.) show "protected" instead of action buttons.
- Stop kills the object via Factory. Restart respawns it with same ID.
- Auto-refreshes on registry changes. Manual Refresh button available.

### Interface ID
\`abjects:process-explorer\``;
  }
}

export const PROCESS_EXPLORER_ID = 'abjects:process-explorer' as AbjectId;
