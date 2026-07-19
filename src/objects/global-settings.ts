/**
 * GlobalSettings object — provides UI for configuring global LLM API keys.
 *
 * This is a global (non-per-workspace) object that manages API keys in
 * global Storage. On first boot with no keys, it auto-shows to prompt
 * the user. Keys are persisted with the 'global-settings:' prefix.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { LLMProviderDescription } from '../llm/provider.js';

const log = new Log('GlobalSettings');

/** Convert a string array to ListItem array for list widgets. */
function toListItems(
  arr: string[],
): Array<{ label: string; value: string; actions: Array<{ id: string; label: string }> }> {
  return arr.map(s => ({ label: s, value: s, actions: [{ id: 'remove', label: 'Remove' }] }));
}

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const STORAGE_PREFIX = 'global-settings:';
const STORAGE_KEY_AI_ACTIVE_PROVIDER = `${STORAGE_PREFIX}aiActiveProvider`;
/** Build a per-provider credential storage key from a description's `storageSuffix`. */
function storageKeyFor(suffix: string): string { return `${STORAGE_PREFIX}${suffix}`; }
const STORAGE_KEY_AUTH_ENABLED = 'global-settings:authEnabled';
const STORAGE_KEY_AUTH_USER = 'global-settings:authUser';
const STORAGE_KEY_AUTH_PASS = 'global-settings:authPass';

// Permissions storage keys
const STORAGE_KEY_FS_ALLOWED_PATHS = 'global-settings:fsAllowedPaths';
const STORAGE_KEY_FS_READ_ONLY = 'global-settings:fsReadOnly';
const STORAGE_KEY_SHELL_ENABLED = 'global-settings:shellEnabled';
const STORAGE_KEY_SHELL_ALLOWED_CMDS = 'global-settings:shellAllowedCmds';
const STORAGE_KEY_SHELL_DENIED_CMDS = 'global-settings:shellDeniedCmds';
const STORAGE_KEY_WEB_ENABLED = 'global-settings:webEnabled';
const STORAGE_KEY_WEB_ALLOWED_DOMAINS = 'global-settings:webAllowedDomains';
const STORAGE_KEY_WEB_DENIED_DOMAINS = 'global-settings:webDeniedDomains';
const STORAGE_KEY_CAP_ENFORCEMENT = 'global-settings:capabilityEnforcement';

// Per-tier routing storage keys
const STORAGE_KEY_TIER_SMART_PROVIDER = 'global-settings:tierSmartProvider';
const STORAGE_KEY_TIER_SMART_MODEL = 'global-settings:tierSmartModel';
const STORAGE_KEY_TIER_SMART_EFFORT = 'global-settings:tierSmartEffort';
const STORAGE_KEY_TIER_BALANCED_PROVIDER = 'global-settings:tierBalancedProvider';
const STORAGE_KEY_TIER_BALANCED_MODEL = 'global-settings:tierBalancedModel';
const STORAGE_KEY_TIER_BALANCED_EFFORT = 'global-settings:tierBalancedEffort';
const STORAGE_KEY_TIER_FAST_PROVIDER = 'global-settings:tierFastProvider';
const STORAGE_KEY_TIER_FAST_MODEL = 'global-settings:tierFastModel';
const STORAGE_KEY_TIER_FAST_EFFORT = 'global-settings:tierFastEffort';
const STORAGE_KEY_TIER_CODE_PROVIDER = 'global-settings:tierCodeProvider';
const STORAGE_KEY_TIER_CODE_MODEL = 'global-settings:tierCodeModel';
const STORAGE_KEY_TIER_CODE_EFFORT = 'global-settings:tierCodeEffort';
// Optional vision-fallback model: substitutes for a text-only tier model on image-bearing steps
const STORAGE_KEY_VISION_PROVIDER = 'global-settings:tierVisionProvider';
const STORAGE_KEY_VISION_MODEL = 'global-settings:tierVisionModel';
// Prompt-cache keepalive toggle (default off — pings spend real money)
const STORAGE_KEY_CACHE_KEEPALIVE = 'global-settings:cacheKeepalive';

/**
 * Provider list, labels, default tier models, credential metadata, and
 * CLI binary detection are all derived from per-provider `describe()`
 * via `LLMObject.listProviderDescriptions`. Each provider self-describes
 * (see `src/llm/provider.ts` — `LLMProviderDescription`); GlobalSettings
 * has no per-provider knowledge.
 */
type LLMProviderName = string;

type ModelTierName = 'smart' | 'balanced' | 'fast' | 'code';
const TIER_LABELS: string[] = ['Smart', 'Balanced', 'Fast', 'Code'];
const TIER_NAMES: ModelTierName[] = ['smart', 'balanced', 'fast', 'code'];

/** Per-tier storage keys, so every load/persist path loops instead of hardcoding tiers. */
const TIER_STORAGE_KEYS: Record<ModelTierName, { provider: string; model: string; effort: string }> = {
  smart:    { provider: STORAGE_KEY_TIER_SMART_PROVIDER,    model: STORAGE_KEY_TIER_SMART_MODEL,    effort: STORAGE_KEY_TIER_SMART_EFFORT },
  balanced: { provider: STORAGE_KEY_TIER_BALANCED_PROVIDER, model: STORAGE_KEY_TIER_BALANCED_MODEL, effort: STORAGE_KEY_TIER_BALANCED_EFFORT },
  fast:     { provider: STORAGE_KEY_TIER_FAST_PROVIDER,     model: STORAGE_KEY_TIER_FAST_MODEL,     effort: STORAGE_KEY_TIER_FAST_EFFORT },
  code:     { provider: STORAGE_KEY_TIER_CODE_PROVIDER,     model: STORAGE_KEY_TIER_CODE_MODEL,     effort: STORAGE_KEY_TIER_CODE_EFFORT },
};

/** 'Default' = no override (provider's tier default applies). */
const EFFORT_DEFAULT_LABEL = 'Default';

/** One tier's saved routing row: provider + model + optional effort override. */
interface TierRoutingRow {
  provider: string | null;
  model: string | null;
  /** Reasoning-effort override; null/undefined = provider default. */
  effort?: string | null;
}

/** Saved tier presets: name → full tier routing + optional vision fallback. */
const STORAGE_KEY_TIER_PRESETS = 'global-settings:tierPresets';

interface TierPreset {
  routing: Partial<Record<ModelTierName, { provider: string; model: string; effort?: string }>>;
  vision: { provider: string; model: string } | null;
}

// Legacy keys for migration
const LEGACY_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const LEGACY_KEY_OPENAI = 'settings:openaiApiKey';
const LEGACY_KEY_PROVIDER = 'global-settings:llmProvider';
const LEGACY_KEY_OLLAMA_MODEL = 'global-settings:ollamaModel';
const LEGACY_KEY_OLLAMA_MODEL_SMART = 'global-settings:ollamaModelSmart';
const LEGACY_KEY_OLLAMA_MODEL_BALANCED = 'global-settings:ollamaModelBalanced';
const LEGACY_KEY_OLLAMA_MODEL_FAST = 'global-settings:ollamaModelFast';

interface ModelInfo { id: string; name: string; vision?: boolean; efforts?: string[]; }

/**
 * GlobalSettings object that provides a configuration UI for LLM API keys.
 *
 * Widgets are first-class Abjects identified by AbjectId. This object registers
 * as a dependent of each widget and listens for 'changed' events to handle
 * user interactions.
 */
export class GlobalSettings extends Abject {
  private llmId?: AbjectId;
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private uiServerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Provider dropdown + single credential panel
  private providerSelectorId?: AbjectId;
  private credentialLabelId?: AbjectId;
  private credentialInputId?: AbjectId;
  private credentialToggleId?: AbjectId;
  private providerModelsLabelId?: AbjectId;
  private activeAiProvider: LLMProviderName = 'anthropic';
  // In-memory cache of unsaved credential values (keyed by provider). Survives
  // provider-switches within the panel; flushed to Storage on Save.
  private credentialValues: Partial<Record<LLMProviderName, string>> = {};

  /**
   * Cached binary-detection state for CLI providers. `undefined` means the
   * detection probe hasn't completed yet; `null` means probed and not found;
   * a string is the resolved binary path (or just the binary name).
   */
  private cliDetected: Partial<Record<LLMProviderName, string | null>> = {};

  /** Detection-status label widget for the AI tab (visible only for CLI providers). */
  private cliStatusLabelId?: AbjectId;
  /** Refresh button next to the detection label. */
  private cliRefreshBtnId?: AbjectId;

  // Per-tier provider + model select widgets
  private tierProviderSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
  private tierModelSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
  /** Per-tier capability label ("vision" / "text-only") next to the model dropdown. */
  private tierCapLabelIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
  /**
   * Per-tier reasoning-effort dropdown. Options come from the selected
   * model's ModelInfo.efforts (plus a leading 'Default' = no override);
   * hidden (never created / options ['—']) for models with no effort knob.
   */
  private tierEffortSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
  /** The effort each tier is meant to show (null = Default/no override). */
  private tierDesiredEfforts: Record<ModelTierName, string | null> = { smart: null, balanced: null, fast: null, code: null };
  /**
   * The model id each tier is meant to show: the saved routing at build time,
   * then the user's latest dropdown pick. Dropdowns render by display name,
   * and the name list changes when a provider's live model fetch lands after
   * the tab was built from the small fallback catalog. Without this id, that
   * refresh silently resets the selection to the list's first model (and a
   * subsequent Save would persist the reset).
   */
  private tierDesiredModelIds: Record<ModelTierName, string | null> = { smart: null, balanced: null, fast: null, code: null };

  // Optional vision-fallback row: provider dropdown (with a leading 'None'),
  // model dropdown, capability label, and the intended model id (same
  // stale-label protection as the tier rows).
  private visionProviderSelectId?: AbjectId;
  private visionModelSelectId?: AbjectId;
  private visionCapLabelId?: AbjectId;
  private visionDesiredModelId: string | null = null;
  /** Provider-dropdown label meaning "no vision fallback configured". */
  private static readonly VISION_NONE_LABEL = 'None';

  // Prompt-cache keepalive: LLMObject pings large prompt prefixes between
  // agent steps so provider caches stay warm. Off by default (it spends
  // cached-read pings to avoid full re-prefills).
  private cacheKeepaliveEnabled = false;
  private cacheKeepaliveCheckboxId?: AbjectId;

  // Tier presets: a named bundle of tier routing + vision fallback. Built-in
  // presets are derived from each provider's defaultTierModels; user-saved
  // presets persist in storage and are listed first.
  private presetSelectId?: AbjectId;
  private presetNameInputId?: AbjectId;
  private presetApplyBtnId?: AbjectId;
  private presetSaveBtnId?: AbjectId;
  private presetDeleteBtnId?: AbjectId;
  private savedPresets: Record<string, TierPreset> = {};

  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private skillBrowserBtnId?: AbjectId;
  private catalogBrowserBtnId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private activeTab: 'ai' | 'auth' | 'permissions' | 'skills' = 'ai';
  private aiContainerId?: AbjectId;
  private authContainerId?: AbjectId;
  private skillsContainerId?: AbjectId;

  // Auth widgets
  private authCheckboxId?: AbjectId;
  private authUserInputId?: AbjectId;
  private authPassInputId?: AbjectId;
  private authPassToggleId?: AbjectId;
  private authSaveBtnId?: AbjectId;

  // Permissions tab
  private permissionsContainerId?: AbjectId;
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
  // Permissions save
  private permsSaveBtnId?: AbjectId;
  // In-memory permissions state
  private fsAllowedPaths: string[] = [];
  private fsReadOnly = false;
  private shellEnabled = true;
  private shellAllowedCmds: string[] = [];
  private shellDeniedCmds: string[] = [];
  private webEnabled = true;
  private webAllowedDomains: string[] = [];
  private webDeniedDomains: string[] = [];
  /** Bus-level capability enforcement for scriptable objects. */
  private capabilityEnforcement: 'off' | 'warn' | 'enforce' = 'warn';
  private capEnforceSelectId?: AbjectId;

  private unmasked: Set<AbjectId> = new Set();

  /**
   * Provider descriptions fetched from LLMObject at init. Used to render
   * the AI tab dropdown, default tier models, credential metadata, and
   * CLI detection — everything that used to be hardcoded per-provider.
   */
  private providerDescriptions: LLMProviderDescription[] = [];
  private providerDescById: Map<string, LLMProviderDescription> = new Map();

