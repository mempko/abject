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
import { chromeCase, type ThemeData } from '../core/theme-data.js';
import { emptyStateMarkdown, emptyStateStyle, livingStyle } from './ui-kit.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { ensure, invariant } from '../core/contracts.js';

/** Filled destructive button style from the theme's destructive slots. */
function destructiveFillStyle(theme: ThemeData): { background: string; color: string; borderColor: string } {
  return { background: theme.destructiveBg, color: theme.destructiveText, borderColor: theme.destructiveBorder };
}

const log = new Log('ProcessExplorer');

const PROCESS_EXPLORER_INTERFACE: InterfaceId = 'abjects:process-explorer';

const WIN_W = 650;
const WIN_H = 500;

/**
 * How often the heap strip re-reads while the window is open. Matched to the
 * monitor's own poll: reading faster only redraws the same numbers.
 */
const HEAP_STRIP_REFRESH_MS = 15_000;

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

/** One isolate's heap reading, as HeapMonitor reports it. */
interface HeapWatch {
  source: string;
  workerIndex?: number;
  fraction: number;
  regime: string;
  sample: { usedBytes: number; limitBytes: number };
}

/** How long a lost worker stays on the map (ghosted, spotlit) after it vanishes. */
const LOST_ISOLATE_MS = 12_000;

/** The isolate an object runs in, as a map group id ('main', 'w0', 'w1', ...). */
function isolateOfRow(row: ObjectRow): string {
  return row.isWorker ? `w${row.workerIndex ?? '?'}` : 'main';
}

/** The isolate a heap reading describes, as a map group id. */
function isolateOfWatch(w: { source: string; workerIndex?: number }): string {
  if (w.source === 'main' || w.workerIndex === undefined) return w.source === 'main' ? 'main' : w.source.replace('worker-', 'w');
  return `w${w.workerIndex}`;
}

