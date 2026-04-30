/**
 * WindowSwitcher — quick switcher for already-open windows.
 *
 * Companion to CommandPalette: where the palette opens *new* objects, this
 * lists the windows that are already on screen and lets the user jump to
 * one. Triggered by Ctrl+` / ⌘+` (familiar Mac/Linux pattern).
 *
 * The list is sorted by z-index so the most recently focused window is at
 * the top — analogous to Alt-Tab's most-recently-used order.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';

const WINDOW_SWITCHER_INTERFACE: InterfaceId = 'abjects:window-switcher' as InterfaceId;
export const WINDOW_SWITCHER_ID = 'abjects:window-switcher' as AbjectId;

interface OpenWindowEntry {
  surfaceId: string;
  windowId: AbjectId;
  title: string;
}

const SWITCHER_WIDTH = 480;
const SWITCHER_HEIGHT = 360;

export class WindowSwitcherAbject extends Abject {
  private widgetManagerId?: AbjectId;
  private windowManagerId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listId?: AbjectId;
  private hintLabelId?: AbjectId;

  private entries: OpenWindowEntry[] = [];

  constructor() {
    super({
      manifest: {
        name: 'WindowSwitcher',
        description: 'Quick switcher for open windows. Sorted by recency (z-index). Bound to Ctrl+`/⌘+`.',
        version: '1.0.0',
        interface: {
          id: WINDOW_SWITCHER_INTERFACE,
          name: 'WindowSwitcher',
          description: 'List and activate open windows.',
          methods: [
            { name: 'show',   description: 'Open the switcher.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'hide',   description: 'Close the switcher.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'toggle', description: 'Toggle the switcher open/closed.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'switcher'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show',   async () => this.openSwitcher());
    this.on('hide',   async () => this.closeSwitcher());
    this.on('toggle', async () => this.windowId ? this.closeSwitcher() : this.openSwitcher());

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      if (fromId !== this.listId) return;

      // Click → selectionChanged with via='click'; Enter → confirm.
      // Arrow keys also emit selectionChanged (without `via`) for preview;
      // we ignore those so navigation doesn't dismiss the switcher.
      if (aspect === 'selectionChanged' || aspect === 'confirm') {
        const sel = parseSelection(value);
        if (!sel || !sel.value) return;
        if (aspect === 'selectionChanged' && sel.via !== 'click') return;
        const entry = this.entries.find((e) => e.surfaceId === sel.value);
        if (entry) await this.activateWindow(entry);
      }
    });

    // Owner-forwarded close requests from chromeless WindowAbjects (Esc, X).
    this.on('windowCloseRequested', async () => { await this.closeSwitcher(); });
  }

  private async openSwitcher(): Promise<boolean> {
    if (!this.widgetManagerId || !this.windowManagerId) return false;
    if (this.windowId) return true;

    await this.refreshEntries();
    if (this.entries.length === 0) {
      // Nothing to switch to; do nothing rather than open an empty modal.
      return false;
    }

    const display = await this.getDisplaySize();
    const x = Math.max(0, Math.floor((display.width  - SWITCHER_WIDTH)  / 2));
    const y = Math.max(40, Math.floor((display.height - SWITCHER_HEIGHT) / 3));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createWindowAbject', {
        title: 'Switch Window',
        rect: { x, y, width: SWITCHER_WIDTH, height: SWITCHER_HEIGHT },
        chromeless: true,
        resizable: false,
        zIndex: 9001,
      }),
    );

    await this.request(request(this.id, this.windowId, 'addDependent', {}));

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
        spacing: 8,
      }),
    );

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', {
        specs: [
          {
            type: 'label',
            windowId: this.windowId,
            text: 'Open windows · ↑↓ to navigate · Enter to focus · Esc to cancel',
            style: { fontSize: 11, color: '#8b8fa3' },
          },
          {
            type: 'list',
            windowId: this.windowId,
            items: this.entries.map(toSwitcherItem),
            selectedIndex: 0,
            itemHeight: 30,
          },
        ],
      }),
    );

    [this.hintLabelId, this.listId] = widgetIds;
    await this.request(request(this.id, this.listId, 'addDependent', {}));

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.hintLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
        { widgetId: this.listId,      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Autofocus the list so ↑↓/Enter work without an extra click.
    if (this.windowId && this.rootLayoutId && this.listId) {
      try {
        await this.request(request(this.id, this.windowId, 'focusChild', {
          widgetId: this.listId,
          parentChildId: this.rootLayoutId,
          via: 'keyboard',
        }));
      } catch { /* window gone */ }
    }

    return true;
  }

  private async closeSwitcher(): Promise<boolean> {
    if (!this.windowId || !this.widgetManagerId) return true;
    const wid = this.windowId;
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.listId = undefined;
    this.hintLabelId = undefined;
    this.entries = [];
    try {
      await this.request(
        request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: wid }),
      );
    } catch { /* already gone */ }
    return true;
  }

  private async activateWindow(entry: OpenWindowEntry): Promise<void> {
    if (this.windowManagerId) {
      this.send(event(this.id, this.windowManagerId, 'raiseWindow', { surfaceId: entry.surfaceId }));
    }
    await this.closeSwitcher();
  }

  private async refreshEntries(): Promise<void> {
    if (!this.windowManagerId) return;
    // Only show windows belonging to *this* workspace. The switcher itself
    // is per-workspace, so cross-workspace results would just be confusing.
    const workspaceId = await this.discoverOwnWorkspace();
    let list: OpenWindowEntry[] = [];
    try {
      list = await this.request<OpenWindowEntry[]>(
        request(this.id, this.windowManagerId, 'listOpenWindows', workspaceId ? { workspaceId } : {}),
      );
    } catch {
      list = [];
    }
    // Drop our own switcher window from the list (just in case it leaks in).
    this.entries = list.filter((e) => e.windowId !== this.windowId);
  }

  private async discoverOwnWorkspace(): Promise<string | undefined> {
    if (!this.widgetManagerId) return undefined;
    try {
      const ws = await this.request<string | null>(
        request(this.id, this.widgetManagerId, 'getObjectWorkspace', { objectId: this.id }),
      );
      return ws ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async getDisplaySize(): Promise<{ width: number; height: number }> {
    if (!this.widgetManagerId) return { width: 1280, height: 800 };
    try {
      return await this.request<{ width: number; height: number }>(
        request(this.id, this.widgetManagerId, 'getDisplayInfo', {}),
      );
    } catch {
      return { width: 1280, height: 800 };
    }
  }
}

/**
 * ListWidget items have shape { label, value, secondary? }. We use the
 * surfaceId as `value` so the selection event can resolve back to the
 * window even if the list reorders.
 */
function toSwitcherItem(e: OpenWindowEntry): { label: string; value: string; secondary?: string } {
  return {
    label: e.title || 'Untitled',
    value: e.surfaceId,
  };
}

function parseSelection(raw: unknown): { index: number; value: string; label: string; via?: 'click' } | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === 'string') return parsed;
  } catch { /* malformed */ }
  return null;
}
