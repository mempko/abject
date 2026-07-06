/**
 * PeerNetwork object — modal window for managing peer identity, signaling
 * servers, and contacts. Extracted from GlobalSettings to be a standalone
 * Abject opened from the GlobalToolbar.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';


const PEER_NETWORK_INTERFACE: InterfaceId = 'abjects:peer-network';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const IDENTITY_INTERFACE: InterfaceId = 'abjects:identity';
const CLIPBOARD_INTERFACE: InterfaceId = 'abjects:clipboard';
const PEER_REGISTRY_INTERFACE: InterfaceId = 'abjects:peer-registry';

export class PeerNetwork extends Abject {
  private widgetManagerId?: AbjectId;
  private identityId?: AbjectId;
  private clipboardId?: AbjectId;
  private peerRegistryId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private tabContents: AbjectId[] = [];

  // Identity section widgets
  private nameInputId?: AbjectId;
  private saveNameBtnId?: AbjectId;
  private copyPeerIdBtnId?: AbjectId;
  private copyIdentityBtnId?: AbjectId;

  // Signaling section widgets
  private signalingInputId?: AbjectId;
  private signalingConnectBtnId?: AbjectId;
  private signalingRemoveButtons: Map<AbjectId, string> = new Map();

  // Contacts section widgets
  private addContactInputId?: AbjectId;
  private addContactBtnId?: AbjectId;
  private contactListId?: AbjectId;
  private connectButtons: Map<AbjectId, string> = new Map();
  private removeButtons: Map<AbjectId, string> = new Map();
  private introduceButtons: Map<AbjectId, string> = new Map();
  private acceptIntroButtons: Map<AbjectId, string> = new Map();
  private rejectIntroButtons: Map<AbjectId, string> = new Map();

  // Network peers section widgets
  private promoteButtons: Map<AbjectId, string> = new Map();
  private blockButtons: Map<AbjectId, string> = new Map();
  private unblockButtons: Map<AbjectId, string> = new Map();

  // Signaling peers section widgets
  private signalingPeerAddButtons: Map<AbjectId, { peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string }> = new Map();

  // Frontends section
  private uiServerId?: AbjectId;
  private remoteUIAccessId?: AbjectId;
  private frontendDisconnectButtons: Map<AbjectId, string> = new Map();
  private frontendRevokeButtons: Map<AbjectId, string> = new Map();
  // Pairing widgets (Frontends tab)
  private remoteEnableCheckboxId?: AbjectId;
  private remoteStatusLabelId?: AbjectId;
  private remoteGenerateBtnId?: AbjectId;
  private remoteQrImageId?: AbjectId;
  private remoteQrUrlLabelId?: AbjectId;
  private lastQrDataUrl?: string;
  private lastQrUrl?: string;
  private refreshing = false;
  private refreshPending = false;
  private frontendsListAreaId?: AbjectId;

  // Discovery dep
  private peerDiscoveryId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'PeerNetwork',
        description:
          'Peer network management UI. Identity, signaling servers, and contacts.',
        version: '1.0.0',
        interface: {
            id: PEER_NETWORK_INTERFACE,
            name: 'PeerNetwork',
            description: 'Peer network management',
            methods: [
              {
                name: 'show',
                description: 'Show the peer network window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the peer network window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display peer network window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'network'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## PeerNetwork Usage Guide

PeerNetwork is the peer network management UI. It provides a modal window
for managing your identity, signaling servers, and contacts.

### Show the peer network window

  await call(await dep('PeerNetwork'), 'show', {});
  / returns true when the window is displayed

### Hide the peer network window

  await call(await dep('PeerNetwork'), 'hide', {});
  / returns true when the window is hidden

### What it manages
- Identity: view/edit your peer name, copy your peer ID or full identity JSON
- Signaling servers: add, connect, disconnect, and remove signaling server URLs
- Contacts: add contacts by peer ID, connect/disconnect, introduce contacts to each other
- Network peers: view connected peers discovered through signaling, promote to contacts
- Discovered peers: view peers found via gossip-based discovery

### Notes
- This is a UI object; it renders its own window via WidgetManager.
- Closing the window hides it (does not destroy it).

Interface: abjects:peer-network`;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.identityId = await this.discoverDep('Identity') ?? undefined;
    this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    this.peerDiscoveryId = await this.discoverDep('PeerDiscovery') ?? undefined;
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    this.remoteUIAccessId = await this.discoverDep('RemoteUIAccess') ?? undefined;

    // Subscribe to PeerRegistry events so the window auto-refreshes
    if (this.peerRegistryId) {
      await this.request(request(this.id, this.peerRegistryId, 'addDependent', {}));
    }
    if (this.uiServerId) {
      try { await this.request(request(this.id, this.uiServerId, 'addDependent', {})); } catch { /* best effort */ }
    }
    if (this.remoteUIAccessId) {
      try { await this.request(request(this.id, this.remoteUIAccessId, 'addDependent', {})); } catch { /* best effort */ }
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

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // Tab bar change — show/hide tab content
      if (fromId === this.tabBarId && aspect === 'change') {
        const idx = parseInt(value as string);
        for (let i = 0; i < this.tabContents.length; i++) {
          await this.request(request(this.id, this.tabContents[i], 'update', {
            style: { visible: i === idx },
          }));
        }
        return;
      }

      // Signaling server remove buttons
      if (aspect === 'click' && this.signalingRemoveButtons.has(fromId)) {
        const url = this.signalingRemoveButtons.get(fromId)!;
        await this.removeSignalingServer(url);
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

      // Signaling section
      if (fromId === this.signalingConnectBtnId && aspect === 'click') {
        await this.connectSignaling();
        return;
      }

      // Contacts section
      if (fromId === this.addContactBtnId && aspect === 'click') {
        await this.addContact();
        return;
      }

      // Inline contact actions on the rich contacts list
      if (fromId === this.contactListId && aspect === 'action') {
        try {
          const data = JSON.parse(value as string) as { value: string; actionId: string };
          const peerId = data.value;
          if (data.actionId === 'connect') await this.toggleConnection(peerId);
          else if (data.actionId === 'introduce') await this.introduceContact(peerId);
          else if (data.actionId === 'remove') await this.removeContact(peerId);
          else if (data.actionId === 'block') await this.blockPeer(peerId);
        } catch { /* malformed payload */ }
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

      if (aspect === 'click' && this.introduceButtons.has(fromId)) {
        const contactId = this.introduceButtons.get(fromId)!;
        await this.introduceContact(contactId);
        return;
      }

      if (aspect === 'click' && this.acceptIntroButtons.has(fromId)) {
        const peerId = this.acceptIntroButtons.get(fromId)!;
        await this.acceptIntroduction(peerId);
        return;
      }

      if (aspect === 'click' && this.rejectIntroButtons.has(fromId)) {
        const peerId = this.rejectIntroButtons.get(fromId)!;
        await this.rejectIntroduction(peerId);
        return;
      }

      if (aspect === 'click' && this.promoteButtons.has(fromId)) {
        const peerId = this.promoteButtons.get(fromId)!;
        await this.promoteNetworkPeer(peerId);
        return;
      }

      if (aspect === 'click' && this.blockButtons.has(fromId)) {
        const peerId = this.blockButtons.get(fromId)!;
        await this.blockPeer(peerId);
        return;
      }

      if (aspect === 'click' && this.unblockButtons.has(fromId)) {
        const peerId = this.unblockButtons.get(fromId)!;
        await this.unblockPeer(peerId);
        return;
      }

      if (aspect === 'click' && this.signalingPeerAddButtons.has(fromId)) {
        const peer = this.signalingPeerAddButtons.get(fromId)!;
        if (this.peerRegistryId) {
          await this.request(request(this.id, this.peerRegistryId, 'addContact', peer));
        }
        return;
      }

      // Frontends tab — toggle remote UI access
      if (fromId === this.remoteEnableCheckboxId && aspect === 'change') {
        if (this.remoteUIAccessId) {
          try {
            await this.request(request(this.id, this.remoteUIAccessId, 'setEnabled', { enabled: !!value }));
          } catch { /* best effort */ }
        }
        return;
      }

      // Frontends tab — Generate Pairing QR
      if (fromId === this.remoteGenerateBtnId && aspect === 'click') {
        if (this.remoteUIAccessId) {
          try {
            const result = await this.request<{ qrUrl: string; qrDataUrl: string }>(
              request(this.id, this.remoteUIAccessId, 'generatePairingToken', {})
            );
            this.lastQrDataUrl = result.qrDataUrl;
            this.lastQrUrl = result.qrUrl;
            if (this.remoteQrImageId) {
              await this.request(request(this.id, this.remoteQrImageId, 'update', { url: result.qrDataUrl, alt: '' }));
            }
            if (this.remoteQrUrlLabelId) {
              await this.request(request(this.id, this.remoteQrUrlLabelId, 'update', { text: result.qrUrl }));
            }
          } catch { /* best effort */ }
        }
        return;
      }

      // Frontends tab — disconnect a connected UI client
      if (aspect === 'click' && this.frontendDisconnectButtons.has(fromId)) {
        const clientId = this.frontendDisconnectButtons.get(fromId)!;
        if (this.uiServerId) {
          try {
            await this.request(request(this.id, this.uiServerId, 'disconnectFrontendClient', { clientId }));
          } catch { /* best effort */ }
        }
        return;
      }

      // Frontends tab — revoke a paired remote UI client (WebRTC only)
      if (aspect === 'click' && this.frontendRevokeButtons.has(fromId)) {
        const peerId = this.frontendRevokeButtons.get(fromId)!;
        if (this.remoteUIAccessId) {
          try {
            await this.request(request(this.id, this.remoteUIAccessId, 'revokeClient', { peerId }));
          } catch { /* best effort */ }
        }
        return;
      }

      // PeerRegistry events — auto-refresh
      if (fromId === this.peerRegistryId && (
        aspect === 'contactConnected' || aspect === 'contactDisconnected' ||
        aspect === 'contactIntroduced' || aspect === 'signalingStateChanged' ||
        aspect === 'introductionReceived' ||
        aspect === 'networkPeerConnected' || aspect === 'networkPeerDisconnected' ||
        aspect === 'signalingPeersUpdated' ||
        aspect === 'peerBlocked' || aspect === 'peerUnblocked'
      )) {
        await this.refresh();
        return;
      }

      // UIServer / RemoteUIAccess events — auto-refresh
      if ((fromId === this.uiServerId && aspect === 'frontendClientsChanged') ||
          (fromId === this.remoteUIAccessId && aspect === 'clientsChanged')) {
        await this.refresh();
        return;
      }
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winW = 500;
    const winH = 700;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83C\uDF10 Peer Network',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    // Create root VBox layout (non-scrollable — tabs handle their own scrolling)
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 0,
      })
    );

    // Tab bar
    const { widgetIds: [_tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'tabBar', windowId: this.windowId, tabs: ['Identity', 'Contacts', 'Servers & Peers', 'Introductions', 'Frontends'], selectedIndex: 0 },
      ] })
    );
    this.tabBarId = _tabBarId;
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Create 5 tab content ScrollableVBoxes
    this.tabContents = [];
    for (let i = 0; i < 5; i++) {
      const tabVBox = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createScrollableVBox', {
          windowId: this.windowId,
          margins: { top: 20, right: 20, bottom: 20, left: 20 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
        widgetId: tabVBox,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
      if (i > 0) {
        await this.request(request(this.id, tabVBox, 'update', {
          style: { visible: false },
        }));
      }
      this.tabContents.push(tabVBox);
    }

    await this.populateTabs();

    this.changed('visibility', true);
    return true;
  }

  /** Populate tab content. Called from show() and refresh(). */
  private async populateTabs(): Promise<void> {
    // Clear widget refs and button maps (old widgets destroyed by clearLayoutChildren)
    this.nameInputId = undefined;
    this.saveNameBtnId = undefined;
    this.copyPeerIdBtnId = undefined;
    this.copyIdentityBtnId = undefined;
    this.statusLabelId = undefined;
    this.addContactInputId = undefined;
    this.addContactBtnId = undefined;
    this.contactListId = undefined;
    this.signalingInputId = undefined;
    this.signalingConnectBtnId = undefined;
    this.connectButtons.clear();
    this.removeButtons.clear();
    this.introduceButtons.clear();
    this.acceptIntroButtons.clear();
    this.rejectIntroButtons.clear();
    this.signalingRemoveButtons.clear();
    this.promoteButtons.clear();
    this.blockButtons.clear();
    this.unblockButtons.clear();
    this.signalingPeerAddButtons.clear();
    // NOTE: frontendDisconnectButtons / frontendRevokeButtons and the pairing
    // widget refs (remoteEnableCheckboxId, remoteQrImageId, frontendsListAreaId,
    // etc.) are NOT reset here. The Frontends tab is refreshed in place —
    // refresh() skips clearing it, populateFrontendsTab() clears just its
    // list area before rebuilding rows. Their refs are reset only in hide().

    // Fetch identity info
    let peerId = '';
    let peerName = '';
    if (this.identityId) {
      try {
        const identity = await this.request<{ peerId: string; name: string }>(
          request(this.id, this.identityId, 'exportPublicKeys', {})
        );
        peerId = identity.peerId;
        peerName = identity.name ?? '';
      } catch { /* identity not ready */ }
    }

    // Fetch contacts
    interface ContactInfo {
      peerId: string; name: string; state: string; addedAt: number;
    }
    let contacts: ContactInfo[] = [];
    if (this.peerRegistryId) {
      try {
        contacts = await this.request<ContactInfo[]>(
          request(this.id, this.peerRegistryId, 'listContacts', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    // ========== TAB 0: IDENTITY ==========
    const tab0 = this.tabContents[0];

    // Display Name label
    const { widgetIds: [nameLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Display Name', style: { color: this.theme.textHeading, fontSize: 13 } },
      ] })
    );
    await this.request(request(this.id, tab0, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Name input + Save button row
    const nameRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: tab0,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, tab0, 'addLayoutChild', {
      widgetId: nameRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Batch: name input + save button
    const { widgetIds: [_nameInputId, _saveNameBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Enter display name', text: peerName },
        { type: 'button', windowId: this.windowId, text: 'Save', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.nameInputId = _nameInputId;
    this.saveNameBtnId = _saveNameBtnId;
    await this.request(request(this.id, this.nameInputId, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, 'addLayoutChild', {
      widgetId: this.nameInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.saveNameBtnId, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, 'addLayoutChild', {
      widgetId: this.saveNameBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 70, height: 32 },
    }));

    // Batch: Peer ID header + Peer ID value (2 adjacent labels in tab0)
    const truncatedPeerId = peerId ? `${peerId.slice(0, 16)}...${peerId.slice(-8)}` : '(not initialized)';
    const { widgetIds: [peerIdHeaderId, peerIdValueId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Peer ID', style: { color: this.theme.textHeading, fontSize: 13 } },
        { type: 'label', windowId: this.windowId, text: truncatedPeerId, style: { color: this.theme.textMeta, fontSize: 12, selectable: true } },
      ] })
    );
    await this.request(request(this.id, tab0, 'addLayoutChild', {
      widgetId: peerIdHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, tab0, 'addLayoutChild', {
      widgetId: peerIdValueId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Copy buttons row
    const copyRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: tab0,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, tab0, 'addLayoutChild', {
      widgetId: copyRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    // Batch: copy peer ID + copy identity buttons
    const { widgetIds: [_copyPeerIdBtnId, _copyIdentityBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Copy Peer ID' },
        { type: 'button', windowId: this.windowId, text: 'Copy Identity JSON' },
      ] })
    );
    this.copyPeerIdBtnId = _copyPeerIdBtnId;
    this.copyIdentityBtnId = _copyIdentityBtnId;
    await this.request(request(this.id, this.copyPeerIdBtnId, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, 'addLayoutChild', {
      widgetId: this.copyPeerIdBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 130, height: 30 },
    }));
    await this.request(request(this.id, this.copyIdentityBtnId, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, 'addLayoutChild', {
      widgetId: this.copyIdentityBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 160, height: 30 },
    }));

    // Spacer + status label at bottom of Identity tab
    await this.request(request(this.id, tab0, 'addLayoutSpacer', {}));

    const { widgetIds: [_statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId!, text: '', style: { color: this.theme.textDescription, fontSize: 12, align: 'right', selectable: true } },
      ] })
    );
    this.statusLabelId = _statusLabelId;
    await this.request(request(this.id, tab0, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // ========== TAB 1: CONTACTS ==========
    const tab1 = this.tabContents[1];

    // Batch: Add Contact label + description label
    const { widgetIds: [addLabelId, addDescId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Add Contact', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
        { type: 'label', windowId: this.windowId, text: "Paste a peer's identity JSON.", style: { color: this.theme.textDescription, fontSize: 12 } },
      ] })
    );
    await this.request(request(this.id, tab1, 'addLayoutChild', {
      widgetId: addLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    await this.request(request(this.id, tab1, 'addLayoutChild', {
      widgetId: addDescId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Add contact input + button row
    const addRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: tab1,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, tab1, 'addLayoutChild', {
      widgetId: addRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Batch: add contact input + add button
    const { widgetIds: [_addContactInputId, _addContactBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Paste identity JSON' },
        { type: 'button', windowId: this.windowId, text: 'Add', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.addContactInputId = _addContactInputId;
    this.addContactBtnId = _addContactBtnId;
    await this.request(request(this.id, this.addContactInputId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: this.addContactInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.addContactBtnId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: this.addContactBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 60, height: 32 },
    }));

    // Contacts list header
    const { widgetIds: [contactsHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Contacts', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
      ] })
    );
    await this.request(request(this.id, tab1, 'addLayoutChild', {
      widgetId: contactsHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    if (contacts.length === 0) {
      const { widgetIds: [emptyLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'No contacts yet.', style: { color: this.theme.textDescription, fontSize: 12 } },
        ] })
      );
      await this.request(request(this.id, tab1, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      // Contacts as a single rich list: state badge + inline actions per row.
      const items = contacts.map((contact) => {
        const isConnected = contact.state === 'connected';
        const stateColor = contact.state === 'connected' ? this.theme.statusSuccess
          : contact.state === 'connecting' ? this.theme.statusWarning
          : this.theme.statusNeutral;
        const actions: Array<{ id: string; label: string; color?: string; textColor?: string }> = [
          { id: 'connect', label: isConnected ? 'Disconnect' : 'Connect', color: isConnected ? undefined : '#1e3a2e' },
        ];
        if (isConnected) {
          actions.push({ id: 'introduce', label: 'Introduce', color: '#1e2a3a' });
        }
        actions.push(
          { id: 'remove', label: 'Remove', color: this.theme.destructiveBg, textColor: this.theme.destructiveText },
          { id: 'block', label: 'Block', color: this.theme.destructiveBg, textColor: this.theme.destructiveText },
        );
        return {
          label: contact.name || contact.peerId.slice(0, 12) + '...',
          value: contact.peerId,
          detail: contact.peerId.slice(0, 24),
          badge: { text: contact.state, color: stateColor },
          actions,
        };
      });

      const { widgetIds: [contactListId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'list', windowId: this.windowId, items },
        ] })
      );
      this.contactListId = contactListId;
      await this.request(request(this.id, this.contactListId, 'addDependent', {}));
      await this.request(request(this.id, tab1, 'addLayoutChild', {
        widgetId: this.contactListId,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
    }

    // ========== TAB 2: SERVERS & PEERS ==========
    const tab2 = this.tabContents[2];

    // Signaling Server header
    const { widgetIds: [sigHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Signaling Servers', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
      ] })
    );
    await this.request(request(this.id, tab2, 'addLayoutChild', {
      widgetId: sigHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Signaling URL input + Connect button row
    const sigRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: tab2,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, tab2, 'addLayoutChild', {
      widgetId: sigRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Batch: signaling input + connect button
    const { widgetIds: [_signalingInputId, _signalingConnectBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'wss://signal.abject.world' },
        { type: 'button', windowId: this.windowId, text: 'Connect', style: { background: '#1e3a2e', borderColor: this.theme.statusSuccess } },
      ] })
    );
    this.signalingInputId = _signalingInputId;
    this.signalingConnectBtnId = _signalingConnectBtnId;
    await this.request(request(this.id, this.signalingInputId, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, 'addLayoutChild', {
      widgetId: this.signalingInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.signalingConnectBtnId, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, 'addLayoutChild', {
      widgetId: this.signalingConnectBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    // List configured signaling servers with status
    let signalingServers: Array<{ url: string; status: string }> = [];
    if (this.peerRegistryId) {
      try {
        signalingServers = await this.request<Array<{ url: string; status: string }>>(
          request(this.id, this.peerRegistryId, 'listSignalingServers', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    for (const { url, status } of signalingServers) {
      const serverRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: tab2,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, tab2, 'addLayoutChild', {
        widgetId: serverRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 28 },
      }));

      const urlColor = status === 'connected' ? this.theme.actionBg
        : status === 'connecting' ? this.theme.statusWarning
        : this.theme.statusErrorBright;
      const statusText = status === 'connected' ? 'connected'
        : status === 'connecting' ? 'connecting...'
        : 'offline';

      // Batch: url label + status label + remove button
      const { widgetIds: [urlLabelId, statusLabelId, removeBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: url, style: { color: urlColor, fontSize: 12, selectable: true } },
          { type: 'label', windowId: this.windowId, text: statusText, style: { color: urlColor, fontSize: 11, selectable: true } },
          { type: 'button', windowId: this.windowId, text: 'Remove', style: { fontSize: 11 } },
        ] })
      );
      await this.request(request(this.id, serverRowId, 'addLayoutChild', {
        widgetId: urlLabelId,
        sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
        preferredSize: { height: 28 },
      }));
      await this.request(request(this.id, serverRowId, 'addLayoutChild', {
        widgetId: statusLabelId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 80, height: 28 },
      }));
      await this.request(request(this.id, removeBtnId, 'addDependent', {}));
      await this.request(request(this.id, serverRowId, 'addLayoutChild', {
        widgetId: removeBtnId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 70, height: 26 },
      }));
      this.signalingRemoveButtons.set(removeBtnId, url);
    }

    // Signaling Peers subsection
    interface SignalingPeerInfo {
      peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string; serverUrl: string;
    }
    let signalingPeers: SignalingPeerInfo[] = [];
    if (this.peerRegistryId) {
      try {
        signalingPeers = await this.request<SignalingPeerInfo[]>(
          request(this.id, this.peerRegistryId, 'listSignalingPeers', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    if (signalingPeers.length > 0) {
      await this.addDivider(tab2);

      const { widgetIds: [spHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'Signaling Peers', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
        ] })
      );
      await this.request(request(this.id, tab2, 'addLayoutChild', {
        widgetId: spHeaderId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 },
      }));

      this.signalingPeerAddButtons.clear();

      for (const sp of signalingPeers) {
        const spRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: tab2,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, tab2, 'addLayoutChild', {
          widgetId: spRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        const displayName = sp.name || sp.peerId.slice(0, 12) + '...';

        // Batch: name label + add button
        const { widgetIds: [spNameId, addBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: displayName, style: { color: this.theme.textDescription, fontSize: 12, selectable: true } },
            { type: 'button', windowId: this.windowId, text: 'Add', style: { background: '#1e3a2e', borderColor: this.theme.statusSuccess, fontSize: 11 } },
          ] })
        );
        await this.request(request(this.id, spRowId, 'addLayoutChild', {
          widgetId: spNameId,
          sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
          preferredSize: { height: 28 },
        }));
        await this.request(request(this.id, addBtnId, 'addDependent', {}));
        await this.request(request(this.id, spRowId, 'addLayoutChild', {
          widgetId: addBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 60, height: 26 },
        }));
        this.signalingPeerAddButtons.set(addBtnId, {
          peerId: sp.peerId,
          name: sp.name,
          publicSigningKey: sp.publicSigningKey,
          publicExchangeKey: sp.publicExchangeKey,
        });
      }
    }

    // Network Peers subsection
    interface NetworkPeerInfo {
      peerId: string; name: string; connectedAt: number;
    }
    let networkPeers: NetworkPeerInfo[] = [];
    if (this.peerRegistryId) {
      try {
        networkPeers = await this.request<NetworkPeerInfo[]>(
          request(this.id, this.peerRegistryId, 'listNetworkPeers', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    let discoveryStats = { cacheSize: 0, connectedNetworkPeers: 0 };
    if (this.peerDiscoveryId) {
      try {
        discoveryStats = await this.request<{ cacheSize: number; connectedNetworkPeers: number }>(
          request(this.id, this.peerDiscoveryId, 'getDiscoveryStats', {})
        );
      } catch { /* PeerDiscovery not ready */ }
    }

    const connectedContacts = contacts.filter(c => c.state === 'connected');

    if (connectedContacts.length > 0 || networkPeers.length > 0 || discoveryStats.cacheSize > 0) {
      await this.addDivider(tab2);

      const hasSignaling = await this.hasSignalingServer();
      const meshStatus = `Mesh: ${contacts.filter(c => c.state === 'connected').length + networkPeers.length} direct, ${discoveryStats.cacheSize} discoverable${!hasSignaling && networkPeers.length > 0 ? ' | Relay active' : ''}`;

      // Batch: network header + mesh status (2 adjacent labels)
      const { widgetIds: [netHeaderId, meshStatusId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'Network Peers', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
          { type: 'label', windowId: this.windowId, text: meshStatus, style: { color: this.theme.textMeta, fontSize: 11 } },
        ] })
      );
      await this.request(request(this.id, tab2, 'addLayoutChild', {
        widgetId: netHeaderId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 },
      }));
      await this.request(request(this.id, tab2, 'addLayoutChild', {
        widgetId: meshStatusId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));

      // Connected contacts (trusted peers) — shown without Trust button
      for (const contact of connectedContacts) {
        const cRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: tab2,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, tab2, 'addLayoutChild', {
          widgetId: cRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        // Batch: name label + tag label + block button
        const { widgetIds: [cNameId, cTagId, cBlockBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: contact.name || contact.peerId.slice(0, 12) + '...', style: { color: this.theme.textDescription, fontSize: 12, selectable: true } },
            { type: 'label', windowId: this.windowId, text: 'contact', style: { color: this.theme.statusSuccess, fontSize: 11, selectable: true } },
            { type: 'button', windowId: this.windowId, text: 'Block', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } },
          ] })
        );
        await this.request(request(this.id, cRowId, 'addLayoutChild', {
          widgetId: cNameId,
          sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
          preferredSize: { height: 30 },
        }));
        await this.request(request(this.id, cRowId, 'addLayoutChild', {
          widgetId: cTagId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 50, height: 30 },
        }));
        await this.request(request(this.id, cBlockBtnId, 'addDependent', {}));
        await this.request(request(this.id, cRowId, 'addLayoutChild', {
          widgetId: cBlockBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 60, height: 28 },
        }));
        this.blockButtons.set(cBlockBtnId, contact.peerId);
      }

      for (const netPeer of networkPeers) {
        const npRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: tab2,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, tab2, 'addLayoutChild', {
          widgetId: npRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        const duration = this.formatDuration(Date.now() - netPeer.connectedAt);

        // Batch: name label + duration label + trust button + block button
        const { widgetIds: [npNameId, durationId, promoteBtnId, npBlockBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: netPeer.name || netPeer.peerId.slice(0, 12) + '...', style: { color: this.theme.textDescription, fontSize: 12, selectable: true } },
            { type: 'label', windowId: this.windowId, text: duration, style: { color: this.theme.statusNeutral, fontSize: 11, selectable: true } },
            { type: 'button', windowId: this.windowId, text: 'Trust', style: { background: '#1e3a2e', borderColor: this.theme.statusSuccess, fontSize: 11 } },
            { type: 'button', windowId: this.windowId, text: 'Block', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } },
          ] })
        );
        await this.request(request(this.id, npRowId, 'addLayoutChild', {
          widgetId: npNameId,
          sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
          preferredSize: { height: 30 },
        }));
        await this.request(request(this.id, npRowId, 'addLayoutChild', {
          widgetId: durationId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 50, height: 30 },
        }));
        await this.request(request(this.id, promoteBtnId, 'addDependent', {}));
        await this.request(request(this.id, npRowId, 'addLayoutChild', {
          widgetId: promoteBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 60, height: 28 },
        }));
        this.promoteButtons.set(promoteBtnId, netPeer.peerId);
        await this.request(request(this.id, npBlockBtnId, 'addDependent', {}));
        await this.request(request(this.id, npRowId, 'addLayoutChild', {
          widgetId: npBlockBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 60, height: 28 },
        }));
        this.blockButtons.set(npBlockBtnId, netPeer.peerId);
      }
    }

    // Blocked Peers subsection
    let blockedPeers: string[] = [];
    if (this.peerRegistryId) {
      try {
        blockedPeers = await this.request<string[]>(
          request(this.id, this.peerRegistryId, 'listBlockedPeers', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    if (blockedPeers.length > 0) {
      await this.addDivider(tab2);

      const { widgetIds: [blockedHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'Blocked Peers', style: { color: this.theme.statusErrorBright, fontWeight: 'bold', fontSize: 13 } },
        ] })
      );
      await this.request(request(this.id, tab2, 'addLayoutChild', {
        widgetId: blockedHeaderId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 },
      }));

      for (const bPeerId of blockedPeers) {
        const bRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: tab2,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, tab2, 'addLayoutChild', {
          widgetId: bRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 28 },
        }));

        // Batch: name label + unblock button
        const { widgetIds: [bNameId, unblockBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: bPeerId.slice(0, 16) + '...', style: { color: this.theme.statusNeutral, fontSize: 12, selectable: true } },
            { type: 'button', windowId: this.windowId, text: 'Unblock', style: { background: '#1e3a2e', borderColor: this.theme.statusSuccess, fontSize: 11 } },
          ] })
        );
        await this.request(request(this.id, bRowId, 'addLayoutChild', {
          widgetId: bNameId,
          sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
          preferredSize: { height: 28 },
        }));
        await this.request(request(this.id, unblockBtnId, 'addDependent', {}));
        await this.request(request(this.id, bRowId, 'addLayoutChild', {
          widgetId: unblockBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 26 },
        }));
        this.unblockButtons.set(unblockBtnId, bPeerId);
      }
    }

    // ========== TAB 3: INTRODUCTIONS ==========
    const tab3 = this.tabContents[3];

    interface PendingIntro {
      peerId: string; name: string; fromPeerId: string; receivedAt: number;
    }
    let pendingIntros: PendingIntro[] = [];
    if (this.peerRegistryId) {
      try {
        pendingIntros = await this.request<PendingIntro[]>(
          request(this.id, this.peerRegistryId, 'listPendingIntroductions', {})
        );
      } catch { /* PeerRegistry not ready */ }
    }

    // Introductions header
    const { widgetIds: [introHeaderId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Pending Introductions', style: { color: this.theme.statusInfo, fontWeight: 'bold', fontSize: 13 } },
      ] })
    );
    await this.request(request(this.id, tab3, 'addLayoutChild', {
      widgetId: introHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    if (pendingIntros.length === 0) {
      const { widgetIds: [emptyIntroId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'No pending introductions.', style: { color: this.theme.textDescription, fontSize: 12 } },
        ] })
      );
      await this.request(request(this.id, tab3, 'addLayoutChild', {
        widgetId: emptyIntroId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const intro of pendingIntros) {
        const introRowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: tab3,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, tab3, 'addLayoutChild', {
          widgetId: introRowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        const introName = intro.name || intro.peerId.slice(0, 12) + '...';
        const fromContact = contacts.find(c => c.peerId === intro.fromPeerId);
        const fromName = fromContact?.name || intro.fromPeerId.slice(0, 12) + '...';

        // Batch: intro label + accept button + reject button
        const { widgetIds: [introLabel, acceptBtnId, rejectBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: [
            { type: 'label', windowId: this.windowId, text: `${introName} (from ${fromName})`, style: { color: this.theme.textHeading, fontSize: 12, selectable: true } },
            { type: 'button', windowId: this.windowId, text: 'Accept', style: { background: '#1e3a2e', borderColor: this.theme.statusSuccess, fontSize: 11 } },
            { type: 'button', windowId: this.windowId, text: 'Reject', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } },
          ] })
        );
        await this.request(request(this.id, introRowId, 'addLayoutChild', {
          widgetId: introLabel,
          sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
          preferredSize: { height: 30 },
        }));
        await this.request(request(this.id, acceptBtnId, 'addDependent', {}));
        await this.request(request(this.id, introRowId, 'addLayoutChild', {
          widgetId: acceptBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 65, height: 28 },
        }));
        this.acceptIntroButtons.set(acceptBtnId, intro.peerId);
        await this.request(request(this.id, rejectBtnId, 'addDependent', {}));
        await this.request(request(this.id, introRowId, 'addLayoutChild', {
          widgetId: rejectBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 65, height: 28 },
        }));
        this.rejectIntroButtons.set(rejectBtnId, intro.peerId);
      }
    }

    // ========== TAB 4: FRONTENDS ==========
    await this.populateFrontendsTab(this.tabContents[4]);
  }

  /** Populate the Frontends tab — currently connected UI clients (WS + WebRTC). */
  private async populateFrontendsTab(tab4: AbjectId): Promise<void> {
    // Lazy-discover in case the deps weren't ready in onInit.
    if (!this.uiServerId) {
      this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
      if (this.uiServerId) {
        try { await this.request(request(this.id, this.uiServerId, 'addDependent', {})); } catch { /* best effort */ }
      }
    }
    if (!this.remoteUIAccessId) {
      this.remoteUIAccessId = await this.discoverDep('RemoteUIAccess') ?? undefined;
      if (this.remoteUIAccessId) {
        try { await this.request(request(this.id, this.remoteUIAccessId, 'addDependent', {})); } catch { /* best effort */ }
      }
    }

    // ── Pair a new frontend (QR generation) ── built once; persists across refreshes
    if (!this.remoteEnableCheckboxId) {
      await this.buildPairingSection(tab4);
    } else {
      await this.refreshRemoteStatusLabel();
    }

    // ── Connected-frontends area: a nested layout we can clear/rebuild
    //    without touching the pairing widgets above. ──
    if (!this.frontendsListAreaId) {
      this.frontendsListAreaId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createVBox', {
          windowId: this.windowId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, tab4, 'addLayoutChild', {
        widgetId: this.frontendsListAreaId,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
    } else {
      await this.request(request(this.id, this.frontendsListAreaId, 'clearLayoutChildren', {}));
      this.frontendDisconnectButtons.clear();
      this.frontendRevokeButtons.clear();
    }
    const listArea = this.frontendsListAreaId;

    // ── Connected frontends header ──
    const { widgetIds: [headerId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Connected Frontends', style: { color: this.theme.statusInfo, fontWeight: 'bold', fontSize: 13 } },
      ] })
    );
    await this.request(request(this.id, listArea, 'addLayoutChild', {
      widgetId: headerId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    interface FrontendClient {
      clientId: string;
      kind: 'websocket' | 'webrtc' | string;
      peerId: string;
      name: string;
      connectedAt: number;
      ready: boolean;
    }

    let clients: FrontendClient[] = [];
    if (this.uiServerId) {
      try {
        clients = await this.request<FrontendClient[]>(
          request(this.id, this.uiServerId, 'listFrontendClients', {})
        );
      } catch { /* UIServer not reachable */ }
    }

    if (clients.length === 0) {
      const { widgetIds: [emptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: 'No frontends connected.', style: { color: this.theme.textDescription, fontSize: 12 } },
        ] })
      );
      await this.request(request(this.id, listArea, 'addLayoutChild', {
        widgetId: emptyId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
      return;
    }

    for (const c of clients) {
      const rowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedHBox', {
          parentLayoutId: listArea,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, listArea, 'addLayoutChild', {
        widgetId: rowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      const isWebRTC = c.kind === 'webrtc';
      const kindLabel = isWebRTC ? 'P2P' : 'WS';
      const displayName = c.name?.trim()
        || (c.peerId ? c.peerId.slice(0, 12) + '…' : '')
        || c.clientId;
      const relAgo = formatRelative(Date.now() - c.connectedAt);
      const text = `[${kindLabel}] ${displayName} • ${relAgo}`;

      const specs: Array<Record<string, unknown>> = [
        { type: 'label', windowId: this.windowId, text, style: { color: this.theme.textHeading, fontSize: 12, selectable: true } },
        { type: 'button', windowId: this.windowId, text: 'Disconnect', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } },
      ];
      if (isWebRTC) {
        specs.push({ type: 'button', windowId: this.windowId, text: 'Revoke', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } });
      }

      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs })
      );
      const [labelId, disconnectBtnId, revokeBtnId] = widgetIds;

      await this.request(request(this.id, rowId, 'addLayoutChild', {
        widgetId: labelId,
        sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
        preferredSize: { height: 30 },
      }));

      await this.request(request(this.id, disconnectBtnId, 'addDependent', {}));
      await this.request(request(this.id, rowId, 'addLayoutChild', {
        widgetId: disconnectBtnId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 90, height: 28 },
      }));
      this.frontendDisconnectButtons.set(disconnectBtnId, c.clientId);

      if (isWebRTC && revokeBtnId) {
        await this.request(request(this.id, revokeBtnId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: revokeBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 28 },
        }));
        this.frontendRevokeButtons.set(revokeBtnId, c.peerId);
      }
    }
  }

  /**
   * Pair-a-new-frontend section: enable toggle, status, Generate QR button,
   * QR image, and selectable pairing URL. Mirrors the UX that previously
   * lived in GlobalSettings → Auth → Remote Access.
   */
  private async buildPairingSection(tab4: AbjectId): Promise<void> {
    // Section header
    const { widgetIds: [headerId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: 'Pair a Frontend',
          style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 15 } },
      ] })
    );
    await this.request(request(this.id, tab4, 'addLayoutChild', {
      widgetId: headerId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    let status = { enabled: false, peerId: '', signalingUrl: '', deviceLabel: '', connectedCount: 0, authorizedCount: 0 };
    if (this.remoteUIAccessId) {
      try {
        status = await this.request<typeof status>(
          request(this.id, this.remoteUIAccessId, 'getStatus', {})
        );
      } catch { /* not ready */ }
    }

    // Enable checkbox
    const enableRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: tab4,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, tab4, 'addLayoutChild', {
      widgetId: enableRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    const { widgetIds: [enableCheckboxId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId,
          checked: status.enabled,
          text: 'Enable remote UI (phone access via WebRTC)' },
      ] })
    );
    this.remoteEnableCheckboxId = enableCheckboxId;
    await this.request(request(this.id, this.remoteEnableCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, enableRowId, 'addLayoutChild', {
      widgetId: this.remoteEnableCheckboxId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Status label
    const { widgetIds: [statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId,
          text: formatRemoteStatus(status),
          style: { color: this.theme.textDescription, fontSize: 12 } },
      ] })
    );
    this.remoteStatusLabelId = statusLabelId;
    await this.request(request(this.id, tab4, 'addLayoutChild', {
      widgetId: this.remoteStatusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Generate QR button
    const generateRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: tab4,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, tab4, 'addLayoutChild', {
      widgetId: generateRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    const { widgetIds: [generateBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Generate Pairing QR',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.remoteGenerateBtnId = generateBtnId;
    await this.request(request(this.id, this.remoteGenerateBtnId, 'addDependent', {}));
    await this.request(request(this.id, generateRowId, 'addLayoutChild', {
      widgetId: this.remoteGenerateBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 200, height: 36 },
    }));
    await this.request(request(this.id, generateRowId, 'addLayoutSpacer', {}));

    // QR image
    const qrImageSpec: Record<string, unknown> = {
      type: 'image', windowId: this.windowId,
      alt: this.lastQrDataUrl ? '' : 'No QR generated yet',
      style: { background: this.theme.windowBg, color: this.theme.textTertiary, fontSize: 12, radius: 4 },
    };
    if (this.lastQrDataUrl) qrImageSpec.url = this.lastQrDataUrl;
    const { widgetIds: [qrImageId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [qrImageSpec] })
    );
    this.remoteQrImageId = qrImageId;
    await this.request(request(this.id, tab4, 'addLayoutChild', {
      widgetId: this.remoteQrImageId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 400, height: 400 },
    }));

    // QR URL label
    const { widgetIds: [qrUrlLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: this.lastQrUrl ?? '',
          style: { color: this.theme.textTertiary, fontSize: 11, wordWrap: true, selectable: true } },
      ] })
    );
    this.remoteQrUrlLabelId = qrUrlLabelId;
    await this.request(request(this.id, tab4, 'addLayoutChild', {
      widgetId: this.remoteQrUrlLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.tabContents = [];
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
    this.introduceButtons.clear();
    this.acceptIntroButtons.clear();
    this.rejectIntroButtons.clear();
    this.signalingRemoveButtons.clear();
    this.promoteButtons.clear();
    this.blockButtons.clear();
    this.unblockButtons.clear();
    this.signalingPeerAddButtons.clear();
    this.frontendDisconnectButtons.clear();
    this.frontendRevokeButtons.clear();
    this.remoteEnableCheckboxId = undefined;
    this.remoteStatusLabelId = undefined;
    this.remoteGenerateBtnId = undefined;
    this.remoteQrImageId = undefined;
    this.remoteQrUrlLabelId = undefined;
    this.frontendsListAreaId = undefined;

    this.changed('visibility', false);
    return true;
  }

  // ========== HELPERS ==========

  private async refresh(): Promise<void> {
    if (!this.windowId) return;
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshPending = false;
        for (let i = 0; i < this.tabContents.length; i++) {
          // The Frontends tab has persistent pairing widgets (checkbox, Generate
          // button, QR image). populateFrontendsTab() clears its inner list area
          // in place, so we skip the full teardown here to avoid flicker.
          if (i === 4 && this.remoteEnableCheckboxId) continue;
          await this.request(request(this.id, this.tabContents[i], 'clearLayoutChildren', {}));
        }
        await this.populateTabs();
      } while (this.refreshPending && this.windowId);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshRemoteStatusLabel(): Promise<void> {
    if (!this.remoteStatusLabelId || !this.remoteUIAccessId) return;
    try {
      const status = await this.request<{ enabled: boolean; peerId: string; signalingUrl: string; connectedCount: number }>(
        request(this.id, this.remoteUIAccessId, 'getStatus', {})
      );
      await this.request(request(this.id, this.remoteStatusLabelId, 'update', {
        text: formatRemoteStatus(status),
      }));
    } catch { /* best effort */ }
  }

  private async addDivider(containerId: AbjectId): Promise<void> {
    const { widgetIds: [divId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'divider', windowId: this.windowId },
      ] })
    );
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));
  }

  private async setStatus(text: string, color = this.theme.textDescription): Promise<void> {
    if (!this.statusLabelId) return;
    await this.request(
      request(this.id, this.statusLabelId, 'update', {
        text, style: { color },
      })
    );
  }

  // ========== IDENTITY ACTIONS ==========

  private async saveName(): Promise<void> {
    if (!this.windowId || !this.nameInputId || !this.identityId) return;

    const name = await this.request<string>(
      request(this.id, this.nameInputId, 'getValue', {})
    );

    if (!name || name.trim() === '') {
      await this.setStatus('Name cannot be empty.', this.theme.statusErrorBright);
      return;
    }

    await this.request(
      request(this.id, this.identityId, 'setName', { name: name.trim() })
    );

    await this.setStatus('Name saved!');
  }

  private async copyPeerId(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<{ peerId: string }>(
        request(this.id, this.identityId, 'exportPublicKeys', {})
      );

      if (this.clipboardId) {
        await this.request(
          request(this.id, this.clipboardId, 'write', { text: identity.peerId })
        );
        await this.setStatus('Peer ID copied!');
      } else {
        await this.setStatus('Clipboard not available.', this.theme.statusErrorBright);
      }
    } catch {
      await this.setStatus('Failed to copy Peer ID.', this.theme.statusErrorBright);
    }
  }

  private async copyIdentityJson(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<{
        peerId: string; publicSigningKey: string; publicExchangeKey: string; name: string;
      }>(
        request(this.id, this.identityId, 'exportPublicKeys', {})
      );

      const json = JSON.stringify({
        peerId: identity.peerId,
        publicSigningKey: identity.publicSigningKey,
        publicExchangeKey: identity.publicExchangeKey,
        name: identity.name,
      }, null, 2);

      if (this.clipboardId) {
        await this.request(
          request(this.id, this.clipboardId, 'write', { text: json })
        );
        await this.setStatus('Identity JSON copied!');
      } else {
        await this.setStatus('Clipboard not available.', this.theme.statusErrorBright);
      }
    } catch {
      await this.setStatus('Failed to copy identity.', this.theme.statusErrorBright);
    }
  }

  // ========== PEER NETWORK ACTIONS ==========

  private async removeSignalingServer(url: string): Promise<void> {
    if (!this.peerRegistryId) return;

    const confirmed = await this.confirm({
      title: 'Remove Server',
      message: `Remove signaling server "${url}"?`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'removeSignalingServer', { url })
      );
      await this.refresh();
      await this.setStatus('Removed signaling server.');
    } catch {
      await this.setStatus('Failed to remove server.', this.theme.statusErrorBright);
    }
  }

  private async connectSignaling(): Promise<void> {
    if (!this.signalingInputId || !this.peerRegistryId) return;

    const url = await this.request<string>(
      request(this.id, this.signalingInputId, 'getValue', {})
    );

    if (!url || url.trim() === '') {
      await this.setStatus('Enter a signaling server URL.', this.theme.statusErrorBright);
      return;
    }

    try {
      const ok = await this.request<boolean>(
        request(this.id, this.peerRegistryId, 'connectSignaling', { url: url.trim() })
      );
      if (ok) {
        await this.refresh();
        await this.setStatus('Connected to signaling server!', this.theme.statusSuccess);
      } else {
        await this.setStatus('Failed to connect.', this.theme.statusErrorBright);
      }
    } catch {
      await this.setStatus('Connection error.', this.theme.statusErrorBright);
    }
  }

  private async addContact(): Promise<void> {
    if (!this.addContactInputId || !this.peerRegistryId) return;

    const jsonStr = await this.request<string>(
      request(this.id, this.addContactInputId, 'getValue', {})
    );

    if (!jsonStr || jsonStr.trim() === '') {
      await this.setStatus('Paste identity JSON.', this.theme.statusErrorBright);
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
        await this.setStatus('Invalid identity JSON.', this.theme.statusErrorBright);
        return;
      }

      await this.request(
        request(this.id, this.peerRegistryId, 'addContact', {
          peerId: parsed.peerId,
          publicSigningKey: parsed.publicSigningKey,
          publicExchangeKey: parsed.publicExchangeKey,
          name: parsed.name ?? '',
        })
      );

      await this.refresh();
      await this.setStatus('Contact added!');
    } catch {
      await this.setStatus('Invalid JSON format.', this.theme.statusErrorBright);
    }
  }

  private async toggleConnection(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      const state = await this.request<string>(
        request(this.id, this.peerRegistryId, 'getContactState', { peerId })
      );

      const wasConnected = state === 'connected';
      if (wasConnected) {
        await this.request(
          request(this.id, this.peerRegistryId, 'disconnectPeer', { peerId })
        );
      } else {
        await this.request(
          request(this.id, this.peerRegistryId, 'connectToPeer', { peerId })
        );
      }

      await this.refresh();
      await this.setStatus(wasConnected ? 'Disconnected.' : 'Connecting...');
    } catch {
      await this.setStatus('Connection error.', this.theme.statusErrorBright);
    }
  }

  private async introduceContact(contactId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    // Get list of connected peers to choose the recipient
    interface ContactInfo {
      peerId: string; name: string; state: string; addedAt: number;
    }
    let contacts: ContactInfo[] = [];
    try {
      contacts = await this.request<ContactInfo[]>(
        request(this.id, this.peerRegistryId, 'listContacts', {})
      );
    } catch { return; }

    // Find connected peers that are not the contact being introduced
    const connectedPeers = contacts.filter(c => c.state === 'connected' && c.peerId !== contactId);
    if (connectedPeers.length === 0) {
      await this.setStatus('No other connected peers to introduce to.', this.theme.statusErrorBright);
      return;
    }

    // For simplicity, introduce to each connected peer
    let introduced = 0;
    for (const peer of connectedPeers) {
      try {
        await this.request(
          request(this.id, this.peerRegistryId, 'introduceContact', {
            contactId, toPeerId: peer.peerId,
          })
        );
        introduced++;
      } catch { /* skip failures */ }
    }

    if (introduced > 0) {
      await this.setStatus(`Introduced to ${introduced} peer(s)!`);
    } else {
      await this.setStatus('Failed to introduce.', this.theme.statusErrorBright);
    }
  }

  private async acceptIntroduction(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'acceptIntroduction', { peerId })
      );
      await this.refresh();
      await this.setStatus('Introduction accepted!');
    } catch {
      await this.setStatus('Failed to accept introduction.', this.theme.statusErrorBright);
    }
  }

  private async rejectIntroduction(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'rejectIntroduction', { peerId })
      );
      await this.refresh();
      await this.setStatus('Introduction rejected.');
    } catch {
      await this.setStatus('Failed to reject introduction.', this.theme.statusErrorBright);
    }
  }

  private async blockPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    const confirmed = await this.confirm({
      title: 'Block Peer',
      message: `Block this peer? They will no longer be able to connect to you.`,
      confirmLabel: 'Block',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'blockPeer', { peerId })
      );
      await this.refresh();
      await this.setStatus('Peer blocked.');
    } catch {
      await this.setStatus('Failed to block peer.', this.theme.statusErrorBright);
    }
  }

  private async unblockPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'unblockPeer', { peerId })
      );
      await this.refresh();
      await this.setStatus('Peer unblocked.');
    } catch {
      await this.setStatus('Failed to unblock peer.', this.theme.statusErrorBright);
    }
  }

  private async promoteNetworkPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'promoteToContact', { peerId })
      );
      await this.refresh();
      await this.setStatus('Peer promoted to contact!');
    } catch {
      await this.setStatus('Failed to promote peer.', this.theme.statusErrorBright);
    }
  }

  private async hasSignalingServer(): Promise<boolean> {
    if (!this.peerRegistryId) return false;
    try {
      const servers = await this.request<Array<{ url: string; status: string }>>(
        request(this.id, this.peerRegistryId, 'listSignalingServers', {})
      );
      return servers.some(s => s.status === 'connected');
    } catch {
      return false;
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  }

  private async removeContact(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    const confirmed = await this.confirm({
      title: 'Remove Contact',
      message: `Remove this contact? You will lose the ability to connect to them.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'removeContact', { peerId })
      );
      await this.refresh();
      await this.setStatus('Contact removed.');
    } catch {
      await this.setStatus('Failed to remove contact.', this.theme.statusErrorBright);
    }
  }
}

// Well-known peer network ID
export const PEER_NETWORK_ID = 'abjects:peer-network' as AbjectId;

function formatRemoteStatus(status: { enabled: boolean; peerId: string; signalingUrl: string; connectedCount: number }): string {
  if (!status.enabled) return 'Remote access is disabled.';
  if (!status.peerId) return 'Remote access enabled (initializing…)';
  return `Listening as ${status.peerId.slice(0, 16)}… via ${status.signalingUrl} (${status.connectedCount} connected)`;
}

function formatRelative(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
