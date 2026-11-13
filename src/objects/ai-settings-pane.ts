/**
 * AiSettingsPane: the AI tab of the Settings window.
 *
 * A view over SettingsManager, drawn inside GlobalSettings' window. A status
 * line (whether an AI is connected) and Undo stay on top; under them are
 * three sub-tabs. Providers: where the models come from and what each
 * provider needs. Models: the presets, then the model behind each tier, so
 * applying a preset shows the tiers change beneath it. Advanced: the
 * less-used rows (image model, backup model, decision model, cache
 * keepalive, learning budget). The tab opens on Providers until a tier is
 * set, and on Models after that.
 *
 * There is no Save button. Every control writes its one change through
 * SettingsManager as it is made, and Undo takes the last one back. A key is
 * checked with its provider before it is saved, a preset says what it still
 * needs before it is applied, and having no provider at all is a state the
 * tab shows, with the way out of it, instead of an error.
 *
 * This is a part of GlobalSettings, not an Abject: the widgets belong to
 * GlobalSettings' window and report to it, and it hands their events here
 * (handleEvent). Everything the pane does reaches other objects as messages
 * sent through the host.
 */

import { AbjectId } from '../core/types.js';
import { Log } from '../core/timed-log.js';
import { require as contractRequire } from '../core/contracts.js';
import type { ThemeData } from '../core/theme-data.js';
import type { UndoResult } from '../core/undo.js';
import type { DecisionGates } from '../core/decision-sites.js';
import { LLMProviderDescription, servesChat } from '../llm/provider.js';
import { LATEST_MODEL, hasTierRules, resolveTier } from '../llm/tier-resolver.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';
import { hintStyle } from './ui-kit.js';
import {
  AUX_ROW_KEYS, TIER_LABELS, TIER_NAMES,
  type AiSettings, type AuxRowKey, type ConnectResult, type ModelInfo, type ModelRef, type ModelTierName,
  type PresetListing, type ProviderStatus, type SlotKey, type TierRoute,
} from './settings-manager.js';

const log = new Log('AiSettingsPane');

/** What the pane needs from the window it is drawn in. */
export interface AiPaneHost {
  readonly widgetManagerId: AbjectId;
  readonly settingsManagerId: AbjectId;
  readonly llmId: AbjectId;
  theme(): ThemeData;
  /** Send a request to another object and wait for its reply. */
  ask<T>(to: AbjectId, method: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  /** The status line at the foot of the window. */
  status(text: string, color?: string): Promise<void>;
  /** A refusal: the status line plus a shake. */
  reject(text: string, color?: string): Promise<void>;
  /** The window lights up: a change took. */
  flash(): void;
  /** A change this window is making will come back as a settingsChanged event that needs no repaint. */
  ownChange(section: 'ai' | 'presets'): void;
  /** Take back this window's last settings change. */
  undo(): Promise<UndoResult>;
}

/** A SettingsManager refusal as a sentence: the contract prefix dropped. */
export function settingsError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^.*\[(REQUIRE|ENSURE|INVARIANT)\]\s*/, '').slice(0, 200);
}

/** The value a select reports for its empty choice (Not set, None, Auto). */
const NONE = '';
/** 'Default' = no effort override (the provider's own default for the tier). */
const EFFORT_DEFAULT = 'Default';
const NO_EFFORT = '—';
/** What the window's margins, a card's padding and the scrollbar take from the window's width. */
const CARD_CHROME_WIDTH = 100;
const ROW_HEIGHT = 32;
const BUTTON_WIDTH = 96;
/** Provider and preset rows shown before "Show more". */
const PROVIDERS_SHOWN = 5;
const PRESETS_SHOWN = 4;

const TIER_HINTS: Record<ModelTierName, string> = {
  smart: 'planning and hard problems', balanced: 'everyday work', fast: 'quick replies and summaries', code: 'writing code',
};
const SLOT_LABELS: Record<SlotKey, string> = { ...TIER_LABELS, vision: 'Image model', fallback: 'Backup model', decision: 'Decision model' };
const AUX_HINTS: Record<AuxRowKey, string> = {
  vision: 'Reads screenshots and pasted images when a tier\'s own model is text-only.',
  fallback: 'Stands in for any tier whose own model fails.',
  decision: 'Answers yes/no and pick-one questions. Auto uses a keyed decision provider, else the Fast tier.',
};
const DECISION_GATE_OPTIONS: Array<{ value: DecisionGates; label: string }> = [
  { value: 'on', label: 'On (decision sites advise and act live)' },
  { value: 'off', label: 'Off (built-in decision sites do not run)' },
];

