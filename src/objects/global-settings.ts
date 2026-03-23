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
const STORAGE_KEY_PROVIDER = 'global-settings:llmProvider';
const STORAGE_KEY_OLLAMA_URL = 'global-settings:ollamaUrl';
const STORAGE_KEY_OLLAMA_MODEL = 'global-settings:ollamaModel';
const STORAGE_KEY_AUTH_ENABLED = 'global-settings:authEnabled';
const STORAGE_KEY_AUTH_USER = 'global-settings:authUser';
const STORAGE_KEY_AUTH_PASS = 'global-settings:authPass';

type LLMProviderName = 'anthropic' | 'openai' | 'ollama';
const PROVIDER_LABELS: string[] = ['Anthropic', 'OpenAI', 'Ollama'];
const PROVIDER_NAMES: LLMProviderName[] = ['anthropic', 'openai', 'ollama'];

// Legacy keys for migration from per-workspace Settings
const LEGACY_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const LEGACY_KEY_OPENAI = 'settings:openaiApiKey';

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

  // Provider selection
  private selectedProvider: LLMProviderName = 'anthropic';
  private providerSelectId?: AbjectId;

  // Anthropic section widgets
  private anthropicKeyId?: AbjectId;
  private anthropicToggleId?: AbjectId;
  private anthropicSectionIds: AbjectId[] = [];

  // OpenAI section widgets
  private openaiKeyId?: AbjectId;
  private openaiToggleId?: AbjectId;
  private openaiSectionIds: AbjectId[] = [];

  // Ollama section widgets
  private ollamaUrlId?: AbjectId;
  private ollamaModelSelectId?: AbjectId;
  private ollamaSectionIds: AbjectId[] = [];

  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Auth widgets
  private authCheckboxId?: AbjectId;
  private authUserInputId?: AbjectId;
  private authPassInputId?: AbjectId;
  private authPassToggleId?: AbjectId;
  private authSaveBtnId?: AbjectId;

  private unmasked: Set<AbjectId> = new Set();

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
    let ollamaModel: string | null = null;
    let savedProvider: string | null = null;

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
      ollamaModel = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OLLAMA_MODEL })
      );
      savedProvider = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_PROVIDER })
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

      await this.applySavedAuthConfig();
    }

    // Determine selected provider
    if (savedProvider && PROVIDER_NAMES.includes(savedProvider as LLMProviderName)) {
      this.selectedProvider = savedProvider as LLMProviderName;
    } else if (anthropicKey) {
      this.selectedProvider = 'anthropic';
      if (this.storageId) {
        await this.request(
          request(this.id, this.storageId, 'set', { key: STORAGE_KEY_PROVIDER, value: 'anthropic' })
        );
      }
    } else if (openaiKey) {
      this.selectedProvider = 'openai';
      if (this.storageId) {
        await this.request(
          request(this.id, this.storageId, 'set', { key: STORAGE_KEY_PROVIDER, value: 'openai' })
        );
      }
    } else {
      this.selectedProvider = 'anthropic';
    }

    // Configure the selected provider
    const hasConfig = this.providerHasConfig(this.selectedProvider, anthropicKey, openaiKey, ollamaUrl);
    if (hasConfig && this.llmId) {
      await this.configureSelectedProvider(anthropicKey, openaiKey, ollamaUrl, ollamaModel);
      log.info(`Loaded saved provider: ${this.selectedProvider}`);
    } else {
      await this.show();
    }
  }

  private providerHasConfig(
    provider: LLMProviderName,
    anthropicKey: string | null,
    openaiKey: string | null,
    ollamaUrl: string | null,
  ): boolean {
    switch (provider) {
      case 'anthropic': return !!anthropicKey;
      case 'openai': return !!openaiKey;
      case 'ollama': return true; // Ollama works with default URL
    }
  }

  private async configureSelectedProvider(
    anthropicKey: string | null,
    openaiKey: string | null,
    ollamaUrl: string | null,
    ollamaModel: string | null = null,
  ): Promise<void> {
    if (!this.llmId) return;

    const config: Record<string, string | undefined> = {};
    switch (this.selectedProvider) {
      case 'anthropic':
        config.anthropicApiKey = anthropicKey ?? undefined;
        break;
      case 'openai':
        config.openaiApiKey = openaiKey ?? undefined;
        break;
      case 'ollama':
        config.ollamaUrl = ollamaUrl || 'http://localhost:11434';
        if (ollamaModel) config.ollamaModel = ollamaModel;
        break;
    }

    await this.request(request(this.id, this.llmId, 'configure', config));
    await this.request(request(this.id, this.llmId, 'setProvider', { name: this.selectedProvider }));
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
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // Provider dropdown changed
      if (fromId === this.providerSelectId && aspect === 'change') {
        const label = value as string;
        const idx = PROVIDER_LABELS.indexOf(label);
        if (idx >= 0) {
          this.selectedProvider = PROVIDER_NAMES[idx];
          await this.switchProviderFields(this.selectedProvider);
        }
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

      // Auth checkbox toggled — enable/disable auth credential fields
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

    const winW = 440;
    const winH = 640;
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

    const cId = this.rootLayoutId;

    // Load saved values to populate inputs
    let savedAnthropicKey: string | null = null;
    let savedOpenaiKey: string | null = null;
    let savedOllamaUrl: string | null = null;
    let savedOllamaModel: string | null = null;
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
      savedOllamaModel = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OLLAMA_MODEL })
      );
    }

    // Section header + description + provider dropdown
    const selectedIndex = PROVIDER_NAMES.indexOf(this.selectedProvider);
    const { widgetIds: [sectionHeaderId, descLabelId, providerSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'LLM Provider',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
        { type: 'label', windowId: this.windowId, text: 'Select your LLM provider and enter credentials.',
          style: { color: this.theme.textDescription, fontSize: 12 } },
        { type: 'select', windowId: this.windowId,
          options: PROVIDER_LABELS,
          selectedIndex: selectedIndex >= 0 ? selectedIndex : 0 },
      ]})
    );
    this.providerSelectId = providerSelectId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));
    await this.request(request(this.id, this.providerSelectId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.providerSelectId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // ── Anthropic section ──
    this.anthropicSectionIds = [];

    const { widgetIds: [anthropicLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'API Key',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    this.anthropicSectionIds.push(anthropicLabelId);
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
    this.anthropicSectionIds.push(anthropicRowId);
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

    // ── OpenAI section ──
    this.openaiSectionIds = [];

    const { widgetIds: [openaiLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'API Key',
          style: { color: this.theme.textHeading, fontSize: 13 } },
      ]})
    );
    this.openaiSectionIds.push(openaiLabelId);
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
    this.openaiSectionIds.push(openaiRowId);
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

    // ── Ollama section ──
    this.ollamaSectionIds = [];

    const { widgetIds: [ollamaLabelId, ollamaUrlId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Base URL',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'textInput', windowId: this.windowId, placeholder: 'http://localhost:11434',
          text: savedOllamaUrl || 'http://localhost:11434' },
      ]})
    );
    this.ollamaUrlId = ollamaUrlId;
    this.ollamaSectionIds.push(ollamaLabelId);
    this.ollamaSectionIds.push(this.ollamaUrlId);
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: ollamaLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, this.ollamaUrlId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.ollamaUrlId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Model dropdown
    let ollamaModels: string[] = [];
    if (this.llmId) {
      try {
        ollamaModels = await this.request<string[]>(
          request(this.id, this.llmId, 'listOllamaModels', {
            baseUrl: savedOllamaUrl || 'http://localhost:11434',
          })
        );
      } catch { /* Ollama not running */ }
    }
    const modelOptions = ollamaModels.length > 0 ? ollamaModels : ['(no models found)'];
    let modelSelectedIndex = 0;
    if (savedOllamaModel && ollamaModels.length > 0) {
      const idx = ollamaModels.indexOf(savedOllamaModel);
      if (idx >= 0) modelSelectedIndex = idx;
    }

    const { widgetIds: [ollamaModelLabelId, ollamaModelSelectId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Model',
          style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'select', windowId: this.windowId,
          options: modelOptions,
          selectedIndex: modelSelectedIndex },
      ]})
    );
    this.ollamaModelSelectId = ollamaModelSelectId;
    this.ollamaSectionIds.push(ollamaModelLabelId);
    this.ollamaSectionIds.push(this.ollamaModelSelectId);
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: ollamaModelLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, this.ollamaModelSelectId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.ollamaModelSelectId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Hide non-selected provider sections
    await this.switchProviderFields(this.selectedProvider);

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
        { type: 'button', windowId: this.windowId, text: 'Save Provider',
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

    // ── Auth section ──────────────────────────────────────────────────

    // Divider + auth section header
    const { widgetIds: [authDividerId, authHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'divider', windowId: this.windowId },
        { type: 'label', windowId: this.windowId, text: 'Authentication',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
      ]})
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authDividerId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 12 },
    }));
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

    // Spacer + status label
    await this.request(request(this.id, cId, 'addLayoutSpacer', {}));

    const { widgetIds: [statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId!, text: '',
          style: { color: this.theme.textDescription, fontSize: 12, align: 'right' } },
      ]})
    );
    this.statusLabelId = statusLabelId;
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    this.changed('visibility', true);
    return true;
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
    this.providerSelectId = undefined;
    this.anthropicKeyId = undefined;
    this.anthropicToggleId = undefined;
    this.anthropicSectionIds = [];
    this.openaiKeyId = undefined;
    this.openaiToggleId = undefined;
    this.openaiSectionIds = [];
    this.ollamaUrlId = undefined;
    this.ollamaModelSelectId = undefined;
    this.ollamaSectionIds = [];
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.authCheckboxId = undefined;
    this.authUserInputId = undefined;
    this.authPassInputId = undefined;
    this.authPassToggleId = undefined;
    this.authSaveBtnId = undefined;
    this.unmasked.clear();

    this.changed('visibility', false);
    return true;
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
    const ids = [this.saveBtnId, this.providerSelectId, this.anthropicKeyId, this.openaiKeyId, this.ollamaUrlId, this.ollamaModelSelectId];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  // ========== PROVIDER VISIBILITY ==========

  private async switchProviderFields(provider: LLMProviderName): Promise<void> {
    const sections: Record<LLMProviderName, AbjectId[]> = {
      anthropic: this.anthropicSectionIds,
      openai: this.openaiSectionIds,
      ollama: this.ollamaSectionIds,
    };

    for (const [name, ids] of Object.entries(sections)) {
      const visible = name === provider;
      for (const id of ids) {
        try {
          await this.request(request(this.id, id, 'update', { style: { visible } }));
        } catch { /* widget gone */ }
      }
    }
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

    const provider = this.selectedProvider;

    // Read values for the active provider
    let anthropicKey = '';
    let openaiKey = '';
    let ollamaUrl = '';

    switch (provider) {
      case 'anthropic':
        anthropicKey = await this.request<string>(
          request(this.id, this.anthropicKeyId!, 'getValue', {})
        );
        if (!anthropicKey) {
          await this.setStatus('Anthropic API key is required.', this.theme.statusErrorBright);
          await this.setSaveControlsDisabled(false);
          return;
        }
        break;
      case 'openai':
        openaiKey = await this.request<string>(
          request(this.id, this.openaiKeyId!, 'getValue', {})
        );
        if (!openaiKey) {
          await this.setStatus('OpenAI API key is required.', this.theme.statusErrorBright);
          await this.setSaveControlsDisabled(false);
          return;
        }
        break;
      case 'ollama':
        ollamaUrl = await this.request<string>(
          request(this.id, this.ollamaUrlId!, 'getValue', {})
        );
        if (!ollamaUrl) ollamaUrl = 'http://localhost:11434';
        break;
    }

    // Read Ollama model if applicable
    let ollamaModel = '';
    if (provider === 'ollama' && this.ollamaModelSelectId) {
      ollamaModel = await this.request<string>(
        request(this.id, this.ollamaModelSelectId, 'getValue', {})
      );
      // Ignore placeholder
      if (ollamaModel === '(no models found)') ollamaModel = '';
    }

    // Persist to storage
    if (this.storageId) {
      await this.request(
        request(this.id, this.storageId, 'set', { key: STORAGE_KEY_PROVIDER, value: provider })
      );
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
      if (provider === 'ollama') {
        await this.request(
          request(this.id, this.storageId, 'set', { key: STORAGE_KEY_OLLAMA_URL, value: ollamaUrl })
        );
        if (ollamaModel) {
          await this.request(
            request(this.id, this.storageId, 'set', { key: STORAGE_KEY_OLLAMA_MODEL, value: ollamaModel })
          );
        }
      }
    }

    // Configure LLM with the selected provider
    await this.configureSelectedProvider(
      anthropicKey || null,
      openaiKey || null,
      ollamaUrl || null,
      ollamaModel || null,
    );

    log.info(`Saved provider: ${provider}`);
    await this.setStatus('Provider settings saved!');
    await this.setSaveControlsDisabled(false);
  }
}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
