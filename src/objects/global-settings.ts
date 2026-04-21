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

const log = new Log('GlobalSettings');

/** Convert a string array to ListItem array for list widgets. */
function toListItems(arr: string[]): Array<{ label: string; value: string }> {
  return arr.map(s => ({ label: s, value: s }));
}

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const STORAGE_KEY_ANTHROPIC = 'global-settings:anthropicApiKey';
const STORAGE_KEY_OPENAI = 'global-settings:openaiApiKey';
const STORAGE_KEY_OLLAMA_URL = 'global-settings:ollamaUrl';
const STORAGE_KEY_OPENROUTER = 'global-settings:openrouterApiKey';
const STORAGE_KEY_DEEPSEEK = 'global-settings:deepseekApiKey';
const STORAGE_KEY_GROK = 'global-settings:grokApiKey';
const STORAGE_KEY_GEMINI = 'global-settings:geminiApiKey';
const STORAGE_KEY_KIMI = 'global-settings:kimiApiKey';
const STORAGE_KEY_MINIMAX = 'global-settings:minimaxApiKey';
const STORAGE_KEY_AI_ACTIVE_PROVIDER = 'global-settings:aiActiveProvider';
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

// Per-tier routing storage keys
const STORAGE_KEY_TIER_SMART_PROVIDER = 'global-settings:tierSmartProvider';
const STORAGE_KEY_TIER_SMART_MODEL = 'global-settings:tierSmartModel';
const STORAGE_KEY_TIER_BALANCED_PROVIDER = 'global-settings:tierBalancedProvider';
const STORAGE_KEY_TIER_BALANCED_MODEL = 'global-settings:tierBalancedModel';
const STORAGE_KEY_TIER_FAST_PROVIDER = 'global-settings:tierFastProvider';
const STORAGE_KEY_TIER_FAST_MODEL = 'global-settings:tierFastModel';

type LLMProviderName = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'deepseek' | 'grok' | 'gemini' | 'kimi' | 'minimax';
const PROVIDER_LABELS: string[] = ['Anthropic', 'OpenAI', 'Ollama', 'OpenRouter', 'DeepSeek', 'Grok', 'Gemini', 'Kimi', 'MiniMax'];
const PROVIDER_NAMES: LLMProviderName[] = ['anthropic', 'openai', 'ollama', 'openrouter', 'deepseek', 'grok', 'gemini', 'kimi', 'minimax'];

type ModelTierName = 'smart' | 'balanced' | 'fast';
const TIER_LABELS: string[] = ['Smart', 'Balanced', 'Fast'];
const TIER_NAMES: ModelTierName[] = ['smart', 'balanced', 'fast'];

