/**
 * GlobalSettings object - provides UI for configuring global LLM API keys,
 * peer identity management, and P2P contact/connection management.
 *
 * This is a global (non-per-workspace) object that manages API keys in
 * global Storage. On first boot with no keys, it auto-shows to prompt
 * the user. Keys are persisted with the 'global-settings:' prefix.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const IDENTITY_INTERFACE: InterfaceId = 'abjects:identity';
const CLIPBOARD_INTERFACE: InterfaceId = 'abjects:clipboard';
const PEER_REGISTRY_INTERFACE: InterfaceId = 'abjects:peer-registry';

const STORAGE_KEY_ANTHROPIC = 'global-settings:anthropicApiKey';
const STORAGE_KEY_OPENAI = 'global-settings:openaiApiKey';
const STORAGE_KEY_SIGNALING = 'peer-registry:signaling-urls';

// Legacy keys for migration from per-workspace Settings
const LEGACY_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const LEGACY_KEY_OPENAI = 'settings:openaiApiKey';

/**
 * GlobalSettings object that provides a configuration UI for LLM API keys,
 * identity management, and peer network controls.
 *
 * Widgets are first-class Abjects identified by AbjectId. This object registers
 * as a dependent of each widget and listens for 'changed' events to handle
 * user interactions.
 */
export class GlobalSettings extends Abject {
  private llmId?: AbjectId;
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private identityId?: AbjectId;
  private clipboardId?: AbjectId;
  private peerRegistryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;

  // API Keys widgets
  private anthropicLabelId?: AbjectId;
  private anthropicKeyId?: AbjectId;
  private anthropicToggleId?: AbjectId;
  private openaiLabelId?: AbjectId;
  private openaiKeyId?: AbjectId;
  private openaiToggleId?: AbjectId;
  private saveBtnId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Identity section widgets
  private nameInputId?: AbjectId;
  private saveNameBtnId?: AbjectId;
  private copyPeerIdBtnId?: AbjectId;
  private copyIdentityBtnId?: AbjectId;

  // Peer section widgets
  private signalingInputId?: AbjectId;
  private signalingConnectBtnId?: AbjectId;
  private addContactInputId?: AbjectId;
  private addContactBtnId?: AbjectId;

  /** Maps connect/disconnect button AbjectId -> peerId */
  private connectButtons: Map<AbjectId, string> = new Map();
  /** Maps remove button AbjectId -> peerId */
  private removeButtons: Map<AbjectId, string> = new Map();

  private unmasked: Set<AbjectId> = new Set();

