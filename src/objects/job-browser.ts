/**
 * JobBrowser -- UI widget for viewing job execution status.
 *
 * Shows/hides from Taskbar. Subscribes to JobManager as a dependent to
 * receive real-time job status updates. Uses a ListWidget for display.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import type { Job } from './job-manager.js';
import type { ListItem } from './widgets/list-widget.js';
import { emptyStateMarkdown, emptyStateStyle, hintStyle, livingStyle } from './ui-kit.js';

const log = new Log('JobBrowser');

const JOB_BROWSER_INTERFACE: InterfaceId = 'abjects:job-browser';

const WIN_W = 500;
const WIN_H = 350;
/** Root layout margins and bottom bar height (px); the live ring anchors to them. */
const MARGIN_X = 16;
const MARGIN_BOTTOM = 12;
const BAR_H = 36;
/** Diameter of the ring that floats beside the status while jobs run. */
const RING_SIZE = 18;
const RING_NODE = 'job-browser-live-ring';
/** Minimum gap between completion flashes, so a busy queue reads as one pulse of news. */
const FLASH_GAP_MS = 1200;

/** Vector icon names for job statuses; ListWidget renders via ListItem.iconName. */
export class JobBrowser extends Abject {
  private jobManagerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private clearBtnId?: AbjectId;
  private emptyLabelId?: AbjectId;
  /** Whether the empty state is showing; undefined until first applied. */
  private emptyShown?: boolean;
  /** Live summary beside the ring in the bottom bar ("2 running · 1 queued"). */
  private statusLabelId?: AbjectId;
  /** Whether the floating ring is in the window's scene (only while jobs run). */
  private ringShown = false;
  private windowSize = { width: WIN_W, height: WIN_H };
  /** When the last completion flash played (throttles a fast queue). */
  private lastFlashAt = 0;

  /** Cached jobs in display order (oldest first). */
  private jobs: Job[] = [];

