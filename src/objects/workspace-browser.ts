/**
 * WorkspaceBrowser — global UI for browsing discovered remote workspaces.
 *
 * Shows shared workspaces from connected peers, grouped by peer name,
 * with Public/Private tabs, search filtering, and description/tags display.
 */

import { AbjectId, AbjectMessage, InterfaceId, SpawnResult } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { DiscoveredWorkspace } from './workspace-share-registry.js';

const WORKSPACE_BROWSER_INTERFACE: InterfaceId = 'abjects:workspace-browser';
const WORKSPACE_SHARE_REGISTRY_INTERFACE: InterfaceId = 'abjects:workspace-share-registry';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const FACTORY_INTERFACE: InterfaceId = 'abjects:factory';
const REGISTRY_BROWSER_INTERFACE: InterfaceId = 'abjects:registry-browser';

export class WorkspaceBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private shareRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private refreshBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private browseButtons: Map<AbjectId, DiscoveredWorkspace> = new Map();

  // Tab & search state
  private searchInputId?: AbjectId;
  private tabBarId?: AbjectId;
  private tabContents: AbjectId[] = []; // [publicScrollBox, privateScrollBox]
  private activeTab: number = 0; // 0=public, 1=private

  /** All widget IDs created inside tab content containers, for cleanup on rebuild. */
  private tabContentWidgetIds: AbjectId[] = [];

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceBrowser',
        description:
          'Browse discovered remote workspaces from connected peers.',
        version: '1.0.0',
        interface: {
            id: WORKSPACE_BROWSER_INTERFACE,
            name: 'WorkspaceBrowser',
            description: 'Remote workspace browser UI',
            methods: [
              {
                name: 'show',
                description: 'Show the workspace browser window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the workspace browser window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'refresh',
                description: 'Refresh workspace discovery and rebuild the UI',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display workspace browser', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'peer'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    this.factoryId = await this.discoverDep('Factory') ?? undefined;

    // Subscribe to WSR events for auto-refresh on new discoveries
    if (this.shareRegistryId) {
      try {
        await this.request(
          request(this.id, this.shareRegistryId, 'addDependent', {})
        );
      } catch { /* WSR may not be ready */ }
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('refresh', async () => {
      return this.refresh();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.refreshBtnId && aspect === 'click') {
        await this.refresh();
        return;
      }

      // Tab bar change — switch tab visibility
      if (fromId === this.tabBarId && aspect === 'change') {
        const idx = value as number;
        this.activeTab = idx;
        await this.switchTabVisibility();
        return;
      }

      // Search input submit — rebuild workspace list
      if (fromId === this.searchInputId && aspect === 'submit') {
        await this.rebuildWorkspaceList();
        return;
      }

      // WSR: new workspaces discovered — auto-refresh if visible
      if (fromId === this.shareRegistryId && aspect === 'workspacesDiscovered') {
        if (this.windowId) {
          await this.rebuildWorkspaceList();
        }
        return;
      }

      // Browse button click — open remote RegistryBrowser
      const ws = this.browseButtons.get(fromId);
      if (ws && aspect === 'click') {
        await this.openRemoteBrowser(ws);
      }
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    if (!this.shareRegistryId) {
      this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winW = 460;
    const winH = 520;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Workspace Browser',
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

    // Header row: title + refresh button
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const titleLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Workspace Browser',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    );
    await this.request(request(this.id, headerRowId, 'addLayoutChild', {
      widgetId: titleLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.refreshBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Refresh',
        style: { fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.refreshBtnId, 'addDependent', {}));
    await this.request(request(this.id, headerRowId, 'addLayoutChild', {
      widgetId: this.refreshBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 80, height: 28 },
    }));

    // Tab bar: Public / Private
    this.tabBarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTabBar', {
        windowId: this.windowId, rect: r0,
        tabs: ['Public', 'Private'],
        selectedIndex: this.activeTab,
      })
    );
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Search input
    this.searchInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createTextInput', {
        windowId: this.windowId, rect: r0,
        placeholder: 'Search by name, description, or tags...',
        text: '',
      })
    );
    await this.request(request(this.id, this.searchInputId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.searchInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Two ScrollableVBox containers (one per tab)
    for (let i = 0; i < 2; i++) {
      const scrollId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedVBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 6,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
        widgetId: scrollId,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
      this.tabContents.push(scrollId);
    }

    // Build workspace list content (from cache)
    await this.buildWorkspaceList();

    // Show only the active tab
    await this.switchTabVisibility();

    // Kick off background discovery to refresh stale cache
    if (this.shareRegistryId) {
      this.request(
        request(this.id, this.shareRegistryId, 'discoverWorkspaces', { hops: 1 })
      ).catch(() => { /* best-effort background refresh */ });
    }

    // Spacer + status
    this.statusLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createLabel', {
        windowId: this.windowId, rect: r0,
        text: '',
        style: { color: '#6b7084', fontSize: 11 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 16 },
    }));

    await this.changed('visibility', true);
    return true;
  }

  /**
   * Build (or rebuild) the workspace list inside both tab containers.
   */
  private async buildWorkspaceList(): Promise<void> {
    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Clear existing tab content widgets
    for (const widgetId of this.tabContentWidgetIds) {
      try { await this.request(request(this.id, widgetId, 'destroy', {})); }
      catch { /* gone */ }
    }
    this.tabContentWidgetIds = [];
    this.browseButtons.clear();

    // Remove children from both tab containers
    for (const containerId of this.tabContents) {
      try { await this.request(request(this.id, containerId, 'clearLayoutChildren', {})); }
      catch { /* best effort */ }
    }

    // Fetch discovered workspaces
    let workspaces: DiscoveredWorkspace[] = [];
    if (this.shareRegistryId) {
      try {
        workspaces = await this.request<DiscoveredWorkspace[]>(
          request(this.id, this.shareRegistryId, 'getDiscoveredWorkspaces', {})
        );
      } catch { /* ShareRegistry may not be ready */ }
    }

    // Get search filter
    let searchFilter = '';
    if (this.searchInputId) {
      try {
        searchFilter = (await this.request<string>(
          request(this.id, this.searchInputId, 'getValue', {})
        ) ?? '').trim().toLowerCase();
      } catch { /* input not ready */ }
    }

    // Filter and split by access mode
    const publicWs: DiscoveredWorkspace[] = [];
    const privateWs: DiscoveredWorkspace[] = [];

    for (const ws of workspaces) {
      // Apply search filter
      if (searchFilter) {
        const nameMatch = ws.name.toLowerCase().includes(searchFilter);
        const descMatch = (ws.description ?? '').toLowerCase().includes(searchFilter);
        const tagMatch = (ws.tags ?? []).some(t => t.toLowerCase().includes(searchFilter));
        if (!nameMatch && !descMatch && !tagMatch) continue;
      }

      if (ws.accessMode === 'public') {
        publicWs.push(ws);
      } else if (ws.accessMode === 'private') {
        privateWs.push(ws);
      }
    }

    // Build each tab
    const tabData = [publicWs, privateWs];
    for (let tabIdx = 0; tabIdx < 2; tabIdx++) {
      const containerId = this.tabContents[tabIdx];
      const tabWorkspaces = tabData[tabIdx];

      if (tabWorkspaces.length === 0) {
        const emptyText = tabIdx === 0
          ? 'No public workspaces discovered yet.'
          : 'No private workspaces available.';
        const emptyId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createLabel', {
            windowId: this.windowId, rect: r0,
            text: emptyText,
            style: { color: '#b4b8c8', fontSize: 12 },
          })
        );
        this.tabContentWidgetIds.push(emptyId);
        await this.request(request(this.id, containerId, 'addLayoutChild', {
          widgetId: emptyId,
          sizePolicy: { vertical: 'fixed' },
          preferredSize: { height: 24 },
        }));
        continue;
      }

      // Group by peer
      const byPeer = new Map<string, DiscoveredWorkspace[]>();
      for (const ws of tabWorkspaces) {
        const key = ws.ownerPeerId;
        if (!byPeer.has(key)) byPeer.set(key, []);
        byPeer.get(key)!.push(ws);
      }

      for (const [peerId, peerWorkspaces] of byPeer) {
        const peerName = peerWorkspaces[0]?.ownerName || peerId.slice(0, 16) + '...';

        // Peer header
        const peerHeaderId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, 'createLabel', {
            windowId: this.windowId, rect: r0, text: peerName,
            style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
          })
        );
        this.tabContentWidgetIds.push(peerHeaderId);
        await this.request(request(this.id, containerId, 'addLayoutChild', {
          widgetId: peerHeaderId,
          sizePolicy: { vertical: 'fixed' },
          preferredSize: { height: 22 },
        }));

        // Workspace entries
        for (const ws of peerWorkspaces) {
          // Row 1: Name + Browse button
          const wsRowId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, 'createNestedHBox', {
              parentLayoutId: containerId,
              margins: { top: 0, right: 0, bottom: 0, left: 0 },
              spacing: 6,
            })
          );
          this.tabContentWidgetIds.push(wsRowId);
          await this.request(request(this.id, containerId, 'addLayoutChild', {
            widgetId: wsRowId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 24 },
          }));

          const wsNameId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, 'createLabel', {
              windowId: this.windowId, rect: r0,
              text: `  ${ws.name}`,
              style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 12 },
            })
          );
          this.tabContentWidgetIds.push(wsNameId);
          await this.request(request(this.id, wsRowId, 'addLayoutChild', {
            widgetId: wsNameId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 24 },
          }));

          // Browse button
          if (ws.registryId) {
            const browseBtnId = await this.request<AbjectId>(
              request(this.id, this.widgetManagerId!, 'createButton', {
                windowId: this.windowId, rect: r0, text: 'Browse',
                style: { fontSize: 11 },
              })
            );
            this.tabContentWidgetIds.push(browseBtnId);
            await this.request(request(this.id, browseBtnId, 'addDependent', {}));
            this.browseButtons.set(browseBtnId, ws);
            await this.request(request(this.id, wsRowId, 'addLayoutChild', {
              widgetId: browseBtnId,
              sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
              preferredSize: { width: 70, height: 24 },
            }));
          }

          // Row 2: Description (if present)
          const desc = ws.description ?? '';
          if (desc) {
            const truncDesc = desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
            const descId = await this.request<AbjectId>(
              request(this.id, this.widgetManagerId!, 'createLabel', {
                windowId: this.windowId, rect: r0,
                text: `  ${truncDesc}`,
                style: { color: '#8b8fa3', fontSize: 11 },
              })
            );
            this.tabContentWidgetIds.push(descId);
            await this.request(request(this.id, containerId, 'addLayoutChild', {
              widgetId: descId,
              sizePolicy: { vertical: 'fixed' },
              preferredSize: { height: 18 },
            }));
          }

          // Row 3: Tags + hop count
          const tags = ws.tags ?? [];
          const hopsLabel = ws.hops > 0 ? `${ws.hops} hop${ws.hops > 1 ? 's' : ''}` : '';
          const tagsStr = tags.join(' \u00b7 ');
          const metaText = [tagsStr, hopsLabel].filter(Boolean).join('    ');
          if (metaText) {
            const metaId = await this.request<AbjectId>(
              request(this.id, this.widgetManagerId!, 'createLabel', {
                windowId: this.windowId, rect: r0,
                text: `  ${metaText}`,
                style: { color: '#6b7084', fontSize: 11 },
              })
            );
            this.tabContentWidgetIds.push(metaId);
            await this.request(request(this.id, containerId, 'addLayoutChild', {
              widgetId: metaId,
              sizePolicy: { vertical: 'fixed' },
              preferredSize: { height: 16 },
            }));
          }
        }
      }
    }

    // Update status with staleness indicator
    const totalCount = publicWs.length + privateWs.length;
    if (this.statusLabelId) {
      let statusText = `${totalCount} workspace${totalCount !== 1 ? 's' : ''} discovered`;

      // Check staleness of newest discovery
      const allWs = [...publicWs, ...privateWs];
      if (allWs.length > 0) {
        const newestAt = Math.max(...allWs.map(w => w.discoveredAt));
        const ageSec = Math.floor((Date.now() - newestAt) / 1000);
        if (ageSec > 60) {
          const ageMin = Math.floor(ageSec / 60);
          statusText += ` · Last updated ${ageMin}m ago`;
        }
      }

      try {
        await this.request(request(this.id, this.statusLabelId, 'update', {
          text: statusText,
        }));
      } catch { /* widget gone */ }
    }
  }

  /**
   * Rebuild workspace list (called on search or discovery events).
   */
  private async rebuildWorkspaceList(): Promise<void> {
    await this.buildWorkspaceList();
    await this.switchTabVisibility();
  }

  /**
   * Show/hide the tab content containers based on activeTab.
   */
  private async switchTabVisibility(): Promise<void> {
    for (let i = 0; i < this.tabContents.length; i++) {
      try {
        await this.request(request(this.id, this.tabContents[i], 'update', {
          style: { visible: i === this.activeTab },
        }));
      } catch { /* container gone */ }
    }
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
    this.refreshBtnId = undefined;
    this.statusLabelId = undefined;
    this.searchInputId = undefined;
    this.tabBarId = undefined;
    this.tabContents = [];
    this.tabContentWidgetIds = [];
    this.browseButtons.clear();

    await this.changed('visibility', false);
    return true;
  }

  async refresh(): Promise<boolean> {
    console.log('[WorkspaceBrowser] refresh — calling discoverWorkspaces');
    if (!this.shareRegistryId) {
      this.shareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }

    // Trigger discovery
    if (this.shareRegistryId) {
      try {
        await this.request(
          request(this.id, this.shareRegistryId, 'discoverWorkspaces', { hops: 1 })
        );
      } catch { /* best-effort */ }
    }

    console.log('[WorkspaceBrowser] discovery done, rebuilding UI');
    if (this.windowId) {
      await this.rebuildWorkspaceList();
    } else {
      await this.show();
    }
    return true;
  }

  /**
   * Spawn a RegistryBrowser, configure it for remote mode, and show it.
   */
  private async openRemoteBrowser(ws: DiscoveredWorkspace): Promise<void> {
    if (!this.factoryId) {
      this.factoryId = await this.discoverDep('Factory') ?? undefined;
    }
    if (!this.factoryId || !ws.registryId) return;

    try {
      const result = await this.request<SpawnResult>(
        request(this.id, this.factoryId, 'spawn', {
          manifest: {
            name: 'RegistryBrowser', description: '', version: '1.0.0',
            requiredCapabilities: [], tags: ['system'],
          },
        })
      );

      const browserId = result.objectId;

      // Configure for remote mode
      await this.request(
        request(this.id, browserId, 'browseRemote', {
          registryId: ws.registryId,
          peerId: ws.ownerPeerId,
          label: ws.name,
        })
      );

      // Show the browser
      await this.request(
        request(this.id, browserId, 'show', {})
      );
    } catch (err) {
      console.warn('[WorkspaceBrowser] Failed to open remote browser:', err);
    }
  }
}

export const WORKSPACE_BROWSER_ID = 'abjects:workspace-browser' as AbjectId;
