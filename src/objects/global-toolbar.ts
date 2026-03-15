/**
 * GlobalToolbar — persistent chromeless panel positioned below WorkspaceSwitcher.
 *
 * Provides quick-access buttons for GlobalSettings (API Keys) and
 * PeerNetwork (identity, signaling, contacts).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('GlobalToolbar');

const GLOBAL_TOOLBAR_INTERFACE: InterfaceId = 'abjects:global-toolbar';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const GLOBAL_SETTINGS_INTERFACE: InterfaceId = 'abjects:global-settings';
const PEER_NETWORK_INTERFACE: InterfaceId = 'abjects:peer-network';

export class GlobalToolbar extends Abject {
  private widgetManagerId?: AbjectId;
  private globalSettingsId?: AbjectId;
  private peerNetworkId?: AbjectId;
  private objectBrowserId?: AbjectId;

  private objectManagerId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private settingsBtnId?: AbjectId;
  private networkBtnId?: AbjectId;
  private explorerBtnId?: AbjectId;
  private processesBtnId?: AbjectId;

  /** Current window height (queried by WorkspaceManager for Taskbar positioning) */
  private currentHeight = 0;

  constructor() {
    super({
      manifest: {
        name: 'GlobalToolbar',
        description:
          'Persistent toolbar panel with quick-access buttons for system settings and peer network.',
        version: '1.0.0',
        interface: {
            id: GLOBAL_TOOLBAR_INTERFACE,
            name: 'GlobalToolbar',
            description: 'System toolbar UI',
            methods: [
              {
                name: 'show',
                description: 'Show the toolbar at a given y offset',
                parameters: [
                  {
                    name: 'yOffset',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Y position for the toolbar window',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the toolbar',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getHeight',
                description: 'Get the current window height for positioning',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'number' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display toolbar', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const { yOffset } = msg.payload as { yOffset?: number } ?? {};
      return this.show(yOffset ?? 8);
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('getHeight', async () => {
      return this.currentHeight;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      if (aspect !== 'click') return;

      const fromId = msg.routing.from;

      // Settings button
      if (fromId === this.settingsBtnId) {
        if (!this.globalSettingsId) {
          this.globalSettingsId = await this.discoverDep('GlobalSettings') ?? undefined;
        }
        if (this.globalSettingsId) {
          try {
            await this.request(request(this.id, this.globalSettingsId,
              'show', {}));
          } catch (err) {
            log.warn('Failed to show GlobalSettings:', err);
          }
        }
        return;
      }

      // Network button
      if (fromId === this.networkBtnId) {
        if (!this.peerNetworkId) {
          this.peerNetworkId = await this.discoverDep('PeerNetwork') ?? undefined;
        }
        if (this.peerNetworkId) {
          try {
            await this.request(request(this.id, this.peerNetworkId,
              'show', {}));
          } catch (err) {
            log.warn('Failed to show PeerNetwork:', err);
          }
        }
        return;
      }

      // Explorer button
      if (fromId === this.explorerBtnId) {
        if (!this.objectBrowserId) {
          this.objectBrowserId = await this.discoverDep('ObjectBrowser') ?? undefined;
        }
        if (this.objectBrowserId) {
          try {
            await this.request(request(this.id, this.objectBrowserId,
              'show', {}));
          } catch (err) {
            log.warn('Failed to show ObjectBrowser:', err);
          }
        }
        return;
      }

      // Processes button
      if (fromId === this.processesBtnId) {
        if (!this.objectManagerId) {
          this.objectManagerId = await this.discoverDep('ProcessExplorer') ?? undefined;
        }
        if (this.objectManagerId) {
          try {
            await this.request(request(this.id, this.objectManagerId,
              'show', {}));
          } catch (err) {
            log.warn('Failed to show ProcessExplorer:', err);
          }
        }
        return;
      }
    });
  }

  async show(yOffset = 8): Promise<boolean> {
    // Always destroy and rebuild (position may have changed)
    if (this.windowId) {
      await this.request(
        request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
          windowId: this.windowId,
        })
      );
      this.windowId = undefined;
    }

    // Reset button tracking
    this.settingsBtnId = undefined;
    this.networkBtnId = undefined;
    this.explorerBtnId = undefined;
    this.processesBtnId = undefined;
    this.rootLayoutId = undefined;

    const btnW = 100;
    const btnH = 30;
    const labelH = 20;
    const padding = 16;
    const spacing = 6;

    // Height: padding + label row + 3 buttons + padding
    const barHeight = padding + labelH + (spacing + btnH) * 3 + padding;
    const barWidth = btnW + padding * 2;

    this.currentHeight = barHeight;

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '',
        rect: { x: 8, y: yOffset, width: barWidth, height: barHeight },
        zIndex: 1000,
        chromeless: true,
        draggable: true,
      })
    );

    // Create root VBox layout
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: padding, right: padding, bottom: padding, left: padding },
        spacing,
      })
    );

    // Header row: "System" label + gear (settings) button
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: labelH },
    }));

    // Batch create all widgets: header label, gear button, 3 action buttons
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId!, text: '\u2699 System', style: { color: this.theme.accent, fontSize: 11, fontWeight: 'bold' } },
          { type: 'button', windowId: this.windowId!, text: '\u2699', style: { fontSize: 13 } },
          { type: 'button', windowId: this.windowId!, text: '\uD83C\uDF10 Network' },
          { type: 'button', windowId: this.windowId!, text: '\uD83D\uDD0D Explorer' },
          { type: 'button', windowId: this.windowId!, text: '\u2699\uFE0F Processes' },
        ],
      })
    );

    const labelId = widgetIds[0];
    this.settingsBtnId = widgetIds[1];
    this.networkBtnId = widgetIds[2];
    this.explorerBtnId = widgetIds[3];
    this.processesBtnId = widgetIds[4];

    // Add header row children: label + gear button
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: labelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: labelH } },
        { widgetId: this.settingsBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 24, height: labelH } },
      ],
    }));

    // Add action buttons to root layout
    await this.request(request(this.id, this.rootLayoutId!, 'addLayoutChildren', {
      children: [
        { widgetId: this.networkBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
        { widgetId: this.explorerBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
        { widgetId: this.processesBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { width: btnW, height: btnH } },
      ],
    }));

    // Fire-and-forget: register as dependent for all buttons
    this.send(request(this.id, this.settingsBtnId, 'addDependent', {}));
    this.send(request(this.id, this.networkBtnId, 'addDependent', {}));
    this.send(request(this.id, this.explorerBtnId, 'addDependent', {}));
    this.send(request(this.id, this.processesBtnId, 'addDependent', {}));

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
    this.settingsBtnId = undefined;
    this.networkBtnId = undefined;
    this.explorerBtnId = undefined;
    this.processesBtnId = undefined;
    return true;
  }
}

export const GLOBAL_TOOLBAR_ID = 'abjects:global-toolbar' as AbjectId;
