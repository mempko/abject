/**
 * CommandPalette — global launcher overlay opened with ⌘K / Ctrl-K.
 *
 * Shows a centered chromeless window with a search input and a list of
 * Abjects from the Registry that expose a `show` method. Selecting a result
 * sends `show` to that Abject. The palette itself never claims focus
 * permanently — it auto-hides on selection or Escape.
 *
 * Wiring contract (Hick's Law: one keystroke surfaces every action):
 *   1. Frontend intercepts ⌘K / Ctrl-K and sends a `globalShortcut` message
 *      to BackendUI.
 *   2. BackendUI dispatches the shortcut to this Abject's `toggle` method.
 *   3. The palette opens centered, autofocuses the input, populates results.
 *
 * The keyboard wiring lives in BackendUI + frontend-client.ts. This Abject
 * cares only about its own UI lifecycle.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';

const COMMAND_PALETTE_INTERFACE: InterfaceId = 'abjects:command-palette' as InterfaceId;

export const COMMAND_PALETTE_ID = 'abjects:command-palette' as AbjectId;

interface RegistrySummary {
  id: AbjectId;
  name: string;
  description?: string;
  tags?: string[];
  /** Method *names* — Registry.toSummary returns these as a flat string array. */
  methods?: string[];
}

interface PaletteEntry {
  id: AbjectId;
  name: string;
  description: string;
}

const PALETTE_WIDTH = 520;
const PALETTE_HEIGHT = 380;
const SEARCH_HEIGHT = 44;

