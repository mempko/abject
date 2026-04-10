/**
 * JobBrowser -- UI widget for viewing job execution status.
 *
 * Shows/hides from Taskbar. Subscribes to JobManager as a dependent to
 * receive real-time job status updates. Uses a ListWidget for display.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { Job } from './job-manager.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('JobBrowser');

const JOB_BROWSER_INTERFACE: InterfaceId = 'abjects:job-browser';

const WIN_W = 500;
const WIN_H = 350;

const STATUS_ICONS: Record<string, string> = {
  queued:    '\u25CB',  // ○
  running:   '\u25B8',  // ▸
  completed: '\u2713',  // ✓
  failed:    '\u2717',  // ✗
};

export class JobBrowser extends Abject {
  private jobManagerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private clearBtnId?: AbjectId;

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
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display job browser window', required: true },
        ],
        providedCapabilities: [],
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

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
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
      preferredSize: { height: 36 },
    }));

    // Spacer pushes button right
    await this.request(request(this.id, bottomRowId, 'addLayoutSpacer', {}));

    // Clear button
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'button', windowId: this.windowId, text: 'Clear' }],
      })
    );
    this.clearBtnId = widgetIds[0];

    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
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
    const icon = STATUS_ICONS[job.status] ?? '?';
    const num = job.id.replace('job-', '');
    const queueTag = job.queue && job.queue !== 'default' ? `[${job.queue}] ` : '';
    const elapsed = job.completedAt && job.startedAt
      ? `${((job.completedAt - job.startedAt) / 1000).toFixed(1)}s`
      : '';
    const errorSuffix = job.status === 'failed' && job.error
      ? ` -- ${job.error.slice(0, 30)}`
      : '';

    return {
      label: `${icon} #${num} ${queueTag}${job.description}${errorSuffix}`,
      value: job.id,
      secondary: elapsed,
    };
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    const items = this.jobs.map(j => this.formatJobItem(j));
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    } catch { /* widget may be gone */ }
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
      if (this.jobManagerId) {
        this.send(request(this.id, this.jobManagerId, 'clearHistory', {}));
      }
      this.jobs = [];
      await this.rebuildList();
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
          break;
        }
        case 'jobFailed': {
          const job = this.jobs.find(j => j.id === jobId);
          if (job) {
            job.status = 'failed';
            job.error = (data.error as string) ?? undefined;
            job.completedAt = Date.now();
          }
          await this.rebuildList();
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