  /**
   * Cached model lists per provider, keyed by provider id. Seeded from
   * each description's static `models` list so tier dropdowns render
   * immediately; live `listProviderModels` results override.
   */
  private providerModelCache: Map<string, ModelInfo[]> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'GlobalSettings',
        description:
          'Global configuration UI for LLM API keys.',
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
              {
                name: 'getCapabilityEnforcement',
                description: 'Current bus-level capability enforcement mode for scriptable objects',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'setCapabilityEnforcement',
                description: 'Set the capability enforcement mode: off, warn, or enforce. Emits capabilityEnforcementChanged.',
                parameters: [
                  {
                    name: 'mode',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'off, warn, or enforce',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'capabilityEnforcementChanged',
                description: 'The capability enforcement mode changed; value is the new mode',
                payload: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display settings window', required: true },
          { capability: Capabilities.STORAGE_READ, reason: 'Load saved settings', required: false },
          { capability: Capabilities.STORAGE_WRITE, reason: 'Save settings', required: false },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'settings'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## GlobalSettings Usage Guide

Interface: abjects:global-settings

GlobalSettings provides the global configuration UI for LLM API keys,
authentication, and permissions (filesystem, shell, web access).
It is a singleton (not per-workspace) and persists settings in global Storage.

### Show the Settings Window

  await this.call(
    this.dep('GlobalSettings'), 'show', {});
  // Opens the settings window with tabs: AI, Auth, Permissions

### Hide the Settings Window

  await this.call(
    this.dep('GlobalSettings'), 'hide', {});

### What It Manages
- AI tab: per-provider API keys (self-described by each provider), Ollama URL, per-tier model routing (smart/balanced/fast/code — code is the code-generation tier and rides smart when unrouted), an optional vision fallback, and tier PRESETS (apply/save/delete a named tier configuration; built-in presets derive from each provider's defaults)
- Auth tab: optional HTTP basic auth for the UI server
- Permissions tab: category sub-tabs — Filesystem (allowed paths, read-only mode), Shell (enable + command allow/deny), Web (enable + domain allow/deny), Objects (capability enforcement mode)
- Skills & MCP tab: installed skills (SKILL.md files) and the skills/MCP catalog browser

### IMPORTANT
- API keys are stored in global Storage (persisted across restarts).
- On first boot with no keys configured, the settings window auto-shows.
- Changes take effect after clicking Save and are applied to the LLM object.
- This object manages UI only; use it to show/hide the configuration window.`;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.llmId = await this.requireDep('LLM');
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.uiServerId = await this.requireDep('UIServer');

    // Fetch provider descriptions before reading storage so we can derive
    // the per-provider credential keys, default tier models, and dropdown
    // entries from them — no per-provider hardcoding lives here.
    await this.loadProviderDescriptions();

    const credentials: Partial<Record<LLMProviderName, string>> = {};
    const tierRouting: Record<ModelTierName, TierRoutingRow> = {
      smart: { provider: null, model: null, effort: null },
      balanced: { provider: null, model: null, effort: null },
      fast: { provider: null, model: null, effort: null },
      code: { provider: null, model: null, effort: null },
    };
    const visionFallback: { provider: string | null; model: string | null } = { provider: null, model: null };

    if (this.storageId) {
      // Per-provider credential keys derived from each description's
      // storageSuffix — CLI providers contribute nothing (their auth
      // lives in the binary).
      for (const desc of this.providerDescriptions) {
        if (desc.credentialMode === 'cli' || desc.credentialMode === 'none') continue;
        const value = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: storageKeyFor(desc.storageSuffix) })
        );
        if (value) credentials[desc.id] = value;
      }
      const savedActive = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AI_ACTIVE_PROVIDER })
      );
      if (savedActive && this.providerDescById.has(savedActive)) {
        this.activeAiProvider = savedActive;
      }

      // Load per-tier routing
      for (const tier of TIER_NAMES) {
        tierRouting[tier].provider = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: TIER_STORAGE_KEYS[tier].provider })
        );
        tierRouting[tier].model = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: TIER_STORAGE_KEYS[tier].model })
        );
        tierRouting[tier].effort = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: TIER_STORAGE_KEYS[tier].effort })
        );
      }
      visionFallback.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_VISION_PROVIDER })
      );
      visionFallback.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_VISION_MODEL })
      );
      this.cacheKeepaliveEnabled = (await this.request<boolean | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_CACHE_KEEPALIVE })
      )) === true;

      // Apply each provider's optional `modelMigrations` map to saved
      // tier-routing model ids. Used when an upstream API drops a model
      // name (e.g. codex no longer accepts `gpt-5` under ChatGPT login —
      // migrates to `auto`). Self-described per provider, no special
      // casing here.
      for (const tier of TIER_NAMES) {
        const providerId = tierRouting[tier].provider;
        if (!providerId) continue;
        const migrations = this.descById(providerId)?.modelMigrations;
        if (!migrations) continue;
        const saved = tierRouting[tier].model;
        if (!saved) continue;
        const migrated = migrations[saved];
        if (migrated && migrated !== saved) {
          tierRouting[tier].model = migrated;
          try {
            await this.request(request(this.id, this.storageId, 'set', { key: TIER_STORAGE_KEYS[tier].model, value: migrated }));
          } catch { /* best-effort migration */ }
          log.info(`Migrated ${providerId} ${tier} tier model "${saved}" → "${migrated}"`);
        }
      }

      // Legacy migration from per-workspace keys (anthropic/openai only —
      // those were the only two providers when the legacy keys existed).
      const anthropicSuffix = this.descById('anthropic')?.storageSuffix;
      const openaiSuffix = this.descById('openai')?.storageSuffix;
      if (!credentials.anthropic && !credentials.openai && anthropicSuffix && openaiSuffix) {
        const legacyAnthropic = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: LEGACY_KEY_ANTHROPIC })
        );
        const legacyOpenai = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OPENAI })
        );
        if (legacyAnthropic || legacyOpenai) {
          if (legacyAnthropic) {
            credentials.anthropic = legacyAnthropic;
            await this.request(
              request(this.id, this.storageId, 'set', { key: storageKeyFor(anthropicSuffix), value: legacyAnthropic })
            );
          }
          if (legacyOpenai) {
            credentials.openai = legacyOpenai;
            await this.request(
              request(this.id, this.storageId, 'set', { key: storageKeyFor(openaiSuffix), value: legacyOpenai })
            );
          }
          log.info('Migrated API keys from legacy storage');
        }
      }

      // Legacy migration: old single-provider setting to per-tier routing
      const hasTierRouting = TIER_NAMES.some(t => tierRouting[t].provider);
      if (!hasTierRouting) {
        const oldProvider = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: LEGACY_KEY_PROVIDER })
        );
        const oldDesc = oldProvider ? this.descById(oldProvider) : undefined;
        if (oldProvider && oldDesc) {
          const providerName = oldProvider;
          const defaults = oldDesc.defaultTierModels;

          // For URL-credential providers (Ollama), preserve the old
          // per-tier model keys if present.
          if (oldDesc.credentialMode === 'url') {
            const oldSmart = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL_SMART })
            );
            const oldBalanced = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL_BALANCED })
            );
            const oldFast = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL_FAST })
            );
            const legacyModel = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL })
            );
            tierRouting.smart = { provider: providerName, model: oldSmart || legacyModel || '' };
            tierRouting.balanced = { provider: providerName, model: oldBalanced || legacyModel || '' };
            tierRouting.fast = { provider: providerName, model: oldFast || legacyModel || '' };
          } else {
            for (const tier of TIER_NAMES) {
              tierRouting[tier] = { provider: providerName, model: defaults[tier] };
            }
          }

          // Persist migrated tier routing
          await this.persistTierRouting(tierRouting);
          log.info(`Migrated single-provider '${providerName}' to per-tier routing`);
        }
      }

      await this.applySavedAuthConfig();
      await this.applySavedPermissions();
    }

    // Seed in-memory credential cache so the settings panel opens prefilled.
    this.credentialValues = { ...credentials };

    // Configure all providers and tier routing
    const hasAnyConfig = Object.keys(credentials).length > 0;
    const hasTierConfig = TIER_NAMES.some(t => tierRouting[t].provider);
    if ((hasAnyConfig || hasTierConfig) && this.llmId) {
      await this.configureProviders(credentials, tierRouting, visionFallback);
      log.info('Loaded saved provider configuration');
    } else {
      await this.show();
    }
  }

  private async persistTierRouting(
    tierRouting: Record<ModelTierName, TierRoutingRow>,
  ): Promise<void> {
    if (!this.storageId) return;
    const keys: [string, string | null][] = TIER_NAMES.flatMap((tier): [string, string | null][] => [
      [TIER_STORAGE_KEYS[tier].provider, tierRouting[tier].provider],
      [TIER_STORAGE_KEYS[tier].model, tierRouting[tier].model],
    ]);
    for (const [key, value] of keys) {
      if (value) {
        await this.request(request(this.id, this.storageId, 'set', { key, value }));
      }
    }
    // Effort override: persisted when set, DELETED when cleared back to
    // Default — unlike provider/model, absence is a meaningful state.
    for (const tier of TIER_NAMES) {
      const effort = tierRouting[tier].effort;
      const key = TIER_STORAGE_KEYS[tier].effort;
      if (effort) {
        await this.request(request(this.id, this.storageId, 'set', { key, value: effort }));
      } else {
        await this.request(request(this.id, this.storageId, 'delete', { key })).catch(() => undefined);
      }
    }
  }

  private async configureProviders(
    credentials: Partial<Record<LLMProviderName, string>>,
    tierRouting: Record<ModelTierName, TierRoutingRow>,
    visionFallback?: { provider: string | null; model: string | null },
  ): Promise<void> {
    if (!this.llmId) return;

    // Build tier routing for LLMObject (only include tiers with both provider and model)
    const routing: Record<string, { provider: string; model: string; effort?: string }> = {};
    for (const tier of TIER_NAMES) {
      const { provider, model, effort } = tierRouting[tier];
      if (provider && model) {
        routing[tier] = { provider, model, ...(effort ? { effort } : {}) };
      }
    }

    // Generic per-provider credentials map keyed by provider id, derived
    // from descriptions so adding a new provider doesn't touch this code.
    const credMap: Record<string, string> = {};
    for (const [id, value] of Object.entries(credentials)) {
      if (value) credMap[id] = value;
    }

    await this.request(request(this.id, this.llmId, 'configure', {
      credentials: credMap,
      tierRouting: Object.keys(routing).length > 0 ? routing : undefined,
      // null clears a previously-set fallback; undefined leaves it untouched
      visionFallback: visionFallback === undefined
        ? undefined
        : (visionFallback.provider && visionFallback.model
          ? { provider: visionFallback.provider, model: visionFallback.model }
          : null),
      cacheKeepalive: { enabled: this.cacheKeepaliveEnabled },
    }));
  }

  private setupHandlers(): void {
    this.on('getCapabilityEnforcement', async () => {
      return this.capabilityEnforcement;
    });

    this.on('setCapabilityEnforcement', async (msg: AbjectMessage) => {
      const { mode } = msg.payload as { mode: string };
      if (mode !== 'off' && mode !== 'warn' && mode !== 'enforce') return false;
      this.capabilityEnforcement = mode;
      if (this.storageId) {
        try {
          await this.request(request(this.id, this.storageId, 'set', {
            key: STORAGE_KEY_CAP_ENFORCEMENT, value: mode,
          }));
        } catch { /* persistence is best-effort */ }
      }
      this.changed('capabilityEnforcementChanged', mode);
      return true;
    });

    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('getState', async () => {
      return { visible: !!this.windowId };
    });

    // Handle permission requests from capability objects
    this.on('requestPermission', async (msg: AbjectMessage) => {
      const { type, resource, description, skillName } = msg.payload as {
        type: 'shell' | 'directory' | 'skill_shell' | 'domain';
        resource: string;
        description: string;
        skillName?: string;
      };
      if (type === 'skill_shell' && skillName) {
        return this.showSkillPermissionPrompt(skillName, resource, description);
      }
      return this.showPermissionPrompt(type as 'shell' | 'directory' | 'domain', resource, description);
    });

    // Handle 'changed' events from widget dependents
    this.on('changed', async (m: AbjectMessage) => {
      const { aspect, value } = m.payload as { aspect: string; value?: unknown };
      const fromId = m.routing.from;

      // Permission prompt buttons
      if (this._pendingPermissionPrompt && aspect === 'click') {
        if (fromId === this._promptAcceptOnceBtnId) { this._pendingPermissionPrompt.resolve('accept_once'); return; }
        if (fromId === this._promptAcceptAlwaysBtnId) { this._pendingPermissionPrompt.resolve('accept_always'); return; }
        if (fromId === this._promptDenyBtnId) { this._pendingPermissionPrompt.resolve('deny'); return; }
        if (fromId === this._promptDenyAlwaysBtnId) { this._pendingPermissionPrompt.resolve('deny_always'); return; }
      }

      // Tab bar changed
      if (fromId === this.tabBarId && aspect === 'change') {
        const idx = value as number;
        this.activeTab = idx === 0 ? 'ai' : idx === 1 ? 'auth' : idx === 2 ? 'permissions' : 'skills';
        await this.switchTab();
        return;
      }

      if (fromId === this.permSubTabBarId && aspect === 'change') {
        await this.switchPermCategory(value as number);
        return;
      }

      if (fromId === this.saveBtnId && aspect === 'click') {
        await this.saveSettings();
        return;
      }

      if (fromId === this.credentialToggleId && aspect === 'click') {
        if (this.credentialInputId) {
          await this.toggleMask(this.credentialInputId, this.credentialToggleId);
        }
        return;
      }

      if (fromId === this.providerSelectorId && aspect === 'change') {
        await this.onProviderSelectorChanged();
        return;
      }

      // CLI detection refresh button — re-probe the binary and update the
      // status label without saving anything.
      if (fromId === this.cliRefreshBtnId && aspect === 'click') {
        await this.refreshCliDetection(this.activeAiProvider);
        return;
      }

      // Tier provider dropdown changed -- refresh model list for that tier
      for (const tier of TIER_NAMES) {
        if (fromId === this.tierProviderSelectIds[tier] && aspect === 'change') {
          await this.refreshTierModelOptions(tier);
          // Also kick off a background live fetch for the newly-selected provider
          const providerSelectId = this.tierProviderSelectIds[tier];
          if (providerSelectId) {
            const label = await this.request<string>(
              request(this.id, providerSelectId, 'getValue', {})
            );
            const id = this.idForLabel(label);
            if (id) void this.refreshProviderModels(id);
          }
          return;
        }
      }

      // Tier model dropdown changed -- record the pick + repaint capability label
      for (const tier of TIER_NAMES) {
        if (fromId === this.tierModelSelectIds[tier] && aspect === 'change') {
          await this.onTierModelChanged(tier);
          return;
        }
      }

      // Tier effort dropdown changed -- record the override pick
      for (const tier of TIER_NAMES) {
        if (fromId === this.tierEffortSelectIds[tier] && aspect === 'change') {
          await this.onTierEffortChanged(tier);
          return;
        }
      }

      // Cache keepalive checkbox toggled (persisted + applied on Save)
      if (fromId === this.cacheKeepaliveCheckboxId && aspect === 'change') {
        this.cacheKeepaliveEnabled = value as boolean;
        return;
      }

      // Vision-fallback row dropdowns
      if (fromId === this.visionProviderSelectId && aspect === 'change') {
        await this.refreshVisionModelOptions();
        const provider = await this.visionSelectedProvider();
        if (provider) void this.refreshProviderModels(provider);
        return;
      }
      if (fromId === this.visionModelSelectId && aspect === 'change') {
        await this.onVisionModelChanged();
        return;
      }

      // Tier preset buttons
      if (fromId === this.presetApplyBtnId && aspect === 'click') {
        await this.onPresetApply();
        return;
      }
      if (fromId === this.presetSaveBtnId && aspect === 'click') {
        await this.onPresetSave();
        return;
      }
      if (fromId === this.presetDeleteBtnId && aspect === 'click') {
        await this.onPresetDelete();
        return;
      }

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
        ];
        const target = lists.find(l => l.id && l.id === fromId);
        if (target) {
          try {
            const data = JSON.parse(value as string) as { value: string; actionId: string };
            if (data.actionId === 'remove') {
              target.set(target.get().filter(x => x !== data.value));
              await this.request(request(this.id, target.id!, 'update', { items: toListItems(target.get()) }));
            }
          } catch { /* malformed payload */ }
        }
        return;
      }

      // Filesystem: add path
      if (fromId === this.fsAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.fsPathInputId!, 'getValue', {}));
        if (val && !this.fsAllowedPaths.includes(val)) {
          this.fsAllowedPaths.push(val);
          await this.request(request(this.id, this.fsPathListId!, 'update', { items: toListItems(this.fsAllowedPaths) }));
          await this.request(request(this.id, this.fsPathInputId!, 'update', { text: '' }));
        }
        return;
      }
      if (fromId === this.fsRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.fsPathListId!, 'getValue', {}));
        if (sel) {
          this.fsAllowedPaths = this.fsAllowedPaths.filter(p => p !== sel);
          await this.request(request(this.id, this.fsPathListId!, 'update', { items: toListItems(this.fsAllowedPaths) }));
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
        if (val && !this.shellAllowedCmds.includes(val)) {
          this.shellAllowedCmds.push(val);
          await this.request(request(this.id, this.shellCmdListId!, 'update', { items: toListItems(this.shellAllowedCmds) }));
          await this.request(request(this.id, this.shellCmdInputId!, 'update', { text: '' }));
        }
        return;
      }
      if (fromId === this.shellRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.shellCmdListId!, 'getValue', {}));
        if (sel) {
          this.shellAllowedCmds = this.shellAllowedCmds.filter(c => c !== sel);
          await this.request(request(this.id, this.shellCmdListId!, 'update', { items: toListItems(this.shellAllowedCmds) }));
        }
        return;
      }
      // Shell: add denied command
      if (fromId === this.shellDeniedAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.shellDeniedInputId!, 'getValue', {}));
        if (val && !this.shellDeniedCmds.includes(val)) {
          this.shellDeniedCmds.push(val);
          await this.request(request(this.id, this.shellDeniedListId!, 'update', { items: toListItems(this.shellDeniedCmds) }));
          await this.request(request(this.id, this.shellDeniedInputId!, 'update', { text: '' }));
        }
        return;
      }
      if (fromId === this.shellDeniedRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.shellDeniedListId!, 'getValue', {}));
        if (sel) {
          this.shellDeniedCmds = this.shellDeniedCmds.filter(c => c !== sel);
          await this.request(request(this.id, this.shellDeniedListId!, 'update', { items: toListItems(this.shellDeniedCmds) }));
        }
        return;
      }

      // Web: enabled checkbox
      if (fromId === this.webEnabledCheckboxId && aspect === 'change') {
        this.webEnabled = value as boolean;
        return;
      }
      // Capability enforcement mode select
      if (fromId === this.capEnforceSelectId && aspect === 'change') {
        const mode = value as string;
        if (mode === 'off' || mode === 'warn' || mode === 'enforce') {
          this.capabilityEnforcement = mode;
          this.changed('capabilityEnforcementChanged', mode);
        }
        return;
      }
      // Web: add allowed domain
      if (fromId === this.webAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.webDomainInputId!, 'getValue', {}));
        if (val && !this.webAllowedDomains.includes(val)) {
          this.webAllowedDomains.push(val);
          await this.request(request(this.id, this.webDomainListId!, 'update', { items: toListItems(this.webAllowedDomains) }));
          await this.request(request(this.id, this.webDomainInputId!, 'update', { text: '' }));
        }
        return;
      }
      if (fromId === this.webRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.webDomainListId!, 'getValue', {}));
        if (sel) {
          this.webAllowedDomains = this.webAllowedDomains.filter(d => d !== sel);
          await this.request(request(this.id, this.webDomainListId!, 'update', { items: toListItems(this.webAllowedDomains) }));
        }
        return;
      }
      // Web: add denied domain
      if (fromId === this.webDeniedAddBtnId && aspect === 'click') {
        const val = await this.request<string>(request(this.id, this.webDeniedInputId!, 'getValue', {}));
        if (val && !this.webDeniedDomains.includes(val)) {
          this.webDeniedDomains.push(val);
          await this.request(request(this.id, this.webDeniedListId!, 'update', { items: toListItems(this.webDeniedDomains) }));
          await this.request(request(this.id, this.webDeniedInputId!, 'update', { text: '' }));
        }
        return;
      }
      if (fromId === this.webDeniedRemoveBtnId && aspect === 'click') {
        const sel = await this.request<string | null>(request(this.id, this.webDeniedListId!, 'getValue', {}));
        if (sel) {
          this.webDeniedDomains = this.webDeniedDomains.filter(d => d !== sel);
          await this.request(request(this.id, this.webDeniedListId!, 'update', { items: toListItems(this.webDeniedDomains) }));
        }
        return;
      }

      // Permissions save button
      if (fromId === this.permsSaveBtnId && aspect === 'click') {
        await this.savePermissions();
        return;
      }

      // Text input submit triggers save
      if (aspect === 'submit') {
        if (fromId === this.authUserInputId || fromId === this.authPassInputId) {
          await this.saveAuthSettings();
        } else {
          await this.saveSettings();
        }
      }
    });
  }

  /**
   * Show the global settings window.
   */
  async show(): Promise<boolean> {
    if (this.windowId) return true;

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winW = 520;
    const winH = Math.min(720, Math.max(480, displayInfo.height - 40));
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
          tabs: ['AI', 'Auth', 'Permissions', 'Skills & MCP'],
          closable: false,
          selectedIndex: this.activeTab === 'ai' ? 0 : this.activeTab === 'auth' ? 1 : this.activeTab === 'permissions' ? 2 : 3 },
      ]})
    );
    this.tabBarId = tabBarId;
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    // AI container (scrollable VBox)
    this.aiContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
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

    // Build AI tab content
    await this.buildAiTab();
    // Build Auth tab content
    await this.buildAuthTab();
    // Build Permissions tab content
    await this.buildPermissionsTab();
    // Build Skills & MCP tab content
    await this.buildSkillsTab();
    // Show correct tab
    await this.switchTab();

    this.changed('visibility', true);
    return true;
  }

  /**
   * A styled card for one settings section: rounded panel with an
   * accent-colored numbered title and a wrap-friendly description. Returns
   * the card's layout id — add the section's rows to IT, not to the tab
   * container. autoSize lets the ScrollableVBox measure the card.
   */
  private async sectionCard(parentId: AbjectId, title: string, description: string, descriptionHeight = 18, expanding = false): Promise<AbjectId> {
    // autoSize cards hug their content (right inside a ScrollableVBox);
    // expanding cards fill the parent's remaining space (right in a plain
    // VBox viewport where inner lists should stretch on resize).
    const cardId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: parentId,
        ...(expanding ? {} : { autoSize: true }),
        margins: { top: 14, right: 16, bottom: 14, left: 16 },
        spacing: 8,
        style: { background: this.theme.inputBg, borderColor: this.theme.windowBorder, borderWidth: 1, radius: 10 },
      })
    );
    const { widgetIds: [titleId, descId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: title,
          style: { color: this.theme.accent, fontWeight: 'bold', fontSize: 14 } },
        { type: 'label', windowId: this.windowId, text: description,
          style: { color: this.theme.textDescription, fontSize: 12, wordWrap: true } },
      ]})
    );
    await this.request(request(this.id, cardId, 'addLayoutChild', {
      widgetId: titleId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, cardId, 'addLayoutChild', {
      widgetId: descId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: descriptionHeight },
    }));
    return cardId;
  }

  /** Build Skills & MCP tab content into skillsContainerId. */
  private async buildSkillsTab(): Promise<void> {
    const cId = this.skillsContainerId!;

    const card = await this.sectionCard(cId, 'Skills & MCP',
      'Skills teach agents new abilities (SKILL.md files in ~/.abject/skills/); MCP servers connect external tools and services. Manage what is installed, or browse the catalog to add more.', 34);

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
        { type: 'button', windowId: this.windowId, text: 'Installed Skills',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
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

  /** Build AI tab content into aiContainerId. */
  private async buildAiTab(): Promise<void> {
    const cId = this.aiContainerId!;

    // Load tier routing (credentials already loaded into this.credentialValues in onInit)
    const savedTierRouting: Record<ModelTierName, TierRoutingRow> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
      code: { provider: null, model: null },
    };
    const savedVisionFallback: { provider: string | null; model: string | null } = { provider: null, model: null };
    if (this.storageId) {
      for (const tier of TIER_NAMES) {
        savedTierRouting[tier].provider = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: TIER_STORAGE_KEYS[tier].provider })
        );
        savedTierRouting[tier].model = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: TIER_STORAGE_KEYS[tier].model })
        );
        savedTierRouting[tier].effort = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: TIER_STORAGE_KEYS[tier].effort })
        );
      }
      savedVisionFallback.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_VISION_PROVIDER })
      );
      savedVisionFallback.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_VISION_MODEL })
      );
    }

    this.savedPresets = await this.loadSavedPresets();

    // Populate cache with defaults synchronously so the UI can render now.
    // Live per-provider fetches run lazily (when the user looks at a provider
    // or hits Save) to avoid blocking the window paint.
    this.populateDefaultModelCache();

    // ── 1 · Credentials (card) ──
    const credCard = await this.sectionCard(cId, '1 · Credentials',
      'Pick a provider and enter its API key. Configured keys persist across restarts.');

    // Provider selector row
    const providerSelectRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: credCard,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, credCard, 'addLayoutChild', {
      widgetId: providerSelectRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [providerPickerLabelId, providerSelectorId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Provider',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'select', windowId: this.windowId,
          options: this.providerLabels(),
          selectedIndex: Math.max(0, this.providerIds().indexOf(this.activeAiProvider)) },
      ]})
    );
    this.providerSelectorId = providerSelectorId;
    await this.request(request(this.id, providerPickerLabelId, 'update', {}));
    await this.request(request(this.id, providerSelectRowId, 'addLayoutChild', {
      widgetId: providerPickerLabelId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 65, height: 32 },
    }));
    await this.request(request(this.id, this.providerSelectorId, 'addDependent', {}));
    await this.request(request(this.id, providerSelectRowId, 'addLayoutChild', {
      widgetId: this.providerSelectorId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Credential label (shows "Anthropic API Key" etc.)
    const activeDesc = this.descById(this.activeAiProvider);
    const credentialLabel = activeDesc?.credentialLabel ?? activeDesc?.label ?? this.activeAiProvider;
    const credentialPlaceholder = activeDesc?.credentialPlaceholder ?? '';
    const isUrl = activeDesc?.credentialMode === 'url';
    const { widgetIds: [credentialLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: credentialLabel,
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    this.credentialLabelId = credentialLabelId;
    await this.request(request(this.id, credCard, 'addLayoutChild', {
      widgetId: this.credentialLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Credential input row (input + Show/Hide toggle)
    const credentialRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: credCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, credCard, 'addLayoutChild', {
      widgetId: credentialRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const initialValue = this.credentialValues[this.activeAiProvider]
      ?? (isUrl ? credentialPlaceholder : '');
    const { widgetIds: [credentialInputId, credentialToggleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId,
          placeholder: credentialPlaceholder,
          masked: !isUrl,
          text: initialValue },
        { type: 'button', windowId: this.windowId, text: 'Show',
          style: isUrl ? { disabled: true } : undefined },
      ]})
    );
    this.credentialInputId = credentialInputId;
    this.credentialToggleId = credentialToggleId;
    await this.request(request(this.id, this.credentialInputId, 'addDependent', {}));
    await this.request(request(this.id, credentialRowId, 'addLayoutChild', {
      widgetId: this.credentialInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.credentialToggleId, 'addDependent', {}));
    await this.request(request(this.id, credentialRowId, 'addLayoutChild', {
      widgetId: this.credentialToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // CLI detection-status row — visible only when the active provider is
    // a CLI provider (claude-cli / codex-cli). Replaces the credential
    // value with a "Detected at /path" or "not detected" line plus a
    // Refresh button. For non-CLI providers the row stays present but
    // collapsed (height 0) so the layout slot is stable across switches.
    const isCli = this.isCliProvider(this.activeAiProvider);
    const cliRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: credCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, credCard, 'addLayoutChild', {
      widgetId: cliRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: isCli ? 28 : 0 },
    }));
    const { widgetIds: [cliStatusLabelId, cliRefreshBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId,
          text: this.formatCliStatus(this.activeAiProvider),
          style: { color: this.cliStatusColor(this.activeAiProvider), fontSize: 12, visible: isCli } },
        { type: 'button', windowId: this.windowId, text: 'Refresh',
          style: { visible: isCli, fontSize: 12 } },
      ]})
    );
    this.cliStatusLabelId = cliStatusLabelId;
    this.cliRefreshBtnId = cliRefreshBtnId;
    await this.request(request(this.id, this.cliRefreshBtnId, 'addDependent', {}));
    await this.request(request(this.id, cliRowId, 'addLayoutChild', {
      widgetId: this.cliStatusLabelId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: isCli ? 28 : 0 },
    }));
    await this.request(request(this.id, cliRowId, 'addLayoutChild', {
      widgetId: this.cliRefreshBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: isCli ? 28 : 0 },
    }));

    // Disable / hide the credential input for CLI providers so the user
    // doesn't enter an irrelevant API key.
    if (isCli) {
      await this.request(request(this.id, this.credentialInputId, 'update', {
        style: { visible: false },
      }));
      await this.request(request(this.id, this.credentialToggleId, 'update', {
        style: { visible: false },
      }));
      await this.request(request(this.id, this.credentialLabelId, 'update', {
        style: { visible: false },
      }));
    }

    // Kick off detection in the background — first show or after switch.
    if (isCli) void this.refreshCliDetection(this.activeAiProvider);

    // Models list label (read-only, shows discovered models for the active provider)
    const { widgetIds: [providerModelsLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId,
          text: this.formatModelListLine(this.activeAiProvider),
          style: { color: this.theme.textDescription, fontSize: 12 } },
      ]})
    );
    this.providerModelsLabelId = providerModelsLabelId;
    await this.request(request(this.id, credCard, 'addLayoutChild', {
      widgetId: this.providerModelsLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // ── 2 · Preset (card) ──
    // [Preset] [dropdown: saved + built-in] [Apply] [Delete], then
    // [Name] [text input] [Save Preset]. Built-ins are derived from each
    // provider's defaultTierModels, so every provider ships a starter preset.
    {
      const presetCard = await this.sectionCard(cId, '2 · Preset',
        'Start from a preset — a built-in provider default or one you saved — then fine-tune the tiers below. You can also save the current tier setup under a name.', 34);

      const presetRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: presetCard,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, presetCard, 'addLayoutChild', {
        widgetId: presetRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      const { widgetIds: [presetLabelId, presetSelectId, applyBtnId, deleteBtnId] } =
        await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: 'Preset',
              style: { color: this.theme.textHeading, fontSize: 13 } },
            { type: 'select', windowId: this.windowId,
              options: this.presetOptionNames(), selectedIndex: 0 },
            { type: 'button', windowId: this.windowId, text: 'Apply', style: { fontSize: 12 } },
            { type: 'button', windowId: this.windowId, text: 'Delete', style: { fontSize: 12 } },
          ]})
        );
      this.presetSelectId = presetSelectId;
      this.presetApplyBtnId = applyBtnId;
      this.presetDeleteBtnId = deleteBtnId;
      await this.request(request(this.id, presetSelectId, 'addDependent', {}));
      await this.request(request(this.id, applyBtnId, 'addDependent', {}));
      await this.request(request(this.id, deleteBtnId, 'addDependent', {}));
      await this.request(request(this.id, presetRowId, 'addLayoutChildren', {
        children: [
          { widgetId: presetLabelId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 65, height: 32 } },
          { widgetId: presetSelectId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 32 } },
          { widgetId: applyBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 70, height: 32 } },
          { widgetId: deleteBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 70, height: 32 } },
        ],
      }));

      const nameRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: presetCard,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, presetCard, 'addLayoutChild', {
        widgetId: nameRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      const { widgetIds: [nameLabelId, nameInputId, savePresetBtnId] } =
        await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: 'Name',
              style: { color: this.theme.textHeading, fontSize: 13 } },
            { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. Everyday / Cheap / Coding' },
            { type: 'button', windowId: this.windowId, text: 'Save Preset', style: { fontSize: 12 } },
          ]})
        );
      this.presetNameInputId = nameInputId;
      this.presetSaveBtnId = savePresetBtnId;
      await this.request(request(this.id, savePresetBtnId, 'addDependent', {}));
      await this.request(request(this.id, nameRowId, 'addLayoutChildren', {
        children: [
          { widgetId: nameLabelId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 65, height: 32 } },
          { widgetId: nameInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 32 } },
          { widgetId: savePresetBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 110, height: 32 } },
        ],
      }));
    }

    // ── 3 · Model Tiers (card) ──
    const tiersCard = await this.sectionCard(cId, '3 · Model Tiers',
      'Choose a provider and model for each quality tier. Code is the code-generation tier (agents draft source on it; leave it matching Smart unless you want a dedicated coding model). Screenshots and pasted images need a 👁 vision model; the optional Vision row is the fallback used for image steps when a tier\'s model is text-only.', 86);

    // Per-tier rows: [Label] [Provider dropdown] [Model dropdown]
    for (let i = 0; i < TIER_NAMES.length; i++) {
      const tier = TIER_NAMES[i];
      const tierLabel = TIER_LABELS[i];
      const savedProvider = savedTierRouting[tier].provider as LLMProviderName | null;
      const savedModel = savedTierRouting[tier].model;
      this.tierDesiredModelIds[tier] = savedModel;

      // Row container
      const tierRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: tiersCard,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, tiersCard, 'addLayoutChild', {
        widgetId: tierRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      // Tier label
      const { widgetIds: [tierLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: tierLabel,
            style: { color: this.theme.textHeading, fontSize: 13 } },
        ]})
      );
      await this.request(request(this.id, tierRowId, 'addLayoutChild', {
        widgetId: tierLabelId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 65, height: 32 },
      }));

      // Provider dropdown
      const providerIds = this.providerIds();
      const providerIdx = savedProvider ? providerIds.indexOf(savedProvider) : 0;
      const { widgetIds: [providerSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'select', windowId: this.windowId,
            options: this.providerLabels(),
            selectedIndex: providerIdx >= 0 ? providerIdx : 0 },
        ]})
      );
      this.tierProviderSelectIds[tier] = providerSelectId;
      await this.request(request(this.id, providerSelectId, 'addDependent', {}));
      await this.request(request(this.id, tierRowId, 'addLayoutChild', {
        widgetId: providerSelectId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 120, height: 32 },
      }));

      // Model dropdown (populated from provider's model list)
      const activeProvider = savedProvider && providerIds.includes(savedProvider) ? savedProvider : providerIds[0];
      const modelList = this.providerModelCache.get(activeProvider) ?? [];
      const modelOptions = modelList.length > 0
        ? modelList.map(m => m.name)
        : ['(no models)'];
      let modelIdx = 0;
      if (savedModel && modelList.length > 0) {
        const idx = modelList.findIndex(m => m.id === savedModel);
        if (idx >= 0) modelIdx = idx;
      }

      const { widgetIds: [modelSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'select', windowId: this.windowId,
            options: modelOptions,
            selectedIndex: modelIdx },
        ]})
      );
      this.tierModelSelectIds[tier] = modelSelectId;
      await this.request(request(this.id, modelSelectId, 'addDependent', {}));
      await this.request(request(this.id, tierRowId, 'addLayoutChild', {
        widgetId: modelSelectId,
        sizePolicy: { horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      // Reasoning-effort dropdown: 'Default' + the selected model's supported
      // levels. Disabled (single '—') when the model has no effort knob.
      const savedEffort = savedTierRouting[tier].effort ?? null;
      this.tierDesiredEfforts[tier] = savedEffort;
      const effortOptions = this.effortOptionsFor(activeProvider, modelList[modelIdx]?.id ?? null);
      const effortIdx = savedEffort ? Math.max(0, effortOptions.indexOf(savedEffort)) : 0;
      const { widgetIds: [effortSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'select', windowId: this.windowId,
            options: effortOptions,
            selectedIndex: effortIdx,
            style: effortOptions.length <= 1 ? { disabled: true } : undefined },
        ]})
      );
      this.tierEffortSelectIds[tier] = effortSelectId;
      await this.request(request(this.id, effortSelectId, 'addDependent', {}));
      await this.request(request(this.id, tierRowId, 'addLayoutChild', {
        widgetId: effortSelectId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 92, height: 32 },
      }));

      // Capability label for the selected model (vision / text-only)
      const initialCap = this.capabilityLabelFor(activeProvider, modelOptions[modelIdx] ?? '');
      const { widgetIds: [capLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: initialCap.text,
            style: { color: initialCap.color, fontSize: 11 } },
        ]})
      );
      this.tierCapLabelIds[tier] = capLabelId;
      await this.request(request(this.id, tierRowId, 'addLayoutChild', {
        widgetId: capLabelId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 62, height: 32 },
      }));
    }

    // ── Vision fallback row ──
    // Optional substitute model for image-bearing steps when a tier's model
    // is text-only. 'None' disables it. Same row shape as the tiers.
    {
      this.visionDesiredModelId = savedVisionFallback.model;

      const visionRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: tiersCard,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, tiersCard, 'addLayoutChild', {
        widgetId: visionRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      const { widgetIds: [visionLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'Vision',
            style: { color: this.theme.textHeading, fontSize: 13 } },
        ]})
      );
      await this.request(request(this.id, visionRowId, 'addLayoutChild', {
        widgetId: visionLabelId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 65, height: 32 },
      }));

      const providerIds = this.providerIds();
      const savedProvider = savedVisionFallback.provider;
      const providerOptions = [GlobalSettings.VISION_NONE_LABEL, ...this.providerLabels()];
      const savedProviderIdx = savedProvider ? providerIds.indexOf(savedProvider) : -1;
      const { widgetIds: [visionProviderSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'select', windowId: this.windowId,
            options: providerOptions,
            selectedIndex: savedProviderIdx >= 0 ? savedProviderIdx + 1 : 0 },
        ]})
      );
      this.visionProviderSelectId = visionProviderSelectId;
      await this.request(request(this.id, visionProviderSelectId, 'addDependent', {}));
      await this.request(request(this.id, visionRowId, 'addLayoutChild', {
        widgetId: visionProviderSelectId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 120, height: 32 },
      }));

      const visionActiveProvider = savedProviderIdx >= 0 ? (savedProvider as LLMProviderName) : null;
      const visionModelList = visionActiveProvider ? (this.providerModelCache.get(visionActiveProvider) ?? []) : [];
      const visionModelOptions = visionActiveProvider
        ? (visionModelList.length > 0 ? visionModelList.map(m => m.name) : ['(no models)'])
        : ['(none)'];
      let visionModelIdx = 0;
      if (savedVisionFallback.model && visionModelList.length > 0) {
        const idx = visionModelList.findIndex(m => m.id === savedVisionFallback.model);
        if (idx >= 0) visionModelIdx = idx;
      }

      const { widgetIds: [visionModelSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'select', windowId: this.windowId,
            options: visionModelOptions,
            selectedIndex: visionModelIdx },
        ]})
      );
      this.visionModelSelectId = visionModelSelectId;
      await this.request(request(this.id, visionModelSelectId, 'addDependent', {}));
      await this.request(request(this.id, visionRowId, 'addLayoutChild', {
        widgetId: visionModelSelectId,
        sizePolicy: { horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      const visionCap = visionActiveProvider
        ? this.capabilityLabelFor(visionActiveProvider, visionModelOptions[visionModelIdx] ?? '')
        : { text: '', color: this.theme.textTertiary };
      const { widgetIds: [visionCapLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: visionCap.text,
            style: { color: visionCap.color, fontSize: 11 } },
        ]})
      );
      this.visionCapLabelId = visionCapLabelId;
      await this.request(request(this.id, visionRowId, 'addLayoutChild', {
        widgetId: visionCapLabelId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 62, height: 32 },
      }));
    }

    // ── Cache keepalive row ──
    // Opt-in: LLMObject re-reads large prompt prefixes on a timer between
    // agent steps so provider prompt caches stay warm (cached reads instead
    // of full re-prefills after the pause). Spends money, hence off by default.
    {
      const { widgetIds: [keepaliveCheckboxId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'checkbox', windowId: this.windowId,
            checked: this.cacheKeepaliveEnabled,
            text: 'Keep prompt caches warm between agent steps (pings spend cached-read tokens to avoid re-prefills)' },
        ]})
      );
      this.cacheKeepaliveCheckboxId = keepaliveCheckboxId;
      await this.request(request(this.id, keepaliveCheckboxId, 'addDependent', {}));
      await this.request(request(this.id, tiersCard, 'addLayoutChild', {
        widgetId: keepaliveCheckboxId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 28 },
      }));
    }

    // Save button row (HBox: spacer + button)
    const saveRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: saveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, saveRowId, 'addLayoutSpacer', {}));

    const { widgetIds: [saveBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Save Settings',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]})
    );
    this.saveBtnId = saveBtnId;
    await this.request(request(this.id, this.saveBtnId, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, 'addLayoutChild', {
      widgetId: this.saveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 130, height: 36 },
    }));

    // Kick off background live fetches for providers the user is currently
    // looking at or that a tier is pointed at. Fire-and-forget so the window
    // paints immediately. Each fetch updates its dropdown/label when it lands.
    const toPrefetch = new Set<LLMProviderName>([this.activeAiProvider]);
    for (const tier of TIER_NAMES) {
      const p = savedTierRouting[tier].provider;
      if (p && this.providerDescById.has(p)) toPrefetch.add(p);
    }
    if (savedVisionFallback.provider && this.providerDescById.has(savedVisionFallback.provider)) {
      toPrefetch.add(savedVisionFallback.provider);
    }
    for (const p of toPrefetch) {
      void this.refreshProviderModels(p);
    }
  }

  /** Build Auth tab content into authContainerId. */
  private async buildAuthTab(): Promise<void> {
    const cId = this.authContainerId!;

    // Auth section header
    const { widgetIds: [authHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Authentication',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Load saved auth settings
    let savedAuthEnabled = false;
    let savedAuthUser = '';
    let savedAuthPass = '';
    if (this.storageId) {
      const enabled = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTH_ENABLED })
      );
      savedAuthEnabled = enabled === 'true';
      savedAuthUser = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTH_USER })
      ) ?? '';
      savedAuthPass = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTH_PASS })
      ) ?? '';
    }

    // Enable auth checkbox row
    const authEnableRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
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
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authUserLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, this.authUserInputId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
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
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authPassLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Password input row (HBox: input + toggle)
    const authPassRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
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
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.providerSelectorId = undefined;
    this.credentialLabelId = undefined;
    this.credentialInputId = undefined;
    this.credentialToggleId = undefined;
    this.providerModelsLabelId = undefined;
    this.tierProviderSelectIds = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
    this.tierModelSelectIds = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
    this.tierCapLabelIds = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
    this.tierEffortSelectIds = { smart: undefined, balanced: undefined, fast: undefined, code: undefined };
    this.visionProviderSelectId = undefined;
    this.visionModelSelectId = undefined;
    this.visionCapLabelId = undefined;
    this.cacheKeepaliveCheckboxId = undefined;
    this.presetSelectId = undefined;
    this.presetNameInputId = undefined;
    this.presetApplyBtnId = undefined;
    this.presetSaveBtnId = undefined;
    this.presetDeleteBtnId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
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
    this.webEnabledCheckboxId = undefined;
    this.webDomainInputId = undefined;
    this.webAddBtnId = undefined;
    this.webDomainListId = undefined;
    this.webRemoveBtnId = undefined;
    this.webDeniedInputId = undefined;
    this.webDeniedAddBtnId = undefined;
    this.webDeniedListId = undefined;
    this.webDeniedRemoveBtnId = undefined;
    this.capEnforceSelectId = undefined;
    this.permsSaveBtnId = undefined;
    this.unmasked.clear();

    this.changed('visibility', false);
    return true;
  }

  /** Show/hide tab containers based on activeTab. */
  private async switchTab(): Promise<void> {
    if (!this.aiContainerId || !this.authContainerId || !this.permissionsContainerId || !this.skillsContainerId) return;
    await this.request(request(this.id, this.aiContainerId, 'update', { style: { visible: this.activeTab === 'ai' } }));
    await this.request(request(this.id, this.authContainerId, 'update', { style: { visible: this.activeTab === 'auth' } }));
    await this.request(request(this.id, this.permissionsContainerId, 'update', { style: { visible: this.activeTab === 'permissions' } }));
    await this.request(request(this.id, this.skillsContainerId, 'update', { style: { visible: this.activeTab === 'skills' } }));
  }

  // ========== HELPERS ==========

  private async setStatus(text: string, color = this.theme.textDescription): Promise<void> {
    if (!this.statusLabelId) return;
    await this.request(
      request(this.id, this.statusLabelId, 'update', {
        text, style: { color },
      })
    );
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

  private async setSaveControlsDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    const ids: (AbjectId | undefined)[] = [
      this.saveBtnId, this.providerSelectorId, this.credentialInputId, this.credentialToggleId,
      ...Object.values(this.tierProviderSelectIds),
      ...Object.values(this.tierModelSelectIds),
      this.visionProviderSelectId,
      this.visionModelSelectId,
      this.presetSelectId,
      this.presetApplyBtnId,
      this.presetSaveBtnId,
      this.presetDeleteBtnId,
    ];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  // ========== TIER PRESETS ==========

  /**
   * Built-in starter presets, one per provider, derived from each
   * description's defaultTierModels — no per-provider knowledge here. The
   * vision fallback is the provider's first vision-capable catalog model.
   */
  private builtinPresets(): Array<{ name: string; preset: TierPreset }> {
    const out: Array<{ name: string; preset: TierPreset }> = [];
    for (const desc of this.providerDescriptions) {
      const d = desc.defaultTierModels;
      if (!d || !d.smart) continue;
      const routing: TierPreset['routing'] = {};
      for (const tier of TIER_NAMES) {
        routing[tier] = { provider: desc.id, model: d[tier] || d.smart };
      }
      const visionModel = desc.models.find(m => m.vision === true);
      out.push({
        name: `${desc.label} defaults`,
        preset: { routing, vision: visionModel ? { provider: desc.id, model: visionModel.id } : null },
      });
    }
    return out;
  }

  /** Dropdown options: user-saved presets first, then the built-ins. */
  private presetOptionNames(): string[] {
    const names = [...Object.keys(this.savedPresets).sort(), ...this.builtinPresets().map(b => b.name)];
    return names.length > 0 ? names : ['(no presets)'];
  }

  /** Saved presets win a name collision with a built-in. */
  private resolvePreset(name: string): TierPreset | undefined {
    return this.savedPresets[name] ?? this.builtinPresets().find(b => b.name === name)?.preset;
  }

  private async loadSavedPresets(): Promise<Record<string, TierPreset>> {
    if (!this.storageId) return {};
    try {
      const raw = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_PRESETS })
      );
      if (!raw || typeof raw !== 'string') return {};
      const parsed = JSON.parse(raw) as Record<string, TierPreset>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async persistSavedPresets(): Promise<void> {
    if (!this.storageId) return;
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_TIER_PRESETS, value: JSON.stringify(this.savedPresets),
    }));
  }

  private async refreshPresetOptions(): Promise<void> {
    if (!this.presetSelectId) return;
    try {
      await this.request(request(this.id, this.presetSelectId, 'update', {
        options: this.presetOptionNames(), selectedIndex: 0,
      }));
    } catch { /* widget gone */ }
  }

  /** Read the tier + vision dropdowns as a preset (current UI state). */
  private async readCurrentTierSelections(): Promise<TierPreset> {
    const routing: TierPreset['routing'] = {};
    for (const tier of TIER_NAMES) {
      const providerSelectId = this.tierProviderSelectIds[tier];
      const modelSelectId = this.tierModelSelectIds[tier];
      if (!providerSelectId || !modelSelectId) continue;
      const providerLabel = await this.request<string>(
        request(this.id, providerSelectId, 'getValue', {})
      );
      const providerName = this.idForLabel(providerLabel);
      const modelName = await this.request<string>(
        request(this.id, modelSelectId, 'getValue', {})
      );
      if (providerName && modelName && modelName !== '(no models)') {
        const modelList = this.providerModelCache.get(providerName) ?? [];
        const info = modelList.find(m => m.name === modelName);
        const effort = this.tierDesiredEfforts[tier];
        routing[tier] = { provider: providerName, model: info ? info.id : modelName, ...(effort ? { effort } : {}) };
      }
    }
    let vision: TierPreset['vision'] = null;
    if (this.visionProviderSelectId && this.visionModelSelectId) {
      const provider = await this.visionSelectedProvider();
      if (provider) {
        const modelName = await this.request<string>(
          request(this.id, this.visionModelSelectId, 'getValue', {})
        );
        if (modelName && modelName !== '(no models)' && modelName !== '(none)') {
          const modelList = this.providerModelCache.get(provider) ?? [];
          const info = modelList.find(m => m.name === modelName);
          vision = { provider, model: info ? info.id : modelName };
        }
      }
    }
    return { routing, vision };
  }

  /**
   * Point every tier/vision dropdown at the preset's routing, then run the
   * normal save path (persist + configure + status toast) so applying a
   * preset behaves exactly like picking the values by hand and hitting Save.
   */
  private async applyTierPreset(preset: TierPreset): Promise<void> {
    const providerIds = this.providerIds();
    const providerLabels = this.providerLabels();
    for (const tier of TIER_NAMES) {
      const entry = preset.routing[tier];
      const providerSelectId = this.tierProviderSelectIds[tier];
      if (!entry || !providerSelectId) continue;
      const pIdx = providerIds.indexOf(entry.provider);
      if (pIdx < 0) continue; // provider not known in this build — leave the tier as-is
      await this.request(request(this.id, providerSelectId, 'update', {
        options: providerLabels, selectedIndex: pIdx,
      }));
      this.tierDesiredModelIds[tier] = entry.model;
      this.tierDesiredEfforts[tier] = entry.effort ?? null;
      await this.refreshTierModelOptions(tier);
      void this.refreshProviderModels(entry.provider);
    }
    if (this.visionProviderSelectId) {
      const providerOptions = [GlobalSettings.VISION_NONE_LABEL, ...providerLabels];
      const vIdx = preset.vision ? providerIds.indexOf(preset.vision.provider) : -1;
      await this.request(request(this.id, this.visionProviderSelectId, 'update', {
        options: providerOptions, selectedIndex: vIdx >= 0 ? vIdx + 1 : 0,
      }));
      this.visionDesiredModelId = vIdx >= 0 ? (preset.vision?.model ?? null) : null;
      await this.refreshVisionModelOptions();
    }
    await this.saveSettings();
  }

  private async onPresetApply(): Promise<void> {
    if (!this.presetSelectId) return;
    const name = await this.request<string>(
      request(this.id, this.presetSelectId, 'getValue', {})
    );
    const preset = name ? this.resolvePreset(name) : undefined;
    if (!preset) {
      await this.setStatus('Pick a preset to apply.', this.theme.statusWarning);
      return;
    }
    await this.applyTierPreset(preset);
  }

  private async onPresetSave(): Promise<void> {
    if (!this.presetNameInputId) return;
    const name = (await this.request<string>(
      request(this.id, this.presetNameInputId, 'getValue', {})
    ))?.trim();
    if (!name) {
      await this.setStatus('Give the preset a name first.', this.theme.statusWarning);
      return;
    }
    const preset = await this.readCurrentTierSelections();
    if (Object.keys(preset.routing).length === 0) {
      await this.setStatus('Configure at least one tier before saving a preset.', this.theme.statusWarning);
      return;
    }
    this.savedPresets[name] = preset;
    await this.persistSavedPresets();
    await this.refreshPresetOptions();
    await this.setStatus(`Preset '${name}' saved.`, this.theme.statusSuccess);
  }

  private async onPresetDelete(): Promise<void> {
    if (!this.presetSelectId) return;
    const name = await this.request<string>(
      request(this.id, this.presetSelectId, 'getValue', {})
    );
    if (!name || !this.savedPresets[name]) {
      await this.setStatus('Only saved presets can be deleted (built-ins stay).', this.theme.statusWarning);
      return;
    }
    delete this.savedPresets[name];
    await this.persistSavedPresets();
    await this.refreshPresetOptions();
    await this.setStatus(`Preset '${name}' deleted.`, this.theme.statusSuccess);
  }

  // ========== TIER MODEL REFRESH ==========

  /** Tracks providers whose live models have been fetched this session. */
  private fetchedLiveModels: Set<LLMProviderName> = new Set();
  /** Tracks in-flight fetches so we don't kick off duplicates. */
  private modelFetchInFlight: Set<LLMProviderName> = new Set();

  /**
   * Seed the model cache from each provider's description so the UI can
   * render immediately. Live fetches happen lazily via refreshProviderModels.
   *
   * Runs on every AI-tab (re)build, so it must NOT clobber a list already
   * fetched live this session: doing so reverts the dropdown to the small
   * fallback catalog, and the `fetchedLiveModels` guard then blocks a re-fetch,
   * leaving the tier dropdowns stuck on the fallback after the first reopen.
   * Only seed providers we have not fetched live yet.
   */
  private populateDefaultModelCache(): void {
    for (const desc of this.providerDescriptions) {
      if (this.fetchedLiveModels.has(desc.id)) continue;
      this.providerModelCache.set(desc.id, [...desc.models]);
    }
  }

  /**
   * Fetch provider descriptions from LLMObject and index them by id. Run
   * once at init, before any storage reads — every per-provider thing
   * (credential keys, dropdown labels, default tier models, CLI binary
   * detection) flows from this list.
   */
  private async loadProviderDescriptions(): Promise<void> {
    if (!this.llmId) return;
    try {
      this.providerDescriptions = await this.request<LLMProviderDescription[]>(
        request(this.id, this.llmId, 'listProviderDescriptions', {})
      );
    } catch (err) {
      log.warn(`Failed to load provider descriptions: ${err instanceof Error ? err.message : String(err)}`);
      this.providerDescriptions = [];
    }
    this.providerDescById = new Map(this.providerDescriptions.map(d => [d.id, d]));
    if (!this.providerDescById.has(this.activeAiProvider) && this.providerDescriptions.length > 0) {
      this.activeAiProvider = this.providerDescriptions[0].id;
    }
  }

  // ── Provider description helpers ─────────────────────────────────────

  /** Provider id → description (or undefined if unknown). */
  private descById(id: string): LLMProviderDescription | undefined {
    return this.providerDescById.get(id);
  }

  /** All provider ids in dropdown order. */
  private providerIds(): string[] {
    return this.providerDescriptions.map(d => d.id);
  }

  /** All provider labels in dropdown order. */
  private providerLabels(): string[] {
    return this.providerDescriptions.map(d => d.label);
  }

  /** Resolve a dropdown label back to its provider id. */
  private idForLabel(label: string): string | undefined {
    return this.providerDescriptions.find(d => d.label === label)?.id;
  }

  /** Resolve a provider id to its display label. */
  private labelForId(id: string): string | undefined {
    return this.providerDescById.get(id)?.label;
  }

  /** True when a provider authenticates via an external CLI binary. */
  private isCliProvider(id: string): boolean {
    return this.providerDescById.get(id)?.credentialMode === 'cli';
  }

  /** Default URL for a `url` provider (Ollama). */
  private defaultUrlPlaceholder(id: string): string {
    return this.providerDescById.get(id)?.credentialPlaceholder ?? '';
  }

  /**
   * Lazily refresh one provider's model list from its API. Non-blocking when
   * awaitResult is false — call-sites can fire-and-forget to avoid freezing
   * the UI. Updates visible widgets (provider-panel label and any matching
   * tier dropdown) when the fetch completes.
   */
  private async refreshProviderModels(
    name: LLMProviderName,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!this.llmId) return;
    if (this.modelFetchInFlight.has(name)) return;
    if (!opts.force && this.fetchedLiveModels.has(name)) return;
    // Skip providers that have no way to reach their models. URL-keyed
    // (Ollama) and CLI-driven providers don't need credentials — they
    // fetch via the binary or local URL.
    const desc = this.descById(name);
    const noCredentialNeeded = !!desc && (desc.credentialMode === 'url' || desc.credentialMode === 'cli');
    if (!noCredentialNeeded && !this.credentialValues[name]) return;

    this.modelFetchInFlight.add(name);
    try {
      const payload: Record<string, unknown> = { provider: name };
      if (desc?.credentialMode === 'url') {
        payload.ollamaUrl = this.credentialValues[name] || desc.credentialPlaceholder || '';
      }
      const models = await this.request<ModelInfo[]>(
        request(this.id, this.llmId, 'listProviderModels', payload)
      );
      if (models.length > 0) {
        log.info(`refreshProviderModels: ${name} returned ${models.length} models`);
        this.providerModelCache.set(name, models);
        this.fetchedLiveModels.add(name);
        await this.onProviderModelsUpdated(name);
      } else {
        log.warn(`refreshProviderModels: ${name} returned an empty model list; keeping the fallback catalog`);
      }
    } catch (err) {
      // Network error or provider not registered; keep defaults but surface why.
      log.warn(`refreshProviderModels: ${name} live model fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.modelFetchInFlight.delete(name);
    }
  }

  /** Update any visible widgets that depend on the given provider's model list. */
  private async onProviderModelsUpdated(name: LLMProviderName): Promise<void> {
    if (!this.windowId) return;
    if (name === this.activeAiProvider && this.providerModelsLabelId) {
      await this.request(request(this.id, this.providerModelsLabelId, 'update', {
        text: this.formatModelListLine(name),
      }));
    }
    // Update any tier dropdown currently pointed at this provider
    for (const tier of TIER_NAMES) {
      const providerSelectId = this.tierProviderSelectIds[tier];
      if (!providerSelectId) continue;
      try {
        const label = await this.request<string>(
          request(this.id, providerSelectId, 'getValue', {})
        );
        const tierProvider = this.idForLabel(label);
        if (tierProvider === name) {
          await this.refreshTierModelOptions(tier);
        }
      } catch { /* widget gone */ }
    }

    // Same for the vision-fallback row
    if (this.visionProviderSelectId) {
      try {
        if (await this.visionSelectedProvider() === name) {
          await this.refreshVisionModelOptions();
        }
      } catch { /* widget gone */ }
    }
  }

  /** Format the models-list label for a provider ("3 models: Claude Opus 4.7, …"). */
  private formatModelListLine(provider: LLMProviderName): string {
    const desc = this.descById(provider);
    const models = this.providerModelCache.get(provider) ?? [];
    if (models.length === 0) {
      return desc?.credentialMode === 'url'
        ? 'No local models found. Start the service and save.'
        : 'Save credentials to discover models.';
    }
    const names = models.slice(0, 6).map(m => m.name);
    const more = models.length > names.length ? `, …(+${models.length - names.length})` : '';
    const visionCount = models.filter(m => m.vision === true).length;
    const visionNote = visionCount > 0 ? ` (${visionCount} with vision)` : '';
    return `${models.length} models${visionNote}: ${names.join(', ')}${more}`;
  }

  /** Handle provider-dropdown change: snapshot the current input, then swap panel. */
  private async onProviderSelectorChanged(): Promise<void> {
    if (!this.providerSelectorId || !this.credentialInputId || !this.credentialLabelId || !this.credentialToggleId) return;

    // Snapshot the current input into credentialValues for the old provider
    const oldValue = await this.request<string>(request(this.id, this.credentialInputId, 'getValue', {}));
    this.credentialValues[this.activeAiProvider] = oldValue ?? '';

    // Figure out the new provider
    const newLabel = await this.request<string>(request(this.id, this.providerSelectorId, 'getValue', {}));
    const newProvider = this.idForLabel(newLabel) ?? this.providerIds()[0];
    this.activeAiProvider = newProvider;

    const desc = this.descById(newProvider);
    if (!desc) return;
    const isCli = desc.credentialMode === 'cli';
    const isUrl = desc.credentialMode === 'url';
    const newValue = this.credentialValues[newProvider]
      ?? (isUrl ? (desc.credentialPlaceholder ?? '') : '');

    // Reset masking state for the input
    this.unmasked.delete(this.credentialInputId);

    // Toggle credential input vs CLI detection row based on provider type.
    await this.request(request(this.id, this.credentialLabelId, 'update', {
      text: desc.credentialLabel ?? desc.label,
      style: { visible: !isCli, color: this.theme.textHeading, fontSize: 13 },
    }));
    await this.request(request(this.id, this.credentialInputId, 'update', {
      text: newValue,
      placeholder: desc.credentialPlaceholder ?? '',
      masked: !isUrl,
      style: { visible: !isCli },
    }));
    await this.request(request(this.id, this.credentialToggleId, 'update', {
      text: 'Show',
      style: isUrl
        ? { disabled: true, visible: !isCli }
        : { disabled: false, visible: !isCli },
    }));
    if (this.cliStatusLabelId) {
      await this.request(request(this.id, this.cliStatusLabelId, 'update', {
        text: this.formatCliStatus(newProvider),
        style: { color: this.cliStatusColor(newProvider), fontSize: 12, visible: isCli },
      }));
    }
    if (this.cliRefreshBtnId) {
      await this.request(request(this.id, this.cliRefreshBtnId, 'update', {
        style: { visible: isCli, fontSize: 12 },
      }));
    }
    if (this.providerModelsLabelId) {
      await this.request(request(this.id, this.providerModelsLabelId, 'update', {
        text: this.formatModelListLine(newProvider),
      }));
    }

    // Background refresh for the newly-active provider (idempotent + deduped)
    if (isCli) void this.refreshCliDetection(newProvider);
    else void this.refreshProviderModels(newProvider);
  }

  // ── CLI detection helpers ─────────────────────────────────────────

  /** Re-probe whether the CLI binary for `provider` is on PATH and update the status label. */
  private async refreshCliDetection(provider: LLMProviderName): Promise<void> {
    const desc = this.descById(provider);
    if (!desc?.cli) return;
    const bin = desc.cli.binary;
    let path: string | null = null;
    try {
      // Spawn the CLI's --version flag through ShellExecutor if available,
      // otherwise via a direct child_process spawn. Either approach is
      // fine for a one-shot detection probe.
      path = await this.probeCliPath(bin);
    } catch { path = null; }
    this.cliDetected[provider] = path;

    // Update label only if we're still on this provider in the panel.
    if (this.activeAiProvider === provider && this.cliStatusLabelId) {
      await this.request(request(this.id, this.cliStatusLabelId, 'update', {
        text: this.formatCliStatus(provider),
        style: { color: this.cliStatusColor(provider), fontSize: 12, visible: true },
      }));
    }
  }

  /** Run `<bin> --version` and return the binary name on success, or null. */
  private async probeCliPath(bin: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        // Lazily require `node:child_process` so the browser bundle never
        // pulls it (this Abject runs server-side, but be defensive).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let resolved = false;
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          proc.kill('SIGTERM');
          resolve(null);
        }, 5_000);
        proc.on('error', () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        });
        proc.on('close', (code) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(code === 0 ? bin : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  private formatCliStatus(provider: LLMProviderName): string {
    const cli = this.descById(provider)?.cli;
    const bin = cli?.binary ?? '';
    const detected = this.cliDetected[provider];
    if (detected === undefined) return `Detecting \`${bin}\` …`;
    if (detected === null) {
      const hint = cli?.installHint ?? '';
      return `\`${bin}\` not found on PATH. ${hint}`;
    }
    return `Detected \`${bin}\` on PATH. The CLI manages its own auth — run \`${bin} login\` if you haven't already.`;
  }

  private cliStatusColor(provider: LLMProviderName): string {
    const detected = this.cliDetected[provider];
    if (detected === undefined) return this.theme.textTertiary;
    if (detected === null)      return this.theme.statusErrorBright;
    return this.theme.statusSuccess;
  }

  /**
   * Refresh the model dropdown for a specific tier after its provider changed
   * or the model cache was updated. Preserves the current selection when
   * still present in the new list.
   */
  private async refreshTierModelOptions(tier: ModelTierName): Promise<void> {
    const providerSelectId = this.tierProviderSelectIds[tier];
    const modelSelectId = this.tierModelSelectIds[tier];
    if (!providerSelectId || !modelSelectId) return;

    const providerLabel = await this.request<string>(
      request(this.id, providerSelectId, 'getValue', {})
    );
    const providerName = this.idForLabel(providerLabel) ?? this.providerIds()[0];

    const currentLabel = await this.request<string>(
      request(this.id, modelSelectId, 'getValue', {})
    );

    const modelList = this.providerModelCache.get(providerName) ?? [];
    const options = modelList.length > 0
      ? modelList.map(m => m.name)
      : ['(no models)'];

    // Prefer the tier's intended model id (saved routing / the user's last
    // pick): the visible label is stale when this refresh replaces a fallback
    // catalog with the live list, whose display names differ.
    const desired = this.tierDesiredModelIds[tier];
    const desiredIdx = desired ? modelList.findIndex(m => m.id === desired) : -1;
    const keepIdx = desiredIdx >= 0 ? desiredIdx : options.indexOf(currentLabel);
    const selectedIndex = keepIdx >= 0 ? keepIdx : 0;

    await this.request(
      request(this.id, modelSelectId, 'update', { options, selectedIndex })
    );
    await this.updateTierCapabilityLabel(tier, providerName, options[selectedIndex] ?? '');
    await this.refreshTierEffortOptions(tier, providerName, modelList[selectedIndex]?.id ?? null);
  }

  // ── Tier capability display ───────────────────────────────────────

  /**
   * Capability text + color for a provider model, from the cached model
   * list's vision flag. Unknown capability renders as empty rather than
   * guessing.
   */
  private capabilityLabelFor(provider: LLMProviderName, modelName: string): { text: string; color: string } {
    const models = this.providerModelCache.get(provider) ?? [];
    const info = models.find(m => m.name === modelName);
    if (info?.vision === true) return { text: '👁 vision', color: this.theme.statusSuccess };
    if (info?.vision === false) return { text: 'text-only', color: this.theme.textTertiary };
    return { text: '', color: this.theme.textTertiary };
  }

  /** Repaint one tier's capability label for the given provider + model name. */
  private async updateTierCapabilityLabel(tier: ModelTierName, provider: LLMProviderName, modelName: string): Promise<void> {
    const capLabelId = this.tierCapLabelIds[tier];
    if (!capLabelId) return;
    const cap = this.capabilityLabelFor(provider, modelName);
    try {
      await this.request(request(this.id, capLabelId, 'update', {
        text: cap.text,
        style: { color: cap.color, fontSize: 11 },
      }));
    } catch { /* widget gone */ }
  }

  // ── Vision-fallback row ───────────────────────────────────────────

  /** The vision row's selected provider id, or null when set to 'None'. */
  private async visionSelectedProvider(): Promise<LLMProviderName | null> {
    if (!this.visionProviderSelectId) return null;
    const label = await this.request<string>(
      request(this.id, this.visionProviderSelectId, 'getValue', {})
    );
    if (label === GlobalSettings.VISION_NONE_LABEL) return null;
    return this.idForLabel(label) ?? null;
  }

  /** Rebuild the vision row's model options after its provider changed or models arrived. */
  private async refreshVisionModelOptions(): Promise<void> {
    if (!this.visionModelSelectId) return;
    const provider = await this.visionSelectedProvider();

    if (!provider) {
      await this.request(
        request(this.id, this.visionModelSelectId, 'update', { options: ['(none)'], selectedIndex: 0 })
      );
      await this.updateVisionCapLabel('', this.theme.textTertiary);
      return;
    }

    const currentLabel = await this.request<string>(
      request(this.id, this.visionModelSelectId, 'getValue', {})
    );
    const modelList = this.providerModelCache.get(provider) ?? [];
    const options = modelList.length > 0 ? modelList.map(m => m.name) : ['(no models)'];

    // Same intended-id preservation as the tier rows, then a vision-friendly
    // default: this row exists to pick a vision model, so land on the first
    // one rather than the list head when there is no better selection.
    const desiredIdx = this.visionDesiredModelId
      ? modelList.findIndex(m => m.id === this.visionDesiredModelId)
      : -1;
    let keepIdx = desiredIdx >= 0 ? desiredIdx : options.indexOf(currentLabel);
    if (keepIdx < 0) keepIdx = modelList.findIndex(m => m.vision === true);
    const selectedIndex = keepIdx >= 0 ? keepIdx : 0;

    await this.request(
      request(this.id, this.visionModelSelectId, 'update', { options, selectedIndex })
    );
    const cap = this.capabilityLabelFor(provider, options[selectedIndex] ?? '');
    await this.updateVisionCapLabel(cap.text, cap.color);
  }

  /** The user picked a vision-fallback model: remember the id + repaint the label. */
  private async onVisionModelChanged(): Promise<void> {
    if (!this.visionModelSelectId) return;
    const provider = await this.visionSelectedProvider();
    if (!provider) return;
    try {
      const modelName = await this.request<string>(
        request(this.id, this.visionModelSelectId, 'getValue', {})
      );
      const info = (this.providerModelCache.get(provider) ?? []).find(m => m.name === modelName);
      this.visionDesiredModelId = info?.id ?? null;
      const cap = this.capabilityLabelFor(provider, modelName);
      await this.updateVisionCapLabel(cap.text, cap.color);
    } catch { /* widget gone */ }
  }

  private async updateVisionCapLabel(text: string, color: string): Promise<void> {
    if (!this.visionCapLabelId) return;
    try {
      await this.request(request(this.id, this.visionCapLabelId, 'update', {
        text,
        style: { color, fontSize: 11 },
      }));
    } catch { /* widget gone */ }
  }

  /**
   * The user picked a model for a tier: remember the picked id (so later
   * option-list refreshes keep the selection) and repaint the capability label.
   */
  private async onTierModelChanged(tier: ModelTierName): Promise<void> {
    const providerSelectId = this.tierProviderSelectIds[tier];
    const modelSelectId = this.tierModelSelectIds[tier];
    if (!providerSelectId || !modelSelectId) return;
    try {
      const providerLabel = await this.request<string>(
        request(this.id, providerSelectId, 'getValue', {})
      );
      const provider = this.idForLabel(providerLabel) ?? this.providerIds()[0];
      const modelName = await this.request<string>(
        request(this.id, modelSelectId, 'getValue', {})
      );
      const info = (this.providerModelCache.get(provider) ?? []).find(m => m.name === modelName);
      this.tierDesiredModelIds[tier] = info?.id ?? null;
      await this.updateTierCapabilityLabel(tier, provider, modelName);
      await this.refreshTierEffortOptions(tier, provider, info?.id ?? null);
    } catch { /* widget gone */ }
  }

  /**
   * Effort dropdown options for one provider model: 'Default' plus the
   * model's supported levels (from ModelInfo.efforts). A model with no
   * selectable effort gets the single placeholder '—'.
   */
  private effortOptionsFor(provider: LLMProviderName, modelId: string | null): string[] {
    if (!modelId) return ['—'];
    const info = (this.providerModelCache.get(provider) ?? []).find(m => m.id === modelId);
    const efforts = info?.efforts ?? [];
    if (efforts.length === 0) return ['—'];
    return [EFFORT_DEFAULT_LABEL, ...efforts];
  }

  /**
   * Repaint a tier's effort dropdown for a newly-selected model: new option
   * list, previous pick kept when the new model supports it, disabled state
   * when there is nothing to select. Clears the desired effort when the new
   * model doesn't support the old level (so Save persists reality).
   */
  private async refreshTierEffortOptions(tier: ModelTierName, provider: LLMProviderName, modelId: string | null): Promise<void> {
    const effortSelectId = this.tierEffortSelectIds[tier];
    if (!effortSelectId) return;
    const options = this.effortOptionsFor(provider, modelId);
    const desired = this.tierDesiredEfforts[tier];
    let selectedIndex = 0;
    if (desired) {
      const idx = options.indexOf(desired);
      if (idx >= 0) selectedIndex = idx;
      else this.tierDesiredEfforts[tier] = null;
    }
    try {
      await this.request(request(this.id, effortSelectId, 'update', {
        options,
        selectedIndex,
        style: { disabled: options.length <= 1 },
      }));
    } catch { /* widget gone */ }
  }

  /** Record a tier's effort-dropdown pick ('Default'/'—' → no override). */
  private async onTierEffortChanged(tier: ModelTierName): Promise<void> {
    const effortSelectId = this.tierEffortSelectIds[tier];
    if (!effortSelectId) return;
    try {
      const value = await this.request<string>(
        request(this.id, effortSelectId, 'getValue', {})
      );
      this.tierDesiredEfforts[tier] = (value === EFFORT_DEFAULT_LABEL || value === '—') ? null : value;
    } catch { /* widget gone */ }
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
   * Load saved auth config from Storage and apply to BackendUI.
   * Called once during onInit so Storage-based settings override env vars.
   */
  private async applySavedAuthConfig(): Promise<void> {
    if (!this.storageId || !this.uiServerId) return;

    const enabledStr = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTH_ENABLED })
    );
    // Only override if settings have been explicitly saved
    if (enabledStr === null) return;

    const enabled = enabledStr === 'true';
    const username = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTH_USER })
    ) ?? '';
    const password = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AUTH_PASS })
    ) ?? '';

    await this.request(
      request(this.id, this.uiServerId, 'updateAuth', { enabled, username, password })
    );
    log.info(`Applied saved auth config (enabled=${enabled})`);
  }

  /**
   * Read auth widget values, save to storage, and apply to BackendUI.
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

    if (enabled && (!username || !password)) {
      await this.setStatus('Username and password are required.', this.theme.statusErrorBright);
      return;
    }

    // Persist to storage
    if (this.storageId) {
      await this.request(
        request(this.id, this.storageId, 'set', { key: STORAGE_KEY_AUTH_ENABLED, value: String(enabled) })
      );
      await this.request(
        request(this.id, this.storageId, 'set', { key: STORAGE_KEY_AUTH_USER, value: username })
      );
      await this.request(
        request(this.id, this.storageId, 'set', { key: STORAGE_KEY_AUTH_PASS, value: password })
      );
    }

    // Apply to BackendUI (updates config, clears sessions, disconnects frontend)
    if (this.uiServerId) {
      await this.request(
        request(this.id, this.uiServerId, 'updateAuth', { enabled, username, password })
      );
    }

    log.info(`Auth settings saved (enabled=${enabled})`);
    await this.setStatus(enabled ? 'Auth enabled. Reconnecting...' : 'Auth disabled.');
  }

  // ========== PERMISSIONS TAB ==========

  /** Build Permissions tab content into permissionsContainerId. */
  private async buildPermissionsTab(): Promise<void> {
    const cId = this.permissionsContainerId!;

    // Load saved permission values
    if (this.storageId) {
      const fsPathsJson = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_FS_ALLOWED_PATHS })
      );
      if (fsPathsJson) { try { this.fsAllowedPaths = JSON.parse(fsPathsJson); } catch { /* ignore */ } }

      const fsRo = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_FS_READ_ONLY })
      );
      if (fsRo !== null) this.fsReadOnly = fsRo === 'true';

      const shellEn = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_SHELL_ENABLED })
      );
      if (shellEn !== null) this.shellEnabled = shellEn === 'true';

      const shellAllowJson = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_SHELL_ALLOWED_CMDS })
      );
      if (shellAllowJson) { try { this.shellAllowedCmds = JSON.parse(shellAllowJson); } catch { /* ignore */ } }

      const shellDenyJson = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_SHELL_DENIED_CMDS })
      );
      if (shellDenyJson) { try { this.shellDeniedCmds = JSON.parse(shellDenyJson); } catch { /* ignore */ } }

      const webEn = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_WEB_ENABLED })
      );
      if (webEn !== null) this.webEnabled = webEn === 'true';

      const webAllowJson = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_WEB_ALLOWED_DOMAINS })
      );
      if (webAllowJson) { try { this.webAllowedDomains = JSON.parse(webAllowJson); } catch { /* ignore */ } }

      const webDenyJson = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_WEB_DENIED_DOMAINS })
      );
      if (webDenyJson) { try { this.webDeniedDomains = JSON.parse(webDenyJson); } catch { /* ignore */ } }

      const capMode = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_CAP_ENFORCEMENT })
      );
      if (capMode === 'off' || capMode === 'warn' || capMode === 'enforce') {
        this.capabilityEnforcement = capMode;
        // Re-announce so a wired interceptor picks up the persisted mode.
        this.changed('capabilityEnforcementChanged', capMode);
      }
    }

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
          tabs: ['Filesystem', 'Shell', 'Web', 'Objects'],
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

    const { widgetIds: [platLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: platformText,
          style: { color: this.theme.textTertiary, fontSize: 11 } },
      ]})
    );
    this.platformLabelId = platLabelId;
    await this.request(request(this.id, shellCard, 'addLayoutChild', {
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
    await this.request(request(this.id, shellCard, 'addLayoutChild', {
      widgetId: this.shellEnabledCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    {
      const ed = await this.stringListEditor(shellCard, 'Allowed commands', 'e.g. git, ls, npm', this.shellAllowedCmds);
      this.shellCmdInputId = ed.inputId;
      this.shellAddBtnId = ed.addBtnId;
      this.shellCmdListId = ed.listId;
      this.shellRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(shellCard, 'Denied commands (always refused)', 'e.g. rm, sudo', this.shellDeniedCmds);
      this.shellDeniedInputId = ed.inputId;
      this.shellDeniedAddBtnId = ed.addBtnId;
      this.shellDeniedListId = ed.listId;
      this.shellDeniedRemoveBtnId = ed.removeBtnId;
    }

    // ── Web card ──
    const webCard = await this.sectionCard(cId, 'Web',
      'Which domains agents may reach over HTTP. An empty allowed list permits every domain except the denied ones.', 34, true);

    const { widgetIds: [webEnCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.webEnabled, text: 'Enable HTTP requests' },
      ]})
    );
    this.webEnabledCheckboxId = webEnCheckId;
    await this.request(request(this.id, this.webEnabledCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, webCard, 'addLayoutChild', {
      widgetId: this.webEnabledCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    {
      const ed = await this.stringListEditor(webCard, 'Allowed domains (empty = allow all)', 'e.g. api.example.com', this.webAllowedDomains);
      this.webDomainInputId = ed.inputId;
      this.webAddBtnId = ed.addBtnId;
      this.webDomainListId = ed.listId;
      this.webRemoveBtnId = ed.removeBtnId;
    }
    {
      const ed = await this.stringListEditor(webCard, 'Denied domains (always refused)', 'e.g. evil.example.com', this.webDeniedDomains);
      this.webDeniedInputId = ed.inputId;
      this.webDeniedAddBtnId = ed.addBtnId;
      this.webDeniedListId = ed.listId;
      this.webDeniedRemoveBtnId = ed.removeBtnId;
    }

    // ── Objects card (capability enforcement) ──
    const objectsCard = await this.sectionCard(cId, 'Objects',
      'Created objects declare the capabilities they need. Choose how strictly those declarations are enforced: off runs no checks, warn logs undeclared use, enforce blocks it.', 34, true);

    const capRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: objectsCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, objectsCard, 'addLayoutChild', {
      widgetId: capRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));
    const capModes = ['off', 'warn', 'enforce'];
    const { widgetIds: [capLabelId, capEnfSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Enforcement',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'select', windowId: this.windowId, options: capModes,
          selectedIndex: Math.max(0, capModes.indexOf(this.capabilityEnforcement)) },
      ]})
    );
    this.capEnforceSelectId = capEnfSelectId;
    await this.request(request(this.id, this.capEnforceSelectId, 'addDependent', {}));
    await this.request(request(this.id, capRowId, 'addLayoutChild', {
      widgetId: capLabelId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 30 },
    }));
    await this.request(request(this.id, capRowId, 'addLayoutChild', {
      widgetId: this.capEnforceSelectId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 160, height: 30 },
    }));

    // Only the selected category's card is visible.
    this.permCategoryCardIds = [fsCard, shellCard, webCard, objectsCard];
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
   * caller stores them in.
   */
  private async stringListEditor(
    cardId: AbjectId,
    label: string,
    placeholder: string,
    items: string[],
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
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));

    const { widgetIds: [removeBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected', style: { fontSize: 12 } },
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
   * Persist permission state to Storage and propagate to target objects.
   */
  private async savePermissions(): Promise<void> {
    if (!this.storageId) return;

    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_FS_ALLOWED_PATHS, value: JSON.stringify(this.fsAllowedPaths),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_FS_READ_ONLY, value: String(this.fsReadOnly),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_SHELL_ENABLED, value: String(this.shellEnabled),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_SHELL_ALLOWED_CMDS, value: JSON.stringify(this.shellAllowedCmds),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_SHELL_DENIED_CMDS, value: JSON.stringify(this.shellDeniedCmds),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_WEB_ENABLED, value: String(this.webEnabled),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_WEB_ALLOWED_DOMAINS, value: JSON.stringify(this.webAllowedDomains),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_WEB_DENIED_DOMAINS, value: JSON.stringify(this.webDeniedDomains),
    }));
    await this.request(request(this.id, this.storageId, 'set', {
      key: STORAGE_KEY_CAP_ENFORCEMENT, value: this.capabilityEnforcement,
    }));

    await this.propagatePermissions();
    log.info('Permissions saved and propagated');
    await this.setStatus('Permissions saved!');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Permission Prompt
  // ═══════════════════════════════════════════════════════════════════

  /** Active permission prompt: resolves when user clicks a button. */
  private _pendingPermissionPrompt?: { resolve: (decision: string) => void };
  private _promptWindowId?: AbjectId;
  private _promptAcceptOnceBtnId?: AbjectId;
  private _promptAcceptAlwaysBtnId?: AbjectId;
  private _promptDenyBtnId?: AbjectId;
  private _promptDenyAlwaysBtnId?: AbjectId;

  private async showPermissionPrompt(
    type: 'shell' | 'directory' | 'domain',
    resource: string,
    description: string,
  ): Promise<{ decision: string }> {
    if (!this.widgetManagerId) return { decision: 'deny' };

    // If there's already a prompt open, deny (don't stack prompts)
    if (this._pendingPermissionPrompt) return { decision: 'deny' };

    try {
      const title = type === 'shell' ? 'Shell Permission'
        : type === 'domain' ? 'Network Permission'
        : 'Filesystem Permission';
      const windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createWindowAbject', {
          title,
          rect: { x: 300, y: 200, width: 440, height: 200 },
          resizable: false,
          chromeless: false,
        })
      );
      this._promptWindowId = windowId;

      const layoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createVBox', {
          windowId,
          margins: { top: 16, right: 16, bottom: 16, left: 16 },
          spacing: 12,
        })
      );

      // Description label
      const { widgetIds: [descLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'label', windowId, text: description,
            style: { color: this.theme.textPrimary, fontSize: 14, wordWrap: true } },
        ]})
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: descLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 40 },
      }));

      // Resource label
      const { widgetIds: [resLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'label', windowId, text: `"${resource}"`,
            style: { color: this.theme.statusWarning, fontSize: 13, fontFamily: 'monospace' } },
        ]})
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: resLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 24 },
      }));

      // Button row
      const btnRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createHBox', {
          windowId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: btnRowId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 36 },
      }));

      const { widgetIds: [acceptOnceId, acceptAlwaysId, denyId, denyAlwaysId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'button', windowId, text: 'Once', style: { fontSize: 12 } },
          { type: 'button', windowId, text: 'Always', style: { fontSize: 12, color: this.theme.statusSuccess } },
          { type: 'button', windowId, text: 'Deny', style: { fontSize: 12 } },
          { type: 'button', windowId, text: 'Never', style: { fontSize: 12, color: this.theme.statusError } },
        ]})
      );

      this._promptAcceptOnceBtnId = acceptOnceId;
      this._promptAcceptAlwaysBtnId = acceptAlwaysId;
      this._promptDenyBtnId = denyId;
      this._promptDenyAlwaysBtnId = denyAlwaysId;

      for (const btnId of [acceptOnceId, acceptAlwaysId, denyId, denyAlwaysId]) {
        await this.request(request(this.id, btnId, 'addDependent', {}));
        await this.request(request(this.id, btnRowId, 'addLayoutChild', {
          widgetId: btnId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));
      }

      // Wait for user decision
      const decision = await new Promise<string>((resolve) => {
        this._pendingPermissionPrompt = { resolve };
      });

      // Persist "always" decisions to storage and update lists
      if (decision === 'accept_always') {
        if (type === 'shell') {
          if (!this.shellAllowedCmds.includes(resource)) this.shellAllowedCmds.push(resource);
        } else {
          if (!this.fsAllowedPaths.includes(resource)) this.fsAllowedPaths.push(resource);
        }
        await this.savePermissions();
      } else if (decision === 'deny_always') {
        if (type === 'shell') {
          if (!this.shellDeniedCmds.includes(resource)) this.shellDeniedCmds.push(resource);
        }
        await this.savePermissions();
      }

      return { decision };
    } finally {
      // Clean up prompt window
      this._pendingPermissionPrompt = undefined;
      if (this._promptWindowId && this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', {
            windowId: this._promptWindowId,
          }));
        } catch { /* best effort */ }
      }
      this._promptWindowId = undefined;
      this._promptAcceptOnceBtnId = undefined;
      this._promptAcceptAlwaysBtnId = undefined;
      this._promptDenyBtnId = undefined;
      this._promptDenyAlwaysBtnId = undefined;
    }
  }

  /** Per-skill allowed commands (persisted). */
  private skillPermissions: Map<string, string[]> = new Map();

  private async showSkillPermissionPrompt(
    skillName: string,
    cmdName: string,
    description: string,
  ): Promise<{ decision: string }> {
    if (!this.widgetManagerId) return { decision: 'deny' };
    if (this._pendingPermissionPrompt) return { decision: 'deny' };

    try {
      const windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createWindowAbject', {
          title: 'Skill Permission',
          rect: { x: 300, y: 200, width: 440, height: 180 },
          resizable: false,
          chromeless: false,
        })
      );
      this._promptWindowId = windowId;

      const layoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createVBox', {
          windowId,
          margins: { top: 16, right: 16, bottom: 16, left: 16 },
          spacing: 12,
        })
      );

      const { widgetIds: [descLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'label', windowId, text: description,
            style: { color: this.theme.textPrimary, fontSize: 14, wordWrap: true } },
        ]})
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: descLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 40 },
      }));

      const { widgetIds: [resLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'label', windowId, text: `"${cmdName}"`,
            style: { color: this.theme.statusWarning, fontSize: 13, fontFamily: 'monospace' } },
        ]})
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: resLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 24 },
      }));

      // Two buttons only for skills: Allow / Deny
      const btnRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createHBox', {
          windowId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, layoutId, 'addLayoutChild', {
        widgetId: btnRowId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 36 },
      }));

      const { widgetIds: [allowBtnId, denyBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'button', windowId, text: 'Allow', style: { fontSize: 12, color: this.theme.statusSuccess } },
          { type: 'button', windowId, text: 'Deny', style: { fontSize: 12, color: this.theme.statusError } },
        ]})
      );

      this._promptAcceptAlwaysBtnId = allowBtnId;
      this._promptDenyBtnId = denyBtnId;

      for (const btnId of [allowBtnId, denyBtnId]) {
        await this.request(request(this.id, btnId, 'addDependent', {}));
        await this.request(request(this.id, btnRowId, 'addLayoutChild', {
          widgetId: btnId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));
      }

      const decision = await new Promise<string>((resolve) => {
        this._pendingPermissionPrompt = { resolve };
      });

      // Persist if allowed
      if (decision === 'accept_always' || decision === 'accept') {
        const existing = this.skillPermissions.get(skillName) ?? [];
        if (!existing.includes(cmdName)) existing.push(cmdName);
        this.skillPermissions.set(skillName, existing);

        // Persist skill permissions + skill names index
        if (this.storageId) {
          try {
            await this.request(request(this.id, this.storageId, 'set', {
              key: `global-settings:skillPerms:${skillName}`,
              value: JSON.stringify(existing),
            }));
            const allNames = Array.from(this.skillPermissions.keys());
            await this.request(request(this.id, this.storageId, 'set', {
              key: 'global-settings:skillPermNames',
              value: JSON.stringify(allNames),
            }));
          } catch { /* best effort */ }
        }

        // Propagate to ShellExecutor
        const shellId = await this.discoverDep('ShellExecutor');
        if (shellId) {
          try {
            await this.request(request(this.id, shellId, 'updateSkillPermissions', {
              skillName,
              allowedCommands: existing,
            }));
          } catch { /* best effort */ }
        }

        return { decision: 'accept' };
      }

      return { decision: 'deny' };
    } finally {
      this._pendingPermissionPrompt = undefined;
      if (this._promptWindowId && this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', {
            windowId: this._promptWindowId,
          }));
        } catch { /* best effort */ }
      }
      this._promptWindowId = undefined;
      this._promptAcceptAlwaysBtnId = undefined;
      this._promptDenyBtnId = undefined;
    }
  }

  /** Whether we've claimed permissions authority on capability objects. */
  private authorityClaimed = false;

  /**
   * Claim permissions authority on capability objects (first-caller-wins).
   * Called once during the first propagation. After this, only messages
   * from GlobalSettings will be accepted by updatePermissions handlers.
   */
  private async claimAuthority(): Promise<void> {
    if (this.authorityClaimed) return;
    this.authorityClaimed = true;

    const targets = ['HostFileSystem', 'ShellExecutor', 'HttpClient', 'StreamClient'];
    for (const name of targets) {
      const id = await this.discoverDep(name);
      if (id) {
        try {
          await this.request(request(this.id, id, 'setPermissionsAuthority', {}));
        } catch { /* may already be claimed on restart */ }
      }
    }
  }

  private async propagatePermissions(): Promise<void> {
    await this.claimAuthority();

    // Filesystem permissions
    const fsId = await this.discoverDep('HostFileSystem');
    if (fsId) {
      try {
        await this.request(request(this.id, fsId, 'updatePermissions', {
          allowedPaths: this.fsAllowedPaths,
          readOnly: this.fsReadOnly,
        }));
      } catch (e) { log.warn('Failed to propagate FS permissions', e); }
    }

    // Shell permissions
    const shellId = await this.discoverDep('ShellExecutor');
    if (shellId) {
      try {
        await this.request(request(this.id, shellId, 'updatePermissions', {
          enabled: this.shellEnabled,
          allowedCommands: this.shellAllowedCmds,
          deniedCommands: this.shellDeniedCmds,
        }));
      } catch (e) { log.warn('Failed to propagate Shell permissions', e); }
    }

    // Web/HTTP permissions
    const httpId = await this.discoverDep('HttpClient');
    if (httpId) {
      try {
        await this.request(request(this.id, httpId, 'updatePermissions', {
          enabled: this.webEnabled,
          allowedDomains: this.webAllowedDomains,
          deniedDomains: this.webDeniedDomains,
        }));
      } catch (e) { log.warn('Failed to propagate HTTP permissions', e); }
    }

    // Streaming permissions follow the web settings: streams are web access
    // held open, so one switch and one domain list govern both.
    const streamId = await this.discoverDep('StreamClient');
    if (streamId) {
      try {
        await this.request(request(this.id, streamId, 'updatePermissions', {
          enabled: this.webEnabled,
          allowedDomains: this.webAllowedDomains,
          deniedDomains: this.webDeniedDomains,
        }));
      } catch (e) { log.warn('Failed to propagate stream permissions', e); }
    }

    // Capability enforcement mode: announced as an event; the bootstrap wires
    // the bus interceptor as a dependent and applies the mode on each change.
    this.changed('capabilityEnforcementChanged', this.capabilityEnforcement);
  }

  /**
   * Load saved permissions from Storage and propagate to target objects.
   * Called once during onInit so persisted permissions are applied on boot.
   */
  private async applySavedPermissions(): Promise<void> {
    if (!this.storageId) return;

    // Check if any permission keys have been saved
    const fsRo = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_FS_READ_ONLY })
    );
    const shellEn = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_SHELL_ENABLED })
    );
    const webEn = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_WEB_ENABLED })
    );

    // Always claim authority, even if no permissions saved yet
    await this.claimAuthority();

    // Capability enforcement mode loads independently of the permission keys
    // so the interceptor hears the persisted (or default) mode at boot.
    const capMode = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_CAP_ENFORCEMENT })
    );
    if (capMode === 'off' || capMode === 'warn' || capMode === 'enforce') {
      this.capabilityEnforcement = capMode;
    }

    // Only propagate saved values if at least one permission key was explicitly saved
    if (fsRo === null && shellEn === null && webEn === null) {
      this.changed('capabilityEnforcementChanged', this.capabilityEnforcement);
      return;
    }

    // Load all values
    if (fsRo !== null) this.fsReadOnly = fsRo === 'true';
    if (shellEn !== null) this.shellEnabled = shellEn === 'true';
    if (webEn !== null) this.webEnabled = webEn === 'true';

    const fsPathsJson = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_FS_ALLOWED_PATHS })
    );
    if (fsPathsJson) { try { this.fsAllowedPaths = JSON.parse(fsPathsJson); } catch { /* ignore */ } }

    const shellAllowJson = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_SHELL_ALLOWED_CMDS })
    );
    if (shellAllowJson) { try { this.shellAllowedCmds = JSON.parse(shellAllowJson); } catch { /* ignore */ } }

    const shellDenyJson = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_SHELL_DENIED_CMDS })
    );
    if (shellDenyJson) { try { this.shellDeniedCmds = JSON.parse(shellDenyJson); } catch { /* ignore */ } }

    const webAllowJson = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_WEB_ALLOWED_DOMAINS })
    );
    if (webAllowJson) { try { this.webAllowedDomains = JSON.parse(webAllowJson); } catch { /* ignore */ } }

    const webDenyJson = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: STORAGE_KEY_WEB_DENIED_DOMAINS })
    );
    if (webDenyJson) { try { this.webDeniedDomains = JSON.parse(webDenyJson); } catch { /* ignore */ } }

    await this.propagatePermissions();

    // Load per-skill permissions
    const skillNamesJson = await this.request<string | null>(
      request(this.id, this.storageId, 'get', { key: 'global-settings:skillPermNames' })
    );
    if (skillNamesJson) {
      try {
        const skillNames: string[] = JSON.parse(skillNamesJson);
        const shellId = await this.discoverDep('ShellExecutor');
        for (const name of skillNames) {
          const permsJson = await this.request<string | null>(
            request(this.id, this.storageId, 'get', { key: `global-settings:skillPerms:${name}` })
          );
          if (permsJson) {
            try {
              const cmds: string[] = JSON.parse(permsJson);
              this.skillPermissions.set(name, cmds);
              if (shellId) {
                await this.request(request(this.id, shellId, 'updateSkillPermissions', {
                  skillName: name,
                  allowedCommands: cmds,
                }));
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } catch { /* ignore */ }
    }

    log.info('Applied saved permissions');
  }

  // ========== API KEYS ACTIONS ==========

  /**
   * Read widget values for the selected provider, save to global storage, and configure LLM.
   */
  private async saveSettings(): Promise<void> {
    if (!this.windowId) return;

    await this.setSaveControlsDisabled(true);

    // Snapshot the currently visible credential into the cache so it persists.
    if (this.credentialInputId) {
      const currentValue = await this.request<string>(
        request(this.id, this.credentialInputId, 'getValue', {})
      );
      this.credentialValues[this.activeAiProvider] = currentValue ?? '';
    }

    // Default Ollama URL if empty
    if (!this.credentialValues.ollama) {
      this.credentialValues.ollama = 'http://localhost:11434';
    }

    // Read per-tier provider + model selections
    const tierRouting: Record<ModelTierName, TierRoutingRow> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
      code: { provider: null, model: null },
    };

    for (const tier of TIER_NAMES) {
      const providerSelectId = this.tierProviderSelectIds[tier];
      const modelSelectId = this.tierModelSelectIds[tier];
      if (!providerSelectId || !modelSelectId) continue;

      const providerLabel = await this.request<string>(
        request(this.id, providerSelectId, 'getValue', {})
      );
      const providerName = this.idForLabel(providerLabel) ?? null;

      const modelName = await this.request<string>(
        request(this.id, modelSelectId, 'getValue', {})
      );

      if (providerName && modelName && modelName !== '(no models)') {
        const modelList = this.providerModelCache.get(providerName) ?? [];
        const modelInfo = modelList.find(m => m.name === modelName);
        tierRouting[tier] = {
          provider: providerName,
          model: modelInfo ? modelInfo.id : modelName,
          effort: this.tierDesiredEfforts[tier],
        };
        this.tierDesiredModelIds[tier] = tierRouting[tier].model;
      }
    }

    // Read the optional vision-fallback row
    const visionFallback: { provider: string | null; model: string | null } = { provider: null, model: null };
    if (this.visionProviderSelectId && this.visionModelSelectId) {
      const provider = await this.visionSelectedProvider();
      if (provider) {
        const modelName = await this.request<string>(
          request(this.id, this.visionModelSelectId, 'getValue', {})
        );
        if (modelName && modelName !== '(no models)' && modelName !== '(none)') {
          const modelList = this.providerModelCache.get(provider) ?? [];
          const modelInfo = modelList.find(m => m.name === modelName);
          visionFallback.provider = provider;
          visionFallback.model = modelInfo ? modelInfo.id : modelName;
          this.visionDesiredModelId = visionFallback.model;
        }
      } else {
        this.visionDesiredModelId = null;
      }
    }

    // Validate: at least one tier must have a valid config
    const hasAnyTier = TIER_NAMES.some(t => tierRouting[t].provider && tierRouting[t].model);
    if (!hasAnyTier) {
      await this.setStatus('Configure at least one model tier.', this.theme.statusErrorBright);
      await this.setSaveControlsDisabled(false);
      return;
    }

    // Validate: each tier's provider must have credentials. URL-only
    // (e.g. Ollama) and CLI providers manage their own auth — neither
    // needs an API key.
    for (const tier of TIER_NAMES) {
      const { provider } = tierRouting[tier];
      if (!provider) continue;
      const desc = this.descById(provider);
      if (!desc) continue;
      if (desc.credentialMode === 'cli' || desc.credentialMode === 'url' || desc.credentialMode === 'none') continue;
      if (!this.credentialValues[provider]) {
        const tierLabel = TIER_LABELS[TIER_NAMES.indexOf(tier)];
        await this.setStatus(
          `${tierLabel} tier uses ${desc.label} but no API key provided.`,
          this.theme.statusErrorBright,
        );
        await this.setSaveControlsDisabled(false);
        return;
      }
    }

    // Same credential check for the vision fallback's provider
    if (visionFallback.provider) {
      const desc = this.descById(visionFallback.provider);
      if (desc && desc.credentialMode === 'apiKey' && !this.credentialValues[visionFallback.provider]) {
        await this.setStatus(
          `Vision fallback uses ${desc.label} but no API key provided.`,
          this.theme.statusErrorBright,
        );
        await this.setSaveControlsDisabled(false);
        return;
      }
    }

    // Persist credentials to storage. Per-provider keys derived from
    // each description's storageSuffix; CLI providers contribute nothing
    // (their auth lives in the binary).
    if (this.storageId) {
      for (const desc of this.providerDescriptions) {
        if (desc.credentialMode === 'cli' || desc.credentialMode === 'none') continue;
        const value = this.credentialValues[desc.id];
        if (value) {
          await this.request(
            request(this.id, this.storageId, 'set', { key: storageKeyFor(desc.storageSuffix), value })
          );
        }
      }
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY_AI_ACTIVE_PROVIDER,
          value: this.activeAiProvider,
        })
      );

      // Persist tier routing
      await this.persistTierRouting(tierRouting);

      // Persist the vision fallback ('None' clears the saved keys)
      if (visionFallback.provider && visionFallback.model) {
        await this.request(request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY_VISION_PROVIDER, value: visionFallback.provider,
        }));
        await this.request(request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY_VISION_MODEL, value: visionFallback.model,
        }));
      } else {
        try {
          await this.request(request(this.id, this.storageId, 'delete', { key: STORAGE_KEY_VISION_PROVIDER }));
          await this.request(request(this.id, this.storageId, 'delete', { key: STORAGE_KEY_VISION_MODEL }));
        } catch { /* nothing saved yet */ }
      }

      // Persist the cache-keepalive opt-in
      await this.request(request(this.id, this.storageId, 'set', {
        key: STORAGE_KEY_CACHE_KEEPALIVE, value: this.cacheKeepaliveEnabled,
      }));
    }

    // Configure all providers, tier routing, and the vision fallback
    await this.configureProviders(this.credentialValues, tierRouting, visionFallback);

    log.info('Saved provider settings with per-tier routing');
    await this.setStatus('Settings saved!');
    await this.setSaveControlsDisabled(false);

    // Kick off background live model refreshes now that providers are
    // registered. Each completing fetch re-renders only the widgets bound to
    // that provider, so the UI never blocks on a slow API.
    this.fetchedLiveModels.clear();
    const prefetch = new Set<LLMProviderName>([this.activeAiProvider]);
    for (const tier of TIER_NAMES) {
      const p = tierRouting[tier].provider;
      if (p && this.providerDescById.has(p)) prefetch.add(p);
    }
    if (visionFallback.provider && this.providerDescById.has(visionFallback.provider)) {
      prefetch.add(visionFallback.provider);
    }
    for (const p of prefetch) {
      void this.refreshProviderModels(p, { force: true });
    }
  }
}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