export class CommandPaletteAbject extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private searchInputId?: AbjectId;
  private resultsListId?: AbjectId;

  private query = '';
  private entries: PaletteEntry[] = [];
  private filtered: PaletteEntry[] = [];
  private rebuildScheduled = false;

  constructor() {
    super({
      manifest: {
        name: 'CommandPalette',
        description: 'Global launcher overlay — opens with ⌘K / Ctrl-K to fuzzy-search Abjects.',
        version: '1.0.0',
        interface: {
          id: COMMAND_PALETTE_INTERFACE,
          name: 'CommandPalette',
          description: 'System-wide quick launcher.',
          methods: [
            { name: 'show',   description: 'Open the palette and focus the search input.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'hide',   description: 'Close the palette.',                            parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'toggle', description: 'Toggle the palette open/closed.',               parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'palette'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    // Spawned per-workspace, so `Registry` resolves to *this* workspace's
    // WorkspaceRegistry. The registry's chained listSummaries returns
    // workspace-local Abjects merged with the global fallback in one call.
    this.registryId = await this.discoverDep('Registry') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show',   async () => this.openPalette());
    this.on('hide',   async () => this.closePalette());
    this.on('toggle', async () => this.windowId ? this.closePalette() : this.openPalette());

    // The window is destroyed externally (e.g. user-initiated). Reset state
    // so the next `show` rebuilds cleanly.
    this.on('windowCloseRequested', async () => { await this.closePalette(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.searchInputId && (aspect === 'change' || aspect === 'submit')) {
        this.query = String(value ?? '');
        if (aspect === 'submit' && this.filtered.length > 0) {
          await this.activateEntry(this.filtered[0]);
          return;
        }
        this.scheduleRebuild();
        return;
      }

      if (
        fromId === this.resultsListId &&
        (aspect === 'selectionChanged' || aspect === 'confirm')
      ) {
        // Activate on click or Enter; arrow-key navigation also fires
        // selectionChanged (without `via`) for preview, so we ignore those.
        const sel = parseSelection(value);
        if (!sel || !sel.value) return;
        if (aspect === 'selectionChanged' && sel.via !== 'click') return;
        const entry = this.filtered.find((e) => e.id === sel.value);
        if (entry) await this.activateEntry(entry);
      }
    });

    // Esc handling — input bubbles keydown when not consumed.
    this.on('keydown', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key?: string };
      if (key === 'Escape') {
        await this.closePalette();
      }
    });
  }

  // ── Show / hide ─────────────────────────────────────────────────────

  private async openPalette(): Promise<boolean> {
    if (!this.widgetManagerId) return false;
    if (this.windowId) {
      // Already open — focus the input again.
      if (this.searchInputId) {
        try {
          await this.request(request(this.id, this.searchInputId, 'focus', {}));
        } catch { /* widget gone */ }
      }
      return true;
    }

    await this.refreshEntries();
    this.query = '';
    this.applyFilter();

    const display = await this.getDisplaySize();
    const x = Math.max(0, Math.floor((display.width  - PALETTE_WIDTH)  / 2));
    const y = Math.max(40, Math.floor((display.height - PALETTE_HEIGHT) / 3));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createWindowAbject', {
        title: 'Command Palette',
        rect: { x, y, width: PALETTE_WIDTH, height: PALETTE_HEIGHT },
        chromeless: true,
        resizable: false,
        zIndex: 9000,
      }),
    );

    await this.request(request(this.id, this.windowId, 'addDependent', {}));

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
        spacing: 10,
      }),
    );

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', {
        specs: [
          {
            type: 'textInput',
            windowId: this.windowId,
            placeholder: 'Search Abjects…',
            text: '',
          },
          {
            type: 'list',
            windowId: this.windowId,
            items: this.filtered.map(toListItem),
            selectedIndex: this.filtered.length > 0 ? 0 : -1,
            itemHeight: 36,
          },
        ],
      }),
    );

    [this.searchInputId, this.resultsListId] = widgetIds;

    await this.request(request(this.id, this.searchInputId, 'addDependent', {}));
    await this.request(request(this.id, this.resultsListId, 'addDependent', {}));

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.searchInputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: SEARCH_HEIGHT } },
        { widgetId: this.resultsListId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
      ],
    }));

    // Autofocus the search input so the user starts typing immediately.
    // Routed through the window so its focus tracking (focusedChildId)
    // stays consistent — keydown events route to the focused child.
    if (this.windowId && this.rootLayoutId && this.searchInputId) {
      try {
        await this.request(request(this.id, this.windowId, 'focusChild', {
          widgetId: this.searchInputId,
          parentChildId: this.rootLayoutId,
        }));
      } catch { /* window gone */ }
    }

    return true;
  }

  private async closePalette(): Promise<boolean> {
    if (!this.windowId || !this.widgetManagerId) return true;
    const wid = this.windowId;
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.searchInputId = undefined;
    this.resultsListId = undefined;
    this.query = '';
    this.filtered = [];
    try {
      await this.request(
        request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: wid }),
      );
    } catch { /* already gone */ }
    return true;
  }

  private async activateEntry(entry: PaletteEntry): Promise<void> {
    this.send(event(this.id, entry.id, 'show', {}));
    await this.closePalette();
  }

  // ── Search / filter ─────────────────────────────────────────────────

  private async refreshEntries(): Promise<void> {
    if (!this.registryId) return;
    let summaries: RegistrySummary[] = [];
    try {
      summaries = await this.request<RegistrySummary[]>(
        request(this.id, this.registryId, 'listSummaries', {}),
      );
    } catch {
      summaries = [];
    }

    this.entries = summaries
      .filter((s) => hasShowMethod(s))
      .map((s) => ({
        id: s.id,
        name: s.name ?? '',
        description: s.description ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private applyFilter(): void {
    const q = this.query.trim().toLowerCase();
    if (!q) {
      this.filtered = this.entries.slice(0, 50);
      return;
    }
    this.filtered = this.entries
      .filter((e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q))
      .slice(0, 50);
  }

  private scheduleRebuild(): void {
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    setTimeout(async () => {
      this.rebuildScheduled = false;
      await this.rebuildResults();
    }, 30);
  }

  private async rebuildResults(): Promise<void> {
    if (!this.resultsListId) return;
    this.applyFilter();
    try {
      await this.request(request(this.id, this.resultsListId, 'update', {
        items: this.filtered.map(toListItem),
        selectedIndex: this.filtered.length > 0 ? 0 : -1,
      }));
    } catch { /* widget gone */ }
  }

  // ── Display info ────────────────────────────────────────────────────

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

function hasShowMethod(s: RegistrySummary): boolean {
  return Array.isArray(s.methods) && s.methods.includes('show');
}

/**
 * ListWidget items have shape { label, value, secondary? }. We use the
 * Abject id as `value` so selection events can identify the entry without
 * trusting list indices (which shift as the filter narrows).
 */
function toListItem(e: PaletteEntry): { label: string; value: string; secondary?: string } {
  return {
    label: e.name || 'Untitled',
    value: e.id,
    secondary: e.description || undefined,
  };
}

/** ListWidget emits selectionChanged/confirm as a JSON string. Decode defensively. */
function parseSelection(raw: unknown): { index: number; value: string; label: string; via?: 'click' } | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === 'string') return parsed;
  } catch { /* malformed */ }
  return null;
}
