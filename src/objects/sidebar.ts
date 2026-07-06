/**
 * Sidebar -- the single full-height dock on the left edge of the screen.
 *
 * Owns one chromeless, non-draggable window partitioned into three section
 * layouts (System, Spaces, Abjects). The section content is populated by the
 * section provider objects (GlobalToolbar, WorkspaceSwitcher, Taskbar) --
 * the sidebar itself holds no rows, no click handlers, and no app knowledge;
 * it is pure structure. WorkspaceManager orchestrates: it shows the sidebar,
 * fetches the section layout IDs, and pushes them into each provider's show().
 *
 * The System and Spaces sections auto-size to their content (autoSize nested
 * VBoxes report their preferred height to the root), and the Abjects section
 * takes the remaining height with internal scrolling, so a long object list
 * never runs off-screen.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { ThemeData } from '../core/theme-data.js';
import { Capabilities } from '../core/capability.js';

const SIDEBAR_INTERFACE: InterfaceId = 'abjects:sidebar';

/** Dock width: 120px rows + root margins, with room for the section scrollbar. */
export const SIDEBAR_WIDTH = 168;
/** Compact dock width: icon-only rows + root margins. */
export const SIDEBAR_COMPACT_WIDTH = 56;

export interface SidebarSections {
  windowId: AbjectId;
  system: AbjectId;
  spaces: AbjectId;
  abjects: AbjectId;
  /** True when the dock is horizontally collapsed — providers render icon-only rows. */
  compact: boolean;
}

export class Sidebar extends Abject {
  private widgetManagerId?: AbjectId;
  private workspaceManagerId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private systemSectionId?: AbjectId;
  private spacesSectionId?: AbjectId;
  private abjectsSectionId?: AbjectId;
  private toggleBtnId?: AbjectId;

  /** Horizontal collapse: compact docks show icon-only rows. */
  private compact = false;

  /** Single-flight guard for show()'s destroy+rebuild (prevents duplicate docks). */
  private buildingUI = false;

