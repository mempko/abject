/**
 * JobBrowser — UI widget for viewing job execution status.
 *
 * Shows/hides from Taskbar. Subscribes to JobManager as a dependent to
 * receive real-time job status updates. Similar to RegistryBrowser but
 * for jobs instead of registered objects.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import type { Job } from './job-manager.js';

const JOB_BROWSER_INTERFACE: InterfaceId = 'abjects:job-browser';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const JOBMANAGER_INTERFACE: InterfaceId = 'abjects:job-manager';

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
        interfaces: [
          {
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
        ],
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

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleChanged(fromId, aspect, value);
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Jobs',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Scrollable VBox for job list (expanding)
    this.jobListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.jobListId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Bottom bar with Clear button
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: bottomRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Spacer pushes button right
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Clear button
    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    this.clearBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: r0,
        text: 'Clear',
      })
    );
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.clearBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 36 },
    }));

    // Register as dependent of Clear button
    await this.request(
      request(this.id, this.clearBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {})
    );

    // Register as dependent of JobManager to receive change events
    await this.request(
      request(this.id, this.jobManagerId!, INTROSPECT_INTERFACE_ID, 'addDependent', {})
    );

    // Populate existing jobs
    await this.populateExistingJobs();

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    // Unsubscribe from JobManager
    try {
      await this.request(
        request(this.id, this.jobManagerId!, INTROSPECT_INTERFACE_ID, 'removeDependent', {})
      );
    } catch { /* best effort */ }

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.jobListId = undefined;
    this.clearBtnId = undefined;
    this.jobLabelMap.clear();
    return true;
  }

  private async populateExistingJobs(): Promise<void> {
    if (!this.jobManagerId || !this.jobListId) return;

    try {
      const jobs = await this.request<Job[]>(
        request(this.id, this.jobManagerId, JOBMANAGER_INTERFACE, 'listJobs', {})
      );

      // Jobs come back most-recent-first; display oldest first (top to bottom)
      const reversed = [...jobs].reverse();
      for (const job of reversed) {
        const { text, color } = this.formatJobLabel(job);
        await this.appendJobLabel(job.id, text, color);
      }
    } catch { /* JobManager may not have any jobs yet */ }
  }

  private formatJobLabel(job: Job): { text: string; color: string } {
    const elapsed = job.completedAt && job.startedAt
      ? `${((job.completedAt - job.startedAt) / 1000).toFixed(1)}s`
      : '';

    switch (job.status) {
      case 'queued':
        return { text: `○ #${job.id.replace('job-', '')} ${job.description}`, color: '#6b7084' };
      case 'running':
        return { text: `▸ #${job.id.replace('job-', '')} ${job.description}`, color: '#e8a84c' };
      case 'completed':
        return { text: `✓ #${job.id.replace('job-', '')} ${job.description}${elapsed ? `  ${elapsed}` : ''}`, color: '#a8cc8c' };
      case 'failed':
        return { text: `✗ #${job.id.replace('job-', '')} ${job.description}`, color: '#e05561' };
      default:
        return { text: `? #${job.id.replace('job-', '')} ${job.description}`, color: '#6b7084' };
    }
  }

  private async appendJobLabel(jobId: string, text: string, color: string): Promise<void> {
    if (!this.jobListId || !this.windowId) return;

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const labelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text,
        style: { color, fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.jobListId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    this.jobLabelMap.set(jobId, labelId);
  }

  private async updateJobLabel(jobId: string, text: string, color: string): Promise<void> {
    const labelId = this.jobLabelMap.get(jobId);
    if (!labelId) return;

    try {
      await this.request(
        request(this.id, labelId, WIDGET_INTERFACE, 'update', {
          text,
          style: { color, fontSize: 13 },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // Clear button click
    if (fromId === this.clearBtnId && aspect === 'click') {
      if (this.jobManagerId) {
        await this.request(
          request(this.id, this.jobManagerId, JOBMANAGER_INTERFACE, 'clearHistory', {})
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

      switch (aspect) {
        case 'jobQueued':
          await this.appendJobLabel(jobId, `○ #${jobId.replace('job-', '')} ${description}`, '#6b7084');
          break;
        case 'jobStarted':
          await this.updateJobLabel(jobId, `▸ #${jobId.replace('job-', '')} ${description}`, '#e8a84c');
          break;
        case 'jobCompleted':
          await this.updateJobLabel(jobId, `✓ #${jobId.replace('job-', '')} ${description}`, '#a8cc8c');
          break;
        case 'jobFailed': {
          const error = data.error as string | undefined;
          const errorSuffix = error ? ` — ${error.slice(0, 30)}` : '';
          await this.updateJobLabel(jobId, `✗ #${jobId.replace('job-', '')} ${description}${errorSuffix}`, '#e05561');
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

    for (const [, labelId] of this.jobLabelMap) {
      try {
        await this.request(request(this.id, this.jobListId, LAYOUT_INTERFACE, 'removeLayoutChild', {
          widgetId: labelId,
        }));
      } catch { /* may already be gone */ }
      try {
        await this.request(request(this.id, labelId, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* already gone */ }
    }
    this.jobLabelMap.clear();
  }
}

export const JOB_BROWSER_ID = 'abjects:job-browser' as AbjectId;
