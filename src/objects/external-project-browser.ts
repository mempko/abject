/**
 * ExternalProjectBrowser -- the window onto the external projects.
 *
 * ExternalProjectRegistry holds the state and answers questions about it; this
 * object only shows it and collects the handful of decisions that need a human:
 * which directory, what to call it, how to check it, and whether to trust it.
 * Keeping the two apart is what lets the registry stay usable headlessly, from
 * the CLI, and from an agent.
 *
 * Trust is the one control here that is not a convenience. A trusted project's
 * CLAUDE.md / AGENTS.md are injected into an agent's prompt, which makes them
 * instructions written by whoever wrote that repository. That is a decision for
 * the person sitting here, so it is a button rather than a default.
 *
 * Autonomy is the second. It says how much work here proceeds without a prompt,
 * and it is deliberately only settable from this window: nothing an agent sends
 * raises it. What a project asks for is not always what it gets, because the
 * access mode of the workspace caps it, so each row shows the level actually in
 * force and what capped it when those differ.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { AUTONOMY_LEVELS, type AutonomyLevel, type ExternalProject } from './external-project-registry.js';
import type { Rule, RuleScope } from './permission-broker.js';
import { isInside } from '../core/path-scope.js';
import type { ListItem } from './widgets/list-widget.js';

type ManagedRule = { index: number } & Rule;

const log = new Log('ExternalProjectBrowser');

const BROWSER_INTERFACE: InterfaceId = 'abjects:external-project-browser';

const WIN_W = 1040;
const WIN_H = 620;
const BUTTON_ROW_H = 36;

/** The isolation modes a project can be worked in. */
const ISOLATION_MODES = ['none', 'worktree'] as const;

/** Decode ListWidget's JSON change payload while preserving legacy raw values. */
function listSelectionValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string'
      ? (value as { value: string }).value
      : undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { value?: unknown }).value === 'string') {
      return (parsed as { value: string }).value;
    }
  } catch {
    // Older `select` events may carry the item value directly.
  }
  return value;
}

export class ExternalProjectBrowser extends Abject {
  private registryObjId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private tabBarId?: AbjectId;
  private detailsWidgetId?: AbjectId;
  private grantsWidgetId?: AbjectId;
  private rightBodyId?: AbjectId;      // scrollable body of the right pane

  // The configuration pane edits in place. Every control is held by id so a
  // change event can be traced back to the field it belongs to, and the draft
  // holds what has been typed but not yet saved.
  private configEditorIds: AbjectId[] = [];
  private descInputId?: AbjectId;
  private checkInputId?: AbjectId;
  private verifyInputId?: AbjectId;
  private formatInputId?: AbjectId;
  private setupInputId?: AbjectId;
  private sharedInputId?: AbjectId;
  private protectedInputId?: AbjectId;
  private isolationSelectId?: AbjectId;
  private autonomySelectId?: AbjectId;
  private trustedCheckId?: AbjectId;
  private saveBtnId?: AbjectId;
  private revertBtnId?: AbjectId;
  private configDraft = new Map<string, string>();
  private configDirty = false;
  private configProjectName = '';

  private grantRowId?: AbjectId;
  private addBtnId?: AbjectId;
  private settingsBtnId?: AbjectId;
  private editBtnId?: AbjectId;
  private trustBtnId?: AbjectId;
  private autonomyBtnId?: AbjectId;
  private removeBtnId?: AbjectId;
  private addGrantBtnId?: AbjectId;
  private editGrantBtnId?: AbjectId;
  private removeGrantBtnId?: AbjectId;

  private projects: ExternalProject[] = [];
  /** Level actually in force per project, and what capped it. */
  private effective = new Map<string, { effective: AutonomyLevel; cappedBy: string }>();
  private brokerId?: AbjectId;
  private permissionRules: ManagedRule[] = [];
  private selected?: string;
  private selectedRuleIndex?: number;
  private activeTab = 0;

