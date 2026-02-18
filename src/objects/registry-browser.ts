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
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';

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
  private objectCreatorId?: AbjectId;
  private factoryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private cachedObjects: ObjectRegistration[] = [];
  private searchText = '';
  private abjectEditorId?: AbjectId;
  private detailIndex?: number;
  private selectedMethod?: { interfaceId: InterfaceId; method: string };
  private detailObjectId?: AbjectId;

  // ── Navigation state ──
  private currentView: 'kindList' | 'instanceList' | 'detail' = 'kindList';
  private selectedKindName?: string;
  private kindInstances: ObjectRegistration[] = [];

  // ── Kind List View widget tracking ──
  private kindButtons: Map<AbjectId, string> = new Map();  // btnId → kind name
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
    this.abjectEditorId = await this.discoverDep('AbjectEditor') ?? undefined;

    if (this.registryId) {
      await this.request(request(this.id, this.registryId,
        'abjects:registry' as InterfaceId, 'subscribe', {}));
    }
  }

  /**
   * List objects from registry via message passing.
   */
  private async registryList(): Promise<ObjectRegistration[]> {
    if (!this.registryId) return [];
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'list', {})
    );
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
   * Group cachedObjects by manifest.name.
   * Returns a map of kindName → array of ObjectRegistration.
   */
  private groupByKind(): Map<string, ObjectRegistration[]> {
    const groups = new Map<string, ObjectRegistration[]>();
    for (const obj of this.cachedObjects) {
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

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click' && aspect !== 'submit' && aspect !== 'change') return;
      const fromId = msg.routing.from;
      await this.handleWidgetEvent(fromId, aspect, value);
    });

    this.on('objectRegistered', async () => {
      this.cachedObjects = await this.registryList();
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
    this.cachedObjects = await this.registryList();
    await this.showKindListView();
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
    this.kindInstances = [];
    this.clearViewTracking();
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

    if (!this.windowId) {
      const displayInfo = await this.request<{ width: number; height: number }>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
      );

      const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
      const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

      this.windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
          title: 'Registry Browser',
          rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
          zIndex: 200,
          resizable: true,
        })
      );
    } else {
      await this.request(
        request(this.id, this.windowId, WINDOW_INTERFACE, 'setTitle', {
          title: 'Registry Browser',
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
   */
  private async rebuildKindButtons(): Promise<void> {
    if (!this.scrollableListId) return;

    // Destroy existing buttons
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

    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const query = this.searchText.toLowerCase();
    const groups = this.groupByKind();

    // Sort kind names alphabetically
    const sortedNames = Array.from(groups.keys()).sort();

    for (const kindName of sortedNames) {
      const instances = groups.get(kindName)!;
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
  }

  // ═══════════════════════════════════════════════════════════════════
  // Instance List View
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show the instance list view for a given kind name.
   */
  private async showInstanceListView(kindName: string): Promise<void> {
    this.currentView = 'instanceList';
    this.selectedKindName = kindName;
    this.searchText = '';

    // Compute instances of this kind from cachedObjects
    this.kindInstances = this.cachedObjects.filter(o => o.manifest.name === kindName);

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

      // Clone button
      if (this.factoryId) {
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

        // Delete button
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
    const obj = this.cachedObjects[index];
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

    await addLabel(`Name: ${obj.manifest.name}`, { color: '#e2e4e9' });
    await addLabel(`Version: ${obj.manifest.version}`, { color: '#e2e4e9' });

    const desc = obj.manifest.description;
    await addLabel(`Description: ${desc.length > 60 ? desc.slice(0, 60) + '...' : desc}`);

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

    // ── Send Message section ──
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

    // Show "Edit Source" button if the object is scriptable
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

    // Clone button (always available if factory exists)
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

    // Right spacer in bottom row
    await this.request(request(this.id, bottomRowId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));
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
        // Detail → Instance List
        this.cachedObjects = await this.registryList();
        await this.showInstanceListView(this.selectedKindName);
      } else {
        // Instance List → Kind List (or detail without kind → kind list)
        this.cachedObjects = await this.registryList();
        await this.showKindListView();
      }
      return;
    }

    // ── Edit Source button in detail view ──
    if (fromId === this.editSourceBtnId && this.detailIndex !== undefined) {
      const obj = this.cachedObjects[this.detailIndex];
      if (obj && this.abjectEditorId) {
        await this.request(request(this.id, this.abjectEditorId,
          'abjects:abject-editor' as InterfaceId, 'show', { objectId: obj.id }));
      }
      return;
    }

    // ── Delete button in detail view ──
    if (fromId === this.deleteBtnId && this.detailObjectId && this.factoryId) {
      try {
        await this.request(request(this.id, this.factoryId,
          FACTORY_INTERFACE, 'kill', { objectId: this.detailObjectId }));
      } catch { /* object may already be gone */ }
      this.cachedObjects = await this.registryList();
      if (this.selectedKindName) {
        await this.showInstanceListView(this.selectedKindName);
      } else {
        await this.showKindListView();
      }
      return;
    }

    // ── Clone button in detail view ──
    if (fromId === this.cloneBtnId && this.detailObjectId && this.factoryId) {
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
      await this.showInstanceListView(kindName);
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
        // Find the global index in cachedObjects
        const globalIndex = this.cachedObjects.findIndex(o => o.id === inst.id);
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
   * Delete an object via Factory, refresh caches, and refresh the current view.
   */
  private async deleteObject(objectId: AbjectId): Promise<void> {
    if (!this.factoryId) return;

    try {
      await this.request(request(this.id, this.factoryId,
        FACTORY_INTERFACE, 'kill', { objectId }));
    } catch { /* object may already be gone */ }

    this.cachedObjects = await this.registryList();
    if (this.currentView === 'instanceList' && this.selectedKindName) {
      // Check if any instances of this kind remain
      const remaining = this.cachedObjects.filter(o => o.manifest.name === this.selectedKindName);
      if (remaining.length === 0) {
        await this.showKindListView();
      } else {
        await this.showInstanceListView(this.selectedKindName);
      }
    }
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
  }
}

export const REGISTRY_BROWSER_ID = 'abjects:registry-browser' as AbjectId;
