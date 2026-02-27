/**
 * Registry Browser — browse all registered objects, view interfaces and methods.
 *
 * Three-level navigation:
 *   Kind List  →  Instance List  →  Detail View
 *
 * Uses direct widget Abject interaction (createWindowAbject, createLabel, etc.)
 * instead of the old string-based widget ID shim.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';

const REGISTRY_BROWSER_INTERFACE: InterfaceId = 'abjects:registry-browser';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const WINDOW_INTERFACE: InterfaceId = 'abjects:window';
const FACTORY_INTERFACE: InterfaceId = 'abjects:factory';

const WIN_W = 550;
const WIN_H = 500;

export class RegistryBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private systemRegistryId?: AbjectId;
  private objectCreatorId?: AbjectId;
  private factoryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private cachedObjects: ObjectRegistration[] = [];
  private systemObjects: ObjectRegistration[] = [];
  private searchText = '';
  private abjectEditorId?: AbjectId;
  private detailIndex?: number;
  private selectedMethod?: { interfaceId: InterfaceId; method: string };
  private detailObjectId?: AbjectId;

  // ── Remote browsing mode ──
  private isRemoteMode = false;
  private remoteLabel?: string;
  private localRegistryId?: AbjectId;   // preserved when switching to remote mode
  private abjectStoreId?: AbjectId;     // for persisting cloned objects

  // ── Navigation state ──
  private currentView: 'kindList' | 'instanceList' | 'detail' = 'kindList';
  private selectedKindName?: string;
  private kindInstances: ObjectRegistration[] = [];
  private selectedKindIsSystem = false;  // true when viewing a system kind

  // ── Kind List View widget tracking ──
  private kindButtons: Map<AbjectId, string> = new Map();  // btnId → kind name
  private systemKindButtons: Map<AbjectId, string> = new Map();  // btnId → system kind name
  private searchInputId?: AbjectId;
  private scrollableListId?: AbjectId;

  // ── Instance List View widget tracking ──
  private instanceButtons: Map<AbjectId, number> = new Map();  // btnId → index in kindInstances
  private instanceCloneButtons: Map<AbjectId, number> = new Map();  // clone btnId → index
  private instanceDeleteButtons: Map<AbjectId, number> = new Map();  // delete btnId → index

  // ── Detail View widget tracking ──
  private backBtnId?: AbjectId;
  private editSourceBtnId?: AbjectId;
  private deleteBtnId?: AbjectId;
  private cloneBtnId?: AbjectId;
  private methodButtons: Map<AbjectId, { interfaceId: InterfaceId; method: string }> = new Map();
  private msgPayloadId?: AbjectId;
  private msgSendBtnId?: AbjectId;
  private msgResponseId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'RegistryBrowser',
        description:
          'Browse all registered objects in the system. View interfaces, methods, and capabilities.',
        version: '1.0.0',
        interfaces: [
          {
            id: REGISTRY_BROWSER_INTERFACE,
            name: 'RegistryBrowser',
            description: 'System object browser',
            methods: [
              {
                name: 'show',
                description: 'Show the registry browser',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the registry browser',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getState',
                description: 'Return current state of the registry browser',
                parameters: [],
                returns: { kind: 'object', properties: {
                  visible: { kind: 'primitive', primitive: 'boolean' },
                }},
              },
              {
                name: 'browseRemote',
                description: 'Configure this browser to target a remote registry via UUID routing',
                parameters: [
                  { name: 'registryId', type: { kind: 'primitive', primitive: 'string' }, description: 'Remote workspace registry ID' },
                  { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Owner peer ID' },
                  { name: 'label', type: { kind: 'primitive', primitive: 'string' }, description: 'Display label for the window title' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        ],
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display browser window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.objectCreatorId = await this.discoverDep('ObjectCreator') ?? undefined;
    this.factoryId = await this.discoverDep('Factory') ?? undefined;

    // Discover the global "SystemRegistry" registered by WorkspaceManager
    this.systemRegistryId = await this.discoverDep('SystemRegistry') ?? undefined;

    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;

    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        'abjects:registry' as InterfaceId, 'subscribe', {}));
    }

    // Subscribe to system registry notifications too
    if (this.systemRegistryId) {
      try {
        await this.request(request(this.id, this.systemRegistryId,
          'abjects:registry' as InterfaceId, 'subscribe', {}));
      } catch { /* SystemRegistry may not support subscribe */ }
    }
  }

  /**
   * List objects from workspace registry via message passing.
   */
  private async registryList(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'list', {})
    );
  }

  /**
   * List objects from the global system registry.
   */
  private async systemRegistryList(): Promise<ObjectRegistration[]> {
    if (!this.systemRegistryId) return [];
    try {
      return await this.request<ObjectRegistration[]>(
        request(this.id, this.systemRegistryId, 'abjects:registry' as InterfaceId, 'list', {})
      );
    } catch {
      return [];
    }
  }

  /**
   * Register this RegistryBrowser as a dependent of a widget Abject,
   * so we receive 'changed' events from it.
   */
  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
  }

  /**
   * Clear all view-specific widget tracking fields.
   * Does NOT clear windowId — only hide() does that.
   */
  private clearViewTracking(): void {
    this.rootLayoutId = undefined;
    // Kind list view
    this.kindButtons.clear();
    this.systemKindButtons.clear();
    this.searchInputId = undefined;
    this.scrollableListId = undefined;

    // Instance list view
    this.instanceButtons.clear();
    this.instanceCloneButtons.clear();
    this.instanceDeleteButtons.clear();

    // Detail view
    this.backBtnId = undefined;
    this.editSourceBtnId = undefined;
    this.deleteBtnId = undefined;
    this.cloneBtnId = undefined;
    this.methodButtons.clear();
    this.msgPayloadId = undefined;
    this.msgSendBtnId = undefined;
    this.msgResponseId = undefined;
  }

  /**
   * Destroy the current root layout (and all its children) so we can
   * repopulate in-place without destroying the window.
   */
  private async destroyRootLayout(): Promise<void> {
    if (this.rootLayoutId && this.windowId) {
      try {
        // Remove layout from window, then destroy it
        await this.request(
          request(this.id, this.windowId, WINDOW_INTERFACE, 'removeChild', {
            widgetId: this.rootLayoutId,
          })
        );
      } catch { /* layout or window may be gone */ }
      try {
        await this.request(
          request(this.id, this.rootLayoutId, WIDGET_INTERFACE, 'destroy', {})
        );
      } catch { /* already gone */ }
    }
    this.clearViewTracking();
  }

  /**
   * Group a list of ObjectRegistrations by manifest.name.
   * Returns a map of kindName → array of ObjectRegistration.
   */
  private groupByKindFrom(objects: ObjectRegistration[]): Map<string, ObjectRegistration[]> {
    const groups = new Map<string, ObjectRegistration[]>();
    for (const obj of objects) {
      const name = obj.manifest.name;
      const group = groups.get(name);
      if (group) {
        group.push(obj);
      } else {
        groups.set(name, [obj]);
      }
    }
    return groups;
  }

  /**
   * Group cachedObjects by manifest.name.
   */
  private groupByKind(): Map<string, ObjectRegistration[]> {
    return this.groupByKindFrom(this.cachedObjects);
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

    this.on('browseRemote', async (msg: AbjectMessage) => {
      const { registryId, label } = msg.payload as {
        registryId: string; peerId: string; label: string;
      };
      this.localRegistryId = this.registryId;   // preserve for cloning back
      this.registryId = registryId as AbjectId;  // UUID routes via PeerRouter
      this.systemRegistryId = undefined;
      this.isRemoteMode = true;
      this.remoteLabel = label;
      return true;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click' && aspect !== 'submit' && aspect !== 'change') return;
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });

    this.on('objectRegistered', async () => {
      if (this.isRemoteMode) return;  // no subscription to remote events
      this.cachedObjects = await this.registryList();
      this.systemObjects = await this.systemRegistryList();
      if (this.windowId) {
        if (this.currentView === 'kindList') {
          await this.populateKindListView();
        } else if (this.currentView === 'instanceList' && this.selectedKindName) {
          await this.showInstanceListView(this.selectedKindName);
        }
        // Don't refresh detail view on registration — it would be disruptive
      }
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    this.searchText = '';
    this.currentView = 'kindList';
    this.selectedKindName = undefined;
    this.selectedKindIsSystem = false;
    this.cachedObjects = await this.registryList();
    this.systemObjects = await this.systemRegistryList();
    await this.showKindListView();
    await this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.currentView = 'kindList';
    this.selectedKindName = undefined;
    this.selectedKindIsSystem = false;
    this.kindInstances = [];
    this.clearViewTracking();
    await this.changed('visibility', false);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Kind List View
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show the kind list view — creates window if needed, then populates content.
   */
  private async showKindListView(): Promise<void> {
    this.currentView = 'kindList';
    this.selectedKindName = undefined;

    const windowTitle = this.isRemoteMode ? `Remote: ${this.remoteLabel}` : 'Registry Browser';

    if (!this.windowId) {
      const displayInfo = await this.request<{ width: number; height: number }>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
      );

      const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
      const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

      this.windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
          title: windowTitle,
          rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
          zIndex: 200,
          resizable: true,
        })
      );
    } else {
      await this.request(
        request(this.id, this.windowId, WINDOW_INTERFACE, 'setTitle', {
          title: windowTitle,
        })
      );
    }

    await this.populateKindListView();
  }

  /**
   * Populate or repopulate the kind list view content without recreating the window.
   */
  private async populateKindListView(): Promise<void> {
    await this.destroyRootLayout();

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout (non-scrollable outer container)
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId!,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Search input at the top
    this.searchInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId!, rect: r0, placeholder: 'Search kinds...',
      })
    );
    await this.addDep(this.searchInputId);
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.searchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Restore search text if non-empty (e.g. after objectRegistered rebuild)
    if (this.searchText) {
      await this.request(
        request(this.id, this.searchInputId, WIDGET_INTERFACE, 'update', {
          text: this.searchText,
        })
      );
    }

    // Scrollable VBox for the kind list
    this.scrollableListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.scrollableListId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Populate buttons for matching kinds
    await this.rebuildKindButtons();
  }

  /**
   * Rebuild the kind buttons inside the scrollable list,
   * filtered by the current searchText.
   * Shows workspace objects first, then a "System" divider, then system objects.
   */
  private async rebuildKindButtons(): Promise<void> {
    if (!this.scrollableListId) return;

    // Destroy existing workspace kind buttons
    for (const [btnId] of this.kindButtons) {
      try {
        await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'removeLayoutChild', {
          widgetId: btnId,
        }));
      } catch { /* may already be gone */ }
      try {
        await this.request(request(this.id, btnId, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* already gone */ }
    }
    this.kindButtons.clear();

    // Destroy existing system kind buttons
    for (const [btnId] of this.systemKindButtons) {
      try {
        await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'removeLayoutChild', {
          widgetId: btnId,
        }));
      } catch { /* may already be gone */ }
      try {
        await this.request(request(this.id, btnId, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* already gone */ }
    }
    this.systemKindButtons.clear();

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const query = this.searchText.toLowerCase();

    // ── Workspace objects ──
    const wsGroups = this.groupByKind();
    const wsSortedNames = Array.from(wsGroups.keys()).sort();

    for (const kindName of wsSortedNames) {
      const instances = wsGroups.get(kindName)!;
      const desc = instances[0].manifest.description;
      const nameLower = kindName.toLowerCase();
      const descLower = desc.toLowerCase();
      if (query && !nameLower.includes(query) && !descLower.includes(query)) continue;

      const count = instances.length;
      const descTrunc = desc.length > 45 ? desc.slice(0, 45) + '...' : desc;
      const label = `${kindName} (${count}) — ${descTrunc}`;

      const btnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId!, rect: r0, text: label,
          style: { fontSize: 13 },
        })
      );
      await this.addDep(btnId);
      this.kindButtons.set(btnId, kindName);

      await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: btnId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));
    }

    // ── System objects (from global registry) ──
    if (this.systemObjects.length > 0) {
      const sysGroups = this.groupByKindFrom(this.systemObjects);
      const sysSortedNames = Array.from(sysGroups.keys()).sort();

      // Filter system kinds that match the search query
      const matchingSysNames = sysSortedNames.filter((kindName) => {
        const instances = sysGroups.get(kindName)!;
        const desc = instances[0].manifest.description;
        const nameLower = kindName.toLowerCase();
        const descLower = desc.toLowerCase();
        return !query || nameLower.includes(query) || descLower.includes(query);
      });

      if (matchingSysNames.length > 0) {
        // Add "System" divider label
        const dividerId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
            windowId: this.windowId!, rect: r0,
            text: 'System',
            style: { color: '#6b7084', fontSize: 12, fontWeight: 'bold' },
          })
        );
        // Track divider in systemKindButtons for cleanup (uses a sentinel key)
        this.systemKindButtons.set(dividerId, '__divider__');
        await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: dividerId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 24 },
        }));

        for (const kindName of matchingSysNames) {
          const instances = sysGroups.get(kindName)!;
          const desc = instances[0].manifest.description;

          const count = instances.length;
          const descTrunc = desc.length > 45 ? desc.slice(0, 45) + '...' : desc;
          const label = `${kindName} (${count}) — ${descTrunc}`;

          const btnId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
              windowId: this.windowId!, rect: r0, text: label,
              style: { fontSize: 13, color: '#6b7084' },
            })
          );
          await this.addDep(btnId);
          this.systemKindButtons.set(btnId, kindName);

          await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'addLayoutChild', {
            widgetId: btnId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 32 },
          }));
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Instance List View
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show the instance list view for a given kind name.
   */
  private async showInstanceListView(kindName: string, isSystem?: boolean): Promise<void> {
    this.currentView = 'instanceList';
    this.selectedKindName = kindName;
    this.searchText = '';

    // If isSystem is explicitly passed, use it; otherwise preserve current state
    if (isSystem !== undefined) {
      this.selectedKindIsSystem = isSystem;
    }

    // Compute instances of this kind from the correct source
    const source = this.selectedKindIsSystem ? this.systemObjects : this.cachedObjects;
    this.kindInstances = source.filter(o => o.manifest.name === kindName);

    await this.destroyRootLayout();

    // Update window title
    const count = this.kindInstances.length;
    if (this.windowId) {
      await this.request(
        request(this.id, this.windowId, WINDOW_INTERFACE, 'setTitle', {
          title: `${kindName} (${count})`,
        })
      );
    }

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId!,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Scrollable VBox for instance rows
    this.scrollableListId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.scrollableListId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Create instance rows (HBox: instance button + clone button)
    for (let i = 0; i < this.kindInstances.length; i++) {
      const inst = this.kindInstances[i];
      const shortId = inst.id.slice(0, 8);

      const rowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: this.scrollableListId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 6,
        })
      );
      await this.request(request(this.id, this.scrollableListId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: rowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      // Instance button (click to show detail)
      const instBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId!, rect: r0,
          text: `${kindName} [${shortId}...]`,
          style: { fontSize: 13 },
        })
      );
      await this.addDep(instBtnId);
      this.instanceButtons.set(instBtnId, i);
      await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: instBtnId,
        sizePolicy: { horizontal: 'expanding' },
        preferredSize: { height: 32 },
      }));

      // Clone button — local mode: always; remote mode: only if source exists
      if (this.factoryId && (!this.isRemoteMode || inst.source !== undefined)) {
        const cloneBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId!, rect: r0, text: 'Clone',
            style: { fontSize: 12 },
          })
        );
        await this.addDep(cloneBtnId);
        this.instanceCloneButtons.set(cloneBtnId, i);
        await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: cloneBtnId,
          sizePolicy: { horizontal: 'fixed' },
          preferredSize: { width: 60, height: 32 },
        }));

        // Delete button (local mode only)
        if (!this.isRemoteMode) {
          const delBtnId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
              windowId: this.windowId!, rect: r0, text: 'Delete',
              style: { fontSize: 12, background: '#c0392b', color: '#ffffff', borderColor: '#c0392b' },
            })
          );
          await this.addDep(delBtnId);
          this.instanceDeleteButtons.set(delBtnId, i);
          await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
            widgetId: delBtnId,
            sizePolicy: { horizontal: 'fixed' },
            preferredSize: { width: 60, height: 32 },
          }));
        }
      }
    }

    // ── Fixed bottom bar ──
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 10,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: bottomRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.backBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId!, rect: r0, text: 'Back',
      })
    );
    await this.addDep(this.backBtnId);
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.backBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    // Right spacer
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Detail View
  // ═══════════════════════════════════════════════════════════════════

  private async showDetailView(index: number): Promise<void> {
    const source = this.selectedKindIsSystem ? this.systemObjects : this.cachedObjects;
    const obj = source[index];
    if (!obj) return;

    // Store for message sending
    this.detailObjectId = obj.id;
    this.detailIndex = index;
    this.currentView = 'detail';
    this.selectedMethod = undefined;

    // Destroy old layout content, keep window
    await this.destroyRootLayout();

    // Update window title
    const shortId = obj.id.slice(0, 8);
    if (this.windowId) {
      await this.request(
        request(this.id, this.windowId, WINDOW_INTERFACE, 'setTitle', {
          title: `${obj.manifest.name} [${shortId}...]`,
        })
      );
    }

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout (non-scrollable outer container)
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId!,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 4,
      })
    );

    // Scrollable VBox for detail content
    const scrollVBoxId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: scrollVBoxId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const addLabel = async (text: string, style?: Record<string, unknown>): Promise<AbjectId> => {
      const id = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text,
          ...(style ? { style } : {}),
        })
      );
      await this.request(request(this.id, scrollVBoxId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: id,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 },
      }));
      return id;
    };

    const addWrappedLabel = async (text: string, style?: Record<string, unknown>): Promise<AbjectId> => {
      const fontSize = 14;
      const lineHeight = fontSize + 4;
      const availableWidth = WIN_W - 32 - 8;
      const lineCount = estimateWrappedLineCount(text, availableWidth, fontSize);
      const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);
      const mergedStyle = { wordWrap: true, ...style };

      const id = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId!, rect: r0, text,
          style: mergedStyle,
        })
      );
      await this.request(request(this.id, scrollVBoxId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: id,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: estimatedHeight },
      }));
      return id;
    };

    await addLabel(`Name: ${obj.manifest.name}`, { color: '#e2e4e9' });
    await addLabel(`Version: ${obj.manifest.version}`, { color: '#e2e4e9' });

    const desc = obj.manifest.description;
    await addWrappedLabel(`Description: ${desc}`);

    // Interfaces
    for (const iface of obj.manifest.interfaces) {
      await addLabel(`Interface: ${iface.name} (${iface.id})`);
      for (const method of iface.methods) {
        const params = method.parameters.map((p) => p.name).join(', ');
        await addLabel(`  ${method.name}(${params}) — ${method.description.slice(0, 40)}`);
      }
    }

    // Tags
    const tags = obj.manifest.tags ?? [];
    if (tags.length > 0) {
      await addLabel(`Tags: ${tags.join(', ')}`);
    }

    // Capabilities
    const provided = obj.manifest.providedCapabilities ?? [];
    if (provided.length > 0) {
      await addLabel(`Provides: ${provided.join(', ')}`);
    }

    const required = obj.manifest.requiredCapabilities ?? [];
    if (required.length > 0) {
      const reqNames = required.map((r) =>
        typeof r === 'string' ? r : r.capability
      );
      await addLabel(`Requires: ${reqNames.join(', ')}`);
    }

    // ── Send Message section (skip in remote mode — read-only) ──
    if (!this.isRemoteMode) {
      await addLabel('Send Message:', { color: '#e2e4e9', fontWeight: 'bold' });

      // Method buttons in 2-col HBox rows
      const allMethods: { interfaceId: InterfaceId; method: string }[] = [];
      for (const iface of obj.manifest.interfaces) {
        for (const method of iface.methods) {
          allMethods.push({ interfaceId: iface.id, method: method.name });
        }
      }

      for (let i = 0; i < allMethods.length; i += 2) {
        const rowId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
            parentLayoutId: scrollVBoxId,
            margins: { top: 0, right: 0, bottom: 0, left: 0 },
            spacing: 8,
          })
        );
        await this.request(request(this.id, scrollVBoxId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: rowId,
          sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 26 },
        }));

        for (let j = i; j < Math.min(i + 2, allMethods.length); j++) {
          const m = allMethods[j];
          const btnId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
              windowId: this.windowId!, rect: r0, text: m.method,
            })
          );
          await this.addDep(btnId);
          this.methodButtons.set(btnId, m);
          await this.request(request(this.id, rowId, LAYOUT_INTERFACE, 'addLayoutChild', {
            widgetId: btnId,
            sizePolicy: { horizontal: 'expanding' },
            preferredSize: { height: 26 },
          }));
        }
      }

      // Payload row (HBox: input + Send)
      const payloadRowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
          parentLayoutId: scrollVBoxId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 8,
        })
      );
      await this.request(request(this.id, scrollVBoxId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: payloadRowId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 30 },
      }));

      this.msgPayloadId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
          windowId: this.windowId!, rect: r0, placeholder: 'JSON payload (optional)',
        })
      );
      await this.addDep(this.msgPayloadId);
      await this.request(request(this.id, payloadRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.msgPayloadId,
        sizePolicy: { horizontal: 'expanding' },
        preferredSize: { height: 30 },
      }));

      this.msgSendBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId!, rect: r0, text: 'Send',
          style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
        })
      );
      await this.addDep(this.msgSendBtnId);
      await this.request(request(this.id, payloadRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.msgSendBtnId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 60, height: 30 },
      }));

      // Response label
      this.msgResponseId = await addLabel('');
    }

    // In remote mode, add a status label for clone feedback
    if (this.isRemoteMode) {
      this.msgResponseId = await addLabel('');
    }

    // ── Fixed bottom buttons row (outside scrollable area) ──
    const bottomRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 4, right: 0, bottom: 0, left: 0 },
        spacing: 10,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: bottomRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    this.backBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId!, rect: r0, text: 'Back',
      })
    );
    await this.addDep(this.backBtnId);
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.backBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));

    // Edit Source + Delete (local mode only)
    if (!this.isRemoteMode) {
      const isEditable = obj.source !== undefined;
      if (isEditable) {
        this.editSourceBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId!, rect: r0, text: 'Edit Source',
          })
        );
        await this.addDep(this.editSourceBtnId);
        await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: this.editSourceBtnId,
          sizePolicy: { horizontal: 'fixed' },
          preferredSize: { width: 110, height: 32 },
        }));

        // Show "Delete" button for workshop-created objects
        if (this.factoryId) {
          this.deleteBtnId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
              windowId: this.windowId!, rect: r0, text: 'Delete',
              style: { background: '#c0392b', color: '#ffffff', borderColor: '#c0392b' },
            })
          );
          await this.addDep(this.deleteBtnId);
          await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
            widgetId: this.deleteBtnId,
            sizePolicy: { horizontal: 'fixed' },
            preferredSize: { width: 80, height: 32 },
          }));
        }
      }

      // Clone button (always available in local mode if factory exists)
      if (this.factoryId) {
        this.cloneBtnId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
            windowId: this.windowId!, rect: r0, text: 'Clone',
          })
        );
        await this.addDep(this.cloneBtnId);
        await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: this.cloneBtnId,
          sizePolicy: { horizontal: 'fixed' },
          preferredSize: { width: 80, height: 32 },
        }));
      }
    }

    // Clone button for remote mode (only for scriptable objects with source)
    if (this.isRemoteMode && this.factoryId && obj.source !== undefined) {
      this.cloneBtnId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
          windowId: this.windowId!, rect: r0, text: 'Clone',
        })
      );
      await this.addDep(this.cloneBtnId);
      await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: this.cloneBtnId,
        sizePolicy: { horizontal: 'fixed' },
        preferredSize: { width: 80, height: 32 },
      }));
    }

    // Right spacer in bottom row
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));
  }

  protected override getSourceForAsk(): string | undefined {
    return `## RegistryBrowser Usage Guide

### Methods
- \`show()\` — Open the registry browser window. If already open, does nothing.
- \`hide()\` — Close the registry browser window.
- \`getState()\` — Returns { visible: boolean }.

### Three-Level Navigation
1. **Kind List** — All registered object types, grouped by manifest name. Shows count and description. Searchable via text input.
2. **Instance List** — All instances of a selected kind. Each row has Clone and Delete buttons.
3. **Detail View** — Full manifest for a specific instance: name, version, description, interfaces, methods, tags, capabilities. Includes method buttons for sending messages, a JSON payload input, and Send button for testing.

### Detail View Features
- **Method buttons** — Click a method to select it, then type JSON payload and click Send.
- **Edit Source** — Opens AbjectEditor for ScriptableAbjects.
- **Clone** — Creates a new instance with the same manifest and source.
- **Delete** — Stops and unregisters the object via Factory.kill().
- **Back** — Navigates back to the instance list or kind list.

### Interface ID
\`abjects:registry-browser\``;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event Handling
  // ═══════════════════════════════════════════════════════════════════

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, _value?: unknown): Promise<void> {
    // ── Search input (kind list view) ──
    if (fromId === this.searchInputId && aspect === 'change') {
      this.searchText = (_value as string) ?? '';
      await this.rebuildKindButtons();
      return;
    }

    // ── Back button ──
    if (fromId === this.backBtnId) {
      if (this.currentView === 'detail' && this.selectedKindName) {
        // Detail → Instance List — refresh both sources
        this.cachedObjects = await this.registryList();
        this.systemObjects = await this.systemRegistryList();
        await this.showInstanceListView(this.selectedKindName);
      } else {
        // Instance List → Kind List (or detail without kind → kind list)
        this.cachedObjects = await this.registryList();
        this.systemObjects = await this.systemRegistryList();
        this.selectedKindIsSystem = false;
        await this.showKindListView();
      }
      return;
    }

    // ── Edit Source button in detail view ──
    if (fromId === this.editSourceBtnId && this.detailIndex !== undefined) {
      const source = this.selectedKindIsSystem ? this.systemObjects : this.cachedObjects;
      const obj = source[this.detailIndex];
      if (obj) {
        // Lazy-discover AbjectEditor (per-workspace, may not exist at onInit time)
        if (!this.abjectEditorId) {
          this.abjectEditorId = await this.discoverDep('AbjectEditor') ?? undefined;
        }
        if (this.abjectEditorId) {
          await this.request(request(this.id, this.abjectEditorId,
            'abjects:abject-editor' as InterfaceId, 'show', { objectId: obj.id }));
        }
      }
      return;
    }

    // ── Delete button in detail view ──
    if (fromId === this.deleteBtnId && this.detailObjectId && this.factoryId) {
      await this.setWidgetDisabled(this.deleteBtnId, true);
      await this.setWidgetDisabled(this.cloneBtnId, true);
      try {
        await this.request(request(this.id, this.factoryId,
          FACTORY_INTERFACE, 'kill', { objectId: this.detailObjectId }));
      } catch { /* object may already be gone */ }
      this.cachedObjects = await this.registryList();
      this.systemObjects = await this.systemRegistryList();
      if (this.selectedKindName) {
        await this.showInstanceListView(this.selectedKindName);
      } else {
        await this.showKindListView();
      }
      return;
    }

    // ── Clone button in detail view ──
    if (fromId === this.cloneBtnId && this.detailObjectId && this.factoryId) {
      await this.setWidgetDisabled(this.cloneBtnId, true);
      await this.cloneObject(this.detailObjectId);
      return;
    }

    // ── Method button in detail view (for message sending) ──
    const methodInfo = this.methodButtons.get(fromId);
    if (methodInfo) {
      this.selectedMethod = methodInfo;
      // Update response label to show selection
      if (this.msgResponseId) {
        await this.request(
          request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
            text: `Selected: ${methodInfo.method}`,
          })
        );
      }
      return;
    }

    // ── Send button in detail view ──
    // Don't await — let the processing loop stay free for other widget events.
    if (fromId === this.msgSendBtnId && this.selectedMethod && this.detailObjectId) {
      this.handleSendMessage();
      return;
    }

    // ── Kind button: navigate to instance list view ──
    const kindName = this.kindButtons.get(fromId);
    if (kindName !== undefined) {
      await this.showInstanceListView(kindName, false);
      return;
    }

    // ── System kind button: navigate to instance list view (system source) ──
    const sysKindName = this.systemKindButtons.get(fromId);
    if (sysKindName !== undefined && sysKindName !== '__divider__') {
      await this.showInstanceListView(sysKindName, true);
      return;
    }

    // ── Instance clone button: clone the instance ──
    const cloneIdx = this.instanceCloneButtons.get(fromId);
    if (cloneIdx !== undefined && this.factoryId) {
      const inst = this.kindInstances[cloneIdx];
      if (inst) {
        await this.cloneObject(inst.id);
      }
      return;
    }

    // ── Instance delete button: delete the instance ──
    const deleteIdx = this.instanceDeleteButtons.get(fromId);
    if (deleteIdx !== undefined && this.factoryId) {
      const inst = this.kindInstances[deleteIdx];
      if (inst) {
        await this.deleteObject(inst.id);
      }
      return;
    }

    // ── Instance button: navigate to detail view ──
    const instIdx = this.instanceButtons.get(fromId);
    if (instIdx !== undefined) {
      const inst = this.kindInstances[instIdx];
      if (inst) {
        // Find the index in the correct source list
        const source = this.selectedKindIsSystem ? this.systemObjects : this.cachedObjects;
        const globalIndex = source.findIndex(o => o.id === inst.id);
        if (globalIndex >= 0) {
          await this.showDetailView(globalIndex);
        }
      }
    }
  }

  /**
   * Clone an object via Factory, refresh caches, and refresh the current view.
   */
  private async cloneObject(objectId: AbjectId): Promise<void> {
    if (!this.factoryId) return;

    if (this.isRemoteMode) {
      return this.cloneRemoteObject(objectId);
    }

    try {
      await this.request(request(this.id, this.factoryId,
        FACTORY_INTERFACE, 'clone', { objectId }));
    } catch (err) {
      // Best-effort: show error in detail view if available
      if (this.msgResponseId) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await this.request(
            request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
              text: `Clone error: ${msg.slice(0, 50)}`,
            })
          );
        } catch { /* widget may be gone */ }
      }
      return;
    }

    // Refresh and rebuild current view
    this.cachedObjects = await this.registryList();
    this.systemObjects = await this.systemRegistryList();
    if (this.currentView === 'instanceList' && this.selectedKindName) {
      await this.showInstanceListView(this.selectedKindName);
    } else if (this.currentView === 'detail' && this.selectedKindName) {
      // Stay on detail but refresh instance list will happen on next back
      // Show feedback in response label
      if (this.msgResponseId) {
        await this.request(
          request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
            text: 'Cloned successfully',
          })
        );
      }
    }
  }

  /**
   * Clone a remote object into the local workspace via Factory.spawn + AbjectStore.save.
   */
  private async cloneRemoteObject(objectId: AbjectId): Promise<void> {
    if (!this.factoryId || !this.localRegistryId) return;

    const obj = this.cachedObjects.find(o => o.id === objectId);
    if (!obj?.source) return;

    try {
      const result = await this.request<SpawnResult>(request(this.id, this.factoryId,
        FACTORY_INTERFACE, 'spawn', {
          manifest: obj.manifest,
          source: obj.source,
          registryHint: this.localRegistryId,
        }));

      // Persist to AbjectStore so it survives page reload
      if (this.abjectStoreId) {
        await this.request(request(this.id, this.abjectStoreId,
          'abjects:abject-store' as InterfaceId, 'save', {
            objectId: result.objectId,
            manifest: obj.manifest,
            source: obj.source,
            owner: this.id,
          }));
      }

      // Show success feedback
      if (this.msgResponseId) {
        try {
          await this.request(request(this.id, this.msgResponseId,
            WIDGET_INTERFACE, 'update', { text: 'Cloned to workspace' }));
        } catch { /* widget may be gone */ }
      }
    } catch (err) {
      if (this.msgResponseId) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await this.request(request(this.id, this.msgResponseId,
            WIDGET_INTERFACE, 'update', { text: `Clone error: ${msg.slice(0, 50)}` }));
        } catch { /* widget may be gone */ }
      }
    }
  }

  /**
   * Delete an object via Factory, refresh caches, and refresh the current view.
   */
  private async deleteObject(objectId: AbjectId): Promise<void> {
    if (!this.factoryId) return;

    try {
      await this.request(request(this.id, this.factoryId,
        FACTORY_INTERFACE, 'kill', { objectId }));
    } catch { /* object may already be gone */ }

    this.cachedObjects = await this.registryList();
    this.systemObjects = await this.systemRegistryList();
    if (this.currentView === 'instanceList' && this.selectedKindName) {
      // Check if any instances of this kind remain (in the correct source)
      const source = this.selectedKindIsSystem ? this.systemObjects : this.cachedObjects;
      const remaining = source.filter(o => o.manifest.name === this.selectedKindName);
      if (remaining.length === 0) {
        await this.showKindListView();
      } else {
        await this.showInstanceListView(this.selectedKindName);
      }
    }
  }

  private async setWidgetDisabled(id: AbjectId | undefined, disabled: boolean): Promise<void> {
    if (!id) return;
    try {
      await this.request(request(this.id, id, WIDGET_INTERFACE, 'update', { style: { disabled } }));
    } catch { /* widget gone */ }
  }

  /**
   * Send a message to the selected method on the detail object.
   */
  private async handleSendMessage(): Promise<void> {
    if (!this.selectedMethod || !this.detailObjectId || !this.msgPayloadId) return;

    const payloadText = await this.request<string>(
      request(this.id, this.msgPayloadId, WIDGET_INTERFACE, 'getValue', {})
    );

    let msgPayload: unknown = {};
    if (payloadText.trim()) {
      try {
        msgPayload = JSON.parse(payloadText);
      } catch {
        if (this.msgResponseId) {
          await this.request(
            request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
              text: 'Error: Invalid JSON payload',
            })
          );
        }
        return;
      }
    }

    // Disable send button during request
    await this.setWidgetDisabled(this.msgSendBtnId, true);

    // Show "Sending..." before the (potentially slow) request
    if (this.msgResponseId) {
      await this.request(
        request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
          text: 'Sending...',
        })
      );
    }

    try {
      const result = await this.request<unknown>(request(
        this.id, this.detailObjectId,
        this.selectedMethod.interfaceId, this.selectedMethod.method, msgPayload
      ));
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const display = resultStr.length > 60 ? resultStr.slice(0, 60) + '...' : resultStr;
      if (this.msgResponseId) {
        await this.request(
          request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
            text: `Result: ${display}`,
          })
        );
      }
    } catch (err) {
      // Object may have been stopped while we were waiting — UI updates are best-effort
      const msg = err instanceof Error ? err.message : String(err);
      try {
        if (this.msgResponseId) {
          await this.request(
            request(this.id, this.msgResponseId, WIDGET_INTERFACE, 'update', {
              text: `Error: ${msg.slice(0, 60)}`,
            })
          );
        }
      } catch { /* object may be stopped */ }
    }

    // Re-enable send button
    await this.setWidgetDisabled(this.msgSendBtnId, false);
  }
}

export const REGISTRY_BROWSER_ID = 'abjects:registry-browser' as AbjectId;
