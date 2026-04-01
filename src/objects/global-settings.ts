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

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const STORAGE_KEY_ANTHROPIC = 'global-settings:anthropicApiKey';
const STORAGE_KEY_OPENAI = 'global-settings:openaiApiKey';
const STORAGE_KEY_OLLAMA_URL = 'global-settings:ollamaUrl';
const STORAGE_KEY_AUTH_ENABLED = 'global-settings:authEnabled';
const STORAGE_KEY_AUTH_USER = 'global-settings:authUser';
const STORAGE_KEY_AUTH_PASS = 'global-settings:authPass';

// Per-tier routing storage keys
const STORAGE_KEY_TIER_SMART_PROVIDER = 'global-settings:tierSmartProvider';
const STORAGE_KEY_TIER_SMART_MODEL = 'global-settings:tierSmartModel';
const STORAGE_KEY_TIER_BALANCED_PROVIDER = 'global-settings:tierBalancedProvider';
const STORAGE_KEY_TIER_BALANCED_MODEL = 'global-settings:tierBalancedModel';
const STORAGE_KEY_TIER_FAST_PROVIDER = 'global-settings:tierFastProvider';
const STORAGE_KEY_TIER_FAST_MODEL = 'global-settings:tierFastModel';

type LLMProviderName = 'anthropic' | 'openai' | 'ollama';
const PROVIDER_LABELS: string[] = ['Anthropic', 'OpenAI', 'Ollama'];
const PROVIDER_NAMES: LLMProviderName[] = ['anthropic', 'openai', 'ollama'];

type ModelTierName = 'smart' | 'balanced' | 'fast';
const TIER_LABELS: string[] = ['Smart', 'Balanced', 'Fast'];
const TIER_NAMES: ModelTierName[] = ['smart', 'balanced', 'fast'];

