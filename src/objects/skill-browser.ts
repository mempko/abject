/**
 * SkillBrowser -- UI for managing installed skills.
 *
 * Two-pane layout: skill list (left) + detail (right scrollable).
 * Follows the ObjectBrowser widget pattern.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { SkillInfo, SkillConfig } from '../core/skill-types.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SkillBrowser');

const SKILL_BROWSER_INTERFACE: InterfaceId = 'abjects:skill-browser';

const WIN_W = 660;
const WIN_H = 400;

export class SkillBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private skillRegistryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private splitPaneId?: AbjectId;

  // Left pane
  private leftPaneId?: AbjectId;
  private listWidgetId?: AbjectId;
  private scanButtonId?: AbjectId;

  // Right pane (scrollable detail)
  private detailPaneId?: AbjectId;
  private detailLabelIds: AbjectId[] = [];
  private detailButtonIds = new Map<AbjectId, string>();
  /** Config text inputs for declared env vars: widgetId -> env var name. */
  private configInputIds = new Map<AbjectId, string>();
  /** Custom env var rows: [nameInputId, valueInputId] pairs. */
  private customEnvRows: Array<{ nameId: AbjectId; valueId: AbjectId }> = [];
  private addVarBtnId?: AbjectId;
  private saveConfigBtnId?: AbjectId;

  // State
  private allSkills: SkillInfo[] = [];
  private selectedIndex = -1;

  constructor() {
    super({
      manifest: {
        name: 'SkillBrowser',
        description:
          'Browse, enable, disable, and manage installed skills. ' +
          'Skills are SKILL.md files (compatible with Claude Code and OpenClaw).',
        version: '1.0.0',
        interface: {
          id: SKILL_BROWSER_INTERFACE,
          name: 'SkillBrowser',
          description: 'Skill management UI',
          methods: [
            {
              name: 'show',
              description: 'Show the skill browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the skill browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display skill browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'skill'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.skillRegistryId = await this.discoverDep('SkillRegistry') ?? undefined;

    if (this.skillRegistryId) {
      this.send(request(this.id, this.skillRegistryId, 'addDependent', {}));
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## SkillBrowser Usage Guide

SkillBrowser provides a two-pane UI for browsing and managing installed skills.
The left pane lists all skills with their enable/disable state, and the right
pane shows details, configuration, and actions for the selected skill.

### Show / hide the skill browser window

  await call(await dep('SkillBrowser'), 'show', {});
  await call(await dep('SkillBrowser'), 'hide', {});

### User interactions (handled internally)

- Click a skill in the list to view its details (name, source, version, description, status).
- Click "Enable" / "Disable" to toggle the skill.
- Click "Uninstall" to remove a skill from disk.
- Click "Scan Skills" to re-scan the skills directory for new SKILL.md files.
- Configure environment variables for a skill and click "Save Config".
- Click "Add Variable" to add custom environment variables.

### IMPORTANT
- The interface ID is '${SKILL_BROWSER_INTERFACE}'.
- SkillBrowser is a UI-only object; it delegates all data operations to SkillRegistry.
- Skills are SKILL.md files compatible with Claude Code and OpenClaw formats.`;
  }

  // ─── Widget helpers (follow ObjectBrowser pattern) ──────────────

  private async wm(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request(request(this.id, this.widgetManagerId!, method, payload));
  }

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  private async addToLayout(layoutId: AbjectId, widgetId: AbjectId, sizePolicy: Record<string, string>, preferredSize?: Record<string, number>): Promise<void> {
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId,
      sizePolicy,
      preferredSize,
    }));
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('show', async () => {
      await this.showWindow();
      return true;
    });

    this.on('hide', async () => {
      await this.hideWindow();
      return true;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // SkillRegistry changed
      if (fromId === this.skillRegistryId) {
        await this.refreshSkillList();
        return;
      }

      // List selection changed
      if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
        try {
          const sel = JSON.parse(value as string) as { index: number; value: string; label: string };
          this.selectedIndex = sel.index;
        } catch {
          this.selectedIndex = -1;
        }
        await this.rebuildDetailPane();
        return;
      }

      // Scan button
      if (fromId === this.scanButtonId && aspect === 'click') {
        await this.refreshSkillList();
        return;
      }

      // Add Variable button
      if (fromId === this.addVarBtnId && aspect === 'click') {
        await this.addCustomEnvRow();
        return;
      }

      // Save Config button
      if (fromId === this.saveConfigBtnId && aspect === 'click') {
        await this.saveSkillConfig();
        // Flash button text as confirmation
        await this.request(request(this.id, this.saveConfigBtnId, 'update', { text: 'Saved!' }));
        setTimeout(() => {
          if (this.saveConfigBtnId) {
            this.send(request(this.id, this.saveConfigBtnId, 'update', { text: 'Save Config' }));
          }
        }, 1500);
        return;
      }

      // Detail buttons
      const action = this.detailButtonIds.get(fromId);
      if (action && aspect === 'click' && this.skillRegistryId && this.selectedIndex >= 0) {
        const skill = this.allSkills[this.selectedIndex];
        if (action === 'enable') {
          await this.request(request(this.id, this.skillRegistryId, 'enableSkill', { name: skill.name }));
        } else if (action === 'disable') {
          await this.request(request(this.id, this.skillRegistryId, 'disableSkill', { name: skill.name }));
        } else if (action === 'uninstall') {
          await this.request(request(this.id, this.skillRegistryId, 'uninstallSkill', { name: skill.name }));
        }
        await this.refreshSkillList();
      }
    });

    this.on('windowCloseRequested', async () => {
      await this.hideWindow();
    });
  }

  // ─── Window lifecycle ───────────────────────────────────────────

  private async showWindow(): Promise<void> {
    if (!this.widgetManagerId) {
      this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    }
    if (!this.skillRegistryId) {
      this.skillRegistryId = await this.discoverDep('SkillRegistry') ?? undefined;
    }
    if (!this.widgetManagerId) return;
    if (this.windowId) return;

    this.windowId = await this.wm('createWindowAbject', {
      title: 'Skill Browser',
      rect: { x: 180, y: 100, width: WIN_W, height: WIN_H },
      resizable: true,
    }) as AbjectId;

    // Root VBox
    this.rootLayoutId = await this.wm('createVBox', {
      windowId: this.windowId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 0,
    }) as AbjectId;

    // Two-pane area: SplitPane
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        { type: 'splitPane', windowId: this.windowId, orientation: 'horizontal',
          dividerPosition: 0.30, minSize: 150 },
      ]}),
    );
    this.splitPaneId = splitId;
    await this.addToLayout(this.rootLayoutId, this.splitPaneId, { vertical: 'expanding' });

    // Left pane: detached VBox (split pane child)
    this.leftPaneId = await this.wm('createDetachedVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 0, bottom: 4, left: 4 },
      spacing: 4,
    }) as AbjectId;

    // Right pane: detached scrollable VBox (split pane child)
    this.detailPaneId = await this.wm('createDetachedScrollableVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 4,
    }) as AbjectId;

    // Wire split pane children
    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.leftPaneId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.detailPaneId }));

    // Batch create scan button + list widget
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Scan Skills' },
        { type: 'list', windowId: this.windowId, items: [] },
      ]}),
    );
    this.scanButtonId = widgetIds[0];
    this.listWidgetId = widgetIds[1];

    await this.addDep(this.scanButtonId);
    await this.addToLayout(this.leftPaneId, this.scanButtonId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 28 });
    await this.addDep(this.listWidgetId);
    await this.addToLayout(this.leftPaneId, this.listWidgetId, { vertical: 'expanding', horizontal: 'expanding' });

    await this.refreshSkillList();
  }

  private async hideWindow(): Promise<void> {
    if (!this.windowId || !this.widgetManagerId) return;
    await this.wm('destroyWindowAbject', { windowId: this.windowId });
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.splitPaneId = undefined;
    this.leftPaneId = undefined;
    this.detailPaneId = undefined;
    this.listWidgetId = undefined;
    this.scanButtonId = undefined;
    this.detailLabelIds = [];
    this.detailButtonIds.clear();
  }

  // ─── Data ───────────────────────────────────────────────────────

  private async refreshSkillList(): Promise<void> {
    if (!this.skillRegistryId) return;
    try {
      this.allSkills = await this.request<SkillInfo[]>(
        request(this.id, this.skillRegistryId, 'listSkills', {}),
      );
    } catch {
      this.allSkills = [];
    }
    if (this.selectedIndex >= this.allSkills.length) {
      this.selectedIndex = this.allSkills.length > 0 ? 0 : -1;
    }
    await this.updateListWidget();
  }

  private async updateListWidget(): Promise<void> {
    if (!this.listWidgetId) return;

    const items = this.allSkills.map(s => ({
      label: `${s.enabled ? '[on]' : '[off]'} ${s.name}`,
      value: s.name,
    }));

    // Send update directly to the list widget Abject
    await this.request(request(this.id, this.listWidgetId, 'update', {
      items,
      selectedIndex: this.selectedIndex,
    }));

    await this.rebuildDetailPane();
  }

  // ─── Detail pane (follows ObjectBrowser pane4 pattern) ──────────

  private async clearDetailPane(): Promise<void> {
    if (!this.detailPaneId) return;
    try {
      await this.request(request(this.id, this.detailPaneId, 'clearLayoutChildren', {}));
    } catch { /* gone */ }

    for (const id of this.detailLabelIds) {
      this.send(request(this.id, id, 'destroy', {}));
    }
    for (const id of this.detailButtonIds.keys()) {
      this.send(request(this.id, id, 'destroy', {}));
    }
    for (const id of this.configInputIds.keys()) {
      this.send(request(this.id, id, 'destroy', {}));
    }
    for (const row of this.customEnvRows) {
      this.send(request(this.id, row.nameId, 'destroy', {}));
      this.send(request(this.id, row.valueId, 'destroy', {}));
    }
    if (this.addVarBtnId) {
      this.send(request(this.id, this.addVarBtnId, 'destroy', {}));
    }
    if (this.saveConfigBtnId) {
      this.send(request(this.id, this.saveConfigBtnId, 'destroy', {}));
    }
    this.detailLabelIds = [];
    this.detailButtonIds.clear();
    this.configInputIds.clear();
    this.customEnvRows = [];
    this.addVarBtnId = undefined;
    this.saveConfigBtnId = undefined;
  }

  private async addDetailLabel(text: string, secondary = false, style?: Record<string, unknown>): Promise<AbjectId> {
    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        {
          type: 'label',
          windowId: this.windowId,
          text,
          style: {
            fontSize: secondary ? 12 : 13,
            wordWrap: true,
            selectable: true,
            ...style,
          },
        },
      ]}),
    );
    const lines = Math.max(1, Math.ceil(text.length / 45));
    const lineHeight = secondary ? 16 : 18;
    await this.addToLayout(this.detailPaneId!, labelId, { vertical: 'fixed' },
      { height: Math.max(lineHeight, lines * lineHeight) });
    this.detailLabelIds.push(labelId);
    return labelId;
  }

  private async addDetailButton(text: string, actionKey: string): Promise<AbjectId> {
    const { widgetIds: [btnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        {
          type: 'button',
          windowId: this.windowId,
          text,
          style: {
            background: this.theme.actionBg,
            color: this.theme.actionText,
            borderColor: this.theme.actionBorder,
          },
        },
      ]}),
    );
    await this.addDep(btnId);
    await this.addToLayout(this.detailPaneId!, btnId, { vertical: 'fixed', horizontal: 'fixed' },
      { width: 120, height: 28 });
    this.detailButtonIds.set(btnId, actionKey);
    return btnId;
  }

  private async rebuildDetailPane(): Promise<void> {
    if (!this.detailPaneId || !this.windowId) return;
    await this.clearDetailPane();

    // Empty state
    if (this.allSkills.length === 0) {
      await this.addDetailLabel('No skills installed', false, { fontSize: 14 });
      await this.addDetailLabel('');
      await this.addDetailLabel(
        'To install a skill, create a subdirectory with a SKILL.md file ' +
        'inside the skills/ folder of your data directory ' +
        '(e.g. .abjects/skills/my-skill/SKILL.md).',
        true,
      );
      await this.addDetailLabel('');
      await this.addDetailLabel('SKILL.md uses YAML frontmatter:', true);
      await this.addDetailLabel(
        '---\nname: my-skill\ndescription: What this skill does\n---\nInstructions for the agent...',
        true, { fontFamily: 'monospace', fontSize: 11 },
      );
      await this.addDetailLabel('');
      await this.addDetailLabel(
        'Compatible with Claude Code and OpenClaw SKILL.md formats. ' +
        'Click "Scan Skills" after adding files.',
        true,
      );
      return;
    }

    // No selection
    if (this.selectedIndex < 0 || this.selectedIndex >= this.allSkills.length) {
      await this.addDetailLabel('Select a skill from the list.', true);
      return;
    }

    // Show selected skill details
    const skill = this.allSkills[this.selectedIndex];

    await this.addDetailLabel(skill.name, false, { fontSize: 15, fontWeight: 'bold' });
    await this.addDetailLabel(`Source: ${skill.source}`, true);
    if (skill.version) await this.addDetailLabel(`Version: ${skill.version}`, true);
    await this.addDetailLabel(skill.description || '(no description)', true);
    if (skill.allowedTools?.length) await this.addDetailLabel(`Tools: ${skill.allowedTools.join(', ')}`, true);
    if (skill.requiredBins?.length) await this.addDetailLabel(`Requires: ${skill.requiredBins.join(', ')}`, true);
    await this.addDetailLabel(`Status: ${skill.enabled ? 'Enabled' : 'Disabled'}`, true);
    if (skill.error) await this.addDetailLabel(`Error: ${skill.error}`, true, { color: '#ff6666' });

    // ── Configuration section (always shown) ──
    await this.addDetailLabel('');
    await this.addDetailLabel('Configuration', false, { fontSize: 14, fontWeight: 'bold' });

    // Load current config from SkillRegistry
    let currentConfig: SkillConfig = { env: {} };
    if (this.skillRegistryId) {
      try {
        currentConfig = await this.request<SkillConfig>(
          request(this.id, this.skillRegistryId, 'getSkillConfig', { name: skill.name }),
        );
      } catch { /* no config yet */ }
    }

    // Collect env var names: declared + previously configured
    const envVarNames = new Set<string>(skill.requiredEnv ?? []);
    if (currentConfig.env) {
      for (const k of Object.keys(currentConfig.env)) envVarNames.add(k);
    }

    // Create label + masked text input for each known env var
    for (const envName of envVarNames) {
      await this.addDetailLabel(envName, true);
      const savedValue = currentConfig.env?.[envName] ?? '';
      const { widgetIds: [inputId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'textInput', windowId: this.windowId, placeholder: envName, text: savedValue, masked: true },
        ]}),
      );
      await this.addDep(inputId);
      await this.addToLayout(this.detailPaneId!, inputId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 28 });
      this.configInputIds.set(inputId, envName);
    }

    if (envVarNames.size === 0) {
      await this.addDetailLabel('No environment variables declared.', true, { color: this.theme.textSecondary });
    }

    // "Add Variable" button
    const { widgetIds: [addBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Add Variable' },
      ]}),
    );
    await this.addDep(addBtnId);
    await this.addToLayout(this.detailPaneId!, addBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 120, height: 28 });
    this.addVarBtnId = addBtnId;

    // Save Config button
    const { widgetIds: [saveBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save Config',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]}),
    );
    await this.addDep(saveBtnId);
    await this.addToLayout(this.detailPaneId!, saveBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 120, height: 28 });
    this.saveConfigBtnId = saveBtnId;

    await this.addDetailLabel('');
    const toggleLabel = skill.enabled ? 'Disable' : 'Enable';
    await this.addDetailButton(toggleLabel, skill.enabled ? 'disable' : 'enable');
    await this.addDetailButton('Uninstall', 'uninstall');
  }

  /** Add a new custom env var row (name input + value input). */
  private async addCustomEnvRow(): Promise<void> {
    if (!this.detailPaneId || !this.widgetManagerId || !this.windowId) return;

    const { widgetIds: [nameId, valueId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'VARIABLE_NAME' },
        { type: 'textInput', windowId: this.windowId, placeholder: 'value', masked: true },
      ]}),
    );
    await this.addDep(nameId);
    await this.addDep(valueId);

    // Insert before the Add Variable button by adding to the layout
    // (scrollable vbox appends at the end, but that's fine -- user sees them above buttons after rebuild)
    await this.addToLayout(this.detailPaneId, nameId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 28 });
    await this.addToLayout(this.detailPaneId, valueId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 28 });

    this.customEnvRows.push({ nameId, valueId });
  }

  /** Read all config input values (declared + custom) and save to SkillRegistry. */
  private async saveSkillConfig(): Promise<void> {
    if (!this.skillRegistryId || this.selectedIndex < 0) return;
    const skill = this.allSkills[this.selectedIndex];
    if (!skill) return;

    const env: Record<string, string> = {};

    // Collect declared env var inputs (send getValue directly to widget Abject)
    for (const [inputId, envName] of this.configInputIds) {
      try {
        const val = await this.request<string>(
          request(this.id, inputId, 'getValue', {}),
        );
        if (val) env[envName] = val;
      } catch { /* skip */ }
    }

    // Collect custom env var inputs
    for (const row of this.customEnvRows) {
      try {
        const name = await this.request<string>(
          request(this.id, row.nameId, 'getValue', {}),
        );
        const value = await this.request<string>(
          request(this.id, row.valueId, 'getValue', {}),
        );
        if (name && value) env[name] = value;
      } catch { /* skip */ }
    }

    await this.request(
      request(this.id, this.skillRegistryId, 'setSkillConfig', { name: skill.name, env }),
    );
  }
}

export const SKILL_BROWSER_ID = 'abjects:skill-browser' as AbjectId;
