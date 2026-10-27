/**
 * Taskbar -- persistent vertical bar with launch buttons for workspace apps.
 *
 * Uses the standard show/hide pattern: destroys and rebuilds the window on
 * each show(). On data changes (minimize/restore, collapse), rebuilds the
 * content by clearing the root layout and repopulating it.
 *
 * The section header and a search field stay put at the top; every row goes
 * in a scrolling body under them. The search filters everything there: the
 * built-in apps, then the favorite user objects (starred from the row's hover
 * star, kept in this workspace's Storage), then every other user object, the
 * three groups parted by hairline rules. Typing hides and shows the built-in
 * rows in place and refills the two object lists, so the field keeps its
 * focus and text, and the rows keep their busy lights and open markers.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import type { ThemeData } from '../core/theme-data.js';
import { event, request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { require } from '../core/contracts.js';
import { chromeCase } from '../core/theme-data.js';
import { ActivityLatch, dockStyles, type DockLauncher } from './dock-style.js';
import { withAlpha } from './widgets/widget-types.js';
import { UNDO_EVENTS, undoMethods, type UndoAction, type UndoResult, type UndoState } from '../core/undo.js';

const log = new Log('Taskbar');

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';

const BTN_W = 120;
const BTN_H = 30;
const LABEL_H = 20;
/** Fallback glyph for user objects whose manifest declares no icon. */
const DEFAULT_OBJECT_ICON = '◆';
/** Height of the search field at the top of the section (a row's height, so it reads as one). */
const SEARCH_H = BTN_H;
/** Height of the hairline rule between the apps, the favorites and the rest. */
const RULE_H = 1;
/** Storage key (this workspace's Storage) for the favorited objects. */
const FAVORITES_KEY = 'taskbar:favorites';

/** A user object's durable favorite key: its typeId, which survives restarts, else its name. */
function favoriteKey(obj: ObjectRegistration): string {
  return obj.typeId ?? obj.manifest.name;
}

/**
 * How well a row matches a search, lower is better, or null for no match:
 * name prefix, then the start of a word in the name ('duck' finds
 * DesktopDuck), then anywhere in the name, then the description.
 */
function matchRank(name: string, description: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = name.toLowerCase();
  if (lower.startsWith(q)) return 0;
  const words = name.split(/(?<=[a-z0-9])(?=[A-Z])|[\s_\-.]+/).map((w) => w.toLowerCase());
  if (words.some((w) => w.startsWith(q))) return 1;
  if (lower.includes(q)) return 2;
  if (description.toLowerCase().includes(q)) return 3;
  return null;
}

function objectRank(obj: ObjectRegistration, query: string): number | null {
  return matchRank(obj.manifest.name, obj.manifest.description ?? '', query);
}

export class Taskbar extends Abject {
  private widgetManagerId?: AbjectId;
  private appExplorerId?: AbjectId;
  private chatBrowserId?: AbjectId;
  private peersViewerId?: AbjectId;
  private jobBrowserId?: AbjectId;
  private webBrowserViewerId?: AbjectId;
  private goalBrowserId?: AbjectId;
  private knowledgeBrowserId?: AbjectId;
  private agentBrowserId?: AbjectId;
  private schedulerBrowserId?: AbjectId;
  private fileManagerId?: AbjectId;
  private externalProjectBrowserId?: AbjectId;
  private registryId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private windowManagerId?: AbjectId;

  /** Sidebar dock window + this rail's section layout (pushed via show()). */
  private windowId?: AbjectId;
  private sectionLayoutId?: AbjectId;
  /** The scrolling body under the header and the search field, holding every row. */
  private bodyLayoutId?: AbjectId;
  /** Single-flight guard for clear+repopulate of the section. */
  private buildingUI = false;
  /** Accordion state: collapsed sections show only their header row. */
  private collapsed = false;
  /** Horizontal dock collapse (pushed via show()): render icon-only rows. */
  private compact = false;
  private headerBtnId?: AbjectId;
  /** Chat system-row button (wears the busy light while a chat works). */
  private chatBtnId?: AbjectId;
  private chatBusy = false;
  /** Jobs system-row button (wears the busy light while a job runs). */
  private jobsBtnId?: AbjectId;
  private jobManagerId?: AbjectId;
  /** Jobs running now, from JobManager's jobStarted / jobCompleted / jobFailed. */
  private runningJobs = new Set<string>();
  /** Debounced jobs light: quick jobs back to back read as one steady light. */
  private jobsLight = new ActivityLatch(
    (busy) => this.setRowBusy(this.jobsBtnId, busy),
    { set: (fn, ms) => this.setTimer(fn, ms), cancel: (h) => this.cancelTimer(h) },
  );

  // Button -> target maps for click dispatch
  private systemButtons: Map<AbjectId, AbjectId> = new Map();
  private userObjButtons: Map<AbjectId, AbjectId> = new Map();
  private restoreButtons: Map<AbjectId, string> = new Map();
  /** User object row -> that object's favorite key (for its star). */
  private rowKeys: Map<AbjectId, string> = new Map();
  /** Favorite key -> the name last shown for it, for undo labels ("Star Notes"). */
  private keyNames: Map<string, string> = new Map();
  /** The built-in launcher rows in order, with the label the search matches. */
  private launcherRows: Array<{ btnId: AbjectId; label: string }> = [];
  /** Launcher rows and rules the search has hidden. */
  private hiddenRows = new Set<AbjectId>();
  /** The rule under the built-in apps, and the one between the favorites and the rest. */
  private appsRuleId?: AbjectId;
  private listsRuleId?: AbjectId;

  /** Favorited user objects by favorite key, in the order they were starred. */
  private favorites: string[] = [];
  private storageId?: AbjectId;
  /** What the search field holds; it filters every row under it. */
  private filterQuery = '';
  private searchInputId?: AbjectId;
  /** The two object lists, refreshed in place (typing never rebuilds the field). */
  private favoritesListId?: AbjectId;
  private othersListId?: AbjectId;
  private favoriteRowIds: AbjectId[] = [];
  private otherRowIds: AbjectId[] = [];
  /** Which of favorites / search / others the section was built with; a change needs a full rebuild. */
  private builtShape = '';
  private listTimer?: ReturnType<typeof setTimeout>;
  private refreshingLists = false;
  private listsStale = false;