// Default tier models per provider (for migration from old single-provider setting)
const DEFAULT_TIER_MODELS: Record<LLMProviderName, Record<ModelTierName, string>> = {
  anthropic: { smart: 'claude-opus-4-6', balanced: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' },
  openai: { smart: 'gpt-5.4', balanced: 'gpt-5.4-mini', fast: 'gpt-5.4-nano' },
  ollama: { smart: '', balanced: '', fast: '' },
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

  // Credential widgets (always visible)
  private anthropicKeyId?: AbjectId;
  private anthropicToggleId?: AbjectId;
  private openaiKeyId?: AbjectId;
  private openaiToggleId?: AbjectId;
  private ollamaUrlId?: AbjectId;

  // Per-tier provider + model select widgets
  private tierProviderSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined };
  private tierModelSelectIds: Record<ModelTierName, AbjectId | undefined> = { smart: undefined, balanced: undefined, fast: undefined };

  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private skillBrowserBtnId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private activeTab: 'ai' | 'auth' = 'ai';
  private aiContainerId?: AbjectId;
  private authContainerId?: AbjectId;

  // Auth widgets
  private authCheckboxId?: AbjectId;
  private authUserInputId?: AbjectId;
  private authPassInputId?: AbjectId;
  private authPassToggleId?: AbjectId;
  private authSaveBtnId?: AbjectId;

  private unmasked: Set<AbjectId> = new Set();

  // Cached model lists per provider (refreshed when credentials change)
  private providerModelCache: Record<LLMProviderName, ModelInfo[]> = {
    anthropic: [],
    openai: [],
    ollama: [],
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

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.llmId = await this.requireDep('LLM');
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.uiServerId = await this.requireDep('UIServer');

    let anthropicKey: string | null = null;
    let openaiKey: string | null = null;
    let ollamaUrl: string | null = null;
    const tierRouting: Record<ModelTierName, { provider: string | null; model: string | null }> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
    };

    if (this.storageId) {
      anthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      openaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OPENAI })
      );
      ollamaUrl = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OLLAMA_URL })
      );

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
      if (!anthropicKey && !openaiKey) {
        const legacyAnthropic = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: LEGACY_KEY_ANTHROPIC })
        );
        const legacyOpenai = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: LEGACY_KEY_OPENAI })
        );
        if (legacyAnthropic || legacyOpenai) {
          anthropicKey = legacyAnthropic;
          openaiKey = legacyOpenai;
          if (anthropicKey) {
            await this.request(
              request(this.id, this.storageId, 'set', { key: STORAGE_KEY_ANTHROPIC, value: anthropicKey })
            );
          }
          if (openaiKey) {
            await this.request(
              request(this.id, this.storageId, 'set', { key: STORAGE_KEY_OPENAI, value: openaiKey })
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
    }

    // Configure all providers and tier routing
    const hasAnyConfig = anthropicKey || openaiKey || ollamaUrl;
    const hasTierConfig = tierRouting.smart.provider || tierRouting.balanced.provider || tierRouting.fast.provider;
    if ((hasAnyConfig || hasTierConfig) && this.llmId) {
      await this.configureProviders(anthropicKey, openaiKey, ollamaUrl, tierRouting);
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
    anthropicKey: string | null,
    openaiKey: string | null,
    ollamaUrl: string | null,
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
      anthropicApiKey: anthropicKey ?? undefined,
      openaiApiKey: openaiKey ?? undefined,
      ollamaUrl: ollamaUrl || undefined,
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

    // Handle 'changed' events from widget dependents
    this.on('changed', async (m: AbjectMessage) => {
      const { aspect, value } = m.payload as { aspect: string; value?: unknown };
      const fromId = m.routing.from;

      // Tab bar changed
      if (fromId === this.tabBarId && aspect === 'change') {
        const idx = value as number;
        this.activeTab = idx === 0 ? 'ai' : 'auth';
        await this.switchTab();
        return;
      }

      if (fromId === this.saveBtnId && aspect === 'click') {
        await this.saveSettings();
        return;
      }

      if (fromId === this.anthropicToggleId && aspect === 'click') {
        await this.toggleMask(this.anthropicKeyId!, this.anthropicToggleId!);
        return;
      }

      if (fromId === this.openaiToggleId && aspect === 'click') {
        await this.toggleMask(this.openaiKeyId!, this.openaiToggleId!);
        return;
      }

      // Tier provider dropdown changed -- refresh model list for that tier
      for (const tier of TIER_NAMES) {
        if (fromId === this.tierProviderSelectIds[tier] && aspect === 'change') {
          await this.refreshTierModelOptions(tier);
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
    const winH = 580;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
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
          tabs: ['AI', 'Auth'],
          closable: false,
          selectedIndex: this.activeTab === 'ai' ? 0 : 1 },
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
    // Show correct tab
    await this.switchTab();

    this.changed('visibility', true);
    return true;
  }

  /** Build AI tab content into aiContainerId. */
  private async buildAiTab(): Promise<void> {
    const cId = this.aiContainerId!;

    // Load saved values to populate inputs
    let savedAnthropicKey: string | null = null;
    let savedOpenaiKey: string | null = null;
    let savedOllamaUrl: string | null = null;
    const savedTierRouting: Record<ModelTierName, { provider: string | null; model: string | null }> = {
      smart: { provider: null, model: null },
      balanced: { provider: null, model: null },
      fast: { provider: null, model: null },
    };
    if (this.storageId) {
      savedAnthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      savedOpenaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OPENAI })
      );
      savedOllamaUrl = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OLLAMA_URL })
      );
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

    // Fetch model lists for all providers
    await this.fetchAllProviderModels(savedOllamaUrl);

    // ── Credentials section ──
    const { widgetIds: [credHeaderId, credDescId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Credentials',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId, text: 'Enter API keys for cloud providers. Ollama runs locally.',
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

    // Anthropic API Key row
    const { widgetIds: [anthropicLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Anthropic API Key',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: anthropicLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    const anthropicRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: anthropicRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [anthropicKeyId, anthropicToggleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'sk-ant-...', masked: true,
          text: savedAnthropicKey ?? undefined },
        { type: 'button', windowId: this.windowId, text: 'Show' },
      ]})
    );
    this.anthropicKeyId = anthropicKeyId;
    this.anthropicToggleId = anthropicToggleId;
    await this.request(request(this.id, this.anthropicKeyId, 'addDependent', {}));
    await this.request(request(this.id, anthropicRowId, 'addLayoutChild', {
      widgetId: this.anthropicKeyId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.anthropicToggleId, 'addDependent', {}));
    await this.request(request(this.id, anthropicRowId, 'addLayoutChild', {
      widgetId: this.anthropicToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // OpenAI API Key row
    const { widgetIds: [openaiLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'OpenAI API Key',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: openaiLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    const openaiRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: openaiRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    const { widgetIds: [openaiKeyId, openaiToggleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'sk-...', masked: true,
          text: savedOpenaiKey ?? undefined },
        { type: 'button', windowId: this.windowId, text: 'Show' },
      ]})
    );
    this.openaiKeyId = openaiKeyId;
    this.openaiToggleId = openaiToggleId;
    await this.request(request(this.id, this.openaiKeyId, 'addDependent', {}));
    await this.request(request(this.id, openaiRowId, 'addLayoutChild', {
      widgetId: this.openaiKeyId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.openaiToggleId, 'addDependent', {}));
    await this.request(request(this.id, openaiRowId, 'addLayoutChild', {
      widgetId: this.openaiToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Ollama URL row
    const { widgetIds: [ollamaLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Ollama URL',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: ollamaLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    const { widgetIds: [ollamaUrlId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'http://localhost:11434',
          text: savedOllamaUrl || 'http://localhost:11434' },
      ]})
    );
    this.ollamaUrlId = ollamaUrlId;
    await this.request(request(this.id, this.ollamaUrlId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.ollamaUrlId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
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

    const { widgetIds: [skillBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Open Skill Browser',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ]})
    );
    this.skillBrowserBtnId = skillBtnId;
    await this.request(request(this.id, this.skillBrowserBtnId, 'addDependent', {}));
    await this.request(request(this.id, skillRowId, 'addLayoutChild', {
      widgetId: this.skillBrowserBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 160, height: 36 },
    }));
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
    this.anthropicKeyId = undefined;
    this.anthropicToggleId = undefined;
    this.openaiKeyId = undefined;
    this.openaiToggleId = undefined;
    this.ollamaUrlId = undefined;
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
    this.tabBarId = undefined;
    this.aiContainerId = undefined;
    this.authContainerId = undefined;
    this.unmasked.clear();

    this.changed('visibility', false);
    return true;
  }

  /** Show/hide tab containers based on activeTab. */
  private async switchTab(): Promise<void> {
    if (!this.aiContainerId || !this.authContainerId) return;
    const showAi = this.activeTab === 'ai';
    await this.request(request(this.id, this.aiContainerId, 'update', { style: { visible: showAi } }));
    await this.request(request(this.id, this.authContainerId, 'update', { style: { visible: !showAi } }));
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
      this.saveBtnId, this.anthropicKeyId, this.openaiKeyId, this.ollamaUrlId,
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

  /**
   * Fetch model lists for all providers and cache them.
   */
  private async fetchAllProviderModels(ollamaUrl?: string | null): Promise<void> {
    // Anthropic and OpenAI have static model lists; Ollama is dynamic
    this.providerModelCache.anthropic = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ];
    this.providerModelCache.openai = [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
    ];
    this.providerModelCache.ollama = [];
    if (this.llmId) {
      try {
        const models = await this.request<ModelInfo[]>(
          request(this.id, this.llmId, 'listProviderModels', {
            provider: 'ollama',
            ollamaUrl: ollamaUrl || 'http://localhost:11434',
          })
        );
        this.providerModelCache.ollama = models;
      } catch { /* Ollama not running */ }
    }
  }

  /**
   * Refresh the model dropdown for a specific tier after its provider changed.
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

    const modelList = this.providerModelCache[providerName];
    const options = modelList.length > 0
      ? modelList.map(m => m.name)
      : ['(no models)'];

    await this.request(
      request(this.id, modelSelectId, 'update', { options, selectedIndex: 0 })
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

  // ========== API KEYS ACTIONS ==========

  /**
   * Read widget values for the selected provider, save to global storage, and configure LLM.
   */
  private async saveSettings(): Promise<void> {
    if (!this.windowId) return;

    await this.setSaveControlsDisabled(true);

    // Read all credential values
    const anthropicKey = this.anthropicKeyId
      ? await this.request<string>(request(this.id, this.anthropicKeyId, 'getValue', {}))
      : '';
    const openaiKey = this.openaiKeyId
      ? await this.request<string>(request(this.id, this.openaiKeyId, 'getValue', {}))
      : '';
    let ollamaUrl = this.ollamaUrlId
      ? await this.request<string>(request(this.id, this.ollamaUrlId, 'getValue', {}))
      : '';
    if (!ollamaUrl) ollamaUrl = 'http://localhost:11434';

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
        // Resolve display name back to model id
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

    // Validate: each configured tier's provider must have credentials
    for (const tier of TIER_NAMES) {
      const { provider } = tierRouting[tier];
      if (!provider) continue;
      if (provider === 'anthropic' && !anthropicKey) {
        await this.setStatus(`${TIER_LABELS[TIER_NAMES.indexOf(tier)]} tier uses Anthropic but no API key provided.`, this.theme.statusErrorBright);
        await this.setSaveControlsDisabled(false);
        return;
      }
      if (provider === 'openai' && !openaiKey) {
        await this.setStatus(`${TIER_LABELS[TIER_NAMES.indexOf(tier)]} tier uses OpenAI but no API key provided.`, this.theme.statusErrorBright);
        await this.setSaveControlsDisabled(false);
        return;
      }
    }

    // Persist credentials to storage
    if (this.storageId) {
      if (anthropicKey) {
        await this.request(
          request(this.id, this.storageId, 'set', { key: STORAGE_KEY_ANTHROPIC, value: anthropicKey })
        );
      }
      if (openaiKey) {
        await this.request(
          request(this.id, this.storageId, 'set', { key: STORAGE_KEY_OPENAI, value: openaiKey })
        );
      }
      await this.request(
        request(this.id, this.storageId, 'set', { key: STORAGE_KEY_OLLAMA_URL, value: ollamaUrl })
      );

      // Persist tier routing
      await this.persistTierRouting(tierRouting);
    }

    // Configure all providers and tier routing
    await this.configureProviders(
      anthropicKey || null,
      openaiKey || null,
      ollamaUrl || null,
      tierRouting,
    );

    log.info('Saved provider settings with per-tier routing');
    await this.setStatus('Settings saved!');
    await this.setSaveControlsDisabled(false);
  }
}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