export class ProcessExplorer extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private systemRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private supervisorId?: AbjectId;
  private heapMonitorId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private scrollableListId?: AbjectId;
  private searchInputId?: AbjectId;
  private summaryLabelId?: AbjectId;
  private refreshBtnId?: AbjectId;
  /** Row holding the per-isolate heap readings, one label each. */
  private heapRowId?: AbjectId;
  private heapLabelIds: AbjectId[] = [];
  private heapTimer?: ReturnType<typeof setInterval>;
  /** What the strip currently reads, so getState can report it as text. */
  private heapStripText: string[] = [];
  /**
   * Regime per isolate at the previous heap reading (source -> regime), so an
   * isolate crossing into critical, or a worker vanishing, is seen once.
   */
  private heapRegimes: Map<string, string> = new Map();

  private searchText = '';

  // Button tracking: widget AbjectId → row index in current display
  private stopButtons: Map<AbjectId, number> = new Map();
  private restartButtons: Map<AbjectId, number> = new Map();
  private currentRows: ObjectRow[] = [];

  // ── Map view (a nodeGraph beside the table: objects clustered by isolate) ──
  /** True while the map shows in place of the table. */
  private mapMode = false;
  private mapToggleId?: AbjectId;
  /** The table's column header band (hidden with the table). */
  private headerRowId?: AbjectId;
  private mapBoxId?: AbjectId;
  private mapGraphId?: AbjectId;
  private mapDetailLabelId?: AbjectId;
  private mapStopBtnId?: AbjectId;
  private mapRestartBtnId?: AbjectId;
  /** Rows the map shows (the search filter applies to both views). */
  private mapRows: ObjectRow[] = [];
  /** Selected map node id (`obj:<id>` or `iso:<isolate>`); marked in the table too. */
  private mapSelectedId?: string;
  /** The table missed changes while the map showed; rebuilt when it returns. */
  private tableStale = false;
  /** The last heap readings (hub sizes and colours). */
  private heapWatches: HeapWatch[] = [];
  /** Isolates that vanished recently (isolate -> when), ghosted and spotlit on the map. */
  private lostIsolates: Map<string, number> = new Map();
  /** True while the map spotlights a lost isolate. */
  private mapSpotlit = false;
  /** WorkerRecovery, heard while the window is open: it reports each worker death. */
  private workerRecoveryId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'ProcessExplorer',
        description:
          'Process manager for running Abjects. Shows all Abjects with state, worker placement, and stop/restart actions.',
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
                  heap: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                }},
              },
            ],
          },
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  /** Map object state → theme color. */
  private stateColor(state: string): string {
    // Running and busy objects are alive (living light), stopped ones are
    // idle (meta), errors stay in the error slot.
    switch (state) {
      case 'ready':
      case 'busy': return livingStyle(this.theme).color as string;
      case 'error': return this.theme.statusError;
      case 'initializing': return this.theme.statusWarning;
      default: return this.theme.textMeta;
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
      // The heap strip is reported as text, not just drawn: a caller without
      // a screen — the CLI, an agent, whatever is asking why a worker died —
      // should be able to read what the window is showing.
      return { visible: !!this.windowId, heap: [...this.heapStripText] };
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      if (fromId === this.workerRecoveryId && aspect === 'recovered') {
        await this.onWorkerRecovered(value);
        return;
      }
      if (fromId === this.mapGraphId && (aspect === 'nodeSelected' || aspect === 'nodeFocused')) {
        await this.onMapSelection(value);
        return;
      }
      if (aspect !== 'click' && aspect !== 'change') return;
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
    this.heapRowId = undefined;
    this.heapLabelIds = [];
    this.heapStripText = [];
    this.heapRegimes.clear();
    this.stopButtons.clear();
    this.restartButtons.clear();
    this.currentRows = [];
    this.mapMode = false;
    this.mapToggleId = undefined;
    this.headerRowId = undefined;
    this.mapBoxId = undefined;
    this.mapGraphId = undefined;
    this.mapDetailLabelId = undefined;
    this.mapStopBtnId = undefined;
    this.mapRestartBtnId = undefined;
    this.mapRows = [];
    this.mapSelectedId = undefined;
    this.tableStale = false;
    this.heapWatches = [];
    this.lostIsolates.clear();
    this.mapSpotlit = false;
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
        title: 'Process Explorer',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    await this.populateView();
    // Autofocus the filter input so the user can start typing immediately.
    if (this.windowId && this.searchInputId && this.rootLayoutId) {
      try {
        await this.request(request(this.id, this.windowId, 'focusChild', {
          widgetId: this.searchInputId,
          parentChildId: this.rootLayoutId,
        }));
      } catch { /* window gone */ }
    }
    // Heap moves on its own, so the strip refreshes on its own. A reading you
    // have to ask for is no use for noticing a slow climb, which is the whole
    // point of showing it. Managed, so hide() and stop() both end it.
    this.heapTimer = this.setRecurringTimer(() => { void this.refreshHeapStrip(); }, HEAP_STRIP_REFRESH_MS);
    // A worker that dies is replaced at once, often before the next heap
    // reading could miss it; WorkerRecovery says so when it has rebuilt.
    this.workerRecoveryId = await this.resolveDep('WorkerRecovery', this.workerRecoveryId);
    if (this.workerRecoveryId) this.send(request(this.id, this.workerRecoveryId, 'addDependent', {}));

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.cancelTimer(this.heapTimer);
    this.heapTimer = undefined;
    if (this.workerRecoveryId) this.send(request(this.id, this.workerRecoveryId, 'removeDependent', {}));

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.clearViewTracking();
    this.changed('visibility', false);
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

    const { widgetIds: [searchId, refreshId, summaryId, mapToggleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId!, placeholder: 'Search objects...' },
          { type: 'button', windowId: this.windowId!, text: 'Refresh', style: { fontSize: 12 } },
          { type: 'label', windowId: this.windowId!, text: '', style: { color: this.theme.sectionLabel, fontSize: 11 } },
          // Map view: the same objects as a 3D map, clustered by isolate.
          { type: 'checkbox', windowId: this.windowId!, checked: false, text: 'Map' },
        ],
      })
    );
    this.searchInputId = searchId;
    this.refreshBtnId = refreshId;
    this.summaryLabelId = summaryId;
    this.mapToggleId = mapToggleId;

    await this.addDep(this.searchInputId);
    await this.request(request(this.id, topBarId, 'addLayoutChild', {
      widgetId: this.searchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    await this.addDep(this.mapToggleId);
    await this.request(request(this.id, topBarId, 'addLayoutChild', {
      widgetId: this.mapToggleId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 70, height: 30 },
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

    // ── Heap strip ──
    // Above the list because it describes the isolates the listed objects sit
    // in, not the objects themselves: a worker climbing toward its ceiling is
    // about to take every object hosted there with it.
    this.heapRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 10,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.heapRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));
    await this.refreshHeapStrip();

    // ── Header row ──
    // A solid band with inverted display type, matching the kit's table
    // header; the insets line the columns up with the row cells below (rows
    // pad 6px each side).
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 6, bottom: 0, left: 6 },
        spacing: 4,
        style: { background: this.theme.textPrimary, radius: this.theme.widgetRadius },
      })
    );
    this.headerRowId = headerRowId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 22 },
    }));

    const headerStyle = { color: this.theme.windowBg, fontSize: 11, fontWeight: 'bold', fontFamily: 'display' };
    const headerTexts = ['Name', 'ID', 'State', 'Location', 'Actions'].map((t) => chromeCase(this.theme, t));
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
   * Heap pressure per isolate, as one label each so a hot one can carry its
   * own colour.
   *
   * Labels are updated in place when the isolate count is unchanged — the
   * common case, since a replaced worker keeps its slot. They are only torn
   * down and rebuilt when the count actually differs, because a nested box
   * adds itself to its parent at creation, so recreating the row wholesale
   * would move it below the list it is meant to sit above.
   */
  private async refreshHeapStrip(): Promise<void> {
    if (!this.heapRowId || !this.windowId) return;
    // Resolved here rather than in onInit: the monitor is spawned after this
    // object during bootstrap, so binding it at init finds nothing and the
    // strip stays empty for the life of the process. Resolving on use also
    // survives the monitor being restarted under it.
    this.heapMonitorId = await this.resolveDep('HeapMonitor', this.heapMonitorId);
    if (!this.heapMonitorId) return;

    let watches: Array<{ source: string; workerIndex?: number; fraction: number; regime: string;
      sample: { usedBytes: number; limitBytes: number } }> = [];
    try {
      const state = await this.request<{ watches: typeof watches }>(
        request(this.id, this.heapMonitorId, 'getState', {})
      );
      watches = state?.watches ?? [];
    } catch {
      return; // The monitor is a diagnostic; its absence must not break this view.
    }

    // Main first, then workers in slot order, so a reading stays in the same
    // place between refreshes and the eye can track one column.
    watches.sort((a, b) => {
      if (a.workerIndex === undefined) return -1;
      if (b.workerIndex === undefined) return 1;
      return a.workerIndex - b.workerIndex;
    });

    const specs = watches.map((w) => ({
      text: this.heapLabelText(w),
      style: { fontSize: 11, color: this.heapColor(w.regime) },
    }));
    this.heapStripText = specs.map((s) => s.text);
    this.signalHeapChanges(watches);
    // The map's isolate hubs read the same numbers, on the same cadence.
    this.heapWatches = watches;
    if (this.mapMode) await this.syncProcessMap();

    if (specs.length !== this.heapLabelIds.length) {
      for (const id of this.heapLabelIds) {
        try {
          await this.request(request(this.id, this.heapRowId, 'removeLayoutChild', { widgetId: id }));
        } catch { /* already detached */ }
        try {
          await this.request(request(this.id, id, 'destroy', {}));
        } catch { /* already gone */ }
      }
      this.heapLabelIds = [];
      if (specs.length === 0) return;

      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: specs.map((s) => ({ type: 'label' as const, windowId: this.windowId!, ...s })),
        })
      );
      this.heapLabelIds = widgetIds;
      for (const widgetId of widgetIds) {
        await this.request(request(this.id, this.heapRowId, 'addLayoutChild', {
          widgetId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: 96, height: 18 },
        }));
      }
      return;
    }

    for (let i = 0; i < specs.length; i++) {
      try {
        await this.request(request(this.id, this.heapLabelIds[i], 'update', specs[i]));
      } catch { /* widget gone; the next rebuild picks it up */ }
    }
  }

  /**
   * e.g. `main 1.0% 46MB` — the fraction leads, since that is what matters.
   *
   * A decimal below 10% because against an 8GB ceiling a healthy worker sits
   * near 0.4%, and a whole-number strip reading `0%` nine times looks broken
   * rather than calm. Above 10% the decimal stops earning its width.
   */
  private heapLabelText(w: { source: string; fraction: number;
    sample: { usedBytes: number } }): string {
    const pct = w.fraction * 100;
    const shown = pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
    const mb = Math.round(w.sample.usedBytes / (1024 * 1024));
    const name = w.source === 'main' ? 'main' : w.source.replace('worker-', 'w');
    return `${name} ${shown}% ${mb}MB`;
  }

  /**
   * Compare this heap reading with the previous one. An isolate that has just
   * entered the critical regime pulses the window for attention; a worker
   * isolate that has vanished from the readings glitches it, since every
   * object it hosted went down with it.
   */
  private signalHeapChanges(watches: Array<{ source: string; regime: string }>): void {
    const next = new Map(watches.map((w) => [w.source, w.regime] as [string, string]));
    const hadReading = this.heapRegimes.size > 0;
    const workerLost = hadReading
      && [...this.heapRegimes.keys()].some((source) => source !== 'main' && !next.has(source));
    const turnedCritical = watches.some(
      (w) => w.regime === 'critical' && this.heapRegimes.get(w.source) !== 'critical',
    );
    // The map keeps a lost worker a while, ghosted and spotlit with the
    // objects it hosted, so the eye finds what went down.
    const now = Date.now();
    for (const [isolate, at] of this.lostIsolates) if (now - at > LOST_ISOLATE_MS) this.lostIsolates.delete(isolate);
    let newlyLost = false;
    if (workerLost) {
      for (const source of this.heapRegimes.keys()) {
        if (source === 'main' || next.has(source)) continue;
        const was = this.heapWatches.find((w) => w.source === source);
        const isolate = isolateOfWatch(was ?? { source });
        // WorkerRecovery may have reported this loss already.
        if (!this.lostIsolates.has(isolate)) newlyLost = true;
        this.lostIsolates.set(isolate, now);
      }
    }
    this.heapRegimes = next;
    if (newlyLost) this.windowEffect('glitch', '$statusError');
    else if (turnedCritical) this.windowEffect('pulse', '$statusError');
  }

  /**
   * Play a one-shot slab effect on the window (visual only). Fire and forget:
   * a window that closed meanwhile simply misses it.
   */
  private windowEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
  }

  private heapColor(regime: string): string {
    switch (regime) {
      case 'critical': return this.theme.statusError;
      case 'elevated': return this.theme.statusWarning;
      default: return this.theme.textMeta;
    }
  }

  /**
   * Rebuild the scrollable list rows from current data.
   */
  private async rebuildList(): Promise<void> {
    if (!this.scrollableListId) return;

    // While the map shows, the same fresh rows feed the map (one setGraph)
    // and the hidden table is rebuilt when it comes back.
    if (this.mapMode) {
      const allRows = await this.buildRows();
      const query = this.searchText.toLowerCase();
      this.mapRows = query ? allRows.filter((r) => r.name.toLowerCase().includes(query)) : allRows;
      await this.updateSummary(allRows, this.mapRows.length, query);
      this.tableStale = true;
      await this.syncProcessMap();
      return;
    }
    this.tableStale = false;

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
    this.mapRows = filteredRows;

    await this.updateSummary(allRows, filteredRows.length, query);

    const rowH = 26;

    if (filteredRows.length === 0) {
      const text = query
        ? emptyStateMarkdown('No matching objects', `Nothing running is named like "${this.searchText}". Clear the search to see every object.`)
        : emptyStateMarkdown('No objects yet', 'Running Abjects appear here as they spawn. Press Refresh to check again.');
      const { widgetIds: [emptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [{ type: 'label', windowId: this.windowId!, text, style: emptyStateStyle(this.theme) }],
        })
      );
      await this.request(request(this.id, this.scrollableListId, 'addLayoutChild', {
        widgetId: emptyId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 80 },
      }));
      return;
    }

    for (let i = 0; i < filteredRows.length; i++) {
      const row = filteredRows[i];

      const rowLayoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: this.scrollableListId,
          margins: { top: 0, right: 6, bottom: 0, left: 6 },
          spacing: 4,
          // The object selected on the map wears the accent here too.
          style: {
            background: this.theme.inputBg,
            borderColor: this.mapSelectedId === `obj:${row.id}` ? this.theme.accent : this.theme.inputBorder,
            radius: this.theme.widgetRadius,
          },
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
              { type: 'label', windowId: this.windowId!, text: row.name, style: { fontSize: 12, color: this.theme.textHeading, selectable: true } },
              { type: 'label', windowId: this.windowId!, text: shortId, style: { fontSize: 11, color: this.theme.sectionLabel, selectable: true } },
              { type: 'label', windowId: this.windowId!, text: row.state, style: { fontSize: 11, color: stateColor, selectable: true, ...(row.state === 'busy' ? { fontWeight: 'bold' } : {}) } },
              { type: 'label', windowId: this.windowId!, text: location, style: { fontSize: 11, color: this.theme.textMeta, selectable: true } },
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
              { type: 'button', windowId: this.windowId!, text: 'Stop', style: { fontSize: 10, ...destructiveFillStyle(this.theme) } },
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
      await this.refreshHeapStrip();
      return;
    }

    // Map toggle: the map shows in place of the table, or the table returns.
    if (fromId === this.mapToggleId && aspect === 'change') {
      await this.setMapMode(value === true || value === 'true');
      return;
    }

    // Stop button
    const stopIdx = this.stopButtons.get(fromId);
    if (stopIdx !== undefined) {
      const row = this.currentRows[stopIdx];
      if (row) await this.stopRow(row, fromId);
      return;
    }

    // Restart button
    const restartIdx = this.restartButtons.get(fromId);
    if (restartIdx !== undefined) {
      const row = this.currentRows[restartIdx];
      if (row) await this.restartRow(row, fromId);
      return;
    }

    // The map's selection strip: Stop / Restart the selected object.
    if ((fromId === this.mapStopBtnId || fromId === this.mapRestartBtnId) && aspect === 'click') {
      const row = this.selectedMapRow();
      if (!row || row.isProtected) return;
      if (fromId === this.mapStopBtnId) await this.stopRow(row, fromId);
      else await this.restartRow(row, fromId);
      return;
    }
  }

  /** Stop an object (after the user confirms), then refresh the view. */
  private async stopRow(row: ObjectRow, buttonId: AbjectId): Promise<void> {
    if (!this.factoryId) return;
    const confirmed = await this.confirm({
      title: 'Stop Abject',
      message: `Stop "${row.name}"? This will kill the running Abject.`,
      confirmLabel: 'Stop',
      destructive: true,
    });
    if (!confirmed) return;
    this.send(event(this.id, buttonId, 'update', { busy: true }));
    try {
      await this.request(request(this.id, this.factoryId,
        'kill', { objectId: row.id }));
      this.windowEffect('flash', '$accent');
      await this.notify(`Stopped "${row.name}"`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.windowEffect('shake');
      await this.notify(`Stop failed: ${msg.slice(0, 80)}`, 'error');
    } finally {
      this.send(event(this.id, buttonId, 'update', { busy: false }));
    }
    await this.rebuildList();
  }

  /** Respawn an object with the same id, then refresh the view. */
  private async restartRow(row: ObjectRow, buttonId: AbjectId): Promise<void> {
    if (!this.factoryId) return;
    const constructorName = row.constructorName ?? row.name;
    this.send(event(this.id, buttonId, 'update', { busy: true }));
    try {
      await this.request(request(this.id, this.factoryId,
        'respawn', { objectId: row.id, constructorName, registryId: this.registryId }));
      // The object is alive again: flash in the living light.
      this.windowEffect('flash');
      await this.notify(`Restarted "${row.name}"`, 'success');
    } catch (err) {
      log.warn(`Failed to restart ${row.name}:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      this.windowEffect('shake');
      await this.notify(`Restart failed: ${msg.slice(0, 80)}`, 'error');
    } finally {
      this.send(event(this.id, buttonId, 'update', { busy: false }));
    }
    await this.rebuildList();
  }

  /** Summary line over the table and the map. */
  private async updateSummary(allRows: ObjectRow[], shown: number, query: string): Promise<void> {
    if (!this.summaryLabelId) return;
    const workerCount = allRows.filter((r) => r.isWorker).length;
    const text = query
      ? `${shown} of ${allRows.length} objects | ${workerCount} in workers`
      : `${allRows.length} objects | ${workerCount} in workers`;
    try {
      await this.request(request(this.id, this.summaryLabelId, 'update', { text }));
    } catch { /* widget gone */ }
  }

  // ── Map view ──

  /**
   * Show the map in place of the table, or bring the table back. The map is
   * built on first use; the table, if it went stale while hidden, is rebuilt
   * from fresh rows when it returns.
   */
  private async setMapMode(on: boolean): Promise<void> {
    if (!this.windowId || !this.rootLayoutId || on === this.mapMode) return;
    this.mapMode = on;
    const show = (id: AbjectId | undefined, visible: boolean) => id
      ? this.request(request(this.id, id, 'update', { style: { visible } })).catch(() => { /* gone */ })
      : Promise.resolve();
    if (on) {
      if (!this.mapBoxId) await this.buildMapBox();
      await show(this.headerRowId, false);
      await show(this.scrollableListId, false);
      await show(this.mapBoxId, true);
      await this.syncProcessMap();
      await this.updateMapDetail();
    } else {
      await show(this.mapBoxId, false);
      await show(this.headerRowId, true);
      if (this.tableStale) await this.rebuildList();
      else await show(this.scrollableListId, true);
    }
    ensure(this.mapMode === on, 'map mode follows the toggle');
  }

  /** The map area: the graph, then a strip naming the selection with its actions. */
  private async buildMapBox(): Promise<void> {
    this.mapBoxId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId!,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: this.mapBoxId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    const { widgetIds: [graphId, detailId, stopId, restartId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'nodeGraph', windowId: this.windowId!, title: 'Objects by isolate',
            emptyText: 'No objects to map', directed: false,
            hint: 'Drag to turn · wheel to zoom · click an object to act on it',
          },
          { type: 'label', windowId: this.windowId!, text: '', style: { fontSize: 11, color: this.theme.textMeta, selectable: true } },
          { type: 'button', windowId: this.windowId!, text: 'Stop', style: { fontSize: 10, ...destructiveFillStyle(this.theme), visible: false } },
          { type: 'button', windowId: this.windowId!, text: 'Restart', style: { fontSize: 10, visible: false } },
        ],
      })
    );
    this.mapGraphId = graphId;
    this.mapDetailLabelId = detailId;
    this.mapStopBtnId = stopId;
    this.mapRestartBtnId = restartId;
    await this.request(request(this.id, this.mapBoxId, 'addLayoutChild', {
      widgetId: graphId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    const stripId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.mapBoxId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.mapBoxId, 'addLayoutChild', {
      widgetId: stripId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 26 },
    }));
    await this.request(request(this.id, stripId, 'addLayoutChildren', {
      children: [
        { widgetId: detailId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 26 } },
        { widgetId: stopId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 56, height: 24 } },
        { widgetId: restartId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 64, height: 24 } },
      ],
    }));
    for (const id of [graphId, stopId, restartId]) await this.addDep(id);
  }

  /** Map node id of an isolate hub. */
  private static hubId(isolate: string): string {
    return `iso:${isolate}`;
  }

  /** Legend name of an isolate. */
  private static isolateName(isolate: string): string {
    return isolate === 'main' ? 'Main thread' : `Worker ${isolate.slice(1)}`;
  }

  /**
   * Send the map its graph: one hub per isolate (sized by its heap, coloured
   * by pressure), every shown object linked to the isolate it runs in (busy
   * objects breathe, failing ones wear the error colour, stopped ones are
   * see-through). One setGraph per refresh the window already does; nodes
   * keep their places between refreshes. A worker that just vanished stays
   * as a ghost hub, spotlit with the objects it hosted.
   */
  private async syncProcessMap(): Promise<void> {
    if (!this.mapGraphId || !this.mapMode) return;
    const watchOf = new Map(this.heapWatches.map((w) => [isolateOfWatch(w), w] as [string, HeapWatch]));
    const isolates = new Set<string>(watchOf.keys());
    for (const row of this.mapRows) isolates.add(isolateOfRow(row));
    for (const lost of this.lostIsolates.keys()) isolates.add(lost);
    const order = [...isolates].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b, undefined, { numeric: true })));

    const nodes: Array<Record<string, unknown>> = [];
    // Hubs grow with their heap, relative to the largest isolate.
    const maxBytes = Math.max(1, ...this.heapWatches.map((w) => w.sample.usedBytes));
    for (const iso of order) {
      const w = watchOf.get(iso);
      const lost = !w && this.lostIsolates.has(iso);
      nodes.push({
        id: ProcessExplorer.hubId(iso),
        label: w ? this.heapLabelText(w) : lost ? `${ProcessExplorer.isolateName(iso)} lost` : ProcessExplorer.isolateName(iso),
        group: iso,
        shape: 'cylinder',
        size: w ? Math.round((8 + 7 * (w.sample.usedBytes / maxBytes)) * 10) / 10 : 8,
        ...(lost || w?.regime === 'critical' ? { color: '$statusError' } : w?.regime === 'elevated' ? { color: '$statusWarning' } : {}),
        ...(lost ? { ghost: true } : {}),
        data: { kind: 'isolate' },
      });
    }
    const edges: Array<Record<string, unknown>> = [];
    for (const row of this.mapRows) {
      const id = `obj:${row.id}`;
      nodes.push({
        id,
        label: row.name,
        group: isolateOfRow(row),
        // Objects are small spheres in their isolate's colour (the group
        // look), so the hubs read as the clusters' centres.
        shape: 'sphere',
        size: row.isProtected ? 4.5 : 4,
        ...(row.state === 'error' ? { color: '$statusError' } : row.state === 'initializing' ? { color: '$statusWarning' } : {}),
        ...(row.state === 'busy' ? { active: true } : {}),
        ...(row.state === 'stopped' ? { ghost: true } : {}),
      });
      edges.push({ from: id, to: ProcessExplorer.hubId(isolateOfRow(row)) });
    }
    const groups = order.map((iso) => ({ id: iso, label: ProcessExplorer.isolateName(iso) }));
    try {
      await this.request(request(this.id, this.mapGraphId, 'setGraph', { nodes, edges, groups }));
    } catch (err) {
      log.warn('process map update failed:', err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.mapSelectedId && !nodes.some((n) => n.id === this.mapSelectedId)) {
      this.mapSelectedId = undefined;
      await this.updateMapDetail();
    }
    // Spotlight what a lost worker took down; clear it once the moment passes.
    const lostIds = [...this.lostIsolates.keys()].filter((iso) => isolates.has(iso));
    if (lostIds.length > 0 || this.mapSpotlit) {
      const ids = lostIds.length === 0 ? [] : [
        ...lostIds.map((iso) => ProcessExplorer.hubId(iso)),
        ...this.mapRows.filter((r) => lostIds.includes(isolateOfRow(r))).map((r) => `obj:${r.id}`),
      ];
      await this.request(request(this.id, this.mapGraphId, 'highlight', { ids, color: '$statusError' }))
        .catch(() => { /* graph gone */ });
      this.mapSpotlit = ids.length > 0;
    }
  }

  /**
   * A worker died and was rebuilt (WorkerRecovery's report): the window
   * glitches as it does for a worker missing from the heap readings (once
   * per loss), and the map spotlights that isolate and what it hosts now.
   */
  private async onWorkerRecovered(value: unknown): Promise<void> {
    const report = value as { workerIndex?: number } | undefined;
    const index = report?.workerIndex;
    if (!this.windowId || typeof index !== 'number' || index < 0) return;
    const isolate = `w${index}`;
    const fresh = !this.lostIsolates.has(isolate);
    this.lostIsolates.set(isolate, Date.now());
    if (fresh) this.windowEffect('glitch', '$statusError');
    if (this.mapMode) await this.rebuildList();
  }

  private selectedMapRow(): ObjectRow | undefined {
    const sel = this.mapSelectedId;
    if (!sel || !sel.startsWith('obj:')) return undefined;
    return this.mapRows.find((r) => `obj:${r.id}` === sel);
  }

  /** A map click (or double-click): select it here, name it in the strip. */
  private async onMapSelection(value: unknown): Promise<void> {
    let data: { id?: string } = {};
    try { data = (typeof value === 'string' ? JSON.parse(value) : value) as { id?: string }; } catch { return; }
    if (!data?.id) return;
    this.mapSelectedId = data.id;
    await this.updateMapDetail();
  }

  /** The strip under the map: what is selected, and Stop / Restart when they apply. */
  private async updateMapDetail(): Promise<void> {
    if (!this.mapDetailLabelId) return;
    const row = this.selectedMapRow();
    let text = 'Click an object on the map to see where it runs and act on it.';
    let color = this.theme.textMeta;
    if (row) {
      text = `${row.name} · ${row.id.slice(0, 8)} · ${row.state} · ${row.isWorker ? `Worker ${row.workerIndex ?? '?'}` : 'Main'}${row.isProtected ? ' · protected' : ''}`;
      color = this.stateColor(row.state);
    } else if (this.mapSelectedId?.startsWith('iso:')) {
      const iso = this.mapSelectedId.slice(4);
      const w = this.heapWatches.find((h) => isolateOfWatch(h) === iso);
      const count = this.mapRows.filter((r) => isolateOfRow(r) === iso).length;
      text = `${ProcessExplorer.isolateName(iso)} · ${count} object${count === 1 ? '' : 's'}${w ? ` · heap ${this.heapLabelText(w)}` : ''}`;
      color = w ? this.heapColor(w.regime) : this.theme.statusError;
    }
    const actions = !!row && !row.isProtected;
    try {
      await this.request(request(this.id, this.mapDetailLabelId, 'update', { text, style: { color } }));
      if (this.mapStopBtnId) await this.request(request(this.id, this.mapStopBtnId, 'update', { style: { visible: actions } }));
      if (this.mapRestartBtnId) await this.request(request(this.id, this.mapRestartBtnId, 'update', { style: { visible: actions } }));
    } catch { /* widgets gone */ }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ProcessExplorer Usage Guide

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
- Heap strip: one reading per isolate (main and each worker), coloured by pressure. The window pulses when an isolate enters the critical regime and glitches when a worker isolate disappears.
- A successful restart flashes the window; a failed stop or restart shakes it.
- Map toggle: shows the same objects as a 3D map in place of the table, one hub per isolate (sized by its heap, coloured by pressure) with its objects around it. Busy objects breathe in the living light, failing ones wear the error colour. Click an object for its details and Stop / Restart; it stays marked in the table. A lost worker stays on the map briefly as a ghost, spotlit with the objects it hosted. The map refreshes on the window's own cadence.

### Interface ID
\`abjects:process-explorer\``;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(!this.mapMode || this.windowId !== undefined, 'the map shows only while the window is open');
    invariant(!this.mapSpotlit || this.mapGraphId !== undefined, 'a spotlight needs the map');
  }
}

export const PROCESS_EXPLORER_ID = 'abjects:process-explorer' as AbjectId;
