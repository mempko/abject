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
import { Log } from '../core/timed-log.js';
import type { DiscoveredWorkspace } from './workspace-share-registry.js';

const log = new Log('WorkspaceBrowser');

const WORKSPACE_BROWSER_INTERFACE: InterfaceId = 'abjects:workspace-browser';
const WORKSPACE_SHARE_REGISTRY_INTERFACE: InterfaceId = 'abjects:workspace-share-registry';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';

export class WorkspaceBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private shareRegistryId?: AbjectId;
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

      // Browse button click — open ObjectBrowser scoped to remote workspace
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

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    // Header row: title + refresh button (nested HBox)
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    // Two ScrollableVBox containers (one per tab)
    for (let i = 0; i < 2; i++) {
      const scrollId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedVBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: 6,
        })
      );
      this.tabContents.push(scrollId);
    }

    // Batch create all non-layout widgets: titleLabel, refreshBtn, tabBar, searchInput, statusLabel
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'label',
            windowId: this.windowId,
            text: 'Workspace Browser',
            style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
          },
          {
            type: 'button',
            windowId: this.windowId,
            text: 'Refresh',
            style: { fontSize: 12 },
          },
          {
            type: 'tabBar',
            windowId: this.windowId,
            tabs: ['Public', 'Private'],
            selectedIndex: this.activeTab,
          },
          {
            type: 'textInput',
            windowId: this.windowId,
            placeholder: 'Search by name, description, or tags...',
            text: '',
          },
          {
            type: 'label',
            windowId: this.windowId,
            text: '',
            style: { color: '#6b7084', fontSize: 11 },
          },
        ],
      })
    );

    const [titleLabelId, refreshBtnId, tabBarId, searchInputId, statusLabelId] = widgetIds;
    this.refreshBtnId = refreshBtnId;
    this.tabBarId = tabBarId;
    this.searchInputId = searchInputId;
    this.statusLabelId = statusLabelId;

    // Fire-and-forget addDependent for interactive widgets
    this.send(request(this.id, this.refreshBtnId, 'addDependent', {}));
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.searchInputId, 'addDependent', {}));

    // Batch add headerRow children: titleLabel (expanding), refreshBtn (fixed)
    await this.request(
      request(this.id, headerRowId, 'addLayoutChildren', {
        children: [
          {
            widgetId: titleLabelId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 30 },
          },
          {
            widgetId: this.refreshBtnId,
            sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
            preferredSize: { width: 80, height: 28 },
          },
        ],
      })
    );

    // Batch add rootLayout children: headerRow, tabBar, searchInput, scroll containers, statusLabel
    await this.request(
      request(this.id, this.rootLayoutId, 'addLayoutChildren', {
        children: [
          {
            widgetId: headerRowId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 30 },
          },
          {
            widgetId: this.tabBarId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 32 },
          },
          {
            widgetId: this.searchInputId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 32 },
          },
          {
            widgetId: this.tabContents[0],
            sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
          },
          {
            widgetId: this.tabContents[1],
            sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
          },
          {
            widgetId: this.statusLabelId,
            sizePolicy: { vertical: 'fixed' },
            preferredSize: { height: 16 },
          },
        ],
      })
    );

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

    await this.changed('visibility', true);
    return true;
  }

  /**
   * Build (or rebuild) the workspace list inside both tab containers.
   */
  private async buildWorkspaceList(): Promise<void> {
    // Clear existing tab content widgets (fire-and-forget destroy)
    for (const widgetId of this.tabContentWidgetIds) {
      this.send(request(this.id, widgetId, 'destroy', {}));
    }
    this.tabContentWidgetIds = [];
    this.browseButtons.clear();

    // Clear children from both tab containers (can run in parallel)
    await Promise.all(
      this.tabContents.map(containerId =>
        this.request(request(this.id, containerId, 'clearLayoutChildren', {})).catch(() => { /* best effort */ })
      )
    );

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

        const { widgetIds: [emptyId] } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', {
            specs: [
              {
                type: 'label',
                windowId: this.windowId,
                text: emptyText,
                style: { color: '#b4b8c8', fontSize: 12 },
              },
            ],
          })
        );
        this.tabContentWidgetIds.push(emptyId);
        await this.request(
          request(this.id, containerId, 'addLayoutChildren', {
            children: [
              {
                widgetId: emptyId,
                sizePolicy: { vertical: 'fixed' },
                preferredSize: { height: 24 },
              },
            ],
          })
        );
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

        // Collect all widget specs for this peer group
        // First pass: create HBox rows (layouts) for each workspace entry
        const wsRowIds: AbjectId[] = [];
        for (const ws of peerWorkspaces) {
          const wsRowId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, 'createNestedHBox', {
              parentLayoutId: containerId,
              margins: { top: 0, right: 0, bottom: 0, left: 0 },
              spacing: 6,
            })
          );
          wsRowIds.push(wsRowId);
          this.tabContentWidgetIds.push(wsRowId);
        }

        // Second pass: collect all non-layout widget specs for batch creation
        type WidgetSpec = {
          type: string;
          windowId: AbjectId;
          text?: string;
          style?: Record<string, unknown>;
          placeholder?: string;
        };

        const allSpecs: WidgetSpec[] = [];

        // Peer header label
        allSpecs.push({
          type: 'label',
          windowId: this.windowId!,
          text: peerName,
          style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
        });

        // Per-workspace widgets
        // We need to track which specs belong to which workspace/layout
        // Structure: for each workspace, we push [wsNameLabel, (optional browseBtnSpec), (optional descLabel), (optional metaLabel)]
        type WsWidgetGroup = {
          ws: DiscoveredWorkspace;
          wsRowId: AbjectId;
          specIndices: {
            nameIdx: number;
            browseIdx?: number;
            descIdx?: number;
            metaIdx?: number;
          };
        };
        const wsGroups: WsWidgetGroup[] = [];

        // peerHeaderIdx = 0 (already pushed above)
        const peerHeaderIdx = 0;

        for (let wi = 0; wi < peerWorkspaces.length; wi++) {
          const ws = peerWorkspaces[wi];

          const nameIdx = allSpecs.length;
          allSpecs.push({
            type: 'label',
            windowId: this.windowId!,
            text: `  ${ws.name}`,
            style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 12 },
          });

          let browseIdx: number | undefined;
          if (ws.registryId) {
            browseIdx = allSpecs.length;
            allSpecs.push({
              type: 'button',
              windowId: this.windowId!,
              text: 'Browse',
              style: { fontSize: 11 },
            });
          }

          let descIdx: number | undefined;
          const desc = ws.description ?? '';
          if (desc) {
            const truncDesc = desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
            descIdx = allSpecs.length;
            allSpecs.push({
              type: 'label',
              windowId: this.windowId!,
              text: `  ${truncDesc}`,
              style: { color: '#8b8fa3', fontSize: 11 },
            });
          }

          let metaIdx: number | undefined;
          const tags = ws.tags ?? [];
          const hopsLabel = ws.hops > 0 ? `${ws.hops} hop${ws.hops > 1 ? 's' : ''}` : '';
          const tagsStr = tags.join(' \u00b7 ');
          const metaText = [tagsStr, hopsLabel].filter(Boolean).join('    ');
          if (metaText) {
            metaIdx = allSpecs.length;
            allSpecs.push({
              type: 'label',
              windowId: this.windowId!,
              text: `  ${metaText}`,
              style: { color: '#6b7084', fontSize: 11 },
            });
          }

          wsGroups.push({
            ws,
            wsRowId: wsRowIds[wi],
            specIndices: { nameIdx, browseIdx, descIdx, metaIdx },
          });
        }

        // Batch create all widgets for this peer group
        const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
          request(this.id, this.widgetManagerId!, 'create', { specs: allSpecs })
        );

        const peerHeaderId = widgetIds[peerHeaderIdx];
        this.tabContentWidgetIds.push(peerHeaderId);

        // Batch add peer header to container
        await this.request(
          request(this.id, containerId, 'addLayoutChildren', {
            children: [
              {
                widgetId: peerHeaderId,
                sizePolicy: { vertical: 'fixed' },
                preferredSize: { height: 22 },
              },
            ],
          })
        );

        // For each workspace: add wsRow to container, then add wsRow children, then add desc/meta to container
        for (const group of wsGroups) {
          const { ws, wsRowId, specIndices } = group;

          // Add wsRow to container
          await this.request(
            request(this.id, containerId, 'addLayoutChildren', {
              children: [
                {
                  widgetId: wsRowId,
                  sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
                  preferredSize: { height: 24 },
                },
              ],
            })
          );

          // Batch add wsRow children (name label + optional browse button)
          const wsRowChildren: Array<{
            widgetId: AbjectId;
            sizePolicy?: { horizontal?: string; vertical?: string };
            preferredSize?: { width?: number; height?: number };
          }> = [];

          const wsNameId = widgetIds[specIndices.nameIdx];
          this.tabContentWidgetIds.push(wsNameId);
          wsRowChildren.push({
            widgetId: wsNameId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 24 },
          });

          if (specIndices.browseIdx !== undefined) {
            const browseBtnId = widgetIds[specIndices.browseIdx];
            this.tabContentWidgetIds.push(browseBtnId);
            // Fire-and-forget addDependent for browse button
            this.send(request(this.id, browseBtnId, 'addDependent', {}));
            this.browseButtons.set(browseBtnId, ws);
            wsRowChildren.push({
              widgetId: browseBtnId,
              sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
              preferredSize: { width: 70, height: 24 },
            });
          }

          await this.request(
            request(this.id, wsRowId, 'addLayoutChildren', { children: wsRowChildren })
          );

          // Add optional desc/meta labels directly to container (batch if both present)
          const containerChildren: Array<{
            widgetId: AbjectId;
            sizePolicy?: { vertical?: string };
            preferredSize?: { height?: number };
          }> = [];

          if (specIndices.descIdx !== undefined) {
            const descId = widgetIds[specIndices.descIdx];
            this.tabContentWidgetIds.push(descId);
            containerChildren.push({
              widgetId: descId,
              sizePolicy: { vertical: 'fixed' },
              preferredSize: { height: 18 },
            });
          }

          if (specIndices.metaIdx !== undefined) {
            const metaId = widgetIds[specIndices.metaIdx];
            this.tabContentWidgetIds.push(metaId);
            containerChildren.push({
              widgetId: metaId,
              sizePolicy: { vertical: 'fixed' },
              preferredSize: { height: 16 },
            });
          }

          if (containerChildren.length > 0) {
            await this.request(
              request(this.id, containerId, 'addLayoutChildren', { children: containerChildren })
            );
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
    log.info('refresh — calling discoverWorkspaces');
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

    log.info('discovery done, rebuilding UI');
    if (this.windowId) {
      await this.rebuildWorkspaceList();
    } else {
      await this.show();
    }
    return true;
  }

  /**
   * Open AppExplorer in remote mode for the given workspace.
   */
  private async openRemoteBrowser(ws: DiscoveredWorkspace): Promise<void> {
    if (!ws.registryId) return;

    try {
      // Resolve the current registryId from PeerRouter's workspace route.
      // The cached discoveredWorkspace may have a stale registryId if the
      // remote peer restarted (all UUIDs change on restart).
      let registryId = ws.registryId;
      const peerRouterId = await this.discoverDep('PeerRouter');
      if (peerRouterId) {
        const resolved = await this.request<string | null>(
          request(this.id, peerRouterId, 'resolveWorkspaceRegistry', {
            ownerPeerId: ws.ownerPeerId,
            workspaceId: ws.workspaceId,
          })
        );
        if (resolved) {
          registryId = resolved;
        }
      }

      const factoryId = await this.discoverDep('Factory');
      if (!factoryId) return;

      const result = await this.request<SpawnResult>(
        request(this.id, factoryId, 'spawn', {
          manifest: {
            name: 'AppExplorer',
            description: '',
            version: '1.0.0',
            requiredCapabilities: [],
            tags: ['system'],
          },
        })
      );

      await this.request(
        request(this.id, result.objectId, 'browseRemote', {
          registryId,
          peerId: ws.ownerPeerId,
          label: `${ws.name} (${ws.ownerName || ws.ownerPeerId.slice(0, 8)})`,
        })
      );
    } catch (err) {
      log.warn('Failed to open remote browser:', err);
    }
  }
}

export const WORKSPACE_BROWSER_ID = 'abjects:workspace-browser' as AbjectId;