  // Minimized window state (survives rebuilds)
  private minimizedWindows: Map<string, { windowId: AbjectId; title: string }> = new Map();

  // Debounce timer for registry events
  private updateTimer?: ReturnType<typeof setTimeout>;
  private openStateTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super({
      manifest: {
        name: 'Taskbar',
        description:
          'Persistent vertical toolbar with launch buttons for workspace apps.',
        version: '1.0.0',
        interface: {
            id: TASKBAR_INTERFACE,
            name: 'Taskbar',
            description: 'System taskbar',
            methods: [
              {
                name: 'show',
                description: 'Show the taskbar',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the taskbar',
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
              {
                name: 'setFavorite',
                description: 'Favorite or unfavorite a launchable user object, which moves its row up under the built-in apps or back into the searchable list',
                parameters: [
                  { name: 'object', type: { kind: 'primitive', primitive: 'string' }, description: 'The object\'s name, typeId or AbjectId' },
                  { name: 'favorite', type: { kind: 'primitive', primitive: 'boolean' }, description: 'true to favorite (default), false to unfavorite' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getFavorites',
                description: 'The favorited user objects, in the order they show',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'object', properties: {
                  name: { kind: 'primitive', primitive: 'string' },
                  key: { kind: 'primitive', primitive: 'string' },
                }}},
              },
              ...undoMethods('the last star or unstar of a dock row (the favorites are put back as they were)'),
            ],
            events: UNDO_EVENTS,
          },
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Taskbar Usage Guide

### Overview
Provider of the Abjects section of the sidebar dock. Under a fixed header and
search field, a scrolling body displays launch rows for
core workspace apps (Chat, Goals, Jobs, Web) and any user-created objects that
expose show/hide methods. Also shows a "minimized windows" list so the user
can restore windows from the sidebar.

### Methods
- \`show({ windowId?, sectionLayoutId?, theme? })\` -- Rebuild the section rows
  inside the sidebar section. IDs are cached, so a bare \`show()\` rebuilds in
  place.
- \`hide()\` -- Clear the section and all button state.
- \`getState()\` -- Returns \`{ visible: boolean }\`.
- \`setFavorite({ object, favorite? })\` -- Favorite (default) or unfavorite a
  launchable user object by name, typeId or AbjectId.
- \`getFavorites()\` -- The favorited objects as \`[{ name, key }]\`.
- \`undo()\` / \`redo()\` -- Take back (or redo) the last star or unstar.
  Returns \`{ ok, label, reason }\`; \`getUndoState()\` says what undo would do.

### Favorites and search
A search field at the top of the section filters every row by name (and a
user object's description): the built-in apps, then the favorited user
objects, then the rest. Enter opens the best match. The person stars or
unstars a user object with the star that appears when the pointer is over its
row; favorites list right under the built-in apps and are kept per workspace.

### Behavior
- Subscribes to the Registry for objectRegistered/objectUnregistered events
  and automatically rebuilds when user objects appear or disappear.
- Listens for windowMinimized/windowRestored events from WindowManager.
- Click events on buttons send \`show\` to the corresponding target object.
- Button styles update in real-time to reflect whether a target is visible.

### Interface ID
\`abjects:taskbar\``;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.appExplorerId = await this.requireDep('AppExplorer');
    this.chatBrowserId = await this.requireDep('ChatBrowser');
    this.peersViewerId = await this.requireDep('PeersViewer');
    this.jobBrowserId = await this.requireDep('JobBrowser');
    this.webBrowserViewerId = await this.discoverDep('WebBrowserViewer') ?? undefined;
    this.goalBrowserId = await this.discoverDep('GoalBrowser') ?? undefined;
    this.knowledgeBrowserId = await this.discoverDep('KnowledgeBrowser') ?? undefined;
    this.agentBrowserId = await this.discoverDep('AgentBrowser') ?? undefined;
    this.schedulerBrowserId = await this.discoverDep('SchedulerBrowser') ?? undefined;
    this.fileManagerId = await this.discoverDep('FileManager') ?? undefined;
    this.externalProjectBrowserId = await this.discoverDep('ExternalProjectBrowser') ?? undefined;
    this.registryId = await this.requireDep('Registry');
    this.workspaceManagerId = await this.requireDep('WorkspaceManager');
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadFavorites();

    if (this.registryId) {
      await this.request(request(this.id, this.registryId, 'subscribe', {}));
    }
    await this.watchJobs();
  }

  /**
   * Subscribe to JobManager's job lifecycle (once it exists) and seed the
   * running set from its current jobs, so the Jobs row lights while any job
   * runs. Retried from rebuild() when JobManager registered after us.
   */
  private async watchJobs(): Promise<void> {
    if (this.jobManagerId) return;
    const id = await this.discoverDep('JobManager') ?? undefined;
    if (!id) return;
    this.jobManagerId = id;
    this.send(request(this.id, id, 'addDependent', {}));
    try {
      const jobs = await this.request<Array<{ jobId: string; status: string }>>(
        request(this.id, id, 'listJobs', {}), 5000,
      );
      for (const j of jobs ?? []) if (j?.status === 'running') this.runningJobs.add(j.jobId);
    } catch { /* JobManager busy or gone: the next lifecycle event catches us up */ }
    this.jobsLight.set(this.runningJobs.size > 0);
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        theme?: ThemeData; windowId?: AbjectId; sectionLayoutId?: AbjectId; compact?: boolean;
      } | undefined;
      if (payload?.theme && typeof payload.theme === 'object' && 'canvasBg' in payload.theme) {
        this.theme = payload.theme;
      }
      // WorkspaceManager pushes fresh sidebar section IDs after each sidebar
      // rebuild; a bare show() rebuilds into the cached section.
      if (payload?.windowId && payload?.sectionLayoutId) {
        this.windowId = payload.windowId;
        this.sectionLayoutId = payload.sectionLayoutId;
        this.compact = payload.compact ?? false;
      }
      return this.show();
    });

    this.on('hide', async () => this.hide());

    this.on('getState', async () => ({ visible: !!this.windowId }));

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect === 'goalActivity') {
        // A chat is busy (turn running or goal active) → light the chat row.
        this.setChatBusy(!!(value as { active?: boolean } | undefined)?.active);
        return;
      }
      if (msg.routing.from === this.jobManagerId
        && (aspect === 'jobStarted' || aspect === 'jobCompleted' || aspect === 'jobFailed')) {
        const jobId = (value as { jobId?: string } | undefined)?.jobId;
        if (jobId) {
          if (aspect === 'jobStarted') this.runningJobs.add(jobId);
          else this.runningJobs.delete(jobId);
        }
        this.jobsLight.set(this.runningJobs.size > 0);
        return;
      }
      if (aspect === 'visibility') {
        const fromId = msg.routing.from;
        // Our own rows report the search hiding them; that is not an app's window.
        if (this.systemButtons.has(fromId) || this.userObjButtons.has(fromId)) return;
        // Update single button style in-place (no rebuild)
        await this.updateButtonStyle(fromId, !!value);
        return;
      }
      if (aspect === 'workspaceAccessChanged') {
        this.scheduleRebuild();
        return;
      }
      if (aspect === 'change' && msg.routing.from === this.searchInputId) {
        this.filterQuery = typeof value === 'string' ? value : '';
        this.scheduleListRefresh(40);
        return;
      }
      if (aspect === 'submit' && msg.routing.from === this.searchInputId) {
        await this.openBestMatch();
        return;
      }
      if (aspect === 'accessory') {
        // The hover star on a user object row.
        const key = this.rowKeys.get(msg.routing.from);
        if (key) await this.applyFavorite(key, !this.favorites.includes(key));
        return;
      }
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      // Section header — accordion toggle
      if (fromId === this.headerBtnId) {
        this.collapsed = !this.collapsed;
        await this.rebuild();
        return;
      }

