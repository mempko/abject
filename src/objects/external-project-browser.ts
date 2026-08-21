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
import type { ListItem } from './widgets/list-widget.js';

const log = new Log('ExternalProjectBrowser');

const BROWSER_INTERFACE: InterfaceId = 'abjects:external-project-browser';

const WIN_W = 640;
const WIN_H = 420;
const BUTTON_ROW_H = 36;

export class ExternalProjectBrowser extends Abject {
  private registryObjId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private addBtnId?: AbjectId;
  private editBtnId?: AbjectId;
  private trustBtnId?: AbjectId;
  private autonomyBtnId?: AbjectId;
  private removeBtnId?: AbjectId;

  private projects: ExternalProject[] = [];
  /** Level actually in force per project, and what capped it. */
  private effective = new Map<string, { effective: AutonomyLevel; cappedBy: string }>();
  private brokerId?: AbjectId;
  private selected?: string;

  constructor() {
    super({
      manifest: {
        name: 'ExternalProjectBrowser',
        description:
          'Browse and manage external projects: the named directories on disk that ExternalCreator ' +
          'works in. Add a project, set the commands that check and verify it, mark it trusted, ' +
          'or remove it from the list. Nothing here deletes anything on disk.',
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

    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], searchable: true }],
      }),
    );
    this.listWidgetId = listId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
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
          { type: 'button', windowId: this.windowId, text: 'Add…' },
          { type: 'button', windowId: this.windowId, text: 'Commands…' },
          { type: 'button', windowId: this.windowId, text: 'Trust' },
          { type: 'button', windowId: this.windowId, text: 'Autonomy…' },
          { type: 'button', windowId: this.windowId, text: 'Remove' },
        ],
      }),
    );
    [this.addBtnId, this.editBtnId, this.trustBtnId, this.autonomyBtnId, this.removeBtnId] = widgetIds;

    await this.request(request(this.id, buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.addBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 80, height: BUTTON_ROW_H } },
        { widgetId: this.editBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: BUTTON_ROW_H } },
        { widgetId: this.trustBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 90, height: BUTTON_ROW_H } },
        { widgetId: this.autonomyBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: BUTTON_ROW_H } },
      ],
    }));
    await this.request(request(this.id, buttonRowId, 'addLayoutSpacer', {}));
    await this.request(request(this.id, buttonRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.removeBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 90, height: BUTTON_ROW_H } },
      ],
    }));

    for (const id of widgetIds) this.send(request(this.id, id, 'addDependent', {}));
    if (this.listWidgetId) this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
    if (this.registryObjId) this.send(request(this.id, this.registryObjId, 'addDependent', {}));

    await this.load();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    if (this.registryObjId) this.send(request(this.id, this.registryObjId, 'removeDependent', {}));

    await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId: this.windowId }));

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.listWidgetId = undefined;
    this.addBtnId = undefined;
    this.editBtnId = undefined;
    this.trustBtnId = undefined;
    this.autonomyBtnId = undefined;
    this.removeBtnId = undefined;
    this.projects = [];
    this.selected = undefined;
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
    await this.refreshEffective();
    await this.rebuildList();
  }

  private formatItem(p: ExternalProject): ListItem {
    const commands = [p.checkCommand, p.verifyCommand].filter(Boolean).length;
    const secondary = p.root;
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

  private async rebuildList(): Promise<void> {
    if (!this.listWidgetId) return;
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', {
        items: this.projects.map(p => this.formatItem(p)),
      }));
    } catch { /* widget may be gone */ }
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

    if (fromId === this.listWidgetId && (aspect === 'select' || aspect === 'selectionChanged')) {
      const v = value as { value?: string } | string | undefined;
      this.selected = typeof v === 'string' ? v : v?.value;
      return;
    }

    if (aspect !== 'click') return;

    if (fromId === this.addBtnId) return this.addProject();
    if (fromId === this.editBtnId) return this.editCommands();
    if (fromId === this.trustBtnId) return this.toggleTrust();
    if (fromId === this.autonomyBtnId) return this.cycleAutonomy();
    if (fromId === this.removeBtnId) return this.removeProject();
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