  // Tab state
  private activeTab: 'api-keys' | 'peer-network' = 'api-keys';
  private tabBarId?: AbjectId;
  /** Maps signaling disconnect button AbjectId -> URL */
  private signalingDisconnectButtons: Map<AbjectId, string> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'GlobalSettings',
        description:
          'Global configuration UI. Manages LLM API keys, peer identity, and P2P connections.',
        version: '1.0.0',
        interfaces: [
          {
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

  protected override async onInit(): Promise<void> {
    this.llmId = await this.requireDep('LLM');
    this.storageId = await this.requireDep('Storage');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.identityId = await this.discoverDep('Identity') ?? undefined;
    this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;

    // Try to load saved API keys from global storage
    let anthropicKey: string | null = null;
    let openaiKey: string | null = null;

    if (this.storageId) {
      anthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      openaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: STORAGE_KEY_OPENAI })
      );

      // If not found, attempt migration from legacy per-workspace keys
      if (!anthropicKey && !openaiKey) {
        const legacyAnthropic = await this.request<string | null>(
          request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: LEGACY_KEY_ANTHROPIC })
        );
        const legacyOpenai = await this.request<string | null>(
          request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: LEGACY_KEY_OPENAI })
        );

        if (legacyAnthropic || legacyOpenai) {
          anthropicKey = legacyAnthropic;
          openaiKey = legacyOpenai;

          // Persist under new keys
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
          console.log('[GLOBAL-SETTINGS] Migrated API keys from legacy storage');
        }
      }
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

      // Tab bar change
      if (fromId === this.tabBarId && aspect === 'change') {
        const idx = value as number;
        this.activeTab = idx === 0 ? 'api-keys' : 'peer-network';
        await this.hide();
        await this.show();
        return;
      }

      // Signaling server disconnect buttons
      if (aspect === 'click' && this.signalingDisconnectButtons.has(fromId)) {
        const url = this.signalingDisconnectButtons.get(fromId)!;
        await this.disconnectSignalingServer(url);
        return;
      }

      // API Keys section
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

      // Identity section
      if (fromId === this.saveNameBtnId && aspect === 'click') {
        await this.saveName();
        return;
      }

      if (fromId === this.copyPeerIdBtnId && aspect === 'click') {
        await this.copyPeerId();
        return;
      }

      if (fromId === this.copyIdentityBtnId && aspect === 'click') {
        await this.copyIdentityJson();
        return;
      }

      // Peer section
      if (fromId === this.signalingConnectBtnId && aspect === 'click') {
        await this.connectSignaling();
        return;
      }

      if (fromId === this.addContactBtnId && aspect === 'click') {
        await this.addContact();
        return;
      }

      if (aspect === 'click' && this.connectButtons.has(fromId)) {
        const peerId = this.connectButtons.get(fromId)!;
        await this.toggleConnection(peerId);
        return;
      }

      if (aspect === 'click' && this.removeButtons.has(fromId)) {
        const peerId = this.removeButtons.get(fromId)!;
        await this.removeContact(peerId);
        return;
      }

      // Text input submit triggers save (API keys)
      if (aspect === 'submit') {
        await this.saveSettings();
      }
    });
  }

  /**
   * Show the global settings window.
   * Always rebuilds to reflect current contacts/identity state.
   */
  async show(): Promise<boolean> {
    // Always rebuild (contacts/identity may have changed)
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    // Reset button tracking
    this.connectButtons.clear();
    this.removeButtons.clear();
    this.unmasked.clear();

    // Load saved keys to populate inputs
    let savedAnthropicKey: string | null = null;
    let savedOpenaiKey: string | null = null;
    if (this.storageId) {
      savedAnthropicKey = await this.request<string | null>(
        request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: STORAGE_KEY_ANTHROPIC })
      );
      savedOpenaiKey = await this.request<string | null>(
        request(this.id, this.storageId, 'abjects:storage' as InterfaceId, 'get', { key: STORAGE_KEY_OPENAI })
      );
    }

    // Get identity info
    let peerId = '';
    let peerName = '';
    if (this.identityId) {
      try {
        const identity = await this.request<{ peerId: string; name: string }>(
          request(this.id, this.identityId, IDENTITY_INTERFACE, 'exportPublicKeys', {})
        );
        peerId = identity.peerId;
        peerName = identity.name ?? '';
      } catch { /* identity not ready */ }
    }

    // Get contacts
    interface ContactInfo {
      peerId: string; name: string; state: string; addedAt: number;
    }
    let contacts: ContactInfo[] = [];
    if (this.peerRegistryId) {
      try {
        contacts = await this.request<ContactInfo[]>(
          request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'listContacts', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winW = 500;
    const winH = 700;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Global Settings',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root ScrollableVBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    // ========== TAB BAR ==========

    this.tabBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTabBar', {
        windowId: this.windowId, rect: r0,
        tabs: ['API Keys', 'Peer Network'],
        selectedIndex: this.activeTab === 'api-keys' ? 0 : 1,
      })
    );
    await this.request(request(this.id, this.tabBarId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    if (this.activeTab === 'api-keys') {
      await this.buildApiKeysTab(r0, savedAnthropicKey, savedOpenaiKey);
    } else {
      await this.buildPeerNetworkTab(r0, peerId, peerName, contacts);
    }

    // ========== FOOTER ==========

    // Spacer
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    // Status label (shared across all sections)
    this.statusLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId!, rect: r0, text: '',
        style: { color: '#b4b8c8', fontSize: 12, align: 'right' },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    await this.changed('visibility', true);
    return true;
  }

  // ========== TAB CONTENT BUILDERS ==========

  private async buildApiKeysTab(
    r0: { x: number; y: number; width: number; height: number },
    savedAnthropicKey: string | null,
    savedOpenaiKey: string | null,
  ): Promise<void> {
    // Section header: "API Keys"
    const sectionHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'API Keys',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: sectionHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Description
    const descLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Enter your API keys to enable LLM features.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: descLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Anthropic label
    this.anthropicLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Anthropic API Key',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.anthropicLabelId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
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
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: anthropicRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.anthropicKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'sk-ant-...', masked: true,
        text: savedAnthropicKey ?? undefined,
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

    // Divider between Anthropic and OpenAI
    const dividerId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: dividerId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 12 },
    }));

    // OpenAI label
    this.openaiLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'OpenAI API Key',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.openaiLabelId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
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
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: openaiRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.openaiKeyId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'sk-...', masked: true,
        text: savedOpenaiKey ?? undefined,
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

    // Save button row for API keys (HBox: spacer + button)
    const saveRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: saveRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    await this.request(request(this.id, saveRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    this.saveBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save API Keys',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.saveBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, saveRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.saveBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 120, height: 36 },
    }));
  }

  private async buildPeerNetworkTab(
    r0: { x: number; y: number; width: number; height: number },
    peerId: string,
    peerName: string,
    contacts: Array<{ peerId: string; name: string; state: string; addedAt: number }>,
  ): Promise<void> {
    // ========== IDENTITY SECTION ==========

    // Identity header
    const identityHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Your Identity',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: identityHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Display Name label
    const nameLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Display Name',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Name input + Save button row
    const nameRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: nameRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.nameInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Enter display name',
        text: peerName,
      })
    );
    await this.request(request(this.id, this.nameInputId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.nameInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.saveNameBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.saveNameBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.saveNameBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 70, height: 32 },
    }));

    // Peer ID label
    const peerIdHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Peer ID',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: peerIdHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Peer ID value (truncated)
    const truncatedPeerId = peerId ? `${peerId.slice(0, 16)}...${peerId.slice(-8)}` : '(not initialized)';
    const peerIdValueId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: truncatedPeerId,
        style: { color: '#8b8fa3', fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: peerIdValueId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Copy buttons row
    const copyRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: copyRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.copyPeerIdBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Copy Peer ID',
      })
    );
    await this.request(request(this.id, this.copyPeerIdBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.copyPeerIdBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 130, height: 30 },
    }));

    this.copyIdentityBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Copy Identity JSON',
      })
    );
    await this.request(request(this.id, this.copyIdentityBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.copyIdentityBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 160, height: 30 },
    }));

    // ========== SIGNALING SERVERS SECTION ==========

    await this.addDivider();

    // Signaling Server header
    const sigHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Signaling Servers',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: sigHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Signaling URL input + Connect button row
    const sigRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: sigRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.signalingInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'ws://localhost:7720',
      })
    );
    await this.request(request(this.id, this.signalingInputId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.signalingInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.signalingConnectBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Connect',
        style: { background: '#1e3a2e', borderColor: '#4caf50' },
      })
    );
    await this.request(request(this.id, this.signalingConnectBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.signalingConnectBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    // List connected signaling servers
    let signalingUrls: string[] = [];
    if (this.peerRegistryId) {
      try {
        signalingUrls = await this.request<string[]>(
          request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'getSignalingUrls', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    for (const url of signalingUrls) {
      const serverRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: serverRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 28 },
      }));

      // URL label
      const urlLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text: url,
          style: { color: '#4caf50', fontSize: 12 },
        })
      );
      await this.request(request(this.id, serverRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: urlLabelId,
        sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
        preferredSize: { height: 28 },
      }));

      // Disconnect button
      const disconnBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId, rect: r0, text: 'Disconnect',
          style: { fontSize: 11 },
        })
      );
      await this.request(request(this.id, disconnBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
      await this.request(request(this.id, serverRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: disconnBtnId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 80, height: 26 },
      }));
      this.signalingDisconnectButtons.set(disconnBtnId, url);
    }

    // ========== CONTACTS SECTION ==========

    await this.addDivider();

    // Add Contact label
    const addLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Add Contact',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: addLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    const addDescId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: "Paste a peer's identity JSON.",
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: addDescId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Add contact input + button row
    const addRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: addRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.addContactInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: '{"peerId":"...","publicSigningKey":"..."}',
      })
    );
    await this.request(request(this.id, this.addContactInputId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, addRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.addContactInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.addContactBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Add',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.addContactBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, addRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.addContactBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 60, height: 32 },
    }));

    // Contacts section header
    const contactsHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Contacts',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: contactsHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    if (contacts.length === 0) {
      const emptyLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No contacts yet.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      );
      await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const contact of contacts) {
        // HBox row: name + state + connect/disconnect + remove
        const rowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
            parentLayoutId: this.rootLayoutId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        // Name label
        const displayName = contact.name || contact.peerId.slice(0, 12) + '...';
        const nameId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
            windowId: this.windowId, rect: r0, text: displayName,
            style: { color: '#e2e4e9', fontSize: 12 },
          })
        );
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: nameId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        // State label (color-coded)
        const stateColor = contact.state === 'connected' ? '#4caf50'
          : contact.state === 'connecting' ? '#e8a84c'
          : '#6b7084';
        const stateId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
            windowId: this.windowId, rect: r0, text: contact.state,
            style: { color: stateColor, fontSize: 11 },
          })
        );
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: stateId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 30 },
        }));

        // Connect/Disconnect button
        const isConnected = contact.state === 'connected';
        const connBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId, rect: r0,
            text: isConnected ? 'Disconnect' : 'Connect',
            style: isConnected
              ? { fontSize: 11 }
              : { background: '#1e3a2e', borderColor: '#4caf50', fontSize: 11 },
          })
        );
        await this.request(request(this.id, connBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: connBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 80, height: 28 },
        }));
        this.connectButtons.set(connBtnId, contact.peerId);

        // Remove button
        const delBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId, rect: r0, text: 'Remove',
            style: { background: '#3a1f1f', color: '#ff6b6b', borderColor: '#ff6b6b', fontSize: 11 },
          })
        );
        await this.request(request(this.id, delBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: delBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 28 },
        }));
        this.removeButtons.set(delBtnId, contact.peerId);
      }
    }
  }

  /**
   * Hide the global settings window.
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
    this.tabBarId = undefined;
    this.anthropicLabelId = undefined;
    this.anthropicKeyId = undefined;
    this.anthropicToggleId = undefined;
    this.openaiLabelId = undefined;
    this.openaiKeyId = undefined;
    this.openaiToggleId = undefined;
    this.saveBtnId = undefined;
    this.statusLabelId = undefined;
    this.nameInputId = undefined;
    this.saveNameBtnId = undefined;
    this.copyPeerIdBtnId = undefined;
    this.copyIdentityBtnId = undefined;
    this.signalingInputId = undefined;
    this.signalingConnectBtnId = undefined;
    this.addContactInputId = undefined;
    this.addContactBtnId = undefined;
    this.connectButtons.clear();
    this.removeButtons.clear();
    this.signalingDisconnectButtons.clear();
    this.unmasked.clear();
    // Note: activeTab is NOT reset so tab persists across hide/show

    await this.changed('visibility', false);
    return true;
  }

  // ========== HELPERS ==========

  private async addDivider(): Promise<void> {
    const divId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createDivider', {
        windowId: this.windowId, rect: { x: 0, y: 0, width: 0, height: 0 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));
  }

  private async setStatus(text: string, color = '#b4b8c8'): Promise<void> {
    if (!this.statusLabelId) return;
    await this.request(
      request(this.id, this.statusLabelId, WIDGET_INTERFACE, 'update', {
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

  private async setSaveControlsDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    const ids = [this.saveBtnId, this.anthropicKeyId, this.openaiKeyId];
    for (const id of ids) {
      if (id) {
        try { await this.request(request(this.id, id, WIDGET_INTERFACE, 'update', { style })); } catch { /* widget gone */ }
      }
    }
  }

  // ========== API KEYS ACTIONS ==========

  /**
   * Read widget values, save to global storage, and configure LLM.
   */
  private async saveSettings(): Promise<void> {
    if (!this.windowId) return;

    await this.setSaveControlsDisabled(true);

    const anthropicKey = await this.request<string>(
      request(this.id, this.anthropicKeyId!, WIDGET_INTERFACE, 'getValue', {})
    );

    const openaiKey = await this.request<string>(
      request(this.id, this.openaiKeyId!, WIDGET_INTERFACE, 'getValue', {})
    );

    // Save to global storage
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
      console.log(`[GLOBAL-SETTINGS] Saved. LLM providers: ${providers.join(', ') || 'none'}`);
    }

    await this.setStatus('API keys saved!');
    await this.setSaveControlsDisabled(false);
  }

  // ========== IDENTITY ACTIONS ==========

  private async saveName(): Promise<void> {
    if (!this.windowId || !this.nameInputId || !this.identityId) return;

    const name = await this.request<string>(
      request(this.id, this.nameInputId, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!name || name.trim() === '') {
      await this.setStatus('Name cannot be empty.', '#ff6b6b');
      return;
    }

    await this.request(
      request(this.id, this.identityId, IDENTITY_INTERFACE, 'setName', { name: name.trim() })
    );

    await this.setStatus('Name saved!');
  }

  private async copyPeerId(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<{ peerId: string }>(
        request(this.id, this.identityId, IDENTITY_INTERFACE, 'exportPublicKeys', {})
      );

      if (this.clipboardId) {
        await this.request(
          request(this.id, this.clipboardId, CLIPBOARD_INTERFACE, 'write', { text: identity.peerId })
        );
        await this.setStatus('Peer ID copied!');
      } else {
        await this.setStatus('Clipboard not available.', '#ff6b6b');
      }
    } catch {
      await this.setStatus('Failed to copy Peer ID.', '#ff6b6b');
    }
  }

  private async copyIdentityJson(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<{
        peerId: string; publicSigningKey: string; publicExchangeKey: string; name: string;
      }>(
        request(this.id, this.identityId, IDENTITY_INTERFACE, 'exportPublicKeys', {})
      );

      const json = JSON.stringify({
        peerId: identity.peerId,
        publicSigningKey: identity.publicSigningKey,
        publicExchangeKey: identity.publicExchangeKey,
        name: identity.name,
      }, null, 2);

      if (this.clipboardId) {
        await this.request(
          request(this.id, this.clipboardId, CLIPBOARD_INTERFACE, 'write', { text: json })
        );
        await this.setStatus('Identity JSON copied!');
      } else {
        await this.setStatus('Clipboard not available.', '#ff6b6b');
      }
    } catch {
      await this.setStatus('Failed to copy identity.', '#ff6b6b');
    }
  }

  // ========== PEER NETWORK ACTIONS ==========

  private async disconnectSignalingServer(url: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'disconnectSignaling', { url })
      );
      await this.setStatus('Disconnected from signaling server.');
      // Rebuild to update server list
      await this.hide();
      await this.show();
    } catch {
      await this.setStatus('Failed to disconnect.', '#ff6b6b');
    }
  }

  private async connectSignaling(): Promise<void> {
    if (!this.signalingInputId || !this.peerRegistryId) return;

    const url = await this.request<string>(
      request(this.id, this.signalingInputId, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!url || url.trim() === '') {
      await this.setStatus('Enter a signaling server URL.', '#ff6b6b');
      return;
    }

    try {
      const ok = await this.request<boolean>(
        request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'connectSignaling', { url: url.trim() })
      );
      if (ok) {
        await this.setStatus('Connected to signaling server!', '#4caf50');
        // Rebuild to show server in list
        await this.hide();
        await this.show();
      } else {
        await this.setStatus('Failed to connect.', '#ff6b6b');
      }
    } catch {
      await this.setStatus('Connection error.', '#ff6b6b');
    }
  }

  private async addContact(): Promise<void> {
    if (!this.addContactInputId || !this.peerRegistryId) return;

    const jsonStr = await this.request<string>(
      request(this.id, this.addContactInputId, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!jsonStr || jsonStr.trim() === '') {
      await this.setStatus('Paste identity JSON.', '#ff6b6b');
      return;
    }

    try {
      const parsed = JSON.parse(jsonStr.trim()) as {
        peerId: string;
        publicSigningKey: string;
        publicExchangeKey: string;
        name?: string;
      };

      if (!parsed.peerId || !parsed.publicSigningKey || !parsed.publicExchangeKey) {
        await this.setStatus('Invalid identity JSON.', '#ff6b6b');
        return;
      }

      await this.request(
        request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'addContact', {
          peerId: parsed.peerId,
          publicSigningKey: parsed.publicSigningKey,
          publicExchangeKey: parsed.publicExchangeKey,
          name: parsed.name ?? '',
        })
      );

      await this.setStatus('Contact added!');
      // Rebuild to show updated contacts
      await this.hide();
      await this.show();
    } catch {
      await this.setStatus('Invalid JSON format.', '#ff6b6b');
    }
  }

  private async toggleConnection(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      const state = await this.request<string>(
        request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'getContactState', { peerId })
      );

      if (state === 'connected') {
        await this.request(
          request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'disconnectPeer', { peerId })
        );
        await this.setStatus('Disconnected.');
      } else {
        await this.request(
          request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'connectToPeer', { peerId })
        );
        await this.setStatus('Connecting...');
      }

      // Rebuild to show updated state
      await this.hide();
      await this.show();
    } catch {
      await this.setStatus('Connection error.', '#ff6b6b');
    }
  }

  private async removeContact(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, PEER_REGISTRY_INTERFACE, 'removeContact', { peerId })
      );
      await this.setStatus('Contact removed.');
      // Rebuild to show updated contacts
      await this.hide();
      await this.show();
    } catch {
      await this.setStatus('Failed to remove contact.', '#ff6b6b');
    }
  }
}

// Well-known global settings ID
export const GLOBAL_SETTINGS_ID = 'abjects:global-settings' as AbjectId;
