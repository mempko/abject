/**
 * Settings object - provides UI for configuring the system (LLM API keys, etc).
 *
 * Uses direct widget Abject interaction (createWindowAbject, createButton, etc.)
 * instead of the legacy string-based widget ID shim.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const SETTINGS_INTERFACE: InterfaceId = 'abjects:settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

const STORAGE_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const STORAGE_KEY_OPENAI = 'settings:openaiApiKey';

/**
 * Settings object that provides a configuration UI for LLM API keys.
 *
 * Widgets are first-class Abjects identified by AbjectId. This object registers
 * as a dependent of each widget and listens for 'changed' events to handle
 * user interactions.
 */
export class Settings extends Abject {
  private llmId?: AbjectId;
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // Widget AbjectIds
  private anthropicLabelId?: AbjectId;
  private anthropicKeyId?: AbjectId;
  private anthropicToggleId?: AbjectId;
  private openaiLabelId?: AbjectId;
  private openaiKeyId?: AbjectId;
  private openaiToggleId?: AbjectId;
  private saveBtnId?: AbjectId;

  private unmasked: Set<AbjectId> = new Set();

  constructor() {
    super({
      manifest: {
        name: 'Settings',
        description:
          'System configuration UI. Manages LLM API keys and persists settings.',
        version: '1.0.0',
        interfaces: [
          {
            id: SETTINGS_INTERFACE,
            name: 'Settings',
            description: 'System configuration',
            methods: [
              {
                name: 'show',
                description: 'Show the settings window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the settings window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
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

  /**
   * Set dependencies.
   */
  setDependencies(llmId: AbjectId, storageId: AbjectId, widgetManagerId: AbjectId): void {
    this.llmId = llmId;
    this.storageId = storageId;
    this.widgetManagerId = widgetManagerId;
  }

  protected async onInit(): Promise<void> {
    // Try to load saved API keys from storage
    let anthropicKey: string | null = null;
    let openaiKey: string | null = null;

    if (this.storageId) {
      anthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      openaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: STORAGE_KEY_OPENAI })
      );
    }

    if (anthropicKey || openaiKey) {
      // Keys found — configure LLM silently
      if (this.llmId) {
        await this.request(
          request(this.id, this.llmId, 'abjects:llm' as InterfaceId, 'configure', {
            anthropicApiKey: anthropicKey ?? undefined,
            openaiApiKey: openaiKey ?? undefined,
          })
        );
      }
      console.log('[SETTINGS] Loaded saved API keys');
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

    // Handle 'changed' events from widget dependents
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.saveBtnId && aspect === 'click') {
        await this.saveSettings();
      }

      if (fromId === this.anthropicToggleId && aspect === 'click') {
        await this.toggleMask(this.anthropicKeyId!, this.anthropicToggleId!);
      }

      if (fromId === this.openaiToggleId && aspect === 'click') {
        await this.toggleMask(this.openaiKeyId!, this.openaiToggleId!);
      }

      // Text input submit triggers save
      if (aspect === 'submit') {
        await this.saveSettings();
      }
    });
  }

  /**
   * Show the settings window.
   */
  async show(): Promise<boolean> {
    if (this.windowId) return true;

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winW = 420;
    const winH = 300;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window — returns an AbjectId
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 16, right: 16, bottom: 16, left: 16 },
        spacing: 8,
      })
    );

    // Anthropic label
    this.anthropicLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Anthropic API Key',
      })
    );
    await this.request(request(this.id, this.anthropicLabelId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.anthropicLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Anthropic input row (HBox: input + toggle)
    const anthropicRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: anthropicRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.anthropicKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'sk-ant-...', masked: true,
      })
    );
    await this.request(request(this.id, this.anthropicKeyId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, anthropicRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.anthropicKeyId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.anthropicToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Show',
      })
    );
    await this.request(request(this.id, this.anthropicToggleId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, anthropicRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.anthropicToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // OpenAI label
    this.openaiLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'OpenAI API Key',
      })
    );
    await this.request(request(this.id, this.openaiLabelId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.openaiLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // OpenAI input row (HBox: input + toggle)
    const openaiRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: openaiRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.openaiKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'sk-...', masked: true,
      })
    );
    await this.request(request(this.id, this.openaiKeyId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, openaiRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.openaiKeyId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.openaiToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Show',
      })
    );
    await this.request(request(this.id, this.openaiToggleId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, openaiRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.openaiToggleId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 56, height: 32 },
    }));

    // Spacer pushes save button to bottom
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Save button row (HBox: spacer + button)
    const saveRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: saveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, saveRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    this.saveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save',
      })
    );
    await this.request(request(this.id, this.saveBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.saveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 100, height: 36 },
    }));

    return true;
  }

  /**
   * Hide the settings window.
   */
  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.anthropicLabelId = undefined;
    this.anthropicKeyId = undefined;
    this.anthropicToggleId = undefined;
    this.openaiLabelId = undefined;
    this.openaiKeyId = undefined;
    this.openaiToggleId = undefined;
    this.saveBtnId = undefined;
    this.unmasked.clear();

    return true;
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
      request(this.id, inputId, WIDGET_INTERFACE, 'update', {
        masked: nowMasked,
      })
    );
    await this.request(
      request(this.id, toggleId, WIDGET_INTERFACE, 'update', {
        text: nowMasked ? 'Show' : 'Hide',
      })
    );
  }

  /**
   * Read widget values, save to storage, and configure LLM.
   */
  private async saveSettings(): Promise<void> {
    if (!this.windowId) return;

    const anthropicKey = await this.request<string>(
      request(this.id, this.anthropicKeyId!, WIDGET_INTERFACE, 'getValue', {})
    );

    const openaiKey = await this.request<string>(
      request(this.id, this.openaiKeyId!, WIDGET_INTERFACE, 'getValue', {})
    );

    // Save to storage
    if (this.storageId) {
      if (anthropicKey) {
        await this.request(
          request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'set', { key: STORAGE_KEY_ANTHROPIC, value: anthropicKey })
        );
      }
      if (openaiKey) {
        await this.request(
          request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'set', { key: STORAGE_KEY_OPENAI, value: openaiKey })
        );
      }
    }

    // Configure LLM
    if (this.llmId) {
      await this.request(
        request(this.id, this.llmId, 'abjects:llm' as InterfaceId, 'configure', {
          anthropicApiKey: anthropicKey || undefined,
          openaiApiKey: openaiKey || undefined,
        })
      );

      const providers = await this.request<string[]>(
        request(this.id, this.llmId, 'abjects:llm' as InterfaceId, 'listProviders', {})
      );
      console.log(`[SETTINGS] Saved. LLM providers: ${providers.join(', ') || 'none'}`);
    }

    // Close the settings window
    await this.hide();
  }
}

// Well-known settings ID
export const SETTINGS_ID = 'abjects:settings' as AbjectId;