  constructor() {
    super({
      manifest: {
        name: 'Sidebar',
        description:
          'Full-height dock window on the left edge, partitioned into sections that provider objects populate with rows.',
        version: '1.0.0',
        interface: {
          id: SIDEBAR_INTERFACE,
          name: 'Sidebar',
          description: 'Dock window host: owns the window and section layouts, holds no content of its own.',
          methods: [
            {
              name: 'show',
              description: 'Create (or recreate) the dock window and its empty section layouts',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Destroy the dock window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getSections',
              description: 'Return the window ID and the three section layout IDs for providers to populate',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  windowId: { kind: 'primitive', primitive: 'string' },
                  system: { kind: 'primitive', primitive: 'string' },
                  spaces: { kind: 'primitive', primitive: 'string' },
                  abjects: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display the dock', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Sidebar Usage Guide

### Overview
The single full-height dock on the left edge of the screen. It owns the dock
window and three vertically stacked section layouts; separate provider objects
fill the sections with rows. The sidebar itself is pure structure: no rows, no
click handling.

### Methods
- \`show({ theme? })\` -- Destroy and recreate the dock window with fresh, empty
  section layouts sized to the current display height.
- \`getSections()\` -- Returns \`{ windowId, system, spaces, abjects }\`: the dock
  window ID plus the three section layout IDs. Providers build their widgets
  into the window and add them to their section layout.
- \`hide()\` -- Destroy the dock window.

### Behavior
- The top two sections auto-size to their content; the bottom section takes the
  remaining height and scrolls internally.
- A toggle row at the top collapses the dock horizontally into a compact
  icon-only strip; \`getSections()\` reports the mode via \`compact\` so
  providers render icon-only rows.
- Every \`show()\` invalidates previously returned section IDs -- callers must
  re-fetch sections after each show.

### Interface ID
\`abjects:sidebar\``;
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const { theme } = (msg.payload as { theme?: ThemeData }) ?? {};
      if (theme && typeof theme === 'object' && 'canvasBg' in theme) {
        this.theme = theme;
      }
      return this.show();
    });

    this.on('hide', async () => this.hide());

    this.on('getSections', async (): Promise<SidebarSections | null> => {
      if (!this.windowId || !this.systemSectionId || !this.spacesSectionId || !this.abjectsSectionId) {
        return null;
      }
      return {
        windowId: this.windowId,
        system: this.systemSectionId,
        spaces: this.spacesSectionId,
        abjects: this.abjectsSectionId,
        compact: this.compact,
      };
    });

    this.on('getState', async () => ({ visible: !!this.windowId, compact: this.compact }));

    // The horizontal collapse toggle is the sidebar's only own widget. The
    // flip needs every section repopulated for the new width, so it routes
    // through WorkspaceManager's refreshTaskbar like every other dock rebuild.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string };
      if (aspect !== 'click' || msg.routing.from !== this.toggleBtnId) return;
      this.compact = !this.compact;
      if (!this.workspaceManagerId) {
        this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
      }
      if (this.workspaceManagerId) {
        this.send(request(this.id, this.workspaceManagerId, 'refreshTaskbar', {}));
      }
    });
  }

  async show(): Promise<boolean> {
    if (this.buildingUI) return true;
    this.buildingUI = true;
    try {
      // Always destroy and rebuild: section layout IDs are single-use, and the
      // display height may have changed since the last build.
      if (this.windowId) {
        await this.request(
          request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
            windowId: this.windowId,
          })
        );
        this.windowId = undefined;
        this.rootLayoutId = undefined;
        this.systemSectionId = undefined;
        this.spacesSectionId = undefined;
        this.abjectsSectionId = undefined;
        this.toggleBtnId = undefined;
      }

      const display = await this.request<{ width: number; height: number }>(
        request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
      );

      this.windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createWindowAbject', {
          title: 'Sidebar',
          rect: { x: 0, y: 0, width: this.compact ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_WIDTH, height: display.height },
          zIndex: 999,
          chromeless: true,
          draggable: false,
          closable: false,
        })
      );

      const space = this.theme.tokens.space;
      this.rootLayoutId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createVBox', {
          windowId: this.windowId,
          margins: { top: space.md, right: space.lg, bottom: space.lg, left: space.lg },
          spacing: space.xxl,
        })
      );

      // Horizontal collapse toggle — a quiet full-width row at the very top.
      const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [{
            type: 'button',
            windowId: this.windowId,
            text: this.compact ? '»' : '«',
            style: {
              background: this.theme.windowBg, flat: true,
              color: this.theme.textSecondary, radius: this.theme.tokens.radius.sm,
              align: this.compact ? 'center' : 'right', fontSize: 14,
              tooltip: this.compact ? 'Expand sidebar' : 'Collapse sidebar',
            },
          }],
        })
      );
      this.toggleBtnId = widgetIds[0];
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
        widgetId: this.toggleBtnId,
        sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 18 },
      }));
      this.send(request(this.id, this.toggleBtnId, 'addDependent', {}));

      // System and Spaces auto-size to their rows; Abjects takes the rest and
      // scrolls so a long object list never runs off-screen.
      this.systemSectionId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedVBox', {
          parentLayoutId: this.rootLayoutId,
          autoSize: true,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: space.sm,
        })
      );
      this.spacesSectionId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedVBox', {
          parentLayoutId: this.rootLayoutId,
          autoSize: true,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: space.sm,
        })
      );
      this.abjectsSectionId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
          parentLayoutId: this.rootLayoutId,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          spacing: space.sm,
        })
      );

      return true;
    } finally {
      this.buildingUI = false;
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
    this.systemSectionId = undefined;
    this.spacesSectionId = undefined;
    this.abjectsSectionId = undefined;
    this.toggleBtnId = undefined;
    return true;
  }
}

export const SIDEBAR_ID = 'abjects:sidebar' as AbjectId;
