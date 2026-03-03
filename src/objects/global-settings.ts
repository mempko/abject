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

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const STORAGE_KEY_ANTHROPIC = 'global-settings:anthropicApiKey';
const STORAGE_KEY_OPENAI = 'global-settings:openaiApiKey';
const STORAGE_KEY_AUTH_ENABLED = 'global-settings:authEnabled';
const STORAGE_KEY_AUTH_USER = 'global-settings:authUser';
const STORAGE_KEY_AUTH_PASS = 'global-settings:authPass';

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

  // API Keys widgets
  private anthropicKeyId?: AbjectId;
  private anthropicToggleId?: AbjectId;
  private openaiKeyId?: AbjectId;
  private openaiToggleId?: AbjectId;
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
    this.llmId = await this.requireDep('LLM');
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.uiServerId = await this.requireDep('UIServer');

    // Try to load saved API keys from global storage
    let anthropicKey: string | null = null;
    let openaiKey: string | null = null;

    if (this.storageId) {
      anthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      openaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OPENAI })
      );

      // If not found, attempt migration from legacy per-workspace keys
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

          // Persist under new keys
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
          console.log('[GLOBAL-SETTINGS] Migrated API keys from legacy storage');
        }
      }

      // Load saved auth settings and apply to BackendUI
      await this.applySavedAuthConfig();
    }

    if (anthropicKey || openaiKey) {
      // Keys found — configure LLM silently
      if (this.llmId) {
        await this.request(
          request(this.id, this.llmId, 'configure', {
            anthropicApiKey: anthropicKey ?? undefined,
            openaiApiKey: openaiKey ?? undefined,
          })
        );
      }
      console.log('[GLOBAL-SETTINGS] Loaded saved API keys');
    } else {
      // No keys — show settings UI
      await this.show();
    }
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

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    const cId = this.rootLayoutId;

    // Load saved keys to populate inputs
    let savedAnthropicKey: string | null = null;
    let savedOpenaiKey: string | null = null;
    if (this.storageId) {
      savedAnthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      savedOpenaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_OPENAI })
      );
    }

    // Section header: "API Keys"
    const sectionHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'API Keys',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    const descLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Enter your API keys to enable LLM features.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Anthropic label
    const anthropicLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Anthropic API Key',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: anthropicLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Anthropic input row (HBox: input + toggle)
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

    this.anthropicKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'sk-ant-...', masked: true,
        text: savedAnthropicKey ?? undefined,
      })
    );
    await this.request(request(this.id, this.anthropicKeyId, 'addDependent', {}));
    await this.request(request(this.id, anthropicRowId, 'addLayoutChild', {
      widgetId: this.anthropicKeyId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.anthropicToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Show',
      })
    );
    await this.request(request(this.id, this.anthropicToggleId, 'addDependent', {}));
    await this.request(request(this.id, anthropicRowId, 'addLayoutChild', {
      widgetId: this.anthropicToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Divider between Anthropic and OpenAI
    const dividerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: dividerId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 12 },
    }));

    // OpenAI label
    const openaiLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'OpenAI API Key',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: openaiLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // OpenAI input row (HBox: input + toggle)
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

    this.openaiKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'sk-...', masked: true,
        text: savedOpenaiKey ?? undefined,
      })
    );
    await this.request(request(this.id, this.openaiKeyId, 'addDependent', {}));
    await this.request(request(this.id, openaiRowId, 'addLayoutChild', {
      widgetId: this.openaiKeyId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.openaiToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Show',
      })
    );
    await this.request(request(this.id, this.openaiToggleId, 'addDependent', {}));
    await this.request(request(this.id, openaiRowId, 'addLayoutChild', {
      widgetId: this.openaiToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

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

    this.saveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save API Keys',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.saveBtnId, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, 'addLayoutChild', {
      widgetId: this.saveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 120, height: 36 },
    }));

    // ── Auth section ──────────────────────────────────────────────────

    // Divider before auth
    const authDividerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authDividerId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 12 },
    }));

    // Section header: "Authentication"
    const authHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Authentication',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
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

    this.authCheckboxId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createCheckbox', {
        windowId: this.windowId, rect: r0,
        checked: savedAuthEnabled,
        text: 'Require login',
      })
    );
    await this.request(request(this.id, this.authCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, authEnableRowId, 'addLayoutChild', {
      widgetId: this.authCheckboxId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Username label
    const authUserLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Username',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: authUserLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Username input
    this.authUserInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Username',
        text: savedAuthUser || undefined,
        style: savedAuthEnabled ? undefined : { disabled: true },
      })
    );
    await this.request(request(this.id, this.authUserInputId, 'addDependent', {}));
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.authUserInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Password label
    const authPassLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Password',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
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

    this.authPassInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Password', masked: true,
        text: savedAuthPass || undefined,
        style: savedAuthEnabled ? undefined : { disabled: true },
      })
    );
    await this.request(request(this.id, this.authPassInputId, 'addDependent', {}));
    await this.request(request(this.id, authPassRowId, 'addLayoutChild', {
      widgetId: this.authPassInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.authPassToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Show',
        style: savedAuthEnabled ? undefined : { disabled: true },
      })
    );
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

    this.authSaveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save Auth',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.authSaveBtnId, 'addDependent', {}));
    await this.request(request(this.id, authSaveRowId, 'addLayoutChild', {
      widgetId: this.authSaveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 120, height: 36 },
    }));

    // Spacer + status label
    await this.request(request(this.id, cId, 'addLayoutSpacer', {}));

    this.statusLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId!, rect: r0, text: '',
        style: { color: '#b4b8c8', fontSize: 12, align: 'right' },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    await this.changed('visibility', true);
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
    this.anthropicKeyId = undefined;
    this.anthropicToggleId = undefined;
    this.openaiKeyId = undefined;
    this.openaiToggleId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.authCheckboxId = undefined;
    this.authUserInputId = undefined;
    this.authPassInputId = undefined;
    this.authPassToggleId = undefined;
    this.authSaveBtnId = undefined;
    this.unmasked.clear();

    await this.changed('visibility', false);
    return true;
  }

  // ========== HELPERS ==========

  private async setStatus(text: string, color = '#b4b8c8'): Promise<void> {
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
    const ids = [this.saveBtnId, this.anthropicKeyId, this.openaiKeyId];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, 'update', { style })); } catch { /* widget gone */ }
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
    console.log(`[GLOBAL-SETTINGS] Applied saved auth config (enabled=${enabled})`);
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
      await this.setStatus('Username and password are required.', '#f87171');
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

    console.log(`[GLOBAL-SETTINGS] Auth settings saved (enabled=${enabled})`);
    await this.setStatus(enabled ? 'Auth enabled. Reconnecting...' : 'Auth disabled.');
  }

  // ========== API KEYS ACTIONS ==========

  /**
   * Read widget values, save to global storage, and configure LLM.
   */
  private async saveSettings(): Promise<void> {
    if (!this.windowId) return;

    await this.setSaveControlsDisabled(true);

    const anthropicKey = await this.request<string>(
      request(this.id, this.anthropicKeyId!, 'getValue', {})
    );

    const openaiKey = await this.request<string>(
      request(this.id, this.openaiKeyId!, 'getValue', {})
    );

    // Save to global storage
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
    }

    // Configure LLM
    if (this.llmId) {
      await this.request(
        request(this.id, this.llmId, 'configure', {
          anthropicApiKey: anthropicKey || undefined,
          openaiApiKey: openaiKey || undefined,
        })
      );

      const providers = await this.request<string[]>(
        request(this.id, this.llmId, 'listProviders', {})
      );
      console.log(`[GLOBAL-SETTINGS] Saved. LLM providers: ${providers.join(', ') || 'none'}`);
    }

    await this.setStatus('API keys saved!');
    await this.setSaveControlsDisabled(false);
  }
}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
