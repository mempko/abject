/**
 * GlobalSettings: the Settings window.
 *
 * A view over SettingsManager, which owns the global settings as data
 * (credentials and tier routing, presets, login, permissions): the window
 * loads its forms from it, saves through it, and repaints when it reports a
 * change (the terminal client edits the same settings). It also raises the
 * permission prompts PermissionBroker asks for, and shows the Skills,
 * Packages and Updates tabs over their own objects. On first boot with
 * nothing configured it opens itself.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { event, request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { require as contractRequire, ensure } from '../core/contracts.js';
import { undoMethods, type UndoAction, type UndoResult, type UndoState } from '../core/undo.js';
import { sectionHeaderStyle, sectionHeaderText, hintStyle, emptyStateMarkdown, emptyStateStyle, livingStyle } from './ui-kit.js';
import { TITLE_BAR_HEIGHT } from './widgets/widget-types.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';
import type { PackageView, PackageDirView, PackageProblem } from './packages.js';
import type { PackageSettingSpec } from '../sandbox/extensions.js';
import { parsePrivateHost } from './capabilities/address-policy.js';
import type { UpdateStatus } from './app-updater.js';
import type { SettingsBySection, SettingsSectionId } from './settings-manager.js';
import { AiSettingsPane, settingsError, type AiPaneHost } from './ai-settings-pane.js';

const log = new Log('GlobalSettings');

/** A permission prompt closed by its window's close button: the person declined. */
const DECLINED = '\u0000declined';
/** A permission prompt taken down because a terminal answered it first. */
const DISMISSED = '\u0000dismissed';

/**
 * The settings window's tabs, in tab-bar order. Updates shows only in the
 * packaged desktop app, where AppUpdater exists (see visibleTabs).
 */
const SETTINGS_TABS = ['ai', 'auth', 'permissions', 'skills', 'packages', 'updates'] as const;
type SettingsTab = typeof SETTINGS_TABS[number];
const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  ai: 'AI', auth: 'Auth', permissions: 'Permissions', skills: 'Skills & MCP', packages: 'Packages', updates: 'Updates',
};

/** How each install gets a new version, as the Updates tab says it. */
const UPDATE_INSTALL_NOTE: Record<UpdateStatus['installKind'], string> = {
  nsis: 'New versions install when Abject restarts or quits.',
  appimage: 'New versions replace this AppImage as soon as they download, and start the next time Abject does.',
  deb: 'New versions install when you restart Abject, which asks for your password.',
  manual: 'New versions are downloaded by hand.',
};

/** Content width of a settings card, for sizing word-wrapped labels. */
const SETTINGS_CARD_TEXT_WIDTH = 440;

/** PermissionBroker's prompt modes, in the order the Permissions tab lists them. */
const PROMPT_MODE_OPTIONS: ReadonlyArray<'ask' | 'allow' | 'deny'> = ['ask', 'allow', 'deny'];

/** Where a package directory comes from, as the Packages tab says it. */
const PACKAGE_DIR_ORIGINS: Record<PackageDirView['origin'], string> = {
  bundled: 'bundled with Abject',
  installed: 'installed with pnpm forge',
  environment: 'from ABJECTS_PACKAGE_DIRS',
  configured: 'added here',
};

/** A package's state in a few words, for its row in the package list. */
function packageStatusWord(p: PackageView): string {
  let word: string;
  if (p.status === 'shadowed') word = `replaced by ${p.shadowedBy?.version ?? 'a newer copy'}`;
  else if (p.status === 'disabled') word = p.loaded ? 'stops after restart' : 'disabled';
  else word = p.loaded ? 'running' : 'starts after restart';
  return p.missingRequired.length > 0 && p.status === 'enabled' ? `${word} · needs settings` : word;
}

/** A package's state as a sentence, for the selected-package card. */
function packageStatusSentence(p: PackageView): string {
  const parts: string[] = [];
  if (p.status === 'shadowed') {
    parts.push(`Not loaded: version ${p.shadowedBy?.version} in ${p.shadowedBy?.dir} takes its place.`);
  } else if (p.status === 'disabled') {
    parts.push(p.loaded ? 'Disabled. It keeps running until Abject restarts.' : 'Disabled. It does not load.');
  } else {
    parts.push(p.loaded ? 'Running.' : 'Enabled. It loads the next time Abject starts.');
  }
  if (p.restartRequired && p.status !== 'disabled' && p.loaded) parts.push('Restart Abject to load the version on disk.');
  if (p.missingRequired.length > 0) {
    const labels = p.settings.filter(s => p.missingRequired.includes(s.key)).map(s => s.label);
    parts.push(`Required settings missing: ${labels.join(', ')}.`);
  }
  return parts.join(' ');
}

