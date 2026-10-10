/**
 * SchedulerBrowser -- UI for viewing and managing scheduled entries.
 *
 * Shows/hides from Taskbar. Subscribes to Scheduler as a dependent to
 * receive real-time schedule updates. Uses a ListWidget for the schedule
 * list and, beside it, either the detail pane for the selected entry or the
 * Dial: a 24-hour clock face in the window's 3D scene with a hand at now,
 * each upcoming run as a marker at its next-run time, recurring intervals as
 * arcs, and labels for the nearest few. Clicking a marker selects its entry.
 *
 * The dial moves client-side: layout changes are one-shot animate ops, the
 * hand is re-aimed once a minute (a short eased move, then the desktop
 * rests), and nothing streams per frame.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import type { ScheduleEntry } from './scheduler.js';
import type { ListItem } from './widgets/list-widget.js';
import { TITLE_BAR_HEIGHT } from './widgets/widget-types.js';
import { emptyStateMarkdown, emptyStateStyle } from './ui-kit.js';

const log = new Log('SchedulerBrowser');

const SCHEDULER_BROWSER_INTERFACE: InterfaceId = 'abjects:scheduler-browser';

const WIN_W = 640;
const WIN_H = 440;
/** Minimum gap between fire pulses, so a fast interval reads as a heartbeat, not a strobe. */
const FIRE_PULSE_GAP_MS = 4000;

// Window geometry the dial is placed by (it sits in the right pane, below
// the view tabs). These mirror the layout built in show().
const ROOT_MARGIN = 12;
const SPLIT_RATIO = 0.45;
const SPLIT_MIN = 180;
/** SplitPaneWidget's divider gutter. */
const SPLIT_DIVIDER_PX = 4;
const TAB_H = 28;
const RIGHT_SPACING = 4;

type BrowserView = 'details' | 'dial';
const VIEW_TABS: BrowserView[] = ['details', 'dial'];

// ── The dial (units: the rim sits at radius 100) ──

/** The dial's extent from its centre, in dial units (rim, hour labels, margin). */
const DIAL_UNITS = 128;
/** The face spans one day: markers show runs due in the next 24 hours. */
const DIAL_SPAN_MS = 24 * 3600_000;
const RIM_R = 100;
const HOUR_LABEL_R = 115;
/** Marker lanes, outermost first; entries take them in list order. */
const LANES = [84, 76, 68, 60, 52];
/** The info disc in the middle (captions) and the ring framing it. */
const HUB_R = 44;
/** Labels for this many of the nearest runs (plus the selected and hovered). */
const NEAREST_LABELS = 3;
/** Two nearby markers share one label slot (radians, about 1.7 hours). */
const LABEL_CLEARANCE = 0.45;
/** Arcs shorter than this (radians, about 17 minutes of the face) are left out. */
const MIN_ARC = 0.07;
const MARKER_Z = 10;
/** Node id prefix: every dial node hangs under ROOT. */
const ID = 'sbd';
const ROOT = `${ID}-root`;

/** Clockwise angle from 12 o'clock of a moment's time of day, on a 24-hour face. */
export function dialAngle(t: number): number {
  const d = new Date(t);
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return (minutes / 1440) * Math.PI * 2;
}

/** A point at radius r and clockwise angle a from 12 o'clock (+y down, as the scene is). */
function polar(r: number, a: number, z = 0): [number, number, number] {
  return [r * Math.sin(a), -r * Math.cos(a), z];
}

/** Points along a circle of radius r from angle a0 to a1 (clockwise). */
function arcPoints(r: number, a0: number, a1: number, z: number): Array<[number, number, number]> {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * 96) + 1);
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) pts.push(polar(r, a0 + ((a1 - a0) * i) / (n - 1), z));
  return pts;
}

/** A closed polygon approximating a circle, for extrude outlines. */
function circleOutline(r: number, n = 72): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