/** "A", "A and B", "A, B and C". */
function listed(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sub-tabs, in tab-bar order. */
const SUB_TABS = ['providers', 'models', 'advanced'] as const;
type SubTab = typeof SUB_TABS[number];
const SUB_TAB_LABELS: Record<SubTab, string> = { providers: 'Providers', models: 'Models', advanced: 'Advanced' };

type Action =
  | { kind: 'toggleProvider' | 'connect' | 'connectUnchecked' | 'use' | 'disconnect' | 'link' | 'presetConnect'; provider: string }
  | { kind: 'showKey' }
  | { kind: 'check' | 'moreProviders' | 'morePresets' | 'savePreset' | 'undo' | 'setBudget' }
  | { kind: 'applyPreset' | 'applyReady' | 'togglePreset' | 'deletePreset'; preset: string };

/** Something to say under an open provider row or preset panel. */
interface Note { where: 'provider' | 'preset'; provider: string; text: string; color: string; allowUnchecked?: boolean }

type SelectOption = { label: string; value: string };

export class AiSettingsPane {
  private windowId?: AbjectId;
  private containerId?: AbjectId;
  /** Width a wrapped line has inside a card, for sizing labels. */
  private textWidth = 440;
  /** Width of the name column in provider rows: wide enough for the longest name where there is room. */
  private nameWidth = 150;

  // What SettingsManager and the LLM object last said
  private ai?: AiSettings;
  private providers: ProviderStatus[] = [];
  private presets: PresetListing[] = [];
  private presetsLoaded = false;
  private descriptions: LLMProviderDescription[] = [];
  private descById = new Map<string, LLMProviderDescription>();
  /** Model lists by provider: each description's own list until the live one arrives. */
  private models = new Map<string, ModelInfo[]>();
  private liveModels = new Set<string>();
  private modelFetches = new Set<string>();

  // What the person has open
  private openProvider?: string;
  private showAllProviders = false;
  private openPreset?: string;
  private showAllPresets = false;
  /** The sub-tab on show; chosen when the window opens. */
  private subTab: SubTab = 'providers';
  private note?: Note;
  /** Keys typed but not yet connected, so a repaint keeps them. */
  private drafts = new Map<string, string>();

  // Widgets
  private statusLabelId?: AbjectId;
  private subTabBarId?: AbjectId;
  /** Each sub-tab's scrolling page. */
  private pages: Partial<Record<SubTab, AbjectId>> = {};
  private providersBoxId?: AbjectId;
  private presetsBoxId?: AbjectId;
  private pendingBoxId?: AbjectId;
  private advancedBoxId?: AbjectId;
  private providerInputId?: AbjectId;
  /** The Show/Hide button beside an open provider's key, and whether the key is in the clear. */
  private keyToggleId?: AbjectId;
  private keyShown = false;
  private presetInputs = new Map<string, AbjectId>();
  private presetNameInputId?: AbjectId;
  private budgetInputId?: AbjectId;
  private budgetHintId?: AbjectId;
  private keepaliveId?: AbjectId;
  private gatesSelectId?: AbjectId;
  private tierRows: Partial<Record<ModelTierName, { provider: AbjectId; model: AbjectId; effort: AbjectId; cap: AbjectId }>> = {};
  private auxRows: Partial<Record<AuxRowKey, { provider: AbjectId; model: AbjectId; cap: AbjectId }>> = {};
  /** Buttons and submit-on-Enter inputs, by the region that owns them (a region's entries go when it is repainted). */
  private actions: Record<'fixed' | 'providers' | 'presets' | 'advanced', Map<AbjectId, Action>> = {
    fixed: new Map(), providers: new Map(), presets: new Map(), advanced: new Map(),
  };
  /** What each rebuilt region last showed: an unchanged region is left alone, so typing in it survives. */
  private painted: Record<'providers' | 'presets' | 'advanced' | 'pending', string> = { providers: '', presets: '', advanced: '', pending: '' };

  /** Repaints and actions run one at a time: two rebuilds of one region would interleave their rows. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: AiPaneHost) {}

  // ===========================================================================
  // Life cycle
  // ===========================================================================

  /** Build the tab into its container. Returns once the tab shows what is already known; the rest follows. */
  async build(windowId: AbjectId, containerId: AbjectId, windowWidth: number): Promise<void> {
    contractRequire(this.windowId === undefined, 'AiSettingsPane: built once per window');
    contractRequire(windowWidth > CARD_CHROME_WIDTH, 'AiSettingsPane: the window has room for a card');
    this.windowId = windowId;
    this.containerId = containerId;
    this.textWidth = windowWidth - CARD_CHROME_WIDTH;
    this.nameWidth = windowWidth >= 680 ? 240 : 150;
    await this.serial(async () => {
      await this.loadDescriptions();
      [this.ai, this.providers] = await Promise.all([
        this.manager<AiSettings>('getSettings', { section: 'ai', reveal: true }),
        this.manager<ProviderStatus[]>('listProviders', {}),
      ]);
      // Nothing routed yet: the first thing to do is connect a provider.
      this.subTab = TIER_NAMES.some(t => this.ai?.tiers[t]) ? 'models' : 'providers';
      await this.buildSkeleton();
      await this.paint();
    });
    // Looking at CLIs and local servers takes a moment: the window is up meanwhile.
    void this.reload();
  }

  /** The window closed: forget its widgets. */
  reset(): void {
    this.windowId = undefined;
    this.containerId = undefined;
    this.statusLabelId = this.subTabBarId = this.providersBoxId = this.presetsBoxId = this.pendingBoxId = undefined;
    this.advancedBoxId = this.providerInputId = this.keyToggleId = this.presetNameInputId = undefined;
    this.keyShown = false;
    this.pages = {};
    this.budgetInputId = this.budgetHintId = this.keepaliveId = this.gatesSelectId = undefined;
    this.presetInputs.clear();
    this.tierRows = {};
    this.auxRows = {};
    for (const region of Object.values(this.actions)) region.clear();
    this.painted = { providers: '', presets: '', advanced: '', pending: '' };
    this.openProvider = this.openPreset = this.note = undefined;
    this.drafts.clear();
    this.presetsLoaded = false;
  }

  /** Settings or the provider list changed elsewhere: fetch again and repaint. */
  async reload(providersChanged = false): Promise<void> {
    try {
      await this.serial(async () => {
        if (providersChanged) await this.loadDescriptions();
        await this.refresh();
      });
    } catch (err) {
      log.warn(`AI tab reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A widget event from the window. True when the widget is the pane's (the
   * event is handled, or deliberately ignored).
   */
  async handleEvent(fromId: AbjectId, aspect: string, value: unknown): Promise<boolean> {
    if (!this.windowId) return false;
    if (aspect === 'click' || aspect === 'submit') {
      const action = Object.values(this.actions).map(region => region.get(fromId)).find(Boolean);
      if (action) {
        await this.serial(() => this.run(action));
        return true;
      }
    }
    if (fromId === this.subTabBarId) {
      if (aspect === 'change') await this.serial(() => this.showSubTab(SUB_TABS[Number(value)] ?? 'providers'));
      return true;
    }
    if (aspect === 'change') {
      const text = typeof value === 'string' ? value : String(value ?? '');
      for (const tier of TIER_NAMES) {
        const row = this.tierRows[tier];
        if (!row) continue;
        if (fromId === row.provider) { await this.serial(() => this.onTierProvider(tier, text)); return true; }
        if (fromId === row.model) { await this.serial(() => this.onTierModel(tier, text)); return true; }
        if (fromId === row.effort) { await this.serial(() => this.onTierEffort(tier, text)); return true; }
      }
      for (const key of AUX_ROW_KEYS) {
        const row = this.auxRows[key];
        if (!row) continue;
        if (fromId === row.provider) { await this.serial(() => this.onAuxProvider(key, text)); return true; }
        if (fromId === row.model) { await this.serial(() => this.onAuxModel(key, text)); return true; }
      }
      if (fromId === this.gatesSelectId) {
        await this.serial(() => this.write({ decisionGates: text === 'off' ? 'off' : 'on' }, 'Decision gates changed.'));
        return true;
      }
      if (fromId === this.keepaliveId) {
        const on = value === true || value === 'true';
        await this.serial(() => this.write({ cacheKeepalive: on }, on ? 'Prompt caches are kept warm.' : 'Cache keepalive is off.'));
        return true;
      }
      if (fromId === this.budgetInputId) {
        if (this.budgetHintId) await this.update(this.budgetHintId, { text: this.budgetHint(this.parseBudget(text)) });
        return true;
      }
      // Typing in a key or name field: nothing to do until Connect or Enter.
      if (fromId === this.providerInputId || fromId === this.presetNameInputId
          || [...this.presetInputs.values()].includes(fromId)) return true;
    }
    return false;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ===========================================================================
  // Talking to other objects
  // ===========================================================================

  private manager<T>(method: string, payload: unknown = {}, timeoutMs = 60_000): Promise<T> {
    return this.host.ask<T>(this.host.settingsManagerId, method, payload, timeoutMs);
  }

  private widgets<T>(method: string, payload: unknown): Promise<T> {
    return this.host.ask<T>(this.host.widgetManagerId, method, payload);
  }

  private async update(widgetId: AbjectId, payload: Record<string, unknown>): Promise<void> {
    try { await this.host.ask(widgetId, 'update', payload); } catch { /* widget gone */ }
  }

  private async loadDescriptions(): Promise<void> {
    try {
      this.descriptions = await this.host.ask<LLMProviderDescription[]>(this.host.llmId, 'listProviderDescriptions', {});
    } catch (err) {
      log.warn(`Could not load provider descriptions: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.descById = new Map(this.descriptions.map(d => [d.id, d]));
    for (const desc of this.descriptions) {
      if (!this.liveModels.has(desc.id)) this.models.set(desc.id, [...desc.models] as ModelInfo[]);
    }
  }

  /** Fetch what SettingsManager holds and repaint what changed. */
  private async refresh(): Promise<void> {
    const windowId = this.windowId;
    if (!windowId) return;
    // Presets first: listing them looks at every provider, so the provider
    // states read next are the ones the presets were judged by.
    const presets = await this.manager<PresetListing[]>('listPresets', {}, 90_000);
    const providers = await this.manager<ProviderStatus[]>('listProviders', { probe: true }, 90_000);
    const ai = await this.manager<AiSettings>('getSettings', { section: 'ai', reveal: true });
    if (this.windowId !== windowId) return;
    this.presets = presets;
    this.presetsLoaded = true;
    this.providers = providers;
    this.ai = ai;
    await this.paint();
    for (const p of this.providers) if (p.state === 'connected') void this.fetchModels(p.id);
  }

  /** Change AI settings. Returns whether SettingsManager took the change. */
  private async write(values: Record<string, unknown>, done?: string): Promise<boolean> {
    this.host.ownChange('ai');
    try {
      await this.manager('setSettings', { section: 'ai', values });
    } catch (err) {
      await this.refresh();
      await this.host.reject(settingsError(err));
      return false;
    }
    this.host.ownChange('ai');
    await this.refresh();
    if (done) await this.host.status(done, this.host.theme().statusSuccess);
    return true;
  }

  // ===========================================================================
  // Model lists
  // ===========================================================================

  /** Fetch one connected provider's live model list, once, and repaint the rows that list it. */
  private async fetchModels(provider: string, force = false): Promise<void> {
    if (this.modelFetches.has(provider) || (!force && this.liveModels.has(provider))) return;
    const desc = this.descById.get(provider);
    if (!desc) return;
    this.modelFetches.add(provider);
    try {
      const payload: Record<string, unknown> = { provider };
      if (desc.credentialMode === 'url') payload.ollamaUrl = this.ai?.credentials[provider]?.value || desc.credentialPlaceholder || '';
      const models = await this.host.ask<ModelInfo[]>(this.host.llmId, 'listProviderModels', payload);
      if (models.length === 0) return;
      this.models.set(provider, models);
      this.liveModels.add(provider);
      await this.serial(async () => {
        if (!this.windowId) return;
        await this.syncTiers();
        await this.paintAdvanced();
        await this.paintPresets();
      });
    } catch (err) {
      log.warn(`Live model list for ${provider} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.modelFetches.delete(provider);
    }
  }

  /**
   * A tier's model choices on one provider: "Latest (…)" first when the
   * provider can recommend the tier from its catalog (saved as `latest`, so
   * it follows new releases), then the catalog.
   */
  private tierModels(provider: string, tier: ModelTierName): ModelInfo[] {
    const list = this.models.get(provider) ?? [];
    const desc = this.descById.get(provider);
    if (!desc || list.length === 0 || !hasTierRules(desc, tier)) return list;
    const recommended = resolveTier(desc, list, tier).model;
    const info = list.find(m => m.id === recommended);
    return [{ ...(info ?? { id: recommended, name: recommended }), id: LATEST_MODEL, name: `Latest (${info?.name ?? recommended})` }, ...list];
  }

  /** A single-model row's choices: the Decision row lists decision models ahead of chat models. */
  private auxModels(key: AuxRowKey, provider: string): ModelInfo[] {
    const chat = this.models.get(provider) ?? [];
    if (key !== 'decision') return chat;
    const desc = this.descById.get(provider);
    const decision = (desc?.decisionModels ?? []) as ModelInfo[];
    const seen = new Set(decision.map(m => m.id));
    return [...decision, ...(desc && servesChat(desc) ? chat.filter(m => !seen.has(m.id)) : [])];
  }

  /**
   * A list that still holds the saved model. Until a provider's live catalog
   * arrives the list is its short built-in one, and a dropdown that cannot
   * find the saved model would show another in its place.
   */
  private withSaved(list: ModelInfo[], saved: string | null | undefined): ModelInfo[] {
    if (!saved || list.some(m => m.id === saved)) return list;
    return [{ id: saved, name: saved === LATEST_MODEL ? 'Latest' : saved }, ...list];
  }

  private modelName(provider: string, model: string): string {
    if (model === LATEST_MODEL) return 'Latest';
    return (this.models.get(provider) ?? []).find(m => m.id === model)?.name ?? model;
  }

  private providerLabel(id: string): string {
    return this.providers.find(p => p.id === id)?.label ?? this.descById.get(id)?.label ?? id;
  }

  private routeText(route: ModelRef | null | undefined): string {
    return route ? `${this.providerLabel(route.provider)} · ${this.modelName(route.provider, route.model)}` : 'not set';
  }

  private isReady(provider: string): boolean {
    return this.providers.find(p => p.id === provider)?.state === 'connected';
  }

  private capability(info: ModelInfo | undefined): { text: string; color: string } {
    const theme = this.host.theme();
    if (info?.vision === true) return { text: '◉ vision', color: theme.statusSuccess };
    if (info?.vision === false) return { text: 'text-only', color: theme.textTertiary };
    return { text: '', color: theme.textTertiary };
  }

  // ===========================================================================
  // Building blocks
  // ===========================================================================

  private async make(specs: Array<Record<string, unknown>>): Promise<AbjectId[]> {
    const { widgetIds } = await this.widgets<{ widgetIds: AbjectId[] }>('create', {
      specs: specs.map(spec => ({ windowId: this.windowId, ...spec })),
    });
    return widgetIds;
  }

  private async listen(...ids: AbjectId[]): Promise<void> {
    for (const id of ids) await this.host.ask(id, 'addDependent', {});
  }

  /** A fixed-height row in a vertical layout. */
  private async row(parent: AbjectId, height = ROW_HEIGHT): Promise<AbjectId> {
    const rowId = await this.widgets<AbjectId>('createNestedHBox', {
      parentLayoutId: parent, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8,
    });
    await this.host.ask(parent, 'addLayoutChild', {
      widgetId: rowId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height },
    });
    return rowId;
  }

  /** Lay widgets out left to right in a row: a width fixes one, none lets it stretch. */
  private async place(rowId: AbjectId, cells: Array<{ id: AbjectId; width?: number }>, height = ROW_HEIGHT): Promise<void> {
    await this.host.ask(rowId, 'addLayoutChildren', {
      children: cells.map(cell => cell.width === undefined
        ? { widgetId: cell.id, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height } }
        : { widgetId: cell.id, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: cell.width, height } }),
    });
  }

  /** A wrapped line of text in a vertical layout, as tall as its text. */
  private async text(parent: AbjectId, text: string, color: string, fontSize = 12, indent = 0): Promise<AbjectId> {
    const lines = estimateWrappedLineCount(text, this.textWidth - indent, fontSize);
    const [labelId] = await this.make([{ type: 'label', text, style: { color, fontSize, wordWrap: true } }]);
    await this.host.ask(parent, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: lines * Math.round(fontSize * 1.35) + 2 },
    });
    return labelId;
  }

  /** A section card with a body that is rebuilt and sizes itself to what it holds. */
  private async card(page: SubTab, title: string, hint: string): Promise<{ cardId: AbjectId; bodyId: AbjectId }> {
    const lines = estimateWrappedLineCount(hint, this.textWidth, 12);
    const { sectionId } = await this.widgets<{ sectionId: AbjectId }>('createSection', {
      parentLayoutId: this.pages[page], windowId: this.windowId, title, description: hint, hintHeight: lines * 16 + 2,
    });
    const bodyId = await this.body(sectionId);
    return { cardId: sectionId, bodyId };
  }

  private async body(parent: AbjectId): Promise<AbjectId> {
    const bodyId = await this.widgets<AbjectId>('createNestedVBox', {
      parentLayoutId: parent, autoSize: true, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 6,
    });
    await this.host.ask(parent, 'addLayoutChild', {
      widgetId: bodyId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' }, preferredSize: { height: 0 },
    });
    return bodyId;
  }

  private actionStyle(): Record<string, unknown> {
    const theme = this.host.theme();
    return { background: theme.actionBg, color: theme.actionText, borderColor: theme.actionBorder, fontSize: 12 };
  }

  // ===========================================================================
  // The tab
  // ===========================================================================

  private async buildSkeleton(): Promise<void> {
    const theme = this.host.theme();
    const container = this.containerId!;

    // Whether an AI is connected, and Undo
    const statusRow = await this.row(container, 38);
    const [statusLabelId, undoId] = await this.make([
      { type: 'label', text: '', style: { color: theme.textHeading, fontSize: 13, wordWrap: true } },
      { type: 'button', text: 'Undo', style: { fontSize: 12 } },
    ]);
    this.statusLabelId = statusLabelId;
    this.actions.fixed.set(undoId, { kind: 'undo' });
    await this.listen(undoId);
    await this.place(statusRow, [{ id: statusLabelId }, { id: undoId, width: 72 }], 38);

    // Sub-tabs: one scrolling page each, one on show
    const [subTabBarId] = await this.make([{
      type: 'tabBar', tabs: SUB_TABS.map(tab => SUB_TAB_LABELS[tab]), closable: false, selectedIndex: SUB_TABS.indexOf(this.subTab),
    }]);
    this.subTabBarId = subTabBarId;
    await this.listen(subTabBarId);
    await this.host.ask(container, 'addLayoutChild', {
      widgetId: subTabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 34 },
    });
    for (const tab of SUB_TABS) {
      const pageId = await this.widgets<AbjectId>('createNestedScrollableVBox', {
        parentLayoutId: container, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8,
      });
      await this.host.ask(container, 'addLayoutChild', {
        widgetId: pageId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      });
      await this.update(pageId, { style: { visible: tab === this.subTab } });
      this.pages[tab] = pageId;
    }

    this.providersBoxId = (await this.card('providers', 'Providers',
      'Where the models come from. Connect one and the tiers under Models fill themselves in. Add more to mix them.')).bodyId;
    this.presetsBoxId = (await this.card('models', 'Presets',
      'One click sets every tier below. A preset that needs a provider you have not connected says so, and helps you connect it.')).bodyId;

    // Models: one row per tier, built once and repointed as settings change
    const models = await this.card('models', 'Models',
      `Fine-tune one tier at a time. ${TIER_NAMES.map(t => `${TIER_LABELS[t]}: ${TIER_HINTS[t]}`).join('. ')}. Changes save as you make them.`);
    const captionRow = await this.row(models.bodyId, 16);
    const captions: Array<[string, number | undefined]> = [['TIER', 70], ['PROVIDER', 170], ['MODEL', undefined], ['REASONING', 92], ['SEES', 62]];
    const captionIds = await this.make(captions.map(([text]) => (
      { type: 'label', text, style: { color: theme.textMeta, fontSize: 11, fontFamily: 'display' } })));
    await this.place(captionRow, captions.map(([, width], i) => ({ id: captionIds[i], width })), 16);
    for (const tier of TIER_NAMES) {
      const rowId = await this.row(models.bodyId);
      const [labelId, providerId, modelId, effortId, capId] = await this.make([
        { type: 'label', text: TIER_LABELS[tier], style: { color: theme.textHeading, fontSize: 13 } },
        { type: 'select', options: [{ label: '', value: NONE }], selectedIndex: 0 },
        { type: 'select', options: [{ label: '', value: NONE }], selectedIndex: 0 },
        { type: 'select', options: [NO_EFFORT], selectedIndex: 0, style: { disabled: true } },
        { type: 'label', text: '', style: { color: theme.textTertiary, fontSize: 11 } },
      ]);
      this.tierRows[tier] = { provider: providerId, model: modelId, effort: effortId, cap: capId };
      await this.listen(providerId, modelId, effortId);
      await this.place(rowId, [{ id: labelId, width: 70 }, { id: providerId, width: 170 }, { id: modelId }, { id: effortId, width: 92 }, { id: capId, width: 62 }]);
    }
    this.pendingBoxId = await this.body(models.bodyId);

    // Advanced: its rows are built the first time the sub-tab is shown
    this.advancedBoxId = (await this.card('advanced', 'Advanced',
      'Image model, backup model, decision model, cache keepalive and the learning budget. The defaults suit most setups.')).bodyId;
  }

  /** Put one sub-tab on show. */
  private async showSubTab(tab: SubTab): Promise<void> {
    this.subTab = tab;
    for (const other of SUB_TABS) {
      const pageId = this.pages[other];
      if (pageId) await this.update(pageId, { style: { visible: other === tab } });
    }
    if (this.subTabBarId) await this.update(this.subTabBarId, { selectedIndex: SUB_TABS.indexOf(tab) });
    await this.paintAdvanced();
  }

  private async paint(): Promise<void> {
    if (!this.windowId || !this.ai) return;
    await this.paintStatus();
    await this.paintProviders();
    await this.paintPresets();
    await this.syncTiers();
    await this.paintPending();
    await this.paintAdvanced();
  }

  // ── Status ──

  private async paintStatus(): Promise<void> {
    if (!this.statusLabelId || !this.ai) return;
    const theme = this.host.theme();
    const routed = TIER_NAMES.map(t => this.ai!.tiers[t]).filter((r): r is TierRoute => !!r);
    const connected = this.providers.filter(p => p.state === 'connected' && p.chat);
    let text: string;
    let color = theme.statusSuccess;
    if (routed.length === 0) {
      color = theme.statusWarning;
      text = connected.length === 0
        ? 'No AI connected yet. Connect a provider under Providers and the models fill themselves in.'
        : 'A provider is ready but no tier uses it yet. Press Use on it under Providers, or pick a preset under Models.';
    } else {
      const used = [...new Set(routed.map(r => r.provider))];
      const away = used.filter(id => this.providers.length > 0 && !this.isReady(id) && this.providers.find(p => p.id === id)?.state !== 'unknown');
      if (away.length > 0) {
        color = theme.statusWarning;
        text = `${listed(away.map(id => this.providerLabel(id)))} ${away.length === 1 ? 'is' : 'are'} not available, and some tiers use ${away.length === 1 ? 'it' : 'them'}.`;
      } else {
        text = `AI is ready. ${routed.length === TIER_NAMES.length ? 'Every tier runs' : 'The tiers run'} on ${listed(used.map(id => this.providerLabel(id)))}.`;
      }
    }
    await this.update(this.statusLabelId, { text, style: { color, fontSize: 13, wordWrap: true } });
  }

  // ── Providers ──

  /** The line beside a provider's name. */
  private providerDetail(p: ProviderStatus): { text: string; color: string } {
    const theme = this.host.theme();
    if (p.state !== 'connected') {
      return { text: p.detail, color: p.state === 'unreachable' || p.state === 'missing' ? theme.textMeta : theme.textSecondary };
    }
    const parts = [p.detail];
    if (p.mode === 'apiKey') {
      const key = this.ai?.credentials[p.id]?.value;
      if (key) parts.push(`key ends ${key.slice(-4)}`);
    }
    if (p.models && p.mode !== 'cli') parts.push(`${p.models} models`);
    if (p.chat && p.usedBy.length === 0) parts.push('not in use');
    return { text: parts.join(' · '), color: theme.textDescription };
  }

  private orderedProviders(): ProviderStatus[] {
    const rank = (p: ProviderStatus): number =>
      p.state === 'connected' ? (p.usedBy.length > 0 ? 0 : 1) : p.state === 'needsKey' ? 2 : p.state === 'unknown' ? 3 : 4;
    return this.providers.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p);
  }

  private async paintProviders(): Promise<void> {
    const box = this.providersBoxId;
    if (!box || !this.ai) return;
    const theme = this.host.theme();
    const ordered = this.orderedProviders();
    const shownCount = Math.max(PROVIDERS_SHOWN, ordered.filter(p => p.state === 'connected').length);
    const shown = this.showAllProviders ? ordered : ordered.filter((p, i) => i < shownCount || p.id === this.openProvider);
    const note = this.note?.where === 'provider' ? this.note : undefined;
    const signature = JSON.stringify([
      shown.map(p => [p.id, p.state, this.providerDetail(p).text, p.usedBy.length === TIER_NAMES.length]),
      this.openProvider, this.openProvider ? this.providers.find(p => p.id === this.openProvider)?.usedBy : null,
      note, ordered.length, this.showAllProviders,
    ]);
    if (signature === this.painted.providers) return;
    this.painted.providers = signature;

    await this.host.ask(box, 'clearLayoutChildren', {});
    this.actions.providers.clear();
    this.providerInputId = this.keyToggleId = undefined;
    this.keyShown = false;

    for (const p of shown) {
      const open = this.openProvider === p.id;
      const detail = this.providerDetail(p);
      const rowId = await this.row(box);
      const ready = p.state === 'connected';
      // What the row's button does: open the key or address field, or use a ready provider.
      let button: { text: string; action: Action; style?: Record<string, unknown> } | undefined;
      if (p.mode === 'apiKey' || p.mode === 'url') {
        button = { text: open ? 'Close' : ready ? 'Manage' : p.mode === 'apiKey' ? 'Add key' : 'Set up', action: { kind: 'toggleProvider', provider: p.id } };
      } else if (ready && p.chat && p.usedBy.length < TIER_NAMES.length) {
        button = { text: 'Use', action: { kind: 'use', provider: p.id } };
      } else if (p.state === 'missing') {
        button = { text: 'Look again', action: { kind: 'check' } };
      }
      const ids = await this.make([
        { type: 'label', text: ready ? '●' : '○', style: { color: ready ? theme.statusSuccess : theme.textMeta, fontSize: 12, align: 'center' } },
        { type: 'label', text: p.label, style: { color: theme.textHeading, fontSize: 13, fontWeight: 'bold' } },
        { type: 'label', text: detail.text, style: { color: detail.color, fontSize: 12 } },
        ...(button ? [{ type: 'button', text: button.text, style: { fontSize: 12, ...(button.style ?? {}) } }] : []),
      ]);
      const cells: Array<{ id: AbjectId; width?: number }> = [{ id: ids[0], width: 14 }, { id: ids[1], width: this.nameWidth }, { id: ids[2] }];
      if (button) {
        this.actions.providers.set(ids[3], button.action);
        await this.listen(ids[3]);
        cells.push({ id: ids[3], width: BUTTON_WIDTH });
      }
      await this.place(rowId, cells);
      if (open) await this.paintOpenProvider(box, p, note);
    }

    const hidden = ordered.length - shown.length;
    if (hidden > 0 || this.showAllProviders) {
      const rowId = await this.row(box, 26);
      const [moreId] = await this.make([{
        type: 'button', style: { fontSize: 12 },
        text: this.showAllProviders ? 'Show fewer providers' : `Show ${hidden} more provider${hidden === 1 ? '' : 's'}`,
      }]);
      this.actions.providers.set(moreId, { kind: 'moreProviders' });
      await this.listen(moreId);
      await this.place(rowId, [{ id: moreId, width: 190 }], 26);
      await this.host.ask(rowId, 'addLayoutSpacer', {});
    }
  }

  /** The rows under an open provider: its key or address field, and what can be done with it. */
  private async paintOpenProvider(box: AbjectId, p: ProviderStatus, note: Note | undefined): Promise<void> {
    const theme = this.host.theme();
    const ready = p.state === 'connected';
    const isKey = p.mode === 'apiKey';
    const saved = this.ai?.credentials[p.id]?.value ?? '';

    if (ready) {
      await this.text(box, p.usedBy.length > 0 ? `Used by ${listed(p.usedBy)}.` : 'No tier uses it yet.', theme.textDescription);
    }
    // A saved key sits in its field, hidden until Show: it can be read, copied, or typed over.
    const fieldRow = await this.row(box);
    const [inputId, connectId, showId] = await this.make([
      isKey
        ? { type: 'textInput', masked: true, text: this.drafts.get(p.id) ?? saved,
            placeholder: p.credentialPlaceholder || `Paste your ${p.label} key` }
        : { type: 'textInput', text: this.drafts.get(p.id) ?? (saved || p.credentialPlaceholder || ''), placeholder: p.credentialPlaceholder ?? '' },
      { type: 'button', text: isKey ? (ready ? 'Save key' : 'Connect') : (ready ? 'Check again' : 'Connect'), style: this.actionStyle() },
      ...(isKey ? [{ type: 'button', text: 'Show', style: { fontSize: 12 } }] : []),
    ]);
    this.providerInputId = inputId;
    this.actions.providers.set(inputId, { kind: 'connect', provider: p.id });
    this.actions.providers.set(connectId, { kind: 'connect', provider: p.id });
    await this.listen(inputId, connectId);
    const fieldCells: Array<{ id: AbjectId; width?: number }> = [{ id: inputId }];
    if (showId) {
      this.keyToggleId = showId;
      this.actions.providers.set(showId, { kind: 'showKey' });
      await this.listen(showId);
      fieldCells.push({ id: showId, width: 60 });
    }
    await this.place(fieldRow, [...fieldCells, { id: connectId, width: 110 }]);

    if (note && note.provider === p.id) {
      await this.text(box, note.text, note.color);
    } else if (!ready) {
      await this.text(box, isKey
        ? `Connect checks the key with ${p.label} first. A key that is refused is not saved.`
        : `Start ${p.label} on this computer, or enter the address of the machine it runs on.`, theme.textSecondary);
    }

    const buttons: Array<{ text: string; action: Action; width: number; style?: Record<string, unknown> }> = [];
    if (note?.provider === p.id && note.allowUnchecked) buttons.push({ text: 'Save without checking', action: { kind: 'connectUnchecked', provider: p.id }, width: 170 });
    if (!ready && p.credentialUrl) buttons.push({ text: 'Where do I get a key?', action: { kind: 'link', provider: p.id }, width: 170, style: { color: theme.linkColor } });
    if (ready && p.chat && p.usedBy.length < TIER_NAMES.length) buttons.push({ text: 'Use for every tier', action: { kind: 'use', provider: p.id }, width: 150 });
    if (ready && isKey && saved) {
      buttons.push({ text: 'Disconnect', action: { kind: 'disconnect', provider: p.id }, width: 110,
        style: { background: theme.destructiveBg, color: theme.destructiveText, borderColor: theme.destructiveBorder } });
    }
    if (buttons.length === 0) return;
    const buttonRow = await this.row(box, 28);
    const ids = await this.make(buttons.map(b => ({ type: 'button', text: b.text, style: { fontSize: 12, ...(b.style ?? {}) } })));
    buttons.forEach((b, i) => this.actions.providers.set(ids[i], b.action));
    await this.listen(...ids);
    await this.place(buttonRow, buttons.map((b, i) => ({ id: ids[i], width: b.width })), 28);
    await this.host.ask(buttonRow, 'addLayoutSpacer', {});
  }

  // ── Presets ──

  private orderedPresets(): PresetListing[] {
    const rank = (p: PresetListing): number => p.inUse ? 0 : !p.builtin ? 1 : p.needs.length === 0 ? 2 : 3;
    return this.presets.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p);
  }

  /** The providers a preset routes to, each once. */
  private presetProviders(preset: PresetListing): string[] {
    const refs = [...TIER_NAMES.map(t => preset.preset.routing[t]), ...AUX_ROW_KEYS.map(k => preset.preset[k])];
    return [...new Set(refs.filter((r): r is TierRoute => !!r).map(r => r.provider))];
  }

  private presetState(preset: PresetListing): { text: string; color: string } {
    const theme = this.host.theme();
    if (preset.inUse) return { text: 'In use now', color: theme.statusSuccess };
    if (preset.needs.length === 0) return { text: 'Ready', color: theme.textDescription };
    const all = this.presetProviders(preset);
    if (all.length === 1) {
      const p = this.providers.find(x => x.id === all[0]);
      const label = this.providerLabel(all[0]);
      return { text: p?.mode === 'apiKey' ? `Needs a ${label} key` : `Needs ${label}`, color: theme.statusWarning };
    }
    return { text: `${all.length - preset.needs.length} of ${all.length} providers ready`, color: theme.statusWarning };
  }

  private async paintPresets(): Promise<void> {
    const box = this.presetsBoxId;
    if (!box || !this.ai) return;
    const theme = this.host.theme();
    const ordered = this.orderedPresets();
    const shown = this.showAllPresets ? ordered : ordered.filter((p, i) => i < PRESETS_SHOWN || p.name === this.openPreset);
    const open = shown.find(p => p.name === this.openPreset && p.needs.length > 0);
    const note = this.note?.where === 'preset' ? this.note : undefined;
    const signature = JSON.stringify([
      this.presetsLoaded, shown.map(p => [p.name, p.inUse, p.needs]), open?.name ?? null, this.showAllPresets, ordered.length, note,
      open ? [open.preset, this.ai.tiers, this.ai.vision, this.ai.fallback, this.ai.decision, open.needs.map(id => this.providers.find(p => p.id === id)?.detail)] : null,
      open ? [...this.liveModels] : null,
    ]);
    if (signature === this.painted.presets) return;
    this.painted.presets = signature;

    await this.host.ask(box, 'clearLayoutChildren', {});
    this.actions.presets.clear();
    this.presetInputs.clear();
    this.presetNameInputId = undefined;

    if (!this.presetsLoaded) {
      await this.text(box, 'Looking at what is available on this computer…', theme.textSecondary);
      return;
    }
    if (ordered.length === 0) {
      await this.text(box, 'No presets yet. Connect a provider and its recommended models show up here.', theme.textSecondary);
    }

    for (const preset of shown) {
      const state = this.presetState(preset);
      const isOpen = open?.name === preset.name;
      const rowId = await this.row(box);
      const button = preset.inUse ? undefined
        : preset.needs.length === 0 ? { text: 'Apply', action: { kind: 'applyPreset', preset: preset.name } as Action }
        : { text: isOpen ? 'Close' : 'Set up', action: { kind: 'togglePreset', preset: preset.name } as Action };
      const ids = await this.make([
        { type: 'label', text: preset.builtin ? preset.name : `${preset.name} (saved)`, style: { color: theme.textHeading, fontSize: 13, fontWeight: 'bold' } },
        { type: 'label', text: state.text, style: { color: state.color, fontSize: 12, align: 'right' } },
        ...(button ? [{ type: 'button', text: button.text, style: { fontSize: 12 } }] : []),
        ...(!preset.builtin ? [{ type: 'button', text: 'Delete', style: { fontSize: 12 } }] : []),
      ]);
      const cells: Array<{ id: AbjectId; width?: number }> = [{ id: ids[0] }, { id: ids[1], width: 170 }];
      let next = 2;
      if (button) {
        this.actions.presets.set(ids[next], button.action);
        cells.push({ id: ids[next++], width: BUTTON_WIDTH });
      }
      if (!preset.builtin) {
        this.actions.presets.set(ids[next], { kind: 'deletePreset', preset: preset.name });
        cells.push({ id: ids[next++], width: 64 });
      }
      await this.listen(...ids.slice(2));
      await this.place(rowId, cells);
      if (isOpen) await this.paintOpenPreset(box, preset, note);
    }

    const hidden = ordered.length - shown.length;
    const footRow = await this.row(box);
    const [nameId, saveId, moreId] = await this.make([
      { type: 'textInput', placeholder: 'Name the current models to keep them' },
      { type: 'button', text: 'Save as preset', style: { fontSize: 12 } },
      ...(hidden > 0 || this.showAllPresets ? [{
        type: 'button', style: { fontSize: 12 }, text: this.showAllPresets ? 'Show fewer' : `Show ${hidden} more`,
      }] : []),
    ]);
    this.presetNameInputId = nameId;
    this.actions.presets.set(nameId, { kind: 'savePreset' });
    this.actions.presets.set(saveId, { kind: 'savePreset' });
    await this.listen(nameId, saveId);
    const cells: Array<{ id: AbjectId; width?: number }> = [{ id: nameId }, { id: saveId, width: 120 }];
    if (moreId) {
      this.actions.presets.set(moreId, { kind: 'morePresets' });
      await this.listen(moreId);
      cells.push({ id: moreId, width: 120 });
    }
    await this.place(footRow, cells);
  }

  /** What a preset would change, tier by tier and row by row. */
  private presetChanges(preset: PresetListing): Array<{ text: string; waiting: boolean; ready: boolean }> {
    const ai = this.ai!;
    const lines: Array<{ text: string; waiting: boolean; ready: boolean }> = [];
    const line = (key: SlotKey, current: ModelRef | null, next: ModelRef | null): void => {
      if (!current && !next) return;
      const same = (current?.provider ?? '') === (next?.provider ?? '') && (current?.model ?? '') === (next?.model ?? '');
      const waiting = !!next && !same && !this.isReady(next.provider);
      const tail = same ? 'no change' : waiting ? `waits for ${this.providerLabel(next!.provider)}` : 'ready';
      lines.push({ text: `${SLOT_LABELS[key]}: ${this.routeText(current)} → ${this.routeText(next)} (${tail})`, waiting, ready: !same && !waiting });
    };
    for (const tier of TIER_NAMES) line(tier, ai.tiers[tier], preset.preset.routing[tier] ?? null);
    line('vision', ai.vision, preset.preset.vision ?? null);
    for (const key of ['fallback', 'decision'] as const) {
      if (preset.preset[key] !== undefined) line(key, ai[key], preset.preset[key] ?? null);
    }
    return lines;
  }

  /** The panel under a preset that still needs a provider: connect what is missing, see what would change, choose. */
  private async paintOpenPreset(box: AbjectId, preset: PresetListing, note: Note | undefined): Promise<void> {
    const theme = this.host.theme();
    const all = this.presetProviders(preset);
    await this.text(box,
      `${preset.name} uses ${listed(all.map(id => this.providerLabel(id)))}. Set up what is missing here, or apply the part that is ready. Nothing changes until you choose.`,
      theme.textDescription);

    for (const id of preset.needs) {
      const p = this.providers.find(x => x.id === id);
      if (!p) continue;
      const rowId = await this.row(box);
      if (p.mode === 'apiKey') {
        const [labelId, inputId, connectId] = await this.make([
          { type: 'label', text: p.label, style: { color: theme.textHeading, fontSize: 13, fontWeight: 'bold' } },
          { type: 'textInput', masked: true, text: this.drafts.get(p.id) ?? '', placeholder: p.credentialPlaceholder || `Paste your ${p.label} key` },
          { type: 'button', text: 'Connect', style: this.actionStyle() },
        ]);
        this.presetInputs.set(p.id, inputId);
        this.actions.presets.set(inputId, { kind: 'presetConnect', provider: p.id });
        this.actions.presets.set(connectId, { kind: 'presetConnect', provider: p.id });
        await this.listen(inputId, connectId);
        await this.place(rowId, [{ id: labelId, width: 130 }, { id: inputId }, { id: connectId, width: BUTTON_WIDTH }]);
      } else {
        const [labelId, detailId, checkId] = await this.make([
          { type: 'label', text: p.label, style: { color: theme.textHeading, fontSize: 13, fontWeight: 'bold' } },
          { type: 'label', text: p.detail, style: { color: theme.statusWarning, fontSize: 12 } },
          { type: 'button', text: 'Look again', style: { fontSize: 12 } },
        ]);
        this.actions.presets.set(checkId, { kind: 'check' });
        await this.listen(checkId);
        await this.place(rowId, [{ id: labelId, width: 130 }, { id: detailId }, { id: checkId, width: BUTTON_WIDTH }]);
      }
      if (note && note.provider === p.id) await this.text(box, note.text, note.color);
    }

    const changes = this.presetChanges(preset);
    for (const change of changes) {
      await this.text(box, change.text, change.waiting ? theme.statusWarning : theme.textSecondary);
    }

    const anyReady = changes.some(c => c.ready);
    const buttonRow = await this.row(box);
    const [readyId, cancelId] = await this.make([
      { type: 'button', text: 'Apply what\'s ready', style: anyReady ? this.actionStyle() : { fontSize: 12, disabled: true } },
      { type: 'button', text: 'Cancel', style: { fontSize: 12 } },
    ]);
    this.actions.presets.set(readyId, { kind: 'applyReady', preset: preset.name });
    this.actions.presets.set(cancelId, { kind: 'togglePreset', preset: preset.name });
    await this.listen(readyId, cancelId);
    await this.place(buttonRow, [{ id: readyId, width: 150 }, { id: cancelId, width: 80 }]);
    await this.host.ask(buttonRow, 'addLayoutSpacer', {});
    await this.text(box, anyReady
      ? 'The rest keeps its current model and switches on its own when its provider connects.'
      : 'No part of it is ready yet: connect a provider above first.', theme.textSecondary);
  }

  // ── Models ──

  /** The provider choices of a tier row: an empty choice, then every chat provider, marked when it is not connected. */
  private providerOptions(empty: string, chatOnly: boolean, current: string | undefined): SelectOption[] {
    const options: SelectOption[] = [{ label: empty, value: NONE }];
    for (const p of this.providers) {
      if (chatOnly && !p.chat) continue;
      options.push({ label: p.state === 'connected' || p.state === 'unknown' ? p.label : `${p.label} (not connected)`, value: p.id });
    }
    if (current && !options.some(o => o.value === current)) options.push({ label: `${current} (away)`, value: current });
    return options;
  }

  private effortOptions(provider: string, tier: ModelTierName, model: string): string[] {
    const efforts = this.tierModels(provider, tier).find(m => m.id === model)?.efforts ?? [];
    return efforts.length === 0 ? [NO_EFFORT] : [EFFORT_DEFAULT, ...efforts];
  }

  /** Point every tier row at the saved routing. */
  private async syncTiers(): Promise<void> {
    if (!this.ai) return;
    for (const tier of TIER_NAMES) {
      const row = this.tierRows[tier];
      if (!row) continue;
      const route = this.ai.tiers[tier];
      const providers = this.providerOptions(tier === 'code' ? 'Same as Smart' : 'Not set', true, route?.provider);
      await this.update(row.provider, {
        options: providers, selectedIndex: Math.max(0, providers.findIndex(o => o.value === (route?.provider ?? NONE))),
      });
      if (!route) {
        const waiting = tier === 'code' && this.ai.tiers.smart ? 'follows Smart' : 'waiting for a provider';
        await this.update(row.model, { options: [{ label: waiting, value: NONE }], selectedIndex: 0, style: { disabled: true } });
        await this.update(row.effort, { options: [NO_EFFORT], selectedIndex: 0, style: { disabled: true } });
        await this.update(row.cap, { text: '' });
        continue;
      }
      const list = this.withSaved(this.tierModels(route.provider, tier), route.model);
      const index = Math.max(0, list.findIndex(m => m.id === route.model));
      await this.update(row.model, {
        options: list.map(m => ({ label: m.name, value: m.id })), selectedIndex: index, style: { disabled: false },
      });
      // A model the catalog has not named yet has unknown efforts: keep the saved one on show.
      let efforts = this.effortOptions(route.provider, tier, route.model);
      if (route.effort && !efforts.includes(route.effort)) efforts = [EFFORT_DEFAULT, route.effort];
      await this.update(row.effort, {
        options: efforts, selectedIndex: route.effort ? Math.max(0, efforts.indexOf(route.effort)) : 0, style: { disabled: efforts.length <= 1 },
      });
      const cap = this.capability(list[index]);
      await this.update(row.cap, { text: cap.text, style: { color: cap.color, fontSize: 11 } });
    }
  }

  /** Whether a provider can take a route now; when it cannot, say why and open the way to fix it. */
  private async admitProvider(provider: string): Promise<boolean> {
    const p = this.providers.find(x => x.id === provider);
    if (!p || p.state === 'connected' || p.state === 'unknown') return true;
    if (p.mode === 'apiKey' || p.mode === 'url') {
      this.openProvider = p.id;
      this.note = undefined;
      await this.showSubTab('providers');
      await this.host.status(p.mode === 'apiKey'
        ? `${p.label} needs a key first. Its row is open here.`
        : `${p.label} is not answering. Its row is open here.`, this.host.theme().statusWarning);
    } else {
      await this.host.status(`${p.label} is not available: ${p.detail.toLowerCase()}.`, this.host.theme().statusWarning);
    }
    return false;
  }

  private async onTierProvider(tier: ModelTierName, provider: string): Promise<void> {
    if (!this.ai) return;
    if (provider === NONE) {
      await this.write({ tiers: { [tier]: null } }, `${TIER_LABELS[tier]} is ${tier === 'code' ? 'following Smart' : 'not set'}.`);
      return;
    }
    if (provider === this.ai.tiers[tier]?.provider) return;
    if (!(await this.admitProvider(provider))) {
      await this.paint();
      return;
    }
    let route: TierRoute | null = null;
    try {
      route = await this.manager<TierRoute | null>('recommendedRoute', { provider, tier });
    } catch { /* falls to the list below */ }
    route ??= this.tierModels(provider, tier)[0] ? { provider, model: this.tierModels(provider, tier)[0].id } : null;
    if (!route) {
      await this.syncTiers();
      await this.host.reject(`${this.providerLabel(provider)} has no models to choose from yet.`, this.host.theme().statusWarning);
      return;
    }
    await this.write({ tiers: { [tier]: route } }, `${TIER_LABELS[tier]} now runs on ${this.routeText(route)}.`);
  }

  private async onTierModel(tier: ModelTierName, model: string): Promise<void> {
    const route = this.ai?.tiers[tier];
    if (!route || model === NONE || model === route.model) return;
    const keepEffort = route.effort && this.effortOptions(route.provider, tier, model).includes(route.effort);
    const next: TierRoute = { provider: route.provider, model, ...(keepEffort ? { effort: route.effort } : {}) };
    await this.write({ tiers: { [tier]: next } }, `${TIER_LABELS[tier]} now runs on ${this.routeText(next)}.`);
  }

  private async onTierEffort(tier: ModelTierName, effort: string): Promise<void> {
    const route = this.ai?.tiers[tier];
    if (!route) return;
    const next = effort === EFFORT_DEFAULT || effort === NO_EFFORT ? undefined : effort;
    if ((route.effort ?? undefined) === next) return;
    await this.write({ tiers: { [tier]: { provider: route.provider, model: route.model, ...(next ? { effort: next } : {}) } } },
      `${TIER_LABELS[tier]} reasoning is ${next ?? 'the provider\'s default'}.`);
  }

  /** Preset routes still waiting for their provider. */
  private async paintPending(): Promise<void> {
    const box = this.pendingBoxId;
    if (!box || !this.ai) return;
    const pending = this.ai.pending;
    const signature = JSON.stringify([pending, [...this.liveModels]]);
    if (signature === this.painted.pending) return;
    this.painted.pending = signature;
    await this.host.ask(box, 'clearLayoutChildren', {});
    if (!pending) return;
    const waits = Object.entries(pending.slots).map(([key, route]) => `${SLOT_LABELS[key as SlotKey]} → ${this.routeText(route)}`);
    await this.text(box,
      `Waiting from ${pending.preset}: ${waits.join('; ')}. Each switches on its own when its provider connects, or stops waiting when you set that row yourself.`,
      this.host.theme().statusWarning);
  }

  // ── Advanced ──

  private parseBudget(text: string): number {
    const typed = text.trim().replace(/^\$/, '');
    return typed === '' ? NaN : Number(typed);
  }

  private budgetHint(perDay: number): string {
    if (!Number.isFinite(perDay) || perDay < 0) return 'Enter dollars per day, 0 or more';
    if (perDay === 0) return 'Learning reviews and repairs are off';
    return `USD a day, about $${Math.round(perDay * 30)} a month`;
  }

  private async paintAdvanced(): Promise<void> {
    const box = this.advancedBoxId;
    if (!box || !this.ai) return;
    const ai = this.ai;
    const theme = this.host.theme();
    // Built while its sub-tab is on show; a change made elsewhere meanwhile is painted on return.
    if (this.subTab !== 'advanced') return;
    const signature = JSON.stringify([
      ai.vision, ai.fallback, ai.decision, ai.decisionGates, ai.cacheKeepalive, ai.learningBudgetUsdPerDay,
      this.providers.map(p => [p.id, p.state]), [...this.liveModels],
    ]);
    if (signature === this.painted.advanced) return;
    this.painted.advanced = signature;

    await this.host.ask(box, 'clearLayoutChildren', {});
    this.actions.advanced.clear();
    this.auxRows = {};
    this.budgetInputId = this.budgetHintId = this.keepaliveId = this.gatesSelectId = undefined;

    for (const key of AUX_ROW_KEYS) {
      const ref = ai[key];
      const providers = this.providerOptions(key === 'decision' ? 'Auto' : 'None', key !== 'decision', ref?.provider);
      const list = ref ? this.withSaved(this.auxModels(key, ref.provider), ref.model) : [];
      const index = ref ? Math.max(0, list.findIndex(m => m.id === ref.model)) : 0;
      let cap = { text: '', color: theme.textTertiary };
      if (ref && key === 'decision') {
        const native = ((this.descById.get(ref.provider)?.decisionModels ?? []) as ModelInfo[]).some(m => m.id === ref.model);
        cap = native ? { text: 'native', color: theme.statusSuccess } : { text: 'emulated', color: theme.textTertiary };
      } else if (ref) {
        cap = this.capability(list[index]);
      }
      const rowId = await this.row(box);
      const [labelId, providerId, modelId, capId] = await this.make([
        { type: 'label', text: SLOT_LABELS[key], style: { color: theme.textHeading, fontSize: 13 } },
        { type: 'select', options: providers, selectedIndex: Math.max(0, providers.findIndex(o => o.value === (ref?.provider ?? NONE))) },
        ref
          ? { type: 'select', options: list.map(m => ({ label: m.name, value: m.id })), selectedIndex: index }
          : { type: 'select', options: [{ label: key === 'decision' ? 'a decision model if keyed, else Fast' : 'none', value: NONE }], selectedIndex: 0, style: { disabled: true } },
        { type: 'label', text: cap.text, style: { color: cap.color, fontSize: 11 } },
      ]);
      this.auxRows[key] = { provider: providerId, model: modelId, cap: capId };
      await this.listen(providerId, modelId);
      await this.place(rowId, [{ id: labelId, width: 110 }, { id: providerId, width: 170 }, { id: modelId }, { id: capId, width: 62 }]);
      await this.text(box, AUX_HINTS[key], theme.textSecondary, 11);
    }

    const gatesRow = await this.row(box);
    const [gatesLabelId, gatesId] = await this.make([
      { type: 'label', text: 'Decision gates', style: { color: theme.textHeading, fontSize: 13 } },
      { type: 'select', options: DECISION_GATE_OPTIONS, selectedIndex: Math.max(0, DECISION_GATE_OPTIONS.findIndex(o => o.value === ai.decisionGates)) },
    ]);
    this.gatesSelectId = gatesId;
    await this.listen(gatesId);
    await this.place(gatesRow, [{ id: gatesLabelId, width: 110 }, { id: gatesId }]);

    const [keepaliveId] = await this.make([{
      type: 'checkbox', checked: ai.cacheKeepalive,
      text: 'Keep prompt caches warm between agent steps (spends cached-read tokens to avoid re-prefills)',
    }]);
    this.keepaliveId = keepaliveId;
    await this.listen(keepaliveId);
    await this.host.ask(box, 'addLayoutChild', {
      widgetId: keepaliveId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 28 },
    });

    const budgetRow = await this.row(box);
    const [budgetLabelId, budgetInputId, setId, hintId] = await this.make([
      { type: 'label', text: 'Learning budget', style: { color: theme.textHeading, fontSize: 13 } },
      { type: 'textInput', placeholder: '3', text: String(ai.learningBudgetUsdPerDay) },
      { type: 'button', text: 'Set', style: { fontSize: 12 } },
      { type: 'label', text: this.budgetHint(ai.learningBudgetUsdPerDay), style: hintStyle(theme) },
    ]);
    this.budgetInputId = budgetInputId;
    this.budgetHintId = hintId;
    this.actions.advanced.set(budgetInputId, { kind: 'setBudget' });
    this.actions.advanced.set(setId, { kind: 'setBudget' });
    await this.listen(budgetInputId, setId);
    await this.place(budgetRow, [{ id: budgetLabelId, width: 110 }, { id: budgetInputId, width: 72 }, { id: setId, width: 56 }, { id: hintId }]);
    await this.text(box, 'What reviewing finished work and repairing what agents learned may spend on models per day, across all workspaces. Reviews pause for the day once it is spent.', theme.textSecondary, 11);
  }

  private async onAuxProvider(key: AuxRowKey, provider: string): Promise<void> {
    if (!this.ai) return;
    if (provider === NONE) {
      await this.write({ [key]: null }, `${SLOT_LABELS[key]} is ${key === 'decision' ? 'automatic' : 'off'}.`);
      return;
    }
    if (provider === this.ai[key]?.provider) return;
    if (!(await this.admitProvider(provider))) {
      this.painted.advanced = '';
      await this.paint();
      return;
    }
    const list = this.auxModels(key, provider);
    const pick = (key === 'vision' ? list.find(m => m.vision === true) : undefined) ?? list[0];
    if (!pick) {
      this.painted.advanced = '';
      await this.paintAdvanced();
      await this.host.reject(`${this.providerLabel(provider)} has no models to choose from yet.`, this.host.theme().statusWarning);
      return;
    }
    const ref = { provider, model: pick.id };
    await this.write({ [key]: ref }, `${SLOT_LABELS[key]} is ${this.routeText(ref)}.`);
  }

  private async onAuxModel(key: AuxRowKey, model: string): Promise<void> {
    const ref = this.ai?.[key];
    if (!ref || model === NONE || model === ref.model) return;
    const next = { provider: ref.provider, model };
    await this.write({ [key]: next }, `${SLOT_LABELS[key]} is ${this.routeText(next)}.`);
  }

  // ===========================================================================
  // Actions
  // ===========================================================================

  private async run(action: Action): Promise<void> {
    if (!this.windowId) return;
    switch (action.kind) {
      case 'undo': {
        const result = await this.host.undo();
        if (result.ok) await this.refresh();
        else await this.host.status(result.reason ?? 'Nothing to undo.', this.host.theme().textDescription);
        return;
      }
      case 'toggleProvider':
        await this.keepDraft();
        this.openProvider = this.openProvider === action.provider ? undefined : action.provider;
        this.note = undefined;
        await this.paintProviders();
        return;
      case 'showKey':
        if (!this.providerInputId || !this.keyToggleId) return;
        this.keyShown = !this.keyShown;
        await this.update(this.providerInputId, { masked: !this.keyShown });
        await this.update(this.keyToggleId, { text: this.keyShown ? 'Hide' : 'Show' });
        return;
      case 'moreProviders':
        await this.keepDraft();
        this.showAllProviders = !this.showAllProviders;
        await this.paintProviders();
        return;
      case 'connect': return this.connect(action.provider, { where: 'provider' });
      case 'connectUnchecked': return this.connect(action.provider, { where: 'provider', unchecked: true });
      case 'presetConnect': return this.connect(action.provider, { where: 'preset' });
      case 'use': return this.use(action.provider);
      case 'disconnect': {
        const label = this.providerLabel(action.provider);
        this.openProvider = undefined;
        this.note = undefined;
        this.liveModels.delete(action.provider);
        await this.write({ credentials: { [action.provider]: null } }, `${label} disconnected.`);
        return;
      }
      case 'check':
        await this.host.status('Looking again…');
        await this.manager('listProviders', { probe: true, force: true }, 90_000);
        await this.refresh();
        await this.host.status('Looked again.', this.host.theme().textDescription);
        return;
      case 'link': {
        const url = this.providers.find(p => p.id === action.provider)?.credentialUrl;
        if (url) await this.widgets('openUrl', { url });
        return;
      }
      case 'togglePreset':
        this.openPreset = this.openPreset === action.preset ? undefined : action.preset;
        this.note = undefined;
        await this.paintPresets();
        return;
      case 'morePresets':
        this.showAllPresets = !this.showAllPresets;
        await this.paintPresets();
        return;
      case 'applyPreset': return this.applyPreset(action.preset, false);
      case 'applyReady': return this.applyPreset(action.preset, true);
      case 'savePreset': return this.savePreset();
      case 'deletePreset': {
        this.host.ownChange('presets');
        try {
          await this.manager('deletePreset', { name: action.preset });
        } catch (err) {
          await this.host.reject(settingsError(err));
          return;
        }
        await this.refresh();
        await this.host.status(`Preset '${action.preset}' deleted.`, this.host.theme().statusSuccess);
        return;
      }
      case 'setBudget': {
        if (!this.budgetInputId) return;
        const perDay = this.parseBudget(String(await this.host.ask<string>(this.budgetInputId, 'getValue', {}) ?? ''));
        if (!Number.isFinite(perDay)) {
          await this.host.reject('The learning budget must be a number of dollars per day (0 turns learning reviews off).');
          return;
        }
        await this.write({ learningBudgetUsdPerDay: perDay }, 'Learning budget set.');
        return;
      }
    }
  }

  /** Remember what is typed in the open provider's field before its row is rebuilt. */
  private async keepDraft(): Promise<void> {
    if (!this.providerInputId || !this.openProvider) return;
    try {
      const typed = String(await this.host.ask<string>(this.providerInputId, 'getValue', {}) ?? '');
      // The saved key shown in the field is not a draft.
      if (typed && typed !== (this.ai?.credentials[this.openProvider]?.value ?? '')) this.drafts.set(this.openProvider, typed);
      else this.drafts.delete(this.openProvider);
    } catch { /* widget gone */ }
  }

  private async connect(provider: string, opts: { where: 'provider' | 'preset'; unchecked?: boolean }): Promise<void> {
    const theme = this.host.theme();
    const p = this.providers.find(x => x.id === provider);
    if (!p) return;
    const inputId = opts.where === 'preset' ? this.presetInputs.get(provider) : this.providerInputId;
    const credential = inputId ? String(await this.host.ask<string>(inputId, 'getValue', {}) ?? '').trim() : '';
    const repaint = async (): Promise<void> => {
      this.painted.providers = '';
      this.painted.presets = '';
      await this.paintProviders();
      await this.paintPresets();
    };
    if (p.mode === 'apiKey' && credential === '') {
      this.note = { where: opts.where, provider, text: 'Paste the key first.', color: theme.statusWarning };
      await repaint();
      await this.host.reject(`Paste the ${p.label} key first.`, theme.statusWarning);
      return;
    }
    if (credential !== '' && credential === (this.ai?.credentials[provider]?.value ?? '')) {
      await this.host.status(p.mode === 'apiKey' ? `That is the ${p.label} key already saved.` : `${p.label} is already connected at that address.`);
      if (p.mode === 'apiKey') return;
    }
    if (credential) this.drafts.set(provider, credential);
    await this.host.status(p.mode === 'apiKey' ? `Checking the key with ${p.label}…` : `Looking for ${p.label}…`);
    this.host.ownChange('ai');
    let result: ConnectResult;
    try {
      result = await this.manager<ConnectResult>('connectProvider',
        { provider, credential, ...(opts.unchecked ? { unchecked: true } : {}) }, 90_000);
    } catch (err) {
      result = { ok: false, message: settingsError(err) };
    }
    this.host.ownChange('ai');
    if (!result.ok) {
      const message = result.message ?? `${p.label} could not be connected.`;
      const more = result.reason === 'rejected' ? ' Check for a missing character at either end. Nothing was saved, and your current models are untouched.'
        : result.reason === 'unreachable' && p.mode === 'apiKey' ? ' Try again, or save the key without checking it.' : '';
      this.note = {
        where: opts.where, provider, text: message + more,
        color: result.reason === 'rejected' ? theme.statusErrorBright : theme.statusWarning,
        ...(result.reason === 'unreachable' && p.mode === 'apiKey' && opts.where === 'provider' ? { allowUnchecked: true } : {}),
      };
      await this.refresh();
      await repaint();
      await this.host.reject(message);
      return;
    }
    this.drafts.delete(provider);
    this.note = undefined;
    if (opts.where === 'provider') this.openProvider = undefined;
    this.liveModels.delete(provider);
    await this.refresh();
    // The tiers just filled in: show them.
    if (result.routed) await this.showSubTab('models');
    this.host.flash();
    await this.host.status(
      `${p.label} connected.${result.routed ? ' Every tier now runs on its recommended models.' : ''}${result.checked === false && p.mode === 'apiKey' ? ' The key was saved without being checked.' : ''}`,
      theme.statusSuccess);
  }

  /** Route every tier to one ready provider's recommended models. */
  private async use(provider: string): Promise<void> {
    const label = this.providerLabel(provider);
    this.host.ownChange('ai');
    let result: ConnectResult;
    try {
      result = await this.manager<ConnectResult>('connectProvider', { provider, route: true }, 90_000);
    } catch (err) {
      result = { ok: false, message: settingsError(err) };
    }
    this.host.ownChange('ai');
    await this.refresh();
    if (!result.ok) {
      await this.host.reject(result.message ?? `${label} could not be used.`);
      return;
    }
    if (!result.routed) {
      await this.host.reject(`${label} has no models to recommend yet.`, this.host.theme().statusWarning);
      return;
    }
    this.openProvider = undefined;
    await this.paintProviders();
    await this.showSubTab('models');
    this.host.flash();
    await this.host.status(`Every tier now runs on ${label}.`, this.host.theme().statusSuccess);
  }

  private async applyPreset(name: string, onlyReady: boolean): Promise<void> {
    this.host.ownChange('ai');
    try {
      await this.manager('applyPreset', { name, ...(onlyReady ? { onlyReady: true } : {}) });
    } catch (err) {
      await this.refresh();
      await this.host.reject(settingsError(err));
      return;
    }
    this.host.ownChange('ai');
    this.openPreset = undefined;
    this.note = undefined;
    await this.refresh();
    this.host.flash();
    await this.host.status(onlyReady && this.ai?.pending
      ? `Applied the ready part of ${name}. The rest follows when its providers connect.`
      : `${name} applied.`, this.host.theme().statusSuccess);
  }

  private async savePreset(): Promise<void> {
    if (!this.presetNameInputId || !this.ai) return;
    const name = String(await this.host.ask<string>(this.presetNameInputId, 'getValue', {}) ?? '').trim();
    if (!name) {
      await this.host.reject('Give the preset a name first.', this.host.theme().statusWarning);
      return;
    }
    if (TIER_NAMES.every(t => !this.ai!.tiers[t])) {
      await this.host.reject('Set at least one tier before saving a preset.', this.host.theme().statusWarning);
      return;
    }
    this.host.ownChange('presets');
    try {
      await this.manager('savePreset', { name });
    } catch (err) {
      await this.host.reject(`Could not save preset '${name}': ${settingsError(err)}`);
      return;
    }
    this.painted.presets = '';
    await this.refresh();
    await this.host.status(`Preset '${name}' saved.`, this.host.theme().statusSuccess);
  }
}
