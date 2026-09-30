/**
 * Taskbar -- persistent vertical bar with launch buttons for workspace apps.
 *
 * Uses the standard show/hide pattern: destroys and rebuilds the window on
 * each show(). On data changes (registry events, minimize/restore), rebuilds
 * the content by clearing the root layout and repopulating it.
 */

import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import type { ThemeData } from '../core/theme-data.js';
import { event, request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { chromeCase } from '../core/theme-data.js';
import { ActivityLatch, dockStyles, type DockLauncher } from './dock-style.js';

const log = new Log('Taskbar');

const TASKBAR_INTERFACE: InterfaceId = 'abjects:taskbar';

const BTN_W = 120;
const BTN_H = 30;
const LABEL_H = 20;
/** Fallback glyph for user objects whose manifest declares no icon. */
const DEFAULT_OBJECT_ICON = '◆';

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
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display taskbar', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Taskbar Usage Guide

### Overview
Provider of the Abjects section of the sidebar dock. Displays launch rows for
core workspace apps (Chat, Goals, Jobs, Web) and any user-created objects that
expose show/hide methods. Also shows a "minimized windows" list so the user
can restore windows from the sidebar.

### Methods
- \`show({ windowId?, sectionLayoutId?, theme? })\` -- Rebuild the section rows
  inside the sidebar section. IDs are cached, so a bare \`show()\` rebuilds in
  place.
- \`hide()\` -- Clear the section and all button state.
- \`getState()\` -- Returns \`{ visible: boolean }\`.

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
        // Update single button style in-place (no rebuild)
        const fromId = msg.routing.from;
        await this.updateButtonStyle(fromId, !!value);
        return;
      }
      if (aspect === 'workspaceAccessChanged') {
        this.scheduleRebuild();
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

    this.on('objectRegistered', async () => this.scheduleRebuild());
    this.on('objectUnregistered', async () => this.scheduleRebuild());
    // An object that gains show and hide through a source update becomes
    // launchable without ever re-registering; the Registry announces the
    // manifest swap and the list follows it.
    this.on('manifestUpdated', async () => this.scheduleRebuild());

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
    await this.populateContent();
  }

  private async populateContent(): Promise<void> {
    const collapsed = this.collapsed;
    const showableObjects = collapsed ? [] : await this.discoverShowableObjects();
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
    const specs: Array<{ type: string; windowId: AbjectId; text: string; style?: Record<string, unknown> }> = [];

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
    const sysRowStartIdx = specs.length;
    if (!collapsed) {
      // Chat (opens ChatBrowser overview). A rebuild creates fresh widgets;
      // the busy light is re-applied once the rows are laid out (below).
      specs.push({ type: 'button', windowId: this.windowId!, text: this.chatRowText(), style: { ...rowStyle('Chat'), ...this.chatRowStyle(this.chatBusy) } });
      // Peers is meaningful only for shared/public (including joined) workspaces.
      if (showPeers) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('peers', 'Peers'), style: rowStyle('Peers', 'peers') });
      }
      // Goals (optional)
      if (this.goalBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('goals', 'Goals'), style: rowStyle('Goals', 'goals') });
      }
      // Jobs
      specs.push({ type: 'button', windowId: this.windowId!, text: row('jobs', 'Jobs'), style: rowStyle('Jobs', 'jobs') });
      // Knowledge (optional)
      if (this.knowledgeBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('knowledge', 'Knowledge'), style: rowStyle('Knowledge', 'knowledge') });
      }
      // Agents (optional)
      if (this.agentBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('agents', 'Agents'), style: rowStyle('Agents', 'agents') });
      }
      // Schedules (optional)
      if (this.schedulerBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('schedules', 'Schedules'), style: rowStyle('Schedules', 'schedules') });
      }
      // Web (optional)
      if (this.webBrowserViewerId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('web', 'Web'), style: rowStyle('Web', 'web') });
      }
      // Files (optional)
      if (this.fileManagerId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('files', 'Files'), style: rowStyle('Files', 'files') });
      }
      // Projects — the on-disk counterpart to Files (optional)
      if (this.externalProjectBrowserId) {
        specs.push({ type: 'button', windowId: this.windowId!, text: row('projects', 'Projects'), style: rowStyle('Projects', 'projects') });
      }
    }

    // User object buttons. Use the manifest icon when present, else a neutral
    // default so older objects (created before icons) still render an icon.
    // (showableObjects is empty when collapsed.)
    const userObjStartIdx = specs.length;
    for (const obj of showableObjects) {
      const icon = obj.manifest.icon?.trim() || DEFAULT_OBJECT_ICON;
      specs.push({ type: 'button', windowId: this.windowId!, text: compact ? icon : `${icon}  ${obj.manifest.name}`, style: compact ? { ...objStyle, tooltip: obj.manifest.name } : objStyle });
    }

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

    if (!collapsed) {
      let idx = sysRowStartIdx;
      const chatBtnId = widgetIds[idx++];
      this.chatBtnId = chatBtnId;
      this.systemButtons.set(chatBtnId, this.chatBrowserId!);
      if (showPeers) this.systemButtons.set(widgetIds[idx++], this.peersViewerId!);
      if (this.goalBrowserId) this.systemButtons.set(widgetIds[idx++], this.goalBrowserId);
      this.jobsBtnId = widgetIds[idx++];
      this.systemButtons.set(this.jobsBtnId, this.jobBrowserId!);
      if (this.knowledgeBrowserId) this.systemButtons.set(widgetIds[idx++], this.knowledgeBrowserId);
      if (this.agentBrowserId) this.systemButtons.set(widgetIds[idx++], this.agentBrowserId);
      if (this.schedulerBrowserId) this.systemButtons.set(widgetIds[idx++], this.schedulerBrowserId);
      if (this.webBrowserViewerId) this.systemButtons.set(widgetIds[idx++], this.webBrowserViewerId);
      if (this.fileManagerId) this.systemButtons.set(widgetIds[idx++], this.fileManagerId);
      if (this.externalProjectBrowserId) this.systemButtons.set(widgetIds[idx++], this.externalProjectBrowserId);
    }

    for (let i = 0; i < showableObjects.length; i++) {
      this.userObjButtons.set(widgetIds[userObjStartIdx + i], showableObjects[i].id);
    }

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

    // System buttons in declaration order (skip the header-row widgets).
    for (let i = sysRowStartIdx; i < userObjStartIdx; i++) {
      sectionChildren.push({ widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }

    // User object buttons
    for (let i = 0; i < showableObjects.length; i++) {
      sectionChildren.push({ widgetId: widgetIds[userObjStartIdx + i], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: BTN_W, height: BTN_H } });
    }

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
      await this.request(request(this.id, this.sectionLayoutId!, 'addLayoutChildren', {
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
    for (let i = 0; i < showableObjects.length; i++) {
      this.send(request(this.id, widgetIds[userObjStartIdx + i], 'addDependent', {}));
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