const TAU = Math.PI * 2;
/** a mod 2π into [0, 2π). */
function wrap(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function untilText(ms: number): string {
  if (ms < 60_000) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Dial text is rasterised this much larger than it is shown, so it stays crisp as the face scales. */
const LABEL_RASTER = 1.6;

/**
 * A dial label sized in dial units (not screen px), so its text scales with
 * the face: with the window, and with the phone's camera.
 */
function dialLabel(position: [number, number, number], size: number, params: Record<string, unknown>): {
  transform: { position: [number, number, number]; scale: number }; params: Record<string, unknown>;
} {
  const padding = typeof params.padding === 'number' ? params.padding * LABEL_RASTER : undefined;
  return {
    transform: { position, scale: 1 / LABEL_RASTER },
    params: { ...params, size: size * LABEL_RASTER, ...(padding !== undefined ? { padding } : {}), screenSpace: false },
  };
}

/** What the dial last sent for one schedule, so a sync sends only differences. */
interface DialMark {
  /** Continuous angle the entry's group was last aimed at (radians). */
  angle: number;
  /** The next run it was placed for. */
  nextRun: number;
  lane: number;
  markerKey: string;
  scale: number;
  arcKey: string;
  labelKey: string;
}

export class SchedulerBrowser extends Abject {
  private schedulerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private splitPaneId?: AbjectId;
  private listWidgetId?: AbjectId;
  private detailLayoutId?: AbjectId;
  private detailTitleId?: AbjectId;
  private detailDescId?: AbjectId;
  private detailCodeId?: AbjectId;
  private detailMetaId?: AbjectId;
  private toggleBtnId?: AbjectId;
  private deleteBtnId?: AbjectId;
  private listEmptyId?: AbjectId;
  private detailEmptyId?: AbjectId;
  private btnRowId?: AbjectId;
  private tabBarId?: AbjectId;
  private dialAreaId?: AbjectId;
  /** Which empty state the list shows; undefined until first applied. */
  private listEmptyShown?: boolean;
  /** Right-pane widget visibility as last applied. */
  private paneShown = new Map<AbjectId, boolean>();

  private entries: ScheduleEntry[] = [];
  private selectedIndex = -1;
  /** When the last fire pulse played. */
  private lastFirePulseAt = 0;

  /** The view beside the list (kept across show/hide). */
  private view: BrowserView = 'details';
  private winW = WIN_W;
  private winH = WIN_H;
  private splitRatio = SPLIT_RATIO;
  private minimized = false;

  // Dial state: what is on the window now.
  private dialStatic = false;
  private dialMarks = new Map<string, DialMark>();
  private handAngle = 0;
  /** Info-disc captions as last sent (id to params). */
  private captionKeys = new Map<string, string>();
  private hoverScheduleId?: string;
  /** Entries that fired since the last sync: they move forward (a daily one laps the face). */
  private firedSinceSync = new Set<string>();
  private markerFlashAt = new Map<string, number>();
  private burstKey = 0;
  private handTimer?: ReturnType<typeof setTimeout>;
  private relayoutTimer?: ReturnType<typeof setTimeout>;
  /** Dial work runs one step at a time (diffs are computed against dialMarks). */
  private dialChain: Promise<void> = Promise.resolve();

  constructor() {
    super({
      manifest: {
        name: 'SchedulerBrowser',
        description:
          'Browse and manage scheduled entries. Shows schedule descriptions, intervals, ' +
          'next run times, and allows enabling/disabling/deleting schedules. A Dial view shows ' +
          'the next 24 hours as a 3D clock face with a marker per upcoming run.',
        version: '1.1.0',
        interface: {
          id: SCHEDULER_BROWSER_INTERFACE,
          name: 'SchedulerBrowser',
          description: 'Schedule management UI',
          methods: [
            {
              name: 'show',
              description: 'Show the scheduler browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the scheduler browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'setView',
              description: 'Choose what shows beside the schedule list: "details" (the selected entry, with Enable/Disable and Delete) or "dial" (a 24-hour clock face: a hand at now, a marker per run due in the next 24 hours, arcs for recurring intervals; click a marker to select its entry).',
              parameters: [
                { name: 'view', type: { kind: 'primitive', primitive: 'string' }, description: '"details" or "dial"' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return current state of the scheduler browser',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
                scheduleCount: { kind: 'primitive', primitive: 'number' },
                view: { kind: 'primitive', primitive: 'string' },
                selectedScheduleId: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.schedulerId = await this.discoverDep('Scheduler') ?? undefined;
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('setView', async (msg: AbjectMessage) => {
      const { view } = msg.payload as { view: string };
      contractRequire(view === 'details' || view === 'dial', 'setView: view must be "details" or "dial"');
      await this.setView(view);
      return true;
    });
    this.on('getState', async () => ({
      visible: !!this.windowId,
      scheduleCount: this.entries.length,
      view: this.view,
      selectedScheduleId: this.entries[this.selectedIndex]?.id ?? '',
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('windowResized', async (msg: AbjectMessage) => {
      const { windowId, width, height } = msg.payload as { windowId?: AbjectId; width: number; height: number };
      if (windowId !== this.windowId || (width === this.winW && height === this.winH)) return;
      this.winW = width;
      this.winH = height;
      this.scheduleRelayout();
    });
    this.on('windowMinimized', async (msg: AbjectMessage) => {
      if ((msg.payload as { windowId?: AbjectId })?.windowId !== this.windowId) return;
      this.minimized = true;
      this.cancelTimer(this.handTimer);
      this.handTimer = undefined;
    });
    this.on('windowRestored', async (msg: AbjectMessage) => {
      if ((msg.payload as { windowId?: AbjectId })?.windowId !== this.windowId) return;
      this.minimized = false;
      if (this.dialStatic) {
        await this.syncDial();
        this.scheduleHandTick();
      }
    });
    // Input on the dial's markers (we contributed them, so it comes to us).
    this.on('nodeInput', async (msg: AbjectMessage) => {
      const p = msg.payload as { type: string; nodeId?: string; hitNodeId?: string };
      const scheduleId = markerScheduleId(p.hitNodeId ?? p.nodeId);
      if (!scheduleId) return;
      if (p.type === 'mousedown') {
        await this.selectFromDial(scheduleId);
      } else if (p.type === 'mouseenter') {
        this.hoverScheduleId = scheduleId;
        await this.syncDial();
      } else if (p.type === 'mouseleave' && this.hoverScheduleId === scheduleId) {
        this.hoverScheduleId = undefined;
        await this.syncDial();
      }
    });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## SchedulerBrowser Usage Guide

### Methods
- \`show()\` -- Open the scheduler browser window.
- \`hide()\` -- Close the scheduler browser window.
- \`setView({ view })\` -- "details" or "dial": what shows beside the list.
- \`getState()\` -- Returns { visible, scheduleCount, view, selectedScheduleId }.

### Schedule Management
SchedulerBrowser shows all registered schedule entries with their status,
interval/time, last run, and next run. Select an entry to see details.
Use the Enable/Disable button to switch a schedule on or off, Delete to remove it.

### Dial view
The Dial tab turns the right pane into a 24-hour clock face (midnight at the
top, noon at the bottom) in the window's 3D scene. The living-light hand
points at now; each run due in the next 24 hours is a marker at its next-run
time (a sphere for an interval, a diamond for a daily time, a ring for a
one-off), dimmed when the schedule is off. Recurring intervals draw an arc
spanning one interval from the next run. The nearest runs carry a time-until
label; the disc in the middle shows now and the next run, or the hovered or
selected schedule. Clicking a marker selects that schedule in the list; a
firing schedule flashes its marker, which then travels to its next run.

### Interface ID
\`abjects:scheduler-browser\``;
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
        title: '⏰ Schedules',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );
    this.winW = WIN_W;
    this.winH = WIN_H;
    this.splitRatio = SPLIT_RATIO;
    this.minimized = false;

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: ROOT_MARGIN, right: ROOT_MARGIN, bottom: ROOT_MARGIN, left: ROOT_MARGIN },
        spacing: 8,
      })
    );

    // Split pane: list | detail
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'splitPane',
          windowId: this.windowId,
          orientation: 'horizontal',
          dividerPosition: SPLIT_RATIO,
          minSize: SPLIT_MIN,
        }],
      })
    );
    this.splitPaneId = splitId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: splitId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Left: list
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
    // detail pane while nothing is selected.
    const { widgetIds: [listEmptyId, detailEmptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'label', windowId: this.windowId,
            text: emptyStateMarkdown(
              'No schedules yet',
              'Recurring and one-time tasks appear here. Ask in Chat for something like "every morning at 9, summarize my news" to create one.',
            ),
            style: emptyStateStyle(this.theme),
          },
          {
            type: 'label', windowId: this.windowId,
            text: emptyStateMarkdown(
              'Select a schedule',
              'Pick one from the list to see when it runs, the job it performs, and to enable, disable or delete it.',
            ),
            style: emptyStateStyle(this.theme),
          },
        ],
      })
    );
    this.listEmptyId = listEmptyId;
    this.detailEmptyId = detailEmptyId;
    await this.request(request(this.id, leftLayoutId, 'addLayoutChild', {
      widgetId: this.listEmptyId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Right pane: view tabs, then the dial's stage or the detail (scrollable
    // detail + buttons at the bottom).
    const rightOuterId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: RIGHT_SPACING,
      })
    );

    // The dial's stage is an empty label: the layout gives it the space and
    // the dial's scene nodes draw over it.
    const { widgetIds: [tabBarId, dialAreaId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'tabBar', windowId: this.windowId, tabs: ['Details', 'Dial'], selectedIndex: VIEW_TABS.indexOf(this.view), closable: false },
          { type: 'label', windowId: this.windowId, text: '' },
        ],
      })
    );
    this.tabBarId = tabBarId;
    this.dialAreaId = dialAreaId;

    await this.request(request(this.id, rightOuterId, 'addLayoutChildren', {
      children: [
        { widgetId: this.tabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: TAB_H } },
        { widgetId: this.dialAreaId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.detailEmptyId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
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
          { type: 'label', windowId: this.windowId, text: 'Select a schedule',
            style: { fontSize: 14, fontWeight: 'bold', color: this.theme.textHeading, wordWrap: true } },
          { type: 'markdown', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true } },
          // Job code goes in its own word-wrapping, monospace text area so long
          // scripts stay fully readable and scroll internally.
          { type: 'textArea', windowId: this.windowId, text: '', monospace: true,
            style: { fontSize: 11, color: this.theme.textPrimary, wordWrap: true }, readOnly: true },
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textMeta, wordWrap: true } },
        ],
      })
    );
    this.detailTitleId = detailIds[0];
    this.detailDescId = detailIds[1];
    this.detailCodeId = detailIds[2];
    this.detailMetaId = detailIds[3];

    await this.request(request(this.id, this.detailLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.detailTitleId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 24 } },
        { widgetId: this.detailDescId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 56 } },
        { widgetId: this.detailCodeId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.detailMetaId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 40 } },
      ],
    }));

    // Add scrollable detail as expanding child
    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: this.detailLayoutId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Action buttons (fixed at bottom)
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
          {
            type: 'button', windowId: this.windowId, text: 'Toggle',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder },
          },
          {
            type: 'button', windowId: this.windowId, text: 'Delete',
            style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder },
          },
        ],
      })
    );
    this.toggleBtnId = btnIds[0];
    this.deleteBtnId = btnIds[1];

    await this.request(request(this.id, btnRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.toggleBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
        { widgetId: this.deleteBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
      ],
    }));

    await this.request(request(this.id, rightOuterId, 'addLayoutChild', {
      widgetId: btnRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Assign split children
    await this.request(request(this.id, splitId, 'setLeftChild', { widgetId: leftLayoutId }));
    await this.request(request(this.id, splitId, 'setRightChild', { widgetId: rightOuterId }));

    // Subscribe
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    this.send(request(this.id, this.toggleBtnId, 'addDependent', {}));
    this.send(request(this.id, this.deleteBtnId, 'addDependent', {}));
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, splitId, 'addDependent', {}));
    if (this.schedulerId) {
      this.send(request(this.id, this.schedulerId, 'addDependent', {}));
    }

    // Populate
    await this.loadEntries();
    await this.applyRightPane();
    if (this.view === 'dial') await this.syncDial();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.schedulerId) {
      this.send(request(this.id, this.schedulerId, 'removeDependent', {}));
    }

    // The dial's nodes go with the window; stop its clock and forget them.
    await this.runDial(async () => { this.resetDial(); });

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.splitPaneId = undefined;
    this.listWidgetId = undefined;
    this.detailLayoutId = undefined;
    this.detailTitleId = undefined;
    this.detailDescId = undefined;
    this.detailCodeId = undefined;
    this.detailMetaId = undefined;
    this.toggleBtnId = undefined;
    this.deleteBtnId = undefined;
    this.listEmptyId = undefined;
    this.detailEmptyId = undefined;
    this.btnRowId = undefined;
    this.tabBarId = undefined;
    this.dialAreaId = undefined;
    this.listEmptyShown = undefined;
    this.paneShown.clear();
    this.entries = [];
    this.selectedIndex = -1;
    this.lastFirePulseAt = 0;
    this.changed('visibility', false);
    return true;
  }

  // -- Data --

  private async loadEntries(): Promise<void> {
    if (!this.schedulerId) return;
    try {
      this.entries = await this.request<ScheduleEntry[]>(
        request(this.id, this.schedulerId, 'listSchedules', {})
      );
    } catch (err) {
      log.warn('Failed to load schedules:', err);
      this.entries = [];
    }
    await this.rebuildList();
  }

  private formatTiming(entry: ScheduleEntry): string {
    if (entry.intervalMs) return this.formatInterval(entry.intervalMs);
    if (entry.runAt !== undefined) return `once @ ${new Date(entry.runAt).toLocaleString()}`;
    return `${String(entry.hour ?? 0).padStart(2, '0')}:${String(entry.minute ?? 0).padStart(2, '0')} ${entry.timezone ?? 'local'}`;
  }

  private formatListItem(entry: ScheduleEntry): ListItem {
    // Narrow master-detail list: a status badge reads at a glance, while
    // Toggle/Delete stay in the detail pane where there is room for them.
    return {
      label: entry.description,
      value: entry.id,
      secondary: this.formatTiming(entry),
      badge: {
        text: entry.enabled ? 'On' : 'Off',
        // An armed schedule is live work: it glows in the living light.
        color: entry.enabled
          ? this.theme.accentSecondary
          : this.theme.statusNeutral,
      },
    };
  }

  /** Short timing for the dial's info disc: "every 1h", "daily 09:30", "once". */
  private dialTiming(entry: ScheduleEntry): string {
    if (entry.intervalMs) {
      const ms = entry.intervalMs;
      const text = ms < 3600000 ? this.formatInterval(ms) : `${+(ms / 3600000).toFixed(1)}h`;
      return `every ${text}`;
    }
    if (entry.runAt !== undefined) return 'once';
    return `daily ${String(entry.hour ?? 0).padStart(2, '0')}:${String(entry.minute ?? 0).padStart(2, '0')}`;
  }

  private formatInterval(ms: number): string {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    const items = this.entries.map(e => this.formatListItem(e));
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    } catch { /* widget may be gone */ }
    await this.applyListEmpty(items.length === 0);
    await this.syncDial();
  }

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

  /**
   * Show what the right pane holds for the current view and selection: the
   * dial's stage, the detail with its buttons, or the "select a schedule"
   * state. Only changed visibilities are sent.
   */
  private async applyRightPane(): Promise<void> {
    const dial = this.view === 'dial';
    const empty = !this.entries[this.selectedIndex];
    const want: Array<[AbjectId | undefined, boolean]> = [
      [this.dialAreaId, dial],
      [this.detailEmptyId, !dial && empty],
      [this.detailLayoutId, !dial && !empty],
      [this.btnRowId, !dial && !empty],
    ];
    const sends: Promise<unknown>[] = [];
    for (const [id, visible] of want) {
      if (!id || this.paneShown.get(id) === visible) continue;
      this.paneShown.set(id, visible);
      sends.push(this.request(request(this.id, id, 'update', { style: { visible } })));
    }
    try {
      await Promise.all(sends);
    } catch { /* widgets may be gone */ }
  }

  private async showDetail(): Promise<void> {
    const entry = this.entries[this.selectedIndex];
    if (!entry) {
      await this.updateDetail('Select a schedule', '', '', '');
      await this.applyRightPane();
      await this.syncDial();
      return;
    }

    let timing: string;
    if (entry.intervalMs) {
      timing = `**Interval:** ${this.formatInterval(entry.intervalMs)}`;
    } else if (entry.runAt !== undefined) {
      timing = `**Once at:** ${new Date(entry.runAt).toLocaleString()} (auto-deletes after firing)`;
    } else {
      timing = `**Daily at:** ${String(entry.hour ?? 0).padStart(2, '0')}:${String(entry.minute ?? 0).padStart(2, '0')} ${entry.timezone ?? 'local'}`;
    }

    const lastRun = entry.lastRun > 0 ? new Date(entry.lastRun).toLocaleString() : 'Never';
    const nextRun = entry.nextRun > 0 ? new Date(entry.nextRun).toLocaleString() : 'Unknown';

    const desc = `${timing}\n**Enabled:** ${entry.enabled ? 'Yes' : 'No'}`;
    const code = entry.jobCode || '(no job code)';
    const meta = `Last run: ${lastRun} | Next run: ${nextRun} | ID: ${entry.id}`;

    await this.updateDetail(entry.description, desc, code, meta);
    if (this.toggleBtnId) {
      this.send(event(this.id, this.toggleBtnId, 'update', { text: entry.enabled ? 'Disable' : 'Enable' }));
    }
    await this.applyRightPane();
    await this.syncDial();
  }

  private async updateDetail(title: string, desc: string, code: string, meta: string): Promise<void> {
    if (!this.detailTitleId) return;
    try {
      await Promise.all([
        this.request(request(this.id, this.detailTitleId, 'update', { text: title })),
        this.request(request(this.id, this.detailDescId!, 'update', { text: desc })),
        this.request(request(this.id, this.detailCodeId!, 'update', { text: code })),
        this.request(request(this.id, this.detailMetaId!, 'update', { text: meta })),
      ]);
    } catch { /* widgets may be gone */ }
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
  }

  // -- Actions (shared by detail-pane buttons and inline row actions) --

  private async doToggle(entry: ScheduleEntry): Promise<void> {
    if (!this.schedulerId) return;
    const method = entry.enabled ? 'disableSchedule' : 'enableSchedule';
    try {
      await this.request(
        request(this.id, this.schedulerId, method, { scheduleId: entry.id }),
        5000,
      );
      entry.enabled = !entry.enabled;
      await this.rebuildList();
      await this.showDetail();
      this.playEffect('flash', '$accent');
      await this.notify(`Schedule ${entry.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      log.warn('Failed to toggle schedule:', err);
      this.playEffect('shake');
      await this.notify('Toggle failed', 'error');
    }
  }

  private async doDelete(entry: ScheduleEntry): Promise<void> {
    if (!this.schedulerId) return;
    const confirmed = await this.confirm({
      title: 'Delete Schedule',
      message: `Delete schedule "${entry.description}"?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this.request(
        request(this.id, this.schedulerId, 'removeSchedule', { scheduleId: entry.id }),
        5000,
      );
      this.selectedIndex = -1;
      await this.loadEntries();
      await this.updateDetail('Select a schedule', '', '', '');
      await this.applyRightPane();
      await this.notify('Schedule deleted', 'success');
    } catch (err) {
      log.warn('Failed to delete schedule:', err);
      this.playEffect('shake');
      await this.notify('Delete failed', 'error');
    }
  }

  // -- Views --

  private async setView(view: BrowserView): Promise<void> {
    if (view === this.view) return;
    this.view = view;
    if (this.tabBarId) {
      this.send(event(this.id, this.tabBarId, 'update', { selectedIndex: VIEW_TABS.indexOf(view) }));
    }
    await this.applyRightPane();
    if (view === 'dial') {
      await this.syncDial();
    } else {
      await this.runDial(async () => {
        if (this.dialStatic && this.windowId) {
          try {
            await this.request(request(this.id, this.windowId, 'scene', { ops: [{ op: 'remove', id: ROOT }] }));
          } catch { /* window gone */ }
        }
        this.resetDial();
      });
    }
  }

  /** Select a schedule from its dial marker: the list follows, as does the detail. */
  private async selectFromDial(scheduleId: string): Promise<void> {
    const index = this.entries.findIndex((e) => e.id === scheduleId);
    if (index < 0) return;
    this.selectedIndex = index;
    if (this.listWidgetId) {
      try {
        await this.request(request(this.id, this.listWidgetId, 'update', { selectedIndex: index }));
      } catch { /* widget gone */ }
    }
    await this.showDetail();
  }

  // -- The dial --

  /** Run dial work in order: each step diffs against what the last one sent. */
  private runDial(fn: () => Promise<void>): Promise<void> {
    const next = this.dialChain.then(fn).catch((err) => {
      log.warn('Dial update failed:', err instanceof Error ? err.message : String(err));
    });
    this.dialChain = next;
    return next;
  }

  /** Forget the dial (its nodes are gone or going) and stop its clock. */
  private resetDial(): void {
    this.cancelTimer(this.handTimer);
    this.cancelTimer(this.relayoutTimer);
    this.handTimer = undefined;
    this.relayoutTimer = undefined;
    this.dialStatic = false;
    this.dialMarks.clear();
    this.captionKeys.clear();
    this.hoverScheduleId = undefined;
    this.firedSinceSync.clear();
    this.checkInvariants();
  }

  /** Bring the dial on the window up to date (adds it the first time). */
  private syncDial(): Promise<void> {
    return this.runDial(async () => {
      if (!this.windowId || this.view !== 'dial') return;
      const ops: Array<Record<string, unknown>> = [];
      const fresh = !this.dialStatic;
      if (fresh) {
        ops.push(...this.staticDialOps());
        this.dialStatic = true;
      }
      ops.push(...this.dynamicDialOps());
      if (ops.length > 0) {
        try {
          await this.request(request(this.id, this.windowId, 'scene', { ops }));
        } catch (err) {
          // What we think is on the window no longer matches: clear it and
          // let the next sync build the dial afresh.
          log.warn('Dial sync failed, rebuilding:', err instanceof Error ? err.message : String(err));
          try {
            await this.request(request(this.id, this.windowId, 'scene', { ops: [{ op: 'remove', id: ROOT }] }));
          } catch { /* window gone */ }
          this.resetDial();
          return;
        }
      }
      if (fresh) this.scheduleHandTick();
    });
  }

  /**
   * Where the dial sits: the centre of the right pane below the tabs (px from
   * the window centre, as scene positions are) and the scale that fits its
   * DIAL_UNITS radius in the pane. Mirrors the layout built in show().
   */
  private dialFrame(): { position: [number, number, number]; scale: number } {
    const W = this.winW;
    const H = this.winH;
    const splitY = TITLE_BAR_HEIGHT + ROOT_MARGIN;
    const splitW = Math.max(0, W - 2 * ROOT_MARGIN);
    const splitH = Math.max(0, H - TITLE_BAR_HEIGHT - 2 * ROOT_MARGIN);
    const total = splitW - SPLIT_DIVIDER_PX;
    const leftW = Math.max(SPLIT_MIN, Math.min(total - SPLIT_MIN, total * this.splitRatio));
    const ax = ROOT_MARGIN + leftW + SPLIT_DIVIDER_PX;
    const aw = Math.max(0, total - leftW);
    const ay = splitY + TAB_H + RIGHT_SPACING;
    const ah = Math.max(0, splitH - TAB_H - RIGHT_SPACING);
    const scale = Math.max(0.15, Math.min(aw, ah) / 2 / DIAL_UNITS);
    return { position: [ax + aw / 2 - W / 2, ay + ah / 2 - H / 2, 0], scale };
  }

  /** Re-place the dial after the window or the split changes size (coalesced). */
  private scheduleRelayout(): void {
    if (!this.dialStatic) return;
    this.cancelTimer(this.relayoutTimer);
    this.relayoutTimer = this.setTimer(() => {
      this.relayoutTimer = undefined;
      void this.runDial(async () => {
        if (!this.dialStatic || !this.windowId) return;
        const f = this.dialFrame();
        await this.request(request(this.id, this.windowId, 'scene', {
          ops: [{ op: 'update', id: ROOT, transform: { position: f.position, scale: f.scale } }],
        }));
      });
    }, 60);
  }

  /** Re-aim the hand just after each minute turns (never per second). */
  private scheduleHandTick(): void {
    this.cancelTimer(this.handTimer);
    this.handTimer = undefined;
    if (!this.dialStatic || this.minimized) return;
    const ms = 60_000 - (Date.now() % 60_000) + 250;
    this.handTimer = this.setTimer(async () => {
      this.handTimer = undefined;
      await this.syncDial();
      this.scheduleHandTick();
    }, ms);
  }

  /** The face: disc, rim, hour ticks and labels, hub, the hand, captions. */
  private staticDialOps(): Array<Record<string, unknown>> {
    const f = this.dialFrame();
    this.handAngle = dialAngle(Date.now());
    const ops: Array<Record<string, unknown>> = [
      { op: 'add', id: ROOT, kind: 'group', transform: { position: f.position, scale: f.scale } },
      // Hard print shadow, then the face, then the ruled rim.
      { op: 'add', id: `${ID}-shadow`, parentId: ROOT, kind: 'mesh',
        transform: { position: [6, 6, -3], rotation: [Math.PI / 2, 0, 0], scale: [RIM_R * 2, 1, RIM_R * 2] },
        params: { primitive: 'cylinder', color: '$shadowColor', shading: 'unlit' } },
      { op: 'add', id: `${ID}-face`, parentId: ROOT, kind: 'mesh',
        transform: { position: [0, 0, -1], rotation: [Math.PI / 2, 0, 0], scale: [RIM_R * 2, 2, RIM_R * 2] },
        params: { primitive: 'cylinder', color: '$canvasBg', shading: 'unlit' } },
      { op: 'add', id: `${ID}-rim`, parentId: ROOT, kind: 'mesh',
        transform: { position: [0, 0, 2], scale: RIM_R * 2 },
        params: { primitive: 'extrude', color: '$textPrimary', roughness: 0.45, metalness: 0.1,
          shape: { outline: circleOutline(0.5), holes: [circleOutline(0.478)], depth: 0.03, bevel: 0.004 } } },
    ];
    // Hour ticks: the four quarters long and in ink, the rest short and quiet.
    const major: Array<Record<string, unknown>> = [];
    const minor: Array<Record<string, unknown>> = [];
    for (let h = 0; h < 24; h++) {
      const a = (h / 24) * TAU;
      const big = h % 6 === 0;
      const len = big ? 13 : 6;
      (big ? major : minor).push({
        position: polar(RIM_R - 4 - len / 2, a, 3),
        rotation: [0, 0, a],
        scale: [big ? 3.2 : 1.6, len, 3],
      });
    }
    ops.push(
      { op: 'add', id: `${ID}-ticks-major`, parentId: ROOT, kind: 'mesh',
        params: { primitive: 'box', color: '$textPrimary', shading: 'unlit', instances: major } },
      { op: 'add', id: `${ID}-ticks-minor`, parentId: ROOT, kind: 'mesh',
        params: { primitive: 'box', color: '$textSecondary', shading: 'unlit', instances: minor } },
    );
    for (const h of [0, 6, 12, 18]) {
      ops.push({ op: 'add', id: `${ID}-hour-${h}`, parentId: ROOT, kind: 'label',
        ...dialLabel(polar(HOUR_LABEL_R, (h / 24) * TAU, 4), 8, { text: String(h).padStart(2, '0'), color: '$textSecondary' }) });
    }
    // The hub: a ruled ring framing the info disc (the captions live inside).
    ops.push({ op: 'add', id: `${ID}-hub`, parentId: ROOT, kind: 'mesh',
      transform: { position: [0, 0, 2], scale: HUB_R * 2 },
      params: { primitive: 'extrude', color: '$textSecondary', roughness: 0.5,
        shape: { outline: circleOutline(0.5), holes: [circleOutline(0.47)], depth: 0.05 } } });
    // The hand: the living light, pointing at now from the hub to the ticks.
    const handLen = RIM_R - 8 - (HUB_R + 2);
    ops.push(
      { op: 'add', id: `${ID}-hand`, parentId: ROOT, kind: 'group',
        transform: { position: [0, 0, 0], rotation: [0, 0, this.handAngle] } },
      { op: 'add', id: `${ID}-hand-bar`, parentId: `${ID}-hand`, kind: 'mesh',
        transform: { position: [0, -(HUB_R + 2 + handLen / 2), 8], scale: [2.6, handLen, 2.6] },
        params: { primitive: 'box', color: '$accentSecondary', emissive: '$accentSecondary' } },
      { op: 'add', id: `${ID}-hand-tip`, parentId: `${ID}-hand`, kind: 'mesh',
        transform: { position: [0, -(RIM_R - 8), 8], scale: 7 },
        params: { primitive: 'sphere', color: '$accentSecondary', emissive: '$accentSecondary' } },
      { op: 'add', id: `${ID}-hand-foot`, parentId: `${ID}-hand`, kind: 'mesh',
        transform: { position: [0, -(HUB_R + 1), 6], rotation: [0, 0, Math.PI / 4], scale: [6, 6, 3] },
        params: { primitive: 'box', color: '$accentSecondary', emissive: '$accentSecondary' } },
    );
    return ops;
  }

  /**
   * The parts that follow the schedules and the clock: one group per
   * upcoming run (turned to its time, holding its marker, arc and label),
   * the hand's aim, and the centre captions. Returns only what changed.
   */
  private dynamicDialOps(): Array<Record<string, unknown>> {
    const ops: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const nowA = dialAngle(now);

    // The hand: forward only, eased over a moment, then the desktop rests.
    const handDelta = wrap(nowA - this.handAngle);
    if (handDelta > 1e-4 && handDelta < TAU - 1e-4) {
      this.handAngle += handDelta;
      ops.push({ op: 'animate', id: `${ID}-hand`,
        params: { channel: 'rotation', to: [0, 0, this.handAngle], duration: 900, easing: 'standard' } });
    }

    const selectedId = this.entries[this.selectedIndex]?.id;
    // Armed runs due within the day (an overdue one waits at the hand);
    // a switched-off schedule shows only while its next time is ahead.
    const due = this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.nextRun > 0 && entry.nextRun - now <= DIAL_SPAN_MS
        && (entry.enabled || entry.nextRun > now));
    const later = this.entries.filter((e) => e.enabled && e.nextRun - now > DIAL_SPAN_MS).length;

    // Labels: the nearest few armed runs, spaced apart, plus selected and hovered.
    const labelled = new Set<string>();
    const labelAngles: number[] = [];
    for (const { entry } of [...due].filter(({ entry }) => entry.enabled).sort((a, b) => a.entry.nextRun - b.entry.nextRun)) {
      if (labelled.size >= NEAREST_LABELS) break;
      const a = entry.nextRun <= now ? nowA : dialAngle(entry.nextRun);
      if (labelAngles.some((b) => Math.min(wrap(a - b), wrap(b - a)) < LABEL_CLEARANCE)) continue;
      labelled.add(entry.id);
      labelAngles.push(a);
    }
    if (selectedId) labelled.add(selectedId);
    if (this.hoverScheduleId) labelled.add(this.hoverScheduleId);

    const present = new Set<string>();
    for (const { entry, index } of due) {
      present.add(entry.id);
      const target = entry.nextRun <= now ? nowA : dialAngle(entry.nextRun);
      const lane = LANES[index % LANES.length];
      const selected = entry.id === selectedId;
      const g = `${ID}-g-${entry.id}`;
      const m = `${ID}-m-${entry.id}`;
      const arcId = `${ID}-a-${entry.id}`;
      const labelId = `${ID}-l-${entry.id}`;

      // Marker: its shape says the kind, its light says the state.
      const primitive = entry.intervalMs ? 'sphere' : entry.runAt !== undefined ? 'torus' : 'box';
      const color = selected ? '$accent' : entry.enabled ? '$accentSecondary' : '$textSecondary';
      const opacity = entry.enabled || selected ? 1 : 0.5;
      const rotation = primitive === 'box' ? [0, 0, Math.PI / 4] : primitive === 'torus' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
      const base = primitive === 'sphere' ? 12 : primitive === 'torus' ? 15 : 10;
      const scale = base * (selected ? 1.45 : 1);
      const markerParams = { primitive, color, opacity, interactive: true, cursor: 'pointer' };
      const markerKey = JSON.stringify([markerParams, lane]);

      // Arc: one interval from the next run (the run after it lands at its end).
      const span = entry.intervalMs && entry.intervalMs < DIAL_SPAN_MS ? (entry.intervalMs / DIAL_SPAN_MS) * TAU : 0;
      const arcParams = span >= MIN_ARC
        ? { points: arcPoints(lane, 0, span, 6), width: selected ? 4 : 3,
            color: selected ? '$accent' : entry.enabled ? '$accentSecondary' : '$textSecondary',
            opacity: entry.enabled || selected ? 0.55 : 0.25, cap: 'round' }
        : undefined;
      const arcKey = arcParams ? JSON.stringify(arcParams) : '';

      // Label: how long until it runs (the name shows in the info disc on
      // hover or selection), beside the marker on the side the hand comes
      // from (its arc runs the other way).
      const aFinal = wrap(target);
      const label = labelled.has(entry.id)
        ? dialLabel([-9, -lane, 16], 7, {
            text: untilText(Math.max(0, entry.nextRun - now)),
            color: selected ? '$accent' : '$textPrimary', background: '$windowBg', padding: 1.5, radius: 0,
            anchor: [0.5 + 0.5 * Math.cos(aFinal), 0.5 + 0.5 * Math.sin(aFinal)] })
        : undefined;
      const labelParams = label?.params;
      const labelKey = label ? JSON.stringify(label) : '';

      const mark = this.dialMarks.get(entry.id);
      if (!mark) {
        ops.push(
          { op: 'add', id: g, parentId: ROOT, kind: 'group', transform: { rotation: [0, 0, target] } },
          { op: 'add', id: m, parentId: g, kind: 'mesh',
            transform: { position: [0, -lane, MARKER_Z], rotation, scale }, params: markerParams },
        );
        if (arcParams) ops.push({ op: 'add', id: arcId, parentId: g, kind: 'line', params: arcParams });
        if (labelParams) {
          ops.push({ op: 'add', id: labelId, parentId: g, kind: 'label',
            transform: label!.transform, params: labelParams });
        }
        this.dialMarks.set(entry.id, { angle: target, nextRun: entry.nextRun, lane, markerKey, scale, arcKey, labelKey });
        this.firedSinceSync.delete(entry.id);
        continue;
      }

      // Travel to the new time along the face: forward after a fire (a daily
      // run laps the dial), otherwise the short way round.
      const fired = this.firedSinceSync.has(entry.id) && entry.nextRun !== mark.nextRun;
      if (fired) this.firedSinceSync.delete(entry.id);
      mark.nextRun = entry.nextRun;
      let delta = wrap(target - mark.angle);
      if (fired) {
        if (delta < 1e-4) delta = TAU;
      } else if (delta > Math.PI) {
        delta -= TAU;
      }
      if (Math.abs(delta) > 1e-4) {
        mark.angle += delta;
        ops.push({ op: 'animate', id: g, params: {
          channel: 'rotation', to: [0, 0, mark.angle],
          duration: Math.round(700 + 500 * Math.min(1, Math.abs(delta) / Math.PI)), easing: 'standard',
        } });
      }
      if (markerKey !== mark.markerKey) {
        ops.push({ op: 'update', id: m, transform: { position: [0, -lane, MARKER_Z], rotation }, params: markerParams });
        mark.markerKey = markerKey;
      }
      if (scale !== mark.scale) {
        ops.push({ op: 'animate', id: m, params: { channel: 'scale', to: [scale, scale, scale], spring: { stiffness: 220, damping: 16 } } });
        mark.scale = scale;
      }
      if (arcKey !== mark.arcKey) {
        if (!arcParams) ops.push({ op: 'remove', id: arcId });
        else ops.push({ op: mark.arcKey ? 'update' : 'add', id: arcId, parentId: g, kind: 'line', params: arcParams });
        mark.arcKey = arcKey;
      }
      if (labelKey !== mark.labelKey || lane !== mark.lane) {
        if (!labelParams) ops.push({ op: 'remove', id: labelId });
        else ops.push({ op: mark.labelKey ? 'update' : 'add', id: labelId, parentId: g, kind: 'label',
          transform: label!.transform, params: labelParams });
        mark.labelKey = labelKey;
      }
      mark.lane = lane;
    }
    for (const id of [...this.dialMarks.keys()]) {
      if (present.has(id)) continue;
      ops.push({ op: 'remove', id: `${ID}-g-${id}` });
      this.dialMarks.delete(id);
    }
    // A fire flag waits for the entry's new next run; drop flags for gone entries.
    for (const id of [...this.firedSinceSync]) if (!this.entries.some((e) => e.id === id)) this.firedSinceSync.delete(id);

    // The info disc: now and the next run, or the hovered or selected entry.
    const sel = this.entries[this.selectedIndex];
    const hovered = this.entries.find((e) => e.id === this.hoverScheduleId);
    const next = due.filter(({ entry }) => entry.enabled).sort((a, b) => a.entry.nextRun - b.entry.nextRun)[0]?.entry;
    const shown = hovered ?? sel;
    const focus = shown ?? next;
    const when = (e: ScheduleEntry): string => {
      if (e.nextRun > 0 && e.nextRun - now <= DIAL_SPAN_MS && (e.enabled || e.nextRun > now)) {
        const u = untilText(Math.max(0, e.nextRun - now));
        return `${clock(Math.max(e.nextRun, now))} · ${u === 'now' ? 'due now' : `in ${u}`}`;
      }
      return e.enabled ? `later · ${new Date(e.nextRun).toLocaleDateString()}` : 'switched off';
    };
    const captions: Array<{ id: string; y: number; text: string; size: number; color: string }> = [
      { id: 'cap1', y: -15, size: 7, color: '$textSecondary',
        text: shown ? this.dialTiming(shown).toUpperCase() : `NOW ${clock(now)}` },
      { id: 'cap2', y: 0, size: 8.5, color: shown === sel && sel ? '$accent' : focus ? '$textPrimary' : '$textSecondary',
        text: focus ? truncate(focus.description, 17) : 'Nothing due' },
      { id: 'cap3', y: 14, size: 7.5, color: '$accentSecondary',
        text: focus ? when(focus) : 'in the next 24 h' },
      { id: 'cap4', y: 27, size: 6, color: '$textSecondary',
        text: !shown && later > 0 ? `+${later} LATER` : '' },
    ];
    for (const c of captions) {
      const key = JSON.stringify(c);
      const had = this.captionKeys.get(c.id);
      if (had === key) continue;
      const nodeId = `${ID}-${c.id}`;
      if (!c.text) {
        if (had) ops.push({ op: 'remove', id: nodeId });
        this.captionKeys.delete(c.id);
        continue;
      }
      ops.push({ op: had ? 'update' : 'add', id: nodeId, parentId: ROOT, kind: 'label',
        ...dialLabel([0, c.y, 18], c.size, { text: c.text, color: c.color }) });
      this.captionKeys.set(c.id, key);
    }
    return ops;
  }

  /**
   * A schedule fired: its marker flashes in the living light and throws a
   * few sparks (throttled per marker); the next sync carries it forward.
   */
  private flashMarker(scheduleId: string): void {
    this.firedSinceSync.add(scheduleId);
    void this.runDial(async () => {
      const mark = this.dialMarks.get(scheduleId);
      if (!mark || !this.windowId || !this.dialStatic) return;
      const now = Date.now();
      if (now - (this.markerFlashAt.get(scheduleId) ?? 0) < FIRE_PULSE_GAP_MS) return;
      this.markerFlashAt.set(scheduleId, now);
      const burstParams = {
        burst: 26, burstKey: ++this.burstKey, rate: 0, lifetime: 900, speed: [30, 110], spread: Math.PI,
        direction: [0, 0, 1], gravity: 0, drag: 0.5, size: [2, 4.5], sizeEnd: 0,
        color: '$accentSecondary', shape: 'glow', maxParticles: 120,
      };
      await this.request(request(this.id, this.windowId, 'scene', { ops: [
        { op: 'animate', id: `${ID}-m-${scheduleId}`, params: { preset: 'flash', color: '$accentSecondary', duration: 900 } },
        { op: 'animate', id: `${ID}-m-${scheduleId}`, params: { channel: 'scale', keyframes: [
          { t: 0, value: mark.scale }, { t: 160, value: mark.scale * 1.8, easing: 'backOut' }, { t: 650, value: mark.scale },
        ] } },
        { op: this.burstKey === 1 ? 'add' : 'update', id: `${ID}-burst`, parentId: ROOT, kind: 'particles',
          transform: { position: polar(mark.lane, mark.angle, MARKER_Z + 2) }, params: burstParams },
      ] }));
    });
  }

  // -- Events --

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // List selection
    if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
      try {
        const data = JSON.parse(value as string) as { index: number; value: string; label: string };
        this.selectedIndex = data.index;
      } catch {
        this.selectedIndex = -1;
      }
      await this.showDetail();
      return;
    }

    // View tabs
    if (fromId === this.tabBarId && aspect === 'change') {
      const view = VIEW_TABS[value as number];
      if (view) await this.setView(view);
      return;
    }

    // Divider dragged: the dial's pane changed width.
    if (fromId === this.splitPaneId && aspect === 'dividerMoved') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.splitRatio = value;
        this.scheduleRelayout();
      }
      return;
    }

    // Toggle button
    if (fromId === this.toggleBtnId && aspect === 'click') {
      const entry = this.entries[this.selectedIndex];
      if (!entry) return;
      if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: true }));
      try {
        await this.doToggle(entry);
      } finally {
        if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      const entry = this.entries[this.selectedIndex];
      if (!entry) return;
      if (this.deleteBtnId) this.send(event(this.id, this.deleteBtnId, 'update', { busy: true }));
      try {
        await this.doDelete(entry);
      } finally {
        if (this.deleteBtnId) this.send(event(this.id, this.deleteBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Scheduler events -- refresh
    if (fromId === this.schedulerId) {
      // A new schedule arrives with a flash; a firing schedule is work
      // starting now, so it pulses (throttled for short intervals) and its
      // dial marker flashes.
      if (aspect === 'scheduleAdded') {
        this.playEffect('flash');
      } else if (aspect === 'scheduleFired') {
        const { scheduleId } = (value ?? {}) as { scheduleId?: string };
        if (scheduleId) this.flashMarker(scheduleId);
        if (Date.now() - this.lastFirePulseAt >= FIRE_PULSE_GAP_MS) {
          this.lastFirePulseAt = Date.now();
          this.playEffect('pulse');
        }
      }
      if (aspect === 'scheduleAdded' || aspect === 'scheduleRemoved' ||
          aspect === 'scheduleUpdated' || aspect === 'scheduleFired') {
        await this.loadEntries();
        if (this.selectedIndex >= 0 && this.selectedIndex < this.entries.length) {
          await this.showDetail();
        }
      }
      return;
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.dialStatic || this.dialMarks.size === 0, 'dial marks exist only while the dial is on the window');
    invariant(this.splitRatio > 0 && this.splitRatio < 1, 'split ratio is a fraction');
  }
}

/** The schedule id behind a dial marker node id, if it is one. */
function markerScheduleId(nodeId: string | undefined): string | undefined {
  const prefix = `${ID}-m-`;
  return nodeId && nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : undefined;
}

export const SCHEDULER_BROWSER_ID = 'abjects:scheduler-browser' as AbjectId;