// Default tier models per provider (for migration from old single-provider setting)
const DEFAULT_TIER_MODELS: Record<LLMProviderName, Record<ModelTierName, string>> = {
  anthropic: { smart: 'claude-opus-4-7', balanced: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' },
  openai: { smart: 'gpt-5.4', balanced: 'gpt-5.4-mini', fast: 'gpt-5.4-nano' },
  ollama: { smart: '', balanced: '', fast: '' },
  openrouter: { smart: 'anthropic/claude-opus-4-6', balanced: 'openai/gpt-5.4-mini', fast: 'meta-llama/llama-3.3-70b-instruct' },
  deepseek: { smart: 'deepseek-reasoner', balanced: 'deepseek-chat', fast: 'deepseek-chat' },
  grok: { smart: 'grok-4', balanced: 'grok-4-mini', fast: 'grok-4-fast' },
  gemini: { smart: 'gemini-3.1-pro', balanced: 'gemini-3.1-flash', fast: 'gemini-3.1-flash-lite' },
  kimi: { smart: 'kimi-k2-0905-preview', balanced: 'moonshot-v1-32k', fast: 'moonshot-v1-8k' },
  minimax: { smart: 'MiniMax-M2', balanced: 'MiniMax-M1', fast: 'abab6.5s-chat' },
};

// Per-provider placeholder and label metadata for the single-panel AI tab
interface ProviderMeta {
  credentialLabel: string;
  placeholder: string;
  isUrl: boolean;
}

const PROVIDER_META: Record<LLMProviderName, ProviderMeta> = {
  anthropic: { credentialLabel: 'Anthropic API Key', placeholder: 'sk-ant-...', isUrl: false },
  openai: { credentialLabel: 'OpenAI API Key', placeholder: 'sk-...', isUrl: false },
  ollama: { credentialLabel: 'Ollama URL', placeholder: 'http://localhost:11434', isUrl: true },
  openrouter: { credentialLabel: 'OpenRouter API Key', placeholder: 'sk-or-...', isUrl: false },
  deepseek: { credentialLabel: 'DeepSeek API Key', placeholder: 'sk-...', isUrl: false },
  grok: { credentialLabel: 'xAI Grok API Key', placeholder: 'xai-...', isUrl: false },
  gemini: { credentialLabel: 'Google Gemini API Key', placeholder: 'AIza...', isUrl: false },
  kimi: { credentialLabel: 'Kimi (Moonshot) API Key', placeholder: 'sk-...', isUrl: false },
  minimax: { credentialLabel: 'MiniMax API Key', placeholder: 'sk-...', isUrl: false },
};

// Legacy keys for migration
const LEGACY_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const LEGACY_KEY_OPENAI = 'settings:openaiApiKey';
const LEGACY_KEY_PROVIDER = 'global-settings:llmProvider';
const LEGACY_KEY_OLLAMA_MODEL = 'global-settings:ollamaModel';
const LEGACY_KEY_OLLAMA_MODEL_SMART = 'global-settings:ollamaModelSmart';
const LEGACY_KEY_OLLAMA_MODEL_BALANCED = 'global-settings:ollamaModelBalanced';
const LEGACY_KEY_OLLAMA_MODEL_FAST = 'global-settings:ollamaModelFast';

interface ModelInfo { id: string; name: string; }

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

  // Per-tier provider + model select widgets
  private tierProviderSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined };
  private tierModelSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined };

  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private skillBrowserBtnId?: AbjectId;
  private catalogBrowserBtnId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private activeTab: 'ai' | 'auth' | 'permissions' = 'ai';
  private aiContainerId?: AbjectId;
  private authContainerId?: AbjectId;

  // Auth widgets
  private authCheckboxId?: AbjectId;
  private authUserInputId?: AbjectId;
  private authPassInputId?: AbjectId;
  private authPassToggleId?: AbjectId;
  private authSaveBtnId?: AbjectId;

  // Permissions tab
  private permissionsContainerId?: AbjectId;
  private platformLabelId?: AbjectId;
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

  private unmasked: Set<AbjectId> = new Set();

  // Cached model lists per provider (refreshed when credentials change)
  private providerModelCache: Record<LLMProviderName, ModelInfo[]> = {
    anthropic: [],
    openai: [],
    ollama: [],
    openrouter: [],
    deepseek: [],
    grok: [],
    gemini: [],
    kimi: [],
    minimax: [],
  };

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
- AI tab: Anthropic/OpenAI API keys, Ollama URL, per-tier model routing (smart/balanced/fast)
- Auth tab: optional HTTP basic auth for the UI server
- Permissions tab: filesystem paths, shell commands, and web domain allow/deny lists

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

    const credentials: Partial<Record<LLMProviderName, string>> = {};
    const tierRouting: Record<ModelTierName, { provider: string | null; model: string | null }> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
    };

    if (this.storageId) {
      const storageKeys: Array<[LLMProviderName, string]> = [
        ['anthropic', STORAGE_KEY_ANTHROPIC],
        ['openai', STORAGE_KEY_OPENAI],
        ['ollama', STORAGE_KEY_OLLAMA_URL],
        ['openrouter', STORAGE_KEY_OPENROUTER],
        ['deepseek', STORAGE_KEY_DEEPSEEK],
        ['grok', STORAGE_KEY_GROK],
        ['gemini', STORAGE_KEY_GEMINI],
        ['kimi', STORAGE_KEY_KIMI],
        ['minimax', STORAGE_KEY_MINIMAX],
      ];
      for (const [name, key] of storageKeys) {
        const value = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key })
        );
        if (value) credentials[name] = value;
      }
      const savedActive = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_AI_ACTIVE_PROVIDER })
      );
      if (savedActive && PROVIDER_NAMES.includes(savedActive as LLMProviderName)) {
        this.activeAiProvider = savedActive as LLMProviderName;
      }

      // Load per-tier routing
      tierRouting.smart.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_SMART_PROVIDER })
      );
      tierRouting.smart.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_SMART_MODEL })
      );
      tierRouting.balanced.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_BALANCED_PROVIDER })
      );
      tierRouting.balanced.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_BALANCED_MODEL })
      );
      tierRouting.fast.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_FAST_PROVIDER })
      );
      tierRouting.fast.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_FAST_MODEL })
      );

      // Legacy migration from per-workspace keys
      if (!credentials.anthropic && !credentials.openai) {
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
              request(this.id, this.storageId, 'set', { key: STORAGE_KEY_ANTHROPIC, value: legacyAnthropic })
            );
          }
          if (legacyOpenai) {
            credentials.openai = legacyOpenai;
            await this.request(
              request(this.id, this.storageId, 'set', { key: STORAGE_KEY_OPENAI, value: legacyOpenai })
            );
          }
          log.info('Migrated API keys from legacy storage');
        }
      }

      // Legacy migration: old single-provider setting to per-tier routing
      const hasTierRouting = tierRouting.smart.provider || tierRouting.balanced.provider || tierRouting.fast.provider;
      if (!hasTierRouting) {
        const oldProvider = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: LEGACY_KEY_PROVIDER })
        );
        if (oldProvider && PROVIDER_NAMES.includes(oldProvider as LLMProviderName)) {
          const providerName = oldProvider as LLMProviderName;
          const defaults = DEFAULT_TIER_MODELS[providerName];

          // For Ollama, check old per-tier model keys
          if (providerName === 'ollama') {
            const oldSmart = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL_SMART })
            );
            const oldBalanced = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL_BALANCED })
            );
            const oldFast = await this.request<string | null>(
              request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OLLAMA_MODEL_FAST })
            );
            // Check legacy single model key
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
    const hasTierConfig = tierRouting.smart.provider || tierRouting.balanced.provider || tierRouting.fast.provider;
    if ((hasAnyConfig || hasTierConfig) && this.llmId) {
      await this.configureProviders(credentials, tierRouting);
      log.info('Loaded saved provider configuration');
    } else {
      await this.show();
    }
  }

  private async persistTierRouting(
    tierRouting: Record<ModelTierName, { provider: string | null; model: string | null }>,
  ): Promise<void> {
    if (!this.storageId) return;
    const keys: [string, string | null][] = [
      [STORAGE_KEY_TIER_SMART_PROVIDER, tierRouting.smart.provider],
      [STORAGE_KEY_TIER_SMART_MODEL, tierRouting.smart.model],
      [STORAGE_KEY_TIER_BALANCED_PROVIDER, tierRouting.balanced.provider],
      [STORAGE_KEY_TIER_BALANCED_MODEL, tierRouting.balanced.model],
      [STORAGE_KEY_TIER_FAST_PROVIDER, tierRouting.fast.provider],
      [STORAGE_KEY_TIER_FAST_MODEL, tierRouting.fast.model],
    ];
    for (const [key, value] of keys) {
      if (value) {
        await this.request(request(this.id, this.storageId, 'set', { key, value }));
      }
    }
  }

  private async configureProviders(
    credentials: Partial<Record<LLMProviderName, string>>,
    tierRouting: Record<ModelTierName, { provider: string | null; model: string | null }>,
  ): Promise<void> {
    if (!this.llmId) return;

    // Build tier routing for LLMObject (only include tiers with both provider and model)
    const routing: Record<string, { provider: string; model: string }> = {};
    for (const tier of TIER_NAMES) {
      const { provider, model } = tierRouting[tier];
      if (provider && model) {
        routing[tier] = { provider, model };
      }
    }

    const config: Record<string, unknown> = {
      anthropicApiKey: credentials.anthropic,
      openaiApiKey: credentials.openai,
      ollamaUrl: credentials.ollama || undefined,
      openrouterApiKey: credentials.openrouter,
      deepseekApiKey: credentials.deepseek,
      grokApiKey: credentials.grok,
      geminiApiKey: credentials.gemini,
      kimiApiKey: credentials.kimi,
      minimaxApiKey: credentials.minimax,
      tierRouting: Object.keys(routing).length > 0 ? routing : undefined,
    };

    await this.request(request(this.id, this.llmId, 'configure', config));
  }

  private setupHandlers(): void {
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
        type: 'shell' | 'directory' | 'skill_shell';
        resource: string;
        description: string;
        skillName?: string;
      };
      if (type === 'skill_shell' && skillName) {
        return this.showSkillPermissionPrompt(skillName, resource, description);
      }
      return this.showPermissionPrompt(type as 'shell' | 'directory', resource, description);
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
        this.activeTab = idx === 0 ? 'ai' : idx === 1 ? 'auth' : 'permissions';
        await this.switchTab();
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
            const idx = PROVIDER_LABELS.indexOf(label);
            if (idx >= 0) void this.refreshProviderModels(PROVIDER_NAMES[idx]);
          }
          return;
        }
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
          tabs: ['AI', 'Auth', 'Permissions'],
          closable: false,
          selectedIndex: this.activeTab === 'ai' ? 0 : this.activeTab === 'auth' ? 1 : 2 },
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

    // Permissions container (scrollable VBox, initially hidden)
    this.permissionsContainerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.permissionsContainerId,
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
    // Show correct tab
    await this.switchTab();

    this.changed('visibility', true);
    return true;
  }

  /** Build AI tab content into aiContainerId. */
  private async buildAiTab(): Promise<void> {
    const cId = this.aiContainerId!;

    // Load tier routing (credentials already loaded into this.credentialValues in onInit)
    const savedTierRouting: Record<ModelTierName, { provider: string | null; model: string | null }> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
    };
    if (this.storageId) {
      savedTierRouting.smart.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_SMART_PROVIDER })
      );
      savedTierRouting.smart.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_SMART_MODEL })
      );
      savedTierRouting.balanced.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_BALANCED_PROVIDER })
      );
      savedTierRouting.balanced.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_BALANCED_MODEL })
      );
      savedTierRouting.fast.provider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_FAST_PROVIDER })
      );
      savedTierRouting.fast.model = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_TIER_FAST_MODEL })
      );
    }

    // Populate cache with defaults synchronously so the UI can render now.
    // Live per-provider fetches run lazily (when the user looks at a provider
    // or hits Save) to avoid blocking the window paint.
    this.populateDefaultModelCache();

    // ── Credentials section ──
    const { widgetIds: [credHeaderId, credDescId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Credentials',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId,
          text: 'Pick a provider to enter or update its API key. Configured keys persist across restarts.',
          style: { color: this.theme.textDescription, fontSize: 12 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: credHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: credDescId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Provider selector row
    const providerSelectRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: providerSelectRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [providerPickerLabelId, providerSelectorId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Provider',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'select', windowId: this.windowId,
          options: PROVIDER_LABELS,
          selectedIndex: Math.max(0, PROVIDER_NAMES.indexOf(this.activeAiProvider)) },
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
    const meta = PROVIDER_META[this.activeAiProvider];
    const { widgetIds: [credentialLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: meta.credentialLabel,
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    this.credentialLabelId = credentialLabelId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.credentialLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Credential input row (input + Show/Hide toggle)
    const credentialRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: credentialRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const initialValue = this.credentialValues[this.activeAiProvider]
      ?? (this.activeAiProvider === 'ollama' ? 'http://localhost:11434' : '');
    const { widgetIds: [credentialInputId, credentialToggleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId,
          placeholder: meta.placeholder,
          masked: !meta.isUrl,
          text: initialValue },
        { type: 'button', windowId: this.windowId, text: 'Show',
          style: meta.isUrl ? { disabled: true } : undefined },
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

    // Models list label (read-only, shows discovered models for the active provider)
    const { widgetIds: [providerModelsLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId,
          text: this.formatModelListLine(this.activeAiProvider),
          style: { color: this.theme.textDescription, fontSize: 12 } },
      ]})
    );
    this.providerModelsLabelId = providerModelsLabelId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.providerModelsLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // ── Model Tiers section ──
    const { widgetIds: [tierHeaderId, tierDescId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Model Tiers',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId, text: 'Choose a provider and model for each quality tier.',
          style: { color: this.theme.textDescription, fontSize: 12 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: tierHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: tierDescId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Per-tier rows: [Label] [Provider dropdown] [Model dropdown]
    for (let i = 0; i < TIER_NAMES.length; i++) {
      const tier = TIER_NAMES[i];
      const tierLabel = TIER_LABELS[i];
      const savedProvider = savedTierRouting[tier].provider as LLMProviderName | null;
      const savedModel = savedTierRouting[tier].model;

      // Row container
      const tierRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: cId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, cId, 'addLayoutChild', {
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
      const providerIdx = savedProvider ? PROVIDER_NAMES.indexOf(savedProvider) : 0;
      const { widgetIds: [providerSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'select', windowId: this.windowId,
            options: PROVIDER_LABELS,
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
      const activeProvider = savedProvider && PROVIDER_NAMES.includes(savedProvider) ? savedProvider : PROVIDER_NAMES[0];
      const modelList = this.providerModelCache[activeProvider];
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

    // ── Skills section ──
    const { widgetIds: [skillsSectionLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Skills', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 14 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: skillsSectionLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 24 },
    }));

    const { widgetIds: [skillsDescId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Manage SKILL.md files in ~/.abject/skills/', style: { fontSize: 12, color: this.theme.textDescription } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: skillsDescId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    // Skill Browser button row
    const skillRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: skillRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));
    await this.request(request(this.id, skillRowId, 'addLayoutSpacer', {}));

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

    // Kick off background live fetches for providers the user is currently
    // looking at or that a tier is pointed at. Fire-and-forget so the window
    // paints immediately. Each fetch updates its dropdown/label when it lands.
    const toPrefetch = new Set<LLMProviderName>([this.activeAiProvider]);
    for (const tier of TIER_NAMES) {
      const p = savedTierRouting[tier].provider as LLMProviderName | null;
      if (p && PROVIDER_NAMES.includes(p)) toPrefetch.add(p);
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
    this.tierProviderSelectIds = { smart: undefined, balanced: undefined, fast: undefined };
    this.tierModelSelectIds = { smart: undefined, balanced: undefined, fast: undefined };
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
    this.permissionsContainerId = undefined;
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
    this.permsSaveBtnId = undefined;
    this.unmasked.clear();

    this.changed('visibility', false);
    return true;
  }

  /** Show/hide tab containers based on activeTab. */
  private async switchTab(): Promise<void> {
    if (!this.aiContainerId || !this.authContainerId || !this.permissionsContainerId) return;
    await this.request(request(this.id, this.aiContainerId, 'update', { style: { visible: this.activeTab === 'ai' } }));
    await this.request(request(this.id, this.authContainerId, 'update', { style: { visible: this.activeTab === 'auth' } }));
    await this.request(request(this.id, this.permissionsContainerId, 'update', { style: { visible: this.activeTab === 'permissions' } }));
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
    ];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  // ========== TIER MODEL REFRESH ==========

  /** Tracks providers whose live models have been fetched this session. */
  private fetchedLiveModels: Set<LLMProviderName> = new Set();
  /** Tracks in-flight fetches so we don't kick off duplicates. */
  private modelFetchInFlight: Set<LLMProviderName> = new Set();

  /**
   * Synchronously populate the cache with hardcoded defaults so the UI can
   * render immediately. Live fetches happen lazily via refreshProviderModels.
   */
  private populateDefaultModelCache(): void {
    this.providerModelCache.anthropic = [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ];
    this.providerModelCache.openai = [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
    ];
    this.providerModelCache.openrouter = [
      { id: 'anthropic/claude-opus-4-6', name: 'anthropic/claude-opus-4-6' },
      { id: 'openai/gpt-5.4-mini', name: 'openai/gpt-5.4-mini' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'meta-llama/llama-3.3-70b-instruct' },
    ];
    this.providerModelCache.deepseek = [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ];
    this.providerModelCache.grok = [
      { id: 'grok-4', name: 'Grok 4' },
      { id: 'grok-4-mini', name: 'Grok 4 Mini' },
      { id: 'grok-4-fast', name: 'Grok 4 Fast' },
    ];
    this.providerModelCache.gemini = [
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
    ];
    this.providerModelCache.kimi = [
      { id: 'kimi-k2-0905-preview', name: 'Kimi K2 (preview)' },
      { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k' },
      { id: 'moonshot-v1-32k', name: 'Moonshot v1 32k' },
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8k' },
    ];
    this.providerModelCache.minimax = [
      { id: 'MiniMax-M2', name: 'MiniMax M2' },
      { id: 'MiniMax-M1', name: 'MiniMax M1' },
      { id: 'abab6.5-chat', name: 'abab6.5 Chat' },
      { id: 'abab6.5s-chat', name: 'abab6.5s Chat' },
    ];
    this.providerModelCache.ollama = [];
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
    // Skip unreachable providers without credentials (except Ollama which is local)
    if (name !== 'ollama' && !this.credentialValues[name]) return;

    this.modelFetchInFlight.add(name);
    try {
      const payload: Record<string, unknown> = { provider: name };
      if (name === 'ollama') {
        payload.ollamaUrl = this.credentialValues.ollama || 'http://localhost:11434';
      }
      const models = await this.request<ModelInfo[]>(
        request(this.id, this.llmId, 'listProviderModels', payload)
      );
      if (models.length > 0) {
        this.providerModelCache[name] = models;
        this.fetchedLiveModels.add(name);
        await this.onProviderModelsUpdated(name);
      }
    } catch {
      // Network error or provider not registered; keep defaults.
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
        const idx = PROVIDER_LABELS.indexOf(label);
        const tierProvider = idx >= 0 ? PROVIDER_NAMES[idx] : null;
        if (tierProvider === name) {
          await this.refreshTierModelOptions(tier);
        }
      } catch { /* widget gone */ }
    }
  }

  /** Format the models-list label for a provider ("3 models: Claude Opus 4.7, …"). */
  private formatModelListLine(provider: LLMProviderName): string {
    const models = this.providerModelCache[provider];
    if (!models || models.length === 0) {
      return provider === 'ollama' ? 'No local models found. Start Ollama and save.' : 'Save credentials to discover models.';
    }
    const names = models.slice(0, 6).map(m => m.name);
    const more = models.length > names.length ? `, …(+${models.length - names.length})` : '';
    return `${models.length} models: ${names.join(', ')}${more}`;
  }

  /** Handle provider-dropdown change: snapshot the current input, then swap panel. */
  private async onProviderSelectorChanged(): Promise<void> {
    if (!this.providerSelectorId || !this.credentialInputId || !this.credentialLabelId || !this.credentialToggleId) return;

    // Snapshot the current input into credentialValues for the old provider
    const oldValue = await this.request<string>(request(this.id, this.credentialInputId, 'getValue', {}));
    this.credentialValues[this.activeAiProvider] = oldValue ?? '';

    // Figure out the new provider
    const newLabel = await this.request<string>(request(this.id, this.providerSelectorId, 'getValue', {}));
    const newIdx = PROVIDER_LABELS.indexOf(newLabel);
    const newProvider = newIdx >= 0 ? PROVIDER_NAMES[newIdx] : PROVIDER_NAMES[0];
    this.activeAiProvider = newProvider;

    const meta = PROVIDER_META[newProvider];
    const newValue = this.credentialValues[newProvider]
      ?? (newProvider === 'ollama' ? 'http://localhost:11434' : '');

    // Reset masking state for the input
    this.unmasked.delete(this.credentialInputId);

    await this.request(request(this.id, this.credentialLabelId, 'update', {
      text: meta.credentialLabel,
    }));
    await this.request(request(this.id, this.credentialInputId, 'update', {
      text: newValue,
      placeholder: meta.placeholder,
      masked: !meta.isUrl,
    }));
    await this.request(request(this.id, this.credentialToggleId, 'update', {
      text: 'Show',
      style: meta.isUrl ? { disabled: true } : { disabled: false },
    }));
    if (this.providerModelsLabelId) {
      await this.request(request(this.id, this.providerModelsLabelId, 'update', {
        text: this.formatModelListLine(newProvider),
      }));
    }

    // Background refresh for the newly-active provider (idempotent + deduped)
    void this.refreshProviderModels(newProvider);
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
    const providerIdx = PROVIDER_LABELS.indexOf(providerLabel);
    const providerName = providerIdx >= 0 ? PROVIDER_NAMES[providerIdx] : PROVIDER_NAMES[0];

    const currentLabel = await this.request<string>(
      request(this.id, modelSelectId, 'getValue', {})
    );

    const modelList = this.providerModelCache[providerName];
    const options = modelList.length > 0
      ? modelList.map(m => m.name)
      : ['(no models)'];

    const keepIdx = options.indexOf(currentLabel);
    const selectedIndex = keepIdx >= 0 ? keepIdx : 0;

    await this.request(
      request(this.id, modelSelectId, 'update', { options, selectedIndex })
    );
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
    }

    // Platform info label
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

    const { widgetIds: [platLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: platformText,
          style: { color: this.theme.textDescription, fontSize: 12 } },
      ]})
    );
    this.platformLabelId = platLabelId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.platformLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // ── Filesystem section ──
    const { widgetIds: [fsHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Filesystem',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: fsHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Read-only checkbox
    const { widgetIds: [fsRoCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.fsReadOnly, text: 'Read-only mode' },
      ]})
    );
    this.fsReadOnlyCheckboxId = fsRoCheckId;
    await this.request(request(this.id, this.fsReadOnlyCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.fsReadOnlyCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Allowed paths label
    const { widgetIds: [fsPathLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Allowed paths (will prompt if not listed)',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: fsPathLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Path input + Add button row
    const fsAddRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: fsAddRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [fsPathInId, fsAddId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: '/path/to/directory' },
        { type: 'button', windowId: this.windowId, text: 'Add' },
      ]})
    );
    this.fsPathInputId = fsPathInId;
    this.fsAddBtnId = fsAddId;
    await this.request(request(this.id, this.fsPathInputId, 'addDependent', {}));
    await this.request(request(this.id, fsAddRowId, 'addLayoutChild', {
      widgetId: this.fsPathInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.fsAddBtnId, 'addDependent', {}));
    await this.request(request(this.id, fsAddRowId, 'addLayoutChild', {
      widgetId: this.fsAddBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Path list
    const { widgetIds: [fsListId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: toListItems(this.fsAllowedPaths), searchable: false,
          style: { height: 80 } },
      ]})
    );
    this.fsPathListId = fsListId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.fsPathListId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));

    // Remove button
    const { widgetIds: [fsRemId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected' },
      ]})
    );
    this.fsRemoveBtnId = fsRemId;
    await this.request(request(this.id, this.fsRemoveBtnId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.fsRemoveBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 130, height: 28 },
    }));

    // ── Shell section ──
    const { widgetIds: [shellHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Shell Execution',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: shellHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Shell enabled checkbox
    const { widgetIds: [shellEnCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.shellEnabled, text: 'Enable shell execution' },
      ]})
    );
    this.shellEnabledCheckboxId = shellEnCheckId;
    await this.request(request(this.id, this.shellEnabledCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.shellEnabledCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Allowed commands label
    const { widgetIds: [shellAllowLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Allowed commands (will prompt if not listed)',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: shellAllowLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Allowed commands input + Add row
    const shellAddRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: shellAddRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [shellCmdInId, shellAddId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. git, ls, npm' },
        { type: 'button', windowId: this.windowId, text: 'Add' },
      ]})
    );
    this.shellCmdInputId = shellCmdInId;
    this.shellAddBtnId = shellAddId;
    await this.request(request(this.id, this.shellCmdInputId, 'addDependent', {}));
    await this.request(request(this.id, shellAddRowId, 'addLayoutChild', {
      widgetId: this.shellCmdInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.shellAddBtnId, 'addDependent', {}));
    await this.request(request(this.id, shellAddRowId, 'addLayoutChild', {
      widgetId: this.shellAddBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Allowed commands list
    const { widgetIds: [shellListId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: toListItems(this.shellAllowedCmds), searchable: false,
          style: { height: 80 } },
      ]})
    );
    this.shellCmdListId = shellListId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.shellCmdListId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));

    // Allowed commands remove button
    const { widgetIds: [shellRemId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected' },
      ]})
    );
    this.shellRemoveBtnId = shellRemId;
    await this.request(request(this.id, this.shellRemoveBtnId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.shellRemoveBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 130, height: 28 },
    }));

    // Denied commands label
    const { widgetIds: [shellDenyLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Denied commands',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: shellDenyLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Denied commands input + Add row
    const shellDenyAddRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: shellDenyAddRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [shellDenyInId, shellDenyAddId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. rm, sudo' },
        { type: 'button', windowId: this.windowId, text: 'Add' },
      ]})
    );
    this.shellDeniedInputId = shellDenyInId;
    this.shellDeniedAddBtnId = shellDenyAddId;
    await this.request(request(this.id, this.shellDeniedInputId, 'addDependent', {}));
    await this.request(request(this.id, shellDenyAddRowId, 'addLayoutChild', {
      widgetId: this.shellDeniedInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.shellDeniedAddBtnId, 'addDependent', {}));
    await this.request(request(this.id, shellDenyAddRowId, 'addLayoutChild', {
      widgetId: this.shellDeniedAddBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Denied commands list
    const { widgetIds: [shellDenyListId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: toListItems(this.shellDeniedCmds), searchable: false,
          style: { height: 80 } },
      ]})
    );
    this.shellDeniedListId = shellDenyListId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.shellDeniedListId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));

    // Denied commands remove button
    const { widgetIds: [shellDenyRemId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected' },
      ]})
    );
    this.shellDeniedRemoveBtnId = shellDenyRemId;
    await this.request(request(this.id, this.shellDeniedRemoveBtnId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.shellDeniedRemoveBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 130, height: 28 },
    }));

    // ── Web (HTTP) section ──
    const { widgetIds: [webHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Web / HTTP',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: webHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Web enabled checkbox
    const { widgetIds: [webEnCheckId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId, checked: this.webEnabled, text: 'Enable HTTP requests' },
      ]})
    );
    this.webEnabledCheckboxId = webEnCheckId;
    await this.request(request(this.id, this.webEnabledCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.webEnabledCheckboxId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Allowed domains label
    const { widgetIds: [webAllowLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Allowed domains (empty = allow all)',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: webAllowLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Allowed domains input + Add row
    const webAddRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: webAddRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [webDomInId, webAddId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. api.example.com' },
        { type: 'button', windowId: this.windowId, text: 'Add' },
      ]})
    );
    this.webDomainInputId = webDomInId;
    this.webAddBtnId = webAddId;
    await this.request(request(this.id, this.webDomainInputId, 'addDependent', {}));
    await this.request(request(this.id, webAddRowId, 'addLayoutChild', {
      widgetId: this.webDomainInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.webAddBtnId, 'addDependent', {}));
    await this.request(request(this.id, webAddRowId, 'addLayoutChild', {
      widgetId: this.webAddBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Allowed domains list
    const { widgetIds: [webListId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: toListItems(this.webAllowedDomains), searchable: false,
          style: { height: 80 } },
      ]})
    );
    this.webDomainListId = webListId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.webDomainListId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));

    // Allowed domains remove button
    const { widgetIds: [webRemId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected' },
      ]})
    );
    this.webRemoveBtnId = webRemId;
    await this.request(request(this.id, this.webRemoveBtnId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.webRemoveBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 130, height: 28 },
    }));

    // Denied domains label
    const { widgetIds: [webDenyLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Denied domains',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: webDenyLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Denied domains input + Add row
    const webDenyAddRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: webDenyAddRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [webDenyInId, webDenyAddId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'e.g. evil.example.com' },
        { type: 'button', windowId: this.windowId, text: 'Add' },
      ]})
    );
    this.webDeniedInputId = webDenyInId;
    this.webDeniedAddBtnId = webDenyAddId;
    await this.request(request(this.id, this.webDeniedInputId, 'addDependent', {}));
    await this.request(request(this.id, webDenyAddRowId, 'addLayoutChild', {
      widgetId: this.webDeniedInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.webDeniedAddBtnId, 'addDependent', {}));
    await this.request(request(this.id, webDenyAddRowId, 'addLayoutChild', {
      widgetId: this.webDeniedAddBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Denied domains list
    const { widgetIds: [webDenyListId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId: this.windowId, items: toListItems(this.webDeniedDomains), searchable: false,
          style: { height: 80 } },
      ]})
    );
    this.webDeniedListId = webDenyListId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.webDeniedListId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 80 },
    }));

    // Denied domains remove button
    const { widgetIds: [webDenyRemId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Remove Selected' },
      ]})
    );
    this.webDeniedRemoveBtnId = webDenyRemId;
    await this.request(request(this.id, this.webDeniedRemoveBtnId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.webDeniedRemoveBtnId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 130, height: 28 },
    }));

    // ── Save button ──
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
    type: 'shell' | 'directory',
    resource: string,
    description: string,
  ): Promise<{ decision: string }> {
    if (!this.widgetManagerId) return { decision: 'deny' };

    // If there's already a prompt open, deny (don't stack prompts)
    if (this._pendingPermissionPrompt) return { decision: 'deny' };

    try {
      const title = type === 'shell' ? 'Shell Permission' : 'Filesystem Permission';
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

    const targets = ['HostFileSystem', 'ShellExecutor', 'HttpClient'];
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

    // Only propagate saved values if at least one permission key was explicitly saved
    if (fsRo === null && shellEn === null && webEn === null) return;

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
    const tierRouting: Record<ModelTierName, { provider: string | null; model: string | null }> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
    };

    for (const tier of TIER_NAMES) {
      const providerSelectId = this.tierProviderSelectIds[tier];
      const modelSelectId = this.tierModelSelectIds[tier];
      if (!providerSelectId || !modelSelectId) continue;

      const providerLabel = await this.request<string>(
        request(this.id, providerSelectId, 'getValue', {})
      );
      const providerIdx = PROVIDER_LABELS.indexOf(providerLabel);
      const providerName = providerIdx >= 0 ? PROVIDER_NAMES[providerIdx] : null;

      const modelName = await this.request<string>(
        request(this.id, modelSelectId, 'getValue', {})
      );

      if (providerName && modelName && modelName !== '(no models)') {
        const modelList = this.providerModelCache[providerName];
        const modelInfo = modelList.find(m => m.name === modelName);
        tierRouting[tier] = {
          provider: providerName,
          model: modelInfo ? modelInfo.id : modelName,
        };
      }
    }

    // Validate: at least one tier must have a valid config
    const hasAnyTier = TIER_NAMES.some(t => tierRouting[t].provider && tierRouting[t].model);
    if (!hasAnyTier) {
      await this.setStatus('Configure at least one model tier.', this.theme.statusErrorBright);
      await this.setSaveControlsDisabled(false);
      return;
    }

    // Validate: each tier's provider must have credentials (Ollama always has a URL)
    for (const tier of TIER_NAMES) {
      const { provider } = tierRouting[tier];
      if (!provider || provider === 'ollama') continue;
      const providerName = provider as LLMProviderName;
      if (!this.credentialValues[providerName]) {
        const tierLabel = TIER_LABELS[TIER_NAMES.indexOf(tier)];
        const providerLabel = PROVIDER_LABELS[PROVIDER_NAMES.indexOf(providerName)] ?? providerName;
        await this.setStatus(
          `${tierLabel} tier uses ${providerLabel} but no API key provided.`,
          this.theme.statusErrorBright,
        );
        await this.setSaveControlsDisabled(false);
        return;
      }
    }

    // Persist credentials to storage
    if (this.storageId) {
      const storageKeys: Array<[LLMProviderName, string]> = [
        ['anthropic', STORAGE_KEY_ANTHROPIC],
        ['openai', STORAGE_KEY_OPENAI],
        ['ollama', STORAGE_KEY_OLLAMA_URL],
        ['openrouter', STORAGE_KEY_OPENROUTER],
        ['deepseek', STORAGE_KEY_DEEPSEEK],
        ['grok', STORAGE_KEY_GROK],
        ['gemini', STORAGE_KEY_GEMINI],
        ['kimi', STORAGE_KEY_KIMI],
        ['minimax', STORAGE_KEY_MINIMAX],
      ];
      for (const [name, key] of storageKeys) {
        const value = this.credentialValues[name];
        if (value) {
          await this.request(
            request(this.id, this.storageId, 'set', { key, value })
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
    }

    // Configure all providers and tier routing
    await this.configureProviders(this.credentialValues, tierRouting);

    log.info('Saved provider settings with per-tier routing');
    await this.setStatus('Settings saved!');
    await this.setSaveControlsDisabled(false);

    // Kick off background live model refreshes now that providers are
    // registered. Each completing fetch re-renders only the widgets bound to
    // that provider, so the UI never blocks on a slow API.
    this.fetchedLiveModels.clear();
    const prefetch = new Set<LLMProviderName>([this.activeAiProvider]);
    for (const tier of TIER_NAMES) {
      const p = tierRouting[tier].provider as LLMProviderName | null;
      if (p && PROVIDER_NAMES.includes(p)) prefetch.add(p);
    }
    for (const p of prefetch) {
      void this.refreshProviderModels(p, { force: true });
    }
  }
}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
