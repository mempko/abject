/**
 * WorkspaceBrowser — global UI for browsing discovered remote workspaces.
 *
 * Shows shared workspaces from connected peers, grouped by peer name,
 * with a refresh button to trigger new discovery.
 */

import { AbjectId, AbjectMessage, InterfaceId, SpawnResult } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
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

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceBrowser',
        description:
          'Browse discovered remote workspaces from connected peers.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
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
      const { aspect } = msg.payload as { aspect: string };
      const fromId = msg.routing.from;

      if (fromId === this.refreshBtnId && aspect === 'click') {
        await this.refresh();
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
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winW = 400;
    const winH = 420;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Workspace Browser',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
        spacing: 8,
      })
    );

    // Header row: title + refresh button
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const titleLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Remote Workspaces',
        style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 15 },
      })
    );
    await this.request(request(this.id, headerRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: titleLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    this.refreshBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId, rect: r0, text: 'Refresh',
        style: { fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.refreshBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, headerRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.refreshBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 80, height: 28 },
    }));

    // Description
    const descId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0, text: 'Shared workspaces from connected peers.',
        style: { color: '#b4b8c8', fontSize: 12 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: descId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Divider
    const divId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createDivider', {
        windowId: this.windowId, rect: r0,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: divId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 1 },
    }));

    // Get discovered workspaces
    let workspaces: DiscoveredWorkspace[] = [];
    if (this.shareRegistryId) {
      try {
        workspaces = await this.request<DiscoveredWorkspace[]>(
          request(this.id, this.shareRegistryId, WORKSPACE_SHARE_REGISTRY_INTERFACE, 'getDiscoveredWorkspaces', {})
        );
      } catch { /* ShareRegistry may not be ready */ }
    }

    console.log(`[WorkspaceBrowser] show — got ${workspaces.length} discovered workspaces`);
    if (workspaces.length > 0) console.log('[WorkspaceBrowser] workspaces:', workspaces.map(w => w.name));

    if (workspaces.length === 0) {
      const emptyId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
          windowId: this.windowId, rect: r0,
          text: 'No remote workspaces discovered yet.\nConnect to peers and click Refresh.',
          style: { color: '#b4b8c8', fontSize: 12 },
        })
      );
      await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
        widgetId: emptyId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 36 },
      }));
    } else {
      // Group by peer
      const byPeer = new Map<string, DiscoveredWorkspace[]>();
      for (const ws of workspaces) {
        const key = ws.ownerPeerId;
        if (!byPeer.has(key)) byPeer.set(key, []);
        byPeer.get(key)!.push(ws);
      }

      for (const [peerId, peerWorkspaces] of byPeer) {
        const peerName = peerWorkspaces[0]?.ownerName || peerId.slice(0, 16) + '...';

        // Peer header
        const peerHeaderId = await this.request<AbjectId>(
          request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
            windowId: this.windowId, rect: r0, text: peerName,
            style: { color: '#e2e4e9', fontWeight: 'bold', fontSize: 13 },
          })
        );
        await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
          widgetId: peerHeaderId,
          sizePolicy: { vertical: 'fixed' },
          preferredSize: { height: 22 },
        }));

        // Workspace entries
        for (const ws of peerWorkspaces) {
          const badge = ws.accessMode === 'public' ? ' [public]' : ' [private]';
          const hopsLabel = ws.hops > 0 ? ` (${ws.hops} hop${ws.hops > 1 ? 's' : ''})` : '';

          // HBox: label (expanding) + Browse button (fixed)
          const wsRowId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
              parentLayoutId: this.rootLayoutId,
              margins: { top: 0, right: 0, bottom: 0, left: 0 },
              spacing: 6,
            })
          );
          await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
            widgetId: wsRowId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 24 },
          }));

          const wsLabelId = await this.request<AbjectId>(
            request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
              windowId: this.windowId, rect: r0,
              text: `  ${ws.name}${badge}${hopsLabel}`,
              style: { color: '#b4b8c8', fontSize: 12 },
            })
          );
          await this.request(request(this.id, wsRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
            widgetId: wsLabelId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: 24 },
          }));

          // Browse button (only if registryId is available)
          if (ws.registryId) {
            const browseBtnId = await this.request<AbjectId>(
              request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
                windowId: this.windowId, rect: r0, text: 'Browse',
                style: { fontSize: 11 },
              })
            );
            await this.request(request(this.id, browseBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
            this.browseButtons.set(browseBtnId, ws);
            await this.request(request(this.id, wsRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
              widgetId: browseBtnId,
              sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
              preferredSize: { width: 70, height: 24 },
            }));
          }
        }
      }
    }

    // Spacer + status
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutSpacer', {}));

    this.statusLabelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId, rect: r0,
        text: `${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''} discovered`,
        style: { color: '#6b7084', fontSize: 11 },
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 16 },
    }));

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
    this.rootLayoutId = undefined;
    this.refreshBtnId = undefined;
    this.statusLabelId = undefined;
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
          request(this.id, this.shareRegistryId, WORKSPACE_SHARE_REGISTRY_INTERFACE, 'discoverWorkspaces', { hops: 1 })
        );
      } catch { /* best-effort */ }
    }

    console.log('[WorkspaceBrowser] discovery done, rebuilding UI');
    // Rebuild UI
    await this.hide();
    await this.show();
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
        request(this.id, this.factoryId, FACTORY_INTERFACE, 'spawn', {
          manifest: {
            name: 'RegistryBrowser', description: '', version: '1.0.0',
            interfaces: [], requiredCapabilities: [], tags: ['system'],
          },
        })
      );

      const browserId = result.objectId;

      // Configure for remote mode
      await this.request(
        request(this.id, browserId, REGISTRY_BROWSER_INTERFACE, 'browseRemote', {
          registryId: ws.registryId,
          peerId: ws.ownerPeerId,
          label: ws.name,
        })
      );

      // Show the browser
      await this.request(
        request(this.id, browserId, REGISTRY_BROWSER_INTERFACE, 'show', {})
      );
    } catch (err) {
      console.warn('[WorkspaceBrowser] Failed to open remote browser:', err);
    }
  }
}

export const WORKSPACE_BROWSER_ID = 'abjects:workspace-browser' as AbjectId;
