/**
 * SchedulerBrowser -- UI for viewing and managing scheduled entries.
 *
 * Shows/hides from Taskbar. Subscribes to Scheduler as a dependent to
 * receive real-time schedule updates. Uses a ListWidget for the schedule
 * list and a detail pane for selected entry info.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { ScheduleEntry } from './scheduler.js';
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('SchedulerBrowser');

const SCHEDULER_BROWSER_INTERFACE: InterfaceId = 'abjects:scheduler-browser';

const WIN_W = 580;
const WIN_H = 400;

const STATUS_ICONS: Record<string, string> = {
  enabled:  '\u25B6',  // ▶
  disabled: '\u25A0',  // ■
};

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
  private detailMetaId?: AbjectId;
  private toggleBtnId?: AbjectId;
  private deleteBtnId?: AbjectId;

  private entries: ScheduleEntry[] = [];
  private selectedIndex = -1;

  constructor() {
    super({
      manifest: {
        name: 'SchedulerBrowser',
        description:
          'Browse and manage scheduled entries. Shows schedule descriptions, intervals, ' +
          'next run times, and allows enabling/disabling/deleting schedules.',
        version: '1.0.0',
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
              name: 'getState',
              description: 'Return current state of the scheduler browser',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
                scheduleCount: { kind: 'primitive', primitive: 'number' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display scheduler browser window', required: true },
        ],
        providedCapabilities: [],
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
    this.on('getState', async () => ({
      visible: !!this.windowId,
      scheduleCount: this.entries.length,
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
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
- \`getState()\` -- Returns { visible: boolean, scheduleCount: number }.

### Schedule Management
SchedulerBrowser shows all registered schedule entries with their status,
interval/time, last run, and next run. Select an entry to see details.
Use Toggle to enable/disable, Delete to remove.

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
        title: '\u23F0 Schedules',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // Split pane: list | detail
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

    // Right pane: outer VBox with scrollable detail + buttons at bottom
    const rightOuterId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    // Scrollable detail area (expanding)
    this.detailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 4, left: 12 },
        spacing: 6,
      })
    );

    // Detail labels
    const { widgetIds: detailIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: 'Select a schedule',
            style: { fontSize: 14, fontWeight: 'bold', color: this.theme.textHeading, wordWrap: true } },
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 12, color: this.theme.textPrimary, wordWrap: true, markdown: true } },
          { type: 'label', windowId: this.windowId, text: '',
            style: { fontSize: 11, color: this.theme.textSecondary, wordWrap: true } },
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

    // Action buttons (fixed at bottom)
    const btnRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedHBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 12, bottom: 8, left: 12 },
        spacing: 8,
      })
    );

    const { widgetIds: btnIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Toggle' },
          { type: 'button', windowId: this.windowId, text: 'Delete' },
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
    if (this.schedulerId) {
      this.send(request(this.id, this.schedulerId, 'addDependent', {}));
    }

    // Populate
    await this.loadEntries();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    if (this.schedulerId) {
      this.send(request(this.id, this.schedulerId, 'removeDependent', {}));
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.listWidgetId = undefined;
    this.detailLayoutId = undefined;
    this.detailTitleId = undefined;
    this.detailDescId = undefined;
    this.detailMetaId = undefined;
    this.toggleBtnId = undefined;
    this.deleteBtnId = undefined;
    this.entries = [];
    this.selectedIndex = -1;
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

  private formatListItem(entry: ScheduleEntry): ListItem {
    const icon = STATUS_ICONS[entry.enabled ? 'enabled' : 'disabled'];
    let timing: string;
    if (entry.intervalMs) {
      timing = this.formatInterval(entry.intervalMs);
    } else if (entry.runAt !== undefined) {
      timing = `once @ ${new Date(entry.runAt).toLocaleString()}`;
    } else {
      timing = `${String(entry.hour ?? 0).padStart(2, '0')}:${String(entry.minute ?? 0).padStart(2, '0')} ${entry.timezone ?? 'local'}`;
    }
    return {
      label: `${icon} ${entry.description}`,
      value: entry.id,
      secondary: timing,
    };
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
  }

  private async showDetail(): Promise<void> {
    const entry = this.entries[this.selectedIndex];
    if (!entry) {
      await this.updateDetail('Select a schedule', '', '');
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

    const desc = `${timing}\n**Enabled:** ${entry.enabled ? 'Yes' : 'No'}\n\n**Job code:**\n\`\`\`\n${entry.jobCode.slice(0, 300)}\n\`\`\``;
    const meta = `Last run: ${lastRun} | Next run: ${nextRun} | ID: ${entry.id}`;

    await this.updateDetail(entry.description, desc, meta);
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

    // Toggle button
    if (fromId === this.toggleBtnId && aspect === 'click') {
      const entry = this.entries[this.selectedIndex];
      if (!entry || !this.schedulerId) return;
      const method = entry.enabled ? 'disableSchedule' : 'enableSchedule';
      if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: true }));
      try {
        await this.request(
          request(this.id, this.schedulerId, method, { scheduleId: entry.id }),
          5000,
        );
        entry.enabled = !entry.enabled;
        await this.rebuildList();
        await this.showDetail();
        await this.notify(`Schedule ${entry.enabled ? 'enabled' : 'disabled'}`, 'success');
      } catch (err) {
        log.warn('Failed to toggle schedule:', err);
        await this.notify('Toggle failed', 'error');
      } finally {
        if (this.toggleBtnId) this.send(event(this.id, this.toggleBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Delete button
    if (fromId === this.deleteBtnId && aspect === 'click') {
      const entry = this.entries[this.selectedIndex];
      if (!entry || !this.schedulerId) return;
      const confirmed = await this.confirm({
        title: 'Delete Schedule',
        message: `Delete schedule "${entry.description}"?`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!confirmed) return;
      if (this.deleteBtnId) this.send(event(this.id, this.deleteBtnId, 'update', { busy: true }));
      try {
        await this.request(
          request(this.id, this.schedulerId, 'removeSchedule', { scheduleId: entry.id }),
          5000,
        );
        this.selectedIndex = -1;
        await this.loadEntries();
        await this.updateDetail('Select a schedule', '', '');
        await this.notify('Schedule deleted', 'success');
      } catch (err) {
        log.warn('Failed to delete schedule:', err);
        await this.notify('Delete failed', 'error');
      } finally {
        if (this.deleteBtnId) this.send(event(this.id, this.deleteBtnId, 'update', { busy: false }));
      }
      return;
    }

    // Scheduler events -- refresh
    if (fromId === this.schedulerId) {
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
  }
}

export const SCHEDULER_BROWSER_ID = 'abjects:scheduler-browser' as AbjectId;