  constructor() {
    super({
      manifest: {
        name: 'ExternalProjectBrowser',
        description:
          'Browse and manage external projects, their configuration, and the standing permission ' +
          'grants that apply to them. Nothing here deletes project files from disk.',
        version: '1.0.0',
        icon: '📁',
        interface: {
          id: BROWSER_INTERFACE,
          name: 'ExternalProjectBrowser',
          description: 'External project manager UI',
          methods: [
            { name: 'show', description: 'Show the window', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'hide', description: 'Hide the window', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            {
              name: 'getState',
              description: 'Current state of the browser',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
                projectCount: { kind: 'primitive', primitive: 'number' },
                selected: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display the external project window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'projects'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryObjId = await this.discoverDep('ExternalProjectRegistry') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      projectCount: this.projects.length,
      selected: this.selected ?? null,
    }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  protected override askPrompt(question: string): string {
    return super.askPrompt(question) + `\n\n## ExternalProjectBrowser

I am the window onto the **external projects**: named directories on disk holding
a body of work. The state itself lives in ExternalProjectRegistry — ask that
object what is registered and how a project is built. I show the list and collect
the decisions that need a person: which directory, what to call it, the commands
that check and verify it, and whether it is trusted.

### Methods
- \`show()\` — open the window (raises it if already open).
- \`hide()\` — close it.
- \`getState()\` — { visible, projectCount, selected }.

### Trust
A trusted project's CLAUDE.md / AGENTS.md get injected into an agent's prompt and
its declared commands may be run. That is a deliberate choice about text and code
someone else wrote, so it is a button here rather than something granted on add.`;
  }

  // ─── Window lifecycle ───────────────────────────────────────────

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', { windowId: this.windowId }));
      } catch { /* best effort */ }
      return true;
    }

    const display = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {}),
    );
    const winX = Math.max(20, Math.floor((display.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((display.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '📁 External Projects',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      }),
    );

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      }),
    );

    const splitId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 10,
      }),
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: splitId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const leftPaneId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: splitId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      }),
    );
    const rightPaneId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: splitId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      }),
    );
    await this.request(request(this.id, splitId, 'updateLayoutChild', {
      widgetId: leftPaneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'fixed' },
      preferredSize: { width: 380 },
    }));
    await this.request(request(this.id, splitId, 'updateLayoutChild', {
      widgetId: rightPaneId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const { widgetIds: [listId, tabBarId, detailsId, grantsId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'list', windowId: this.windowId, items: [], searchable: true },
          {
            type: 'tabBar',
            windowId: this.windowId,
            tabs: ['Configuration', 'Grants'],
            selectedIndex: this.activeTab,
            closable: false,
          },
          { type: 'list', windowId: this.windowId, items: [] },
          { type: 'list', windowId: this.windowId, items: [] },
        ],
      }),
    );
    this.listWidgetId = listId;
    this.tabBarId = tabBarId;
    this.detailsWidgetId = detailsId;
    this.grantsWidgetId = grantsId;

    // What a project needs configured is small and known, so it is offered as
    // fields to edit rather than a list to click through and a chain of modal
    // prompts to answer -- the same shape the system settings and network
    // panes use. The summary list above stays as the at-a-glance view.
    const { widgetIds: editorIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: 'Description' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'What this project is' },
          { type: 'label', windowId: this.windowId, text: 'Check command' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'Fast check, run after every edit' },
          { type: 'label', windowId: this.windowId, text: 'Verify command' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'Full verification, such as the test suite' },
          { type: 'label', windowId: this.windowId, text: 'Format command' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'Optional formatting command' },
          { type: 'label', windowId: this.windowId, text: 'Setup command' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'Optional setup command' },
          { type: 'label', windowId: this.windowId, text: 'Shared paths' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'Comma-separated paths isolation may share' },
          { type: 'label', windowId: this.windowId, text: 'Protected paths' },
          { type: 'textInput', windowId: this.windowId, text: '', placeholder: 'Comma-separated paths that always ask before writes' },
          { type: 'label', windowId: this.windowId, text: 'Isolation' },
          { type: 'select', windowId: this.windowId, options: [...ISOLATION_MODES], selectedIndex: 0 },
          { type: 'label', windowId: this.windowId, text: 'Autonomy requested' },
          { type: 'select', windowId: this.windowId, options: [...AUTONOMY_LEVELS], selectedIndex: 0 },
          { type: 'checkbox', windowId: this.windowId, checked: false, text: 'Trusted — may act here without asking every time' },
          { type: 'button', windowId: this.windowId, text: 'Save changes' },
          { type: 'button', windowId: this.windowId, text: 'Revert' },
        ],
      }),
    );

    // Positions follow the spec order above: label, control, label, control...
    this.configEditorIds = editorIds;
    this.descInputId = editorIds[1];
    this.checkInputId = editorIds[3];
    this.verifyInputId = editorIds[5];
    this.formatInputId = editorIds[7];
    this.setupInputId = editorIds[9];
    this.sharedInputId = editorIds[11];
    this.protectedInputId = editorIds[13];
    this.isolationSelectId = editorIds[15];
    this.autonomySelectId = editorIds[17];
    this.trustedCheckId = editorIds[18];
    this.saveBtnId = editorIds[19];
    this.revertBtnId = editorIds[20];
    await this.request(request(this.id, leftPaneId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    // The tab bar stays pinned as the pane header; everything that can
    // overflow lives in a scrollable body -- the same header + scroll body
    // pattern the system settings and network panes use -- so the full
    // configuration form stays reachable even on short windows.
    await this.request(request(this.id, rightPaneId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 34 },
    }));
    const rightBodyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: rightPaneId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      }),
    );
    this.rightBodyId = rightBodyId;
    await this.request(request(this.id, rightBodyId, 'addLayoutChildren', {
      children: [
        { widgetId: this.detailsWidgetId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 116 } },
        ...this.configEditorIds.map(id => ({
          widgetId: id,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 26 },
        })),
        // A fixed height: an expanding child inside a scroll container has no
        // stable height to expand against, which is what let the pane clip.
        { widgetId: this.grantsWidgetId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 260 } },
      ],
    }));

    this.grantRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: rightBodyId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      }),
    );
    await this.request(request(this.id, rightBodyId, 'updateLayoutChild', {
      widgetId: this.grantRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: BUTTON_ROW_H },
    }));

    const buttonRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      }),
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: buttonRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: BUTTON_ROW_H },
    }));

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: 'Add project…' },
          { type: 'button', windowId: this.windowId, text: 'Settings…' },
          { type: 'button', windowId: this.windowId, text: 'Commands…' },
          { type: 'button', windowId: this.windowId, text: 'Trust' },
          { type: 'button', windowId: this.windowId, text: 'Autonomy…' },
          { type: 'button', windowId: this.windowId, text: 'Remove project' },
          { type: 'button', windowId: this.windowId, text: 'Add grant…' },
          { type: 'button', windowId: this.windowId, text: 'Edit grant…' },
          { type: 'button', windowId: this.windowId, text: 'Remove grant' },
        ],
      }),
    );
    [
      this.addBtnId, this.settingsBtnId, this.editBtnId, this.trustBtnId,
      this.autonomyBtnId, this.removeBtnId, this.addGrantBtnId,
      this.editGrantBtnId, this.removeGrantBtnId,
    ] = widgetIds;

    await this.request(request(this.id, buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.addBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: BUTTON_ROW_H } },
        { widgetId: this.settingsBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: BUTTON_ROW_H } },
        { widgetId: this.editBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: BUTTON_ROW_H } },
        { widgetId: this.trustBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 90, height: BUTTON_ROW_H } },
        { widgetId: this.autonomyBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: BUTTON_ROW_H } },
      ],
    }));
    await this.request(request(this.id, buttonRowId, 'addLayoutSpacer', {}));
    await this.request(request(this.id, buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.removeBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 130, height: BUTTON_ROW_H } },
      ],
    }));
    await this.request(request(this.id, this.grantRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.addGrantBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: BUTTON_ROW_H } },
        { widgetId: this.editGrantBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: BUTTON_ROW_H } },
        { widgetId: this.removeGrantBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: BUTTON_ROW_H } },
      ],
    }));

    for (const id of widgetIds) this.send(request(this.id, id, 'addDependent', {}));
    for (const id of this.configEditorIds) this.send(request(this.id, id, 'addDependent', {}));
    if (this.listWidgetId) this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    if (this.tabBarId) this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.updateTabVisibility();
    if (this.registryObjId) this.send(request(this.id, this.registryObjId, 'addDependent', {}));
    this.brokerId = await this.resolveDep('PermissionBroker', this.brokerId);
    if (this.brokerId) this.send(request(this.id, this.brokerId, 'addDependent', {}));

    await this.load();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    if (this.registryObjId) this.send(request(this.id, this.registryObjId, 'removeDependent', {}));
    if (this.brokerId) this.send(request(this.id, this.brokerId, 'removeDependent', {}));

    await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId: this.windowId }));

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.listWidgetId = undefined;
    this.tabBarId = undefined;
    this.detailsWidgetId = undefined;
    this.grantsWidgetId = undefined;
    this.configEditorIds = [];
    this.descInputId = undefined;
    this.checkInputId = undefined;
    this.verifyInputId = undefined;
    this.formatInputId = undefined;
    this.setupInputId = undefined;
    this.sharedInputId = undefined;
    this.protectedInputId = undefined;
    this.isolationSelectId = undefined;
    this.autonomySelectId = undefined;
    this.trustedCheckId = undefined;
    this.saveBtnId = undefined;
    this.revertBtnId = undefined;
    this.configDraft.clear();
    this.configDirty = false;
    this.configProjectName = '';
    this.grantRowId = undefined;
    this.addBtnId = undefined;
    this.settingsBtnId = undefined;
    this.editBtnId = undefined;
    this.trustBtnId = undefined;
    this.autonomyBtnId = undefined;
    this.removeBtnId = undefined;
    this.addGrantBtnId = undefined;
    this.editGrantBtnId = undefined;
    this.removeGrantBtnId = undefined;
    this.projects = [];
    this.permissionRules = [];
    this.selected = undefined;
    this.selectedRuleIndex = undefined;
    this.activeTab = 0;
    this.changed('visibility', false);
    return true;
  }

  // ─── Data ───────────────────────────────────────────────────────

  private async registry(): Promise<AbjectId | undefined> {
    if (!this.registryObjId) {
      this.registryObjId = await this.discoverDep('ExternalProjectRegistry') ?? undefined;
    }
    return this.registryObjId;
  }

  private async load(): Promise<void> {
    const reg = await this.registry();
    if (!reg) return;
    try {
      this.projects = await this.request<ExternalProject[]>(request(this.id, reg, 'listProjects', {}));
    } catch (err) {
      log.warn(`could not list projects: ${err instanceof Error ? err.message : String(err)}`);
      this.projects = [];
    }
    if (this.selected && !this.projects.some(p => p.name === this.selected)) this.selected = undefined;
    await this.refreshEffective();
    await this.loadRules();
    await this.rebuildList();
    await this.rebuildDetails();
  }

  private formatItem(p: ExternalProject): ListItem {
    const commands = [p.checkCommand, p.verifyCommand].filter(Boolean).length;
    // A root that is not on disk is the first thing to say about a project:
    // nothing can run there until the user fixes or removes it.
    const secondary = p.rootMissing ? `${p.root} (missing)` : p.root;
    // What the row has to convey at a glance: where it is, whether it can be
    // checked automatically, and whether its instructions are being trusted.
    const detail = commands === 0
      ? 'no commands'
      : `${p.checkCommand ? 'check' : ''}${p.checkCommand && p.verifyCommand ? ' + ' : ''}${p.verifyCommand ? 'verify' : ''}`;

    // What is actually in force, which is not always what the project asks
    // for: a public workspace holds everything at "ask". Saying so on the row
    // is the difference between a considered setting and a silent mystery.
    const eff = this.effective.get(p.name);
    const level = eff?.effective ?? (p.trusted ? p.autonomy : 'ask');
    const capped = eff && eff.cappedBy && eff.effective !== p.autonomy
      ? ` (asks ${p.autonomy}, capped by ${eff.cappedBy})`
      : '';

    return {
      label: `${p.name} — ${detail}${p.isolation === 'worktree' ? ' · worktree' : ''}${capped}`,
      value: p.name,
      secondary,
      badge: !p.trusted
        ? { text: 'Untrusted', color: this.theme.statusNeutral }
        : level === 'ask'
          ? { text: 'Asks', color: this.theme.statusNeutral }
          : level === 'read'
            ? { text: 'Auto: read', color: this.theme.statusSuccess }
            : level === 'edit'
              ? { text: 'Auto: edit', color: this.theme.statusWarning }
              : { text: 'Auto: full', color: this.theme.statusError },
    };
  }

  /**
   * Ask the broker what each project's level comes out as once the workspace
   * ceiling is applied. Best-effort: without a broker the row falls back to
   * showing what the project asks for.
   */
  private async refreshEffective(): Promise<void> {
    this.brokerId = await this.resolveDep('PermissionBroker', this.brokerId);
    if (!this.brokerId) return;
    for (const p of this.projects) {
      try {
        const r = await this.request<{ effective: AutonomyLevel; cappedBy: string }>(
          request(this.id, this.brokerId, 'getEffectiveAutonomy', { project: p.name, callerId: this.id }),
          10_000,
        );
        if (r) this.effective.set(p.name, { effective: r.effective, cappedBy: r.cappedBy });
      } catch { /* the row falls back to the requested level */ }
    }
  }

  private async loadRules(): Promise<void> {
    if (!this.brokerId) return;
    try {
      this.permissionRules = await this.request<ManagedRule[]>(
        request(this.id, this.brokerId, 'listRules', {}), 10_000);
    } catch {
      this.permissionRules = [];
    }
  }

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', {
        items: this.projects.map(p => this.formatItem(p)),
      }));
    } catch { /* widget may be gone */ }
  }

  private applicableRules(project: ExternalProject): ManagedRule[] {
    return this.permissionRules.filter(rule => {
      if (rule.kind === 'exact') return true;
      if (rule.scope.kind === 'anywhere') return true;
      if (rule.scope.kind === 'project') return rule.scope.name === project.name;
      return isInside(project.root, rule.scope.root) || isInside(rule.scope.root, project.root);
    });
  }

  private scopeLabel(rule: Rule, project: ExternalProject): string {
    if (rule.kind === 'exact') return 'Broader · exact command (not project-scoped)';
    if (rule.scope.kind === 'project') return `Project-scoped · ${rule.scope.name}`;
    if (rule.scope.kind === 'anywhere') return 'Broader · applies anywhere';
    if (isInside(project.root, rule.scope.root)) return `Broader path · ${rule.scope.root}`;
    return `Project subpath · ${rule.scope.root}`;
  }

  private ruleLabel(rule: Rule): string {
    const subject = rule.kind === 'class' ? `class ${rule.effect}`
      : rule.kind === 'program' ? `program ${rule.program}` : `command ${rule.command}`;
    return `${rule.allow ? 'Allow' : 'Deny'} ${subject} for ${rule.caller}`;
  }

  private async rebuildDetails(): Promise<void> {
    if (!this.detailsWidgetId || !this.grantsWidgetId) return;
    const project = this.current();
    const details: ListItem[] = project ? [
      { label: `Configuration — ${project.name}`, value: 'heading', secondary: project.description || 'No description' },
      { label: 'Root', value: 'root', secondary: project.root },
      { label: 'Check command', value: 'check', secondary: project.checkCommand || 'Not configured' },
      { label: 'Verify command', value: 'verify', secondary: project.verifyCommand || 'Not configured' },
      { label: 'Format / setup', value: 'aux', secondary: `${project.formatCommand || 'none'} / ${project.setupCommand || 'none'}` },
      { label: 'Trust and autonomy', value: 'security', secondary: `${project.trusted ? 'Trusted' : 'Untrusted'} · requested ${project.autonomy} · effective ${this.effective.get(project.name)?.effective ?? 'ask'}` },
      { label: 'Isolation / VCS', value: 'isolation', secondary: `${project.isolation} / ${project.vcs}` },
      { label: 'Shared paths', value: 'shared', secondary: (project.sharedPaths ?? []).length ? (project.sharedPaths ?? []).join(', ') : 'None' },
      { label: 'Protected paths', value: 'protected', secondary: (project.protectedPaths ?? []).length ? (project.protectedPaths ?? []).join(', ') : 'None' },
    ] : [{ label: 'Select a project', value: 'empty', secondary: 'Configuration and applicable permission grants appear here.' }];

    const grants: ListItem[] = project
      ? this.applicableRules(project).map(rule => ({
          label: this.ruleLabel(rule),
          value: `rule:${rule.index}`,
          secondary: this.scopeLabel(rule, project),
          badge: { text: rule.allow ? 'ALLOW' : 'DENY', color: rule.allow ? this.theme.statusSuccess : this.theme.statusError },
        }))
      : [];
    if (project && grants.length === 0) grants.push({ label: 'Applicable permission grants', value: 'none', secondary: 'No standing grants affect this project.' });
    try {
      await this.request(request(this.id, this.detailsWidgetId, 'update', { items: details }));
      await this.request(request(this.id, this.grantsWidgetId, 'update', { items: grants }));
    } catch { /* widgets may have been closed */ }

    await this.rebuildEditor(project);
  }

  /**
   * Fill the editable fields from the registry's copy of the project.
   *
   * A refresh must not silently discard what someone is in the middle of
   * typing, so a dirty draft for the project still selected is left alone.
   * Selecting a different project does replace it: the draft belonged to the
   * project that was on screen.
   */
  private async rebuildEditor(project?: ExternalProject): Promise<void> {
    if (this.configEditorIds.length === 0) return;

    const name = project?.name ?? '';
    if (this.configDirty && this.configProjectName === name) return;

    this.configProjectName = name;
    this.configDraft.clear();
    this.configDirty = false;

    const isolationIndex = Math.max(0, (ISOLATION_MODES as readonly string[]).indexOf(project?.isolation ?? 'none'));
    const autonomyIndex = Math.max(0, (AUTONOMY_LEVELS as readonly string[]).indexOf(project?.autonomy ?? 'ask'));

    const updates: Array<[AbjectId | undefined, Record<string, unknown>]> = [
      [this.descInputId, { text: project?.description ?? '' }],
      [this.checkInputId, { text: project?.checkCommand ?? '' }],
      [this.verifyInputId, { text: project?.verifyCommand ?? '' }],
      [this.formatInputId, { text: project?.formatCommand ?? '' }],
      [this.setupInputId, { text: project?.setupCommand ?? '' }],
      [this.sharedInputId, { text: (project?.sharedPaths ?? []).join(', ') }],
      [this.protectedInputId, { text: (project?.protectedPaths ?? []).join(', ') }],
      [this.isolationSelectId, { options: [...ISOLATION_MODES], selectedIndex: isolationIndex }],
      [this.autonomySelectId, { options: [...AUTONOMY_LEVELS], selectedIndex: autonomyIndex }],
      [this.trustedCheckId, { checked: project?.trusted ?? false }],
      [this.saveBtnId, { text: 'Save changes' }],
    ];

    try {
      for (const [id, payload] of updates) {
        if (id) await this.request(request(this.id, id, 'update', payload));
      }
    } catch { /* widgets may have been closed */ }
  }

  /** Which configuration field a control in the pane stands for. */
  private editorFieldFor(widgetId: AbjectId): string | undefined {
    if (widgetId === this.descInputId) return 'description';
    if (widgetId === this.checkInputId) return 'checkCommand';
    if (widgetId === this.verifyInputId) return 'verifyCommand';
    if (widgetId === this.formatInputId) return 'formatCommand';
    if (widgetId === this.setupInputId) return 'setupCommand';
    if (widgetId === this.sharedInputId) return 'sharedPaths';
    if (widgetId === this.protectedInputId) return 'protectedPaths';
    if (widgetId === this.isolationSelectId) return 'isolation';
    if (widgetId === this.autonomySelectId) return 'autonomy';
    if (widgetId === this.trustedCheckId) return 'trusted';
    return undefined;
  }

  /**
   * Write the pane back to the registry.
   *
   * Description, commands, paths and isolation are ordinary settings and go in
   * one updateProject call. Trust and autonomy are not: the registry gates them
   * separately because they hand out power, so they only move when they
   * actually differ from what is stored, and granting trust still asks.
   */
  private async saveConfiguration(): Promise<void> {
    const reg = await this.registry();
    const project = this.current();
    if (!reg || !project) {
      await this.notify('Select a project first', 'warning');
      return;
    }

    const draft = (key: string, fallback: string): string => this.configDraft.get(key) ?? fallback;
    const list = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);

    const protectedPaths = list(draft('protectedPaths', (project.protectedPaths ?? []).join(', ')));
    if ((project.protectedPaths ?? []).length > protectedPaths.length) {
      const ok = await this.confirm({
        title: 'Reduce protected paths?',
        message: 'Removing protected paths permits more writes without an explicit prompt. Continue?',
        confirmLabel: 'Save changes',
        destructive: true,
      });
      if (!ok) return;
    }

    const checkCommand = draft('checkCommand', project.checkCommand ?? '');
    const verifyCommand = draft('verifyCommand', project.verifyCommand ?? '');
    const formatCommand = draft('formatCommand', project.formatCommand ?? '');
    const setupCommand = draft('setupCommand', project.setupCommand ?? '');

    try {
      await this.request(request(this.id, reg, 'updateProject', {
        name: project.name,
        changes: {
          description: draft('description', project.description ?? ''),
          checkCommand: checkCommand || undefined,
          verifyCommand: verifyCommand || undefined,
          formatCommand: formatCommand || undefined,
          setupCommand: setupCommand || undefined,
          sharedPaths: list(draft('sharedPaths', (project.sharedPaths ?? []).join(', '))),
          protectedPaths,
          isolation: draft('isolation', project.isolation) as ExternalProject['isolation'],
        },
      }));
    } catch (err) {
      await this.notify(`Could not save ${project.name}: ${(err as Error).message}`, 'error');
      return;
    }

    // The checkbox reports the string 'true' or 'false', never a boolean.
    const wantTrusted = this.configDraft.has('trusted')
      ? this.configDraft.get('trusted') === 'true'
      : project.trusted;
    if (wantTrusted !== project.trusted) {
      const granting = wantTrusted && !await this.confirm({
        title: `Trust ${project.name}?`,
        message: 'A trusted project may run commands here without asking every time.',
        confirmLabel: 'Trust',
      });
      if (!granting) {
        try {
          await this.request(request(this.id, reg, 'setTrusted', {
            name: project.name,
            trusted: wantTrusted,
          }));
        } catch (err) {
          await this.notify(`Could not change trust: ${(err as Error).message}`, 'error');
        }
      }
    }

    const wantAutonomy = draft('autonomy', project.autonomy) as AutonomyLevel;
    if (wantAutonomy !== project.autonomy) {
      try {
        const r = await this.request<{ success: boolean; error?: string }>(
          request(this.id, reg, 'setAutonomy', { name: project.name, autonomy: wantAutonomy }));
        if (r && !r.success) await this.notify(r.error ?? 'Could not change autonomy', 'error');
      } catch (err) {
        await this.notify(`Could not change autonomy: ${(err as Error).message}`, 'error');
      }
    }

    this.configDraft.clear();
    this.configDirty = false;
    await this.load();
  }

  /** Throw the unsaved draft away and show what the registry holds. */
  private async revertConfiguration(): Promise<void> {
    this.configDraft.clear();
    this.configDirty = false;
    await this.rebuildDetails();
  }

  private current(): ExternalProject | undefined {
    return this.projects.find(p => p.name === this.selected);
  }

  // ─── Events ─────────────────────────────────────────────────────

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    if (fromId === this.registryObjId && aspect === 'projectsChanged') {
      await this.load();
      return;
    }
    if (fromId === this.brokerId && aspect === 'rulesChanged') {
      await this.loadRules();
      await this.rebuildDetails();
      return;
    }

    if (fromId === this.tabBarId && aspect === 'change') {
      if (value === 0 || value === 1) {
        this.activeTab = value;
        await this.updateTabVisibility();
      }
      return;
    }

    if (fromId === this.listWidgetId && (aspect === 'select' || aspect === 'selectionChanged')) {
      this.selected = listSelectionValue(value);
      this.selectedRuleIndex = undefined;
      await this.rebuildDetails();
      return;
    }
    if (fromId === this.grantsWidgetId && (aspect === 'select' || aspect === 'selectionChanged')) {
      const raw = listSelectionValue(value);
      this.selectedRuleIndex = raw?.startsWith('rule:') ? Number(raw.slice(5)) : undefined;
      return;
    }

    // Editing happens in the pane itself: each field reports its own change
    // into the draft, and nothing reaches the registry until Save. These are
    // input aspects, so they have to be read above the click gate below.
    const field = this.editorFieldFor(fromId);
    if (field && (aspect === 'change' || aspect === 'submit')) {
      this.configDraft.set(field, String(value ?? ''));
      this.configDirty = true;
      if (this.saveBtnId) this.send(request(this.id, this.saveBtnId, 'update', { text: 'Save changes •' }));
      if (aspect === 'submit') await this.saveConfiguration();
      return;
    }

    if (aspect !== 'click') return;

    if (fromId === this.saveBtnId) return this.saveConfiguration();
    if (fromId === this.revertBtnId) return this.revertConfiguration();
    if (fromId === this.addBtnId) return this.addProject();
    if (fromId === this.settingsBtnId) return this.editProjectSettings();
    if (fromId === this.editBtnId) return this.editCommands();
    if (fromId === this.trustBtnId) return this.toggleTrust();
    if (fromId === this.autonomyBtnId) return this.cycleAutonomy();
    if (fromId === this.removeBtnId) return this.removeProject();
    if (fromId === this.addGrantBtnId) return this.addGrant();
    if (fromId === this.editGrantBtnId) return this.editGrant();
    if (fromId === this.removeGrantBtnId) return this.removeGrant();
  }

  private async updateTabVisibility(): Promise<void> {
    const configurationVisible = this.activeTab === 0;
    const visibility: ReadonlyArray<readonly [AbjectId | undefined, boolean]> = [
      [this.detailsWidgetId, configurationVisible],
      ...this.configEditorIds.map(id => [id, configurationVisible] as const),
      [this.grantsWidgetId, !configurationVisible],
      [this.grantRowId, !configurationVisible],
    ];

    for (const [id, visible] of visibility) {
      if (!id) continue;
      try {
        await this.request(request(this.id, id, 'update', { style: { visible } }));
      } catch { /* widget may be gone */ }
    }
  }

  private async addProject(): Promise<void> {
    const reg = await this.registry();
    if (!reg) return;

    const root = await this.prompt({
      title: 'Add External Project',
      message: 'Absolute path to the project directory',
      placeholder: '/home/you/projects/thing',
    });
    if (!root) return;

    const suggested = root.replace(/\/+$/, '').split('/').pop() ?? 'project';
    const name = await this.prompt({
      title: 'Project Name',
      message: 'Short handle used to refer to this project',
      defaultValue: suggested,
    });
    if (!name) return;

    const description = await this.prompt({
      title: 'Description',
      message: 'What is this project? (optional)',
      placeholder: 'A book, a service, research notes…',
    }) ?? '';

    // A project is not assumed to be code, so the commands are asked for
    // rather than guessed, and skipping them is a valid answer.
    const checkCommand = await this.prompt({
      title: 'Check Command (optional)',
      message: 'Fast check, run after every edit. Leave blank if there is nothing to run.',
      placeholder: 'pnpm tsc --noEmit',
    }) ?? '';

    const verifyCommand = await this.prompt({
      title: 'Verify Command (optional)',
      message: 'Authoritative check, run before work is reported done.',
      placeholder: 'pnpm test',
    }) ?? '';

    const isGit = await this.confirm({
      title: 'Version Control',
      message: `Is ${name} a git checkout? Checkpoints and worktree isolation need git.`,
      confirmLabel: 'Yes, git',
      cancelLabel: 'No',
    });

    try {
      await this.request(request(this.id, reg, 'addProject', {
        name, root, description,
        checkCommand: checkCommand || undefined,
        verifyCommand: verifyCommand || undefined,
        vcs: isGit ? 'git' : 'none',
        // The user chose this directory deliberately, which is exactly what
        // trust means; an agent-added project is the case that starts untrusted.
        trusted: true,
      }));
      await this.notify(`Added external project "${name}"`, 'success');
    } catch (err) {
      await this.notify(`Could not add project: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    await this.load();
  }

  private async editProjectSettings(): Promise<void> {
    const reg = await this.registry();
    const project = this.current();
    if (!reg || !project) return void await this.notify('Select a project first', 'warning');
    const description = await this.prompt({ title: `Settings — ${project.name}`, message: 'Project description', defaultValue: project.description ?? '' });
    if (description === null) return;
    const formatCommand = await this.prompt({ title: `Format Command — ${project.name}`, message: 'Optional formatting command', defaultValue: project.formatCommand ?? '' });
    if (formatCommand === null) return;
    const setupCommand = await this.prompt({ title: `Setup Command — ${project.name}`, message: 'Optional setup command', defaultValue: project.setupCommand ?? '' });
    if (setupCommand === null) return;
    const shared = await this.prompt({ title: `Shared Paths — ${project.name}`, message: 'Comma-separated paths that isolation may share', defaultValue: (project.sharedPaths ?? []).join(', ') });
    if (shared === null) return;
    const protectedValue = await this.prompt({ title: `Protected Paths — ${project.name}`, message: 'Comma-separated paths that always require confirmation before writes', defaultValue: (project.protectedPaths ?? []).join(', ') });
    if (protectedValue === null) return;
    const protectedPaths = protectedValue.split(',').map(v => v.trim()).filter(Boolean);
    if ((project.protectedPaths ?? []).length > 0 && protectedPaths.length < (project.protectedPaths ?? []).length) {
      const ok = await this.confirm({ title: 'Reduce protected paths?', message: 'Removing protected paths permits more writes without an explicit prompt. Continue?', confirmLabel: 'Save changes', destructive: true });
      if (!ok) return;
    }
    try {
      await this.request(request(this.id, reg, 'updateProject', { name: project.name, changes: {
        description,
        formatCommand: formatCommand || undefined,
        setupCommand: setupCommand || undefined,
        sharedPaths: shared.split(',').map(v => v.trim()).filter(Boolean),
        protectedPaths,
      }}));
    } catch (err) {
      await this.notify(`Could not update settings: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    await this.load();
  }

  private async collectRule(existing?: ManagedRule): Promise<Rule | undefined> {
    const project = this.current();
    if (!project) return undefined;
    const caller = await this.prompt({ title: 'Grant caller', message: 'Object name this rule applies to', defaultValue: existing?.caller ?? 'ExternalCreator' });
    if (!caller) return undefined;
    const kind = await this.prompt({ title: 'Grant type', message: 'Enter program, class, or exact', defaultValue: existing?.kind ?? 'program' });
    if (!kind || !['program', 'class', 'exact'].includes(kind)) {
      await this.notify('Grant type must be program, class, or exact', 'warning');
      return undefined;
    }
    const previousSubject = existing?.kind === 'program' ? existing.program : existing?.kind === 'class' ? existing.effect : existing?.kind === 'exact' ? existing.command : '';
    const subject = await this.prompt({ title: 'Grant subject', message: kind === 'class' ? 'read, write, exec, network, or dangerous' : kind === 'program' ? 'Program name, for example grep' : 'Exact command', defaultValue: previousSubject });
    if (!subject) return undefined;
    const allow = await this.confirm({ title: 'Rule decision', message: `Should this rule allow ${subject}? Choose Deny to create a blocking rule.`, confirmLabel: 'Allow', cancelLabel: 'Deny' });
    if (kind === 'exact') return { kind: 'exact', caller, command: subject, allow };
    const oldScope = existing && existing.kind !== 'exact' ? existing.scope : undefined;
    const defaultScope = oldScope?.kind === 'project' ? 'project' : oldScope?.kind === 'path' ? 'path' : oldScope?.kind === 'anywhere' ? 'anywhere' : 'project';
    const scopeKind = await this.prompt({ title: 'Grant scope', message: 'Enter project, path, or anywhere. Project is the narrowest and safest.', defaultValue: defaultScope });
    if (!scopeKind || !['project', 'path', 'anywhere'].includes(scopeKind)) return undefined;
    let scope: RuleScope = { kind: 'project', name: project.name };
    if (scopeKind === 'anywhere') scope = { kind: 'anywhere' };
    if (scopeKind === 'path') {
      const root = await this.prompt({ title: 'Path scope', message: 'Absolute path this grant covers', defaultValue: oldScope?.kind === 'path' ? oldScope.root : project.root });
      if (!root) return undefined;
      scope = { kind: 'path', root };
    }
    if (kind === 'class') {
      if (!['read', 'write', 'exec', 'network', 'dangerous'].includes(subject)) {
        await this.notify('Unknown effect class', 'warning');
        return undefined;
      }
      return { kind: 'class', caller, effect: subject as 'read' | 'write' | 'exec' | 'network' | 'dangerous', scope, allow };
    }
    return { kind: 'program', caller, program: subject, scope, allow };
  }

  private async addGrant(): Promise<void> {
    if (!this.brokerId || !this.current()) return void await this.notify('Select a project first', 'warning');
    const rule = await this.collectRule();
    if (!rule) return;
    // The broker owns the final approval, including calls that bypass this UI.
    const result = await this.request<{ success: boolean; error?: string }>(request(this.id, this.brokerId, 'addRule', { rule }), 31 * 60 * 1000);
    if (!result.success) await this.notify(result.error ?? 'Could not add grant', 'error');
    await this.loadRules();
    await this.rebuildDetails();
  }

  private async editGrant(): Promise<void> {
    if (!this.brokerId || this.selectedRuleIndex === undefined) return void await this.notify('Select a grant first', 'warning');
    const existing = this.permissionRules.find(rule => rule.index === this.selectedRuleIndex);
    if (!existing) return void await this.notify('That grant no longer exists', 'warning');
    const rule = await this.collectRule(existing);
    if (!rule) return;
    const result = await this.request<{ success: boolean; error?: string }>(request(this.id, this.brokerId, 'updateRule', { index: existing.index, rule }), 31 * 60 * 1000);
    if (!result.success) await this.notify(result.error ?? 'Could not edit grant', 'error');
    this.selectedRuleIndex = undefined;
    await this.loadRules();
    await this.rebuildDetails();
  }

  private async removeGrant(): Promise<void> {
    if (!this.brokerId || this.selectedRuleIndex === undefined) return void await this.notify('Select a grant first', 'warning');
    const existing = this.permissionRules.find(rule => rule.index === this.selectedRuleIndex);
    if (!existing) return;
    const result = await this.request<{ success: boolean; error?: string }>(request(this.id, this.brokerId, 'removeRule', { index: existing.index }), 31 * 60 * 1000);
    if (!result.success) await this.notify(result.error ?? 'Could not remove grant', 'error');
    this.selectedRuleIndex = undefined;
    await this.loadRules();
    await this.rebuildDetails();
  }

  private async editCommands(): Promise<void> {
    const reg = await this.registry();
    const project = this.current();
    if (!reg || !project) {
      await this.notify('Select a project first', 'warning');
      return;
    }

    const checkCommand = await this.prompt({
      title: `Check Command — ${project.name}`,
      message: 'Fast check, run after every edit. Blank means nothing runs.',
      defaultValue: project.checkCommand ?? '',
    });
    if (checkCommand === null) return;

    const verifyCommand = await this.prompt({
      title: `Verify Command — ${project.name}`,
      message: 'Authoritative check, run before work is reported done.',
      defaultValue: project.verifyCommand ?? '',
    });
    if (verifyCommand === null) return;

    try {
      await this.request(request(this.id, reg, 'updateProject', {
        name: project.name,
        changes: {
          checkCommand: checkCommand || undefined,
          verifyCommand: verifyCommand || undefined,
        },
      }));
    } catch (err) {
      await this.notify(`Could not update: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    await this.load();
  }

  private async toggleTrust(): Promise<void> {
    const reg = await this.registry();
    const project = this.current();
    if (!reg || !project) {
      await this.notify('Select a project first', 'warning');
      return;
    }

    if (!project.trusted) {
      const ok = await this.confirm({
        title: `Trust ${project.name}?`,
        message:
          `Trusting this project lets its own CLAUDE.md / AGENTS.md be added to an agent's ` +
          `instructions, and its declared commands be run. Those files are written by whoever ` +
          `wrote the project. Only trust a directory whose contents you know.`,
        confirmLabel: 'Trust it',
      });
      if (!ok) return;
    }

    try {
      await this.request(request(this.id, reg, 'setTrusted', {
        name: project.name,
        trusted: !project.trusted,
      }));
    } catch (err) {
      await this.notify(`Could not change trust: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    await this.load();
  }

  /**
   * Step a project through ask → read → edit → full → ask.
   *
   * A four-state control as a cycling button rather than a dropdown: the
   * widget set has confirm and prompt dialogs but no option picker, and every
   * step that grants more asks for confirmation anyway, which is where the
   * explanation belongs.
   */
  private async cycleAutonomy(): Promise<void> {
    const reg = await this.registry();
    const project = this.current();
    if (!reg || !project) {
      await this.notify('Select a project first', 'warning');
      return;
    }
    if (!project.trusted) {
      await this.notify(`Trust ${project.name} first — an untrusted project always asks`, 'warning');
      return;
    }

    const next = AUTONOMY_LEVELS[(AUTONOMY_LEVELS.indexOf(project.autonomy) + 1) % AUTONOMY_LEVELS.length];

    const explain: Record<AutonomyLevel, string> = {
      ask: 'Every command in this project will prompt you, as it does today.',
      read: 'Read-only commands whose files all sit inside this project will run without asking. '
        + 'Anything that writes, reaches the network, or touches a path outside the project still prompts.',
      edit: 'Read-only commands and file edits inside this project will run without asking. '
        + 'Network access, unknown programs, and anything outside the project still prompt. '
        + 'Protected paths are never written without asking.',
      full: 'Nearly everything inside this project will run without asking, including builds and package '
        + 'installs. Commands that leave the project, and the never-automatic set (sudo, rm -rf of a root, '
        + 'credential files, piping a download into a shell), still prompt. '
        + 'Consider pairing this with worktree isolation so changes land in a scratch checkout.',
    };

    if (next !== 'ask') {
      const ok = await this.confirm({
        title: `Set ${project.name} to "${next}"?`,
        message: `${explain[next]}\n\n`
          + `This is capped by the workspace: a private workspace allows at most "edit", `
          + `and a public workspace holds every project at "ask", because anything exposed there `
          + `can be reached by other peers.`,
        confirmLabel: `Set ${next}`,
        destructive: next === 'full',
      });
      if (!ok) return;
    }

    try {
      const r = await this.request<{ success: boolean; error?: string }>(
        request(this.id, reg, 'setAutonomy', { name: project.name, autonomy: next }));
      if (!r?.success) {
        await this.notify(r?.error ?? 'Could not change autonomy', 'error');
        return;
      }
      const eff = this.effective.get(project.name);
      await this.notify(
        eff && eff.cappedBy && eff.effective !== next
          ? `${project.name} asks for ${next}, capped to ${eff.effective} by ${eff.cappedBy}`
          : `${project.name} is now ${next}`,
        'info');
    } catch (err) {
      await this.notify(`Could not change autonomy: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    await this.load();
  }

  private async removeProject(): Promise<void> {
    const reg = await this.registry();
    const project = this.current();
    if (!reg || !project) {
      await this.notify('Select a project first', 'warning');
      return;
    }

    const ok = await this.confirm({
      title: `Remove ${project.name}?`,
      message: `This forgets the project. Nothing on disk at ${project.root} is touched.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;

    try {
      await this.request(request(this.id, reg, 'removeProject', { name: project.name }));
      this.selected = undefined;
    } catch (err) {
      await this.notify(`Could not remove: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    await this.load();
  }
}

export const EXTERNAL_PROJECT_BROWSER_ID = 'abjects:external-project-browser' as AbjectId;