      // Launch button clicked
      const targetId = this.systemButtons.get(fromId) ?? this.userObjButtons.get(fromId);
      if (targetId) {
        this.send(event(this.id, targetId, 'show', {}));
        return;
      }

      // Restore button clicked
      if (this.restoreButtons.has(fromId)) {
        const surfaceId = this.restoreButtons.get(fromId)!;
        if (this.windowManagerId) {
          this.send(event(this.id, this.windowManagerId, 'restoreWindow', { surfaceId }));
        }
      }
    });

    this.on('windowMinimized', async (msg: AbjectMessage) => {
      const { surfaceId, windowId, title } = msg.payload as {
        surfaceId: string; windowId: AbjectId; title: string;
      };
      this.minimizedWindows.set(surfaceId, { windowId, title });
      if (this.windowId) await this.rebuild();
    });

    this.on('windowRestored', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      this.minimizedWindows.delete(surfaceId);
      if (this.windowId) await this.rebuild();
    });

    this.on('objectRegistered', async () => this.scheduleListRefresh());
    this.on('objectUnregistered', async () => this.scheduleListRefresh());
    // An object that gains show and hide through a source update becomes
    // launchable without ever re-registering; the Registry announces the
    // manifest swap and the list follows it.
    this.on('manifestUpdated', async () => this.scheduleListRefresh());

    this.on('setFavorite', async (msg: AbjectMessage) => {
      const { object, favorite } = msg.payload as { object: string; favorite?: boolean };
      require(typeof object === 'string' && object.length > 0, 'setFavorite: object is required');
      const objects = await this.discoverShowableObjects();
      const target = objects.find((o) => o.id === object || o.typeId === object)
        ?? objects.find((o) => o.manifest.name === object);
      if (!target) throw new Error(`No launchable user object '${object}' (it needs show and hide methods)`);
      this.keyNames.set(favoriteKey(target), target.manifest.name);
      await this.applyFavorite(favoriteKey(target), favorite !== false);
      return true;
    });

    this.on('getFavorites', async () => {
      const byKey = new Map((await this.discoverShowableObjects()).map((o) => [favoriteKey(o), o]));
      return this.favorites.map((key) => ({ name: byKey.get(key)?.manifest.name ?? key, key }));
    });

    // Storage keeps the favorites' history: this object is its one writer.
    this.on('undo', async () => this.undoFavorites('undo'));
    this.on('redo', async () => this.undoFavorites('redo'));
    this.on('getUndoState', async (): Promise<UndoState> => {
      if (!this.storageId) return { canUndo: false, canRedo: false };
      try {
        return await this.request<UndoState>(request(this.id, this.storageId, 'getUndoState', {}), 5000);
      } catch {
        return { canUndo: false, canRedo: false };
      }
    });

    // WidgetManager broadcasts these (with the owning app's id) whenever any
    // window opens or closes — the authoritative signal for the open highlight.
    this.on('windowCreated', async () => this.scheduleOpenStateRefresh());
    this.on('windowDestroyed', async () => this.scheduleOpenStateRefresh());
  }

  // ---- Show / Hide / Rebuild ----

  async show(): Promise<boolean> {
    if (this.buildingUI) return true;
    if (!this.windowId || !this.sectionLayoutId) return false;
    this.buildingUI = true;
    try {
      await this.rebuildSection();
    } finally {
      this.buildingUI = false;
    }
    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (this.openStateTimer) { clearTimeout(this.openStateTimer); this.openStateTimer = undefined; }
    if (this.sectionLayoutId) {
      // Best-effort: the sidebar may already have destroyed the section.
      try {
        await this.request(request(this.id, this.sectionLayoutId, 'clearLayoutChildren', {}));
      } catch { /* section gone */ }
    }
    this.windowId = undefined;
    this.sectionLayoutId = undefined;
    this.headerBtnId = undefined;
    this.chatBtnId = undefined;
    this.jobsBtnId = undefined;
    this.systemButtons.clear();
    this.userObjButtons.clear();
    this.restoreButtons.clear();
    this.forgetObjectLists();
    this.changed('visibility', false);
    return true;
  }

  private scheduleRebuild(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = undefined;
      if (this.windowId) await this.rebuild();
    }, 100);
  }

  /**
   * Rebuild content inside the existing sidebar section. Clears the section
   * layout and repopulates.
   */
  private async rebuild(): Promise<void> {
    if (this.buildingUI) return;
    if (!this.windowId || !this.sectionLayoutId) return;
    // Optional browsers are discovered once at init, so one that registers
    // later — a different spawn order, a respawn — would never get a row.
    // Retrying only what is still missing costs nothing on the common path.
    if (!this.externalProjectBrowserId) {
      this.externalProjectBrowserId = await this.discoverDep('ExternalProjectBrowser') ?? undefined;
    }
    if (!this.jobManagerId) await this.watchJobs();
    this.buildingUI = true;
    try {
      await this.rebuildSection();
    } finally {
      this.buildingUI = false;
    }
  }

  // ---- UI Construction ----

  private async rebuildSection(): Promise<void> {
    await this.request(request(this.id, this.sectionLayoutId!, 'clearLayoutChildren', {}));
    this.headerBtnId = undefined;
    this.chatBtnId = undefined;
    this.jobsBtnId = undefined;
    this.systemButtons.clear();
    this.userObjButtons.clear();
    this.restoreButtons.clear();
    this.forgetObjectLists();
    await this.populateContent();
  }

  /** Drop every handle on the rows, lists, rules and the search field (their widgets go with the section). */
  private forgetObjectLists(): void {
    this.rowKeys.clear();
    this.launcherRows = [];
    this.hiddenRows.clear();
    this.appsRuleId = undefined;
    this.listsRuleId = undefined;
    this.searchInputId = undefined;
    this.bodyLayoutId = undefined;
    this.favoritesListId = undefined;
    this.othersListId = undefined;
    this.favoriteRowIds = [];
    this.otherRowIds = [];
    this.builtShape = '';
  }

  private async populateContent(): Promise<void> {
    const collapsed = this.collapsed;
    const objects = this.partitionObjects(collapsed ? [] : await this.discoverShowableObjects());
    const shape = this.listShape(objects);
    const activeWorkspace = await this.request<{
      accessMode: 'local' | 'shared' | 'public';
      joined?: boolean;
    } | null>(request(this.id, this.workspaceManagerId!, 'getActiveWorkspace', {}));
    // Joined workspace records intentionally persist as local so they are never
    // advertised as hosted here, but they are shared workspaces in the UI.
    const showPeers = activeWorkspace?.joined === true
      || activeWorkspace?.accessMode === 'shared'
      || activeWorkspace?.accessMode === 'public';

    // No blocking getState queries. Buttons render unstyled immediately.
    // Visibility events from system objects update styles via updateButtonStyle().

    // ---- Header row: collapse-toggle header button + gear button ----
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.sectionLayoutId!,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.sectionLayoutId!, 'updateLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: LABEL_H },
    }));

    // ---- Batch create all widgets ----
    const specs: Array<{ type: string; windowId: AbjectId; text: string; placeholder?: string; style?: Record<string, unknown> }> = [];

    // "Grimoire index" styling: flat, borderless, left-aligned rows rather than
    // boxed pills. Apps render in primary ink; user objects are demoted to
    // secondary so the eye lands on the built-in apps and the active entry.
    // Constructivist themes swap in the red header block, paper rows, and
    // geometric launcher glyphs (see dock-style.ts).
    const compact = this.compact;
    const dock = dockStyles(this.theme, compact);
    const sectionLabelStyle = dock.sectionLabel;
    const appStyle = dock.row;
    // User objects use the same font/size/ink as the apps; their icon (declared
    // emoji or the default glyph) is the only distinction, so the rail is uniform.
    const objStyle = appStyle;
    const gearStyle = dock.gear;
    const headerStyle = dock.header;
    const row = (key: DockLauncher, label: string) => dock.rowText(key, label);
    // Compact rows are icon-only, so the label moves into a hover tooltip.
    const rowStyle = (label: string, key?: DockLauncher) => dock.rowStyle(label, key);

    // [0] Header collapse-toggle button. Compact mode drops the gear from the
    // header (no horizontal room).
    specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\u25A0' : dock.headerText('Abjects', collapsed), style: compact ? { ...headerStyle, tooltip: 'Abjects' } : headerStyle });
    if (!compact) {
      // [1] Gear button (AppExplorer)
      specs.push({ type: 'button', windowId: this.windowId!, text: '', style: gearStyle });
    }

    // The search field heads the section, over every row below it.
    const searchIdx = specs.length;
    if (shape.search) {
      specs.push({
        type: 'textInput', windowId: this.windowId!, text: this.filterQuery,
        placeholder: 'Search abjects',
        style: {
          fontSize: 13, icon: 'search', clearable: true, radius: this.theme.tokens.radius.sm,
          // A quiet tint with no rule: it reads as the list's own field, not a box among rows.
          background: withAlpha(this.theme.textPrimary, 0.06),
          borderColor: withAlpha(this.theme.textPrimary, 0),
        },
      });
    }

    // The built-in apps, in this order. Chat carries its own icon style (and
    // the busy light, re-applied once the rows are laid out, below).
    const launchers: Array<{ label: string; key?: DockLauncher; target: AbjectId }> = [];
    if (!collapsed) {
      launchers.push({ label: 'Chat', target: this.chatBrowserId! });
      // Peers is meaningful only for shared/public (including joined) workspaces.
      if (showPeers) launchers.push({ label: 'Peers', key: 'peers', target: this.peersViewerId! });
      if (this.goalBrowserId) launchers.push({ label: 'Goals', key: 'goals', target: this.goalBrowserId });
      launchers.push({ label: 'Jobs', key: 'jobs', target: this.jobBrowserId! });
      if (this.knowledgeBrowserId) launchers.push({ label: 'Knowledge', key: 'knowledge', target: this.knowledgeBrowserId });
      if (this.agentBrowserId) launchers.push({ label: 'Agents', key: 'agents', target: this.agentBrowserId });
      if (this.schedulerBrowserId) launchers.push({ label: 'Schedules', key: 'schedules', target: this.schedulerBrowserId });
      if (this.webBrowserViewerId) launchers.push({ label: 'Web', key: 'web', target: this.webBrowserViewerId });
      if (this.fileManagerId) launchers.push({ label: 'Files', key: 'files', target: this.fileManagerId });
      // Projects — the on-disk counterpart to Files
      if (this.externalProjectBrowserId) launchers.push({ label: 'Projects', key: 'projects', target: this.externalProjectBrowserId });
    }
    const query = this.activeQuery();
    const sysRowStartIdx = specs.length;
    for (const l of launchers) {
      // Rows the search leaves out are born hidden.
      const visible = matchRank(l.label, '', query) !== null;
      const style = l.key ? rowStyle(l.label, l.key) : { ...rowStyle(l.label), ...this.chatRowStyle(this.chatBusy) };
      specs.push({ type: 'button', windowId: this.windowId!, text: l.key ? row(l.key, l.label) : this.chatRowText(), style: { ...style, visible } });
    }

    // Hairline rules: under the apps when user objects follow, and between
    // the favorites and the rest. The search shows and hides them.
    const ruleStyle = (visible: boolean) => ({ color: this.theme.divider, visible });
    const appsRuleIdx = specs.length;
    const withAppsRule = launchers.length > 0 && (shape.favorites || shape.others);
    if (withAppsRule) specs.push({ type: 'divider', windowId: this.windowId!, text: '', style: ruleStyle(false) });
    const listsRuleIdx = specs.length;
    const withListsRule = shape.favorites && shape.others;
    if (withListsRule) specs.push({ type: 'divider', windowId: this.windowId!, text: '', style: ruleStyle(false) });

    // Minimized window section (hidden while collapsed)
    const minimizedStartIdx = specs.length;
    const minimizedCount = collapsed ? 0 : this.minimizedWindows.size;
    if (minimizedCount > 0) {
      specs.push({ type: 'label', windowId: this.windowId!, text: compact ? '\u25A1' : `\u25A1 ${chromeCase(this.theme, 'Windows')}`, style: sectionLabelStyle });
      for (const [, { title }] of this.minimizedWindows) {
        specs.push({ type: 'button', windowId: this.windowId!, text: compact ? '\u25A1' : title, style: compact ? { ...objStyle, tooltip: title } : objStyle });
      }
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    // ---- Map button IDs to targets ----
    this.headerBtnId = widgetIds[0];
    const gearBtnId = compact ? undefined : widgetIds[1];
    if (gearBtnId) {
      this.systemButtons.set(gearBtnId, this.appExplorerId!);
    }

    launchers.forEach((l, i) => {
      const btnId = widgetIds[sysRowStartIdx + i];
      this.systemButtons.set(btnId, l.target);
      this.launcherRows.push({ btnId, label: l.label });
      if (matchRank(l.label, '', query) === null) this.hiddenRows.add(btnId);
      if (!l.key) this.chatBtnId = btnId;
      if (l.key === 'jobs') this.jobsBtnId = btnId;
    });
    this.searchInputId = shape.search ? widgetIds[searchIdx] : undefined;
    this.appsRuleId = withAppsRule ? widgetIds[appsRuleIdx] : undefined;
    this.listsRuleId = withListsRule ? widgetIds[listsRuleIdx] : undefined;
    // Rules are born hidden; applyRules shows the ones with rows on both sides.
    if (this.appsRuleId) this.hiddenRows.add(this.appsRuleId);
    if (this.listsRuleId) this.hiddenRows.add(this.listsRuleId);
    this.builtShape = shape.key;

    // ---- Add header row children ----
    const headerChildren: Array<Record<string, unknown>> = [
      { widgetId: this.headerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: LABEL_H } },
    ];
    if (gearBtnId) {
      headerChildren.push({ widgetId: gearBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: LABEL_H } });
    }
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', { children: headerChildren }));
    this.send(request(this.id, this.headerBtnId, 'addDependent', {}));

    // ---- Add section layout children ----
    const sectionChildren: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];

    // The search field stays under the header; the body under it takes the
    // rest of the section's height and scrolls on its own.
    if (this.searchInputId) {
      await this.request(request(this.id, this.sectionLayoutId!, 'addLayoutChild', {
        widgetId: this.searchInputId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: BTN_W, height: SEARCH_H },
      }));
      this.send(request(this.id, this.searchInputId, 'addDependent', {}));
    }
    this.bodyLayoutId = await this.request<AbjectId>(request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
      parentLayoutId: this.sectionLayoutId!,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: this.theme.tokens.space.sm,
    }));

    // The built-in apps and their rule, then the lists. Nested lists append
    // to the body as they are made, so everything goes in order.
    for (const { btnId } of this.launcherRows) {
      sectionChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }
    if (this.appsRuleId) {
      sectionChildren.push({ widgetId: this.appsRuleId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: RULE_H } });
    }
    if (sectionChildren.length > 0) {
      await this.request(request(this.id, this.bodyLayoutId, 'addLayoutChildren', { children: sectionChildren }));
      sectionChildren.length = 0;
    }

    // The favorites, their rule, and the rest.
    const lists = this.filterLists(objects);
    if (shape.favorites) {
      this.favoritesListId = await this.createObjectList();
      await this.fillObjectList('favorites', lists.favorites);
    }
    if (this.listsRuleId) {
      await this.request(request(this.id, this.bodyLayoutId, 'addLayoutChild', {
        widgetId: this.listsRuleId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: BTN_W, height: RULE_H },
      }));
    }
    if (shape.others) {
      this.othersListId = await this.createObjectList();
      await this.fillObjectList('others', lists.others, this.noMatchText(lists));
    }
    this.applyRules(lists);

    // Minimized window section
    if (minimizedCount > 0) {
      let mIdx = minimizedStartIdx;
      sectionChildren.push({ widgetId: widgetIds[mIdx++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: LABEL_H } });
      let surfaceIdx = 0;
      for (const [surfaceId] of this.minimizedWindows) {
        const btnId = widgetIds[mIdx + surfaceIdx];
        this.restoreButtons.set(btnId, surfaceId);
        sectionChildren.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
        surfaceIdx++;
      }
    }

    if (sectionChildren.length > 0) {
      await this.request(request(this.id, this.bodyLayoutId, 'addLayoutChildren', {
        children: sectionChildren,
      }));
    }

    // Fresh rows are born idle: light the ones whose activity is live now.
    if (this.chatBusy) this.setRowBusy(this.chatBtnId, true);
    if (this.jobsLight.busy) this.setRowBusy(this.jobsBtnId, true);

    // Register as dependent of all buttons (for click events)
    for (const [btnId] of this.systemButtons) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }
    for (const [btnId] of this.restoreButtons) {
      this.send(request(this.id, btnId, 'addDependent', {}));
    }

    // Subscribe as dependent of system objects for visibility change events
    const depIds = [this.appExplorerId!, this.chatBrowserId!, this.jobBrowserId!];
    if (this.webBrowserViewerId) depIds.push(this.webBrowserViewerId);
    if (this.fileManagerId) depIds.push(this.fileManagerId);
    if (this.externalProjectBrowserId) depIds.push(this.externalProjectBrowserId);
    if (this.goalBrowserId) depIds.push(this.goalBrowserId);
    if (this.knowledgeBrowserId) depIds.push(this.knowledgeBrowserId);
    if (this.agentBrowserId) depIds.push(this.agentBrowserId);
    if (this.schedulerBrowserId) depIds.push(this.schedulerBrowserId);
    for (const depId of depIds) {
      this.send(request(this.id, depId, 'addDependent', {}));
    }

    // Subscribe to WidgetManager so a window opening or closing — for ANY app,
    // system browser or user-authored scriptable alike — updates the open
    // highlight. This is the single authoritative source; scriptable apps don't
    // reliably emit visibility or return it from getState, and window-level
    // visibility events carry the window's id, not the owning app's.
    if (this.widgetManagerId) {
      this.send(request(this.id, this.widgetManagerId, 'addDependent', {}));
    }

    // Fire-and-forget: derive the open highlight from live window ownership.
    // This doesn't block rendering; buttons appear immediately, styles follow.
    void this.refreshOpenStates();
  }

  // ---- Favorites and search ----

  /** Split launchable objects into favorites (in starred order) and the rest (in registry order). */
  private partitionObjects(all: ObjectRegistration[]): { favorites: ObjectRegistration[]; others: ObjectRegistration[] } {
    const starred = new Set(this.favorites);
    const byKey = new Map<string, ObjectRegistration>();
    const others: ObjectRegistration[] = [];
    for (const obj of all) {
      const key = favoriteKey(obj);
      if (starred.has(key) && !byKey.has(key)) byKey.set(key, obj);
      else others.push(obj);
    }
    const favorites = this.favorites.map((k) => byKey.get(k)).filter((o): o is ObjectRegistration => !!o);
    return { favorites, others };
  }

  /**
   * Which object lists the section carries. Compact docks have no room for a
   * search field, and a collapsed section shows no rows to search. The shape
   * follows the unfiltered lists; the others list also holds the "No matches"
   * row, so it is there whenever the field is.
   */
  private listShape(objects: { favorites: ObjectRegistration[]; others: ObjectRegistration[] }): {
    favorites: boolean; search: boolean; others: boolean; key: string;
  } {
    const favorites = objects.favorites.length > 0;
    const search = !this.compact && !this.collapsed;
    const others = search || objects.others.length > 0;
    return { favorites, search, others, key: `${favorites}|${search}|${others}` };
  }

  /** The search that applies: none in a compact dock, which has no field. */
  private activeQuery(): string {
    return this.compact ? '' : this.filterQuery.trim();
  }

  /** The objects the search keeps, best matches first (stable within a rank). */
  private filterObjects(objs: ObjectRegistration[]): ObjectRegistration[] {
    const query = this.activeQuery();
    if (!query) return objs;
    return objs
      .map((obj, i) => ({ obj, i, rank: objectRank(obj, query) }))
      .filter((m): m is { obj: ObjectRegistration; i: number; rank: number } => m.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((m) => m.obj);
  }

  private filterLists(objects: { favorites: ObjectRegistration[]; others: ObjectRegistration[] }): {
    favorites: ObjectRegistration[]; others: ObjectRegistration[];
  } {
    return { favorites: this.filterObjects(objects.favorites), others: this.filterObjects(objects.others) };
  }

  /** The launcher rows the search keeps showing. */
  private visibleLaunchers(): number {
    return this.launcherRows.filter(({ btnId }) => !this.hiddenRows.has(btnId)).length;
  }

  /** The "No matches" row's text, when a search left nothing at all to show. */
  private noMatchText(lists: { favorites: ObjectRegistration[]; others: ObjectRegistration[] }): string | undefined {
    const nothing = this.activeQuery().length > 0 && this.visibleLaunchers() === 0
      && lists.favorites.length === 0 && lists.others.length === 0;
    return nothing ? 'No matches' : undefined;
  }

  /** Show or hide one row or rule (one update, only when it changes). */
  private setRowShown(widgetId: AbjectId, shown: boolean): void {
    if (shown === !this.hiddenRows.has(widgetId)) return;
    if (shown) this.hiddenRows.delete(widgetId); else this.hiddenRows.add(widgetId);
    try {
      this.send(event(this.id, widgetId, 'update', { visible: shown }));
    } catch { /* widget gone with a dock rebuild */ }
  }

  /** Hide the built-in rows the search leaves out (in place: they keep their lights and markers). */
  private applyLauncherFilter(): void {
    const query = this.activeQuery();
    for (const { btnId, label } of this.launcherRows) {
      this.setRowShown(btnId, matchRank(label, '', query) !== null);
    }
  }

  /** A rule shows only with rows on both sides of it. */
  private applyRules(lists: { favorites: ObjectRegistration[]; others: ObjectRegistration[] }): void {
    const apps = this.visibleLaunchers() > 0;
    const favorites = lists.favorites.length > 0;
    const others = lists.others.length > 0;
    if (this.appsRuleId) this.setRowShown(this.appsRuleId, apps && (favorites || others));
    if (this.listsRuleId) this.setRowShown(this.listsRuleId, favorites && others);
  }

  /**
   * Enter in the search field: open the best match across every group (a
   * better rank wins; on a tie, the row higher up), then clear the field so
   * the section is whole again.
   */
  private async openBestMatch(): Promise<void> {
    const query = this.activeQuery();
    if (!query) return;
    const objects = this.partitionObjects(await this.discoverShowableObjects());
    const candidates: Array<{ rank: number | null; target: AbjectId | undefined }> = [
      ...this.launcherRows.map(({ btnId, label }) => ({ rank: matchRank(label, '', query), target: this.systemButtons.get(btnId) })),
      ...[...objects.favorites, ...objects.others].map((obj) => ({ rank: objectRank(obj, query), target: obj.id })),
    ];
    let best: { rank: number; target: AbjectId } | undefined;
    for (const c of candidates) {
      if (c.rank === null || !c.target) continue;
      if (!best || c.rank < best.rank) best = { rank: c.rank, target: c.target };
    }
    if (!best) return;
    this.send(event(this.id, best.target, 'show', {}));
    this.filterQuery = '';
    if (this.searchInputId) {
      try {
        this.send(event(this.id, this.searchInputId, 'update', { text: '' }));
      } catch { /* field gone */ }
    }
    this.scheduleListRefresh(0);
  }

  private async createObjectList(): Promise<AbjectId> {
    return this.request<AbjectId>(request(this.id, this.widgetManagerId!, 'createNestedVBox', {
      parentLayoutId: this.bodyLayoutId!,
      autoSize: true,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: this.theme.tokens.space.sm,
    }));
  }

  /**
   * Fill one object list with rows. Each row carries a star at its right end
   * that shows while the pointer is over the row: filled on favorites (press
   * to unfavorite), an outline on the rest. Their place under the apps says
   * which are favorites, so the stars stay out of sight otherwise. `noMatch`
   * adds one quiet row saying the search found nothing.
   */
  private async fillObjectList(which: 'favorites' | 'others', objs: ObjectRegistration[], noMatch?: string): Promise<void> {
    const listId = which === 'favorites' ? this.favoritesListId : this.othersListId;
    if (!listId || !this.windowId) return;
    const compact = this.compact;
    const dock = dockStyles(this.theme, compact);
    const favorite = which === 'favorites';
    const accessory = favorite
      ? { icon: 'starFilled', tooltip: 'Remove from favorites' }
      : { icon: 'star', tooltip: 'Add to favorites' };
    const specs: Array<Record<string, unknown>> = objs.map((obj) => {
      // The manifest icon when present, else a neutral default so older
      // objects (created before icons) still render an icon.
      const icon = obj.manifest.icon?.trim() || DEFAULT_OBJECT_ICON;
      const name = obj.manifest.name;
      return {
        type: 'button', windowId: this.windowId!,
        text: compact ? icon : `${icon}  ${name}`,
        style: compact ? { ...dock.row, tooltip: favorite ? `\u2605 ${name}` : name } : { ...dock.row, accessory },
      };
    });
    if (noMatch && objs.length === 0) {
      specs.push({
        type: 'button', windowId: this.windowId!, text: noMatch,
        style: { ...dock.row, color: this.theme.textSecondary, fontSize: 12, disabled: true },
      });
    }
    if (specs.length === 0) return;

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs }),
    );
    const rowIds = widgetIds.slice(0, objs.length);
    rowIds.forEach((btnId, i) => {
      this.userObjButtons.set(btnId, objs[i].id);
      this.rowKeys.set(btnId, favoriteKey(objs[i]));
      this.keyNames.set(favoriteKey(objs[i]), objs[i].manifest.name);
    });
    if (favorite) this.favoriteRowIds = rowIds; else this.otherRowIds = rowIds;

    await this.request(request(this.id, listId, 'addLayoutChildren', {
      children: widgetIds.map((widgetId) => ({
        widgetId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { width: BTN_W, height: BTN_H },
      })),
    }));
    for (const btnId of rowIds) this.send(request(this.id, btnId, 'addDependent', {}));
  }

  /** Coalesce list refreshes (keystrokes, registry bursts) into one. */
  private scheduleListRefresh(delayMs = 100): void {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = undefined;
      void this.refreshObjectLists();
    }, delayMs);
  }

  /**
   * Refresh the section for the search in place: hide or show the built-in
   * rows, refill the favorites and the rest, set the rules. The search field
   * is left alone. A change of shape (the first favorite, the last one gone)
   * rebuilds the section instead. One refresh runs at
   * a time; a request during it runs once more after.
   */
  private async refreshObjectLists(): Promise<void> {
    if (!this.windowId || !this.sectionLayoutId) return;
    if (this.refreshingLists || this.buildingUI) {
      this.listsStale = true;
      return;
    }
    this.refreshingLists = true;
    try {
      // Optional browsers are discovered once at init; one that registers
      // later needs its row, which only a full rebuild adds.
      const hadProjects = !!this.externalProjectBrowserId;
      if (!hadProjects) {
        this.externalProjectBrowserId = await this.discoverDep('ExternalProjectBrowser') ?? undefined;
      }
      const objects = this.partitionObjects(this.collapsed ? [] : await this.discoverShowableObjects());
      const shape = this.listShape(objects);
      if (shape.key !== this.builtShape || hadProjects !== !!this.externalProjectBrowserId) {
        this.refreshingLists = false;
        await this.rebuild();
        return;
      }
      if (this.collapsed) return;
      this.applyLauncherFilter();
      const lists = this.filterLists(objects);
      await this.clearObjectList('favorites');
      await this.fillObjectList('favorites', lists.favorites);
      await this.clearObjectList('others');
      await this.fillObjectList('others', lists.others, this.noMatchText(lists));
      this.applyRules(lists);
      void this.refreshOpenStates();
    } finally {
      this.refreshingLists = false;
      if (this.listsStale) {
        this.listsStale = false;
        this.scheduleListRefresh(0);
      }
    }
  }

  private async clearObjectList(which: 'favorites' | 'others'): Promise<void> {
    const listId = which === 'favorites' ? this.favoritesListId : this.othersListId;
    const rowIds = which === 'favorites' ? this.favoriteRowIds : this.otherRowIds;
    for (const btnId of rowIds) {
      this.userObjButtons.delete(btnId);
      this.rowKeys.delete(btnId);
    }
    if (which === 'favorites') this.favoriteRowIds = []; else this.otherRowIds = [];
    if (!listId) return;
    try {
      await this.request(request(this.id, listId, 'clearLayoutChildren', {}));
    } catch { /* list gone with a dock rebuild */ }
  }

  /** Star or unstar an object by favorite key, keep it, and move its row. */
  private async applyFavorite(key: string, favorite: boolean): Promise<void> {
    const has = this.favorites.includes(key);
    if (favorite === has) return;
    this.favorites = favorite ? [...this.favorites, key] : this.favorites.filter((k) => k !== key);
    if (this.storageId) {
      const name = this.keyNames.get(key) ?? key;
      this.send(request(this.id, this.storageId, 'set', {
        key: FAVORITES_KEY, value: this.favorites, undo: `${favorite ? 'Star' : 'Unstar'} ${name}`,
      }));
    }
    this.changed('favorites', this.favorites);
    await this.refreshObjectLists();
  }

  /**
   * Undo or redo the last star through Storage, which journals each labeled
   * write, then take the favorites it put back and move the rows the way a
   * star press does.
   */
  private async undoFavorites(action: UndoAction): Promise<UndoResult> {
    if (!this.storageId) return { ok: false, reason: 'Favorites are not kept here' };
    const result = await this.request<UndoResult>(request(this.id, this.storageId, action, {}), 30000);
    const restored = (result?.restored ?? {}) as Record<string, unknown>;
    if (result?.ok && FAVORITES_KEY in restored) {
      const value = restored[FAVORITES_KEY];
      this.favorites = Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
      this.changed('favorites', this.favorites);
      await this.refreshObjectLists();
    }
    return result;
  }

  private async loadFavorites(): Promise<void> {
    if (!this.storageId) return;
    try {
      const stored = await this.request<unknown>(request(this.id, this.storageId, 'get', { key: FAVORITES_KEY }), 5000);
      if (Array.isArray(stored)) this.favorites = stored.filter((k): k is string => typeof k === 'string');
    } catch { /* no favorites yet, or Storage busy: start with none */ }
  }

  /**
   * Set every button's active highlight from the set of currently-open windows
   * and their owners (WidgetManager.listWindows). An app is "open" exactly when
   * it owns at least one live window — uniform for system browsers and
   * user-authored scriptable apps, and self-correcting (closed apps go
   * inactive), so click-away and close are reflected and every open app shows.
   */
  /**
   * Apply/clear the chat row's busy light on the `goalActivity` aspect
   * (ChatManager aggregates every chat, so one idle chat never clears
   * another's light).
   *
   * The light is the widget `busy` state: a static frame in the row's paint
   * plus a breathing frame and a running light the browser animates as scene
   * nodes. It costs one row repaint per transition, never a timer, so it can
   * stay on for the whole length of a goal.
   */
  private setChatBusy(busy: boolean): void {
    if (this.chatBusy === busy) return;
    this.chatBusy = busy;
    this.setRowBusy(this.chatBtnId, busy);
    // Compact rows have no label; the tooltip says what the light means.
    if (this.compact && this.chatBtnId) {
      try {
        this.send(event(this.id, this.chatBtnId, 'update', { style: this.chatRowStyle(busy) }));
      } catch { /* widget gone */ }
    }
  }

  /** Turn a dock row's busy light on or off (one event; the row repaints once). */
  private setRowBusy(btnId: AbjectId | undefined, busy: boolean): void {
    if (!btnId) return;
    try {
      this.send(event(this.id, btnId, 'update', { busy }));
    } catch { /* widget gone */ }
  }

  /** Chat row label (the vector icon rides in the style; see chatRowStyle). */
  private chatRowText(): string {
    return this.compact ? '' : 'Chat';
  }

  /**
   * Chat row style: the chat icon, plus in compact (icon-only) mode a tooltip
   * that says whether a chat is working, since there is no label.
   */
  private chatRowStyle(busy: boolean): Record<string, unknown> {
    const style: Record<string, unknown> = { icon: 'chat' };
    if (this.compact) style.tooltip = busy ? 'Chat (working)' : 'Chat';
    return style;
  }

  private async refreshOpenStates(): Promise<void> {
    if (!this.windowId) return;
    const owners = new Set<AbjectId>();
    if (this.widgetManagerId) {
      try {
        const windows = await this.request<Array<{ ownerId?: AbjectId }>>(
          request(this.id, this.widgetManagerId, 'listWindows', {}), 2000
        );
        for (const w of windows ?? []) if (w?.ownerId) owners.add(w.ownerId);
      } catch { /* WidgetManager unavailable */ }
    }
    const allButtons = [...this.systemButtons, ...this.userObjButtons];
    for (const [, targetId] of allButtons) {
      await this.updateButtonStyle(targetId, owners.has(targetId));
    }
  }

  private scheduleOpenStateRefresh(): void {
    if (this.openStateTimer) return;
    this.openStateTimer = setTimeout(() => {
      this.openStateTimer = undefined;
      void this.refreshOpenStates();
    }, 80);
  }

  // ---- Helpers ----

  private async discoverShowableObjects(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    const allObjects = await this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'list', {})
    );
    return allObjects.filter((obj) => {
      // Provenance filter (display layer only). `list` unions local +
      // remote-pooled + global-fallback entries; a remote peer's objects are
      // the ones carrying ownerPeerId. They stay registered in this
      // workspace's registry and remain callable over P2P — they simply are
      // not this user's launchables, so the sidebar renders no button for
      // them. Deliberately NOT `listLocal`: global-fallback entries have no
      // ownerPeerId and must keep rendering.
      if (obj.ownerPeerId) return false;
      if ((obj.manifest.tags ?? []).includes('system')) return false;
      if (!obj.manifest.interface) return false;
      const names = obj.manifest.interface.methods.map((m) => m.name);
      return names.includes('show') && names.includes('hide');
    });
  }

  /**
   * Update a single button's active/inactive style by target object ID.
   * Cheap: one message to one button widget, no layout rebuild.
   */
  private async updateButtonStyle(targetId: AbjectId, visible: boolean): Promise<void> {
    if (!this.windowId) return;
    // Toggle only bg/border (style updates merge), so each button keeps its
    // creation-time ink (primary for apps, secondary for objects). Active gets
    // the accent highlight; inactive restores the flat ghost row.
    const dock = dockStyles(this.theme, this.compact);
    const activeStyle = dock.activeRow;
    const inactiveStyle = dock.inactiveRow;
    const style = visible ? activeStyle : inactiveStyle;

    for (const [btnId, tid] of this.systemButtons) {
      if (tid === targetId) {
        this.send(request(this.id, btnId, 'update', { style }));
        return;
      }
    }
    for (const [btnId, tid] of this.userObjButtons) {
      if (tid === targetId) {
        this.send(request(this.id, btnId, 'update', { style }));
        return;
      }
    }
  }
}

export const TASKBAR_ID = 'abjects:taskbar' as AbjectId;
