/**
 * Settings object - provides UI for configuring the system (LLM API keys, etc).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';

const SETTINGS_INTERFACE: InterfaceId = 'abjects:settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';

const STORAGE_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const STORAGE_KEY_OPENAI = 'settings:openaiApiKey';

/**
 * Settings object that provides a configuration UI for LLM API keys.
 */
export class Settings extends Abject {
  private llmId?: AbjectId;
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: string;
  private unmasked: Set<string> = new Set();

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

    this.on('widgetEvent', async (msg: AbjectMessage) => {
      const payload = msg.payload as { windowId: string; widgetId: string; type: string; value?: string };
      await this.handleWidgetEvent(payload);
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

    // Create window
    this.windowId = await this.request<string>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindow', {
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
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'anthropic-label',
        type: 'label',
        rect: { x: pad, y, width: inputW, height: 20 },
        text: 'Anthropic API Key',
      })
    );
    y += 24;

    // Anthropic text input + show/hide button
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'anthropic-key',
        type: 'textInput',
        rect: { x: pad, y, width: inputW, height: inputH },
        placeholder: 'sk-ant-...',
        masked: true,
      })
    );
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'anthropic-toggle',
        type: 'button',
        rect: { x: pad + inputW + gap, y, width: toggleW, height: inputH },
        text: 'Show',
      })
    );
    y += inputH + 20;

    // OpenAI label
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'openai-label',
        type: 'label',
        rect: { x: pad, y, width: inputW, height: 20 },
        text: 'OpenAI API Key',
      })
    );
    y += 24;

    // OpenAI text input + show/hide button
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'openai-key',
        type: 'textInput',
        rect: { x: pad, y, width: inputW, height: inputH },
        placeholder: 'sk-...',
        masked: true,
      })
    );
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'openai-toggle',
        type: 'button',
        rect: { x: pad + inputW + gap, y, width: toggleW, height: inputH },
        text: 'Show',
      })
    );
    y += inputH + 24;

    // Save button
    const btnW = 100;
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'addWidget', {
        windowId: this.windowId,
        id: 'save-btn',
        type: 'button',
        rect: { x: winW - pad - btnW, y, width: btnW, height: 36 },
        text: 'Save',
      })
    );

    return true;
  }

  /**
   * Hide the settings window.
   */
  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindow', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    return true;
  }

  /**
   * Handle widget interaction events.
   */
  private async handleWidgetEvent(payload: { windowId: string; widgetId: string; type: string; value?: string }): Promise<void> {
    if (payload.widgetId === 'save-btn' && payload.type === 'click') {
      await this.saveSettings();
    }

    if (payload.widgetId === 'anthropic-toggle' && payload.type === 'click') {
      await this.toggleMask('anthropic-key', 'anthropic-toggle');
    }

    if (payload.widgetId === 'openai-toggle' && payload.type === 'click') {
      await this.toggleMask('openai-key', 'openai-toggle');
    }

    if (payload.type === 'submit') {
      await this.saveSettings();
    }
  }

  /**
   * Toggle masked state on a text input and update its toggle button label.
   */
  private async toggleMask(inputId: string, toggleId: string): Promise<void> {
    if (!this.windowId) return;

    // Read current masked state via a round-trip: if value looks masked, it's masked.
    // Instead, track locally which inputs are currently masked.
    const showing = this.unmasked.has(inputId);
    if (showing) {
      this.unmasked.delete(inputId);
    } else {
      this.unmasked.add(inputId);
    }
    const nowMasked = !this.unmasked.has(inputId);

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'updateWidget', {
        widgetId: inputId,
        masked: nowMasked,
      })
    );
    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'updateWidget', {
        widgetId: toggleId,
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
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getWidgetValue', {
        widgetId: 'anthropic-key',
      })
    );

    const openaiKey = await this.request<string>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getWidgetValue', {
        widgetId: 'openai-key',
      })
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