  constructor() {
    super({
      manifest: {
        name: 'JobBrowser',
        description:
          'Browse and monitor job execution status. Shows real-time updates for queued, running, completed, and failed jobs.',
        version: '1.0.0',
        interface: {
            id: JOB_BROWSER_INTERFACE,
            name: 'JobBrowser',
            description: 'Job status browser UI',
            methods: [
              {
                name: 'show',
                description: 'Show the job browser window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the job browser window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getState',
                description: 'Return current state of the job browser',
                parameters: [],
                returns: { kind: 'object', properties: {
                  visible: { kind: 'primitive', primitive: 'boolean' },
                  jobCount: { kind: 'primitive', primitive: 'number' },
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
    this.jobManagerId = await this.requireDep('JobManager');
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      jobCount: this.jobs.length,
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
    return super.askPrompt(_question) + `\n\n## JobBrowser Usage Guide

### Methods
- \`show()\` -- Open the job browser window. If already open, raises it to front.
- \`hide()\` -- Close the job browser window and unsubscribe from JobManager.
- \`getState()\` -- Returns { visible: boolean, jobCount: number }.

### Real-Time Job Monitoring
JobBrowser registers as a dependent of JobManager to receive live status updates.
Job status icons: \u25CB queued, \u25B8 running, \u2713 completed, \u2717 failed.

### Interface ID
\`abjects:job-browser\``;
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
        title: '\uD83D\uDCCB Jobs',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );
    this.windowSize = { width: WIN_W, height: WIN_H };

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: MARGIN_X, bottom: MARGIN_BOTTOM, left: MARGIN_X },
        spacing: 8,
      })
    );

    // List widget -- add to layout first
    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], searchable: false }],
      })
    );
    this.listWidgetId = listId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Empty state: shares the list's slot, shown while there are no jobs.
    const { widgetIds: [emptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'label', windowId: this.windowId,
          text: emptyStateMarkdown(
            'No jobs yet',
            'Background work queued by agents and objects appears here as it runs, with its status and timing. Ask in Chat for something to run and its jobs will show up.',
          ),
          style: emptyStateStyle(this.theme),
        }],
      })
    );
    this.emptyLabelId = emptyId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.emptyLabelId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Bottom bar (auto-adds after the list)
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: bottomRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: BAR_H },
    }));

    // Left of the bar: a slot the live ring floats in, then the live summary
    // of what is running. The slot is an empty label so the ring never
    // overlaps the text.
    const { widgetIds: [ringSlotId, statusId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: '' },
          { type: 'label', windowId: this.windowId, text: '', style: hintStyle(this.theme) },
        ],
      })
    );
    this.statusLabelId = statusId;
    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: ringSlotId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: RING_SIZE + 4, height: BAR_H } },
        { widgetId: this.statusLabelId, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: BAR_H } },
      ],
    }));

    // Spacer pushes button right
    await this.request(request(this.id, bottomRowId, 'addLayoutSpacer', {}));

    // Clear button
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'button', windowId: this.windowId, text: 'Clear History',
          style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder },
        }],
      })
    );
    this.clearBtnId = widgetIds[0];

    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: 36 } },
      ],
    }));

    // Subscribe
    this.send(request(this.id, this.clearBtnId, 'addDependent', {}));
    this.send(request(this.id, this.jobManagerId!, 'addDependent', {}));

    // Populate
    await this.loadJobs();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.send(request(this.id, this.jobManagerId!, 'removeDependent', {}));

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.listWidgetId = undefined;
    this.clearBtnId = undefined;
    this.emptyLabelId = undefined;
    this.emptyShown = undefined;
    this.statusLabelId = undefined;
    this.ringShown = false;
    this.windowSize = { width: WIN_W, height: WIN_H };
    this.lastFlashAt = 0;
    this.jobs = [];
    this.changed('visibility', false);
    return true;
  }

  // -- Data --

  private async loadJobs(): Promise<void> {
    if (!this.jobManagerId) return;
    try {
      const jobs = await this.request<Job[]>(
        request(this.id, this.jobManagerId, 'listJobs', {})
      );
      // listJobs returns most-recent-first; display oldest first
      this.jobs = [...jobs].reverse();
    } catch (err) {
      log.warn('Failed to load jobs:', err);
    }
    await this.rebuildList();
  }

  private formatJobItem(job: Job): ListItem {
    const num = job.id.replace('job-', '');
    const queueTag = job.queue && job.queue !== 'default' ? `[${job.queue}] ` : '';
    const elapsed = job.completedAt && job.startedAt
      ? `${((job.completedAt - job.startedAt) / 1000).toFixed(1)}s`
      : '';
    const errorSuffix = job.status === 'failed' && job.error
      ? ` -- ${job.error.slice(0, 30)}`
      : '';

    return {
      label: `#${num} ${queueTag}${job.description}${errorSuffix}`,
      value: job.id,
      secondary: elapsed,
      badge: this.statusBadge(job.status),
    };
  }

  private statusBadge(status: string): { text: string; color: string } {
    switch (status) {
      case 'running':   return { text: 'Running', color: this.theme.accentSecondary };
      case 'completed': return { text: 'Done',    color: this.theme.statusSuccess };
      case 'failed':    return { text: 'Failed',  color: this.theme.statusError };
      default:          return { text: 'Queued',  color: this.theme.statusNeutral };
    }
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    const items = this.jobs.map(j => this.formatJobItem(j));
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    } catch { /* widget may be gone */ }
    await this.applyEmptyState(items.length === 0);
    await this.updateStatus();
  }

  // -- Live status: summary text, Clear History availability, floating ring --

  private countStatus(status: Job['status']): number {
    return this.jobs.filter(j => j.status === status).length;
  }

  /** "2 running · 1 queued" while work is live; a done/failed tally at rest. */
  private statusText(): string {
    const running = this.countStatus('running');
    const queued = this.countStatus('queued');
    if (running > 0 || queued > 0) {
      return [running > 0 ? `${running} running` : '', queued > 0 ? `${queued} queued` : '']
        .filter(Boolean).join(' \u00B7 ');
    }
    if (this.jobs.length === 0) return '';
    const done = this.countStatus('completed');
    const failed = this.countStatus('failed');
    return [`${done} done`, failed > 0 ? `${failed} failed` : ''].filter(Boolean).join(' \u00B7 ');
  }

  private async updateStatus(): Promise<void> {
    const live = this.countStatus('running') > 0 || this.countStatus('queued') > 0;
    try {
      if (this.statusLabelId) {
        await this.request(request(this.id, this.statusLabelId, 'update', {
          text: this.statusText(),
          style: live ? livingStyle(this.theme) : hintStyle(this.theme),
        }));
      }
      // Clearing history only makes sense once there is history to clear.
      if (this.clearBtnId) {
        await this.request(request(this.id, this.clearBtnId, 'update', { disabled: this.jobs.length === 0 }));
      }
    } catch { /* widgets may be gone */ }
    await this.updateRing();
  }

  /** Ring position: the slot at the left end of the bottom bar (px from window centre). */
  private ringAnchor(): [number, number, number] {
    const { width, height } = this.windowSize;
    return [-width / 2 + MARGIN_X + RING_SIZE / 2 + 2, height / 2 - MARGIN_BOTTOM - BAR_H / 2, 6];
  }

  private ringOps(): Array<Record<string, unknown>> {
    return [
      {
        op: 'add', id: RING_NODE, kind: 'mesh',
        transform: { position: this.ringAnchor(), scale: [RING_SIZE, RING_SIZE, RING_SIZE] },
        params: { primitive: 'ring', color: '$accentSecondary', emissive: '$accentSecondary' },
      },
      { op: 'animate', id: RING_NODE, params: { preset: 'float', amplitude: 3, duration: 1400 } },
    ];
  }

  /**
   * A slow floating ring in the living light beside the status, present only
   * while a job is running. Its loop keeps the desktop redrawing, so it is
   * removed the moment the queue goes idle.
   */
  private async updateRing(): Promise<void> {
    if (!this.windowId) return;
    const want = this.countStatus('running') > 0;
    if (want === this.ringShown) return;
    this.ringShown = want;
    const ops = want ? this.ringOps() : [{ op: 'remove', id: RING_NODE }];
    try {
      await this.request(request(this.id, this.windowId, 'scene', { ops }));
    } catch (err) {
      log.warn('Live ring scene update failed:', err);
    }
  }

  private async onWindowResized(width: number, height: number): Promise<void> {
    if (width === this.windowSize.width && height === this.windowSize.height) return;
    this.windowSize = { width, height };
    if (!this.ringShown || !this.windowId) return;
    try {
      await this.request(request(this.id, this.windowId, 'scene', {
        ops: [{ op: 'remove', id: RING_NODE }, ...this.ringOps()],
      }));
    } catch { /* window may be gone */ }
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, opts: { color?: string } = {}): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, opts.color);
  }

  /** Swap the list and the empty-state label in the shared layout slot. */
  private async applyEmptyState(empty: boolean): Promise<void> {
    if (!this.listWidgetId || !this.emptyLabelId || this.emptyShown === empty) return;
    this.emptyShown = empty;
    try {
      await Promise.all([
        this.request(request(this.id, this.listWidgetId, 'update', { style: { visible: !empty } })),
        this.request(request(this.id, this.emptyLabelId, 'update', { style: { visible: empty } })),
      ]);
    } catch { /* widgets may be gone */ }
  }

  // -- Events --

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Clear button
    if (fromId === this.clearBtnId && aspect === 'click') {
      const confirmed = await this.confirm({
        title: 'Clear Job History',
        message: 'Clear all completed and failed jobs from history?',
        confirmLabel: 'Clear',
        destructive: true,
      });
      if (!confirmed) return;
      this.send(event(this.id, this.clearBtnId, 'update', { busy: true }));
      try {
        if (this.jobManagerId) {
          this.send(request(this.id, this.jobManagerId, 'clearHistory', {}));
        }
        this.jobs = [];
        await this.rebuildList();
        await this.notify('Job history cleared', 'success');
      } finally {
        this.send(event(this.id, this.clearBtnId, 'update', { busy: false }));
      }
      return;
    }

    // JobManager events
    if (fromId === this.jobManagerId) {
      const data = value as Record<string, unknown> | undefined;
      if (!data) return;
      const jobId = data.jobId as string;

      switch (aspect) {
        case 'jobQueued': {
          this.jobs.push({
            id: jobId,
            queue: (data.queue as string) ?? 'default',
            description: (data.description as string) ?? '',
            code: '',
            callerId: '' as AbjectId,
            status: 'queued',
            queuedAt: Date.now(),
          });
          await this.rebuildList();
          break;
        }
        case 'jobStarted': {
          const job = this.jobs.find(j => j.id === jobId);
          if (job) { job.status = 'running'; job.startedAt = Date.now(); }
          await this.rebuildList();
          break;
        }
        case 'jobCompleted': {
          const job = this.jobs.find(j => j.id === jobId);
          if (job) { job.status = 'completed'; job.completedAt = Date.now(); }
          await this.rebuildList();
          // The last job landing drains the queue: celebrate the whole batch.
          // Otherwise a completion flashes in the living light (throttled).
          const drained = this.countStatus('running') === 0 && this.countStatus('queued') === 0;
          if (drained) {
            this.playEffect('burst');
            this.lastFlashAt = Date.now();
          } else if (Date.now() - this.lastFlashAt >= FLASH_GAP_MS) {
            this.playEffect('flash');
            this.lastFlashAt = Date.now();
          }
          break;
        }
        case 'jobFailed': {
          const job = this.jobs.find(j => j.id === jobId);
          if (job) {
            job.status = 'failed';
            job.error = (data.error as string) ?? undefined;
            job.completedAt = Date.now();
            await this.notify(`Job failed: ${job.description.slice(0, 60)}`, 'error');
          }
          await this.rebuildList();
          // A cancellation is a deliberate stop; a real failure glitches.
          if (data.error !== 'Cancelled') this.playEffect('glitch');
          break;
        }
        case 'historyCleared':
          this.jobs = [];
          await this.loadJobs();
          break;
      }
    }
  }
}

export const JOB_BROWSER_ID = 'abjects:job-browser' as AbjectId;