/** Convert a string array to ListItem array for list widgets. */
/** "just now", "5 min ago", "3 h ago", "2 d ago". */
function timeSince(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function toListItems(
  arr: string[],
): Array<{ label: string; value: string; actions: Array<{ id: string; label: string }> }> {
  return arr.map(s => ({ label: s, value: s, actions: [{ id: 'remove', label: 'Remove' }] }));
}

/**
 * Parse a per-object shell grant written as "ObjectName: command". The command
 * is a program name, so anything with whitespace or a path separator in it is
 * rejected rather than silently stored as a grant that can never match.
 */
/** Per-object shell rules: programs the object may run, and programs it may not. */
interface ObjectCommandRules {
  allow: string[];
  deny: string[];
}

function parseObjectPermEntry(entry: string): { objectName: string; commandName: string } | undefined {
  const sep = entry.indexOf(':');
  if (sep <= 0) return undefined;
  const objectName = entry.slice(0, sep).trim();
  const commandName = entry.slice(sep + 1).trim();
  if (!objectName || !commandName) return undefined;
  if (/[\s/\\]/.test(commandName)) return undefined;
  return { objectName, commandName };
}

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

/**
 * GlobalSettings object that provides a configuration UI for LLM API keys.
 *
 * Widgets are first-class Abjects identified by AbjectId. This object registers
 * as a dependent of each widget and listens for 'changed' events to handle
 * user interactions.
 */
export class GlobalSettings extends Abject {
  private llmId?: AbjectId;
  private widgetManagerId?: AbjectId;
  /** Owns the settings this window edits. */
  private settingsManagerId?: AbjectId;
  /** The settings as last loaded from SettingsManager (secrets included: this window may read them). */
  private managed?: SettingsBySection;
  /**
   * The section this window saved last, and when: its own change comes back
   * as a settingsChanged event, which needs no repaint.
   */
  private lastOwnSave?: { section: string; at: number };
  private windowId?: AbjectId;
  /** The window being built, which a second show joins (see show). */
  private showInFlight?: Promise<boolean>;
  private rootLayoutId?: AbjectId;

  /** The AI tab: providers, presets and the model behind each tier. */
  private readonly aiPane: AiSettingsPane = new AiSettingsPane(this.aiPaneHost());

  private statusLabelId?: AbjectId;
  /** Permission list id -> its empty-state note. */
  private listEmptyNoteIds = new Map<AbjectId, AbjectId>();
  /** List -> the scrollable body holding it. A scrollable VBox gives
   *  expanding children no room, so these lists take a fixed height that
   *  collapses to nothing while the list is empty. */
  private scrollBodyListLayouts = new Map<AbjectId, AbjectId>();
  private skillBrowserBtnId?: AbjectId;
  private catalogBrowserBtnId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private activeTab: SettingsTab = 'ai';
  private aiContainerId?: AbjectId;
  private authContainerId?: AbjectId;
  private skillsContainerId?: AbjectId;

  // Updates tab (packaged desktop app only: a view over AppUpdater)
  private appUpdaterId?: AbjectId;
  private updateStatus?: UpdateStatus;
  /** The version the user was last notified about, so each is announced once. */
  private announcedUpdateVersion?: string;
  private workspaceManagerId?: AbjectId;
  private updatesContainerId?: AbjectId;
  private updStatusLabelId?: AbjectId;
  private updProgressId?: AbjectId;
  private updPrimaryBtnId?: AbjectId;
  private updCheckBtnId?: AbjectId;
  private updNotesBtnId?: AbjectId;
  private updAutoCheckboxId?: AbjectId;

  // Packages tab (a view over the Packages object)
  private packagesContainerId?: AbjectId;
  private packagesObjectId?: AbjectId;
  private pkgListCardId?: AbjectId;
  private pkgListId?: AbjectId;
  private pkgNoticeId?: AbjectId;
  private pkgDetailLayoutId?: AbjectId;
  private pkgEnabledCheckboxId?: AbjectId;
  private pkgSaveBtnId?: AbjectId;
  /** Setting input widget -> the setting it edits (for the selected package). */
  private pkgSettingInputs = new Map<AbjectId, PackageSettingSpec>();
  private pkgDirInputId?: AbjectId;
  private pkgDirAddBtnId?: AbjectId;
  private pkgDirListId?: AbjectId;
  private pkgDirRemoveBtnId?: AbjectId;
  private pkgViews: PackageView[] = [];
  private pkgProblems: PackageProblem[] = [];
  private pkgDirs: PackageDirView[] = [];
  private pkgSelected?: string;

  // Auth widgets
  private authCheckboxId?: AbjectId;
  private authUserInputId?: AbjectId;
  private authPassInputId?: AbjectId;
  private authPassToggleId?: AbjectId;
  private authSaveBtnId?: AbjectId;

  // Permissions tab
  private permissionsContainerId?: AbjectId;
  private autonomyStatusId?: AbjectId;
  private takeWheelBtnId?: AbjectId;
  private platformLabelId?: AbjectId;
  private permSubTabBarId?: AbjectId;
  private permCategoryCardIds: (AbjectId | undefined)[] = [];
  // Filesystem
  private fsReadOnlyCheckboxId?: AbjectId;
  private fsPathInputId?: AbjectId;
  private fsAddBtnId?: AbjectId;
  private fsPathListId?: AbjectId;
  private fsRemoveBtnId?: AbjectId;
  // Shell
  private shellEnabledCheckboxId?: AbjectId;
  private shellCmdInputId?: AbjectId;
  private shellAddBtnId?: AbjectId;
  private shellCmdListId?: AbjectId;
  private shellRemoveBtnId?: AbjectId;
  private shellDeniedInputId?: AbjectId;
  private shellDeniedAddBtnId?: AbjectId;
  private shellDeniedListId?: AbjectId;
  private shellDeniedRemoveBtnId?: AbjectId;
  private objectPermInputId?: AbjectId;
  private objectPermAddBtnId?: AbjectId;
  private objectPermListId?: AbjectId;
  private objectPermRemoveBtnId?: AbjectId;
  private objectDenyInputId?: AbjectId;
  private objectDenyAddBtnId?: AbjectId;
  private objectDenyListId?: AbjectId;
  private objectDenyRemoveBtnId?: AbjectId;
  // Web
  private webEnabledCheckboxId?: AbjectId;
  private webDomainInputId?: AbjectId;
  private webAddBtnId?: AbjectId;
  private webDomainListId?: AbjectId;
  private webRemoveBtnId?: AbjectId;
  private webDeniedInputId?: AbjectId;
  private webDeniedAddBtnId?: AbjectId;
  private webDeniedListId?: AbjectId;
  private webDeniedRemoveBtnId?: AbjectId;
  private webPrivateInputId?: AbjectId;
  private webPrivateAddBtnId?: AbjectId;
  private webPrivateListId?: AbjectId;
  private webPrivateRemoveBtnId?: AbjectId;
  // Permissions save
  private permsSaveBtnId?: AbjectId;
  // In-memory permissions state
  private fsAllowedPaths: string[] = [];
  private fsReadOnly = false;
  private shellEnabled = true;
  private shellAllowedCmds: string[] = [];
  private shellDeniedCmds: string[] = [];
  /**
   * Per-object shell rules: object name -> programs it may or may not run,
   * whatever the arguments. Keyed by name, so a rule survives the object being
   * respawned with a fresh AbjectId.
   */
  private objectPermissions: Map<string, ObjectCommandRules> = new Map();
  private webEnabled = true;
  private webAllowedDomains: string[] = [];
  private webDeniedDomains: string[] = [];
  /** Private and internal hosts HttpClient and StreamClient may reach
   *  (address-policy.ts). Empty: every private address is refused. */
  private webPrivateHosts: string[] = [];
  /** What a request no rule decides gets: ask, allow once, or deny (PermissionBroker's prompt mode). */
  private promptMode: 'ask' | 'allow' | 'deny' = 'ask';
  private promptModeSelectId?: AbjectId;

  private unmasked: Set<AbjectId> = new Set();

  constructor() {
    super({
      manifest: {
        name: 'GlobalSettings',
        description:
          'The Settings window: model keys and tiers, login, permissions, skills, packages and updates. The settings themselves live in SettingsManager.',
        version: '1.0.0',
        interface: {
            id: GLOBAL_SETTINGS_INTERFACE,
            name: 'GlobalSettings',
            description: 'Global system configuration',
            methods: [
              {
                name: 'show',
                description: 'Show the global settings window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the global settings window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              ...undoMethods('the last change made in this window to the AI settings or a saved preset (SettingsManager keeps the history)'),
            ],
          },
        tags: ['system', 'ui', 'settings'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GlobalSettings Usage Guide

Interface: abjects:global-settings

GlobalSettings is the Settings window: tabs for AI (model keys, tier routing, presets), Auth (a login for the UI and CLI),
Permissions (filesystem, shell, web, and what happens to a request no rule decides), Skills & MCP, Packages, and Updates in the packaged app.
The settings themselves live in SettingsManager, which this window loads from and saves through; ask SettingsManager to read them.

### Show or hide the window

  await this.call(this.dep('GlobalSettings'), 'show', {});
  await this.call(this.dep('GlobalSettings'), 'hide', {});

### Undo
undo() / redo() take back the last change made in this window to the AI settings or a saved preset
(Ctrl+Z in the window does the same). Credentials, the login and permissions are never undone.

### IMPORTANT
- Changing settings is the person's call: open the window for them, or ask them.
- On first boot with nothing configured, the window opens by itself.`;
  }

  /** What the AI tab needs from this window: its ids, its status line, and requests sent as this object. */
  private aiPaneHost(): AiPaneHost {
    const window = this;
    return {
      get widgetManagerId() { return window.widgetManagerId!; },
      get settingsManagerId() { return window.settingsManagerId!; },
      get llmId() { return window.llmId!; },
      theme: () => this.theme,
      ask: <T>(to: AbjectId, method: string, payload?: unknown, timeoutMs?: number) =>
        this.request<T>(request(this.id, to, method, payload ?? {}), timeoutMs),
      status: (text, color) => this.setStatus(text, color),
      reject: (text, color) => this.rejectWith(text, color),
      flash: () => this.windowEffect('flash'),
      ownChange: (section) => { this.lastOwnSave = { section, at: Date.now() }; },
      undo: () => this.undoSettings('undo', { fromAiTab: true }),
    };
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.llmId = await this.requireDep('LLM');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.settingsManagerId = await this.requireDep('SettingsManager');
    // Its settingsChanged events repaint an open window.
    try { await this.request(request(this.id, this.settingsManagerId, 'addDependent', {})); } catch { /* repaints on reopen */ }
    // Packaged desktop app only: AppUpdater (spawned before us) feeds the Updates tab.
    await this.connectAppUpdater();

    // First boot with nothing configured: open so the person can add a key.
    const configured = await this.request<boolean>(request(this.id, this.settingsManagerId, 'isConfigured', {}));
    if (!configured) void this.openWhenRegistered();
  }

  /**
   * Open the window once the Registry knows this object. SettingsManager
   * hands settings (keys included) to the Settings window only, and tells it
   * apart by its registration, which the Factory makes after onInit returns.
   */
  private async openWhenRegistered(): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (await this.discoverDep('GlobalSettings') === this.id) {
        await this.show();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    log.warn('Not registered after 10s; the settings window stays closed until opened');
  }

  /**
   * Load every section from SettingsManager (secrets included) into the
   * forms' working state: the window edits copies and saves them back.
   */
  private async loadFromManager(): Promise<void> {
    this.managed = await this.request<SettingsBySection>(
      request(this.id, this.settingsManagerId!, 'getSettings', { reveal: true }));
    const m = this.managed;
    this.fsAllowedPaths = [...m.filesystem.allowedPaths];
    this.fsReadOnly = m.filesystem.readOnly;
    this.shellEnabled = m.shell.enabled;
    this.shellAllowedCmds = [...m.shell.allowedCommands];
    this.shellDeniedCmds = [...m.shell.deniedCommands];
    this.objectPermissions = new Map(Object.entries(m.shell.objectRules)
      .map(([name, r]) => [name, { allow: [...r.allow], deny: [...r.deny] }]));
    this.webEnabled = m.web.enabled;
    this.webAllowedDomains = [...m.web.allowedDomains];
    this.webDeniedDomains = [...m.web.deniedDomains];
    this.webPrivateHosts = [...m.web.privateHosts];
    this.promptMode = m.permissions.mode;
  }

  /**
   * Change one section through SettingsManager. Returns the error to show,
   * or undefined when it took.
   */
  private async saveSection(section: SettingsSectionId, values: Record<string, unknown>): Promise<string | undefined> {
    this.lastOwnSave = { section, at: Date.now() };
    try {
      await this.request(request(this.id, this.settingsManagerId!, 'setSettings', { section, values }), 60_000);
      return undefined;
    } catch (err) {
      return settingsError(err);
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      // Closing an open permission prompt declines it. Every other close
      // (the settings window) hides the settings window as before.
      const { windowId } = (msg.payload ?? {}) as { windowId?: AbjectId };
      if (windowId && windowId === this._promptWindowId) {
        this._pendingPermissionPrompt?.resolve(DECLINED);
        return;
      }
      await this.hide();
    });

    this.on('getState', async () => {
      return { visible: !!this.windowId };
    });

    // Ctrl+Z in the window: SettingsManager keeps the history of this
    // window's changes; take back the newest and show what it left.
    this.on('undo', async () => this.undoSettings('undo'));
    this.on('redo', async () => this.undoSettings('redo'));
    this.on('getUndoState', async (): Promise<UndoState> => {
      try {
        return await this.request<UndoState>(request(this.id, this.settingsManagerId!, 'getUndoState', {}), 5000);
      } catch {
        return { canUndo: false, canRedo: false };
      }
    });

    // DialogBroker hands this window the permission questions to draw, one at
    // a time (the options kind). PermissionBroker decides what needs asking
    // and builds the grouped answers; DialogBroker owns the question and who
    // may answer it; this object only draws it and reports the click.
    this.on('presentDialog', async (m: AbjectMessage) => {
      if (!(await this.fromDialogBroker(m))) return;
      const d = m.payload as {
        dialogId: string; title: string; message: string; summary?: string; resource?: string; detail?: string[];
        groups?: Array<{ label: string; options: Array<{ id: string; label: string; tone?: string }> }>;
      };
      contractRequire(typeof d?.dialogId === 'string' && d.dialogId.length > 0, 'presentDialog needs a dialogId');
      void this.presentPermission({
        dialogId: d.dialogId,
        title: d.title || 'Permission',
        description: d.message || '',
        summary: d.summary || '',
        resource: d.resource || '',
        detail: d.detail ?? [],
        groups: d.groups ?? [],
      });
    });

    // A terminal answered first: take the prompt down without reporting.
    this.on('dismissDialog', async (m: AbjectMessage) => {
      if (!(await this.fromDialogBroker(m))) return;
      const { dialogId } = m.payload as { dialogId?: string };
      if (dialogId && dialogId === this._promptDialogId) this._pendingPermissionPrompt?.resolve(DISMISSED);
    });

    // Handle 'changed' events from widget dependents
    this.on('changed', async (m: AbjectMessage) => {
      const { aspect, value } = m.payload as { aspect: string; value?: unknown };
      const fromId = m.routing.from;

      // Permission prompt buttons
      if (this._pendingPermissionPrompt && aspect === 'click') {
        const decision = this._promptButtons.get(fromId);
        if (decision) { this._pendingPermissionPrompt.resolve(decision); return; }
      }

      // A wrapped block of the prompt measured itself; grow the window to fit.
      if (aspect === 'contentHeight'
          && (fromId === this._promptResourceBlockId || fromId === this._promptSummaryBlockId)) {
        const height = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(height) && height > 0) await this.resizePromptBlock(fromId, height);
        return;
      }

      // Settings changed through another surface (the terminal client):
      // repaint the forms that show them.
      if (fromId === this.settingsManagerId && aspect === 'settingsChanged') {
        await this.onSettingsChanged((value as { section?: string } | undefined)?.section);
        return;
      }

      // AppUpdater changes and Updates tab widgets
      if (await this.handleUpdatesEvent(fromId, aspect, value)) return;

      // Tab bar changed
      if (fromId === this.tabBarId && aspect === 'change') {
        this.activeTab = this.visibleTabs()[value as number] ?? 'ai';
        await this.switchTab();
        if (this.activeTab === 'packages') await this.refreshPackages();
        if (this.activeTab === 'updates') await this.refreshUpdatesTab();
        return;
      }

      // Packages tab widgets
      if (await this.handlePackagesEvent(fromId, aspect, value)) return;

      if (fromId === this.permSubTabBarId && aspect === 'change') {
        await this.switchPermCategory(value as number);
        return;
      }

      if (fromId === this.takeWheelBtnId && aspect === 'click') {
        await this.takeTheWheel();
        return;
      }

      // AI tab widgets: every control there belongs to the pane
      if (await this.aiPane.handleEvent(fromId, aspect, value)) return;

      // Auth checkbox toggled
      if (fromId === this.authCheckboxId && aspect === 'change') {
        await this.setAuthFieldsDisabled(!(value as boolean));
        return;
      }

      if (fromId === this.authPassToggleId && aspect === 'click') {
        await this.toggleMask(this.authPassInputId!, this.authPassToggleId!);
        return;
      }

      if (fromId === this.authSaveBtnId && aspect === 'click') {
        await this.saveAuthSettings();
        return;
      }

      // Open Skill Browser
      if (fromId === this.skillBrowserBtnId && aspect === 'click') {
        const skillBrowserId = await this.discoverDep('SkillBrowser');
        if (skillBrowserId) {
          await this.request(request(this.id, skillBrowserId, 'show', {}));
        }
        return;
      }

      // Open Catalog (MCP registry + skill marketplaces)
      if (fromId === this.catalogBrowserBtnId && aspect === 'click') {
        const catalogBrowserId = await this.discoverDep('CatalogBrowser');
        if (catalogBrowserId) {
          await this.request(request(this.id, catalogBrowserId, 'show', {}));
        }
        return;
      }

      // ── Permissions tab handlers ──

      // Inline Remove action on any permission list row
      if (aspect === 'action') {
        const lists: Array<{ id?: AbjectId; get: () => string[]; set: (v: string[]) => void }> = [
          { id: this.fsPathListId, get: () => this.fsAllowedPaths, set: v => { this.fsAllowedPaths = v; } },
          { id: this.shellCmdListId, get: () => this.shellAllowedCmds, set: v => { this.shellAllowedCmds = v; } },
          { id: this.shellDeniedListId, get: () => this.shellDeniedCmds, set: v => { this.shellDeniedCmds = v; } },
          { id: this.webDomainListId, get: () => this.webAllowedDomains, set: v => { this.webAllowedDomains = v; } },
          { id: this.webDeniedListId, get: () => this.webDeniedDomains, set: v => { this.webDeniedDomains = v; } },
          { id: this.webPrivateListId, get: () => this.webPrivateHosts, set: v => { this.webPrivateHosts = v; } },
        ];
        const target = lists.find(l => l.id && l.id === fromId);
        if (target) {
          try {
            const data = JSON.parse(value as string) as { value: string; actionId: string };
            if (data.actionId === 'remove') {
              target.set(target.get().filter(x => x !== data.value));
              await this.updateStringList(target.id!, target.get());
            }
          } catch { /* malformed payload */ }
        }
        return;
      }

      // Filesystem: add path
      if (fromId === this.fsAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.fsPathInputId!, 'getValue', {}));
        const added = !!val && !this.fsAllowedPaths.includes(val);
        if (added) {
          this.fsAllowedPaths.push(val);
          await this.updateStringList(this.fsPathListId!, this.fsAllowedPaths);
          await this.request(request(this.id, this.fsPathInputId!, 'update', { text: '' }));
        }
        await this.listAddFeedback(val, added);
        return;
      }
      if (fromId === this.fsRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.fsPathListId!, 'getValue', {}));
        if (sel) {
          this.fsAllowedPaths = this.fsAllowedPaths.filter(p => p !== sel);
          await this.updateStringList(this.fsPathListId!, this.fsAllowedPaths);
        }
        return;
      }
      if (fromId === this.fsReadOnlyCheckboxId && aspect === 'change') {
        this.fsReadOnly = value as boolean;
        return;
      }

      // Shell: enabled checkbox
      if (fromId === this.shellEnabledCheckboxId && aspect === 'change') {
        this.shellEnabled = value as boolean;
        return;
      }
      // Shell: add allowed command
      if (fromId === this.shellAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.shellCmdInputId!, 'getValue', {}));
        const added = !!val && !this.shellAllowedCmds.includes(val);
        if (added) {
          this.shellAllowedCmds.push(val);
          await this.updateStringList(this.shellCmdListId!, this.shellAllowedCmds);
          await this.request(request(this.id, this.shellCmdInputId!, 'update', { text: '' }));
        }
        await this.listAddFeedback(val, added);
        return;
      }
      if (fromId === this.shellRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.shellCmdListId!, 'getValue', {}));
        if (sel) {
          this.shellAllowedCmds = this.shellAllowedCmds.filter(c => c !== sel);
          await this.updateStringList(this.shellCmdListId!, this.shellAllowedCmds);
        }
        return;
      }
      // Shell: add denied command
      if (fromId === this.shellDeniedAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.shellDeniedInputId!, 'getValue', {}));
        const added = !!val && !this.shellDeniedCmds.includes(val);
        if (added) {
          this.shellDeniedCmds.push(val);
          await this.updateStringList(this.shellDeniedListId!, this.shellDeniedCmds);
          await this.request(request(this.id, this.shellDeniedInputId!, 'update', { text: '' }));
        }
        await this.listAddFeedback(val, added);
        return;
      }
      if (fromId === this.shellDeniedRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.shellDeniedListId!, 'getValue', {}));
        if (sel) {
          this.shellDeniedCmds = this.shellDeniedCmds.filter(c => c !== sel);
          await this.updateStringList(this.shellDeniedListId!, this.shellDeniedCmds);
        }
        return;
      }
      // Shell: per-object rules, entered as "ObjectName: command"
      if (fromId === this.objectPermAddBtnId && aspect === 'click') {
        await this.addObjectPermEntry('allow', this.objectPermInputId!, this.objectPermListId!);
        return;
      }
      if (fromId === this.objectDenyAddBtnId && aspect === 'click') {
        await this.addObjectPermEntry('deny', this.objectDenyInputId!, this.objectDenyListId!);
        return;
      }
      if (fromId === this.objectPermRemoveBtnId && aspect === 'click') {
        await this.removeObjectPermEntry('allow', this.objectPermListId!);
        return;
      }
      if (fromId === this.objectDenyRemoveBtnId && aspect === 'click') {
        await this.removeObjectPermEntry('deny', this.objectDenyListId!);
        return;
      }

      // Web: enabled checkbox
      if (fromId === this.webEnabledCheckboxId && aspect === 'change') {
        this.webEnabled = value as boolean;
        return;
      }
      // Permission prompt mode select: takes effect at once.
      if (fromId === this.promptModeSelectId && aspect === 'change') {
        const mode = value as string;
        if (mode === 'ask' || mode === 'allow' || mode === 'deny') {
          this.promptMode = mode;
          const error = await this.saveSection('permissions', { mode });
          if (error) await this.rejectWith(error);
        }
        return;
      }
      // Web: add allowed domain
      if (fromId === this.webAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.webDomainInputId!, 'getValue', {}));
        const added = !!val && !this.webAllowedDomains.includes(val);
        if (added) {
          this.webAllowedDomains.push(val);
          await this.updateStringList(this.webDomainListId!, this.webAllowedDomains);
          await this.request(request(this.id, this.webDomainInputId!, 'update', { text: '' }));
        }
        await this.listAddFeedback(val, added);
        return;
      }
      if (fromId === this.webRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.webDomainListId!, 'getValue', {}));
        if (sel) {
          this.webAllowedDomains = this.webAllowedDomains.filter(d => d !== sel);
          await this.updateStringList(this.webDomainListId!, this.webAllowedDomains);
        }
        return;
      }
      // Web: add denied domain
      if (fromId === this.webDeniedAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.webDeniedInputId!, 'getValue', {}));
        const added = !!val && !this.webDeniedDomains.includes(val);
        if (added) {
          this.webDeniedDomains.push(val);
          await this.updateStringList(this.webDeniedListId!, this.webDeniedDomains);
          await this.request(request(this.id, this.webDeniedInputId!, 'update', { text: '' }));
        }
        await this.listAddFeedback(val, added);
        return;
      }
      if (fromId === this.webDeniedRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.webDeniedListId!, 'getValue', {}));
        if (sel) {
          this.webDeniedDomains = this.webDeniedDomains.filter(d => d !== sel);
          await this.updateStringList(this.webDeniedListId!, this.webDeniedDomains);
        }
        return;
      }
      // Web: add private host
      if (fromId === this.webPrivateAddBtnId && aspect === 'click') {
        const raw = await this.request<string>(request(this.id, this.webPrivateInputId!, 'getValue', {}));
        const val = raw?.trim().toLowerCase();
        if (val && !parsePrivateHost(val)) {
          await this.rejectWith('Not a host, host:port, address, or address range (e.g. 10.0.0.0/8).', this.theme.statusWarning);
          return;
        }
        const added = !!val && !this.webPrivateHosts.includes(val);
        if (added) {
          this.webPrivateHosts.push(val);
          await this.updateStringList(this.webPrivateListId!, this.webPrivateHosts);
          await this.request(request(this.id, this.webPrivateInputId!, 'update', { text: '' }));
        }
        await this.listAddFeedback(val, added);
        return;
      }
      if (fromId === this.webPrivateRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.webPrivateListId!, 'getValue', {}));
        if (sel) {
          this.webPrivateHosts = this.webPrivateHosts.filter(h => h !== sel);
          await this.updateStringList(this.webPrivateListId!, this.webPrivateHosts);
        }
        return;
      }

      // Permissions save button
      if (fromId === this.permsSaveBtnId && aspect === 'click') {
        await this.savePermissions();
        return;
      }

      // Enter in a login field saves the login
      if (aspect === 'submit' && (fromId === this.authUserInputId || fromId === this.authPassInputId)) {
        await this.saveAuthSettings();
      }
    });
  }

  /**
   * Show the global settings window.
   *
   * One window at a time. Building it waits on the provider and model lists,
   * which take seconds while the LLM is still fetching catalogs at startup,
   * so a second click (or a second sender) arrives mid-build. It joins the
   * build in progress: two builds made two windows, and the one this object
   * stopped tracking stayed on screen with every tab and button dead.
   */
  async show(): Promise<boolean> {
    if (this.windowId && !this.showInFlight) return true;
    this.showInFlight ??= this.openWindow().finally(() => { this.showInFlight = undefined; });
    const shown = await this.showInFlight;
    ensure(!shown || this.windowId !== undefined, 'GlobalSettings: a shown window has an id');
    return shown;
  }

  private async openWindow(): Promise<boolean> {
    contractRequire(this.windowId === undefined, 'GlobalSettings: one settings window at a time');

    await this.loadFromManager();

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winW = Math.min(720, Math.max(520, displayInfo.width - 40));
    const winH = Math.min(800, Math.max(480, displayInfo.height - 40));
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
        resizable: true,
      })
    );

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    // Tab bar: AI | Auth
    const { widgetIds: [tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'tabBar', windowId: this.windowId,
          tabs: this.visibleTabs().map(t => SETTINGS_TAB_LABELS[t]),
          closable: false,
          selectedIndex: Math.max(0, this.visibleTabs().indexOf(this.activeTab)) },
      ]})
    );
    this.tabBarId = tabBarId;
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    // AI container (plain VBox: the pane puts its status line and sub-tabs in
    // it, and each sub-tab scrolls by itself)
    this.aiContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.aiContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Auth container (scrollable VBox, initially hidden)
    this.authContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.authContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Permissions container (plain VBox, initially hidden): the active
    // category card expands to fill the viewport (its lists stretch), and
    // the Save Permissions row stays pinned at the bottom.
    this.permissionsContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.permissionsContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Skills & MCP container (scrollable VBox, initially hidden)
    this.skillsContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.skillsContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Packages container (scrollable VBox, initially hidden)
    this.packagesContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.packagesContainerId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Updates container (packaged desktop app only; scrollable VBox, initially hidden)
    if (this.appUpdaterId) {
      this.updatesContainerId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
        widgetId: this.updatesContainerId,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
    }

    // Status label at bottom (always visible)
    const { widgetIds: [statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId!, text: '',
          style: { color: this.theme.textDescription, fontSize: 12, align: 'right' } },
      ]})
    );
    this.statusLabelId = statusLabelId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Build AI tab content (the pane re-reads the provider list each time the window opens)
    await this.aiPane.build(this.windowId, this.aiContainerId, winW);
    // Build Auth tab content
    await this.buildAuthTab();
    // Build Permissions tab content
    await this.buildPermissionsTab();
    // Build Skills & MCP tab content
    await this.buildSkillsTab();
    // Build Packages tab content
    await this.buildPackagesTab();
    // Build Updates tab content (packaged desktop app only)
    if (this.updatesContainerId) await this.buildUpdatesTab();
    // Show correct tab
    await this.switchTab();

    this.changed('visibility', true);
    return true;
  }

  /**
   * A grouped card for one settings section (WidgetManager createSection:
   * ruled panel, sigil title, wrap-friendly hint). Returns the card's layout
   * id: add the section's rows to IT, not to the tab container. Cards size to
   * their content inside a ScrollableVBox; `expanding` fills a plain VBox.
   */
  private async sectionCard(parentId: AbjectId, title: string, description: string, descriptionHeight = 18, expanding = false): Promise<AbjectId> {
    const { sectionId } = await this.request<{ sectionId: AbjectId }>(
      request(this.id, this.widgetManagerId!, 'createSection', {
        parentLayoutId: parentId,
        windowId: this.windowId,
        title,
        description,
        hintHeight: descriptionHeight,
        expanding,
      })
    );
    return sectionId;
  }

  /** Build Skills & MCP tab content into skillsContainerId. */
  private async buildSkillsTab(): Promise<void> {
    const cId = this.skillsContainerId!;

    const card = await this.sectionCard(cId, 'Skills & MCP',
      'Skills teach agents new abilities (SKILL.md files in the skills folder of the data directory); MCP servers connect external tools and services. Manage what is installed, or browse the catalog to add more.', 34);

    const skillRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: card,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, card, 'addLayoutChild', {
      widgetId: skillRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        // One red primary per card: Browse leads, Installed is secondary.
        { type: 'button', windowId: this.windowId, text: 'Installed Skills' },
        { type: 'button', windowId: this.windowId, text: 'Browse Skills & MCP',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]})
    );
    this.skillBrowserBtnId = widgetIds[0];
    this.catalogBrowserBtnId = widgetIds[1];
    await this.request(request(this.id, this.skillBrowserBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.catalogBrowserBtnId, 'addDependent', {}));
    await this.request(request(this.id, skillRowId, 'addLayoutChild', {
      widgetId: this.skillBrowserBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 150, height: 36 },
    }));
    await this.request(request(this.id, skillRowId, 'addLayoutChild', {
      widgetId: this.catalogBrowserBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 180, height: 36 },
    }));
    await this.request(request(this.id, skillRowId, 'addLayoutSpacer', {}));
  }

  // ========== PACKAGES TAB ==========

  /**
   * Build Packages tab content into packagesContainerId: the installed
   * packages, the selected package's switch and settings, and the directories
   * packages load from. Everything shown and changed here goes through the
   * Packages object, which owns packages.json.
   */
  private async buildPackagesTab(): Promise<void> {
    const cId = this.packagesContainerId!;

    // ── Installed packages ──
    const listCard = await this.sectionCard(cId, 'Packages',
      'Abjects that load from installed packages. Enabling, disabling and package directories take effect the next time Abject starts; settings apply at once.', 34);
    this.pkgListCardId = listCard;

    const { widgetIds: [listId, noticeId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: [], searchable: false, style: { height: 140 } },
        { type: 'label', windowId: this.windowId, text: '',
          style: { color: this.theme.statusWarning, fontSize: 12, wordWrap: true, visible: false } },
      ]})
    );
    this.pkgListId = listId;
    this.pkgNoticeId = noticeId;
    await this.request(request(this.id, listId, 'addDependent', {}));
    await this.request(request(this.id, listCard, 'addLayoutChild', {
      widgetId: listId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 140 },
    }));
    await this.request(request(this.id, listCard, 'addLayoutChild', {
      widgetId: noticeId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // ── Selected package (rebuilt whenever the selection or its state changes) ──
    const detailCard = await this.sectionCard(cId, 'Selected package',
      'What the package is, whether it loads, and the settings it needs.', 18);
    // autoSize: the card grows and shrinks with whatever the pane is rebuilt to hold.
    this.pkgDetailLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: detailCard,
        autoSize: true,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, detailCard, 'addLayoutChild', {
      widgetId: this.pkgDetailLayoutId,
      sizePolicy: { vertical: 'preferred', horizontal: 'expanding' },
      preferredSize: { height: 40 },
    }));

    // ── Package directories ──
    const dirCard = await this.sectionCard(cId, 'Package directories',
      'Where packages load from, in order: a later copy of a package replaces an earlier one. Add a package directory, or a directory of packages.', 34);
    const ed = await this.stringListEditor(dirCard, 'Directories', '/absolute/path/to/packages', []);
    this.pkgDirInputId = ed.inputId;
    this.pkgDirAddBtnId = ed.addBtnId;
    this.pkgDirListId = ed.listId;
    this.pkgDirRemoveBtnId = ed.removeBtnId;

    await this.refreshPackages();
  }

  /** Re-read packages and directories from the Packages object and repaint the tab. */
  private async refreshPackages(): Promise<void> {
    if (!this.pkgListId) return;
    if (!this.packagesObjectId) this.packagesObjectId = await this.discoverDep('Packages') ?? undefined;
    if (!this.packagesObjectId) {
      await this.setPackagesNotice('The Packages service is not running, so packages cannot be managed here.');
      return;
    }
    try {
      const state = await this.request<{ packages: PackageView[]; problems: PackageProblem[] }>(
        request(this.id, this.packagesObjectId, 'list', {}), 30_000);
      this.pkgViews = state.packages;
      this.pkgProblems = state.problems;
      this.pkgDirs = await this.request<PackageDirView[]>(
        request(this.id, this.packagesObjectId, 'listDirs', {}), 30_000);
    } catch (err) {
      await this.setPackagesNotice(`Could not read packages: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.pkgSelected && !this.pkgViews.some(p => p.dir === this.pkgSelected)) this.pkgSelected = undefined;
    if (!this.pkgSelected && this.pkgViews.length > 0) this.pkgSelected = this.pkgViews[0].dir;
    try {
      await this.renderPackageList();
      await this.renderPackageDirs();
      await this.renderPackageDetail();
    } catch { /* settings window closed */ }
  }

  private async renderPackageList(): Promise<void> {
    if (!this.pkgListId) return;
    const items = this.pkgViews.map(p => ({
      label: `${p.icon ? `${p.icon} ` : ''}${p.name} ${p.version} · ${p.runtime} · ${packageStatusWord(p)}`,
      value: p.dir,
    }));
    await this.request(request(this.id, this.pkgListId, 'update', {
      items, selectedIndex: this.pkgViews.findIndex(p => p.dir === this.pkgSelected),
    }));

    const notes: string[] = [];
    if (this.pkgViews.length === 0) {
      notes.push('No packages found. Install one with pnpm forge, or add a directory below.');
    }
    const pending = this.pkgViews.filter(p => p.restartRequired).map(p => p.name);
    if (pending.length > 0) notes.push(`Restart Abject to apply changes to: ${[...new Set(pending)].join(', ')}.`);
    for (const problem of this.pkgProblems) notes.push(`Could not read ${problem.dir}: ${problem.error}`);
    await this.setPackagesNotice(notes.join(' '));
  }

  /** Show a note under the package list, or hide it when there is nothing to say. */
  private async setPackagesNotice(text: string): Promise<void> {
    if (!this.pkgNoticeId || !this.pkgListCardId) return;
    const lines = text ? estimateWrappedLineCount(text, SETTINGS_CARD_TEXT_WIDTH, 12) : 1;
    await this.request(request(this.id, this.pkgNoticeId, 'update', { text, style: { visible: text !== '' } }));
    await this.request(request(this.id, this.pkgListCardId, 'updateLayoutChild', {
      widgetId: this.pkgNoticeId,
      preferredSize: { height: text ? lines * 16 + 2 : 1 },
    }));
  }

  private async renderPackageDirs(): Promise<void> {
    if (!this.pkgDirListId) return;
    const items = this.pkgDirs.map(d => ({
      label: `${d.dir}  (${PACKAGE_DIR_ORIGINS[d.origin]}${d.exists ? '' : ', missing'})`,
      value: d.dir,
      actions: d.editable ? [{ id: 'remove', label: 'Remove' }] : [],
    }));
    await this.request(request(this.id, this.pkgDirListId, 'update', { items }));
    await this.syncListEmptyState(this.pkgDirListId, items.length === 0);
  }

  /** A word-wrapped label sized to its text, added to a layout. */
  private async addPackageLabel(
    layoutId: AbjectId, text: string, color: string, fontSize = 12,
  ): Promise<AbjectId> {
    const lines = estimateWrappedLineCount(text, SETTINGS_CARD_TEXT_WIDTH, fontSize);
    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text, style: { color, fontSize, wordWrap: true } },
      ]})
    );
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: lines * Math.round(fontSize * 1.35) + 2 },
    }));
    return labelId;
  }

  /** Rebuild the selected-package card: facts, the load switch, and a settings form. */
  private async renderPackageDetail(): Promise<void> {
    const layout = this.pkgDetailLayoutId;
    if (!layout) return;
    await this.request(request(this.id, layout, 'clearLayoutChildren', {}));
    this.pkgEnabledCheckboxId = undefined;
    this.pkgSaveBtnId = undefined;
    this.pkgSettingInputs.clear();

    const p = this.pkgViews.find(v => v.dir === this.pkgSelected);
    if (!p) {
      await this.addPackageLabel(layout, 'Pick a package above to see it here.', this.theme.textSecondary);
      return;
    }

    await this.addPackageLabel(layout, `${p.icon ? `${p.icon} ` : ''}${p.name} ${p.version}`, this.theme.textHeading, 14);
    if (p.description) await this.addPackageLabel(layout, p.description, this.theme.textDescription);
    const facts = [
      p.runtime === 'script' ? 'Script package' : 'WASM package',
      p.scope === 'workspace' ? 'one in every workspace' : 'one per instance',
      p.replaces ? `replaces the built-in ${p.replaces}` : `type ${p.typeName}`,
    ].join(' · ');
    await this.addPackageLabel(layout, facts, this.theme.textSecondary);
    await this.addPackageLabel(layout, `${p.dir} (${PACKAGE_DIR_ORIGINS[p.origin]})`, this.theme.textTertiary, 11);
    await this.addPackageLabel(layout, packageStatusSentence(p),
      p.restartRequired || p.missingRequired.length > 0 ? this.theme.statusWarning : this.theme.textDescription);

    const { widgetIds: [enabledId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: p.status !== 'disabled',
          text: 'Load this package (applies at the next start)' },
      ]})
    );
    this.pkgEnabledCheckboxId = enabledId;
    await this.request(request(this.id, enabledId, 'addDependent', {}));
    await this.request(request(this.id, layout, 'addLayoutChild', {
      widgetId: enabledId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    if (p.settings.length === 0) {
      await this.addPackageLabel(layout, 'This package declares no settings.', this.theme.textSecondary);
      return;
    }

    for (const spec of p.settings) {
      const value = p.values[spec.key];
      const title = `${spec.label}${spec.required ? ' (required)' : ''}`;
      let inputId: AbjectId;
      if (spec.type === 'boolean') {
        ({ widgetIds: [inputId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'checkbox', windowId: this.windowId, checked: value === true, text: title },
          ]})
        ));
        await this.request(request(this.id, layout, 'addLayoutChild', {
          widgetId: inputId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));
      } else {
        await this.addPackageLabel(layout, title, this.theme.textHeading, 13);
        const secretSet = spec.type === 'secret' && typeof value === 'object' && value !== null && value.set;
        const placeholder = spec.type === 'secret'
          ? (secretSet ? 'Stored. Type a new value to replace it.' : 'Not set')
          : spec.default !== undefined ? `Default: ${String(spec.default)}` : spec.label;
        const text = spec.type !== 'secret' && value !== undefined && typeof value !== 'object' ? String(value) : undefined;
        ({ widgetIds: [inputId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'textInput', windowId: this.windowId, placeholder,
              ...(text !== undefined ? { text } : {}),
              ...(spec.type === 'secret' ? { masked: true } : {}) },
          ]})
        ));
        await this.request(request(this.id, layout, 'addLayoutChild', {
          widgetId: inputId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 32 },
        }));
      }
      await this.request(request(this.id, inputId, 'addDependent', {}));
      this.pkgSettingInputs.set(inputId, spec);
      if (spec.description) await this.addPackageLabel(layout, spec.description, this.theme.textSecondary, 11);
    }

    const saveRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: layout,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, layout, 'addLayoutChild', {
      widgetId: saveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 40 },
    }));
    await this.request(request(this.id, saveRowId, 'addLayoutSpacer', {}));
    const { widgetIds: [saveId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save Settings',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]})
    );
    this.pkgSaveBtnId = saveId;
    await this.request(request(this.id, saveId, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, 'addLayoutChild', {
      widgetId: saveId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 130, height: 36 },
    }));
  }

  /**
   * Route a widget event from the Packages tab. Returns true when the event
   * belonged to the tab (handled or deliberately ignored), so the generic
   * handlers below never see it: a submit in a package setting must save the
   * package's settings, not the AI settings.
   */
  private async handlePackagesEvent(fromId: AbjectId, aspect: string, value: unknown): Promise<boolean> {
    if (!this.packagesContainerId) return false;

    if (fromId === this.pkgListId) {
      if (aspect === 'selectionChanged') {
        try {
          this.pkgSelected = (JSON.parse(value as string) as { value: string }).value;
          await this.renderPackageDetail();
        } catch { /* malformed selection */ }
      }
      return true;
    }

    if (fromId === this.pkgEnabledCheckboxId) {
      if (aspect === 'change') await this.setSelectedPackageEnabled(value === true || value === 'true');
      return true;
    }

    if (fromId === this.pkgSaveBtnId) {
      if (aspect === 'click') await this.saveSelectedPackageSettings();
      return true;
    }

    if (this.pkgSettingInputs.has(fromId)) {
      if (aspect === 'submit') await this.saveSelectedPackageSettings();
      return true;
    }

    if (fromId === this.pkgDirAddBtnId || fromId === this.pkgDirInputId) {
      if ((fromId === this.pkgDirAddBtnId && aspect === 'click') || (fromId === this.pkgDirInputId && aspect === 'submit')) {
        await this.addPackageDir();
      }
      return true;
    }

    if (fromId === this.pkgDirRemoveBtnId) {
      if (aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.pkgDirListId!, 'getValue', {}));
        if (sel) await this.removePackageDir(sel);
        else await this.rejectWith('Select a directory you added here to remove it.');
      }
      return true;
    }

    if (fromId === this.pkgDirListId) {
      if (aspect === 'action') {
        try {
          const data = JSON.parse(value as string) as { value: string; actionId: string };
          if (data.actionId === 'remove') await this.removePackageDir(data.value);
        } catch { /* malformed action */ }
      }
      return true;
    }

    return false;
  }

  private selectedPackage(): PackageView | undefined {
    return this.pkgViews.find(v => v.dir === this.pkgSelected);
  }

  private async setSelectedPackageEnabled(enabled: boolean): Promise<void> {
    const p = this.selectedPackage();
    if (!p || !this.packagesObjectId) return;
    const r = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.packagesObjectId, 'setEnabled', { name: p.name, enabled }));
    if (!r.success) {
      await this.rejectWith(r.error ?? `Could not change ${p.name}.`);
      await this.refreshPackages();
      return;
    }
    this.windowEffect('flash');
    await this.setStatus(enabled
      ? `${p.name} will load the next time Abject starts.`
      : `${p.name} will not load the next time Abject starts.`);
    await this.refreshPackages();
  }

  private async saveSelectedPackageSettings(): Promise<void> {
    const p = this.selectedPackage();
    if (!p || !this.packagesObjectId) return;
    const values: Record<string, unknown> = {};
    for (const [inputId, spec] of this.pkgSettingInputs) {
      const raw = String(await this.request<string>(request(this.id, inputId, 'getValue', {})) ?? '');
      if (spec.type === 'boolean') {
        values[spec.key] = raw === 'true';
      } else if (spec.type === 'number') {
        if (raw.trim() === '') { values[spec.key] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n)) { await this.rejectWith(`${spec.label} must be a number.`); return; }
        values[spec.key] = n;
      } else if (spec.type === 'secret') {
        values[spec.key] = raw; // empty keeps the stored secret
      } else {
        values[spec.key] = raw === '' ? null : raw; // empty falls back to the default
      }
    }
    const r = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.packagesObjectId, 'setSettings', { name: p.name, values }));
    if (!r.success) {
      await this.rejectWith(r.error ?? `Could not save settings for ${p.name}.`);
      return;
    }
    this.windowEffect('flash');
    await this.setStatus(`Settings saved for ${p.name}.`);
    await this.refreshPackages();
  }

  private async addPackageDir(): Promise<void> {
    if (!this.packagesObjectId || !this.pkgDirInputId) return;
    const dir = String(await this.request<string>(request(this.id, this.pkgDirInputId, 'getValue', {})) ?? '').trim();
    const r = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.packagesObjectId, 'addDir', { dir }));
    if (!r.success) {
      await this.rejectWith(r.error ?? 'Could not add that directory.');
      return;
    }
    await this.request(request(this.id, this.pkgDirInputId, 'update', { text: '' }));
    await this.listAddFeedback(dir, true);
    await this.setStatus('Directory added. Restart Abject to load packages from it.');
    await this.refreshPackages();
  }

  private async removePackageDir(dir: string): Promise<void> {
    if (!this.packagesObjectId) return;
    const r = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.packagesObjectId, 'removeDir', { dir }));
    if (!r.success) {
      await this.rejectWith(r.error ?? 'Could not remove that directory.');
      return;
    }
    await this.setStatus('Directory removed. Restart Abject to stop loading packages from it.');
    await this.refreshPackages();
  }

  // ========== UPDATES TAB (packaged desktop app only) ==========

  /**
   * Find AppUpdater, which exists only in the packaged desktop app, and watch
   * it: its status feeds the Updates tab and the new-version notification.
   */
  private async connectAppUpdater(): Promise<void> {
    this.appUpdaterId = await this.discoverDep('AppUpdater') ?? undefined;
    if (!this.appUpdaterId) return;
    try {
      await this.request(request(this.id, this.appUpdaterId, 'addDependent', {}));
      this.updateStatus = await this.request<UpdateStatus>(request(this.id, this.appUpdaterId, 'getStatus', {}));
    } catch (err) {
      log.warn(`AppUpdater did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private askUpdater<T>(method: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.request<T>(request(this.id, this.appUpdaterId!, method, payload), timeoutMs);
  }

  /** Build Updates tab content into updatesContainerId. */
  private async buildUpdatesTab(): Promise<void> {
    const cId = this.updatesContainerId!;
    const u = this.updateStatus;
    const note = u
      ? `${UPDATE_INSTALL_NOTE[u.installKind]}${u.installKind === 'manual' && u.manualReason ? ` (${u.manualReason}.)` : ''}`
      : '';
    const card = await this.sectionCard(cId, u ? `Abject ${u.currentVersion}` : 'Abject', note, 34);

    const action = { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder };
    const { widgetIds: [statusId, progressId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textPrimary, fontSize: 13, wordWrap: true, selectable: true } },
        { type: 'progress', windowId: this.windowId, value: 0, style: { visible: false } },
      ] })
    );
    this.updStatusLabelId = statusId;
    this.updProgressId = progressId;
    await this.request(request(this.id, card, 'addLayoutChild', {
      widgetId: statusId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 54 },
    }));
    await this.request(request(this.id, card, 'addLayoutChild', {
      widgetId: progressId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 12 },
    }));

    const row = await this.request<AbjectId>(request(this.id, this.widgetManagerId!, 'createNestedHBox', {
      parentLayoutId: card, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8,
    }));
    await this.request(request(this.id, card, 'addLayoutChild', {
      widgetId: row, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 32 },
    }));
    const { widgetIds: [primaryId, checkId, notesId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Download', style: { ...action, visible: false } },
        { type: 'button', windowId: this.windowId, text: 'Check now' },
        { type: 'button', windowId: this.windowId, text: 'Release notes', style: { visible: false } },
      ] })
    );
    this.updPrimaryBtnId = primaryId;
    this.updCheckBtnId = checkId;
    this.updNotesBtnId = notesId;
    for (const [id, width] of [[primaryId, 150], [checkId, 110], [notesId, 120]] as const) {
      await this.request(request(this.id, id, 'addDependent', {}));
      await this.request(request(this.id, row, 'addLayoutChild', {
        widgetId: id, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width, height: 30 },
      }));
    }

    if (u && u.installKind !== 'manual') {
      const { widgetIds: [autoId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'checkbox', windowId: this.windowId, checked: u.autoDownload, text: 'Download new versions automatically' },
        ] })
      );
      this.updAutoCheckboxId = autoId;
      await this.request(request(this.id, autoId, 'addDependent', {}));
      await this.request(request(this.id, card, 'addLayoutChild', {
        widgetId: autoId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 24 },
      }));
    }

    await this.refreshUpdatesTab();
  }

  /** What the Updates tab's main button does in the current state, if anything. */
  private updatesPrimaryAction(): { label: string; run: () => Promise<void> } | undefined {
    const u = this.updateStatus;
    if (!u) return undefined;
    const manual = u.installKind === 'manual';
    if (u.state === 'ready') return { label: 'Restart to update', run: () => this.restartToUpdate() };
    if (u.state === 'available' && manual) return { label: 'Download', run: async () => { await this.askUpdater('openPage', { page: 'download' }); } };
    if (u.state === 'available') return { label: 'Download', run: async () => { await this.askUpdater('download'); } };
    if (u.state === 'error' && !manual && u.latestVersion && u.latestVersion !== u.currentVersion) {
      return { label: 'Retry download', run: async () => { await this.askUpdater('download'); } };
    }
    return undefined;
  }

  private updatesStatusText(): string {
    const u = this.updateStatus;
    if (!u) return 'Software updates are not available right now.';
    const checked = u.lastCheckedAt ? ` Checked ${timeSince(u.lastCheckedAt)}.` : '';
    switch (u.state) {
      case 'idle': return `Abject ${u.currentVersion} is running.${checked}`;
      case 'checking': return 'Checking for a new version…';
      case 'upToDate': return `Abject ${u.currentVersion} is the newest version.${checked}`;
      case 'available':
        if (u.installKind === 'manual') {
          return process.platform === 'darwin'
            ? `Version ${u.latestVersion} is available. Download it, open the disk image, and drag Abject into Applications, replacing the old one.`
            : `Version ${u.latestVersion} is available. Download it and replace the old Abject with it.`;
        }
        return `Version ${u.latestVersion} is available.`;
      case 'downloading': {
        const of = u.totalBytes ? ` (${megabytes(u.transferredBytes ?? 0)} of ${megabytes(u.totalBytes)})` : '';
        return `Downloading version ${u.latestVersion}: ${u.percent ?? 0}%${of}`;
      }
      case 'ready':
        if (u.installKind === 'appimage') return `Version ${u.latestVersion} is installed. Restart Abject to start using it.`;
        return u.installKind === 'deb'
          ? `Version ${u.latestVersion} is ready. Restart Abject to install it; installing asks for your password.`
          : `Version ${u.latestVersion} is ready. Restart Abject to finish updating, or it installs the next time you quit.`;
      case 'error': return `The update did not work: ${u.error ?? 'unknown error'}`;
    }
  }

  private async refreshUpdatesTab(): Promise<void> {
    if (!this.updatesContainerId) return;
    const u = this.updateStatus;
    const act = this.updatesPrimaryAction();
    const set = async (id: AbjectId | undefined, payload: Record<string, unknown>): Promise<void> => {
      if (!id) return;
      try { await this.request(request(this.id, id, 'update', payload)); } catch { /* widget gone */ }
    };
    const text = { fontSize: 13, wordWrap: true, selectable: true };
    const statusStyle = u?.state === 'error' ? { ...text, color: this.theme.statusError }
      : u?.state === 'ready' || u?.state === 'available' ? { ...livingStyle(this.theme), ...text }
      : { ...text, color: this.theme.textPrimary };
    await set(this.updStatusLabelId, { text: this.updatesStatusText(), style: statusStyle });
    // A fraction: the bar reads values up to 1 as fractions, so 1% would draw full.
    await set(this.updProgressId, { visible: u?.state === 'downloading', value: (u?.percent ?? 0) / 100 });
    await set(this.updPrimaryBtnId, act ? { visible: true, text: act.label } : { visible: false });
    await set(this.updNotesBtnId, { visible: !!u?.releaseUrl && !!u.latestVersion && u.latestVersion !== u.currentVersion });
    if (u) await set(this.updAutoCheckboxId, { checked: u.autoDownload });
  }

  /** AppUpdater's changes and the Updates tab's widgets. True when handled. */
  private async handleUpdatesEvent(fromId: AbjectId, aspect: string, value: unknown): Promise<boolean> {
    if (!this.appUpdaterId) return false;
    if (fromId === this.appUpdaterId) {
      if (aspect === 'updateStatus') {
        this.updateStatus = value as UpdateStatus;
        await this.refreshUpdatesTab();
        await this.announceUpdate();
      } else if (aspect === 'showRequested') {
        await this.showUpdatesTab();
      }
      return true;
    }
    const ours = fromId === this.updPrimaryBtnId || fromId === this.updCheckBtnId
      || fromId === this.updNotesBtnId || fromId === this.updAutoCheckboxId;
    if (!ours) return false;
    try {
      if (fromId === this.updAutoCheckboxId) {
        if (aspect === 'change') {
          this.updateStatus = await this.askUpdater<UpdateStatus>('setAutoDownload', { enabled: value === 'true' });
          await this.refreshUpdatesTab();
        }
      } else if (aspect === 'click') {
        if (fromId === this.updPrimaryBtnId) await this.updatesPrimaryAction()?.run();
        else if (fromId === this.updCheckBtnId) await this.askUpdater('checkNow', {}, 60_000);
        else await this.askUpdater('openPage', { page: 'release' });
      }
    } catch (err) {
      await this.request(request(this.id, this.updStatusLabelId!, 'update', {
        text: `That did not work: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
        style: { color: this.theme.statusError, fontSize: 13, wordWrap: true, selectable: true },
      })).catch(() => { /* widget gone */ });
    }
    return true;
  }

  /** Open the settings window on the Updates tab (Help → Check for Updates…). */
  private async showUpdatesTab(): Promise<void> {
    this.activeTab = 'updates';
    if (!this.windowId) { await this.show(); return; }
    if (this.tabBarId) {
      await this.request(request(this.id, this.tabBarId, 'update', { selectedIndex: this.visibleTabs().indexOf('updates') }));
    }
    await this.switchTab();
    await this.refreshUpdatesTab();
  }

  /**
   * Restart into the new version. Goals still running anywhere are
   * interrupted by a restart, so the user is told how many first and can
   * wait; the choice stays theirs.
   */
  private async restartToUpdate(): Promise<void> {
    const running = await this.countRunningGoals();
    if (running > 0) {
      const ok = await this.confirm({
        title: 'Restart to update',
        message: `${running} goal${running === 1 ? ' is' : 's are'} still running. Restarting now interrupts ${running === 1 ? 'it' : 'them'}.`,
        confirmLabel: 'Restart anyway',
        cancelLabel: 'Later',
      });
      if (!ok) return;
    }
    // A .deb install asks for a password before the reply comes back.
    await this.askUpdater('restartToUpdate', {}, 300_000);
  }

  private async workspaceManager(): Promise<AbjectId | undefined> {
    this.workspaceManagerId = await this.resolveDep('WorkspaceManager', this.workspaceManagerId);
    return this.workspaceManagerId;
  }

  /** Active goals across every workspace, background ones included. */
  private async countRunningGoals(): Promise<number> {
    const wsm = await this.workspaceManager();
    if (!wsm) return 0;
    let workspaces: Array<{ registryId?: AbjectId }> = [];
    try {
      workspaces = await this.request<Array<{ registryId?: AbjectId }>>(request(this.id, wsm, 'listWorkspacesDetailed', {}));
    } catch { return 0; }
    const counts = await Promise.all(workspaces.map(async (ws) => {
      if (!ws.registryId) return 0;
      try {
        const [gm] = await this.request<Array<{ id: AbjectId }>>(request(this.id, ws.registryId, 'discover', { name: 'GoalManager' }), 5000);
        if (!gm) return 0;
        const stats = await this.request<{ active?: number }>(request(this.id, gm.id, 'getStats', {}), 5000);
        return stats.active ?? 0;
      } catch { return 0; }
    }));
    return counts.reduce((a, b) => a + b, 0);
  }

  /**
   * Notify the user of a new version, once per version: when it is ready to
   * install, or, when it will not download by itself (a manual install, or
   * automatic downloads off), as soon as it is found.
   */
  private async announceUpdate(): Promise<void> {
    const u = this.updateStatus;
    if (!u?.latestVersion || u.latestVersion === this.announcedUpdateVersion) return;
    const downloadsItself = u.installKind !== 'manual' && u.autoDownload;
    const ready = u.state === 'ready';
    const found = u.state === 'available' && !downloadsItself;
    if (!ready && !found) return;
    this.announcedUpdateVersion = u.latestVersion;
    const message = !ready
      ? `Abject ${u.latestVersion} is available. Get it from Settings, under Updates.`
      : u.installKind === 'appimage'
        ? `Abject ${u.latestVersion} is installed. Restart from Settings, under Updates, to start using it.`
        : `Abject ${u.latestVersion} is ready to install. Restart from Settings, under Updates.`;
    const nc = await this.activeNotificationCenter();
    if (nc) this.send(event(this.id, nc, 'notify', { message, level: 'info', durationMs: 12_000 }));
  }

  /** NotificationCenter is per workspace: the active workspace's, through WorkspaceManager. */
  private async activeNotificationCenter(): Promise<AbjectId | undefined> {
    const wsm = await this.workspaceManager();
    if (!wsm) return undefined;
    try {
      const active = await this.request<{ registryId?: AbjectId } | null>(request(this.id, wsm, 'getActiveWorkspace', {}));
      if (!active?.registryId) return undefined;
      const found = await this.request<Array<{ id: AbjectId }>>(request(this.id, active.registryId, 'discover', { name: 'NotificationCenter' }));
      return found?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  /** Build Auth tab content into authContainerId. */
  private async buildAuthTab(): Promise<void> {
    const cId = this.authContainerId!;

    // The login fields live in a kit section card (header + hint).
    const authParent: AbjectId = await this.sectionCard(cId, 'Authentication',
      'Ask for a username and password whenever a client connects to this desktop. Saving reconnects open clients.', 34);

    // The login as SettingsManager holds it
    const savedAuthEnabled = this.managed?.auth.enabled ?? false;
    const savedAuthUser = this.managed?.auth.username ?? '';
    const savedAuthPass = this.managed?.auth.password.value ?? '';

    // Enable auth checkbox row
    const authEnableRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: authParent,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, authParent, 'addLayoutChild', {
      widgetId: authEnableRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    const { widgetIds: [authCheckboxId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId,
          checked: savedAuthEnabled,
          text: 'Require login' },
      ]})
    );
    this.authCheckboxId = authCheckboxId;
    await this.request(request(this.id, this.authCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, authEnableRowId, 'addLayoutChild', {
      widgetId: this.authCheckboxId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Username label + input
    const { widgetIds: [authUserLabelId, authUserInputId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Username',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'textInput', windowId: this.windowId, placeholder: 'Username',
          text: savedAuthUser || undefined,
          style: savedAuthEnabled ? undefined : { disabled: true } },
      ]})
    );
    this.authUserInputId = authUserInputId;
    await this.request(request(this.id, authParent, 'addLayoutChild', {
      widgetId: authUserLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, this.authUserInputId, 'addDependent', {}));
    await this.request(request(this.id, authParent, 'addLayoutChild', {
      widgetId: this.authUserInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Password label
    const { widgetIds: [authPassLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Password',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, authParent, 'addLayoutChild', {
      widgetId: authPassLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Password input row (HBox: input + toggle)
    const authPassRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: authParent,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, authParent, 'addLayoutChild', {
      widgetId: authPassRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [authPassInputId, authPassToggleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Password', masked: true,
          text: savedAuthPass || undefined,
          style: savedAuthEnabled ? undefined : { disabled: true } },
        { type: 'button', windowId: this.windowId, text: 'Show',
          style: savedAuthEnabled ? undefined : { disabled: true } },
      ]})
    );
    this.authPassInputId = authPassInputId;
    this.authPassToggleId = authPassToggleId;
    await this.request(request(this.id, this.authPassInputId, 'addDependent', {}));
    await this.request(request(this.id, authPassRowId, 'addLayoutChild', {
      widgetId: this.authPassInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.authPassToggleId, 'addDependent', {}));
    await this.request(request(this.id, authPassRowId, 'addLayoutChild', {
      widgetId: this.authPassToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Auth save button row
    const authSaveRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authSaveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, authSaveRowId, 'addLayoutSpacer', {}));

    const { widgetIds: [authSaveBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save Auth',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]})
    );
    this.authSaveBtnId = authSaveBtnId;
    await this.request(request(this.id, this.authSaveBtnId, 'addDependent', {}));
    await this.request(request(this.id, authSaveRowId, 'addLayoutChild', {
      widgetId: this.authSaveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 120, height: 36 },
    }));
  }


  /**
   * Hide the global settings window.
   */
  async hide(): Promise<boolean> {
    // A close that lands while the window is still being built closes the
    // finished window rather than racing the build.
    if (this.showInFlight) await this.showInFlight.catch(() => false);
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.aiPane.reset();
    this.statusLabelId = undefined;
    this.listEmptyNoteIds.clear();
    this.scrollBodyListLayouts.clear();
    this.authCheckboxId = undefined;
    this.authUserInputId = undefined;
    this.authPassInputId = undefined;
    this.authPassToggleId = undefined;
    this.authSaveBtnId = undefined;
    this.skillBrowserBtnId = undefined;
    this.catalogBrowserBtnId = undefined;
    this.tabBarId = undefined;
    this.aiContainerId = undefined;
    this.authContainerId = undefined;
    this.skillsContainerId = undefined;
    this.permissionsContainerId = undefined;
    this.autonomyStatusId = undefined;
    this.takeWheelBtnId = undefined;
    this.permSubTabBarId = undefined;
    this.permCategoryCardIds = [];
    this.platformLabelId = undefined;
    this.fsReadOnlyCheckboxId = undefined;
    this.fsPathInputId = undefined;
    this.fsAddBtnId = undefined;
    this.fsPathListId = undefined;
    this.fsRemoveBtnId = undefined;
    this.shellEnabledCheckboxId = undefined;
    this.shellCmdInputId = undefined;
    this.shellAddBtnId = undefined;
    this.shellCmdListId = undefined;
    this.shellRemoveBtnId = undefined;
    this.shellDeniedInputId = undefined;
    this.shellDeniedAddBtnId = undefined;
    this.shellDeniedListId = undefined;
    this.shellDeniedRemoveBtnId = undefined;
    this.objectPermInputId = undefined;
    this.objectPermAddBtnId = undefined;
    this.objectPermListId = undefined;
    this.objectPermRemoveBtnId = undefined;
    this.objectDenyInputId = undefined;
    this.objectDenyAddBtnId = undefined;
    this.objectDenyListId = undefined;
    this.objectDenyRemoveBtnId = undefined;
    this.webEnabledCheckboxId = undefined;
    this.webDomainInputId = undefined;
    this.webAddBtnId = undefined;
    this.webDomainListId = undefined;
    this.webRemoveBtnId = undefined;
    this.webDeniedInputId = undefined;
    this.webDeniedAddBtnId = undefined;
    this.webDeniedListId = undefined;
    this.webDeniedRemoveBtnId = undefined;
    this.webPrivateInputId = undefined;
    this.webPrivateAddBtnId = undefined;
    this.webPrivateListId = undefined;
    this.webPrivateRemoveBtnId = undefined;
    this.promptModeSelectId = undefined;
    this.permsSaveBtnId = undefined;
    this.packagesContainerId = undefined;
    this.pkgListCardId = undefined;
    this.pkgListId = undefined;
    this.pkgNoticeId = undefined;
    this.pkgDetailLayoutId = undefined;
    this.pkgEnabledCheckboxId = undefined;
    this.pkgSaveBtnId = undefined;
    this.pkgSettingInputs.clear();
    this.pkgDirInputId = undefined;
    this.pkgDirAddBtnId = undefined;
    this.pkgDirListId = undefined;
    this.pkgDirRemoveBtnId = undefined;
    this.updatesContainerId = undefined;
    this.updStatusLabelId = undefined;
    this.updProgressId = undefined;
    this.updPrimaryBtnId = undefined;
    this.updCheckBtnId = undefined;
    this.updNotesBtnId = undefined;
    this.updAutoCheckboxId = undefined;
    this.unmasked.clear();

    this.changed('visibility', false);
    return true;
  }

  /** Show/hide tab containers based on activeTab. */
  private async switchTab(): Promise<void> {
    if (!this.aiContainerId || !this.authContainerId || !this.permissionsContainerId || !this.skillsContainerId
        || !this.packagesContainerId) return;
    await this.request(request(this.id, this.aiContainerId, 'update', { style: { visible: this.activeTab === 'ai' } }));
    await this.request(request(this.id, this.authContainerId, 'update', { style: { visible: this.activeTab === 'auth' } }));
    await this.request(request(this.id, this.permissionsContainerId, 'update', { style: { visible: this.activeTab === 'permissions' } }));
    await this.request(request(this.id, this.skillsContainerId, 'update', { style: { visible: this.activeTab === 'skills' } }));
    await this.request(request(this.id, this.packagesContainerId, 'update', { style: { visible: this.activeTab === 'packages' } }));
    if (this.updatesContainerId) {
      await this.request(request(this.id, this.updatesContainerId, 'update', { style: { visible: this.activeTab === 'updates' } }));
    }
  }

  /** The tabs this window shows: Updates only where AppUpdater exists. */
  private visibleTabs(): SettingsTab[] {
    return SETTINGS_TABS.filter(t => t !== 'updates' || this.appUpdaterId !== undefined);
  }

  // ========== HELPERS ==========

  /**
   * Repaint a permission list editor's rows, then swap the list for its
   * empty-state note when it has no entries.
   */
  private async updateStringList(listId: AbjectId, items: string[]): Promise<void> {
    await this.request(request(this.id, listId, 'update', { items: toListItems(items) }));
    await this.syncListEmptyState(listId, items.length === 0);
  }

  /** Show the empty-state note in place of an empty permission list. */
  private async syncListEmptyState(listId: AbjectId, empty: boolean): Promise<void> {
    const noteId = this.listEmptyNoteIds.get(listId);
    if (!noteId) return;
    try {
      await this.request(request(this.id, listId, 'update', { style: { visible: !empty } }));
      await this.request(request(this.id, noteId, 'update', { style: { visible: empty } }));
      const bodyId = this.scrollBodyListLayouts.get(listId);
      if (bodyId) {
        await this.request(request(this.id, bodyId, 'updateLayoutChild', {
          widgetId: listId, preferredSize: { height: empty ? 0 : 80 },
        }));
      }
    } catch { /* settings window closed */ }
  }

  private async setStatus(text: string, color = this.theme.textDescription): Promise<void> {
    if (!this.statusLabelId) return;
    await this.request(
      request(this.id, this.statusLabelId, 'update', {
        text, style: { color },
      })
    );
  }

  /**
   * Play a slab effect on a window (visual only, fire and forget): the
   * settings window by default, or a prompt window. `color` overrides the
   * effect's light (a $token), e.g. '$accent' for the hand's own edits.
   */
  private windowEffect(effect: 'shake' | 'flash' | 'pulse', color?: string, windowId = this.windowId): void {
    if (!windowId) return;
    this.request(request(this.id, windowId, 'effect', { effect, ...(color ? { color } : {}) }))
      .catch(() => { /* effects are decoration */ });
  }

  /** Invalid input or a failure: status in the given colour plus a shake. */
  private async rejectWith(text: string, color = this.theme.statusErrorBright): Promise<void> {
    this.windowEffect('shake');
    await this.setStatus(text, color);
  }

  /**
   * Feedback for a list-editor Add: a hand-coloured flash when the value
   * joined the (unsaved) list, a shake when it was empty or already there.
   */
  private async listAddFeedback(value: string | null | undefined, added: boolean): Promise<void> {
    if (added) {
      this.windowEffect('flash', '$accent');
      return;
    }
    await this.rejectWith(value ? 'Already in the list.' : 'Type a value first.', this.theme.statusWarning);
  }

  /** Mark a permission prompt modal (or release it). Best effort. */
  private async setPromptModal(windowId: AbjectId | undefined, modal: boolean): Promise<void> {
    if (!windowId) return;
    try {
      await this.request(request(this.id, windowId, 'setModal', { modal }));
    } catch { /* window gone or no surface yet */ }
  }

  /**
   * Toggle masked state on a text input and update its toggle button label.
   */
  private async toggleMask(inputId: AbjectId, toggleId: AbjectId): Promise<void> {
    if (!this.windowId) return;

    const showing = this.unmasked.has(inputId);
    if (showing) {
      this.unmasked.delete(inputId);
    } else {
      this.unmasked.add(inputId);
    }
    const nowMasked = !this.unmasked.has(inputId);

    await this.request(
      request(this.id, inputId, 'update', {
        masked: nowMasked,
      })
    );
    await this.request(
      request(this.id, toggleId, 'update', {
        text: nowMasked ? 'Show' : 'Hide',
      })
    );
  }

  // ========== CHANGES FROM ELSEWHERE ==========

  /**
   * A section changed through SettingsManager. An open window reloads it
   * and repaints its widgets; this window's own saves come back too and need
   * nothing. Unsaved edits in the section that changed give way to the saved
   * values.
   */
  private async onSettingsChanged(section: string | undefined): Promise<void> {
    if (!this.windowId || !section) return;
    const own = this.lastOwnSave;
    if (own && (own.section === section || section === 'presets') && Date.now() - own.at < 5000) return;
    if (section === 'presets') {
      // Presets follow the provider list (SettingsManager announces a
      // provider registering or leaving this way), so the AI tab re-reads both.
      await this.aiPane.reload(true);
      return;
    }
    await this.loadFromManager();
    switch (section) {
      case 'ai': await this.aiPane.reload(); break;
      case 'auth': await this.showAuthSettings(); break;
      default: await this.showPermissionSettings(); break;
    }
    await this.setStatus('Settings changed elsewhere; showing the saved values.', this.theme.textDescription);
  }

  /**
   * Undo or redo this window's last settings change through SettingsManager,
   * then repaint the AI tab (the only one undo touches) from what it holds.
   */
  private async undoSettings(action: UndoAction, opts: { fromAiTab?: boolean } = {}): Promise<UndoResult> {
    // The change comes back as settingsChanged; this repaint answers it.
    const prior = this.lastOwnSave;
    this.lastOwnSave = { section: 'ai', at: Date.now() };
    const result = await this.forwardUndo([this.settingsManagerId], action);
    if (!result.ok) this.lastOwnSave = prior;
    if (!result.ok || !this.windowId) return result;
    await this.loadFromManager();
    // The AI tab's own Undo button repaints the tab itself once this returns.
    if (!opts.fromAiTab) await this.aiPane.reload();
    await this.setStatus(`${action === 'undo' ? 'Undid' : 'Redid'} ${result.label ?? 'the last change'}.`, this.theme.statusSuccess);
    return result;
  }

  private async showAuthSettings(): Promise<void> {
    const auth = this.managed?.auth;
    if (!auth) return;
    const set = async (id: AbjectId | undefined, payload: Record<string, unknown>): Promise<void> => {
      if (!id) return;
      try { await this.request(request(this.id, id, 'update', payload)); } catch { /* widget gone */ }
    };
    await set(this.authCheckboxId, { checked: auth.enabled });
    await set(this.authUserInputId, { text: auth.username });
    await set(this.authPassInputId, { text: auth.password.value ?? '' });
    await this.setAuthFieldsDisabled(!auth.enabled);
  }

  private async showPermissionSettings(): Promise<void> {
    const set = async (id: AbjectId | undefined, payload: Record<string, unknown>): Promise<void> => {
      if (!id) return;
      try { await this.request(request(this.id, id, 'update', payload)); } catch { /* widget gone */ }
    };
    for (const [listId, items] of [
      [this.fsPathListId, this.fsAllowedPaths],
      [this.shellCmdListId, this.shellAllowedCmds],
      [this.shellDeniedListId, this.shellDeniedCmds],
      [this.webDomainListId, this.webAllowedDomains],
      [this.webDeniedListId, this.webDeniedDomains],
      [this.webPrivateListId, this.webPrivateHosts],
    ] as Array<[AbjectId | undefined, string[]]>) {
      if (listId) { try { await this.updateStringList(listId, items); } catch { /* widget gone */ } }
    }
    await this.refreshObjectPermLists();
    await set(this.fsReadOnlyCheckboxId, { checked: this.fsReadOnly });
    await set(this.shellEnabledCheckboxId, { checked: this.shellEnabled });
    await set(this.webEnabledCheckboxId, { checked: this.webEnabled });
    await set(this.promptModeSelectId, { selectedIndex: Math.max(0, PROMPT_MODE_OPTIONS.indexOf(this.promptMode)) });
  }

  // ========== AUTH HELPERS ==========

  /**
   * Enable/disable auth credential fields based on checkbox state.
   */
  private async setAuthFieldsDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    const ids = [this.authUserInputId, this.authPassInputId, this.authPassToggleId];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  /**
   * Read the auth widgets and save them through SettingsManager, which
   * persists them and applies them (signing every client out).
   */
  private async saveAuthSettings(): Promise<void> {
    if (!this.windowId) return;

    const checked = await this.request<boolean>(
      request(this.id, this.authCheckboxId!, 'getValue', {})
    );
    const username = await this.request<string>(
      request(this.id, this.authUserInputId!, 'getValue', {})
    );
    const password = await this.request<string>(
      request(this.id, this.authPassInputId!, 'getValue', {})
    );
    const enabled = !!checked;

    const error = await this.saveSection('auth', { enabled, username: username ?? '', password: password ?? '' });
    if (error) {
      await this.rejectWith(error);
      return;
    }
    log.info(`Auth settings saved (enabled=${enabled})`);
    this.windowEffect('flash');
    await this.setStatus(enabled ? 'Auth enabled. Reconnecting...' : 'Auth disabled.');
  }

  // ========== PERMISSIONS TAB ==========

  /** Build Permissions tab content into permissionsContainerId. */
  private async buildPermissionsTab(): Promise<void> {
    const cId = this.permissionsContainerId!;

    // Permission values were loaded from SettingsManager when the window opened.

    // Platform info (shown inside the Shell card)
    let platformText = 'Platform: unknown';
    try {
      const shellId = await this.discoverDep('ShellExecutor');
      if (shellId) {
        const info = await this.request<{ os: string; arch: string; shell: string }>(
          request(this.id, shellId, 'getPlatformInfo', {})
        );
        platformText = `Platform: ${info.os} ${info.arch} (${info.shell})`;
      }
    } catch { /* ShellExecutor not available */ }

    // ── Category sub-tabs: one card per permission domain ──
    const { widgetIds: [permTabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'tabBar', windowId: this.windowId,
          tabs: ['Filesystem', 'Shell', 'Web'],
          closable: false,
          selectedIndex: 0 },
      ]})
    );
    this.permSubTabBarId = permTabBarId;
    await this.request(request(this.id, this.permSubTabBarId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.permSubTabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 34 },
    }));

    // ── Autonomy card ──
    // The one place that says, in one line, how much is currently happening
    // without you, and gives you the way back.
    const autoCard = await this.sectionCard(cId, 'Autonomy',
      'External projects can be set to run some commands without prompting you, capped by each '
      + 'workspace\'s access mode (shared allows at most edit; public always asks). '
      + 'Levels are set per project in the Projects window.', 48, true);

    const { widgetIds: [autoStatusId, wheelBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Checking…',
          style: { color: this.theme.textSecondary, fontSize: 12, wordWrap: true } },
        { type: 'button', windowId: this.windowId, text: 'Take the wheel',
          style: { fontSize: 12, color: this.theme.statusWarning } },
      ]})
    );
    this.autonomyStatusId = autoStatusId;
    this.takeWheelBtnId = wheelBtnId;
    await this.request(request(this.id, this.takeWheelBtnId, 'addDependent', {}));
    await this.request(request(this.id, autoCard, 'addLayoutChild', {
      widgetId: autoStatusId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, autoCard, 'addLayoutChild', {
      widgetId: wheelBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 150, height: 28 },
    }));
    void this.refreshAutonomyStatus();

    // What a request nothing else decides gets. "allow" and "deny" are for
    // running unattended, when nobody may be at a desktop or a terminal.
    const promptRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: autoCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, autoCard, 'addLayoutChild', {
      widgetId: promptRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));
    const { widgetIds: [promptLabelId, promptSelectId, promptHintId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Prompts',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'select', windowId: this.windowId, options: [...PROMPT_MODE_OPTIONS],
          selectedIndex: Math.max(0, PROMPT_MODE_OPTIONS.indexOf(this.promptMode)) },
        { type: 'label', windowId: this.windowId,
          text: 'ask waits for you here or in the terminal; allow approves once without asking (dangerous commands, website clicks that submit or activate something, and destructive MCP tools still ask); deny refuses.',
          style: { color: this.theme.textSecondary, fontSize: 11, wordWrap: true } },
      ]})
    );
    this.promptModeSelectId = promptSelectId;
    await this.request(request(this.id, this.promptModeSelectId, 'addDependent', {}));
    await this.request(request(this.id, promptRowId, 'addLayoutChild', {
      widgetId: promptLabelId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100, height: 30 },
    }));
    await this.request(request(this.id, promptRowId, 'addLayoutChild', {
      widgetId: promptSelectId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: 30 },
    }));
    await this.request(request(this.id, autoCard, 'addLayoutChild', {
      widgetId: promptHintId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    // ── Filesystem card ──
    const fsCard = await this.sectionCard(cId, 'Filesystem',
      'Where agents may read and write files. Paths outside the allowed list prompt you for approval; read-only mode blocks every write.', 34, true);

    const { widgetIds: [fsRoCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.fsReadOnly, text: 'Read-only mode (block all writes)' },
      ]})
    );
    this.fsReadOnlyCheckboxId = fsRoCheckId;
    await this.request(request(this.id, this.fsReadOnlyCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, fsCard, 'addLayoutChild', {
      widgetId: this.fsReadOnlyCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    {
      const ed = await this.stringListEditor(fsCard, 'Allowed paths', '/path/to/directory', this.fsAllowedPaths);
      this.fsPathInputId = ed.inputId;
      this.fsAddBtnId = ed.addBtnId;
      this.fsPathListId = ed.listId;
      this.fsRemoveBtnId = ed.removeBtnId;
    }

    // ── Shell card ──
    const shellCard = await this.sectionCard(cId, 'Shell',
      'Which shell commands agents may run. Commands not on the allowed list prompt you for approval; denied commands are always refused.', 34, true);

    // Four lists outgrow the card on any window, so the card's body scrolls
    // (as the Web card's does): the description stays put, the rest moves.
    const shellBody = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: shellCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, shellCard, 'addLayoutChild', {
      widgetId: shellBody,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const { widgetIds: [platLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: platformText,
          style: { color: this.theme.textTertiary, fontSize: 11 } },
      ]})
    );
    this.platformLabelId = platLabelId;
    await this.request(request(this.id, shellBody, 'addLayoutChild', {
      widgetId: this.platformLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 16 },
    }));

    const { widgetIds: [shellEnCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.shellEnabled, text: 'Enable shell execution' },
      ]})
    );
    this.shellEnabledCheckboxId = shellEnCheckId;
    await this.request(request(this.id, this.shellEnabledCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, shellBody, 'addLayoutChild', {
      widgetId: this.shellEnabledCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    {
      const ed = await this.stringListEditor(shellBody, 'Allowed commands', 'e.g. git, ls, npm', this.shellAllowedCmds, true);
      this.shellCmdInputId = ed.inputId;
      this.shellAddBtnId = ed.addBtnId;
      this.shellCmdListId = ed.listId;
      this.shellRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(shellBody, 'Denied commands (always refused)', 'e.g. rm, sudo', this.shellDeniedCmds, true);
      this.shellDeniedInputId = ed.inputId;
      this.shellDeniedAddBtnId = ed.addBtnId;
      this.shellDeniedListId = ed.listId;
      this.shellDeniedRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(
        shellBody,
        'Per-object allowed (object runs it with any arguments)',
        'e.g. TmuxSession: tmux',
        this.objectPermEntries('allow'),
        true,
      );
      this.objectPermInputId = ed.inputId;
      this.objectPermAddBtnId = ed.addBtnId;
      this.objectPermListId = ed.listId;
      this.objectPermRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(
        shellBody,
        'Per-object blocked (refused before any allow list)',
        'e.g. TmuxSession: rm',
        this.objectPermEntries('deny'),
        true,
      );
      this.objectDenyInputId = ed.inputId;
      this.objectDenyAddBtnId = ed.addBtnId;
      this.objectDenyListId = ed.listId;
      this.objectDenyRemoveBtnId = ed.removeBtnId;
    }

    // ── Web card ──
    const webCard = await this.sectionCard(cId, 'Web',
      'Which domains agents may reach over HTTP and streams. An empty allowed list permits every domain except the denied ones. ' +
      'Local and internal addresses (localhost, your network, cloud metadata) are refused unless listed under Private hosts.', 50, true);

    // Three lists outgrow the card on a short window, so the card's body
    // scrolls: the description stays put, the checkbox and lists move.
    const webBody = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: webCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, webCard, 'addLayoutChild', {
      widgetId: webBody,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const { widgetIds: [webEnCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.webEnabled, text: 'Enable HTTP requests' },
      ]})
    );
    this.webEnabledCheckboxId = webEnCheckId;
    await this.request(request(this.id, this.webEnabledCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, webBody, 'addLayoutChild', {
      widgetId: this.webEnabledCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    {
      const ed = await this.stringListEditor(webBody, 'Allowed domains (empty = allow all)', 'e.g. api.example.com', this.webAllowedDomains, true);
      this.webDomainInputId = ed.inputId;
      this.webAddBtnId = ed.addBtnId;
      this.webDomainListId = ed.listId;
      this.webRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(webBody, 'Denied domains (always refused)', 'e.g. evil.example.com', this.webDeniedDomains, true);
      this.webDeniedInputId = ed.inputId;
      this.webDeniedAddBtnId = ed.addBtnId;
      this.webDeniedListId = ed.listId;
      this.webDeniedRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(webBody, 'Private hosts (local and internal addresses allowed; empty = none)',
        'e.g. localhost:11434, models.internal, 10.0.0.0/8', this.webPrivateHosts, true);
      this.webPrivateInputId = ed.inputId;
      this.webPrivateAddBtnId = ed.addBtnId;
      this.webPrivateListId = ed.listId;
      this.webPrivateRemoveBtnId = ed.removeBtnId;
    }

    // Only the selected category's card is visible.
    this.permCategoryCardIds = [fsCard, shellCard, webCard];
    await this.switchPermCategory(0);

    // ── Save button (always visible, below the active card) ──
    const permsSaveRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: permsSaveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));
    await this.request(request(this.id, permsSaveRowId, 'addLayoutSpacer', {}));
    const { widgetIds: [permsSaveId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save Permissions',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]})
    );
    this.permsSaveBtnId = permsSaveId;
    await this.request(request(this.id, this.permsSaveBtnId, 'addDependent', {}));
    await this.request(request(this.id, permsSaveRowId, 'addLayoutChild', {
      widgetId: this.permsSaveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 150, height: 36 },
    }));
  }

  /** Show one permission-category card, hide the rest. */
  private async switchPermCategory(index: number): Promise<void> {
    for (let i = 0; i < this.permCategoryCardIds.length; i++) {
      const cardId = this.permCategoryCardIds[i];
      if (!cardId) continue;
      try {
        await this.request(request(this.id, cardId, 'update', { style: { visible: i === index } }));
      } catch { /* widget gone */ }
    }
  }

  /**
   * A labeled add/remove string-list editor: label, input + Add row, a list
   * whose rows carry an inline Remove action, and a Remove Selected button.
   * Returns the widget ids — the changed() handlers key on the fields the
   * caller stores them in. `inScrollBody`: the parent is a scrollable VBox,
   * where the list gets a fixed height instead of stretching.
   */
  private async stringListEditor(
    cardId: AbjectId,
    label: string,
    placeholder: string,
    items: string[],
    inScrollBody = false,
  ): Promise<{ inputId: AbjectId; addBtnId: AbjectId; listId: AbjectId; removeBtnId: AbjectId }> {
    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: label,
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cardId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    const addRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cardId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cardId, 'addLayoutChild', {
      widgetId: addRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [inputId, addBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder },
        { type: 'button', windowId: this.windowId, text: 'Add' },
      ]})
    );
    await this.request(request(this.id, inputId, 'addDependent', {}));
    await this.request(request(this.id, addBtnId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: inputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: addBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: toListItems(items), searchable: false,
          style: { height: 80 } },
      ]})
    );
    await this.request(request(this.id, listId, 'addDependent', {}));
    await this.request(request(this.id, cardId, 'addLayoutChild', {
      widgetId: listId,
      sizePolicy: { vertical: inScrollBody ? 'preferred' : 'expanding', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));
    if (inScrollBody) this.scrollBodyListLayouts.set(listId, cardId);

    // Empty-state note that stands in for the list while it has no entries.
    {
      const { widgetIds: [noteId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId,
            text: 'Nothing listed yet. Type an entry above and press Add.',
            style: { color: this.theme.textSecondary, fontSize: 12 } },
        ]})
      );
      await this.request(request(this.id, cardId, 'addLayoutChild', {
        widgetId: noteId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 20 },
      }));
      this.listEmptyNoteIds.set(listId, noteId);
      await this.syncListEmptyState(listId, items.length === 0);
    }

    const { widgetIds: [removeBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected',
          style: { fontSize: 12, background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder } },
      ]})
    );
    await this.request(request(this.id, removeBtnId, 'addDependent', {}));
    await this.request(request(this.id, cardId, 'addLayoutChild', {
      widgetId: removeBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 130, height: 28 },
    }));

    return { inputId, addBtnId, listId, removeBtnId };
  }

  /**
   * Save the permission forms through SettingsManager, which persists them
   * and pushes them to the capability objects.
   */
  private async savePermissions(): Promise<void> {
    const sections: Array<[SettingsSectionId, Record<string, unknown>]> = [
      ['filesystem', { allowedPaths: this.fsAllowedPaths, readOnly: this.fsReadOnly }],
      ['shell', {
        enabled: this.shellEnabled, allowedCommands: this.shellAllowedCmds, deniedCommands: this.shellDeniedCmds,
        objectRules: Object.fromEntries(this.objectPermissions),
      }],
      ['web', { enabled: this.webEnabled, allowedDomains: this.webAllowedDomains, deniedDomains: this.webDeniedDomains, privateHosts: this.webPrivateHosts }],
    ];
    for (const [section, values] of sections) {
      const error = await this.saveSection(section, values);
      if (error) {
        await this.rejectWith(`Could not save permissions: ${error}`);
        return;
      }
    }
    log.info('Permissions saved');
    this.windowEffect('flash');
    await this.setStatus('Permissions saved!');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Permission Prompt
  // ═══════════════════════════════════════════════════════════════════

  /** Active permission prompt: resolves when the person clicks, closes it, or a terminal answers. */
  private _pendingPermissionPrompt?: { resolve: (decision: string) => void };
  /** DialogBroker's id for the prompt on screen. */
  private _promptDialogId?: string;
  /** DialogBroker, which hands this window the permission prompts to draw. */
  private dialogBrokerId?: AbjectId;
  /** Settles once the prompt on screen has been taken down. */
  private _promptDone?: Promise<void>;
  private _promptWindowId?: AbjectId;
  /** Button widget -> the decision it stands for, for the active prompt. */
  private _promptButtons = new Map<AbjectId, string>();
  /** The self-measuring block holding the requested resource. */
  private _promptResourceBlockId?: AbjectId;
  /** The self-measuring block explaining the resource in everyday words. */
  private _promptSummaryBlockId?: AbjectId;
  private _promptResourceLayoutId?: AbjectId;
  private _promptRect?: { x: number; y: number; width: number; height: number };

  /**
   * Two decisions live in this dialog, and the layout says so: the top group
   * acts on the exact command line, the bottom group on the pair (object,
   * program) so an object that drives one tool is not re-asked per argument
   * list. The resource itself is a self-measuring block, because a command
   * line is any length and the old fixed-height label overlapped it. When the
   * question carries a summary (a command explained in everyday words), it
   * comes first, so the person reads what will happen before any shell.
   *
   * @param grant present when the caller resolved to a registered object.
   *        `canAllow` false means the line does not reduce to a program name
   *        (a shell line with metacharacters), so only the block half is
   *        offered.
   */
  private async presentPermission(opts: {
    /** DialogBroker's id for the question. */
    dialogId: string;
    title: string;
    description: string;
    /** The resource in everyday words; empty when there is none. */
    summary: string;
    resource: string;
    detail: string[];
    groups: Array<{ label: string; options: Array<{ id: string; label: string; tone?: string }> }>;
  }): Promise<void> {
    // The broker presents one at a time, so a second while one is up means the
    // broker restarted and the first question is gone: take it down first.
    if (this._pendingPermissionPrompt) this._pendingPermissionPrompt.resolve(DISMISSED);
    await this._promptDone;
    if (!this.widgetManagerId) return;
    this._promptDialogId = opts.dialogId;
    // Settled before the window is built, so an answer from a terminal that
    // arrives mid-build still takes the prompt down.
    const decided = new Promise<string>((resolve) => {
      this._pendingPermissionPrompt = { resolve };
    });
    let finished!: () => void;
    this._promptDone = new Promise<void>((resolve) => { finished = resolve; });

    const WIDTH = 620;
    const MARGIN = 16;
    const SPACING = 10;
    const HEADER_H = 20;
    const DETAIL_H = 15;
    const SECTION_H = 16;
    const ROW_H = 34;
    const RESOURCE_START_H = 22;
    const SUMMARY_START_H = 40;

    const groups = opts.groups.filter(g => g.options.length > 0);
    const summary = opts.summary.trim();

    try {
      // Only a starting size: the window has to exist before its children do.
      // Once every control is in the layout, `fitPromptToLayout` asks the
      // layout what it actually measures and corrects this. The children are
      // header + (summary block + its caption) + resource block + one label
      // per detail line + a caption and a button row per group, with SPACING
      // between each adjacent pair.
      const childCount = 2 + (summary ? 2 : 0) + opts.detail.length + groups.length * 2;
      const estimate = MARGIN * 2
        + HEADER_H + RESOURCE_START_H
        + (summary ? SUMMARY_START_H + SECTION_H : 0)
        + opts.detail.length * DETAIL_H
        + groups.length * (SECTION_H + ROW_H)
        + Math.max(0, childCount - 1) * SPACING;
      const rect = {
        x: 300, y: 180, width: WIDTH,
        height: TITLE_BAR_HEIGHT + estimate,
      };
      this._promptRect = rect;

      const windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createWindowAbject', {
          title: opts.title,
          rect,
          resizable: false,
          chromeless: false,
        })
      );
      this._promptWindowId = windowId;

      const layoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createVBox', {
          windowId,
          margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
          spacing: SPACING,
        })
      );

      // Who is asking, and for what.
      const { widgetIds: [descLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'label', windowId, text: opts.description,
            style: { color: this.theme.textPrimary, fontSize: 14 } },
        ]})
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: descLabelId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: HEADER_H },
      }));

      // What it will do, in everyday words, before the shell nobody but a
      // programmer can read. The LLM wrote it for PermissionBroker and decided
      // nothing; the caption says so and points at the command below it.
      if (summary) {
        const { widgetIds: [summaryId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId, 'create', { specs: [
            { type: 'contentBlock', windowId, text: summary,
              style: { color: this.theme.textPrimary, fontSize: 14, markdown: false } },
          ]})
        );
        this._promptSummaryBlockId = summaryId;
        await this.request(request(this.id, summaryId, 'addDependent', {}));
        await this.request(request(this.id, layoutId, 'addLayoutChild', {
          widgetId: summaryId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: SUMMARY_START_H },
        }));
        await this.promptSectionLabel(layoutId, windowId,
          'Explained by AI, which can be wrong. The exact command:', SECTION_H);
      }

      // The command line itself: wraps and reports its own height, so nothing
      // is clipped or overlapped however long it is.
      const { widgetIds: [resBlockId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'contentBlock', windowId, text: opts.resource,
            style: {
              color: this.theme.statusWarning, fontSize: 13,
              fontFamily: 'mono', markdown: false,
            } },
        ]})
      );
      this._promptResourceBlockId = resBlockId;
      this._promptResourceLayoutId = layoutId;
      await this.request(request(this.id, resBlockId, 'addDependent', {}));
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: resBlockId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: RESOURCE_START_H },
      }));

      // What the command actually does, and why this is being asked at all.
      // A wall of shell with no analysis is not a question anyone can answer.
      for (const line of opts.detail) {
        const { widgetIds: [detailId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId, 'create', { specs: [
            { type: 'label', windowId, text: line,
              style: { color: this.theme.textSecondary, fontSize: 11, fontFamily: 'mono' } },
          ]})
        );
        await this.request(request(this.id, layoutId, 'addLayoutChild', {
          widgetId: detailId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: DETAIL_H },
        }));
      }

      // Buttons, grouped narrowest scope first.
      this._promptButtons.clear();
      for (const group of groups) {
        await this.promptSectionLabel(layoutId, windowId, group.label, SECTION_H);
        const rowId = await this.promptButtonRow(layoutId, windowId, ROW_H);
        const specs = group.options.map(o => ({
          type: 'button', windowId, text: o.label,
          style: {
            fontSize: 12,
            ...(o.tone === 'good' ? { color: this.theme.statusSuccess }
              : o.tone === 'bad' ? { color: this.theme.statusError } : {}),
          },
        }));
        const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId, 'create', { specs })
        );
        for (let i = 0; i < widgetIds.length; i++) {
          this._promptButtons.set(widgetIds[i], group.options[i].id);
          await this.promptAddButton(rowId, widgetIds[i], ROW_H);
        }
      }

      // Every control is in the layout now, so let the layout say how tall the
      // window must be.
      await this.fitPromptToLayout();

      // A question that blocks work owns the desktop until it is answered:
      // every other window recedes, and the prompt pulses once for attention.
      await this.setPromptModal(windowId, true);
      this.windowEffect('pulse', undefined, windowId);

      // The broker holds the question open, heartbeats for the asker, and
      // takes a terminal's answer too; this window waits only for its click.
      const decision = await decided;
      if (decision !== DISMISSED) await this.reportPermission(opts.dialogId, decision);
    } finally {
      // Clean up prompt window
      this._pendingPermissionPrompt = undefined;
      this._promptDialogId = undefined;
      this._promptButtons.clear();
      await this.setPromptModal(this._promptWindowId, false);
      if (this._promptWindowId && this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', {
            windowId: this._promptWindowId,
          }));
        } catch { /* best effort */ }
      }
      this._promptWindowId = undefined;
      this._promptResourceBlockId = undefined;
      this._promptSummaryBlockId = undefined;
      this._promptResourceLayoutId = undefined;
      this._promptRect = undefined;
      finished();
    }
  }

  /** Tell DialogBroker what the person clicked. */
  private async reportPermission(dialogId: string, decision: string): Promise<void> {
    if (!this.dialogBrokerId) return;
    const answer = decision === DECLINED ? { confirmed: false } : { confirmed: true, option: decision };
    try {
      await this.request(request(this.id, this.dialogBrokerId, 'respond', { dialogId, ...answer }));
    } catch (err) {
      log.warn(`could not report the permission answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Accept presentDialog/dismissDialog only from DialogBroker itself. */
  private async fromDialogBroker(m: AbjectMessage): Promise<boolean> {
    this.dialogBrokerId = await this.resolveDep('DialogBroker', this.dialogBrokerId);
    return !!this.dialogBrokerId && m.routing.from === this.dialogBrokerId;
  }

  /** Small caption introducing a group of prompt buttons. */
  private async promptSectionLabel(
    layoutId: AbjectId, windowId: AbjectId, text: string, height: number,
  ): Promise<void> {
    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId, text,
          style: { color: this.theme.textTertiary, fontSize: 11 } },
      ]})
    );
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height },
    }));
  }

  private async promptButtonRow(
    layoutId: AbjectId, windowId: AbjectId, height: number,
  ): Promise<AbjectId> {
    const rowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createHBox', {
        windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId: rowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height },
    }));
    return rowId;
  }

  private async promptAddButton(rowId: AbjectId, btnId: AbjectId, height: number): Promise<void> {
    await this.request(request(this.id, btnId, 'addDependent', {}));
    await this.request(request(this.id, rowId, 'addLayoutChild', {
      widgetId: btnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: height - 4 },
    }));
  }

  /**
   * Size the prompt window to what its layout actually measures.
   *
   * The layout is the only authority on this: it knows every child's preferred
   * height and that it inserts `spacing` between each adjacent pair, and it
   * allocates from exactly that number. Re-deriving the height here from the
   * constants handed to the layout is what clipped the dialog — the old sum
   * charged DETAIL_H + 2 per detail line where the layout spends
   * DETAIL_H + SPACING, so the window came up 8px short per detail row and the
   * deficit ate the bottom margin and sliced the last button in half. Asking
   * keeps the dialog correct as the content varies: long commands, more detail
   * rows, extra scope buttons.
   *
   * A non-chromeless window gives its root layout `height - TITLE_BAR_HEIGHT`,
   * so the title bar goes back on top of the layout's own height.
   */
  private async fitPromptToLayout(): Promise<void> {
    const layoutId = this._promptResourceLayoutId;
    if (!this._promptWindowId || !layoutId || !this._promptRect) return;

    const contentHeight = await this.request<number>(
      request(this.id, layoutId, 'getPreferredHeight', {})
    ).catch(() => undefined);
    if (typeof contentHeight !== 'number' || contentHeight <= 0) return;

    const windowHeight = TITLE_BAR_HEIGHT + Math.ceil(contentHeight);
    if (windowHeight === this._promptRect.height) return;
    this._promptRect = { ...this._promptRect, height: windowHeight };
    await this.request(request(this.id, this._promptWindowId, 'windowRect', this._promptRect))
      .catch(() => { /* window gone */ });
  }

  /**
   * Grow the open prompt to fit a wrapped block it is showing (the command
   * line, or its explanation). The block measures itself once the layout
   * settles; the layout absorbs the new height and the window follows it.
   */
  private async resizePromptBlock(blockId: AbjectId, contentHeight: number): Promise<void> {
    if (!this._promptWindowId || !this._promptRect) return;
    const height = Math.min(Math.max(Math.ceil(contentHeight), 22), 260);

    const layoutId = this._promptResourceLayoutId;
    if (layoutId) {
      await this.request(request(this.id, layoutId, 'updateLayoutChild', {
        widgetId: blockId,
        preferredSize: { height },
      })).catch(() => { /* widget gone */ });
    }
    await this.fitPromptToLayout();
  }

  /**
   * Record that a named object may (or may not) run a command with any
   * arguments, persist it, and push it to ShellExecutor. The two rules are
   * exclusive: granting clears a block on the same pair and vice versa.
   */
  private async setObjectCommandRule(
    objectName: string, commandName: string, rule: 'allow' | 'deny',
  ): Promise<void> {
    this.lastOwnSave = { section: 'shell', at: Date.now() };
    try {
      await this.request(request(this.id, this.settingsManagerId!, 'setObjectCommandRule', { objectName, commandName, rule }));
    } catch (err) {
      log.warn(`Could not record the ${rule} rule for ${objectName}: ${settingsError(err)}`);
      return;
    }
    // Keep an open form in step, leaving its other unsaved edits alone.
    const record = this.objectPermissions.get(objectName) ?? { allow: [], deny: [] };
    const [into, outOf] = rule === 'allow' ? ['allow', 'deny'] as const : ['deny', 'allow'] as const;
    if (!record[into].includes(commandName)) record[into].push(commandName);
    record[outOf] = record[outOf].filter((c) => c !== commandName);
    this.objectPermissions.set(objectName, record);
    await this.refreshObjectPermLists();
  }

  /** Add a hand-typed "ObjectName: command" rule from a list editor's input. */
  private async addObjectPermEntry(
    kind: 'allow' | 'deny', inputId: AbjectId, listId: AbjectId,
  ): Promise<void> {
    const val = await this.request<string>(request(this.id, inputId, 'getValue', {}));
    const parsed = parseObjectPermEntry(val ?? '');
    if (!parsed) {
      await this.rejectWith('Use the form "ObjectName: command"', this.theme.statusWarning);
      return;
    }
    const record = this.objectPermissions.get(parsed.objectName) ?? { allow: [], deny: [] };
    const other = kind === 'allow' ? 'deny' : 'allow';
    if (!record[kind].includes(parsed.commandName)) record[kind].push(parsed.commandName);
    record[other] = record[other].filter((c) => c !== parsed.commandName);
    this.objectPermissions.set(parsed.objectName, record);
    await this.refreshObjectPermLists();
    await this.updateStringList(listId, this.objectPermEntries(kind));
    await this.request(request(this.id, inputId, 'update', { text: '' }));
    this.windowEffect('flash', '$accent');
  }

  private async removeObjectPermEntry(kind: 'allow' | 'deny', listId: AbjectId): Promise<void> {
    const sel = await this.request<string | null>(request(this.id, listId, 'getValue', {}));
    const parsed = sel ? parseObjectPermEntry(sel) : undefined;
    if (!parsed) return;
    const record = this.objectPermissions.get(parsed.objectName);
    if (!record) return;
    record[kind] = record[kind].filter((c) => c !== parsed.commandName);
    if (record.allow.length === 0 && record.deny.length === 0) {
      this.objectPermissions.delete(parsed.objectName);
    }
    await this.updateStringList(listId, this.objectPermEntries(kind));
  }

  /** Repaint the settings list editors, if the settings window is open. */
  private async refreshObjectPermLists(): Promise<void> {
    for (const [listId, kind] of [
      [this.objectPermListId, 'allow'] as const,
      [this.objectDenyListId, 'deny'] as const,
    ]) {
      if (!listId) continue;
      try {
        await this.updateStringList(listId, this.objectPermEntries(kind));
      } catch { /* settings window not open */ }
    }
  }

  /** Flat "Name: command" view of one rule direction, for the list editors. */
  private objectPermEntries(kind: 'allow' | 'deny'): string[] {
    const entries: string[] = [];
    for (const [objectName, record] of this.objectPermissions) {
      for (const cmd of record[kind]) entries.push(`${objectName}: ${cmd}`);
    }
    return entries.sort();
  }

  /**
   * Summarise what is currently allowed to run unattended, so the Permissions
   * tab answers "is anything happening without me?" without a hunt.
   */
  private async refreshAutonomyStatus(): Promise<void> {
    if (!this.autonomyStatusId) return;
    let text = 'No permission broker is running; every command prompts.';
    try {
      const brokerId = await this.discoverDep('PermissionBroker');
      if (brokerId) {
        const rules = await this.request<Array<{ allow: boolean }>>(
          request(this.id, brokerId, 'listRules', {}), 10_000);
        const decisions = await this.request<Array<{ asked: boolean }>>(
          request(this.id, brokerId, 'listDecisions', { limit: 200 }), 10_000);
        const auto = decisions.filter(d => !d.asked).length;
        const allows = rules.filter(r => r.allow).length;
        text = `${allows} standing allow rule${allows === 1 ? '' : 's'}. `
          + `${auto} of the last ${decisions.length} decision${decisions.length === 1 ? '' : 's'} ran without asking.`;
      }
    } catch { /* leave the default text */ }
    try {
      await this.request(request(this.id, this.autonomyStatusId, 'update', { text }));
    } catch { /* widget may be gone */ }
  }

  /** Drop every project back to asking, and clear the standing allow rules. */
  private async takeTheWheel(): Promise<void> {
    const brokerId = await this.discoverDep('PermissionBroker');
    if (!brokerId) { await this.rejectWith('No permission broker is running'); return; }
    const ok = await this.confirm({
      title: 'Take the wheel?',
      message:
        'Every external project drops back to "ask", grants made for a running task are dropped, '
        + 'and standing allow rules are removed. Blocks you have set are kept.',
      confirmLabel: 'Take the wheel',
    });
    if (!ok) return;
    try {
      const r = await this.request<{ projectsReset: number; rulesCleared: number }>(
        request(this.id, brokerId, 'takeTheWheel', {}), 60_000);
      this.windowEffect('flash');
      await this.setStatus(`${r.projectsReset} project(s) back to ask, ${r.rulesCleared} allow rule(s) cleared`);
    } catch (err) {
      await this.rejectWith(`Could not reset: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refreshAutonomyStatus();
  }

  // ========== API KEYS ACTIONS ==========

}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
