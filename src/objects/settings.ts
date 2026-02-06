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

    const pad = 16;
    const toggleW = 56;
    const gap = 8;
    const inputW = winW - pad * 2 - toggleW - gap;
    const inputH = 32;
    let y = 16;

    // Anthropic label
    this.anthropicLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: pad, y, width: inputW, height: 20 },
        text: 'Anthropic API Key',
      })
    );
    await this.request(request(this.id, this.anthropicLabelId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    y += 24;

    // Anthropic text input
    this.anthropicKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: { x: pad, y, width: inputW, height: inputH },
        placeholder: 'sk-ant-...',
        masked: true,
      })
    );
    await this.request(request(this.id, this.anthropicKeyId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));

    // Anthropic show/hide toggle button
    this.anthropicToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: pad + inputW + gap, y, width: toggleW, height: inputH },
        text: 'Show',
      })
    );
    await this.request(request(this.id, this.anthropicToggleId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    y += inputH + 20;

    // OpenAI label
    this.openaiLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: { x: pad, y, width: inputW, height: 20 },
        text: 'OpenAI API Key',
      })
    );
    await this.request(request(this.id, this.openaiLabelId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    y += 24;

    // OpenAI text input
    this.openaiKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: { x: pad, y, width: inputW, height: inputH },
        placeholder: 'sk-...',
        masked: true,
      })
    );
    await this.request(request(this.id, this.openaiKeyId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));

    // OpenAI show/hide toggle button
    this.openaiToggleId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: pad + inputW + gap, y, width: toggleW, height: inputH },
        text: 'Show',
      })
    );
    await this.request(request(this.id, this.openaiToggleId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    y += inputH + 24;

    // Save button
    const btnW = 100;
    this.saveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: { x: winW - pad - btnW, y, width: btnW, height: 36 },
        text: 'Save',
      })
    );
    await this.request(request(this.id, this.saveBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));

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
