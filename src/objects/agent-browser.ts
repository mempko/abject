/**
 * AgentBrowser -- UI for browsing registered agents and event watchers.
 *
 * Two-tab layout:
 *   Tab 0 (Agents):    Live list of all registered agents with status
 *   Tab 1 (Watchers):  TriggerManager rules plus watcher-tagged objects
 *
 * The Watchers tab merges two sources: declarative rules from the built-in
 * TriggerManager (toggled/removed via enableTrigger/disableTrigger/
 * removeTrigger) and legacy watcher-tagged objects exposing getState watches.
 *
 * Subscribes to AgentAbject, Registry, and TriggerManager for real-time
 * updates. Schedules are managed by the separate SchedulerBrowser.
 */

import type { SessionRecord } from './task-session.js';
import { AbjectId, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { ListItem } from './widgets/list-widget.js';
import { emptyStateMarkdown, emptyStateStyle, eyeSigilOps, removeSigilOps } from './ui-kit.js';

const log = new Log('AgentBrowser');

const AGENT_BROWSER_INTERFACE: InterfaceId = 'abjects:agent-browser';

const WIN_W = 620;
const WIN_H = 420;

const TAB_LABELS = ['Agents', 'Watchers', 'Sessions'];

/** Scene node prefix for the "an agent is at work" eye sigil. */
const SIGIL_PREFIX = 'agent-browser-working';
const SIGIL_SIZE = 26;
/** Minimum gap between trigger-failure glitches, so a failing loop reads as one signal. */
const TRIGGER_GLITCH_GAP_MS = 3000;

/** Per-tab empty states: [list empty, nothing selected]. */
const TAB_EMPTY: Array<[string, string, string, string]> = [
  [
    'No agents yet',
    'Agents are objects that take on tasks for you. Ask in Chat to create one, for example "make an agent that tracks my reading list".',
    'Select an agent',
    'Pick one from the list to see what it does, whether it is working, and to edit or delete it.',
  ],
  [
    'No watchers yet',
    'Watchers run a task when something happens, such as a file changing or a message arriving. Ask in Chat to set one up, for example "when a new file lands in Files, summarize it".',
    'Select a watcher',
    'Pick one from the list to see what it listens for and what it does, and to enable, disable or delete it.',
  ],
  [
    'No sessions yet',
    'Each task an agent works on keeps a durable session with its outcome and usage. Sessions appear here as soon as agents start work.',
    'Select a session',
    'Pick one from the list to inspect its outcome and usage, pause or resume it, or fork a fresh attempt.',
  ],
];

interface AgentInfo {
  agentId: string;
  name: string;
  description: string;
  status: string;
  activeTasks: number;
}

interface WatchInfo {
  /** 'trigger' rows come from TriggerManager rules; 'watch' rows from watcher-tagged objects. */
  kind: 'watch' | 'trigger';
  watcherName: string;
  watcherId: string;
  id: string;
  targetName: string;
  aspectFilter?: string;
  taskDescription: string;
  enabled: boolean;
  triggerCount: number;
  lastError?: string;
}

export class AgentBrowser extends Abject {
  private agentAbjectId?: AbjectId;
  private registryId?: AbjectId;
  private triggerManagerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private abjectEditorId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private listWidgetId?: AbjectId;
  private detailLayoutId?: AbjectId;
  private detailTitleId?: AbjectId;
  private detailDescId?: AbjectId;
  private detailMetaId?: AbjectId;
  private editBtnId?: AbjectId;
  private toggleBtnId?: AbjectId;
  private deleteBtnId?: AbjectId;
  private listEmptyId?: AbjectId;
  private detailEmptyId?: AbjectId;
  private btnRowId?: AbjectId;
  /** Which empty states are showing; undefined until first applied. */
  private listEmptyShown?: boolean;
  private detailEmptyShown?: boolean;
  /** Whether the "agent at work" eye sigil is in the window's scene. */
  private sigilShown = false;
  private windowSize?: { width: number; height: number };

  private activeTab = 0;
  private agents: AgentInfo[] = [];
  private sessions: SessionRecord[] = [];
  private sessionStoreId?: AbjectId;
  private watches: WatchInfo[] = [];
  private selectedIndex = -1;
  /** When the last trigger-failure glitch played. */
  private lastTriggerGlitchAt = 0;

  constructor() {
    super({
      manifest: {
        name: 'AgentBrowser',
        description:
          'Browse registered agents and event watchers. Shows real-time updates for agent status and event watch triggers.',
        version: '1.0.0',
        interface: {
          id: AGENT_BROWSER_INTERFACE,
          name: 'AgentBrowser',
          description: 'Agent, schedule, and watcher browser UI',
          methods: [
            {
              name: 'show',
              description: 'Show the agent browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the agent browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return current state of the agent browser',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
                agentCount: { kind: 'primitive', primitive: 'number' },
                watchCount: { kind: 'primitive', primitive: 'number' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display agent browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.agentAbjectId = await this.discoverDep('AgentAbject') ?? undefined;
    this.registryId = await this.discoverDep('Registry') ?? undefined;
    this.triggerManagerId = await this.discoverDep('TriggerManager') ?? undefined;
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      agentCount: this.agents.length,
      watchCount: this.watches.length,
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('windowResized', async (msg: AbjectMessage) => {
      const { windowId, width, height } = msg.payload as { windowId?: AbjectId; width: number; height: number };
      if (windowId && windowId !== this.windowId) return;
      await this.onWindowResized(width, height);
    });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AgentBrowser Usage Guide

### Methods
- \`show()\` -- Open the agent browser window. If already open, raises it to front.
- \`hide()\` -- Close the agent browser window.
- \`getState()\` -- Returns { visible, agentCount, watchCount }.

### Tabs
- **Agents**: Lists all registered agents with live status (idle/busy), active task count.
- **Sessions**: Inspect durable outcomes, usage and unknown operations; pause, resume or fork work.
- **Watchers**: Merges TriggerManager rules (toggle, delete) with watcher-tagged objects and their event watch entries. Schedules live in the separate SchedulerBrowser.

### Real-Time Updates
AgentBrowser subscribes to AgentAbject for agent registration/status changes,
to Registry for new watcher objects, and to TriggerManager for rule activity.

### Interface ID
\`abjects:agent-browser\``;
  }

  // -- Window lifecycle --

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83E\uDD16 Agents',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
        spacing: 8,
      })
    );
    this.windowSize = { width: WIN_W, height: WIN_H };

    // Tab bar
    const { widgetIds: [tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'tabBar', windowId: this.windowId, tabs: TAB_LABELS, selectedIndex: 0, closable: false }],
      })
    );
    this.tabBarId = tabBarId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Split: list (left) | detail (right)
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'splitPane',
          windowId: this.windowId,
          orientation: 'horizontal',
          dividerPosition: 0.45,
          minSize: 180,
        }],
      })
    );

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: splitId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Left pane: list
    const leftLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 4,
      })
    );

    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], searchable: false, itemHeight: 28 }],
      })
    );
    this.listWidgetId = listId;

    await this.request(request(this.id, leftLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Empty states: one shares the list's slot, one stands in for the
    // detail pane while nothing is selected. Texts follow the active tab.
    const { widgetIds: [listEmptyId, detailEmptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: emptyStateMarkdown(TAB_EMPTY[0][0], TAB_EMPTY[0][1]), style: emptyStateStyle(this.theme) },
          { type: 'label', windowId: this.windowId, text: emptyStateMarkdown(TAB_EMPTY[0][2], TAB_EMPTY[0][3]), style: emptyStateStyle(this.theme) },
        ],
      })
    );
    this.listEmptyId = listEmptyId;
    this.detailEmptyId = detailEmptyId;
    await this.request(request(this.id, leftLayoutId, 'addLayoutChild', {
      widgetId: this.listEmptyId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Right pane: outer VBox with scrollable detail area + buttons at bottom
    const rightOuterId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: this.detailEmptyId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Scrollable detail area (expanding)
    this.detailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 4, left: 12 },
        spacing: 8,
      })
    );

    // Detail labels
    const { widgetIds: detailIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          // 0: title
          { type: 'label', windowId: this.windowId, text: 'Select an item',
            style: { fontSize: 14, fontWeight: 'bold', color: this.theme.textHeading, wordWrap: true } },
          // 1: description
          { type: 'markdown', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true } },
          // 2: metadata
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textMeta, wordWrap: true } },
        ],
      })
    );
    this.detailTitleId = detailIds[0];
    this.detailDescId = detailIds[1];
    this.detailMetaId = detailIds[2];

    await this.request(request(this.id, this.detailLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.detailTitleId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 24 } },
        { widgetId: this.detailDescId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.detailMetaId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 40 } },
      ],
    }));

    // Add scrollable detail as expanding child
    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: this.detailLayoutId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Action buttons row (fixed at bottom)
    const btnRowId = this.btnRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 12, bottom: 8, left: 12 },
        spacing: 8,
      })
    );

    const { widgetIds: btnIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Edit' },
          { type: 'button', windowId: this.windowId, text: 'Toggle' },
          { type: 'button', windowId: this.windowId, text: 'Delete' },
        ],
      })
    );
    this.editBtnId = btnIds[0];
    this.toggleBtnId = btnIds[1];
    this.deleteBtnId = btnIds[2];

    await this.request(request(this.id, btnRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.editBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 70, height: 30 } },
        { widgetId: this.toggleBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
        { widgetId: this.deleteBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 70, height: 30 } },
      ],
    }));

    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: btnRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Assign panes to split
    await this.request(request(this.id, splitId, 'setLeftChild', { widgetId: leftLayoutId }));
    await this.request(request(this.id, splitId, 'setRightChild', { widgetId: rightOuterId }));

    // Subscribe to events
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.editBtnId, 'addDependent', {}));
    this.send(request(this.id, this.toggleBtnId, 'addDependent', {}));
    this.send(request(this.id, this.deleteBtnId!, 'addDependent', {}));

    if (this.agentAbjectId) {
      this.send(request(this.id, this.agentAbjectId, 'addDependent', {}));
    }
    if (this.registryId) {
      this.send(request(this.id, this.registryId, 'addDependent', {}));
    }
    if (this.triggerManagerId) {
      this.send(request(this.id, this.triggerManagerId, 'addDependent', {}));
    }

    // Populate (agents always load so the eye sigil reflects work on any tab)
    if (this.activeTab !== 0) await this.loadAgents();
    await this.loadTabData();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.agentAbjectId) {
      this.send(request(this.id, this.agentAbjectId, 'removeDependent', {}));
    }
    if (this.registryId) {
      this.send(request(this.id, this.registryId, 'removeDependent', {}));
    }
    if (this.triggerManagerId) {
      this.send(request(this.id, this.triggerManagerId, 'removeDependent', {}));
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.listWidgetId = undefined;
    this.detailLayoutId = undefined;
    this.detailTitleId = undefined;
    this.detailDescId = undefined;
    this.detailMetaId = undefined;
    this.editBtnId = undefined;
    this.toggleBtnId = undefined;
    this.deleteBtnId = undefined;
    this.listEmptyId = undefined;
    this.detailEmptyId = undefined;
    this.btnRowId = undefined;
    this.listEmptyShown = undefined;
    this.detailEmptyShown = undefined;
    this.sigilShown = false;
    this.windowSize = undefined;
    this.agents = [];
    this.watches = [];
    this.selectedIndex = -1;
    this.changed('visibility', false);
    return true;
  }

  // -- Data loading --

  private async loadTabData(): Promise<void> {
    this.selectedIndex = -1;
    switch (this.activeTab) {
      case 0: await this.loadAgents(); break;
      case 1: await this.loadWatches(); break;
      case 2: await this.loadSessions(); break;
    }
    for (const [id, text] of [[this.editBtnId, this.activeTab === 2 ? 'Inspect' : 'Edit'], [this.toggleBtnId, this.activeTab === 2 ? 'Resume' : 'Toggle'], [this.deleteBtnId, this.activeTab === 2 ? 'Fork' : 'Delete']] as const) {
      if (id) await this.request(request(this.id, id, 'update', { text, disabled: false, style: this.buttonStyle(id) }));
    }
    const [listTitle, listHint, detailTitle, detailHint] = TAB_EMPTY[this.activeTab] ?? TAB_EMPTY[0];
    if (this.listEmptyId && this.detailEmptyId) {
      await Promise.all([
        this.request(request(this.id, this.listEmptyId, 'update', { text: emptyStateMarkdown(listTitle, listHint) })),
        this.request(request(this.id, this.detailEmptyId, 'update', { text: emptyStateMarkdown(detailTitle, detailHint) })),
      ]);
    }
    await this.rebuildList();
    await this.clearDetail();
    await this.updateSigil();
  }

  /**
   * One primary action per tab (red), destructive Delete, the rest neutral.
   * Agents: Edit. Watchers: Toggle. Sessions: Resume (Fork is not destructive).
   */
  private buttonStyle(id: AbjectId): Record<string, unknown> {
    const t = this.theme;
    const primary = { background: t.actionBg, color: t.actionText, borderColor: t.actionBorder };
    const destructive = { background: t.destructiveBg, color: t.destructiveText, borderColor: t.destructiveBorder };
    // null (not undefined) survives message serialization and resets to the default look.
    const neutral = { background: null, color: null, borderColor: null };
    const primaryId = this.activeTab === 0 ? this.editBtnId : this.toggleBtnId;
    if (id === primaryId) return primary;
    if (id === this.deleteBtnId && this.activeTab !== 2) return destructive;
    return neutral;
  }

  // -- Empty states --

  /** Swap the list and its empty-state label. */
  private async applyListEmpty(empty: boolean): Promise<void> {
    if (!this.listWidgetId || !this.listEmptyId || this.listEmptyShown === empty) return;
    this.listEmptyShown = empty;
    try {
      await Promise.all([
        this.request(request(this.id, this.listWidgetId, 'update', { style: { visible: !empty } })),
        this.request(request(this.id, this.listEmptyId, 'update', { style: { visible: empty } })),
      ]);
    } catch { /* widgets may be gone */ }
  }

  /** Swap the detail pane (and its buttons) with the "select an item" state. */
  private async applyDetailEmpty(empty: boolean): Promise<void> {
    if (!this.detailLayoutId || !this.detailEmptyId || !this.btnRowId || this.detailEmptyShown === empty) return;
    this.detailEmptyShown = empty;
    try {
      await Promise.all([
        this.request(request(this.id, this.detailLayoutId, 'update', { style: { visible: !empty } })),
        this.request(request(this.id, this.btnRowId, 'update', { style: { visible: !empty } })),
        this.request(request(this.id, this.detailEmptyId, 'update', { style: { visible: empty } })),
      ]);
    } catch { /* widgets may be gone */ }
  }

  // -- Eye sigil: shown while any agent is at work --

  private anyAgentWorking(): boolean {
    return this.agents.some(a => a.status === 'busy' || a.activeTasks > 0);
  }

  /** Sigil position: right end of the tab bar row (px from window centre). */
  private sigilAnchor(): [number, number, number] {
    const { width, height } = this.windowSize ?? { width: WIN_W, height: WIN_H };
    return [width / 2 - 12 - SIGIL_SIZE / 2 - 4, -height / 2 + 36 + 12 + 16, 8];
  }

  /**
   * The working sigil plus a gentle thinking stream rising from its pupil.
   * The emitter is a child of the sigil group, so it lives and dies with the
   * sigil: it streams only while an agent is at work.
   */
  private workingSigilOps(): Array<Record<string, unknown>> {
    return [
      ...eyeSigilOps(SIGIL_PREFIX, this.sigilAnchor(), SIGIL_SIZE),
      {
        op: 'add', id: `${SIGIL_PREFIX}-thought`, parentId: `${SIGIL_PREFIX}-sigil`, kind: 'particles',
        transform: { position: [0, -SIGIL_SIZE * 0.2, 4] },
        params: {
          rate: 9, lifetime: 1300, speed: [10, 26], direction: [0, -1, 0.2], spread: 0.55,
          gravity: -6, size: [1.2, 2.4], color: '$accentSecondary', shape: 'glow',
          emitterSize: [SIGIL_SIZE * 0.2, 2, 0], maxParticles: 40,
        },
      },
    ];
  }

  private async updateSigil(): Promise<void> {
    if (!this.windowId) return;
    const want = this.anyAgentWorking();
    if (want === this.sigilShown) return;
    this.sigilShown = want;
    const ops = want ? this.workingSigilOps() : removeSigilOps(SIGIL_PREFIX);
    try {
      await this.request(request(this.id, this.windowId, 'scene', { ops }));
    } catch (err) {
      log.warn('Sigil scene update failed:', err);
    }
  }

  private async onWindowResized(width: number, height: number): Promise<void> {
    const prev = this.windowSize;
    this.windowSize = { width, height };
    if (!this.sigilShown || !this.windowId) return;
    if (prev && prev.width === width && prev.height === height) return;
    try {
      await this.request(request(this.id, this.windowId, 'scene', {
        ops: [...removeSigilOps(SIGIL_PREFIX), ...this.workingSigilOps()],
      }));
    } catch { /* window may be gone */ }
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
  }

  private async loadSessions(): Promise<void> {
    if (!this.sessionStoreId) {
      this.sessionStoreId = await this.discoverDep('TaskSession') ?? undefined;
      if (this.sessionStoreId) this.send(request(this.id, this.sessionStoreId, 'addDependent', {}));
    }
    this.sessions = this.agentAbjectId ? await this.request<SessionRecord[]>(request(this.id, this.agentAbjectId, 'getSessions', {})) : [];
    this.sessions.sort((a,b) => b.updatedAt - a.updatedAt);
  }

  private async loadAgents(): Promise<void> {
    if (!this.agentAbjectId) { this.agents = []; return; }
    try {
      this.agents = await this.request<AgentInfo[]>(
        request(this.id, this.agentAbjectId, 'listAgents', {})
      );
    } catch (err) {
      log.warn('Failed to load agents:', err);
      this.agents = [];
    }
  }

  private async loadWatches(): Promise<void> {
    this.watches = [];

    // TriggerManager rules come first: they are the built-in trigger surface.
    if (!this.triggerManagerId) {
      this.triggerManagerId = await this.discoverDep('TriggerManager') ?? undefined;
    }
    if (this.triggerManagerId) {
      try {
        const rules = await this.request<Array<{
          id: string; name: string; sourceName: string; aspect: string;
          filter?: string; enabled: boolean; fireCount: number;
          lastError?: string;
          action: { targetName: string; method: string };
        }>>(
          request(this.id, this.triggerManagerId, 'listTriggers', {}),
          5000,
        );
        for (const r of rules) {
          this.watches.push({
            kind: 'trigger',
            watcherName: 'TriggerManager',
            watcherId: this.triggerManagerId as string,
            id: r.id,
            targetName: `${r.sourceName}.${r.aspect}`,
            aspectFilter: r.filter,
            taskDescription: `${r.name}: call ${r.action.targetName}.${r.action.method}`,
            enabled: r.enabled,
            triggerCount: r.fireCount,
            lastError: r.lastError,
          });
        }
      } catch (err) {
        log.warn('Failed to load trigger rules:', err);
      }
    }

    // Legacy watcher-tagged objects exposing getState watches.
    if (!this.registryId) return;
    try {
      const watchers = await this.request<ObjectRegistration[]>(
        request(this.id, this.registryId, 'discover', { tags: ['watcher'] })
      );
      for (const w of watchers) {
        // TriggerManager is watcher-tagged but already listed above.
        if ((w.id as string) === (this.triggerManagerId as string | undefined)) continue;
        try {
          const state = await this.request<{ watches?: Array<{
            id: string; targetName: string; aspectFilter?: string;
            taskDescription: string; enabled: boolean; triggerCount: number;
          }> }>(
            request(this.id, w.id, 'getState', {}),
            5000,
          );
          if (state.watches) {
            for (const watch of state.watches) {
              this.watches.push({
                kind: 'watch',
                watcherName: w.name,
                watcherId: w.id as string,
                ...watch,
              });
            }
          }
        } catch { /* object may not respond */ }
      }
    } catch (err) {
      log.warn('Failed to load watches:', err);
    }
  }

  // -- List rendering --

  private buildListItems(): ListItem[] {
    switch (this.activeTab) {
      case 0:
        // Kit marks: a working agent glows in the living light, idle ones rest.
        return this.agents.map((a): ListItem => {
          const working = a.status === 'busy' || a.activeTasks > 0;
          const tasks = a.activeTasks > 0 ? ` (${a.activeTasks} active)` : '';
          return {
            label: `${a.name}${tasks}`, value: a.agentId,
            iconName: working ? 'activity' : 'dot',
            iconColor: working ? this.theme.accentSecondary : this.theme.textMeta,
          };
        });
      case 1:
        return this.watches.map((w, i): ListItem => {
          const filter = w.kind === 'watch' && w.aspectFilter ? ` [${w.aspectFilter}]` : '';
          const fires = w.lastError ? `${w.triggerCount} fires, error` : `${w.triggerCount} fires`;
          return {
            label: `${w.targetName}${filter}`, value: String(i), secondary: fires,
            iconName: w.enabled ? 'eye' : 'dot',
            iconColor: w.lastError ? this.theme.statusError : (w.enabled ? this.theme.accentSecondary : this.theme.textMeta),
          };
        });
      case 2: return this.sessions.map((s): ListItem => ({
        label: s.intent.slice(0, 100), value: s.id, secondary: `${s.agentName} · ${s.status} · attempt ${s.attempt}`,
        iconName: s.status === 'running' ? 'activity' : 'dot',
        iconColor: s.status === 'running' ? this.theme.accentSecondary : this.theme.textMeta,
      }));
      default:
        return [];
    }
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    const items = this.buildListItems();
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    } catch { /* widget may be gone */ }
    await this.applyListEmpty(items.length === 0);
  }

  // -- Detail pane --

  private async clearDetail(): Promise<void> {
    await this.updateDetail('Select an item', '', '');
    await this.applyDetailEmpty(true);
  }

  private async updateDetail(title: string, desc: string, meta: string): Promise<void> {
    if (!this.detailTitleId) return;
    try {
      await Promise.all([
        this.request(request(this.id, this.detailTitleId, 'update', { text: title })),
        this.request(request(this.id, this.detailDescId!, 'update', { text: desc })),
        this.request(request(this.id, this.detailMetaId!, 'update', { text: meta })),
      ]);
    } catch { /* widgets may be gone */ }
    if (title !== 'Select an item') await this.applyDetailEmpty(false);
  }

  private async showDetailForSelection(): Promise<void> {
    if (this.activeTab === 2) {
      const s = this.sessions[this.selectedIndex];
      if (!s) return this.clearDetail();
      await this.updateDetail(s.intent, `**Agent:** ${s.agentName}\n**State:** ${s.status}\n**Usage:** ${s.usage.tokens} reported tokens, $${s.usage.cost.toFixed(4)}${s.usage.unpricedCalls ? ` (${s.usage.unpricedCalls} unpriced calls)` : ''}\n**Outstanding operation:** ${s.outstandingOperation ? JSON.stringify(s.outstandingOperation) : 'None'}\n\n**Outcome:** ${JSON.stringify(s.outcome ?? 'In progress')}`, `Attempt ${s.attempt} · revision ${s.revision} · session ${s.id}`);
      if (this.toggleBtnId) await this.request(request(this.id, this.toggleBtnId, 'update', { text: s.status === 'running' ? 'Pause' : 'Resume', disabled: s.status === 'accepted' || (s.status !== 'running' && !!s.outstandingOperation) }));
      return;
    }
    switch (this.activeTab) {
      case 0: {
        const agent = this.agents[this.selectedIndex];
        if (!agent) { await this.clearDetail(); return; }
        const desc = agent.description;
        const meta = `Status: ${agent.status} | Active tasks: ${agent.activeTasks} | ID: ${agent.agentId.slice(0, 12)}...`;
        await this.updateDetail(agent.name, desc, meta);
        break;
      }
      case 1: {
        const watch = this.watches[this.selectedIndex];
        if (!watch) { await this.clearDetail(); return; }
        if (watch.kind === 'trigger') {
          const desc = `**Rule:** ${watch.taskDescription}\n\n**Source event:** ${watch.targetName}\n**Filter:** ${watch.aspectFilter || 'None (all matching events)'}\n**Enabled:** ${watch.enabled ? 'Yes' : 'No'}${watch.lastError ? `\n\n**Last error:** ${watch.lastError}` : ''}`;
          const meta = `TriggerManager rule ${watch.id} | Fired: ${watch.triggerCount} times`;
          await this.updateDetail(`Trigger: ${watch.targetName}`, desc, meta);
        } else {
          const desc = `**Task:** ${watch.taskDescription}\n\n**Target:** ${watch.targetName}\n**Filter:** ${watch.aspectFilter || 'All events'}\n**Enabled:** ${watch.enabled ? 'Yes' : 'No'}`;
          const meta = `Watcher: ${watch.watcherName} | Triggered: ${watch.triggerCount} times`;
          await this.updateDetail(`Watch: ${watch.targetName}`, desc, meta);
        }
        break;
      }
    }
  }

  // -- Event handling --

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    if (fromId === this.sessionStoreId && aspect === 'sessionUpdated' && this.activeTab === 2) {
      const selected = this.sessions[this.selectedIndex]?.id;
      await this.loadSessions(); await this.rebuildList();
      this.selectedIndex = this.sessions.findIndex(s => s.id === selected);
      if (this.selectedIndex >= 0) await this.showDetailForSelection();
      return;
    }
    // Tab bar change
    if (fromId === this.tabBarId && aspect === 'tabSelected') {
      const data = value as { index: number } | undefined;
      if (data && typeof data.index === 'number') {
        this.activeTab = data.index;
        await this.loadTabData();
      }
      return;
    }

    // List selection
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      try {
        const data = JSON.parse(value as string) as { index: number; value: string; label: string };
        this.selectedIndex = data.index;
      } catch {
        this.selectedIndex = -1;
      }
      await this.showDetailForSelection();
      return;
    }

    // Edit button
    if (fromId === this.editBtnId && aspect === 'click') {
      await this.handleEdit();
      return;
    }

    // Toggle button
    if (fromId === this.toggleBtnId && aspect === 'click') {
      await this.handleToggle();
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      await this.handleDelete();
      return;
    }

    // AgentAbject events -- refresh agents tab
    if (fromId === this.agentAbjectId) {
      if (aspect === 'agentRegistered' || aspect === 'agentUnregistered' || aspect === 'taskPhaseChanged') {
        // Agents stay current on every tab so the eye sigil tracks real work.
        await this.loadAgents();
        if (this.activeTab === 0) {
          await this.rebuildList();
          if (this.selectedIndex >= 0) await this.showDetailForSelection();
        }
        await this.updateSigil();
      }
      return;
    }

    // Registry events -- refresh schedules/watchers if objects changed
    if (fromId === this.registryId) {
      if (aspect === 'objectRegistered' || aspect === 'objectUnregistered') {
        if (this.activeTab === 1) {
          await this.loadTabData();
        }
      }
      return;
    }

    // TriggerManager events -- refresh the watchers tab on rule activity
    if (fromId === this.triggerManagerId) {
      // A failing watcher is an error the Watchers tab exists to surface.
      if (aspect === 'triggerFailed' && this.activeTab === 1
          && Date.now() - this.lastTriggerGlitchAt >= TRIGGER_GLITCH_GAP_MS) {
        this.lastTriggerGlitchAt = Date.now();
        this.playEffect('glitch');
      }
      if (aspect === 'triggerFired' || aspect === 'triggerFailed'
          || aspect === 'triggerAdded' || aspect === 'triggerRemoved'
          || aspect === 'triggerUpdated') {
        if (this.activeTab === 1) {
          await this.loadWatches();
          await this.rebuildList();
          if (this.selectedIndex >= 0) await this.showDetailForSelection();
        }
      }
      return;
    }
  }

  private async handleEdit(): Promise<void> {
    if (this.activeTab === 2) { await this.showDetailForSelection(); return; }
    if (this.selectedIndex < 0) return;

    let objectId: string | undefined;
    switch (this.activeTab) {
      case 0: objectId = this.agents[this.selectedIndex]?.agentId; break;
      case 1: objectId = this.watches[this.selectedIndex]?.watcherId; break;
    }
    if (!objectId) return;

    // Try to open in AbjectEditor
    if (!this.abjectEditorId) {
      this.abjectEditorId = await this.discoverDep('AbjectEditor') ?? undefined;
    }
    if (this.abjectEditorId) {
      try {
        await this.request(
          request(this.id, this.abjectEditorId, 'editObject', { objectId }),
          10000,
        );
      } catch {
        log.warn('Failed to open AbjectEditor for', objectId);
      }
    }
  }

  private async handleToggle(): Promise<void> {
    if (this.activeTab === 2 && this.agentAbjectId) {
      const s = this.sessions[this.selectedIndex];
      if (!s) return;
      try {
        if (s.status === 'running') await this.request(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: s.attempt === 1 ? s.id : `${s.id}:attempt-${s.attempt}` }));
        else await this.request(request(this.id, this.agentAbjectId, 'resumeTask', { id: s.id, expectedRevision: s.revision }));
        await this.loadSessions(); await this.rebuildList();
        this.playEffect('flash', '$accent');
      } catch (err) { this.playEffect('shake'); await this.notify(String(err), 'error'); }
      return;
    }
    if (this.selectedIndex < 0) return;

    switch (this.activeTab) {
      case 1: {
        const watch = this.watches[this.selectedIndex];
        if (!watch) return;
        const method = watch.kind === 'trigger'
          ? (watch.enabled ? 'disableTrigger' : 'enableTrigger')
          : (watch.enabled ? 'disableWatch' : 'enableWatch');
        const payload = watch.kind === 'trigger'
          ? { triggerId: watch.id }
          : { watchId: watch.id };
        if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: true }));
        try {
          await this.request(
            request(this.id, watch.watcherId as AbjectId, method, payload),
            5000,
          );
          watch.enabled = !watch.enabled;
          await this.rebuildList();
          await this.showDetailForSelection();
          this.playEffect('flash', '$accent');
          await this.notify(`${watch.kind === 'trigger' ? 'Trigger' : 'Watch'} ${watch.enabled ? 'enabled' : 'disabled'}`, 'success');
        } catch (err) {
          log.warn('Failed to toggle watch:', err);
          this.playEffect('shake');
          await this.notify('Toggle failed', 'error');
        } finally {
          if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: false }));
        }
        break;
      }
    }
  }

  private async handleDelete(): Promise<void> {
    if (this.activeTab === 2 && this.agentAbjectId) {
      const s = this.sessions[this.selectedIndex];
      if (!s) return;
      try {
        await this.request(request(this.id, this.agentAbjectId, 'forkTask', { id: s.id, newId: `${s.id}:fork-${Date.now()}` }));
        await this.loadSessions(); await this.rebuildList();
        this.playEffect('flash');
        await this.notify('Forked a fresh attempt', 'success');
      } catch (err) {
        log.warn('Failed to fork session:', err);
        this.playEffect('shake');
        const msg = err instanceof Error ? err.message : String(err);
        await this.notify(`Fork failed: ${msg.slice(0, 80)}`, 'error');
      }
      return;
    }
    if (this.selectedIndex < 0) return;

    // Watchers tab: TriggerManager rules can be removed directly.
    if (this.activeTab === 1) {
      const watch = this.watches[this.selectedIndex];
      if (!watch) return;
      if (watch.kind !== 'trigger') {
        // A legacy watch belongs to its watcher object, which removes it.
        this.playEffect('shake');
        await this.notify(`This watch belongs to ${watch.watcherName}. Press Edit to open it and remove the watch there.`, 'info');
        return;
      }
      const confirmed = await this.confirm({
        title: 'Delete Trigger',
        message: `Delete trigger rule "${watch.taskDescription}"? This cannot be undone.`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await this.request(
          request(this.id, watch.watcherId as AbjectId, 'removeTrigger', { triggerId: watch.id }),
          5000,
        );
        this.selectedIndex = -1;
        await this.loadWatches();
        await this.rebuildList();
        await this.clearDetail();
        await this.notify('Trigger deleted', 'success');
      } catch (err) {
        log.warn('Failed to delete trigger:', err);
        this.playEffect('shake');
        await this.notify('Delete failed', 'error');
      }
      return;
    }

    if (this.activeTab !== 0) return;
    const agent = this.agents[this.selectedIndex];
    if (!agent) return;

    // Check if agent is user-created by looking for the 'scriptable' tag
    if (!this.registryId) return;
    let isUserCreated = false;
    try {
      const reg = await this.request<{ manifest?: { tags?: string[] } } | null>(
        request(this.id, this.registryId, 'lookup', { objectId: agent.agentId }),
        5000,
      );
      isUserCreated = reg?.manifest?.tags?.includes('scriptable') ?? false;
    } catch { /* best effort */ }

    if (!isUserCreated) {
      log.info(`Cannot delete system agent "${agent.name}"`);
      this.playEffect('shake');
      await this.notify(`"${agent.name}" is a system agent. Only agents you created can be deleted.`, 'info');
      return;
    }

    const confirmed = await this.confirm({
      title: 'Delete Agent',
      message: `Delete agent "${agent.name}" and its backing object? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      // 1. Unregister from AgentAbject
      if (this.agentAbjectId) {
        await this.request(
          request(agent.agentId as AbjectId, this.agentAbjectId, 'unregisterAgent', {}),
          5000,
        );
      }

      // 2. Remove snapshot from AbjectStore
      const abjectStoreId = await this.discoverDep('AbjectStore');
      if (abjectStoreId) {
        await this.request(
          request(this.id, abjectStoreId, 'remove', { objectId: agent.agentId }),
          5000,
        );
      }

      // 3. Kill the object via Factory
      const factoryId = await this.discoverDep('Factory');
      if (factoryId) {
        await this.request(
          request(this.id, factoryId, 'kill', { objectId: agent.agentId }),
          5000,
        );
      }

      this.selectedIndex = -1;
      await this.loadAgents();
      await this.rebuildList();
      await this.clearDetail();
      await this.notify(`Agent "${agent.name}" deleted`, 'success');
    } catch (err) {
      log.warn('Failed to delete agent:', err);
      this.playEffect('shake');
      const msg = err instanceof Error ? err.message : String(err);
      await this.notify(`Delete failed: ${msg.slice(0, 80)}`, 'error');
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}

export const AGENT_BROWSER_ID = 'abjects:agent-browser' as AbjectId;
