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
  private connectButtons: Map<AbjectId, string> = new Map();
  private removeButtons: Map<AbjectId, string> = new Map();

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

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.identityId = await this.discoverDep('Identity') ?? undefined;
    this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;

    // Subscribe to PeerRegistry events so the window auto-refreshes
    if (this.peerRegistryId) {
      await this.request(request(this.id, this.peerRegistryId, 'addDependent', {}));
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
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

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

      // PeerRegistry events — auto-refresh
      if (fromId === this.peerRegistryId && (
        aspect === 'contactConnected' || aspect === 'contactDisconnected' ||
        aspect === 'contactIntroduced' || aspect === 'signalingStateChanged'
      )) {
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
        title: 'Peer Network',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root ScrollableVBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createScrollableVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    const cId = this.rootLayoutId;

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

    // ========== IDENTITY SECTION ==========

    // Identity header
    const identityHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Your Identity',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: identityHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 24 },
    }));

    // Display Name label
    const nameLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Display Name',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: nameLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Name input + Save button row
    const nameRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: nameRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.nameInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'Enter display name',
        text: peerName,
      })
    );
    await this.request(request(this.id, this.nameInputId, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, 'addLayoutChild', {
      widgetId: this.nameInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.saveNameBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Save',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.saveNameBtnId, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, 'addLayoutChild', {
      widgetId: this.saveNameBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 70, height: 32 },
    }));

    // Peer ID label
    const peerIdHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Peer ID',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: peerIdHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Peer ID value (truncated)
    const truncatedPeerId = peerId ? `${peerId.slice(0, 16)}...${peerId.slice(-8)}` : '(not initialized)';
    const peerIdValueId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: truncatedPeerId,
        style: { color: '#8b8fa3', fontSize: 12 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: peerIdValueId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Copy buttons row
    const copyRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: copyRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.copyPeerIdBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Copy Peer ID',
      })
    );
    await this.request(request(this.id, this.copyPeerIdBtnId, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, 'addLayoutChild', {
      widgetId: this.copyPeerIdBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 130, height: 30 },
    }));

    this.copyIdentityBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Copy Identity JSON',
      })
    );
    await this.request(request(this.id, this.copyIdentityBtnId, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, 'addLayoutChild', {
      widgetId: this.copyIdentityBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 160, height: 30 },
    }));

    // ========== SIGNALING SERVERS SECTION ==========

    await this.addDivider(cId);

    // Signaling Server header
    const sigHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Signaling Servers',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sigHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    // Signaling URL input + Connect button row
    const sigRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: sigRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.signalingInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: 'ws://localhost:7720',
      })
    );
    await this.request(request(this.id, this.signalingInputId, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, 'addLayoutChild', {
      widgetId: this.signalingInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.signalingConnectBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Connect',
        style: { background: '#1e3a2e', borderColor: '#4caf50' },
      })
    );
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
          parentLayoutId: cId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, cId, 'addLayoutChild', {
        widgetId: serverRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 28 },
      }));

      // URL label — color based on status
      const urlColor = status === 'connected' ? '#4caf50'
        : status === 'connecting' ? '#e8a84c'
        : '#ff6b6b';
      const urlLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text: url,
          style: { color: urlColor, fontSize: 12 },
        })
      );
      await this.request(request(this.id, serverRowId, 'addLayoutChild', {
        widgetId: urlLabelId,
        sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
        preferredSize: { height: 28 },
      }));

      // Status label
      const statusText = status === 'connected' ? 'connected'
        : status === 'connecting' ? 'connecting...'
        : 'offline';
      const statusLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text: statusText,
          style: { color: urlColor, fontSize: 11 },
        })
      );
      await this.request(request(this.id, serverRowId, 'addLayoutChild', {
        widgetId: statusLabelId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 80, height: 28 },
      }));

      // Remove button
      const removeBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createButton', {
          windowId: this.windowId, rect: r0, text: 'Remove',
          style: { fontSize: 11 },
        })
      );
      await this.request(request(this.id, removeBtnId, 'addDependent', {}));
      await this.request(request(this.id, serverRowId, 'addLayoutChild', {
        widgetId: removeBtnId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 70, height: 26 },
      }));
      this.signalingRemoveButtons.set(removeBtnId, url);
    }

    // ========== CONTACTS SECTION ==========

    await this.addDivider(cId);

    // Add Contact label
    const addLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Add Contact',
        style: { color: '#e2e4e9', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: addLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    const addDescId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: "Paste a peer's identity JSON.",
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: addDescId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Add contact input + button row
    const addRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: cId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: addRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.addContactInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0, placeholder: '{"peerId":"...","publicSigningKey":"..."}',
      })
    );
    await this.request(request(this.id, this.addContactInputId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: this.addContactInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.addContactBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Add',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.addContactBtnId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: this.addContactBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 60, height: 32 },
    }));

    // Contacts section header
    const contactsHeaderId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Contacts',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
      })
    );
    await this.request(request(this.id, cId, 'addLayoutChild', {
      widgetId: contactsHeaderId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));

    if (contacts.length === 0) {
      const emptyLabelId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createLabel', {
          windowId: this.windowId, rect: r0, text: 'No contacts yet.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      );
      await this.request(request(this.id, cId, 'addLayoutChild', {
        widgetId: emptyLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 18 },
      }));
    } else {
      for (const contact of contacts) {
        // HBox row: name + state + connect/disconnect + remove
        const rowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createNestedHBox', {
            parentLayoutId: cId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, cId, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        // Name label
        const displayName = contact.name || contact.peerId.slice(0, 12) + '...';
        const nameId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createLabel', {
            windowId: this.windowId, rect: r0, text: displayName,
            style: { color: '#e2e4e9', fontSize: 12 },
          })
        );
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: nameId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 30 },
        }));

        // State label (color-coded)
        const stateColor = contact.state === 'connected' ? '#4caf50'
          : contact.state === 'connecting' ? '#e8a84c'
          : '#6b7084';
        const stateId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createLabel', {
            windowId: this.windowId, rect: r0, text: contact.state,
            style: { color: stateColor, fontSize: 11 },
          })
        );
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: stateId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 30 },
        }));

        // Connect/Disconnect button
        const isConnected = contact.state === 'connected';
        const connBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createButton', {
            windowId: this.windowId, rect: r0,
            text: isConnected ? 'Disconnect' : 'Connect',
            style: isConnected
              ? { fontSize: 11 }
              : { background: '#1e3a2e', borderColor: '#4caf50', fontSize: 11 },
          })
        );
        await this.request(request(this.id, connBtnId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: connBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 80, height: 28 },
        }));
        this.connectButtons.set(connBtnId, contact.peerId);

        // Remove button
        const delBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createButton', {
            windowId: this.windowId, rect: r0, text: 'Remove',
            style: { background: '#3a1f1f', color: '#ff6b6b', borderColor: '#ff6b6b', fontSize: 11 },
          })
        );
        await this.request(request(this.id, delBtnId, 'addDependent', {}));
        await this.request(request(this.id, rowId, 'addLayoutChild', {
          widgetId: delBtnId,
          sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 70, height: 28 },
        }));
        this.removeButtons.set(delBtnId, contact.peerId);
      }
    }

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

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
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
    this.signalingRemoveButtons.clear();

    await this.changed('visibility', false);
    return true;
  }

  // ========== HELPERS ==========

  private async refresh(): Promise<void> {
    if (!this.windowId) return;
    await this.hide();
    await this.show();
  }

  private async addDivider(containerId: AbjectId): Promise<void> {
    const divId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDivider', {
        windowId: this.windowId, rect: { x: 0, y: 0, width: 0, height: 0 },
      })
    );
    await this.request(request(this.id, containerId, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));
  }

  private async setStatus(text: string, color = '#b4b8c8'): Promise<void> {
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
      await this.setStatus('Name cannot be empty.', '#ff6b6b');
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
        await this.setStatus('Clipboard not available.', '#ff6b6b');
      }
    } catch {
      await this.setStatus('Failed to copy identity.', '#ff6b6b');
    }
  }

  // ========== PEER NETWORK ACTIONS ==========

  private async removeSignalingServer(url: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'removeSignalingServer', { url })
      );
      await this.refresh();
      await this.setStatus('Removed signaling server.');
    } catch {
      await this.setStatus('Failed to remove server.', '#ff6b6b');
    }
  }

  private async connectSignaling(): Promise<void> {
    if (!this.signalingInputId || !this.peerRegistryId) return;

    const url = await this.request<string>(
      request(this.id, this.signalingInputId, 'getValue', {})
    );

    if (!url || url.trim() === '') {
      await this.setStatus('Enter a signaling server URL.', '#ff6b6b');
      return;
    }

    try {
      const ok = await this.request<boolean>(
        request(this.id, this.peerRegistryId, 'connectSignaling', { url: url.trim() })
      );
      if (ok) {
        await this.refresh();
        await this.setStatus('Connected to signaling server!', '#4caf50');
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
      request(this.id, this.addContactInputId, 'getValue', {})
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
      await this.setStatus('Invalid JSON format.', '#ff6b6b');
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
      await this.setStatus('Connection error.', '#ff6b6b');
    }
  }

  private async removeContact(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'removeContact', { peerId })
      );
      await this.refresh();
      await this.setStatus('Contact removed.');
    } catch {
      await this.setStatus('Failed to remove contact.', '#ff6b6b');
    }
  }
}

// Well-known peer network ID
export const PEER_NETWORK_ID = 'abjects:peer-network' as AbjectId;
