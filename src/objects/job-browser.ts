/**
 * JobBrowser — UI widget for viewing job execution status.
 *
 * Shows/hides from Taskbar. Subscribes to JobManager as a dependent to
 * receive real-time job status updates. Similar to AppExplorer but
 * for jobs instead of registered objects.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { Job } from './job-manager.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';

const JOB_BROWSER_INTERFACE: InterfaceId = 'abjects:job-browser';

const WIN_W = 400;
const WIN_H = 350;

export class JobBrowser extends Abject {
  private jobManagerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private jobListId?: AbjectId;
  private clearBtnId?: AbjectId;
  private jobLabelMap: Map<string, AbjectId> = new Map();

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
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('getState', async () => {
      return { visible: !!this.windowId, jobCount: this.jobLabelMap.size };
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleChanged(fromId, aspect, value);
    });
  }

  protected override getSourceForAsk(): string | undefined {
    return `## JobBrowser Usage Guide

### Methods
- \`show()\` — Open the job browser window. If already open, raises it to front.
- \`hide()\` — Close the job browser window and unsubscribe from JobManager.
- \`getState()\` — Returns { visible: boolean, jobCount: number }.

### Real-Time Job Monitoring
JobBrowser registers as a dependent of JobManager to receive live status updates.
Job status icons:
- ○ queued — job is waiting to execute
- ▸ running — job is currently executing
- ✓ completed — job finished successfully (shows elapsed time)
- ✗ failed — job encountered an error (shows error message)

### Clear Button
Calls JobManager.clearHistory() to remove completed/failed jobs, then refreshes the list.

### Interface ID
\`abjects:job-browser\``;
  }

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

    // Scrollable VBox for job list (expanding)
    this.jobListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    // Bottom bar with Clear button
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    // Add layouts to root
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.jobListId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: bottomRowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 36 } },
      ],
    }));

    // Spacer pushes button right
    await this.request(request(this.id, bottomRowId, 'addLayoutSpacer', {}));

    // Create clear button
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Clear' },
        ],
      })
    );
    this.clearBtnId = widgetIds[0];

    // Add to layout
    await this.request(request(this.id, bottomRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.clearBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: 36 } },
      ],
    }));

    // Fire-and-forget: register as dependent
    this.send(request(this.id, this.clearBtnId, 'addDependent', {}));
    this.send(request(this.id, this.jobManagerId!, 'addDependent', {}));

    // Populate existing jobs
    await this.populateExistingJobs();

    await this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    // Unsubscribe from JobManager
    try {
      await this.request(
        request(this.id, this.jobManagerId!, 'removeDependent', {})
      );
    } catch { /* best effort */ }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.jobListId = undefined;
    this.clearBtnId = undefined;
    this.jobLabelMap.clear();
    await this.changed('visibility', false);
    return true;
  }

  private async populateExistingJobs(): Promise<void> {
    if (!this.jobManagerId || !this.jobListId || !this.windowId) return;

    try {
      const jobs = await this.request<Job[]>(
        request(this.id, this.jobManagerId, 'listJobs', {})
      );

      // Jobs come back most-recent-first; display oldest first (top to bottom)
      const reversed = [...jobs].reverse();
      if (reversed.length === 0) return;

      const fontSize = 13;
      const lineHeight = fontSize + 4;
      const availableWidth = WIN_W - 32 - 8;

      // Build specs for all job labels
      const specs = reversed.map(job => {
        const { text, color } = this.formatJobLabel(job);
        return { type: 'label' as const, windowId: this.windowId!, text, style: { color, fontSize, wordWrap: true } };
      });

      // Batch create all labels
      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );

      // Build layout children specs
      const children = reversed.map((job, i) => {
        const { text } = this.formatJobLabel(job);
        const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
        const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);
        this.jobLabelMap.set(job.id, widgetIds[i]);
        return { widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed' as const }, preferredSize: { height: estimatedHeight } };
      });

      // Batch add to layout
      await this.request(request(this.id, this.jobListId, 'addLayoutChildren', { children }));
    } catch { /* JobManager may not have any jobs yet */ }
  }

  private formatJobLabel(job: Job): { text: string; color: string } {
    const elapsed = job.completedAt && job.startedAt
      ? `${((job.completedAt - job.startedAt) / 1000).toFixed(1)}s`
      : '';
    const queueTag = job.queue && job.queue !== 'default' ? `[${job.queue}] ` : '';

    switch (job.status) {
      case 'queued':
        return { text: `○ #${job.id.replace('job-', '')} ${queueTag}${job.description}`, color: this.theme.statusNeutral };
      case 'running':
        return { text: `▸ #${job.id.replace('job-', '')} ${queueTag}${job.description}`, color: this.theme.statusWarning };
      case 'completed':
        return { text: `✓ #${job.id.replace('job-', '')} ${queueTag}${job.description}${elapsed ? `  ${elapsed}` : ''}`, color: this.theme.statusSuccess };
      case 'failed':
        return { text: `✗ #${job.id.replace('job-', '')} ${queueTag}${job.description}`, color: this.theme.statusError };
      default:
        return { text: `? #${job.id.replace('job-', '')} ${queueTag}${job.description}`, color: this.theme.statusNeutral };
    }
  }

  private async appendJobLabel(jobId: string, text: string, color: string): Promise<void> {
    if (!this.jobListId || !this.windowId) return;

    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const availableWidth = WIN_W - 32 - 8;
    const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
    const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);

    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text, style: { color, fontSize, wordWrap: true } },
        ],
      })
    );
    await this.request(request(this.id, this.jobListId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: estimatedHeight },
    }));
    this.jobLabelMap.set(jobId, labelId);
  }

  private async updateJobLabel(jobId: string, text: string, color: string): Promise<void> {
    const labelId = this.jobLabelMap.get(jobId);
    if (!labelId) return;

    try {
      await this.request(
        request(this.id, labelId, 'update', {
          text,
          style: { color, fontSize: 13, wordWrap: true },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Clear button click
    if (fromId === this.clearBtnId && aspect === 'click') {
      if (this.jobManagerId) {
        await this.request(
          request(this.id, this.jobManagerId, 'clearHistory', {})
        );
      }
      // Rebuild the job list
      await this.clearJobLabels();
      await this.populateExistingJobs();
      return;
    }

    // JobManager events
    if (fromId === this.jobManagerId) {
      const data = value as Record<string, unknown> | undefined;
      if (!data) return;

      const jobId = data.jobId as string;
      const description = data.description as string;
      const queue = data.queue as string | undefined;
      const queueTag = queue && queue !== 'default' ? `[${queue}] ` : '';

      switch (aspect) {
        case 'jobQueued':
          await this.appendJobLabel(jobId, `○ #${jobId.replace('job-', '')} ${queueTag}${description}`, this.theme.statusNeutral);
          break;
        case 'jobStarted':
          await this.updateJobLabel(jobId, `▸ #${jobId.replace('job-', '')} ${queueTag}${description}`, this.theme.statusWarning);
          break;
        case 'jobCompleted':
          await this.updateJobLabel(jobId, `✓ #${jobId.replace('job-', '')} ${queueTag}${description}`, this.theme.statusSuccess);
          break;
        case 'jobFailed': {
          const error = data.error as string | undefined;
          const errorSuffix = error ? ` — ${error.slice(0, 30)}` : '';
          await this.updateJobLabel(jobId, `✗ #${jobId.replace('job-', '')} ${queueTag}${description}${errorSuffix}`, this.theme.statusError);
          break;
        }
        case 'historyCleared':
          await this.clearJobLabels();
          await this.populateExistingJobs();
          break;
      }
    }
  }

  private async clearJobLabels(): Promise<void> {
    if (!this.jobListId) return;

    // Clear layout in one request
    try {
      await this.request(request(this.id, this.jobListId, 'clearLayoutChildren', {}));
    } catch { /* may already be gone */ }

    // Fire-and-forget destroy all labels
    for (const [, labelId] of this.jobLabelMap) {
      this.send(request(this.id, labelId, 'destroy', {}));
    }
    this.jobLabelMap.clear();
  }
}

export const JOB_BROWSER_ID = 'abjects:job-browser' as AbjectId;
